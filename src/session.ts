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

export async function createSessionTokens(userId: string) {
  const refreshToken = buildRefreshToken();
  const refreshTokenHash = hashRefreshToken(refreshToken);
  const sessionId = crypto.randomUUID();

  await query(
    `INSERT INTO refresh_sessions (id, user_id, token_hash, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' days')::interval)`,
    [sessionId, userId, refreshTokenHash, String(REFRESH_TTL_DAYS)]
  );

  return {
    accessToken: signToken(userId),
    refreshToken,
  };
}

export async function rotateRefreshToken(refreshToken: string) {
  const tokenHash = hashRefreshToken(refreshToken);
  const { rows } = await query(
    `SELECT id, user_id
     FROM refresh_sessions
     WHERE token_hash = $1
       AND revoked_at IS NULL
       AND expires_at > NOW()
     ORDER BY created_at DESC
     LIMIT 1`,
    [tokenHash]
  );

  if (rows.length === 0) return null;

  const session = rows[0];
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
    accessToken: signToken(session.user_id),
    refreshToken: nextRefreshToken,
    userId: session.user_id as string,
  };
}
