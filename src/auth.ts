import jwt from "jsonwebtoken";

const secret = () => process.env.JWT_SECRET || "dev-secret-change-me";

export type AuthPayload = { userId: string };

export function signToken(userId: string): string {
  return jwt.sign({ userId }, secret(), { expiresIn: "15m" });
}

export function verifyToken(token: string): AuthPayload {
  return jwt.verify(token, secret()) as AuthPayload;
}
