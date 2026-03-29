import crypto from "crypto";
import { query } from "./db";
import { signToken } from "./auth";

const REFRESH_TTL_DAYS = 30;

function hashRefreshToken(token: string) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function buildRefreshToken() {
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`;
}

async function getSessionUser(userId: string) {
  const { rows } = await query(
    "SELECT id, is_disabled, token_version FROM users WHERE id = $1",
    [userId]
  );
  return rows[0] || null;
}

export async function revokeAllSessionsForUser(userId: string) {
  await query(
    "UPDATE refresh_sessions SET revoked_at = COALESCE(revoked_at, NOW()) WHERE user_id = $1 AND revoked_at IS NULL",
    [userId]
  );
}

export async function createSessionTokens(userId: string) {
  const user = await getSessionUser(userId);
  if (!user) throw new Error("User not found");
  if (user.is_disabled) throw new Error("Cannot create a session for a disabled user");

  const refreshToken = buildRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const sessionId = crypto.randomUUID();

  await query(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)`,
    [sessionId, userId, refreshTokenHash, String(REFRESH_TTL_DAYS)]
  );

  return {
    accessToken: signToken(userId, user.token_version ?? 0),
    refreshToken,
  };
}

export async function rotateRefreshToken(refreshToken: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  const { rows } = await query(
    `SELECT rs.id, rs.user_id, u.is_disabled, u.token_version
     FROM refresh_sessions rs
     JOIN users u ON u.id = rs.user_id
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY rs.created_at DESC
     LIMIT 1`,
    [tokenHash]
  );

  if (rows.length === 0) return null;

  const session = rows[0];
  if (session.is_disabled) {
    await revokeAllSessionsForUser(session.user_id);
    return null;
  }

  const nextRefreshToken = buildRefreshToken();
  const nextHash = hashRefreshToken(nextRefreshToken);
  const nextSessionId = crypto.randomUUID();

  await query("UPDATE refresh_sessions SET revoked_at = NOW(), replaced_by = $1 WHERE id = $2", [nextSessionId, session.id]);
  await query(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)`,
    [nextSessionId, session.user_id, nextHash, String(REFRESH_TTL_DAYS)]
  );

  return {
    accessToken: signToken(session.user_id, session.token_version ?? 0),
    refreshToken: nextRefreshToken,
    userId: session.user_id as string,
  };
}
