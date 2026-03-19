import { Elysia, t } from "elysia";
import bcrypt from "bcryptjs";
import { Resend } from "resend";
import { query, generateReferralCode, updateUserLocation } from "../db";
import { verifyToken } from "../auth";
import { sanitizeEmail } from "../utils";
import { lookupIP } from "../geo";
import { createSessionTokens, rotateRefreshToken } from "../session";

function extractIP(headers: Record<string, string | undefined>): string {
  return headers["x-forwarded-for"]?.split(",")[0]?.trim() || "unknown";
}

function backgroundGeoUpdate(userId: string, ip: string) {
  lookupIP(ip).then((geo) => {
    if (geo) updateUserLocation(userId, geo, ip);
  }).catch(() => {});
}

const resend = new Resend(process.env.RESEND_API_KEY);

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
  return null;
}

function normalizeUsername(input: string): string {
  const trimmed = input.replace(/^@+/, "").toLowerCase().trim();
  const cleaned = trimmed.replace(/[^a-z0-9_.]/g, "").slice(0, 20);
  return `@${cleaned}`;
}

function validateUsername(input: string): string | null {
  const normalized = normalizeUsername(input);
  if (normalized.length < 4) return "Handle must be at least 3 characters.";
  if (!/^@[a-z0-9_.]+$/.test(normalized)) return "Handle can only contain letters, numbers, underscores, and periods.";
  return null;
}

