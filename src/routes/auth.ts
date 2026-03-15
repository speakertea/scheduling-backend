import { Elysia, t } from "elysia";
import bcrypt from "bcryptjs";
import { query, seedUserData } from "../db";
import { signToken, verifyToken } from "../auth";

export const authRoutes = new Elysia({ prefix: "/auth" })

  .post("/register", async ({ body }) => {
    const { email, password, name } = body;
    const { rows } = await query("SELECT id FROM users WHERE email = $1", [email.toLowerCase().trim()]);
    if (rows.length > 0) {
      return new Response(JSON.stringify({ error: "Email already registered" }), { status: 409 });
    }

    const id = crypto.randomUUID();
    const hash = bcrypt.hashSync(password, 10);
    const username = `@${(name || email.split("@")[0]).toLowerCase().replace(/\s+/g, "")}`;

    await query("INSERT INTO users (id,email,password_hash,username,name) VALUES ($1,$2,$3,$4,$5)",
      [id, email.toLowerCase().trim(), hash, username, name || ""]);
    await seedUserData(id);

    return { token: signToken(id), user: { id, email, username, name: name || "" } };
  }, {
    body: t.Object({
      email: t.String(),
      password: t.String({ minLength: 8 }),
      name: t.Optional(t.String()),
    }),
  })

  .post("/login", async ({ body }) => {
    const { email, password } = body;
    const { rows } = await query(
      "SELECT id,email,password_hash,username,name FROM users WHERE email = $1",
      [email.toLowerCase().trim()]
    );
    if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
      return new Response(JSON.stringify({ error: "Invalid email or password" }), { status: 401 });
    }
    const u = rows[0];
    return { token: signToken(u.id), user: { id: u.id, email: u.email, username: u.username, name: u.name } };
  }, {
    body: t.Object({
      email: t.String(),
      password: t.String(),
    }),
  })

  .get("/me", async ({ headers }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    try {
      const { userId } = verifyToken(token);
      const { rows } = await query("SELECT id,email,username,name,about_me,profile_picture FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) return new Response(JSON.stringify({ error: "User not found" }), { status: 404 });
      const u = rows[0];
      return { id: u.id, email: u.email, username: u.username, name: u.name, aboutMe: u.about_me, profilePicture: u.profile_picture };
    } catch {
      return new Response(JSON.stringify({ error: "Invalid token" }), { status: 401 });
    }
  });
