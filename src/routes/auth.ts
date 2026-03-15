import { Elysia, t } from "elysia";
import bcrypt from "bcryptjs";
import { Resend } from "resend";
import { query, seedUserData } from "../db";
import { signToken, verifyToken } from "../auth";
import { sanitizeName, sanitizeEmail } from "../utils";

const resend = new Resend(process.env.RESEND_API_KEY);

/* ─── Password strength checker ─── */

const COMMON_PASSWORDS = new Set([
  "password", "password1", "password123", "123456", "12345678", "123456789",
  "1234567890", "qwerty", "qwerty123", "abc123", "letmein", "welcome",
  "monkey", "dragon", "master", "login", "princess", "football", "shadow",
  "sunshine", "trustno1", "iloveyou", "admin", "welcome1",
]);

function checkPasswordStrength(password: string): string | null {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return "That password is too common. Pick something less guessable.";
  if (!/[A-Z]/.test(password)) return "Password must include at least one uppercase letter.";
  if (!/[a-z]/.test(password)) return "Password must include at least one lowercase letter.";
  if (!/[0-9]/.test(password)) return "Password must include at least one number.";
  return null; // password is strong enough
}

/* ─── Generate 6-digit code ─── */

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

/* ─── Routes ─── */

export const authRoutes = new Elysia({ prefix: "/auth" })

  /*
   * Step 1: Start registration
   * - Validates password strength
   * - Checks email isn't taken
   * - Sends 6-digit code to email
   * - Stores code + hashed password temporarily
   */
  .post("/register/start", async ({ body, set }) => {
    const { email, password, name } = body;
    const cleanEmail = sanitizeEmail(email);
    const cleanName  = name ? sanitizeName(name) : "";

    // Check password strength
    const weakness = checkPasswordStrength(password);
    if (weakness) {
      set.status = 400;
      return { error: weakness };
    }

    // Check if email already registered
    const { rows } = await query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (rows.length > 0) {
      set.status = 409;
      return { error: "Email already registered." };
    }

    // Generate code and hash password
    const code = generateCode();
    const hash = bcrypt.hashSync(password, 10);

    // Expire any old codes for this email
    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE", [cleanEmail]);

    // Store the code (expires in 10 minutes)
    await query(
      "INSERT INTO verification_codes (email, code, name, password_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')",
      [cleanEmail, code, cleanName, hash]
    );

    // Send the email
    try {
      await resend.emails.send({
        from: "Scheduling App <onboarding@resend.dev>",
        to: cleanEmail,
        subject: "Your verification code",
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #0f172a; margin-bottom: 8px;">Verify your email</h2>
            <p style="color: #475569; margin-bottom: 24px;">Enter this code in the app to finish creating your account:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${code}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
          </div>
        `,
      });
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send verification email. Please try again." };
    }

    return { success: true, message: "Verification code sent to your email." };
  }, {
    body: t.Object({
      email: t.String(),
      password: t.String(),
      name: t.Optional(t.String()),
    }),
  })

  /*
   * Step 2: Verify code and create account
   * - Checks the code matches and hasn't expired
   * - Creates the user
   * - Returns JWT token
   */
  .post("/register/verify", async ({ body, set }) => {
    const { email, code } = body;
    const cleanEmail = email.toLowerCase().trim();

    // Find the most recent unused code for this email
    const { rows } = await query(
      "SELECT id, code, name, password_hash, expires_at FROM verification_codes WHERE email = $1 AND used = FALSE ORDER BY created_at DESC LIMIT 1",
      [cleanEmail]
    );

    if (rows.length === 0) {
      set.status = 400;
      return { error: "No pending verification. Please register again." };
    }

    const record = rows[0];

    // Check expiry
    if (new Date(record.expires_at) < new Date()) {
      await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);
      set.status = 400;
      return { error: "Code expired. Please register again." };
    }

    // Check code
    if (record.code !== code.trim()) {
      set.status = 400;
      return { error: "Incorrect code. Please try again." };
    }

    // Mark code as used
    await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);

    // Check email isn't taken (in case someone registered between steps)
    const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (existing.length > 0) {
      set.status = 409;
      return { error: "Email already registered." };
    }

    // Create the user
    const id = crypto.randomUUID();
    const username = `@${(record.name || cleanEmail.split("@")[0]).toLowerCase().replace(/\s+/g, "")}`;

    await query(
      "INSERT INTO users (id, email, password_hash, username, name) VALUES ($1, $2, $3, $4, $5)",
      [id, cleanEmail, record.password_hash, username, record.name || ""]
    );
    await seedUserData(id);

    const token = signToken(id);
    set.status = 201;
    return { token, user: { id, email: cleanEmail, username, name: record.name || "" } };
  }, {
    body: t.Object({
      email: t.String(),
      code: t.String(),
    }),
  })

  /*
   * Resend code (if the first one didn't arrive)
   */
  .post("/register/resend", async ({ body, set }) => {
    const cleanEmail = sanitizeEmail(body.email);

    // Find existing pending verification
    const { rows } = await query(
      "SELECT id, name, password_hash FROM verification_codes WHERE email = $1 AND used = FALSE ORDER BY created_at DESC LIMIT 1",
      [cleanEmail]
    );

    if (rows.length === 0) {
      set.status = 400;
      return { error: "No pending registration found. Please start over." };
    }

    const record = rows[0];
    const code = generateCode();

    // Expire old code, create new one
    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE", [cleanEmail]);
    await query(
      "INSERT INTO verification_codes (email, code, name, password_hash, expires_at) VALUES ($1, $2, $3, $4, NOW() + INTERVAL '10 minutes')",
      [cleanEmail, code, record.name, record.password_hash]
    );

    try {
      await resend.emails.send({
        from: "Scheduling App <onboarding@resend.dev>",
        to: cleanEmail,
        subject: "Your new verification code",
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #0f172a; margin-bottom: 8px;">New verification code</h2>
            <p style="color: #475569; margin-bottom: 24px;">Here's your new code:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${code}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes.</p>
          </div>
        `,
      });
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send email. Please try again." };
    }

    return { success: true, message: "New code sent." };
  }, {
    body: t.Object({
      email: t.String(),
    }),
  })

  /* Login — unchanged */
  .post("/login", async ({ body, set }) => {
    const { email, password } = body;
    const { rows } = await query(
      "SELECT id,email,password_hash,username,name FROM users WHERE email = $1",
      [sanitizeEmail(email)]
    );
    if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
      set.status = 401;
      return { error: "Invalid email or password" };
    }
    const u = rows[0];
    return { token: signToken(u.id), user: { id: u.id, email: u.email, username: u.username, name: u.name } };
  }, {
    body: t.Object({
      email: t.String(),
      password: t.String(),
    }),
  })

  /* Me — unchanged */
  .get("/me", async ({ headers, set }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    try {
      const { userId } = verifyToken(token);
      const { rows } = await query("SELECT id,email,username,name,about_me,profile_picture FROM users WHERE id = $1", [userId]);
      if (rows.length === 0) { set.status = 404; return { error: "User not found" }; }
      const u = rows[0];
      return { id: u.id, email: u.email, username: u.username, name: u.name, aboutMe: u.about_me, profilePicture: u.profile_picture };
    } catch {
      set.status = 401;
      return { error: "Invalid token" };
    }
  })

  /*
   * Forgot Password Step 1: Send reset code to email
   */
  .post("/forgot-password/start", async ({ body, set }) => {
    const cleanEmail = sanitizeEmail(body.email);

    // Check user exists
    const { rows } = await query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (rows.length === 0) {
      // Don't reveal whether email exists — always say "sent"
      return { success: true, message: "If that email is registered, a code has been sent." };
    }

    const code = generateCode();

    // Expire old reset codes for this email
    await query(
      "UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE AND name = '__reset__'",
      [cleanEmail]
    );

    // Store the code (name = '__reset__' to distinguish from registration codes, password_hash is a placeholder)
    await query(
      "INSERT INTO verification_codes (email, code, name, password_hash, expires_at) VALUES ($1, $2, '__reset__', '__reset__', NOW() + INTERVAL '10 minutes')",
      [cleanEmail, code]
    );

    try {
      await resend.emails.send({
        from: "Scheduling App <onboarding@resend.dev>",
        to: cleanEmail,
        subject: "Reset your password",
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #0f172a; margin-bottom: 8px;">Reset your password</h2>
            <p style="color: #475569; margin-bottom: 24px;">Enter this code in the app to set a new password:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${code}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
          </div>
        `,
      });
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send reset email. Please try again." };
    }

    return { success: true, message: "If that email is registered, a code has been sent." };
  }, {
    body: t.Object({ email: t.String() }),
  })

  /*
   * Forgot Password Step 2: Verify code and set new password
   */
  .post("/forgot-password/verify", async ({ body, set }) => {
    const { email, code, newPassword } = body;
    const cleanEmail = sanitizeEmail(email);

    // Check password strength
    const weakness = checkPasswordStrength(newPassword);
    if (weakness) {
      set.status = 400;
      return { error: weakness };
    }

    // Find the reset code
    const { rows } = await query(
      "SELECT id, code, expires_at FROM verification_codes WHERE email = $1 AND used = FALSE AND name = '__reset__' ORDER BY created_at DESC LIMIT 1",
      [cleanEmail]
    );

    if (rows.length === 0) {
      set.status = 400;
      return { error: "No pending reset. Please request a new code." };
    }

    const record = rows[0];

    if (new Date(record.expires_at) < new Date()) {
      await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);
      set.status = 400;
      return { error: "Code expired. Please request a new one." };
    }

    if (record.code !== code.trim()) {
      set.status = 400;
      return { error: "Incorrect code. Please try again." };
    }

    // Mark code as used
    await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);

    // Update password
    const hash = bcrypt.hashSync(newPassword, 10);
    const result = await query("UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, email, username, name", [hash, cleanEmail]);

    if (result.rows.length === 0) {
      set.status = 400;
      return { error: "Account not found." };
    }

    // Auto-login: return a token so they don't have to log in again
    const u = result.rows[0];
    const token = signToken(u.id);
    return { success: true, token, user: { id: u.id, email: u.email, username: u.username, name: u.name } };
  }, {
    body: t.Object({
      email: t.String(),
      code: t.String(),
      newPassword: t.String(),
    }),
  })

  /*
   * Forgot Password: Resend code
   */
  .post("/forgot-password/resend", async ({ body, set }) => {
    const cleanEmail = sanitizeEmail(body.email);

    // Check user exists
    const { rows: users } = await query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (users.length === 0) {
      return { success: true, message: "If that email is registered, a new code has been sent." };
    }

    const code = generateCode();

    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE AND name = '__reset__'", [cleanEmail]);
    await query(
      "INSERT INTO verification_codes (email, code, name, password_hash, expires_at) VALUES ($1, $2, '__reset__', '__reset__', NOW() + INTERVAL '10 minutes')",
      [cleanEmail, code]
    );

    try {
      await resend.emails.send({
        from: "Scheduling App <onboarding@resend.dev>",
        to: cleanEmail,
        subject: "Your new password reset code",
        html: `
          <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
            <h2 style="color: #0f172a; margin-bottom: 8px;">New reset code</h2>
            <p style="color: #475569; margin-bottom: 24px;">Here's your new code:</p>
            <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
              <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${code}</span>
            </div>
            <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes.</p>
          </div>
        `,
      });
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send email." };
    }

    return { success: true, message: "New code sent." };
  }, {
    body: t.Object({ email: t.String() }),
  });
