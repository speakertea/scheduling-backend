import { Elysia } from "elysia";
import { verifyToken } from "../auth";
import { query, updateLastActive } from "../db";

/**
 * Auth guard: verifies JWT, checks disabled status, updates last_active.
 */
export const authGuard = new Elysia({ name: "authGuard" })
  .resolve({ as: "scoped" }, async ({ headers, set }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    if (!token) {
      set.status = 401;
      return { userId: null as string | null, authError: "Missing Authorization header" };
    }
    try {
      const { userId } = verifyToken(token);

      // Check if user exists and isn't disabled
      const { rows } = await query("SELECT is_disabled FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) {
        set.status = 401;
        return { userId: null as string | null, authError: "User not found" };
      }
      if (rows[0].is_disabled) {
        set.status = 403;
        return { userId: null as string | null, authError: "Account disabled" };
      }

      // Fire-and-forget last active update
      updateLastActive(userId).catch(() => {});

      return { userId: userId as string | null, authError: null as string | null };
    } catch {
      set.status = 401;
      return { userId: null as string | null, authError: "Invalid or expired token" };
    }
  })
  .onBeforeHandle({ as: "scoped" }, ({ userId, authError, set }) => {
    if (authError) {
      set.status = set.status && set.status >= 400 ? set.status : 401;
      return { error: authError };
    }
  });
