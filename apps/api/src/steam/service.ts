import { t, type SteamSyncResult, type SteamWishlistMissingApp, type SteamWishlistResult } from "@gametracker/shared";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gameLinks, listEntries, steamPlays, steamWishMissing, steamWishes, users } from "../db/schema.js";
import { env } from "../env.js";

export class SteamError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

type OwnedGame = { appid?: number; playtime_forever?: number };

export async function syncSteamLibrary(userId: string, profile: string): Promise<SteamSyncResult> {
  const steamId = await resolveSteamId(profile);
  const owned = await ownedGames(steamId);
  const minutesByApp = new Map<string, number>();
  for (const game of owned) {
    if (!Number.isInteger(game.appid)) continue;
    const appId = String(game.appid);
    const minutes = Math.max(0, Math.round(game.playtime_forever ?? 0));
    minutesByApp.set(appId, Math.max(minutesByApp.get(appId) ?? 0, minutes));
  }

  const matched = await matchCatalog([...minutesByApp.keys()]);
  const plays = matched.map((game) => ({
    gameId: game.gameId,
    minutes: minutesByApp.get(game.appId) ?? 0,
  }));

  let added = 0;
  try {
    added = await db.transaction(async (tx) => {
      await tx.update(users).set({ steamId }).where(eq(users.id, userId));
      await tx.delete(steamPlays).where(eq(steamPlays.userId, userId));
      for (const chunk of chunks(plays, 200)) {
        await tx.insert(steamPlays).values(
          chunk.map((play) => ({
            userId,
            gameId: play.gameId,
            playtimeMinutes: play.minutes,
          })),
        );
      }

      const gameIds = plays.map((play) => play.gameId);
      const existing = new Set<string>();
      for (const chunk of chunks(gameIds, 200)) {
        const rows = await tx
          .select({ gameId: listEntries.gameId })
          .from(listEntries)
          .where(and(eq(listEntries.userId, userId), inArray(listEntries.gameId, chunk)));
        for (const row of rows) existing.add(row.gameId);
      }
      const missing = gameIds.filter((gameId) => !existing.has(gameId));
      for (const chunk of chunks(missing, 200)) {
        await tx.insert(listEntries).values(
          chunk.map((gameId) => ({
            userId,
            gameId,
            status: "backlog",
            updatedAt: new Date(),
          })),
        );
      }
      return missing.length;
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new SteamError(t("profile.steamTaken"), 409);
    throw error;
  }

  return {
    steamId,
    matched: plays.length,
    added,
    unmatched: minutesByApp.size - plays.length,
  };
}

async function resolveSteamId(profile: string): Promise<string> {
  const parsed = parseSteamProfile(profile);
  if (!parsed) throw new SteamError(t("profile.steamInvalid"));
  if ("steamId" in parsed) return parsed.steamId;

  const payload = await steamGet<{ response?: { success?: number; steamid?: string } }>(
    "ISteamUser/ResolveVanityURL/v1",
    { vanityurl: parsed.vanity },
  );
  const steamId = payload.response?.steamid;
  if (payload.response?.success !== 1 || !steamId) throw new SteamError(t("profile.steamNotFound"));
  return steamId;
}

async function ownedGames(steamId: string): Promise<OwnedGame[]> {
  const payload = await steamGet<{ response?: { game_count?: number; games?: OwnedGame[] } }>(
    "IPlayerService/GetOwnedGames/v1",
    { steamid: steamId, include_played_free_games: "1" },
  );
  const response = payload.response ?? {};
  if (Array.isArray(response.games)) return response.games;
  if (response.game_count === 0) return [];
  throw new SteamError(t("profile.steamPrivate"));
}

async function matchCatalog(appIds: string[]): Promise<{ gameId: string; appId: string }[]> {
  const matched: { gameId: string; appId: string }[] = [];
  const seen = new Set<string>();
  for (const chunk of chunks(appIds, 300)) {
    const rows = await db
      .select({ gameId: gameLinks.gameId, appId: gameLinks.externalId })
      .from(gameLinks)
      .where(and(eq(gameLinks.kind, "steam"), inArray(gameLinks.externalId, chunk)));
    for (const row of rows) {
      if (!row.appId || seen.has(row.gameId)) continue;
      seen.add(row.gameId);
      matched.push({ gameId: row.gameId, appId: row.appId });
    }
  }
  return matched;
}

function parseSteamProfile(profile: string): { steamId: string } | { vanity: string } | null {
  const trimmed = profile.trim();
  if (!trimmed || trimmed.length > 200) return null;
  if (/^\d{17}$/.test(trimmed)) return { steamId: trimmed };

  const withProtocol = /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(withProtocol);
  } catch {
    return null;
  }
  if (!/(^|\.)steamcommunity\.com$/i.test(url.hostname)) return null;

  const profiles = url.pathname.match(/^\/profiles\/(\d{17})\/?$/i);
  if (profiles?.[1]) return { steamId: profiles[1] };
  const vanity = url.pathname.match(/^\/id\/([^/]+)\/?$/i);
  if (!vanity?.[1]) return null;
  try {
    return { vanity: decodeURIComponent(vanity[1]) };
  } catch {
    return null;
  }
}

async function steamGet<T>(method: string, params: Record<string, string>): Promise<T> {
  if (!env.steamWebApiKey) throw new SteamError(t("profile.steamUnconfigured"), 503);
  const url = new URL(`https://api.steampowered.com/${method}`);
  url.searchParams.set("key", env.steamWebApiKey);
  url.searchParams.set("format", "json");
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);

  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!response.ok) throw new Error("steam");
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof SteamError) throw error;
    throw new SteamError(t("profile.steamFailed"), 502);
  }
}

