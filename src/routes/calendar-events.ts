import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { broadcastToUser } from "../broadcast";

const toCalEvent = (row: any) => ({
  id: row.id,
  title: row.title,
  creator: row.creator,
  group: row.group_name || undefined,
  location: row.location,
  startAt: row.start_at,
  endAt: row.end_at,
  notes: row.notes || undefined,
  totalSentTo: row.total_sent_to,
  acceptStatus: row.accept_status || null,
  reminderSettings: row.reminder_times ? { times: JSON.parse(row.reminder_times) } : null,
});

async function recordDeletion(userId: string, calendarEventId: string) {
  await query(
    "INSERT INTO deleted_entities (user_id, entity_type, entity_id) VALUES ($1, 'calendar_event', $2)",
    [userId, calendarEventId]
  );
}

function broadcastCalendarEvent(row: any) {
  broadcastToUser(row.user_id, { type: "calendar_event_upsert", payload: toCalEvent(row) });
}

export const calendarEventRoutes = new Elysia({ prefix: "/calendar-events" })
  .use(authGuard)

  .get("/", async ({ userId, query: qs }) => {
    let sql = "SELECT * FROM calendar_events WHERE user_id = $1";
    const params: any[] = [userId];
    if (qs.type === "group") sql += " AND is_group = TRUE";
    else if (qs.type === "friend") sql += " AND is_group = FALSE";
    sql += " ORDER BY start_at DESC";
    const { rows } = await query(sql, params);
    return rows.map(toCalEvent);
  })

  .patch("/:id", async ({ userId, params, body }) => {
    const { acceptStatus, reminderSettings } = body;
    const { rows } = await query("SELECT * FROM calendar_events WHERE id = $1 AND user_id = $2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });

    const row = rows[0];
    const sets: string[] = [];
    const paramsList: any[] = [];
    let index = 1;

    if (acceptStatus !== undefined) {
      sets.push(`accept_status = $${index++}`);
      paramsList.push(acceptStatus);
    }
    if (reminderSettings !== undefined) {
      sets.push(`reminder_times = $${index++}`);
      paramsList.push(reminderSettings?.times ? JSON.stringify(reminderSettings.times) : null);
    }
    sets.push(`updated_at = NOW()`);

    paramsList.push(row.id);
    await query(`UPDATE calendar_events SET ${sets.join(", ")} WHERE id = $${index}`, paramsList);

    if (acceptStatus === "accepted") {
      const { rows: existingEvents } = await query(
        "SELECT id FROM events WHERE user_id = $1 AND title = $2 AND start_at = $3",
        [userId, row.title, row.start_at]
      );
      if (existingEvents.length === 0) {
        let type = "class";
        const lower = row.title.toLowerCase();
        if (lower.includes("study") || lower.includes("homework")) type = "study";
        else if (lower.includes("meet") || lower.includes("coffee") || lower.includes("hangout")) type = "meetup";
        await query(
          `INSERT INTO events (id, user_id, title, type, start_at, end_at, location, notes)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [
            crypto.randomUUID(),
            userId,
            row.title,
            type,
            row.start_at,
            row.end_at,
            row.location,
            row.notes || `Created by ${row.creator}${row.group_name ? ` • ${row.group_name}` : ""}`,
          ]
        );
      }
    }

    const { rows: updated } = await query("SELECT * FROM calendar_events WHERE id = $1", [row.id]);
    const result = toCalEvent(updated[0]);
    broadcastCalendarEvent(updated[0]);
    return result;
  }, {
    body: t.Object({
      acceptStatus: t.Optional(t.Union([t.Literal("accepted"), t.Literal("declined"), t.Null()])),
      reminderSettings: t.Optional(t.Any()),
    }),
  })

  .delete("/:id", async ({ userId, params, set }) => {
    const { rows } = await query(
      "SELECT id, thread_id, sender_user_id FROM calendar_events WHERE id = $1 AND user_id = $2",
      [params.id, userId]
    );
    if (rows.length === 0) {
      set.status = 404;
      return new Response(JSON.stringify({ error: "Not found or not the creator." }), { status: 404 });
    }

    const event = rows[0];
    if (event.sender_user_id !== userId) {
      set.status = 403;
      return { error: "Only the creator can revoke this event." };
    }

    const { rows: doomed } = await query("SELECT id, user_id FROM calendar_events WHERE thread_id = $1", [event.thread_id || event.id]);
    await query("DELETE FROM calendar_events WHERE thread_id = $1", [event.thread_id || event.id]);

    for (const doomedRow of doomed) {
      await recordDeletion(doomedRow.user_id, doomedRow.id);
      broadcastToUser(doomedRow.user_id, { type: "calendar_event_deleted", payload: { id: doomedRow.id } });
    }

    return { success: true };
  });
