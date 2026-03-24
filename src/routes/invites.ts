import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { broadcastToUser } from "../broadcast";

function computeTimeStatus(startAt: string, endAt: string): "upcoming" | "happening" | "past" {
  const now = Date.now();
  const start = new Date(startAt).getTime();
  const end = new Date(endAt).getTime();
  if (now < start) return "upcoming";
  if (now >= start && now <= end) return "happening";
  return "past";
}

// Batched headcount query
async function batchHeadcounts(inviteIds: string[]): Promise<Map<string, { going: number; maybe: number; declined: number; pending: number; total: number }>> {
  const map = new Map<string, any>();
  if (inviteIds.length === 0) return map;

  const { rows } = await query(
    `SELECT invite_id,
      COUNT(*) FILTER (WHERE status = 'yes')::int as going,
      COUNT(*) FILTER (WHERE status = 'maybe')::int as maybe,
      COUNT(*) FILTER (WHERE status = 'no')::int as declined,
      COUNT(*) FILTER (WHERE status IS NULL)::int as pending,
      COUNT(*)::int as total
    FROM invite_attendees
    WHERE invite_id = ANY($1::text[])
    GROUP BY invite_id`,
    [inviteIds]
  );

  for (const row of rows) {
    map.set(row.invite_id, {
      going: row.going,
      maybe: row.maybe,
      declined: row.declined,
      pending: row.pending,
      total: row.total,
    });
  }

  return map;
}

async function toInvite(row: any, includeSentAnalytics = false, headcount?: { going: number; maybe: number; declined: number; pending: number; total: number }) {
  const { rows: attendees } = await query(
    "SELECT name, status, is_friend, responded_at FROM invite_attendees WHERE invite_id = $1 ORDER BY id ASC",
    [row.id]
  );

  const hc = headcount || {
    going: attendees.filter((a: any) => a.status === "yes").length,
    maybe: attendees.filter((a: any) => a.status === "maybe").length,
    declined: attendees.filter((a: any) => a.status === "no").length,
    pending: attendees.filter((a: any) => a.status === null).length,
    total: attendees.length,
  };

  const base: any = {
    id: row.id,
    title: row.title,
    organizer: row.organizer,
    group: row.group_name || undefined,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    totalInvited: row.total_invited,
    rsvpStatus: row.rsvp_status || null,
    status: row.status || "active",
    notes: row.notes || null,
    createdBy: row.created_by || row.sender_user_id || null,
    timeStatus: computeTimeStatus(row.start_at, row.end_at),
    updatedAt: row.updated_at || null,
    cancelledAt: row.cancelled_at || null,
    cancelReason: row.cancel_reason || null,
    headcount: hc,
    recurrenceRule: row.recurrence_rule || null,
    parentInviteId: row.parent_invite_id || null,
    recurrenceIndex: row.recurrence_index ?? 0,
    attendees: attendees.map((a: any) => ({
      name: a.name,
      status: a.status || null,
      isFriend: a.is_friend,
      respondedAt: a.responded_at || null,
    })),
  };

  if (includeSentAnalytics) {
    const total = attendees.length;
    const responded = attendees.filter((a: any) => a.status !== null).length;
    base.responseRate = total > 0 ? Math.round((responded / total) * 100) : 0;
    base.yesCount = attendees.filter((a: any) => a.status === "yes").length;
    base.maybeCount = attendees.filter((a: any) => a.status === "maybe").length;
    base.noCount = attendees.filter((a: any) => a.status === "no").length;
    base.pendingCount = attendees.filter((a: any) => a.status === null).length;
    base.lastNudgeAt = row.last_nudge_at || null;
    base.nudgeCount = row.nudge_count ?? 0;
  }

  return base;
}

async function broadcastInviteRow(row: any) {
  const payload = await toInvite(row);
  broadcastToUser(row.user_id, { type: "invite_upsert", payload });
}

async function recordDeletion(userId: string, inviteId: string) {
  await query(
    "INSERT INTO deleted_entities (user_id, entity_type, entity_id) VALUES ($1, 'invite', $2)",
    [userId, inviteId]
  );
}

