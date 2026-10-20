import type { GameSummary } from "@gametracker/shared";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { collectionCache, curatorApps, gameLinks, games } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { fetchIgdbGamesByIds, igdbIdsForSteamApps, queryIgdbGames } from "../igdb/client.js";
import { toSummary } from "./present.js";
import { storeIgdbGames } from "./service.js";
import { refreshCurators } from "../steam/curators.js";

const CACHE_KEY = "origin:v2:ua";
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 20;

let pending: Promise<string[]> | null = null;

export async function ukrainianGames(offset: number): Promise<{ games: GameSummary[]; hasMore: boolean }> {
  const ids = await ukrainianIds();
  const start = Math.max(0, offset);
  return {
    games: await summaries(ids.slice(start, start + PAGE_SIZE)),
    hasMore: start + PAGE_SIZE < ids.length,
  };
}

async function ukrainianIds(): Promise<string[]> {
  const cached = await db.select().from(collectionCache).where(eq(collectionCache.key, CACHE_KEY)).limit(1);
  const row = cached[0];
  if (row && Date.now() - row.fetchedAt.getTime() < CACHE_TTL_MS) return row.gameIds;
  if (!pending) {
    pending = refresh(row?.gameIds ?? []).finally(() => {
      pending = null;
    });
  }
  return pending;
}

async function refresh(fallback: string[]): Promise<string[]> {
  const appIds = await steamAppIds();
  if (appIds.length === 0) return fallback;

  const linked = await linkedIds(appIds);
  const known = new Set(linked.flatMap((row) => (row.appId ? [row.appId] : [])));
  const missing = appIds.filter((id) => !known.has(id));
  let storedIds: string[] = [];

  if (missing.length > 0 && igdbConfigured()) {
    try {
      const remoteIds = await igdbIdsForSteamApps(missing);
      const remote = await fetchIgdbGamesByIds(remoteIds);
      storedIds = await storeIgdbGames(remote);
    } catch (error) {
      console.error("Ukrainian game import failed", error);
      if (fallback.length > 0) return fallback;
    }
  }

  const matched = await linkedIds(appIds);
  const matchedIds = new Set(matched.map((row) => row.id));
  const extras = storedIds.filter((id) => !matchedIds.has(id));
  const extraRows =
    extras.length === 0
      ? []
      : await db.select({ id: games.id, igdbId: games.igdbId, releaseDate: games.releaseDate }).from(games).where(inArray(games.id, extras));
  const ids = await uniqueByPopularity([...matched, ...extraRows]);
  if (ids.length === 0) return fallback;
  await db
    .insert(collectionCache)
    .values({ key: CACHE_KEY, gameIds: ids, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: collectionCache.key,
      set: { gameIds: ids, fetchedAt: new Date() },
    });
  return ids;
}

async function steamAppIds(): Promise<string[]> {
  let rows = await db.select({ appId: curatorApps.appId }).from(curatorApps).where(eq(curatorApps.list, "ua"));
  if (rows.length === 0) {
    await refreshCurators();
    rows = await db.select({ appId: curatorApps.appId }).from(curatorApps).where(eq(curatorApps.list, "ua"));
  }
  return [...new Set(rows.map((row) => row.appId))];
}

async function linkedIds(appIds: string[]): Promise<{ id: string; igdbId: number; appId: string | null; releaseDate: string | null }[]> {
  if (appIds.length === 0) return [];
  return db
    .select({ id: games.id, igdbId: games.igdbId, appId: gameLinks.externalId, releaseDate: games.releaseDate })
    .from(gameLinks)
    .innerJoin(games, eq(games.id, gameLinks.gameId))
    .where(and(eq(gameLinks.kind, "steam"), inArray(gameLinks.externalId, appIds)));
}

async function uniqueByPopularity(rows: { id: string; igdbId: number; releaseDate: string | null }[]): Promise<string[]> {
  const byId = new Map<string, { igdbId: number; releaseDate: string | null }>();
  for (const row of rows) {
    if (!byId.has(row.id)) byId.set(row.id, { igdbId: row.igdbId, releaseDate: row.releaseDate });
  }
  let scores = new Map<number, number>();
  try {
    scores = await popularity([...byId.values()].map((row) => row.igdbId));
  } catch (error) {
    console.error("Ukrainian game sort failed", error);
  }
  return [...byId.entries()]
    .sort((a, b) => {
      const score = (scores.get(b[1].igdbId) ?? 0) - (scores.get(a[1].igdbId) ?? 0);
      if (score !== 0) return score;
      return (b[1].releaseDate ?? "").localeCompare(a[1].releaseDate ?? "");
    })
    .map(([id]) => id);
}

async function popularity(igdbIds: number[]): Promise<Map<number, number>> {
  const scores = new Map<number, number>();
  if (!igdbConfigured()) return scores;
  const unique = [...new Set(igdbIds)];
  for (let index = 0; index < unique.length; index += 50) {
    const chunk = unique.slice(index, index + 50).join(",");
    const remote = await queryIgdbGames(
      ["fields id,total_rating_count,hypes;", `where id = (${chunk});`, "limit 50;"].join("\n"),
    );
    for (const game of remote) {
      if (typeof game.id !== "number") continue;
      const ratings = typeof game.total_rating_count === "number" ? game.total_rating_count : 0;
      const hypes = typeof game.hypes === "number" ? game.hypes : 0;
      scores.set(game.id, ratings + hypes);
    }
  }
  return scores;
}

async function summaries(ids: string[]): Promise<GameSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(games).where(inArray(games.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSummary(row)] : [];
  });
}
