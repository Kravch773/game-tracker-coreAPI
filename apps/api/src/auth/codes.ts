import { t, type AuthUser } from "@gametracker/shared";
import { createHmac, randomInt, timingSafeEqual } from "node:crypto";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { emailCodes, sessions, users, type EmailCodePurpose, type SignupPayload } from "../db/schema.js";
import { env } from "../env.js";
import { codeLetter, sendEmail } from "./email.js";
import { hashPassword } from "./password.js";
import { AuthInputError, assertIdentityFree, assertPassword, insertUser, type RegisterInput } from "./service.js";

const CODE_TTL_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 5;

// Signup holds the account in the code row until the address is confirmed; the user row is made in finishSignup.
export async function startSignup(input: RegisterInput): Promise<void> {
  await assertIdentityFree(input.email, input.username);
  const payload: SignupPayload = { username: input.username, passwordHash: await hashPassword(input.password) };
  await issueCode("signup", input.email, payload);
}

export async function finishSignup(email: string, code: string): Promise<AuthUser> {
  const row = await consumeCode("signup", email, code);
  if (!row.payload) throw new AuthInputError(t("auth.codeExpired"));
  await assertIdentityFree(email, row.payload.username);
  return insertUser(email, row.payload.username, row.payload.passwordHash);
}

// Answers the same whether or not the address has a profile, so the form cannot be used to find accounts.
export async function startReset(email: string): Promise<void> {
  const rows = await db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  if (rows.length === 0) return;
  await issueCode("reset", email, null);
}

export async function finishReset(email: string, code: string, password: string): Promise<AuthUser> {
  assertPassword(password);
  await consumeCode("reset", email, code);
  const rows = await db.select().from(users).where(sql`lower(${users.email}) = ${email}`).limit(1);
  const user = rows[0];
  if (!user) throw new AuthInputError(t("auth.codeExpired"));
  const passwordHash = await hashPassword(password);
  await db.transaction(async (tx) => {
    await tx.update(users).set({ passwordHash }).where(eq(users.id, user.id));
    await tx.delete(sessions).where(eq(sessions.userId, user.id));
  });
  return { id: user.id, username: user.username, email: user.email, steamId: user.steamId };
}

export function parseCode(value: unknown): string {
  const code = typeof value === "string" ? value.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(code)) throw new AuthInputError(t("auth.codeInvalid"));
  return code;
}

async function issueCode(purpose: EmailCodePurpose, email: string, payload: SignupPayload | null): Promise<void> {
  const code = randomInt(0, 1_000_000).toString().padStart(6, "0");
  const inserted = await db.transaction(async (tx) => {
    await tx.delete(emailCodes).where(and(eq(emailCodes.purpose, purpose), eq(emailCodes.email, email)));
    return tx
      .insert(emailCodes)
      .values({ purpose, email, payload, codeHash: hashCode(code), expiresAt: new Date(Date.now() + CODE_TTL_MS) })
      .returning({ id: emailCodes.id });
  });
  try {
    await sendEmail(email, codeLetter(purpose, code));
  } catch (error) {
    const id = inserted[0]?.id;
    if (id) await db.delete(emailCodes).where(eq(emailCodes.id, id));
    throw error;
  }
}

// A wrong code costs one of five attempts; the row is deleted once used, expired or worn out.
async function consumeCode(purpose: EmailCodePurpose, email: string, code: string) {
  const rows = await db
    .select()
    .from(emailCodes)
    .where(and(eq(emailCodes.purpose, purpose), eq(emailCodes.email, email)))
    .orderBy(desc(emailCodes.createdAt))
    .limit(1);
  const row = rows[0];
  if (!row || row.expiresAt.getTime() < Date.now() || row.attempts >= MAX_ATTEMPTS) {
    if (row) await db.delete(emailCodes).where(eq(emailCodes.id, row.id));
    throw new AuthInputError(t("auth.codeExpired"));
  }
  const expected = Buffer.from(row.codeHash);
  const actual = Buffer.from(hashCode(code));
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    await db.update(emailCodes).set({ attempts: row.attempts + 1 }).where(eq(emailCodes.id, row.id));
    throw new AuthInputError(t("auth.codeInvalid"));
  }
  await db.delete(emailCodes).where(eq(emailCodes.id, row.id));
  return row;
}

function hashCode(code: string): string {
  return createHmac("sha256", env.sessionSecret).update(code).digest("base64url");
}
