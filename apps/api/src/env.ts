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
  sessionSecret: required("SESSION_SECRET"),
};

export function igdbConfigured(): boolean {
  return Boolean(env.twitchClientId && env.twitchClientSecret);
}

export function rawgConfigured(): boolean {
  return Boolean(env.rawgApiKey);
}
