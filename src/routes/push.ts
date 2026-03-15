import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

export const pushRoutes = new Elysia({ prefix: "/push-token" })
  .use(authGuard)

  .post("/", async ({ userId, body }) => {
    await query("UPDATE users SET push_token = $1 WHERE id = $2", [body.token, userId]);
    return { success: true };
  }, {
    body: t.Object({
      token: t.String(),
    }),
  });
