import { config } from "dotenv";
import { resolve } from "node:path";

config({ path: resolve(process.cwd(), ".env") });
config({ path: resolve(process.cwd(), "../../.env") });

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(`Missing ${name}. Copy .env.example to .env in the repository root.`);
  }
  return value;
}

export const env = {
  databaseUrl: required("DATABASE_URL"),
  port: Number(process.env.PORT ?? 3001),
  webOrigin: process.env.WEB_ORIGIN?.trim() || "http://localhost:3000",
  twitchClientId: process.env.TWITCH_CLIENT_ID?.trim() ?? "",
  twitchClientSecret: process.env.TWITCH_CLIENT_SECRET?.trim() ?? "",
  rawgApiKey: process.env.RAWG_API_KEY?.trim() ?? "",
  steamWebApiKey: process.env.STEAM_WEB_API_KEY?.trim() ?? "",
  resendApiKey: process.env.RESEND_API_KEY?.trim() ?? "",
  // Resend's test sender only delivers to the Resend account's own address; a verified domain lifts that.
  emailFrom: process.env.EMAIL_FROM?.trim() || "GameTracker <onboarding@resend.dev>",
  sessionSecret: required("SESSION_SECRET"),
  trustProxy: proxyHops(process.env.TRUST_PROXY),
};

function proxyHops(value: string | undefined): ((address: string, hop: number) => boolean) | false {
  const hops = Number(value?.trim());
  if (!Number.isInteger(hops) || hops <= 0) return false;
  return (_address, hop) => hop < hops;
}

export function igdbConfigured(): boolean {
  return Boolean(env.twitchClientId && env.twitchClientSecret);
}

export function rawgConfigured(): boolean {
  return Boolean(env.rawgApiKey);
}

export function emailConfigured(): boolean {
  return Boolean(env.resendApiKey);
}
