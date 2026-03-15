import { Elysia } from "elysia";
import { verifyToken } from "../auth";

/**
 * Elysia plugin: resolves `userId` from the Bearer token.
 * Returns 401 if token is missing or invalid.
 */
export const authGuard = new Elysia({ name: "authGuard" })
  .resolve(({ headers, set }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    if (!token) {
      set.status = 401;
      return { userId: null as string | null, authError: "Missing Authorization header" };
    }
    try {
      const { userId } = verifyToken(token);
      return { userId: userId as string | null, authError: null as string | null };
    } catch {
      set.status = 401;
      return { userId: null as string | null, authError: "Invalid or expired token" };
    }
  })
  .onBeforeHandle(({ userId, authError, set }) => {
    if (authError) {
      set.status = 401;
      return { error: authError };
    }
  });
