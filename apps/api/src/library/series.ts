import { LIBRARY_STATUSES, type GameSeries, type LibraryStatus, type SeriesGame, type UserSeries } from "@gametracker/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { franchiseGames, gameFranchises, games, listEntries, users, type StoredFranchiseGame } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { fetchFranchiseGames, fetchFranchisesOf } from "../igdb/client.js";
import { mapIgdbGame } from "../igdb/map.js";

const FRANCHISE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const GAMES_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_SERIES = 80;
const MAX_GAMES = 60;

type Entry = {
  gameId: string;
  igdbId: number;
  status: string;
  rating: number | null;
  slug: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
};

const pending = new Map<string, Promise<UserSeries | null>>();

// The profile's games grouped by IGDB franchise, each series filled with the parts that are not in the lists yet.
export function seriesForUsername(username: string): Promise<UserSeries | null> {
  const key = username.toLowerCase();
  const running = pending.get(key);
  if (running) return running;
  const job = buildSeries(key).finally(() => pending.delete(key));
  pending.set(key, job);
  return job;
}

async function buildSeries(username: string): Promise<UserSeries | null> {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${username}`)
    .limit(1);
  const user = found[0];
  if (!user) return null;

  const entries: Entry[] = await db
    .select({
      gameId: games.id,
      igdbId: games.igdbId,
      status: listEntries.status,
      rating: listEntries.rating,
      slug: games.slug,
      title: games.title,
      coverUrl: games.coverUrl,
      releaseDate: games.releaseDate,
    })
    .from(listEntries)
    .innerJoin(games, eq(games.id, listEntries.gameId))
    .where(eq(listEntries.userId, user.id));
  if (entries.length === 0) return { series: [] };

  const franchiseOf = await franchisesFor(entries);
  const groups = new Map<number, { name: string; entries: Entry[] }>();
  for (const entry of entries) {
    const franchise = franchiseOf.get(entry.gameId);
    if (!franchise) continue;
    const group = groups.get(franchise.id) ?? { name: franchise.name, entries: [] };
    group.entries.push(entry);
    groups.set(franchise.id, group);
  }

  const picked = [...groups.entries()].sort((left, right) => right[1].entries.length - left[1].entries.length).slice(0, MAX_SERIES);
  const full = await gamesOfFranchises(picked.map(([id]) => id));
  const byIgdb = new Map(entries.map((entry) => [entry.igdbId, entry]));

  const series: GameSeries[] = picked.flatMap(([id, group]) => {
    const seen = new Set<number>();
    const list: SeriesGame[] = [];
    for (const game of [...(full.get(id) ?? []), ...group.entries]) {
      if (seen.has(game.igdbId)) continue;
      seen.add(game.igdbId);
      list.push(toSeriesGame(game, byIgdb.get(game.igdbId)));
    }
    if (list.length < 2) return [];
    list.sort((left, right) => (left.releaseDate ?? "9999").localeCompare(right.releaseDate ?? "9999"));
    return [{ id, name: group.name, games: list.slice(0, MAX_GAMES) }];
  });

  return { series };
}

function toSeriesGame(game: StoredFranchiseGame | Entry, entry: Entry | undefined): SeriesGame {
  const source = entry ?? game;
  return {
    slug: source.slug,
    title: source.title,
    coverUrl: source.coverUrl,
    releaseDate: source.releaseDate,
    status: entry && isLibraryStatus(entry.status) ? entry.status : null,
    rating: entry?.rating == null ? null : Number(entry.rating),
  };
}

// Reads each game's franchise from the cache and asks IGDB once for the games it has not seen in a month.
async function franchisesFor(entries: Entry[]): Promise<Map<string, { id: number; name: string }>> {
  const rows = await db.select().from(gameFranchises).where(
    inArray(
      gameFranchises.gameId,
      entries.map((entry) => entry.gameId),
    ),
  );
  const known = new Map(rows.map((row) => [row.gameId, row]));
  const freshAfter = Date.now() - FRANCHISE_TTL_MS;
  const stale = entries.filter((entry) => {
    const row = known.get(entry.gameId);
    return !row || row.fetchedAt.getTime() < freshAfter;
  });

  if (stale.length > 0 && igdbConfigured()) {
    try {
      const remote = await fetchFranchisesOf(stale.map((entry) => entry.igdbId));
      const byIgdb = new Map(remote.flatMap((game) => (game.id ? [[game.id, game] as const] : [])));
      const now = new Date();
      const values = stale.map((entry) => {
        const game = byIgdb.get(entry.igdbId);
        const main = [game?.franchise, ...(game?.franchises ?? [])].find((item) => item?.id && item.name?.trim());
        return {
          gameId: entry.gameId,
          franchiseId: main?.id ?? null,
          franchiseName: main?.name?.trim() ?? null,
          fetchedAt: now,
        };
      });
      for (let index = 0; index < values.length; index += 200) {
        await db
          .insert(gameFranchises)
          .values(values.slice(index, index + 200))
          .onConflictDoUpdate({
            target: gameFranchises.gameId,
            set: {
              franchiseId: sql`excluded.franchise_id`,
              franchiseName: sql`excluded.franchise_name`,
              fetchedAt: sql`excluded.fetched_at`,
            },
          });
      }
      for (const value of values) known.set(value.gameId, value);
    } catch (error) {
      console.error("Series franchise lookup failed", error);
    }
  }

  const result = new Map<string, { id: number; name: string }>();
  for (const [gameId, row] of known) {
    if (row.franchiseId != null && row.franchiseName) result.set(gameId, { id: row.franchiseId, name: row.franchiseName });
  }
  return result;
}

// Every main game of each franchise, cached for a week; stale franchises are refreshed together.
async function gamesOfFranchises(ids: number[]): Promise<Map<number, StoredFranchiseGame[]>> {
  const result = new Map<number, StoredFranchiseGame[]>();
  if (ids.length === 0) return result;

  const rows = await db.select().from(franchiseGames).where(inArray(franchiseGames.franchiseId, ids));
  for (const row of rows) result.set(row.franchiseId, row.games);
  const freshAfter = Date.now() - GAMES_TTL_MS;
  const fresh = new Set(rows.filter((row) => row.fetchedAt.getTime() >= freshAfter).map((row) => row.franchiseId));
  const stale = ids.filter((id) => !fresh.has(id));
  if (stale.length === 0 || !igdbConfigured()) return result;

  try {
    const remote = await fetchFranchiseGames(stale);
    const lists = new Map<number, StoredFranchiseGame[]>(stale.map((id) => [id, []]));
    for (const game of remote) {
      const mapped = mapIgdbGame(game);
      if (!mapped) continue;
      const stored: StoredFranchiseGame = {
        igdbId: mapped.igdbId,
        slug: mapped.slug,
        title: mapped.title,
        coverUrl: mapped.coverUrl,
        releaseDate: mapped.releaseDate,
      };
      for (const franchise of game.franchises ?? []) lists.get(franchise)?.push(stored);
    }
    const now = new Date();
    const values = [...lists.entries()].map(([franchiseId, list]) => ({ franchiseId, games: list, fetchedAt: now }));
    for (let index = 0; index < values.length; index += 50) {
      await db
        .insert(franchiseGames)
        .values(values.slice(index, index + 50))
        .onConflictDoUpdate({
          target: franchiseGames.franchiseId,
          set: { games: sql`excluded.games`, fetchedAt: sql`excluded.fetched_at` },
        });
    }
    for (const [id, list] of lists) result.set(id, list);
  } catch (error) {
    console.error("Series games lookup failed", error);
  }
  return result;
}

function isLibraryStatus(value: unknown): value is LibraryStatus {
  return typeof value === "string" && (LIBRARY_STATUSES as readonly string[]).includes(value);
}
