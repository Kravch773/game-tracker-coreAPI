import type { GameSummary, HomeCollection, HomeCollectionId, LibraryStatus } from "@gametracker/shared";
import { HOME_COLLECTION_IDS } from "@gametracker/shared";
import { and, asc, desc, eq, gte, gt, inArray, lt } from "drizzle-orm";
import { db } from "../db/client.js";
import { collectionCache, favorites, games, listEntries } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { queryIgdbGames } from "../igdb/client.js";
import { toSummary } from "./present.js";
import { storeIgdbGames } from "./service.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const DAY_SECONDS = 24 * 60 * 60;
const GENRE_MAX_AGE_DAYS = 15 * 365;
const SECTION_LIMIT = 12;
const BACKLOG_LIMIT = 24;
const PLAYABLE = "game_type = (0,8,9) & version_parent = null & cover != null";
const FIELDS =
  "fields name,slug,summary,first_release_date,cover.image_id,platforms.name,websites.url,websites.type;";

const GENRE_ID: Partial<Record<HomeCollectionId, number>> = {
  rpg: 12,
  shooter: 5,
  adventure: 31,
  strategy: 15,
  indie: 32,
  racing: 10,
};

const refreshing = new Map<HomeCollectionId, Promise<string[]>>();

export async function loadHomeCollections(): Promise<HomeCollection[]> {
  const rows = await db.select().from(collectionCache);
  const cached = new Map(rows.map((row) => [row.key, row]));
  const now = Math.floor(Date.now() / 1000);
  const sections = await Promise.all(
    HOME_COLLECTION_IDS.map(async (id) => ({
      id,
      games: await gamesFor(id, cached.get(cacheKey(id)), now),
    })),
  );
  return sections.filter((section) => section.games.length > 0);
}

export async function listForUser(userId: string, status: LibraryStatus): Promise<GameSummary[]> {
  const rows = await db
    .select({ game: games })
    .from(listEntries)
    .innerJoin(games, eq(games.id, listEntries.gameId))
    .where(and(eq(listEntries.userId, userId), eq(listEntries.status, status)))
    .orderBy(desc(listEntries.updatedAt))
    .limit(BACKLOG_LIMIT);
  return rows.map((row) => toSummary(row.game));
}

export async function upcomingFromBacklog(userId: string): Promise<GameSummary[]> {
  const rows = await db
    .select({ game: games })
    .from(listEntries)
    .innerJoin(games, eq(games.id, listEntries.gameId))
    .where(
      and(
        eq(listEntries.userId, userId),
        eq(listEntries.status, "backlog"),
        gt(games.releaseDate, todayStamp()),
      ),
    )
    .orderBy(asc(games.releaseDate))
    .limit(BACKLOG_LIMIT);
  return rows.map((row) => toSummary(row.game));
}

export async function backlogInMonth(userId: string, monthStart: string): Promise<GameSummary[]> {
  const start = monthStart.slice(0, 10);
  const [year, month] = start.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const end = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, "0")}-01`;
  const rows = await db
    .select({ game: games })
    .from(listEntries)
    .innerJoin(games, eq(games.id, listEntries.gameId))
    .where(
      and(
        eq(listEntries.userId, userId),
        eq(listEntries.status, "backlog"),
        gte(games.releaseDate, start),
        lt(games.releaseDate, end),
      ),
    )
    .orderBy(asc(games.releaseDate))
    .limit(BACKLOG_LIMIT);
  return rows.map((row) => toSummary(row.game));
}

export async function favoritesForUser(userId: string): Promise<GameSummary[]> {
  const rows = await db
    .select({ game: games })
    .from(favorites)
    .innerJoin(games, eq(games.id, favorites.gameId))
    .where(eq(favorites.userId, userId))
    .orderBy(desc(favorites.createdAt))
    .limit(BACKLOG_LIMIT);
  return rows.map((row) => toSummary(row.game));
}

function todayStamp(): string {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${now.getFullYear()}-${month}-${day}`;
}

function cacheKey(id: HomeCollectionId): string {
  return id === "recent" || id === "upcoming" ? id : `d15:${id}`;
}

export function genreReleaseSince(now = Math.floor(Date.now() / 1000)): number {
  return now - GENRE_MAX_AGE_DAYS * DAY_SECONDS;
}

async function gamesFor(
  id: HomeCollectionId,
  cached: { gameIds: string[]; fetchedAt: Date } | undefined,
  now: number,
): Promise<GameSummary[]> {
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return orderedSummaries(cached.gameIds);
  }

  const pending = refreshing.get(id);
  if (pending) return orderedSummaries(await pending);

  const job = refresh(id, cached?.gameIds ?? null, now).finally(() => {
    refreshing.delete(id);
  });
  refreshing.set(id, job);
  return orderedSummaries(await job);
}

async function refresh(id: HomeCollectionId, fallback: string[] | null, now: number): Promise<string[]> {
  if (!igdbConfigured()) return fallback ?? [];

  try {
    const remote = await queryIgdbGames(queryFor(id, now));
    const ids = await storeIgdbGames(remote);
    await db
      .insert(collectionCache)
      .values({ key: cacheKey(id), gameIds: ids, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: collectionCache.key,
        set: { gameIds: ids, fetchedAt: new Date() },
      });
    return ids;
  } catch (error) {
    console.error(`Collection ${id} failed`, error);
    return fallback ?? [];
  }
}

function queryFor(id: HomeCollectionId, now: number): string {
  const yearAgo = now - 365 * DAY_SECONDS;
  const ahead = now + 180 * DAY_SECONDS;
  const genreId = GENRE_ID[id];

  if (genreId) {
    return clause(
      `genres = (${genreId}) & first_release_date >= ${genreReleaseSince(now)} & total_rating > 60 & total_rating_count > 100`,
      "total_rating desc",
    );
  }
  if (id === "popular") {
    return clause(
      `first_release_date >= ${genreReleaseSince(now)} & total_rating > 85 & total_rating_count > 500`,
      "total_rating desc",
    );
  }
  if (id === "recent") {
    return clause(
      `first_release_date >= ${yearAgo} & first_release_date <= ${now} & total_rating > 70 & total_rating_count > 40`,
      "first_release_date desc",
    );
  }
  return clause(
    `first_release_date > ${now} & first_release_date < ${ahead} & hypes > 5`,
    "hypes desc",
  );
}

function clause(filter: string, sort: string): string {
  return [FIELDS, `where ${filter} & ${PLAYABLE};`, `sort ${sort};`, `limit ${SECTION_LIMIT};`].join("\n");
}

async function orderedSummaries(ids: string[]): Promise<GameSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(games).where(inArray(games.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSummary(row)] : [];
  });
}
