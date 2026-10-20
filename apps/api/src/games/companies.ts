import type { GameSummary } from "@gametracker/shared";
import { eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { collectionCache, gameDetails, games } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { findCompanyIds, queryIgdbGames } from "../igdb/client.js";
import { toSummary } from "./present.js";
import { storeIgdbGames } from "./service.js";

const CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const PLAYABLE = "game_type = (0,8,9) & version_parent = null";
const FIELDS =
  "fields name,slug,summary,first_release_date,cover.image_id,platforms.name,websites.url,websites.type,total_rating_count,hypes;";
const refreshing = new Map<string, Promise<string[]>>();

export type CompanyRole = "developer" | "publisher";

export async function companyGames(role: CompanyRole, rawName: string): Promise<GameSummary[]> {
  const name = rawName.replace(/\s+/g, " ").trim();
  if (name.length < 2) return [];

  const key = `company:v4:${role}:${name.toLowerCase()}`;
  const rows = await db.select().from(collectionCache).where(eq(collectionCache.key, key)).limit(1);
  const cached = rows[0];
  if (cached && Date.now() - cached.fetchedAt.getTime() < CACHE_TTL_MS) {
    return ordered(cached.gameIds);
  }

  const pending = refreshing.get(key);
  if (pending) return ordered(await pending);

  const job = refresh(key, role, name, cached?.gameIds ?? null).finally(() => refreshing.delete(key));
  refreshing.set(key, job);
  return ordered(await job);
}

async function refresh(key: string, role: CompanyRole, name: string, fallback: string[] | null): Promise<string[]> {
  const local = await localCompanyIds(role, name);
  if (!igdbConfigured()) return local.length > 0 ? local : (fallback ?? []);

  try {
    const companyIds = await findCompanyIds(name);
    const remote = await gamesForCompanies(role, companyIds);
    const remoteIds = await storeIgdbGames(remote);
    const seen = new Set(remoteIds);
    const ids = [...remoteIds, ...local.filter((id) => !seen.has(id))];
    await db
      .insert(collectionCache)
      .values({ key, gameIds: ids, fetchedAt: new Date() })
      .onConflictDoUpdate({
        target: collectionCache.key,
        set: { gameIds: ids, fetchedAt: new Date() },
      });
    return ids;
  } catch (error) {
    console.error(`Company games ${key} failed`, error);
    return local.length > 0 ? local : (fallback ?? []);
  }
}

async function gamesForCompanies(role: CompanyRole, companyIds: number[]) {
  let best: Awaited<ReturnType<typeof queryIgdbGames>> = [];
  let bestScore = -1;
  for (const companyId of companyIds) {
    const games = await queryIgdbGames(companyQuery(role, companyId));
    const score = games.reduce((sum, game) => sum + popularity(game), 0);
    if (score > bestScore) {
      best = games;
      bestScore = score;
    }
  }
  return [...best].sort((a, b) => popularity(b) - popularity(a));
}

function popularity(game: { total_rating_count?: number; hypes?: number }): number {
  return (game.total_rating_count ?? 0) + (game.hypes ?? 0);
}

function companyQuery(role: CompanyRole, companyId: number): string {
  const flag = role === "developer" ? "developer" : "publisher";
  return [
    FIELDS,
    `where involved_companies.company = ${companyId} & involved_companies.${flag} = true & ${PLAYABLE};`,
    "sort total_rating_count desc;",
    "limit 48;",
  ].join("\n");
}

async function localCompanyIds(role: CompanyRole, name: string): Promise<string[]> {
  const column = role === "developer" ? gameDetails.developers : gameDetails.publishers;
  const rows = await db
    .select({ id: games.id })
    .from(games)
    .innerJoin(gameDetails, eq(gameDetails.gameId, games.id))
    .where(
      sql`exists (
        select 1 from jsonb_array_elements_text(${column}) as company(name)
        where lower(company.name) = ${name.toLowerCase()}
      )`,
    )
    .orderBy(sql`${games.releaseDate} desc nulls last`)
    .limit(48);
  return rows.map((row) => row.id);
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
