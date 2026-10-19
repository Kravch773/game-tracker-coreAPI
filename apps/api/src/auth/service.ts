import { t, type AuthUser } from "@gametracker/shared";
import type { FastifyRequest } from "fastify";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { users } from "../db/schema.js";
import { hashPassword, verifyPassword } from "./password.js";
import { readCookie, readSession } from "./session.js";

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const USERNAME_PATTERN = /^[A-Za-z0-9_]+$/;

export class AuthInputError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

export type RegisterInput = {
  email: string;
  username: string;
  password: string;
};

export function parseRegister(body: unknown): RegisterInput {
  const record = objectOf(body);
  const email = stringOf(record.email).toLowerCase();
  const username = stringOf(record.username);
  const password = typeof record.password === "string" ? record.password : "";

  if (!EMAIL_PATTERN.test(email) || email.length > 254) {
    throw new AuthInputError(t("auth.emailInvalid"));
  }
  assertUsername(username);
  if (password.length < 8 || password.length > 128) {
    throw new AuthInputError(t("auth.passwordTooShort"));
  }

  return { email, username, password };
}

export function parseLogin(body: unknown): { login: string; password: string } {
  const record = objectOf(body);
  const login = stringOf(record.login);
  const password = typeof record.password === "string" ? record.password : "";
  if (!login || !password || password.length > 128) {
    throw new AuthInputError(t("auth.badCredentials"));
  }
  return { login, password };
}

export async function registerUser(input: RegisterInput): Promise<AuthUser> {
  const taken = await db
    .select({ email: users.email, username: users.username })
    .from(users)
    .where(sql`lower(${users.email}) = ${input.email} OR lower(${users.username}) = ${input.username.toLowerCase()}`)
    .limit(2);

  if (taken.some((user) => user.email === input.email)) {
    throw new AuthInputError(t("auth.emailTaken"), 409);
  }
  if (taken.length > 0) {
    throw new AuthInputError(t("auth.usernameTaken"), 409);
  }

  const passwordHash = await hashPassword(input.password);
  try {
    const inserted = await db
      .insert(users)
      .values({ email: input.email, username: input.username, passwordHash })
      .returning({ id: users.id, username: users.username, email: users.email, steamId: users.steamId });
    const user = inserted[0];
    if (!user) throw new Error("User insert returned no row");
    return user;
  } catch (error) {
    if (errorCode(error) !== "23505") throw error;
    throw new AuthInputError(t("auth.identityTaken"), 409);
  }
}

export async function loginUser(login: string, password: string): Promise<AuthUser | null> {
  const key = login.trim().toLowerCase();
  const rows = await db
    .select()
    .from(users)
    .where(sql`lower(${users.email}) = ${key} OR lower(${users.username}) = ${key}`)
    .limit(1);
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) return null;
  return { id: user.id, username: user.username, email: user.email, steamId: user.steamId };
}

export async function changeUsername(userId: string, username: string, password: string): Promise<AuthUser> {
  assertUsername(username);
  const user = await requirePassword(userId, password);
  const taken = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()} AND ${users.id} <> ${userId}`)
    .limit(1);
  if (taken.length > 0) throw new AuthInputError(t("auth.usernameTaken"), 409);
  const updated = await db
    .update(users)
    .set({ username })
    .where(eq(users.id, user.id))
    .returning({ id: users.id, username: users.username, email: users.email, steamId: users.steamId });
  const next = updated[0];
  if (!next) throw new Error("Username update returned no row");
  return next;
}

export async function changePassword(userId: string, currentPassword: string, nextPassword: string): Promise<void> {
  if (nextPassword.length < 8 || nextPassword.length > 128) {
    throw new AuthInputError(t("auth.passwordTooShort"));
  }
  const user = await requirePassword(userId, currentPassword);
  await db.update(users).set({ passwordHash: await hashPassword(nextPassword) }).where(eq(users.id, user.id));
}

export async function deleteAccount(userId: string, password: string): Promise<void> {
  const user = await requirePassword(userId, password);
  await db.delete(users).where(eq(users.id, user.id));
}

export async function userFromRequest(request: FastifyRequest): Promise<AuthUser | null> {
  const userId = readSession(readCookie(request.headers.cookie, "session"));
  if (!userId) return null;

  const rows = await db
    .select({ id: users.id, username: users.username, email: users.email, steamId: users.steamId })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

function assertUsername(username: string): void {
  if (username.length < 3 || username.length > 24 || !USERNAME_PATTERN.test(username) || !/[A-Za-z0-9]/.test(username)) {
    throw new AuthInputError(t("auth.usernameInvalid"));
  }
}

async function requirePassword(userId: string, password: string) {
  const rows = await db.select().from(users).where(eq(users.id, userId)).limit(1);
  const user = rows[0];
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    throw new AuthInputError(t("settings.wrongPassword"), 401);
  }
  return user;
}

function objectOf(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  return body as Record<string, unknown>;
}

function stringOf(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function errorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return errorCode(error.cause);
  return undefined;
}
