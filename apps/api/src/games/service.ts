import { and, eq, inArray, notInArray, sql } from "drizzle-orm";
import {
  catalogGenre,
  catalogPlatform,
  type GameDetails,
  type GameOrigin,
  type GameSummary,
  type SearchFilters,
} from "@gametracker/shared";
import { db } from "../db/client.js";
import { gameDetails, gameLinks, games, searchCache, type GameDetailRow, type GameRow } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { fetchIgdbGame, fetchIgdbGameBySlug, fetchTimeToBeat, matchCompanies, matchFranchises, queryIgdbGames, searchAlternativeNames, searchIgdb } from "../igdb/client.js";
import { communityForGame } from "./community.js";
import { CONSOLE_LINK_KINDS, STORE_LINK_KINDS, mapIgdbDetails, mapIgdbGame, mapStoreLinks, type MappedGame, type MappedLink } from "../igdb/map.js";
import { scheduleMetacriticEnrich } from "../rawg/enrich.js";
import {
  developedByUkrainianStudio,
  matchingRussianDevelopers,
  matchingRussianPublishers,
  russianGames,
  ukrainianGames,
} from "./origin.js";
import { originsFor } from "../steam/curators.js";
import { toDetails, toSummary } from "./present.js";
import { loose, looseIncludes, matchScore, matchTier, queryVariants } from "./text.js";

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
  origin?: "ua" | "ru",
): Promise<{ games: GameSummary[]; hasMore: boolean }> {
  const credit = hasCredit(filters);
  if (!credit && origin === "ua") return ukrainianGames(offset, filters, rawQuery);
  if (!credit && origin === "ru") return russianGames(offset, filters, rawQuery);
  const query = rawQuery.replace(/\s+/g, " ").trim();
  const clauses = await creditClauses(filters);
  if (clauses === null) return { games: [], hasMore: false };
  const key = cacheKey(query, filters);
  const filtered = hasFilters(filters);
  const start = offset > 0 ? offset : 0;
  const sortedBrowse = filters.sort === "release" || filters.sort === "title";
  if (query.length < 2 && !filtered && !sortedBrowse) return { games: [], hasMore: false };
  const cachedIds = await readFreshCache(key);
  if (cachedIds) return pageOf(cachedIds, start);

  const needle = query.toLowerCase();
  // "Baldur's Gate 3" is stored as "Baldur's Gate III", "Ratchet & Clank" gets typed with "and": the query also
  // runs in its other spellings.
  const variants = needle.length >= 2 ? queryVariants(needle) : [];
  const local = needle.length >= 2 ? uniqueById((await Promise.all([needle, ...variants].map((term) => searchLocal(term)))).flat()) : [];
  const titled = local.filter((game) => looseIncludes(game.title, needle) && matchesLocal(game, filters));
  if (!igdbConfigured()) return pageOf(sortedLocalIds(titled, filters.sort), start);

  try {
    const ordered = filtered || filters.sort === "release" || filters.sort === "title";
    const lookup = (term: string) =>
      ordered ? queryIgdbGames(filteredQuery(term, filters, SEARCH_POOL, clauses)) : searchIgdb(term, SEARCH_POOL);
    // Acronyms ("gta 5", "rdr2") only exist as IGDB alternative names; a game found that way needs no title match.
    const [found, aliased] = await Promise.all([
      Promise.all([query, ...variants].map(lookup)).then((lists) => lists.flat()),
      !ordered && needle.length >= 2
        ? searchAlternativeNames([query, ...variants]).catch((error: unknown) => {
            console.error("IGDB alternative names failed", error);
            return [];
          })
        : Promise.resolve([]),
    ]);
    const aliasIds = new Set(aliased.map((game) => game.id));
    const remote = uniqueById([...aliased, ...found]);
    const named = needle.length >= 2 ? remote.filter((game) => aliasIds.has(game.id) || looseIncludes(game.name ?? "", needle)) : remote;
    // A game found by an alternative name ranks like one whose title starts with the query, not like an exact title.
    const scoreOf = (game: Parameters<typeof mapIgdbGame>[0]) =>
      matchScore(aliasIds.has(game.id) ? 1 : matchTier(game.name ?? "", needle), popularityOf(game));
    const byScore = !(filters.sort === "release" || filters.sort === "title") && needle.length >= 2;
    const ranked = byScore ? rankByScore(named, scoreOf) : orderRemote(named, filters.sort);
    const ids = await upsertIgdbGames(ranked);
    const seen = new Set(ids);
    const extra = titled.filter((game) => !seen.has(game.id)).sort(byReleaseDesc);
    // Local games IGDB did not return carry no popularity, so they rank on how closely their title matches alone.
    const result = byScore
      ? mergeByScore(ids, ranked.map(scoreOf), extra.map((game) => ({ id: game.id, score: matchScore(matchTier(game.title, needle), 0) })))
      : [...ids, ...extra.map((game) => game.id)];
    await writeCache(key, result);
    return pageOf(result, start);
  } catch (error) {
    console.error("IGDB search failed", error);
    return pageOf(sortedLocalIds(titled, filters.sort), start);
  }
}

