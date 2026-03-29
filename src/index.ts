import { Elysia, t } from "elysia";
import { cors } from "@elysiajs/cors";
import { createTables, logApiRequest } from "./db";

import { rateLimiter } from "./rate-limiter";
import { checkAndSendNotifications } from "./notifications";
import { authRoutes } from "./routes/auth";
import { profileRoutes } from "./routes/profile";
import { eventRoutes } from "./routes/events";
import { inviteRoutes } from "./routes/invites";
import { calendarEventRoutes } from "./routes/calendar-events";
import { socialCreateRoutes } from "./routes/social-create";
import { groupRoutes, friendRoutes, notificationRoutes } from "./routes/misc";
import { adminRoutes } from "./routes/admin";
import { pushRoutes } from "./routes/push";
import { avatarRoutes } from "./routes/avatar";
import { referralRoutes } from "./routes/referrals";
import { peopleRoutes } from "./routes/people";
import { sponsoredRoutes } from "./routes/sponsored";
import { syncRoutes } from "./routes/sync";
import { query as dbQuery } from "./db";
import { sendSponsoredEvent } from "./sponsored-send";
import { assertJwtConfigured, verifyToken } from "./auth";
import { addConnection, removeConnection } from "./broadcast";

const PORT = Number(process.env.PORT) || 3000;

assertJwtConfigured();
await createTables();

const app = new Elysia({ serve: { maxRequestBodySize: 10 * 1024 * 1024 } })
  .use(cors())
  .use(rateLimiter)

  // Request logging middleware (logs every API request for system health tracking)
  .onAfterHandle(({ request, set }) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api")) {
      const status = typeof set.status === "number" ? set.status : 200;
      // We don't have exact timing here, but we log what we can
      logApiRequest(request.method, url.pathname, status, 0).catch(() => {});
    }
  })

  // Health check
  .get("/api/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  // All API routes
  .group("/api", (app) =>
    app
      .use(authRoutes)
      .use(profileRoutes)
      .use(eventRoutes)
      .use(inviteRoutes)
      .use(calendarEventRoutes)
      .use(socialCreateRoutes)
      .use(groupRoutes)
      .use(friendRoutes)
      .use(notificationRoutes)
      .use(adminRoutes)
      .use(pushRoutes)
      .use(avatarRoutes)
      .use(referralRoutes)
      .use(peopleRoutes)
      .use(sponsoredRoutes)
      .use(syncRoutes)
      .ws("/ws", {
        query: t.Object({ token: t.Optional(t.String()) }),
        async open(ws) {
          const token = (ws.data.query as any)?.token ?? "";
          try {
            const { userId, tokenVersion } = verifyToken(token);
            const { rows } = await dbQuery(
              "SELECT is_disabled, token_version FROM users WHERE id = $1",
              [userId]
            );
            if (
              rows.length === 0 ||
              rows[0].is_disabled ||
              (rows[0].token_version ?? 0) !== tokenVersion
            ) {
              ws.close();
              return;
            }
            (ws.data as any).userId = userId;
            addConnection(userId, ws);
          } catch {
            ws.close();
          }
        },
        close(ws) {
          const userId = (ws.data as any).userId;
          if (userId) removeConnection(userId, ws);
        },
        message() {},
      })
  )

  .listen(PORT);

// Check for upcoming events and push notify every 5 minutes
setInterval(() => { checkAndSendNotifications().catch(console.error); }, 5 * 60_000);

// Auto-expire invites 24 hours after they end
setInterval(async () => {
  try {
    const result = await dbQuery(
      "UPDATE invites SET status = 'expired', updated_at = NOW() WHERE status = 'active' AND end_at < (NOW() - INTERVAL '24 hours')::text"
    );
    if ((result.rowCount ?? 0) > 0) {
      console.log(`[invite-expiry] Expired ${result.rowCount} invites`);
    }
  } catch (err: any) {
    console.error("[invite-expiry] Error:", err.message);
  }
}, 5 * 60_000);

// Check for scheduled sponsored events every 60 seconds
setInterval(async () => {
  try {
    const { rows } = await dbQuery(
      "SELECT * FROM sponsored_events WHERE status = 'scheduled' AND scheduled_send_at <= NOW()"
    );
    for (const event of rows) {
      await sendSponsoredEvent(event);
      console.log(`[sponsored-scheduler] Sent sponsored event ${event.id} (${event.title})`);
    }
  } catch (err: any) {
    console.error("[sponsored-scheduler] Error:", err.message);
  }
}, 60_000);

console.log(`
  🦊 Scheduling App API (Elysia + Bun)
  Running on http://localhost:${PORT}

  Admin: To make yourself admin, run:
  bun run src/make-admin.ts your@email.com
`);

export type App = typeof app;

