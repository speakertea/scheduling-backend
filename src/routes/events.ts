import { Elysia, t } from "elysia";
import { query as dbQuery } from "../db";
import { authGuard } from "./guard";
import { sanitizeTitle, sanitizeLocation, sanitizeNotes } from "../utils";
import { broadcastToUser } from "../broadcast";

const toEvent = (row: any) => ({
  id: row.id,
  title: row.title,
  type: row.type,
  startAt: row.start_at,
  endAt: row.end_at,
  location: row.location || undefined,
  notes: row.notes || undefined,
  recurrenceRule: row.recurrence_rule || undefined,
  parentEventId: row.parent_event_id || undefined,
});

function nextOccurrence(date: Date, rule: string): Date {
  const next = new Date(date);
  switch (rule) {
    case "daily":
      next.setDate(next.getDate() + 1);
      break;
    case "weekly":
      next.setDate(next.getDate() + 7);
      break;
    case "biweekly":
      next.setDate(next.getDate() + 14);
      break;
    case "monthly":
      next.setMonth(next.getMonth() + 1);
      break;
  }
  return next;
}

async function recordDeletion(userId: string, entityId: string, payload?: Record<string, unknown>) {
  await dbQuery(
    "INSERT INTO deleted_entities (user_id, entity_type, entity_id, payload_json) VALUES ($1, 'event', $2, $3)",
    [userId, entityId, payload ? JSON.stringify(payload) : null]
  );
}

async function broadcastEvent(userId: string, row: any) {
  broadcastToUser(userId, { type: "event_upsert", payload: toEvent(row) });
}

