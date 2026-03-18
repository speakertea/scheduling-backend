import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { broadcastToUser } from "../broadcast";

const toCalEvent = (r: any) => ({
  id: r.id, title: r.title, creator: r.creator, group: r.group_name || undefined,
  location: r.location, startAt: r.start_at, endAt: r.end_at, notes: r.notes || undefined,
  totalSentTo: r.total_sent_to, acceptStatus: r.accept_status || null,
  reminderSettings: r.reminder_times ? { times: JSON.parse(r.reminder_times) } : null,
});

export const calendarEventRoutes = new Elysia({ prefix: "/calendar-events" })
  .use(authGuard)

  .get("/", async ({ userId, query: qs }) => {
    let sql = "SELECT * FROM calendar_events WHERE user_id=$1";
    const params: any[] = [userId];
    if (qs.type === "group") sql += " AND is_group=TRUE";
    else if (qs.type === "friend") sql += " AND is_group=FALSE";
    sql += " ORDER BY start_at DESC";
    const { rows } = await query(sql, params);
    return rows.map(toCalEvent);
  })

  .patch("/:id", async ({ userId, params, body }) => {
    const { acceptStatus, reminderSettings } = body;
    const { rows } = await query("SELECT * FROM calendar_events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
    const row = rows[0];

    const sets: string[] = [];
    const p: any[] = [];
    let idx = 1;
    if (acceptStatus !== undefined) { sets.push(`accept_status=$${idx++}`); p.push(acceptStatus); }
    if (reminderSettings !== undefined) { sets.push(`reminder_times=$${idx++}`); p.push(reminderSettings?.times ? JSON.stringify(reminderSettings.times) : null); }

    if (sets.length > 0) { p.push(row.id); await query(`UPDATE calendar_events SET ${sets.join(",")} WHERE id=$${idx}`, p); }

    if (acceptStatus === "accepted") {
      const { rows: ex } = await query("SELECT id FROM events WHERE user_id=$1 AND title=$2 AND start_at=$3", [userId, row.title, row.start_at]);
      if (ex.length === 0) {
        let type = "class";
        const tl = row.title.toLowerCase();
        if (tl.includes("study") || tl.includes("homework")) type = "study";
        else if (tl.includes("meet") || tl.includes("coffee") || tl.includes("hangout")) type = "meetup";
        await query(
          "INSERT INTO events (id,user_id,title,type,start_at,end_at,location,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
          [crypto.randomUUID(), userId, row.title, type, row.start_at, row.end_at, row.location,
           row.notes || `Created by ${row.creator}${row.group_name ? ` • ${row.group_name}` : ""}`]
        );
      }
    }

    const { rows: updated } = await query("SELECT * FROM calendar_events WHERE id=$1", [row.id]);
    const result = toCalEvent(updated[0]);
    broadcastToUser(userId, { type: "calendar_event_updated", payload: result });
    return result;
  }, {
    body: t.Object({
      acceptStatus: t.Optional(t.Union([t.Literal("accepted"), t.Literal("declined"), t.Null()])),
      reminderSettings: t.Optional(t.Any()),
    }),
  })

  // Revoke a sent calendar event (creator only)
  .delete("/:id", async ({ userId, params, set }) => {
    const { rows } = await query(
      "SELECT id FROM calendar_events WHERE id=$1 AND user_id=$2 AND creator='You'",
      [params.id, userId]
    );
    if (rows.length === 0) {
      set.status = 404;
      return new Response(JSON.stringify({ error: "Not found or not the creator." }), { status: 404 });
    }
    await query("DELETE FROM calendar_events WHERE id=$1", [params.id]);
    return { success: true };
  });
