import { and, eq, inArray, sql } from "drizzle-orm";
import {
  catalogGenre,
  catalogPlatform,
  type GameDetails,
  type GameSummary,
  type SearchFilters,
} from "@gametracker/shared";
import { db } from "../db/client.js";
import { gameDetails, gameLinks, games, searchCache, type GameDetailRow, type GameRow } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { fetchIgdbGame, fetchTimeToBeat, queryIgdbGames, searchIgdb } from "../igdb/client.js";
import { communityForGame } from "./community.js";
import { mapIgdbDetails, mapIgdbGame, type MappedGame } from "../igdb/map.js";
import { scheduleMetacriticEnrich } from "../rawg/enrich.js";
import { toDetails, toSummary } from "./present.js";

const PAGE_SIZE = 20;
const SEARCH_POOL = 60;
const CACHE_TTL_MS = 14 * 24 * 60 * 60 * 1000;
const FRESH_MS = 7 * 24 * 60 * 60 * 1000;
const DETAILS_TTL_MS = 14 * 24 * 60 * 60 * 1000;

const detailRequests = new Map<string, Promise<GameDetailRow | null>>();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export async function searchGames(
  rawQuery: string,
  filters: SearchFilters = {},
  offset = 0,
): Promise<{ games: GameSummary[]; hasMore: boolean }> {
  const query = rawQuery.replace(/\s+/g, " ").trim();
  const key = cacheKey(query, filters);
  const filtered = hasFilters(filters);
  const start = offset > 0 ? offset : 0;
  if (query.length < 2 && !filtered) return { games: [], hasMore: false };

  const cachedIds = await readFreshCache(key);
  if (cachedIds) return pageOf(cachedIds, start);

  const needle = query.toLowerCase();
  const local = needle.length >= 2 ? await searchLocal(needle) : [];
  const titled = local.filter((game) => game.title.toLowerCase().includes(needle) && matchesLocal(game, filters));
  if (!igdbConfigured()) return pageOf(sortedLocalIds(titled), start);

  try {
    const remote = filtered ? await queryIgdbGames(filteredQuery(query, filters, SEARCH_POOL)) : await searchIgdb(query, SEARCH_POOL);
    const named = needle.length >= 2 ? remote.filter((game) => (game.name ?? "").toLowerCase().includes(needle)) : remote;
    const ids = await upsertIgdbGames(rankRemote(named));
    const seen = new Set(ids);
    const extra = titled
      .filter((game) => !seen.has(game.id))
      .sort(byReleaseDesc)
      .map((game) => game.id);
    const result = [...ids, ...extra];
    await writeCache(key, result);
    return pageOf(result, start);
  } catch (error) {
    console.error("IGDB search failed", error);
    return pageOf(sortedLocalIds(titled), start);
  }
}

export async function getGameBySlug(slug: string): Promise<GameDetails | null> {
  const rows = await db.select().from(games).where(eq(games.slug, slug)).limit(1);
  const game = rows[0];
  if (!game) return null;

  const links = await db.select().from(gameLinks).where(eq(gameLinks.gameId, game.id));
  const details = await ensureDetails(game);
  scheduleMetacriticEnrich(game, links);
  const [similar, community] = await Promise.all([
    similarGames(details?.similarIgdbIds ?? []),
    communityForGame(game.id),
  ]);
  return { ...toDetails(game, links, details), similar, ...community };
}

async function ensureDetails(game: GameRow): Promise<GameDetailRow | null> {
  const existing = await readDetails(game.id);
  if (existing && existing.detailVersion >= 2 && Date.now() - existing.fetchedAt.getTime() < DETAILS_TTL_MS) {
    return existing;
  }
  if (!igdbConfigured()) return existing;

  const pending = detailRequests.get(game.id);
  if (pending) return pending;

  const request = loadDetails(game, existing).finally(() => {
    detailRequests.delete(game.id);
  });
  detailRequests.set(game.id, request);
  return request;
}

async function readDetails(gameId: string): Promise<GameDetailRow | null> {
  const rows = await db.select().from(gameDetails).where(eq(gameDetails.gameId, gameId)).limit(1);
  return rows[0] ?? null;
}

async function loadDetails(game: GameRow, existing: GameDetailRow | null): Promise<GameDetailRow | null> {
  try {
    const remote = await fetchIgdbGame(game.igdbId);
    const beat = await fetchTimeToBeat(game.igdbId);
    const mapped = mapIgdbDetails(remote, beat);
    const now = new Date();
    const saved = await db
      .insert(gameDetails)
      .values({ gameId: game.id, ...mapped, fetchedAt: now })
      .onConflictDoUpdate({
        target: gameDetails.gameId,
        set: { ...mapped, fetchedAt: now },
      })
      .returning();
    return saved[0] ?? existing;
  } catch (error) {
    console.error("IGDB details failed", error);
    return existing;
  }
}

