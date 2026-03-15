import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

export const groupRoutes = new Elysia({ prefix: "/groups" })
  .use(authGuard)
  .get("/", async () => {
    const { rows: groups } = await query("SELECT * FROM groups_ ORDER BY name");
    const results = [];
    for (const g of groups) {
      const { rows: members } = await query("SELECT id,name,role FROM group_members WHERE group_id=$1", [g.id]);
      results.push({ id: g.id, name: g.name, totalMembers: g.total_members, members });
    }
    return results;
  });

export const friendRoutes = new Elysia({ prefix: "/friends" })
  .use(authGuard)
  .get("/", async ({ userId }) => {
    const { rows } = await query("SELECT id,name FROM friends WHERE user_id=$1 ORDER BY name", [userId]);
    return rows;
  });

export const notificationRoutes = new Elysia({ prefix: "/notifications" })
  .use(authGuard)

  .get("/dismissed", async ({ userId }) => {
    const { rows: general } = await query(
      "SELECT notification_id FROM notification_dismissals WHERE user_id=$1 AND type='general'", [userId]
    );
    const { rows: invite } = await query(
      "SELECT notification_id,dismissed_date FROM notification_dismissals WHERE user_id=$1 AND type='invite'", [userId]
    );
    const byDate: Record<string, string[]> = {};
    for (const r of invite) {
      if (!byDate[r.dismissed_date]) byDate[r.dismissed_date] = [];
      byDate[r.dismissed_date].push(r.notification_id);
    }
    return { dismissedNotificationIds: general.map((r: any) => r.notification_id), inviteNotificationDismissals: byDate };
  })

  .post("/dismiss", async ({ userId, body }) => {
    const dismissType = body.type === "invite" ? "invite" : "general";
    const dismissDate = body.date || new Date().toISOString().slice(0, 10);
    await query(
      "INSERT INTO notification_dismissals (user_id,notification_id,dismissed_date,type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [userId, body.notificationId, dismissDate, dismissType]
    );
    return { success: true };
  }, {
    body: t.Object({
      notificationId: t.String(),
      type: t.Optional(t.String()),
      date: t.Optional(t.String()),
    }),
  })

  .post("/dismiss-bulk", async ({ userId, body }) => {
    const dismissType = body.type === "invite" ? "invite" : "general";
    const dismissDate = body.date || new Date().toISOString().slice(0, 10);
    for (const id of body.notificationIds) {
      await query(
        "INSERT INTO notification_dismissals (user_id,notification_id,dismissed_date,type) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING",
        [userId, id, dismissDate, dismissType]
      );
    }
    return { success: true };
  }, {
    body: t.Object({
      notificationIds: t.Array(t.String()),
      type: t.Optional(t.String()),
      date: t.Optional(t.String()),
    }),
  })

  .post("/clear", async ({ userId, body }) => {
    for (const id of body.notificationIds) {
      await query("DELETE FROM notification_dismissals WHERE user_id=$1 AND notification_id=$2 AND type='general'", [userId, id]);
    }
    return { success: true };
  }, {
    body: t.Object({ notificationIds: t.Array(t.String()) }),
  });
