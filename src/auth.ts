import jwt from "jsonwebtoken";

const JWT_SECRET_PLACEHOLDERS = new Set([
  "",
  "change-me-to-a-real-secret-in-production",
  "dev-secret-change-me",
]);

function getJwtSecret(): string {
  const jwtSecret = (process.env.JWT_SECRET || "").trim();
  if (JWT_SECRET_PLACEHOLDERS.has(jwtSecret)) {
    throw new Error("JWT_SECRET must be set to a strong, non-placeholder value.");
  }
  return jwtSecret;
}

export type AuthPayload = { userId: string; tokenVersion: number };

export function assertJwtConfigured(): void {
  void getJwtSecret();
}

export function signToken(userId: string, tokenVersion: number): string {
  return jwt.sign({ userId, tokenVersion }, getJwtSecret(), { expiresIn: "15m" });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, getJwtSecret()) as AuthPayload;
}
