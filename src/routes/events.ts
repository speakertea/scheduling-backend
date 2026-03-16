import { Elysia, t } from "elysia";
import { query as dbQuery } from "../db";
import { authGuard } from "./guard";
import { sanitizeTitle, sanitizeLocation, sanitizeNotes } from "../utils";

const toEvent = (r: any) => ({
  id: r.id, title: r.title, type: r.type, startAt: r.start_at, endAt: r.end_at,
  location: r.location || undefined, notes: r.notes || undefined,
  recurrenceRule: r.recurrence_rule || undefined,
  parentEventId: r.parent_event_id || undefined,
});

function nextOccurrence(date: Date, rule: string): Date {
  const d = new Date(date);
  switch (rule) {
    case "daily":    d.setDate(d.getDate() + 1);   break;
    case "weekly":   d.setDate(d.getDate() + 7);   break;
    case "biweekly": d.setDate(d.getDate() + 14);  break;
    case "monthly":  d.setMonth(d.getMonth() + 1); break;
  }
  return d;
}

export const eventRoutes = new Elysia({ prefix: "/events" })
  .use(authGuard)

  .get("/", async ({ userId }) => {
    const { rows } = await dbQuery("SELECT * FROM events WHERE user_id=$1 ORDER BY start_at ASC", [userId]);
    return rows.map(toEvent);
  })

  .get("/:id", async ({ userId, params }) => {
    const { rows } = await dbQuery("SELECT * FROM events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    return toEvent(rows[0]);
  })

  .post("/", async ({ userId, body, set }) => {
    const { title: rawTitle, type, startAt, endAt, location: rawLocation, notes: rawNotes, recurrenceRule, recurrenceEndDate } = body;
    const title    = sanitizeTitle(rawTitle);
    const location = rawLocation ? sanitizeLocation(rawLocation) : undefined;
    const notes    = rawNotes    ? sanitizeNotes(rawNotes)        : undefined;

    const parentId = crypto.randomUUID();
    const durationMs = new Date(endAt).getTime() - new Date(startAt).getTime();

    await dbQuery(
      "INSERT INTO events (id,user_id,title,type,start_at,end_at,location,notes,recurrence_rule,recurrence_end_date,parent_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
      [parentId, userId, title, type, startAt, endAt, location || null, notes || null, recurrenceRule || null, recurrenceEndDate || null, null]
    );

    if (recurrenceRule && recurrenceEndDate) {
      const endBoundary = new Date(recurrenceEndDate);
      let current = new Date(startAt);
      let count = 1;
      while (count < 52) {
        current = nextOccurrence(current, recurrenceRule);
        if (current > endBoundary) break;
        const instanceId = crypto.randomUUID();
        const instanceStart = current.toISOString();
        const instanceEnd = new Date(current.getTime() + durationMs).toISOString();
        await dbQuery(
          "INSERT INTO events (id,user_id,title,type,start_at,end_at,location,notes,recurrence_rule,recurrence_end_date,parent_event_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
          [instanceId, userId, title, type, instanceStart, instanceEnd, location || null, notes || null, recurrenceRule, recurrenceEndDate, parentId]
        );
        count++;
      }
    }

    set.status = 201;
    return {
      id: parentId, title, type, startAt, endAt,
      location: location || undefined, notes: notes || undefined,
      recurrenceRule: recurrenceRule || undefined,
    };
  }, {
    body: t.Object({
      title: t.String(),
      type: t.Union([t.Literal("study"), t.Literal("meetup"), t.Literal("class")]),
      startAt: t.String(),
      endAt: t.String(),
      location: t.Optional(t.String()),
      notes: t.Optional(t.String()),
      recurrenceRule: t.Optional(t.String()),
      recurrenceEndDate: t.Optional(t.String()),
    }),
  })

  .patch("/:id", async ({ userId, params, query: qs, body }) => {
    const { rows } = await dbQuery("SELECT * FROM events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    const ev = rows[0];
    const editAll = (qs as Record<string, string>).editAll === "true";

    const { title: rawTitle, type, startAt, endAt, location: rawLocation, notes: rawNotes } = body;
    const title    = rawTitle    !== undefined ? sanitizeTitle(rawTitle)                              : ev.title;
    const location = rawLocation !== undefined ? (rawLocation ? sanitizeLocation(rawLocation) : null) : ev.location;
    const notes    = rawNotes    !== undefined ? (rawNotes    ? sanitizeNotes(rawNotes)        : null) : ev.notes;
    const finalType    = type    || ev.type;
    const finalStartAt = startAt || ev.start_at;
    const finalEndAt   = endAt   || ev.end_at;

    if (editAll) {
      const parentId = ev.parent_event_id || ev.id;
      await dbQuery(
        `UPDATE events SET title=$1, type=$2, location=$3, notes=$4 WHERE user_id=$5 AND (id=$6 OR parent_event_id=$6) AND start_at >= $7`,
        [title, finalType, location, notes, userId, parentId, ev.start_at]
      );
    } else {
      await dbQuery(
        `UPDATE events SET title=$1, type=$2, start_at=$3, end_at=$4, location=$5, notes=$6 WHERE id=$7 AND user_id=$8`,
        [title, finalType, finalStartAt, finalEndAt, location, notes, params.id, userId]
      );
    }

    const { rows: updated } = await dbQuery("SELECT * FROM events WHERE id=$1", [params.id]);
    if (!updated[0]) return { success: true };
    return toEvent(updated[0]);
  }, {
    body: t.Object({
      title: t.Optional(t.String()),
      type: t.Optional(t.Union([t.Literal("study"), t.Literal("meetup"), t.Literal("class")])),
      startAt: t.Optional(t.String()),
      endAt: t.Optional(t.String()),
      location: t.Optional(t.String()),
      notes: t.Optional(t.String()),
    }),
  })

  .delete("/:id", async ({ userId, params, query: qs }) => {
    const { rows } = await dbQuery("SELECT * FROM events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    const ev = rows[0];
    const deleteAll = (qs as Record<string, string>).deleteAll === "true";

    if (deleteAll) {
      const parentId = ev.parent_event_id || ev.id;
      await dbQuery("DELETE FROM events WHERE user_id=$1 AND (id=$2 OR parent_event_id=$2)", [userId, parentId]);
    } else {
      await dbQuery("DELETE FROM events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    }

    return { success: true };
  });
