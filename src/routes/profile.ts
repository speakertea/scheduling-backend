import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { sanitizeName, sanitizeNotes } from "../utils";

function normalizeUsername(input: string) {
  return `@${input.replace(/^@+/, "").toLowerCase().replace(/[^a-z0-9_.]/g, "").slice(0, 20)}`;
}

function validateUsername(input: string): string | null {
  const normalized = normalizeUsername(input);
  if (normalized.length < 4) return "Username must be at least 3 characters.";
  if (!/^@[a-z0-9_.]+$/.test(normalized)) return "Username can only contain letters, numbers, underscores, and periods.";
  return null;
}

async function getUser(userId: string | null) {
  if (!userId) return null;
  try {
    const { rows } = await query(
      "SELECT username,name,about_me,profile_picture,username_changed_at,created_at FROM users WHERE id=$1",
      [userId]
    );
    return rows[0] ?? null;
  } catch {
    const { rows } = await query(
      "SELECT username,name,about_me,profile_picture,created_at FROM users WHERE id=$1",
      [userId]
    );
    return rows[0] ? { ...rows[0], username_changed_at: null } : null;
  }
}

export const profileRoutes = new Elysia({ prefix: "/profile" })
  .use(authGuard)

  .get("/", async ({ userId, set }) => {
    const user = await getUser(userId);
    if (!user) { set.status = 404; return { error: "User not found" }; }
    return {
      username: user.username,
      name: user.name,
      aboutMe: user.about_me,
      profilePicture: user.profile_picture,
      usernameChangedAt: user.username_changed_at ?? null,
      createdAt: user.created_at ?? null,
    };
  })

  .patch("/", async ({ userId, body, set }) => {
    const { username: rawUsername, name: rawName, aboutMe: rawAboutMe, profilePicture } = body;
    const name = rawName !== undefined ? sanitizeName(rawName) : undefined;
    const aboutMe = rawAboutMe !== undefined ? sanitizeNotes(rawAboutMe) : undefined;
    const sets: string[] = [];
    const params: any[] = [];
    let index = 1;

    if (rawUsername !== undefined) {
      const username = normalizeUsername(rawUsername);
      const validation = validateUsername(username);
      if (validation) {
        set.status = 400;
        return { error: validation };
      }

      const currentUser = await getUser(userId);
      const currentUsername = currentUser?.username ?? "";
      const lastChanged: Date | null = currentUser?.username_changed_at ? new Date(currentUser.username_changed_at) : null;

      if (username !== currentUsername) {
        if (lastChanged) {
          const daysSince = (Date.now() - lastChanged.getTime()) / (1000 * 60 * 60 * 24);
          if (daysSince < 30) {
            const daysLeft = Math.ceil(30 - daysSince);
            set.status = 429;
            return { error: `You can change your username again in ${daysLeft} day${daysLeft === 1 ? "" : "s"}.` };
          }
        }

        const { rows: taken } = await query("SELECT id FROM users WHERE username = $1 AND id != $2", [username, userId]);
        if (taken.length > 0) {
          set.status = 409;
          return { error: "Username already taken." };
        }

        sets.push(`username = $${index++}`);
        params.push(username);
        sets.push(`username_changed_at = $${index++}`);
        params.push(new Date().toISOString());
      }
    }

    if (name !== undefined) { sets.push(`name = $${index++}`); params.push(name); }
    if (aboutMe !== undefined) { sets.push(`about_me = $${index++}`); params.push(aboutMe); }
    if (profilePicture !== undefined) { sets.push(`profile_picture = $${index++}`); params.push(profilePicture); }

    if (sets.length > 0) {      params.push(userId);
      await query(`UPDATE users SET ${sets.join(", ")} WHERE id = $${index}`, params);
    }

    const user = await getUser(userId);
    return {
      username: user?.username ?? "",
      name: user?.name ?? "",
      aboutMe: user?.about_me ?? "",
      profilePicture: user?.profile_picture ?? "",
      usernameChangedAt: user?.username_changed_at ?? null,
      createdAt: user?.created_at ?? null,
    };
  }, {
    body: t.Object({
      username: t.Optional(t.String()),
      name: t.Optional(t.String()),
      aboutMe: t.Optional(t.String()),
      profilePicture: t.Optional(t.String()),
    }),
  });



