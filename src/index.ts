import { Elysia } from "elysia";
import { cors } from "@elysiajs/cors";
import { createTables } from "./db";

import { authRoutes } from "./routes/auth";
import { profileRoutes } from "./routes/profile";
import { eventRoutes } from "./routes/events";
import { inviteRoutes } from "./routes/invites";
import { calendarEventRoutes } from "./routes/calendar-events";
import { socialCreateRoutes } from "./routes/social-create";
import { groupRoutes, friendRoutes, notificationRoutes } from "./routes/misc";

const PORT = Number(process.env.PORT) || 3000;

// Initialize database tables, then start
await createTables();

const app = new Elysia()
  .use(cors())

  // Health check
  .get("/api/health", () => ({ status: "ok", timestamp: new Date().toISOString() }))

  // All API routes under /api
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
  )

  .listen(PORT);

console.log(`
  🦊 Scheduling App API (Elysia + Bun)
  Running on http://localhost:${PORT}
`);

export type App = typeof app;
