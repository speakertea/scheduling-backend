import { Elysia } from "elysia";
import { verifyToken } from "../auth";
import { query, updateLastActive } from "../db";

export const adminGuard = new Elysia({ name: "adminGuard" })
  .resolve({ as: "scoped" }, async ({ headers, set }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    if (!token) {
      set.status = 401;
      return { userId: null as string | null, authError: "Missing Authorization header" };
    }

    try {
      const { userId } = verifyToken(token);
      const { rows } = await query("SELECT id, is_admin, is_disabled FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) {
        set.status = 401;
        return { userId: null as string | null, authError: "User not found" };
      }
      if (rows[0].is_disabled) {
        set.status = 403;
        return { userId: null as string | null, authError: "Account disabled" };
      }
      if (!rows[0].is_admin) {
        set.status = 403;
        return { userId: null as string | null, authError: "Admin access required" };
      }

      updateLastActive(userId).catch(() => {});
      return { userId: userId as string | null, authError: null as string | null };
    } catch {
      set.status = 401;
      return { userId: null as string | null, authError: "Invalid or expired token" };
    }
  })
  .onBeforeHandle({ as: "scoped" }, ({ authError, set }) => {
    if (authError) {
      const statusCode = typeof set.status === "number" ? set.status : Number(set.status || 0);
      set.status = statusCode >= 400 ? statusCode : 401;
      return { error: authError };
    }
  });
