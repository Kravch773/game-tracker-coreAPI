import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

export const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

const secure = env.webOrigin.startsWith("https://") ? "; Secure" : "";

export function signSession(sessionId: string): string {
  const signature = createHmac("sha256", env.sessionSecret).update(sessionId).digest("base64url");
  return `${sessionId}.${signature}`;
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const [sessionId, signature] = token.split(".");
  if (!sessionId || !signature) return null;

  const expected = createHmac("sha256", env.sessionSecret).update(sessionId).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }
  return /^[0-9a-f-]{36}$/i.test(sessionId) ? sessionId : null;
}

export function sessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Path=/; Max-Age=${SESSION_MAX_AGE_SECONDS}; SameSite=Lax${secure}`;
}

export function clearSessionCookie(): string {
  return `session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax${secure}`;
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
