import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { broadcastToUser } from "../broadcast";

async function toInvite(row: any) {
  const { rows: attendees } = await query(
    "SELECT name, status, is_friend FROM invite_attendees WHERE invite_id = $1 ORDER BY id ASC",
    [row.id]
  );

  return {
    id: row.id,
    title: row.title,
    organizer: row.organizer,
    group: row.group_name || undefined,
    location: row.location,
    startAt: row.start_at,
    endAt: row.end_at,
    totalInvited: row.total_invited,
    rsvpStatus: row.rsvp_status || null,
    attendees: attendees.map((attendee: any) => ({
      name: attendee.name,
      status: attendee.status || null,
      isFriend: attendee.is_friend,
    })),
  };
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

export const inviteRoutes = new Elysia({ prefix: "/invites" })
  .use(authGuard)

  .get("/", async ({ userId, query: qs }) => {
    let sql = "SELECT * FROM invites WHERE user_id = $1";
    const params: any[] = [userId];
    if (qs.type === "group") sql += " AND is_group = TRUE";
    else if (qs.type === "friend") sql += " AND is_group = FALSE";
    sql += " ORDER BY start_at DESC";

    const { rows } = await query(sql, params);
    return Promise.all(rows.map(toInvite));
  })

  .patch("/:id/rsvp", async ({ userId, params, body }) => {
    const { status } = body;
    const { rows } = await query(
      "SELECT * FROM invites WHERE id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Invite not found" }), { status: 404 });

    const invite = rows[0];
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
      "UPDATE invite_attendees SET status = $1 WHERE invite_id IN (SELECT id FROM invites WHERE thread_id = $2) AND user_id = $3",
      [status, invite.thread_id || invite.id, userId]
    );
    await query(
      "UPDATE invite_attendees SET status = $1 WHERE invite_id IN (SELECT id FROM invites WHERE thread_id = $2) AND name = $3 AND user_id IS NULL",
      [status, invite.thread_id || invite.id, currentName]
    );

    if (status === "yes") {
      const { rows: existingEvents } = await query(
        "SELECT id FROM events WHERE user_id = $1 AND title = $2 AND start_at = $3",
        [userId, invite.title, invite.start_at]
      );
      if (existingEvents.length === 0) {
        await query(
          `INSERT INTO events (id, user_id, title, type, start_at, end_at, location, notes)
           VALUES ($1, $2, $3, 'meetup', $4, $5, $6, $7)`,
          [
            crypto.randomUUID(),
            userId,
            invite.title,
            invite.start_at,
            invite.end_at,
            invite.location,
            `Organized by ${invite.organizer}${invite.group_name ? ` • ${invite.group_name}` : ""}`,
          ]
        );
      }
    }

    const { rows: affectedRows } = await query(
      "SELECT * FROM invites WHERE thread_id = $1 ORDER BY created_at ASC",
      [invite.thread_id || invite.id]
    );

    for (const affectedRow of affectedRows) {
      await broadcastInviteRow(affectedRow);
    }

    const updated = affectedRows.find((row: any) => row.id === params.id) || invite;
    return toInvite(updated);
  }, {
    body: t.Object({
      status: t.Union([t.Literal("yes"), t.Literal("maybe"), t.Literal("no"), t.Null()]),
    }),
  })

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