async function readFreshCache(key: string): Promise<string[] | null> {
  const rows = await db.select().from(searchCache).where(eq(searchCache.query, key)).limit(1);
  const cached = rows[0];
  if (!cached) return null;
  if (Date.now() - cached.fetchedAt.getTime() > CACHE_TTL_MS) return null;
  return cached.gameIds;
}

async function writeCache(key: string, gameIds: string[]): Promise<void> {
  await db
    .insert(searchCache)
    .values({ query: key, gameIds, fetchedAt: new Date() })
    .onConflictDoUpdate({
      target: searchCache.query,
      set: { gameIds, fetchedAt: new Date() },
    });
}

async function searchLocal(key: string) {
  const pattern = `%${key.replace(/[\\%_]/g, "\\$&")}%`;
  return db
    .select()
    .from(games)
    .where(
      sql`similarity(lower(${games.title}), ${key}) > 0.25 OR ${games.title} ILIKE ${pattern} ESCAPE '\\'`,
    )
    .orderBy(
      sql`CASE WHEN lower(${games.title}) LIKE ${pattern} ESCAPE '\\' THEN 0 ELSE 1 END`,
      sql`similarity(lower(${games.title}), ${key}) DESC`,
    )
    .limit(SEARCH_POOL);
}

async function pageOf(ids: string[], start: number): Promise<{ games: GameSummary[]; hasMore: boolean }> {
  return {
    games: await loadSummaries(ids.slice(start, start + PAGE_SIZE)),
    hasMore: start + PAGE_SIZE < ids.length,
  };
}

function sortedLocalIds(rows: GameRow[]): string[] {
  return [...rows].sort(byReleaseDesc).map((game) => game.id);
}

function byReleaseDesc(a: { releaseDate: string | null }, b: { releaseDate: string | null }): number {
  return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
}

function rankRemote(remote: Parameters<typeof mapIgdbGame>[0][]): Parameters<typeof mapIgdbGame>[0][] {
  return [...remote].sort((a, b) => {
    const popularity = popularityOf(b) - popularityOf(a);
    if (popularity !== 0) return popularity;
    return (b.first_release_date ?? 0) - (a.first_release_date ?? 0);
  });
}

function popularityOf(game: { total_rating_count?: number; hypes?: number }): number {
  const ratings = typeof game.total_rating_count === "number" ? game.total_rating_count : 0;
  const hypes = typeof game.hypes === "number" ? game.hypes : 0;
  return ratings + hypes;
}

async function loadSummaries(ids: string[]): Promise<GameSummary[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(games).where(inArray(games.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  return ids.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toSummary(row)] : [];
  });
}

export async function storeIgdbGames(remote: Parameters<typeof mapIgdbGame>[0][]): Promise<string[]> {
  return upsertIgdbGames(remote);
}

async function upsertIgdbGames(remote: Parameters<typeof mapIgdbGame>[0][]): Promise<string[]> {
  const mapped = remote.map(mapIgdbGame).filter((game): game is MappedGame => game !== null);
  if (mapped.length === 0) return [];

  return db.transaction(async (tx) => {
    const ids: string[] = [];
    const usedSlugs = new Set<string>();
    for (const game of mapped) {
      ids.push(await upsertOne(tx, game, usedSlugs));
    }
    return ids;
  });
}

async function upsertOne(tx: Tx, game: MappedGame, usedSlugs: Set<string>): Promise<string> {
  const existing = await tx.select().from(games).where(eq(games.igdbId, game.igdbId)).limit(1);
  const current = existing[0];
  const freshBefore = new Date(Date.now() - FRESH_MS);

  if (current && current.fetchedAt > freshBefore) {
    return current.id;
  }

  const now = new Date();
  if (!current) {
    const slug = await resolveSlug(tx, game.slug, game.igdbId, usedSlugs);
    const inserted = await tx
      .insert(games)
      .values({
        igdbId: game.igdbId,
        slug,
        title: game.title,
        summary: game.summary,
        coverUrl: game.coverUrl,
        releaseDate: game.releaseDate,
        platforms: game.platforms,
        fetchedAt: now,
        updatedAt: now,
      })
      .returning({ id: games.id });
    const id = inserted[0]?.id;
    if (!id) throw new Error(`Failed to insert IGDB game ${game.igdbId}`);
    if (game.links.length > 0) {
      await tx.insert(gameLinks).values(game.links.map((link) => ({ ...link, gameId: id })));
    }
    return id;
  }

  await tx
    .update(games)
    .set({
      title: game.title,
      summary: game.summary,
      coverUrl: game.coverUrl,
      releaseDate: game.releaseDate,
      platforms: game.platforms,
      fetchedAt: now,
      updatedAt: now,
    })
    .where(eq(games.id, current.id));

  await tx
    .delete(gameLinks)
    .where(and(eq(gameLinks.gameId, current.id), eq(gameLinks.source, "igdb")));

  const kept = await tx
    .select({ kind: gameLinks.kind })
    .from(gameLinks)
    .where(eq(gameLinks.gameId, current.id));
  const keptKinds = new Set(kept.map((link) => link.kind));
  const freshLinks = game.links.filter((link) => !keptKinds.has(link.kind));
  if (freshLinks.length > 0) {
    await tx.insert(gameLinks).values(freshLinks.map((link) => ({ ...link, gameId: current.id })));
  }

  return current.id;
}

