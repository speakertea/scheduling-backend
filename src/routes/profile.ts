import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { sanitizeName, sanitizeNotes } from "../utils";

/** Fetch a user row, gracefully handling missing username_changed_at column */
async function getUser(userId: string) {
  try {
    const { rows } = await query(
      "SELECT username,name,about_me,profile_picture,username_changed_at FROM users WHERE id=$1",
      [userId]
    );
    return rows[0] ?? null;
  } catch {
    // Column doesn't exist yet — fall back without it
    const { rows } = await query(
      "SELECT username,name,about_me,profile_picture FROM users WHERE id=$1",
      [userId]
    );
    return rows[0] ? { ...rows[0], username_changed_at: null } : null;
  }
}

export const profileRoutes = new Elysia({ prefix: "/profile" })
  .use(authGuard)

  .get("/", async ({ userId, set }) => {
    const u = await getUser(userId);
    if (!u) { set.status = 404; return { error: "User not found" }; }
    return {
      username: u.username,
      name: u.name,
      aboutMe: u.about_me,
      profilePicture: u.profile_picture,
      usernameChangedAt: u.username_changed_at ?? null,
    };
  })

  .patch("/", async ({ userId, body, set }) => {
    const { username: rawUsername, name: rawName, aboutMe: rawAboutMe, profilePicture } = body;
    const username = rawUsername !== undefined ? sanitizeName(rawUsername) : undefined;
    const name     = rawName     !== undefined ? sanitizeName(rawName)     : undefined;
    const aboutMe  = rawAboutMe  !== undefined ? sanitizeNotes(rawAboutMe) : undefined;
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (username !== undefined) {
      const u = await getUser(userId);
      const currentUsername = u?.username ?? "";
      const lastChanged: Date | null = u?.username_changed_at ? new Date(u.username_changed_at) : null;

      if (username !== currentUsername) {
        // Enforce 30-day cooldown
        if (lastChanged) {
          const daysSince = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < 30) {
            const daysLeft = Math.ceil(30 - daysSince);
            set.status = 429;
            return { error: `You can change your username again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.` };
          }
        }

        // Check for duplicates
        const { rows: taken } = await query(
          "SELECT id FROM users WHERE username = $1 AND id != $2",
          [username, userId]
        );
        if (taken.length > 0) {
          set.status = 409;
          return { error: "Username already taken." };
        }

        sets.push(`username=$${idx++}`); params.push(username);
        // Only set username_changed_at if the column exists
        try {
          await query("SELECT username_changed_at FROM users LIMIT 0");
          sets.push(`username_changed_at=$${idx++}`); params.push(new Date().toISOString());
        } catch { /* column not yet migrated — skip */ }
      }
    }

    if (name !== undefined) { sets.push(`name=$${idx++}`); params.push(name); }
    if (aboutMe !== undefined) { sets.push(`about_me=$${idx++}`); params.push(aboutMe); }
    if (profilePicture !== undefined) { sets.push(`profile_picture=$${idx++}`); params.push(profilePicture); }

    if (sets.length > 0) {
      params.push(userId);
      await query(`UPDATE users SET ${sets.join(",")} WHERE id=$${idx}`, params);
    }

    const u = await getUser(userId);
    return {
      username: u?.username ?? "",
      name: u?.name ?? "",
      aboutMe: u?.about_me ?? "",
      profilePicture: u?.profile_picture ?? "",
      usernameChangedAt: u?.username_changed_at ?? null,
    };
  }, {
    body: t.Object({
      username: t.Optional(t.String()),
      name: t.Optional(t.String()),
      aboutMe: t.Optional(t.String()),
      profilePicture: t.Optional(t.String()),
    }),
  });