export async function getGameBySlug(slug: string): Promise<GameDetails | null> {
  const rows = await db.select().from(games).where(eq(games.slug, slug)).limit(1);
  const game = rows[0] ?? (await importBySlug(slug));
  if (!game) return null;

  // Details first: loading them also refreshes the console store links.
  const details = await ensureDetails(game);
  const links = await db.select().from(gameLinks).where(eq(gameLinks.gameId, game.id));
  scheduleMetacriticEnrich(game, links);
  const steamIds = links.flatMap((link) => (link.kind === "steam" && link.externalId ? [link.externalId] : []));
  const developers = details?.developers ?? [];
  const publishers = details?.publishers ?? [];
  const developerNames = Array.isArray(developers) ? developers.filter((name): name is string => typeof name === "string") : [];
  const publisherNames = Array.isArray(publishers) ? publishers.filter((name): name is string => typeof name === "string") : [];
  const [similar, community, origins, ukrainianStudio, russianDevelopers, russianPublishers] = await Promise.all([
    similarGames(details?.similarIgdbIds ?? []),
    communityForGame(game.id),
    originsFor(steamIds),
    developedByUkrainianStudio(developerNames),
    matchingRussianDevelopers(developerNames),
    matchingRussianPublishers(publisherNames),
  ]);
  const tagged: GameOrigin[] = origins.filter((origin) => origin !== "ru");
  if (ukrainianStudio && !tagged.includes("ua")) tagged.push("ua");
  if (russianDevelopers.length > 0 && !tagged.includes("ru")) tagged.push("ru");
  return { ...toDetails(game, links, details), similar, ...community, origins: tagged, russianDevelopers, russianPublishers };
}

// Series and other IGDB lists link to games that are not stored yet; the first visit pulls one in.
async function importBySlug(slug: string): Promise<GameRow | null> {
  if (!igdbConfigured()) return null;
  try {
    const remote = await fetchIgdbGameBySlug(slug);
    if (!remote) return null;
    const [id] = await storeIgdbGames([remote]);
    if (!id) return null;
    const rows = await db.select().from(games).where(eq(games.id, id)).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error(`Game import for ${slug} failed`, error);
    return null;
  }
}

async function ensureDetails(game: GameRow): Promise<GameDetailRow | null> {
  const existing = await readDetails(game.id);
  if (existing && existing.detailVersion >= 5 && Date.now() - existing.fetchedAt.getTime() < DETAILS_TTL_MS) {
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
    await saveStoreLinks(game.id, mapStoreLinks(remote));
    return saved[0] ?? existing;
  } catch (error) {
    console.error("IGDB details failed", error);
    return existing;
  }
}

