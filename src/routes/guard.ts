import { Elysia } from "elysia";
import { verifyToken } from "../auth";
import { query, updateLastActive, updateUserLocation } from "../db";
import { lookupIP } from "../geo";

export const authGuard = new Elysia({ name: "authGuard" })
  .resolve({ as: "scoped" }, async ({ headers, set }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    if (!token) {
      set.status = 401;
      return { userId: null as string | null, authError: "Missing Authorization header" };
    }

    try {
      const { userId } = verifyToken(token);
      const { rows } = await query("SELECT is_disabled, location_updated_at FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) {
        set.status = 401;
        return { userId: null as string | null, authError: "User not found" };
      }
      if (rows[0].is_disabled) {
        set.status = 403;
        return { userId: null as string | null, authError: "Account disabled" };
      }

      updateLastActive(userId).catch(() => {});

      const locUpdated = rows[0].location_updated_at;
      const isStale = !locUpdated || (Date.now() - new Date(locUpdated).getTime()) > 7 * 24 * 60 * 60 * 1000;
      if (isStale) {
        const ip = headers["x-forwarded-for"]?.split(",")[0]?.trim() || "";
        if (ip) {
          lookupIP(ip).then((geo) => {
            if (geo) updateUserLocation(userId, geo, ip);
          }).catch(() => {});
        }
      }

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
