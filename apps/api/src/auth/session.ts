import { createHmac, timingSafeEqual } from "node:crypto";
import { env } from "../env.js";

const WEEK_SECONDS = 60 * 60 * 24 * 30;

export function signSession(userId: string): string {
  const payload = Buffer.from(
    JSON.stringify({ sub: userId, exp: Math.floor(Date.now() / 1000) + WEEK_SECONDS }),
  ).toString("base64url");
  const signature = createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

export function readSession(token: string | undefined): string | null {
  if (!token) return null;
  const [payload, signature] = token.split(".");
  if (!payload || !signature) return null;

  const expected = createHmac("sha256", env.sessionSecret).update(payload).digest("base64url");
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  if (actualBuffer.length !== expectedBuffer.length || !timingSafeEqual(actualBuffer, expectedBuffer)) {
    return null;
  }

  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString()) as {
      sub?: unknown;
      exp?: unknown;
    };
    if (typeof data.sub !== "string" || typeof data.exp !== "number") return null;
    if (data.exp < Date.now() / 1000) return null;
    return data.sub;
  } catch {
    return null;
  }
}

export function sessionCookie(token: string): string {
  return `session=${token}; HttpOnly; Path=/; Max-Age=${WEEK_SECONDS}; SameSite=Lax`;
}

export function clearSessionCookie(): string {
  return "session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax";
}

export function readCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}