async function saveStoreLinks(gameId: string, links: MappedLink[]): Promise<void> {
  await db.transaction(async (tx) => {
    await tx
      .delete(gameLinks)
      .where(
        and(
          eq(gameLinks.gameId, gameId),
          eq(gameLinks.source, "igdb"),
          inArray(gameLinks.kind, [...new Set([...CONSOLE_LINK_KINDS, ...links.map((link) => link.kind)])]),
        ),
      );
    if (links.length > 0) {
      await tx
        .insert(gameLinks)
        .values(links.map((link) => ({ ...link, gameId })))
        .onConflictDoNothing({ target: [gameLinks.gameId, gameLinks.kind] });
    }
  });
}

function uniqueById<T extends { id?: string | number }>(items: T[]): T[] {
  const seen = new Set<string | number>();
  return items.filter((item) => {
    if (item.id == null) return true;
    if (seen.has(item.id)) return false;
    seen.add(item.id);
    return true;
  });
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
      sql`similarity(lower(${games.title}), ${key}) > 0.25 OR ${games.title} ILIKE ${pattern} ESCAPE '\\' OR regexp_replace(lower(${games.title}), '[^a-z0-9а-яіїєґё]+', '', 'g') LIKE ${`%${loose(key)}%`}`,
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

function sortedLocalIds(rows: GameRow[], sort?: SearchFilters["sort"]): string[] {
  const copy = [...rows];
  if (sort === "title") {
    copy.sort((a, b) => a.title.localeCompare(b.title));
    return copy.map((game) => game.id);
  }
  if (sort === "popular") return copy.map((game) => game.id);
  return copy.sort(byReleaseDesc).map((game) => game.id);
}

function byReleaseDesc(a: { releaseDate: string | null }, b: { releaseDate: string | null }): number {
  return (b.releaseDate ?? "").localeCompare(a.releaseDate ?? "");
}

function orderRemote(
  remote: Parameters<typeof mapIgdbGame>[0][],
  sort?: SearchFilters["sort"],
): Parameters<typeof mapIgdbGame>[0][] {
  if (sort === "release") {
    return [...remote].sort((a, b) => (b.first_release_date ?? 0) - (a.first_release_date ?? 0));
  }
  if (sort === "title") {
    return [...remote].sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  }
  return rankRemote(remote);
}

// Closest and most popular first: "Ori and the Blind Forest" before "Horizon Zero Dawn" for "ori", "Half-Life 2"
// before a mod named after it.
function rankByScore(
  remote: Parameters<typeof mapIgdbGame>[0][],
  scoreOf: (game: Parameters<typeof mapIgdbGame>[0]) => number,
): Parameters<typeof mapIgdbGame>[0][] {
  const scores = new Map(remote.map((game) => [game, scoreOf(game)]));
  return [...remote].sort((a, b) => (scores.get(b) ?? 0) - (scores.get(a) ?? 0) || (b.first_release_date ?? 0) - (a.first_release_date ?? 0));
}

// upsertIgdbGames keeps the order it is given, so ids[i] belongs to scores[i]; if it skipped a game the lists no
// longer line up and the local games simply go last.
function mergeByScore(ids: string[], scores: number[], extra: { id: string; score: number }[]): string[] {
  if (ids.length !== scores.length) return [...ids, ...extra.map((game) => game.id)];
  const items = [...ids.map((id, index) => ({ id, score: scores[index], order: index })), ...extra.map((game, index) => ({ ...game, order: ids.length + index }))];
  return items.sort((a, b) => b.score - a.score || a.order - b.order).map((item) => item.id);
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
    .where(and(eq(gameLinks.gameId, current.id), eq(gameLinks.source, "igdb"), notInArray(gameLinks.kind, STORE_LINK_KINDS)));

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

// The prefixes version the cached results: bump them whenever matching or ordering changes. During a deploy the
// old instance keeps serving and caching for a few minutes, and a new prefix keeps it from refilling the new keys.
function cacheKey(query: string, filters: SearchFilters): string {
  const base = query.toLowerCase();
  const sort = filters.sort && filters.sort !== "popular" ? filters.sort : "";
  const list = (values: string[] | undefined) => [...(values ?? [])].map((value) => value.toLowerCase()).sort().join(",");
  const lists = `${list(filters.genre)}|${list(filters.platform)}|${filters.year ?? ""}`;
  if (hasCredit(filters)) {
    return `m2:${base}|${lists}|${list(filters.developer)}~${list(filters.publisher)}~${list(filters.series)}|${sort}`;
  }
  if (!hasFilters(filters)) return sort ? `d6:${base}|${sort}` : `d6:${base}`;
  const core = `m2:${base}|${lists}`;
  return sort ? `${core}|${sort}` : core;
}

function hasCredit(filters: SearchFilters): boolean {
  return Boolean(filters.developer?.length || filters.publisher?.length || filters.series?.length);
}

function hasFilters(filters: SearchFilters): boolean {
  return Boolean(filters.genre?.length || filters.platform?.length || filters.year || hasCredit(filters));
}

async function creditClauses(filters: SearchFilters): Promise<string[] | null> {
  const clauses: string[] = [];
  if (filters.developer?.length) {
    const ids = await matchMany(filters.developer, matchCompanies);
    if (ids.length === 0) return null;
    clauses.push(`involved_companies.company = (${ids.join(",")}) & involved_companies.developer = true`);
  }
  if (filters.publisher?.length) {
    const ids = await matchMany(filters.publisher, matchCompanies);
    if (ids.length === 0) return null;
    clauses.push(`involved_companies.company = (${ids.join(",")}) & involved_companies.publisher = true`);
  }
  if (filters.series?.length) {
    const ids = await matchMany(filters.series, matchFranchises);
    if (ids.length === 0) return null;
    clauses.push(`franchises = (${ids.join(",")})`);
  }
  return clauses;
}

// Any of the names may match, so their IGDB ids are pooled into one list.
async function matchMany(names: string[], match: (name: string) => Promise<number[]>): Promise<number[]> {
  const found = await Promise.all(names.map((name) => match(name)));
  return [...new Set(found.flat())];
}

function filteredQuery(query: string, filters: SearchFilters, limit = SEARCH_POOL, extra: string[] = []): string {
  const where = ["game_type = (0,1,2,3,4,8,9,10)", "version_parent = null", "cover != null", ...extra];
  const genres = (filters.genre ?? []).flatMap((id) => catalogGenre(id)?.igdbId ?? []);
  const platforms = (filters.platform ?? []).flatMap((id) => catalogPlatform(id)?.igdbId ?? []);
  if (genres.length > 0) where.push(`genres = (${genres.join(",")})`);
  if (platforms.length > 0) where.push(`platforms = (${platforms.join(",")})`);
  if (filters.year) {
    const start = Math.floor(Date.UTC(filters.year, 0, 1) / 1000);
    const end = Math.floor(Date.UTC(filters.year + 1, 0, 1) / 1000);
    where.push(`first_release_date >= ${start} & first_release_date < ${end}`);
  }
  const lines: string[] = [];
  const term = query.replace(/["\\*\n\r;]/g, "").trim().slice(0, 80);
  if (term.length >= 2) lines.push(`search "${term}";`);
  else if (extra.length === 0) where.push("total_rating_count > 40");
  lines.push(CARD_FIELDS);
  const sort =
    filters.sort === "release" ? "first_release_date desc" : filters.sort === "title" ? "name asc" : "total_rating_count desc";
  lines.push(`where ${where.join(" & ")};`, `sort ${sort};`, `limit ${limit};`);
  return lines.join("\n");
}

function matchesLocal(game: GameRow, filters: SearchFilters): boolean {
  if (hasCredit(filters)) return false;
  if (filters.genre?.length) return false;
  if (filters.year && game.releaseDate?.slice(0, 4) !== String(filters.year)) return false;
  const platforms: string[] = (filters.platform ?? []).flatMap((id) => catalogPlatform(id)?.name ?? []);
  if (platforms.length > 0) {
    const names = Array.isArray(game.platforms) ? game.platforms : [];
    if (!names.some((name) => platforms.includes(name))) return false;
  }
  return true;
}

function sanitizeSlug(slug: string): string {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
