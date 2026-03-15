import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { createTables, logApiRequest } from "./db";

import { rateLimiter } from "./rate-limiter";
import { authRoutes } from "./routes/auth";
import { profileRoutes } from "./routes/profile";
import { eventRoutes } from "./routes/events";
import { inviteRoutes } from "./routes/invites";
import { calendarEventRoutes } from "./routes/calendar-events";
import { socialCreateRoutes } from "./routes/social-create";
import { groupRoutes, friendRoutes, notificationRoutes } from "./routes/misc";
import { adminRoutes } from "./routes/admin";

const PORT = Number(process.env.PORT) || 3000;

await createTables();

const app = new Elysia()
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
  )

  .listen(PORT);

console.log(`
  🦊 Scheduling App API (Elysia + Bun)
  Running on http://localhost:${PORT}

  Admin: To make yourself admin, run:
  bun run src/make-admin.ts your@email.com
`);

export type App = typeof app;