export const eventRoutes = new Elysia({ prefix: "/events" })
  .use(authGuard)

  .get("/", async ({ userId, query: qs }) => {
    const currentUserId = userId as string;
    const start = typeof qs.start === "string" ? qs.start : null;
    const end = typeof qs.end === "string" ? qs.end : null;

    const conditions = ["user_id = $1"];
    const params: any[] = [currentUserId];

    if (start) {
      params.push(start);
      conditions.push(`end_at >= $${params.length}`);
    }
    if (end) {
      params.push(end);
      conditions.push(`start_at <= $${params.length}`);
    }

    const { rows } = await dbQuery(
      `SELECT * FROM events WHERE ${conditions.join(" AND ")} ORDER BY start_at ASC`,
      params
    );
    return rows.map(toEvent);
  })

  .get("/:id", async ({ userId, params }) => {
    const currentUserId = userId as string;
    const { rows } = await dbQuery("SELECT * FROM events WHERE id = $1 AND user_id = $2", [params.id, currentUserId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    return toEvent(rows[0]);
  })

  .post("/", async ({ userId, body, set }) => {
    const currentUserId = userId as string;
    const { id, title: rawTitle, type, startAt, endAt, location: rawLocation, notes: rawNotes, recurrenceRule, recurrenceEndDate } = body;
    const title = sanitizeTitle(rawTitle);
    const location = rawLocation ? sanitizeLocation(rawLocation) : undefined;
    const notes = rawNotes ? sanitizeNotes(rawNotes) : undefined;

    const parentId = id || crypto.randomUUID();
    const durationMs = new Date(endAt).getTime() - new Date(startAt).getTime();
    const createdRows: any[] = [];

    await dbQuery(
      `INSERT INTO events (id, user_id, title, type, start_at, end_at, location, notes, recurrence_rule, recurrence_end_date, parent_event_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [parentId, currentUserId, title, type, startAt, endAt, location || null, notes || null, recurrenceRule || null, recurrenceEndDate || null, null]
    );
    const { rows: parentRows } = await dbQuery("SELECT * FROM events WHERE id = $1", [parentId]);
    createdRows.push(parentRows[0]);

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
          `INSERT INTO events (id, user_id, title, type, start_at, end_at, location, notes, recurrence_rule, recurrence_end_date, parent_event_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [instanceId, currentUserId, title, type, instanceStart, instanceEnd, location || null, notes || null, recurrenceRule, recurrenceEndDate, parentId]
        );
        const { rows: created } = await dbQuery("SELECT * FROM events WHERE id = $1", [instanceId]);
        createdRows.push(created[0]);
        count++;
      }
    }

    set.status = 201;
    for (const row of createdRows) await broadcastEvent(currentUserId, row);
    return createdRows.map(toEvent);
  }, {
    body: t.Object({
      id: t.Optional(t.String()),
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
    const currentUserId = userId as string;
    const { rows } = await dbQuery("SELECT * FROM events WHERE id = $1 AND user_id = $2", [params.id, currentUserId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });

    const event = rows[0];
    const editAll = (qs as Record<string, string>).editAll === "true";
    const { title: rawTitle, type, startAt, endAt, location: rawLocation, notes: rawNotes } = body;

    const title = rawTitle !== undefined ? sanitizeTitle(rawTitle) : event.title;
    const location = rawLocation !== undefined ? (rawLocation ? sanitizeLocation(rawLocation) : null) : event.location;
    const notes = rawNotes !== undefined ? (rawNotes ? sanitizeNotes(rawNotes) : null) : event.notes;
    const finalType = type || event.type;
    const finalStartAt = startAt || event.start_at;
    const finalEndAt = endAt || event.end_at;

    let updatedRows: any[] = [];

    if (editAll) {
      const parentId = event.parent_event_id || event.id;
      await dbQuery(
        `UPDATE events
         SET title = $1, type = $2, location = $3, notes = $4, updated_at = NOW()
         WHERE user_id = $5 AND (id = $6 OR parent_event_id = $6) AND start_at >= $7`,
        [title, finalType, location, notes, currentUserId, parentId, event.start_at]
      );
      const { rows: refreshed } = await dbQuery(
        "SELECT * FROM events WHERE user_id = $1 AND (id = $2 OR parent_event_id = $2) AND start_at >= $3 ORDER BY start_at ASC",
        [currentUserId, parentId, event.start_at]
      );
      updatedRows = refreshed;
    } else {
      await dbQuery(
        `UPDATE events
         SET title = $1, type = $2, start_at = $3, end_at = $4, location = $5, notes = $6, updated_at = NOW()
         WHERE id = $7 AND user_id = $8`,
        [title, finalType, finalStartAt, finalEndAt, location, notes, params.id, currentUserId]
      );
      const { rows: refreshed } = await dbQuery("SELECT * FROM events WHERE id = $1", [params.id]);
      updatedRows = refreshed;
    }

    for (const row of updatedRows) await broadcastEvent(currentUserId, row);
    return updatedRows.length === 1 ? toEvent(updatedRows[0]) : updatedRows.map(toEvent);
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
    const currentUserId = userId as string;
    const { rows } = await dbQuery("SELECT * FROM events WHERE id = $1 AND user_id = $2", [params.id, currentUserId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });

    const event = rows[0];
    const deleteAll = (qs as Record<string, string>).deleteAll === "true";

    if (deleteAll) {
      const parentId = event.parent_event_id || event.id;
      const { rows: doomed } = await dbQuery(
        "SELECT id FROM events WHERE user_id = $1 AND (id = $2 OR parent_event_id = $2)",
        [currentUserId, parentId]
      );
      for (const doomedRow of doomed) {
        await recordDeletion(currentUserId, doomedRow.id, { deleteAll: true, parentId });
      }
      await dbQuery("DELETE FROM events WHERE user_id = $1 AND (id = $2 OR parent_event_id = $2)", [currentUserId, parentId]);
      broadcastToUser(currentUserId, { type: "event_deleted", payload: { id: parentId, deleteAll: true, parentId } });
    } else {
      await recordDeletion(currentUserId, params.id, { deleteAll: false });
      await dbQuery("DELETE FROM events WHERE id = $1 AND user_id = $2", [params.id, currentUserId]);
      broadcastToUser(currentUserId, { type: "event_deleted", payload: { id: params.id, deleteAll: false } });
    }

    return { success: true };
  });


