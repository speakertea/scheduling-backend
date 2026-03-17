import { Elysia, t } from "elysia";
import { authGuard } from "./guard";
import { query } from "../db";

export const sponsoredRoutes = new Elysia({ name: "sponsoredRoutes" })
  .use(authGuard)

  // List delivered sponsored events for current user
  .get("/sponsored-events", async ({ userId }) => {
    const { rows } = await query(
      `SELECT
         se.id, se.title, se.description, se.sponsor_name, se.location,
         se.event_url, se.start_at, se.end_at, se.created_at,
         sed.opened, sed.delivered_at,
         ser.rsvp_status,
         (SELECT COUNT(*) FROM sponsored_event_rsvps WHERE sponsored_event_id = se.id AND rsvp_status = 'going')::int AS going_count,
         (SELECT COUNT(*) FROM sponsored_event_rsvps WHERE sponsored_event_id = se.id AND rsvp_status = 'interested')::int AS interested_count
       FROM sponsored_event_deliveries sed
       JOIN sponsored_events se ON se.id = sed.sponsored_event_id
       LEFT JOIN sponsored_event_rsvps ser ON ser.sponsored_event_id = se.id AND ser.user_id = $1
       WHERE sed.user_id = $1 AND sed.delivered = TRUE
       ORDER BY sed.delivered_at DESC`,
      [userId]
    );
    return { events: rows };
  })

  // RSVP to a sponsored event
  .post(
    "/sponsored-events/:id/rsvp",
    async ({ userId, params, body, set }) => {
      // Verify delivery exists
      const { rows: del } = await query(
        "SELECT id FROM sponsored_event_deliveries WHERE sponsored_event_id = $1 AND user_id = $2 AND delivered = TRUE",
        [params.id, userId]
      );
      if (del.length === 0) {
        set.status = 404;
        return { error: "Sponsored event not found" };
      }

      const rsvpId = crypto.randomUUID();
      await query(
        `INSERT INTO sponsored_event_rsvps (id, sponsored_event_id, user_id, rsvp_status)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (sponsored_event_id, user_id)
         DO UPDATE SET rsvp_status = EXCLUDED.rsvp_status`,
        [rsvpId, params.id, userId, body.rsvp_status]
      );

      // Update total_rsvp count on the event
      const { rows: countRows } = await query(
        "SELECT COUNT(*) AS cnt FROM sponsored_event_rsvps WHERE sponsored_event_id = $1 AND rsvp_status IN ('going','interested')",
        [params.id]
      );
      await query("UPDATE sponsored_events SET total_rsvp = $1 WHERE id = $2", [
        countRows[0].cnt,
        params.id,
      ]);

      return { ok: true, rsvp_status: body.rsvp_status };
    },
    {
      body: t.Object({
        rsvp_status: t.Union([
          t.Literal("going"),
          t.Literal("interested"),
          t.Literal("not_going"),
        ]),
      }),
    }
  )

  // Mark a sponsored event as opened (fire-and-forget from client)
  .post("/sponsored-events/:id/opened", async ({ userId, params }) => {
    // Fire-and-forget update
    query(
      `UPDATE sponsored_event_deliveries SET opened = TRUE, opened_at = NOW()
       WHERE sponsored_event_id = $1 AND user_id = $2 AND opened = FALSE`,
      [params.id, userId]
    ).then(async () => {
      // Update total_opened count
      const { rows } = await query(
        "SELECT COUNT(*) AS cnt FROM sponsored_event_deliveries WHERE sponsored_event_id = $1 AND opened = TRUE",
        [params.id]
      );
      await query("UPDATE sponsored_events SET total_opened = $1 WHERE id = $2", [
        rows[0].cnt,
        params.id,
      ]);
    }).catch(() => {});

    return { ok: true };
  });