function generateCode(): string {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendVerificationEmail(email: string, subject: string, heading: string, body: string, code: string) {
  await resend.emails.send({
    from: "Collabo <verify@collabo.cloud>",
    to: email,
    subject,
    html: `
      <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 24px;">
        <h2 style="color: #0f172a; margin-bottom: 8px;">${heading}</h2>
        <p style="color: #475569; margin-bottom: 24px;">${body}</p>
        <div style="background: #f1f5f9; border-radius: 12px; padding: 20px; text-align: center; margin-bottom: 24px;">
          <span style="font-size: 32px; font-weight: 800; letter-spacing: 8px; color: #0f172a;">${code}</span>
        </div>
        <p style="color: #94a3b8; font-size: 13px;">This code expires in 10 minutes. If you didn't request this, you can ignore this email.</p>
      </div>
    `,
  });
}

export const authRoutes = new Elysia({ prefix: "/auth" })
  .get("/check-username", async ({ query: qs, set }) => {
    const raw = String((qs as any).username || "");
    const validation = validateUsername(raw);
    const normalized = normalizeUsername(raw);
    if (validation) {
      set.status = 400;
      return { error: validation, available: false, normalized };
    }

    const { rows } = await query("SELECT id FROM users WHERE username = $1", [normalized]);
    return { available: rows.length === 0, normalized };
  }, {
    query: t.Object({ username: t.String() }),
  })

  .post("/register/start", async ({ body, set }) => {
    const { email, password, username } = body;
    const cleanEmail = sanitizeEmail(email);
    const normalizedUsername = normalizeUsername(username);

    const passwordWeakness = checkPasswordStrength(password);
    if (passwordWeakness) {
      set.status = 400;
      return { error: passwordWeakness };
    }

    const usernameWeakness = validateUsername(normalizedUsername);
    if (usernameWeakness) {
      set.status = 400;
      return { error: usernameWeakness };
    }

    const [{ rows: existingUsers }, { rows: existingHandles }] = await Promise.all([
      query("SELECT id FROM users WHERE email = $1", [cleanEmail]),
      query("SELECT id FROM users WHERE username = $1", [normalizedUsername]),
    ]);

    if (existingUsers.length > 0) {
      set.status = 409;
      return { error: "Email already registered." };
    }
    if (existingHandles.length > 0) {
      set.status = 409;
      return { error: "Handle already taken." };
    }

    const code = generateCode();
    const hash = bcrypt.hashSync(password, 10);

    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE", [cleanEmail]);
    await query(
      `INSERT INTO verification_codes (email, code, username, name, password_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '10 minutes')`,
      [cleanEmail, code, normalizedUsername, normalizedUsername, hash]
    );

    try {
      await sendVerificationEmail(
        cleanEmail,
        "Your verification code",
        "Verify your email",
        "Enter this code in the app to finish creating your account:",
        code
      );
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send verification email. Please try again." };
    }

    return { success: true, message: "Verification code sent to your email." };
  }, {
    body: t.Object({ email: t.String(), password: t.String(), username: t.String() }),
  })

  .post("/register/verify", async ({ body, set, headers }) => {
    const { email, code, referralCode } = body;
    const cleanEmail = sanitizeEmail(email);

    const { rows } = await query(
      `SELECT id, code, username, password_hash, expires_at
       FROM verification_codes
       WHERE email = $1 AND used = FALSE
       ORDER BY created_at DESC
       LIMIT 1`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      set.status = 400;
      return { error: "No pending verification. Please register again." };
    }

    const record = rows[0];
    if (new Date(record.expires_at) < new Date()) {
      await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);
      set.status = 400;
      return { error: "Code expired. Please register again." };
    }
    if (record.code !== code.trim()) {
      set.status = 400;
      return { error: "Incorrect code. Please try again." };
    }

    await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);

    const { rows: existing } = await query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (existing.length > 0) {
      set.status = 409;
      return { error: "Email already registered." };
    }

    const normalizedUsername = normalizeUsername(record.username || cleanEmail.split("@")[0]);
    const { rows: handleClash } = await query("SELECT id FROM users WHERE username = $1", [normalizedUsername]);
    if (handleClash.length > 0) {
      set.status = 409;
      return { error: "That handle is no longer available. Choose another one." };
    }

    const userId = crypto.randomUUID();
    await query(
      "INSERT INTO users (id, email, password_hash, username, name) VALUES ($1, $2, $3, $4, $5)",
      [userId, cleanEmail, record.password_hash, normalizedUsername, normalizedUsername.replace(/^@/, "")]
    );

    let newReferralCode = generateReferralCode();
    while (true) {
      const { rows: clash } = await query("SELECT id FROM users WHERE referral_code = $1", [newReferralCode]);
      if (clash.length === 0) break;
      newReferralCode = generateReferralCode();
    }
    await query("UPDATE users SET referral_code = $1 WHERE id = $2", [newReferralCode, userId]);

    if (referralCode) {
      const { rows: referrers } = await query("SELECT id FROM users WHERE referral_code = $1", [referralCode.toLowerCase().trim()]);
      if (referrers.length > 0) {
        await query("UPDATE users SET referred_by = $1 WHERE id = $2", [referrers[0].id, userId]);
      }
    }

    const tokens = await createSessionTokens(userId);
    const ip = extractIP(headers);
    backgroundGeoUpdate(userId, ip);

    set.status = 201;
    return {
      ...tokens,
      user: { id: userId, email: cleanEmail, username: normalizedUsername, name: normalizedUsername.replace(/^@/, "") },
    };
  }, {
    body: t.Object({ email: t.String(), code: t.String(), referralCode: t.Optional(t.String()) }),
  })

  .post("/register/resend", async ({ body, set }) => {
    const cleanEmail = sanitizeEmail(body.email);
    const { rows } = await query(
      `SELECT id, username, password_hash
       FROM verification_codes
       WHERE email = $1 AND used = FALSE
       ORDER BY created_at DESC
       LIMIT 1`,
      [cleanEmail]
    );

    if (rows.length === 0) {
      set.status = 400;
      return { error: "No pending registration found. Please start over." };
    }

    const record = rows[0];
    const code = generateCode();
    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE", [cleanEmail]);
    await query(
      `INSERT INTO verification_codes (email, code, username, name, password_hash, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + INTERVAL '10 minutes')`,
      [cleanEmail, code, record.username, record.username, record.password_hash]
    );

    try {
      await sendVerificationEmail(cleanEmail, "Your new verification code", "New verification code", "Here's your new code:", code);
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send email. Please try again." };
    }

    return { success: true, message: "New code sent." };
  }, {
    body: t.Object({ email: t.String() }),
  })

  .post("/login", async ({ body, set, headers }) => {
    const { email, password } = body;
    const { rows } = await query(
      "SELECT id, email, password_hash, username, name FROM users WHERE email = $1 AND is_disabled = FALSE",
      [sanitizeEmail(email)]
    );

    if (rows.length === 0 || !bcrypt.compareSync(password, rows[0].password_hash)) {
      set.status = 401;
      return { error: "Invalid email or password" };
    }

    const user = rows[0];
    const tokens = await createSessionTokens(user.id);
    const ip = extractIP(headers);
    backgroundGeoUpdate(user.id, ip);

    return { ...tokens, user: { id: user.id, email: user.email, username: user.username, name: user.name } };
  }, {
    body: t.Object({ email: t.String(), password: t.String() }),
  })

  .post("/refresh", async ({ body, set }) => {
    const rotated = await rotateRefreshToken(body.refreshToken);
    if (!rotated) {
      set.status = 401;
      return { error: "Invalid refresh token." };
    }
    return { accessToken: rotated.accessToken, refreshToken: rotated.refreshToken };
  }, {
    body: t.Object({ refreshToken: t.String() }),
  })

  .get("/me", async ({ headers, set }) => {
    const token = (headers.authorization || "").replace("Bearer ", "");
    try {
      const { userId } = verifyToken(token);
      const { rows } = await query(
        "SELECT id, email, username, name, about_me, profile_picture, created_at FROM users WHERE id = $1",
        [userId]
      );
      if (rows.length === 0) {
        set.status = 404;
        return { error: "User not found" };
      }
      const user = rows[0];
      return {
        id: user.id,
        email: user.email,
        username: user.username,
        name: user.name,
        aboutMe: user.about_me,
        profilePicture: user.profile_picture,
        createdAt: user.created_at,
      };
    } catch {
      set.status = 401;
      return { error: "Invalid token" };
    }
  })

  .post("/forgot-password/start", async ({ body, set }) => {
    const cleanEmail = sanitizeEmail(body.email);
    const { rows } = await query("SELECT id FROM users WHERE email = $1", [cleanEmail]);
    if (rows.length === 0) {
      return { success: true, message: "If that email is registered, a code has been sent." };
    }

    const code = generateCode();
    await query("UPDATE verification_codes SET used = TRUE WHERE email = $1 AND used = FALSE AND name = '__reset__'", [cleanEmail]);
    await query(
      "INSERT INTO verification_codes (email, code, name, password_hash, expires_at) VALUES ($1, $2, '__reset__', '__reset__', NOW() + INTERVAL '10 minutes')",
      [cleanEmail, code]
    );

    try {
      await sendVerificationEmail(cleanEmail, "Reset your password", "Reset your password", "Enter this code in the app to set a new password:", code);
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send reset email. Please try again." };
    }

    return { success: true, message: "If that email is registered, a code has been sent." };
  }, {
    body: t.Object({ email: t.String() }),
  })

  .post("/forgot-password/verify", async ({ body, set }) => {
    const { email, code, newPassword } = body;
    const cleanEmail = sanitizeEmail(email);

    const weakness = checkPasswordStrength(newPassword);
    if (weakness) {
      set.status = 400;
      return { error: weakness };
    }

    const { rows } = await query(
      `SELECT id, code, expires_at
       FROM verification_codes
       WHERE email = $1 AND used = FALSE AND name = '__reset__'
       ORDER BY created_at DESC
       LIMIT 1`,
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

    await query("UPDATE verification_codes SET used = TRUE WHERE id = $1", [record.id]);
    const hash = bcrypt.hashSync(newPassword, 10);
    const result = await query(
      "UPDATE users SET password_hash = $1 WHERE email = $2 RETURNING id, email, username, name",
      [hash, cleanEmail]
    );

    if (result.rows.length === 0) {
      set.status = 400;
      return { error: "Account not found." };
    }

    const user = result.rows[0];
    const tokens = await createSessionTokens(user.id);
    return { success: true, ...tokens, user: { id: user.id, email: user.email, username: user.username, name: user.name } };
  }, {
    body: t.Object({ email: t.String(), code: t.String(), newPassword: t.String() }),
  })

  .post("/forgot-password/resend", async ({ body, set }) => {
    const cleanEmail = sanitizeEmail(body.email);
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
      await sendVerificationEmail(cleanEmail, "Your new password reset code", "New reset code", "Here's your new code:", code);
    } catch (err: any) {
      console.error("[resend]", err.message);
      set.status = 500;
      return { error: "Failed to send email." };
    }

    return { success: true, message: "New code sent." };
  }, {
    body: t.Object({ email: t.String() }),
  });