type WishItem = { appid?: number };

export async function syncSteamWishlist(userId: string, profile: string): Promise<SteamWishlistResult> {
  const steamId = await resolveSteamId(profile);
  const appIds = await wishlistApps(steamId);
  const matched = await matchCatalog(appIds);
  const found = new Set(matched.map((row) => row.appId));
  const missingIds = appIds.filter((appId) => !found.has(appId));
  const names = await steamAppNames(missingIds);

  try {
    await db.transaction(async (tx) => {
      await tx.update(users).set({ steamId }).where(eq(users.id, userId));
      await tx.delete(steamWishes).where(eq(steamWishes.userId, userId));
      await tx.delete(steamWishMissing).where(eq(steamWishMissing.userId, userId));
      for (const group of chunks(matched, 200)) {
        await tx.insert(steamWishes).values(group.map((row) => ({ userId, gameId: row.gameId })));
      }
      for (const group of chunks(missingIds, 200)) {
        await tx.insert(steamWishMissing).values(
          group.map((appId) => ({
            userId,
            appId,
            title: names.get(appId)?.slice(0, 200) ?? null,
          })),
        );
      }
    });
  } catch (error) {
    if (pgCode(error) === "23505") throw new SteamError(t("profile.steamTaken"), 409);
    throw error;
  }

  return { steamId, matched: matched.length, unmatched: missingIds.length };
}

export async function listSteamWishlistMissing(userId: string): Promise<SteamWishlistMissingApp[]> {
  return db
    .select({ appId: steamWishMissing.appId, title: steamWishMissing.title })
    .from(steamWishMissing)
    .where(eq(steamWishMissing.userId, userId))
    .orderBy(asc(sql`coalesce(${steamWishMissing.title}, ${steamWishMissing.appId})`))
    .limit(500);
}

async function wishlistApps(steamId: string): Promise<string[]> {
  const payload = await steamGet<{ response?: { items?: WishItem[] } }>("IWishlistService/GetWishlist/v1", {
    steamid: steamId,
  });
  const items = payload.response?.items;
  if (!Array.isArray(items)) throw new SteamError(t("profile.steamWishlistPrivate"));
  return [
    ...new Set(
      items
        .map((item) => item.appid)
        .filter((appId): appId is number => typeof appId === "number" && Number.isInteger(appId) && appId > 0)
        .map(String),
    ),
  ];
}

async function steamAppNames(appIds: string[]): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  for (const group of chunks(appIds, 80)) {
    const input = JSON.stringify({
      ids: group.map((appid) => ({ appid: Number(appid) })),
      context: { language: "english", country_code: "US" },
      data_request: { include_basic_info: true },
    });
    try {
      const response = await fetch(
        `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(input)}`,
        { signal: AbortSignal.timeout(20_000) },
      );
      if (!response.ok) continue;
      const payload = (await response.json()) as { response?: { store_items?: { appid?: number; name?: string }[] } };
      for (const item of payload.response?.store_items ?? []) {
        if (item.appid && item.name) names.set(String(item.appid), item.name);
      }
    } catch {
      continue;
    }
  }
  return names;
}

function chunks<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function pgCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  if ("code" in error && typeof error.code === "string") return error.code;
  if ("cause" in error) return pgCode(error.cause);
  return undefined;
}
