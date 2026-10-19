import { catalogGenre, catalogPlatform, type GameSummary } from "@gametracker/shared";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { collectionCache, games } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { queryIgdbGames } from "../igdb/client.js";
import { toSummary } from "./present.js";
import { genreReleaseSince } from "./collections.js";
import { storeIgdbGames } from "./service.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYABLE = "game_type = (0,8,9) & version_parent = null & cover != null";
const FIELDS =
  "fields name,slug,summary,first_release_date,cover.image_id,platforms.name,websites.url,websites.type;";
const refreshing = new Map<string, Promise<string[]>>();

export async function browseCatalog(kind: "genres" | "platforms", id: string): Promise<GameSummary[] | null> {
  const filter = kind === "genres" ? genreFilter(id) : platformFilter(id);
  if (!filter) return null;

  const key = kind === "genres" ? `browse:d15:${kind}:${id}` : `browse:${kind}:${id}`;
  const rows = await db.select().from(collectionCache).where(eq(collectionCache.key, key)).limit(1);
  const cached = rows[0];
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return ordered(cached.gameIds);
  }

  const pending = refreshing.get(key);
  if (pending) return ordered(await pending);

  const job = refresh(key, filter, cached?.gameIds ?? null).finally(() => refreshing.delete(key));
  refreshing.set(key, job);
  return ordered(await job);
}

function genreFilter(id: string): string | null {
  const genre = catalogGenre(id);
  if (!genre) return null;
  return `genres = (${genre.igdbId}) & first_release_date >= ${genreReleaseSince()} & total_rating > 60 & total_rating_count > 100`;
}

function platformFilter(id: string): string | null {
  const platform = catalogPlatform(id);
  if (!platform) return null;
  return `platforms = (${platform.igdbId}) & total_rating > 60 & total_rating_count > 100`;
}

async function refresh(key: string, filter: string, fallback: string[] | null): Promise<string[]> {
  if (!igdbConfigured()) return fallback ?? [];
  try {
    const remote = await queryIgdbGames(
      [FIELDS, `where ${filter} & ${PLAYABLE};`, "sort total_rating desc;", "limit 24;"].join("\n"),
    );
    const ids = await storeIgdbGames(remote);
    await db
      .insert(collectionCache)
      .values({ key, gameIds: ids, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: collectionCache.key,
        set: { gameIds: ids, fetchedAt: new Date() },
      });
    return ids;
  } catch (error) {
    console.error(`Browse ${key} failed`, error);
    return fallback ?? [];
  }
}

async function ordered(ids: string[]): Promise<GameSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(games).where(inArray(games.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSummary(row)] : [];
  });
}
