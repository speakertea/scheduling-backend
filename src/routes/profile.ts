import { Elysia, t } from "elysia";
import { query } from "../db";
import { authGuard } from "./guard";
import { sanitizeName, sanitizeNotes } from "../utils";

export const profileRoutes = new Elysia({ prefix: "/profile" })
  .use(authGuard)

  .get("/", async ({ userId }) => {
    const { rows } = await query("SELECT username,name,about_me,profile_picture FROM users WHERE id=$1", [userId]);
    if (rows.length === 0) return { error: "User not found" };
    const u = rows[0];
    return { username: u.username, name: u.name, aboutMe: u.about_me, profilePicture: u.profile_picture };
  })

  .patch("/", async ({ userId, body }) => {
    const { username: rawUsername, name: rawName, aboutMe: rawAboutMe, profilePicture } = body;
    const username = rawUsername !== undefined ? sanitizeName(rawUsername)  : undefined;
    const name     = rawName     !== undefined ? sanitizeName(rawName)      : undefined;
    const aboutMe  = rawAboutMe  !== undefined ? sanitizeNotes(rawAboutMe)  : undefined;
    const sets: string[] = [];
    const params: any[] = [];
    let idx = 1;

    if (username !== undefined) { sets.push(`username=$${idx++}`); params.push(username); }
    if (name !== undefined) { sets.push(`name=$${idx++}`); params.push(name); }
    if (aboutMe !== undefined) { sets.push(`about_me=$${idx++}`); params.push(aboutMe); }
    if (profilePicture !== undefined) { sets.push(`profile_picture=$${idx++}`); params.push(profilePicture); }

    if (sets.length > 0) {
      params.push(userId);
      await query(`UPDATE users SET ${sets.join(",")} WHERE id=$${idx}`, params);
    }

    const { rows } = await query("SELECT username,name,about_me,profile_picture FROM users WHERE id=$1", [userId]);
    const u = rows[0];
    return { username: u.username, name: u.name, aboutMe: u.about_me, profilePicture: u.profile_picture };
  }, {
    body: t.Object({
      username: t.Optional(t.String()),
      name: t.Optional(t.String()),
      aboutMe: t.Optional(t.String()),
      profilePicture: t.Optional(t.String()),
    }),
  });