// Expo push helper
async function sendExpoPushBatch(messages: Array<{ to: string; title: string; body: string; data?: any; sound?: string }>) {
  if (messages.length === 0) return;
  const batches = [];
  for (let i = 0; i < messages.length; i += 100) {
    batches.push(messages.slice(i, i + 100));
  }
  for (const batch of batches) {
    try {
      await fetch("https://exp.host/--/api/v2/push/send", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json", "Accept-Encoding": "gzip, deflate" },
        body: JSON.stringify(batch),
      });
    } catch (err: any) {
      console.error("[nudge-push] Error:", err.message);
    }
  }
}

export const inviteRoutes = new Elysia({ prefix: "/invites" })
  .use(authGuard)

  // GET /invites — list invites with filter support + headcount
  .get("/", async ({ userId, query: qs }) => {
    const filter = qs.filter || "received";
    const isSent = filter === "sent";

    let sql: string;
    const params: any[] = [userId];

    if (isSent) {
      sql = "SELECT * FROM invites WHERE created_by = $1 AND user_id = $1";
    } else {
      sql = "SELECT * FROM invites WHERE user_id = $1";
    }

    if (qs.type === "group") sql += " AND is_group = TRUE";
    else if (qs.type === "friend") sql += " AND is_group = FALSE";

    sql += " ORDER BY start_at DESC";

    const { rows } = await query(sql, params);

    // Batch headcount
    const inviteIds = rows.map((r: any) => r.id);
    const headcounts = await batchHeadcounts(inviteIds);

    return Promise.all(rows.map((row: any) => {
      const hc = headcounts.get(row.id) || { going: 0, maybe: 0, declined: 0, pending: 0, total: 0 };
      return toInvite(row, isSent, hc);
    }));
  })

  // GET /invites/stats — overall invite stats
  .get("/stats", async ({ userId }) => {
    const { rows: received } = await query(
      "SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE rsvp_status IS NULL AND status = 'active') AS pending, COUNT(*) FILTER (WHERE start_at > NOW()::text AND status = 'active') AS upcoming FROM invites WHERE user_id = $1",
      [userId]
    );

    const { rows: sent } = await query(
      "SELECT COUNT(*) AS total FROM invites WHERE created_by = $1 AND user_id = $1",
      [userId]
    );

    const { rows: sentInviteIds } = await query(
      "SELECT id FROM invites WHERE created_by = $1 AND user_id = $1 AND status = 'active'",
      [userId]
    );

    let avgResponseRate = 0;
    if (sentInviteIds.length > 0) {
      const ids = sentInviteIds.map((r: any) => r.id);
      const { rows: threadIds } = await query(
        "SELECT DISTINCT thread_id FROM invites WHERE id = ANY($1::text[])",
        [ids]
      );
      const tids = threadIds.map((r: any) => r.thread_id).filter(Boolean);

      if (tids.length > 0) {
        const { rows: stats } = await query(
          `SELECT COUNT(*) AS total, COUNT(*) FILTER (WHERE ia.status IS NOT NULL) AS responded
           FROM invite_attendees ia
           JOIN invites i ON ia.invite_id = i.id
           WHERE i.thread_id = ANY($1::text[]) AND i.user_id = i.created_by`,
          [tids]
        );
        const total = parseInt(stats[0].total || "0");
        const responded = parseInt(stats[0].responded || "0");
        avgResponseRate = total > 0 ? Math.round((responded / total) * 100) : 0;
      }
    }

    return {
      totalReceived: parseInt(received[0].total || "0"),
      pendingResponse: parseInt(received[0].pending || "0"),
      totalSent: parseInt(sent[0].total || "0"),
      avgResponseRate,
      upcomingCount: parseInt(received[0].upcoming || "0"),
    };
  })

  // GET /invites/:id/analytics — detailed analytics + headcount
  .get("/:id/analytics", async ({ userId, params, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    if ((invite.created_by || invite.sender_user_id) !== userId) {
      set.status = 403;
      return { error: "Only the creator can view analytics" };
    }

    const { rows: attendees } = await query(
      "SELECT name, status, is_friend, responded_at FROM invite_attendees WHERE invite_id = $1 ORDER BY id ASC",
      [invite.id]
    );

    const total = attendees.length;
    const responded = attendees.filter((a: any) => a.status !== null).length;
    const yesCount = attendees.filter((a: any) => a.status === "yes").length;
    const maybeCount = attendees.filter((a: any) => a.status === "maybe").length;
    const noCount = attendees.filter((a: any) => a.status === "no").length;
    const pendingCount = attendees.filter((a: any) => a.status === null).length;

    const respondedAts = attendees
      .map((a: any) => a.responded_at)
      .filter(Boolean)
      .map((d: string) => new Date(d).getTime());

    return {
      id: invite.id,
      title: invite.title,
      totalInvited: invite.total_invited,
      responded,
      responseRate: total > 0 ? Math.round((responded / total) * 100) : 0,
      breakdown: { yes: yesCount, maybe: maybeCount, no: noCount, pending: pendingCount },
      headcount: { going: yesCount, maybe: maybeCount, declined: noCount, pending: pendingCount, total },
      attendees: attendees.map((a: any) => ({
        name: a.name,
        status: a.status || null,
        isFriend: a.is_friend,
        respondedAt: a.responded_at || null,
      })),
      timeline: {
        created: invite.created_at,
        firstResponse: respondedAts.length > 0 ? new Date(Math.min(...respondedAts)).toISOString() : null,
        lastResponse: respondedAts.length > 0 ? new Date(Math.max(...respondedAts)).toISOString() : null,
      },
    };
  })

  // PATCH /invites/:id — edit an invite (creator only, active + upcoming only)
  .patch("/:id", async ({ userId, params, body, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    const creatorId = invite.created_by || invite.sender_user_id;
    if (creatorId !== userId) {
      set.status = 403;
      return { error: "Only the creator can edit this invite" };
    }

    if (invite.status !== "active" && invite.status !== null) {
      set.status = 400;
      return { error: "Can only edit active invites" };
    }

    const timeStatus = computeTimeStatus(invite.start_at, invite.end_at);
    if (timeStatus !== "upcoming") {
      set.status = 400;
      return { error: "Can only edit invites that haven't started yet" };
    }

    const threadId = invite.thread_id || invite.id;
    const updates: string[] = [];
    const values: any[] = [];
    let idx = 1;

    if (body.title !== undefined) { updates.push(`title = $${idx++}`); values.push(body.title); }
    if (body.location !== undefined) { updates.push(`location = $${idx++}`); values.push(body.location); }
    if (body.notes !== undefined) { updates.push(`notes = $${idx++}`); values.push(body.notes); }
    if (body.startAt !== undefined) { updates.push(`start_at = $${idx++}`); values.push(body.startAt); }
    if (body.endAt !== undefined) { updates.push(`end_at = $${idx++}`); values.push(body.endAt); }

    if (updates.length === 0) {
      set.status = 400;
      return { error: "No fields to update" };
    }

    updates.push(`updated_at = NOW()`);
    values.push(threadId);

    await query(`UPDATE invites SET ${updates.join(", ")} WHERE thread_id = $${idx}`, values);

    const { rows: updatedRows } = await query("SELECT * FROM invites WHERE thread_id = $1", [threadId]);
    for (const row of updatedRows) {
      await broadcastInviteRow(row);
    }

    const updated = updatedRows.find((r: any) => r.id === params.id) || updatedRows[0];
    return toInvite(updated);
  }, {
    body: t.Object({
      title: t.Optional(t.String()),
      location: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      startAt: t.Optional(t.String()),
      endAt: t.Optional(t.String()),
    }),
  })

  // PATCH /invites/:id/rsvp — RSVP with calendar sync
  .patch("/:id/rsvp", async ({ userId, params, body }) => {
    const { status } = body;
    const { rows } = await query(
      "SELECT * FROM invites WHERE id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Invite not found" }), { status: 404 });

    const invite = rows[0];
    const previousStatus = invite.rsvp_status;
    const { rows: userRows } = await query("SELECT name FROM users WHERE id = $1", [userId]);
    const currentName = userRows[0]?.name || "You";

    await query(
      "UPDATE invites SET rsvp_status = $1, updated_at = NOW() WHERE id = $2",
      [status, invite.id]
    );
    await query(
      "UPDATE invites SET updated_at = NOW() WHERE thread_id = $1",
      [invite.thread_id || invite.id]
    );
    await query(
      "UPDATE invite_attendees SET status = $1, responded_at = NOW() WHERE invite_id IN (SELECT id FROM invites WHERE thread_id = $2) AND user_id = $3",
      [status, invite.thread_id || invite.id, userId]
    );
    await query(
      "UPDATE invite_attendees SET status = $1, responded_at = NOW() WHERE invite_id IN (SELECT id FROM invites WHERE thread_id = $2) AND name = $3 AND user_id IS NULL",
      [status, invite.thread_id || invite.id, currentName]
    );

    // Calendar sync
    let calendarSynced: boolean | null = null;

    if (status === "yes") {
      // Check by source_invite_id first, then fall back to title+start_at match
      const { rows: existingBySource } = await query(
        "SELECT id FROM events WHERE user_id = $1 AND source_invite_id = $2",
        [userId, invite.id]
      );
      if (existingBySource.length === 0) {
        // Also check legacy events without source_invite_id
        const { rows: existingLegacy } = await query(
          "SELECT id FROM events WHERE user_id = $1 AND title = $2 AND start_at = $3 AND source_invite_id IS NULL",
          [userId, invite.title, invite.start_at]
        );
        if (existingLegacy.length === 0) {
          await query(
            `INSERT INTO events (id, user_id, title, type, start_at, end_at, location, notes, source_invite_id)
             VALUES ($1, $2, $3, 'meetup', $4, $5, $6, $7, $8)`,
            [
              crypto.randomUUID(),
              userId,
              invite.title,
              invite.start_at,
              invite.end_at,
              invite.location,
              `Organized by ${invite.organizer}${invite.group_name ? ` • ${invite.group_name}` : ""}`,
              invite.id,
            ]
          );
          calendarSynced = true;
        }
      }
    } else if (previousStatus === "yes" && (status === "maybe" || status === "no" || status === null)) {
      // Remove from calendar when changing away from "yes"
      const deleteResult = await query(
        "DELETE FROM events WHERE source_invite_id = $1 AND user_id = $2",
        [invite.id, userId]
      );
      if ((deleteResult.rowCount ?? 0) === 0) {
        // Try legacy cleanup
        await query(
          "DELETE FROM events WHERE user_id = $1 AND title = $2 AND start_at = $3 AND source_invite_id IS NULL",
          [userId, invite.title, invite.start_at]
        );
      }
      calendarSynced = false;
    }

    const { rows: affectedRows } = await query(
      "SELECT * FROM invites WHERE thread_id = $1 ORDER BY created_at ASC",
      [invite.thread_id || invite.id]
    );

    for (const affectedRow of affectedRows) {
      await broadcastInviteRow(affectedRow);
    }

    const updated = affectedRows.find((row: any) => row.id === params.id) || invite;
    const result = await toInvite(updated);
    if (calendarSynced !== null) {
      (result as any).calendarSynced = calendarSynced;
    }
    return result;
  }, {
    body: t.Object({
      status: t.Union([t.Literal("yes"), t.Literal("maybe"), t.Literal("no"), t.Null()]),
    }),
  })

  // POST /invites/:id/cancel — cancel/revoke an invite (creator only)
  .post("/:id/cancel", async ({ userId, params, body, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    const creatorId = invite.created_by || invite.sender_user_id;
    if (creatorId !== userId) {
      set.status = 403;
      return { error: "Only the creator can cancel this invite" };
    }

    const threadId = invite.thread_id || invite.id;
    await query(
      "UPDATE invites SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = $1, updated_at = NOW() WHERE thread_id = $2",
      [body.reason || null, threadId]
    );

    const { rows: updatedRows } = await query("SELECT * FROM invites WHERE thread_id = $1", [threadId]);
    for (const row of updatedRows) {
      await broadcastInviteRow(row);
    }

    return { success: true };
  }, {
    body: t.Object({
      reason: t.Optional(t.String()),
    }),
  })

  // POST /invites/:id/nudge — send reminder to non-responders
  .post("/:id/nudge", async ({ userId, params, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    const creatorId = invite.created_by || invite.sender_user_id;
    if (creatorId !== userId) {
      set.status = 403;
      return { error: "Only the creator can send reminders" };
    }

    if (invite.status !== "active" || computeTimeStatus(invite.start_at, invite.end_at) === "past") {
      set.status = 400;
      return { error: "Can only nudge for active, upcoming invites" };
    }

    // Rate limit: once per 24 hours
    if (invite.last_nudge_at) {
      const lastNudge = new Date(invite.last_nudge_at).getTime();
      const hoursSince = (Date.now() - lastNudge) / (1000 * 60 * 60);
      if (hoursSince < 24) {
        set.status = 429;
        return { error: "You can only send one reminder per day" };
      }
    }

    // Get non-responders from the thread
    const threadId = invite.thread_id || invite.id;
    const { rows: pendingAttendees } = await query(
      `SELECT DISTINCT ia.user_id, ia.name, u.push_token
       FROM invite_attendees ia
       JOIN invites i ON ia.invite_id = i.id
       LEFT JOIN users u ON ia.user_id = u.id
       WHERE i.thread_id = $1 AND ia.status IS NULL AND ia.user_id != $2 AND ia.user_id IS NOT NULL`,
      [threadId, userId]
    );

    const messages = pendingAttendees
      .filter((a: any) => a.push_token)
      .map((a: any) => ({
        to: a.push_token,
        title: "Reminder",
        body: `You haven't responded to "${invite.title}" yet`,
        data: { type: "invite_nudge", inviteId: invite.id },
        sound: "default",
      }));

    await sendExpoPushBatch(messages);

    // Update nudge tracking on all thread copies
    await query(
      "UPDATE invites SET last_nudge_at = NOW(), nudge_count = COALESCE(nudge_count, 0) + 1, updated_at = NOW() WHERE thread_id = $1",
      [threadId]
    );

    return { success: true, nudgedCount: messages.length, totalPending: pendingAttendees.length };
  })

  // POST /invites/:id/duplicate — duplicate an invite with new dates (creator only)
  .post("/:id/duplicate", async ({ userId, params, body, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    const creatorId = invite.created_by || invite.sender_user_id;
    if (creatorId !== userId) {
      set.status = 403;
      return { error: "Only the creator can duplicate this invite" };
    }

    const newStartAt = `${body.date}T${body.startTime}:00`;
    const newEndAt = `${body.date}T${body.endTime}:00`;
    const threadId = invite.thread_id || invite.id;

    const { rows: originalCopies } = await query(
      "SELECT * FROM invites WHERE thread_id = $1 ORDER BY created_at ASC",
      [threadId]
    );

    const newThreadId = crypto.randomUUID();
    const createdIds: string[] = [];

    for (const copy of originalCopies) {
      const newId = crypto.randomUUID();
      await query(
        `INSERT INTO invites (id, thread_id, user_id, sender_user_id, created_by, title, organizer, group_name, location, start_at, end_at, total_invited, is_group, rsvp_status, notes, status)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,'active')`,
        [newId, newThreadId, copy.user_id, copy.sender_user_id, copy.created_by, invite.title, copy.organizer, invite.group_name, invite.location, newStartAt, newEndAt, invite.total_invited, invite.is_group, null, invite.notes]
      );

      const { rows: attendees } = await query(
        "SELECT name, user_id, is_friend FROM invite_attendees WHERE invite_id = $1",
        [copy.id]
      );
      for (const att of attendees) {
        await query(
          "INSERT INTO invite_attendees (invite_id, user_id, name, status, is_friend) VALUES ($1, $2, $3, NULL, $4)",
          [newId, att.user_id, att.name, att.is_friend]
        );
      }

      createdIds.push(newId);
    }

    for (const id of createdIds) {
      const { rows: newRows } = await query("SELECT * FROM invites WHERE id = $1", [id]);
      if (newRows.length > 0) await broadcastInviteRow(newRows[0]);
    }

    const creatorCopyId = createdIds[0];
    const { rows: creatorRows } = await query("SELECT * FROM invites WHERE id = $1", [creatorCopyId]);
    set.status = 201;
    return toInvite(creatorRows[0]);
  }, {
    body: t.Object({
      date: t.String(),
      startTime: t.String(),
      endTime: t.String(),
    }),
  })

  // POST /invites/:id/cancel-series — cancel all active upcoming invites in a recurring series
  .post("/:id/cancel-series", async ({ userId, params, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    const creatorId = invite.created_by || invite.sender_user_id;
    if (creatorId !== userId) {
      set.status = 403;
      return { error: "Only the creator can cancel a series" };
    }

    // Find the parent — if this IS the parent, use its id. If it has a parent, use that.
    const parentId = invite.parent_invite_id || invite.id;

    // Get all thread_ids for the series (parent + children)
    const { rows: seriesInvites } = await query(
      `SELECT DISTINCT thread_id FROM invites
       WHERE (id = $1 OR parent_invite_id = $1) AND status = 'active'
         AND start_at > NOW()::text`,
      [parentId]
    );

    const threadIds = seriesInvites.map((r: any) => r.thread_id).filter(Boolean);
    let cancelledCount = 0;

    if (threadIds.length > 0) {
      const result = await query(
        `UPDATE invites SET status = 'cancelled', cancelled_at = NOW(), cancel_reason = 'Series cancelled', updated_at = NOW()
         WHERE thread_id = ANY($1::text[]) AND status = 'active' AND start_at > NOW()::text`,
        [threadIds]
      );
      cancelledCount = result.rowCount ?? 0;

      // Broadcast updates
      const { rows: updated } = await query(
        "SELECT * FROM invites WHERE thread_id = ANY($1::text[])",
        [threadIds]
      );
      for (const row of updated) {
        await broadcastInviteRow(row);
      }
    }

    return { success: true, cancelledCount };
  })

  // DELETE /invites/:id/series — delete all invites in a recurring series
  .delete("/:id/series", async ({ userId, params, set }) => {
    const { rows } = await query("SELECT * FROM invites WHERE id = $1", [params.id]);
    if (rows.length === 0) { set.status = 404; return { error: "Invite not found" }; }

    const invite = rows[0];
    const creatorId = invite.created_by || invite.sender_user_id;
    if (creatorId !== userId) {
      set.status = 403;
      return { error: "Only the creator can delete a series" };
    }

    const parentId = invite.parent_invite_id || invite.id;

    // Get all thread_ids for the series
    const { rows: seriesInvites } = await query(
      "SELECT DISTINCT thread_id, id, user_id FROM invites WHERE id = $1 OR parent_invite_id = $1",
      [parentId]
    );

    const threadIds = seriesInvites.map((r: any) => r.thread_id).filter(Boolean);

    // Record deletions and broadcast
    const { rows: doomed } = await query(
      "SELECT id, user_id FROM invites WHERE thread_id = ANY($1::text[])",
      [threadIds]
    );

    for (const d of doomed) {
      await recordDeletion(d.user_id, d.id);
      broadcastToUser(d.user_id, { type: "invite_deleted", payload: { id: d.id } });
    }

    const result = await query(
      "DELETE FROM invites WHERE thread_id = ANY($1::text[])",
      [threadIds]
    );

    return { success: true, deletedCount: result.rowCount ?? 0 };
  })

  // DELETE /invites/:id — delete an invite (organizer only)
  .delete("/:id", async ({ userId, params, set }) => {
    const { rows } = await query(
      "SELECT id, thread_id, sender_user_id FROM invites WHERE id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (rows.length === 0) {
      set.status = 404;
      return { error: "Invite not found or you are not the organizer." };
    }

    const invite = rows[0];
    if (invite.sender_user_id !== userId) {
      set.status = 403;
      return { error: "Only the organizer can revoke this invite." };
    }

    const { rows: doomed } = await query("SELECT id, user_id FROM invites WHERE thread_id = $1", [invite.thread_id || invite.id]);
    await query("DELETE FROM invites WHERE thread_id = $1", [invite.thread_id || invite.id]);

    for (const doomedRow of doomed) {
      await recordDeletion(doomedRow.user_id, doomedRow.id);
      broadcastToUser(doomedRow.user_id, { type: "invite_deleted", payload: { id: doomedRow.id } });
    }

    return { success: true };
  });
