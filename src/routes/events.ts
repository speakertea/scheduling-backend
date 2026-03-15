import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { sanitizeTitle, sanitizeLocation, sanitizeNotes } from "../utils";

const toEvent = (r: any) => ({
  id: r.id, title: r.title, type: r.type, startAt: r.start_at, endAt: r.end_at,
  location: r.location || undefined, notes: r.notes || undefined,
});

export const eventRoutes = new Elysia({ prefix: "/events" })
  .use(authGuard)

  .get("/", async ({ userId }) => {
    const { rows } = await query("SELECT * FROM events WHERE user_id=$1 ORDER BY start_at ASC", [userId]);
    return rows.map(toEvent);
  })

  .get("/:id", async ({ userId, params }) => {
    const { rows } = await query("SELECT * FROM events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (rows.length === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    return toEvent(rows[0]);
  })

  .post("/", async ({ userId, body, set }) => {
    const { title: rawTitle, type, startAt, endAt, location: rawLocation, notes: rawNotes } = body;
    const title    = sanitizeTitle(rawTitle);
    const location = rawLocation ? sanitizeLocation(rawLocation) : undefined;
    const notes    = rawNotes    ? sanitizeNotes(rawNotes)        : undefined;
    const id = crypto.randomUUID();
    await query(
      "INSERT INTO events (id,user_id,title,type,start_at,end_at,location,notes) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)",
      [id, userId, title, type, startAt, endAt, location || null, notes || null]
    );
    set.status = 201;
    return { id, title, type, startAt, endAt, location: location || undefined, notes: notes || undefined };
  }, {
    body: t.Object({
      title: t.String(),
      type: t.Union([t.Literal("study"), t.Literal("meetup"), t.Literal("class")]),
      startAt: t.String(),
      endAt: t.String(),
      location: t.Optional(t.String()),
      notes: t.Optional(t.String()),
    }),
  })

  .delete("/:id", async ({ userId, params }) => {
    const result = await query("DELETE FROM events WHERE id=$1 AND user_id=$2", [params.id, userId]);
    if (result.rowCount === 0) return new Response(JSON.stringify({ error: "Event not found" }), { status: 404 });
    return { success: true };
  });
