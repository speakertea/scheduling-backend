import { Elysia } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";

export const referralRoutes = new Elysia({ prefix: "/referrals" })
  .use(authGuard)
  .get("/", async ({ userId, set }) => {
    if (!userId) {
      set.status = 401;
      return { error: "Unauthorized" };
    }

    // 1. Get the user's referral_code
    const { rows: userRows } = await query(
      "SELECT referral_code FROM users WHERE id = $1",
      [userId]
    );

    if (userRows.length === 0) {
      set.status = 404;
      return { error: "User not found" };
    }

    const referralCode = userRows[0].referral_code;

    // 2. Get all users referred by this user (referred_by = userId)
    const { rows: referrals } = await query(
      "SELECT name, created_at, last_active_at FROM users WHERE referred_by = $1 ORDER BY created_at DESC",
      [userId]
    );

    // 3. Return referralCode, referrals array, and total count
    return {
      referralCode,
      referrals: referrals.map((r: any) => ({
        name: r.name,
        createdAt: r.created_at,
        lastActiveAt: r.last_active_at,
      })),
      total: referrals.length,
    };
  });