async function resolveSlug(
  tx: Tx,
  base: string,
  igdbId: number,
  usedSlugs: Set<string>,
): Promise<string> {
  const candidate = sanitizeSlug(base) || `game-${igdbId}`;
  if (!usedSlugs.has(candidate)) {
    const owner = await tx
      .select({ igdbId: games.igdbId })
      .from(games)
      .where(eq(games.slug, candidate))
      .limit(1);
    if (owner.length === 0 || owner[0]?.igdbId === igdbId) {
      usedSlugs.add(candidate);
      return candidate;
    }
  }

  const withId = `${candidate}-${igdbId}`;
  usedSlugs.add(withId);
  return withId;
}

const CARD_FIELDS =
  "fields name,slug,summary,first_release_date,cover.image_id,platforms.name,websites.url,websites.type,total_rating_count,hypes;";

async function similarGames(igdbIds: number[]): Promise<GameSummary[]> {
  const ids = igdbIds.filter((id) => Number.isInteger(id)).slice(0, 8);
  if (ids.length === 0) return [];

  const missing = await missingIgdbIds(ids);
  if (missing.length > 0 && igdbConfigured()) {
    try {
      const remote = await queryIgdbGames(
        [CARD_FIELDS, `where id = (${missing.join(",")});`, `limit ${missing.length};`].join("\n"),
      );
      await storeIgdbGames(remote);
    } catch (error) {
      console.error("IGDB similar games failed", error);
    }
  }

  const rows = await db.select().from(games).where(inArray(games.igdbId, ids));
  const byIgdb = new Map(rows.map((row) => [row.igdbId, row]));
  return ids.flatMap((id) => {
    const row = byIgdb.get(id);
    return row ? [toSummary(row)] : [];
  });
}

async function missingIgdbIds(ids: number[]): Promise<number[]> {
  const rows = await db.select({ igdbId: games.igdbId }).from(games).where(inArray(games.igdbId, ids));
  const have = new Set(rows.map((row) => row.igdbId));
  return ids.filter((id) => !have.has(id));
}

function cacheKey(query: string, filters: SearchFilters): string {
  const base = query.toLowerCase();
  if (!hasFilters(filters)) return `d5:${base}`;
  return `f6:${base}|${filters.genre ?? ""}|${filters.platform ?? ""}|${filters.year ?? ""}`;
}

function hasFilters(filters: SearchFilters): boolean {
  return Boolean(filters.genre || filters.platform || filters.year);
}

function filteredQuery(query: string, filters: SearchFilters, limit = SEARCH_POOL): string {
  const where = ["game_type = (0,1,2,3,4,8,9,10)", "version_parent = null", "cover != null"];
  const genre = filters.genre ? catalogGenre(filters.genre) : null;
  const platform = filters.platform ? catalogPlatform(filters.platform) : null;
  if (genre) where.push(`genres = (${genre.igdbId})`);
  if (platform) where.push(`platforms = (${platform.igdbId})`);
  if (filters.year) {
    const start = Math.floor(Date.UTC(filters.year, 0, 1) / 1000);
    const end = Math.floor(Date.UTC(filters.year + 1, 0, 1) / 1000);
    where.push(`first_release_date >= ${start} & first_release_date < ${end}`);
  }
  const lines = [CARD_FIELDS];
  const term = query.replace(/["\\*\n\r]/g, "").trim().slice(0, 80);
  if (term.length >= 2) where.push(`name ~ *"${term}"*`);
  else where.push("total_rating_count > 40");
  lines.push(`where ${where.join(" & ")};`, "sort total_rating_count desc;", `limit ${limit};`);
  return lines.join("\n");
}

function matchesLocal(game: GameRow, filters: SearchFilters): boolean {
  if (filters.genre) return false;
  if (filters.year && game.releaseDate?.slice(0, 4) !== String(filters.year)) return false;
  const platform = filters.platform ? catalogPlatform(filters.platform) : null;
  if (platform) {
    const names = Array.isArray(game.platforms) ? game.platforms : [];
    if (!names.includes(platform.name)) return false;
  }
  return true;
}

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
