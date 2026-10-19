import type { ReleaseCalendar, ReleaseDay, ReleaseGame } from "@gametracker/shared";
import { inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { games } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { queryIgdbGames } from "../igdb/client.js";
import { mapIgdbGame } from "../igdb/map.js";
import { toSummary } from "./present.js";
import { storeIgdbGames } from "./service.js";

const CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const PLAYABLE = "game_type = (0,8,9) & version_parent = null & cover != null";
const FIELDS =
  "fields name,slug,summary,first_release_date,cover.image_id,platforms.name,websites.url,websites.type,hypes,release_dates.date,release_dates.date_format,release_dates.platform.name,release_dates.platform.abbreviation;";

const cache = new Map<string, { at: number; value: ReleaseCalendar }>();
const pending = new Map<string, Promise<ReleaseCalendar>>();

export function calendarMonth(requested?: string, now = new Date()): string {
  if (requested && /^\d{4}-\d{2}$/.test(requested)) {
    const [year, month] = requested.split("-").map(Number);
    if (year >= 2020 && year <= 2032 && month >= 1 && month <= 12) return `${requested}-01`;
  }
  return utcMonthStart(now);
}

export async function releaseCalendar(requested?: string, now = new Date()): Promise<ReleaseCalendar> {
  const month = calendarMonth(requested, now);
  const key = month.slice(0, 7);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  const job = pending.get(key);
  if (job) return job;

  const next = load(month, key).finally(() => {
    pending.delete(key);
  });
  pending.set(key, next);
  return next;
}

async function load(month: string, key: string): Promise<ReleaseCalendar> {
  const empty = { month, days: [], mine: [] };
  if (!igdbConfigured()) return cache.get(key)?.value ?? empty;

  const start = Math.floor(new Date(`${month}T00:00:00Z`).getTime() / 1000);
  const end = Math.floor(new Date(nextMonth(month)).getTime() / 1000);
  try {
    const day = 24 * 60 * 60;
    const [hyped, later] = await Promise.all([
      queryIgdbGames(monthQuery(start, end, "hypes desc", 40)),
      queryIgdbGames(monthQuery(start + day, end, "release_dates.date asc", 80)),
    ]);
    const selected = [...pick(hyped, start, end), ...pick(later, start, end)];
    const ids = await storeIgdbGames(selected.map((item) => item.raw));
    const value = {
      month,
      mine: [],
      days: await daysFor(
        ids,
        selected.map((item) => ({ hypes: item.hypes, date: item.date, platforms: item.platforms })),
      ),
    };
    cache.set(key, { at: Date.now(), value });
    return value;
  } catch (error) {
    console.error("Release calendar failed", error);
    return cache.get(key)?.value ?? empty;
  }
}

function monthQuery(start: number, end: number, sort: string, limit: number): string {
  return [
    FIELDS,
    `where release_dates.date >= ${start} & release_dates.date < ${end} & ${PLAYABLE};`,
    `sort ${sort};`,
    `limit ${limit};`,
  ].join("\n");
}

function pick(
  remote: Awaited<ReturnType<typeof queryIgdbGames>>,
  start: number,
  end: number,
): { raw: (typeof remote)[number]; hypes: number; date: string | null; platforms: string[] }[] {
  return remote.flatMap((game): { raw: (typeof remote)[number]; hypes: number; date: string | null; platforms: string[] }[] => {
    if (!mapIgdbGame(game)) return [];
    const stamps = (game.release_dates ?? []).filter(
      (item) => typeof item.date === "number" && item.date >= start && item.date < end,
    );
    const exact = stamps
      .filter((item) => item.date_format === 0)
      .sort((a, b) => (a.date ?? 0) - (b.date ?? 0));
    const hypes = typeof game.hypes === "number" ? game.hypes : 0;
    if (exact[0]?.date) {
      return [
        {
          raw: game,
          hypes,
          date: new Date(exact[0].date * 1000).toISOString().slice(0, 10),
          platforms: platformNames(exact),
        },
      ];
    }
    const loose = stamps.filter((item) => item.date_format === 1);
    if (loose.length > 0) return [{ raw: game, hypes, date: null, platforms: platformNames(loose) }];
    return [];
  });
}

function platformNames(stamps: { platform?: { name?: string; abbreviation?: string } }[]): string[] {
  return [
    ...new Set(
      stamps
        .map((item) => item.platform?.abbreviation?.trim() || item.platform?.name?.trim() || "")
        .filter((name) => name.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

async function daysFor(
  ids: string[],
  marks: { hypes: number; date: string | null; platforms: string[] }[],
): Promise<ReleaseDay[]> {
  if (ids.length === 0) return [];
  const rows = await db.select().from(games).where(inArray(games.id, ids));
  const byId = new Map(rows.map((row) => [row.id, row]));
  const grouped = new Map<string, ReleaseGame[]>();
  const seen = new Set<string>();

  ids.forEach((id, index) => {
    const row = byId.get(id);
    const mark = marks[index];
    if (!row || !mark || seen.has(id)) return;
    seen.add(id);
    const date = mark.date ?? "unscheduled";
    const summary = toSummary(row);
    const game: ReleaseGame = {
      ...summary,
      releaseDate: mark.date ?? summary.releaseDate,
      hypes: mark.hypes,
      featured: false,
      releasePlatforms: mark.platforms,
    };
    const list = grouped.get(date) ?? [];
    if (list.some((item) => item.id === game.id)) return;
    list.push(game);
    grouped.set(date, list);
  });

  return [...grouped.entries()]
    .sort(([a], [b]) => {
      if (a === "unscheduled") return 1;
      if (b === "unscheduled") return -1;
      return a.localeCompare(b);
    })
    .map(([date, list]) => ({ date, games: feature(list) }));
}

function feature(list: ReleaseGame[]): ReleaseGame[] {
  const max = Math.max(...list.map((game) => game.hypes), 0);
  const floor = Math.max(5, Math.ceil(max * 0.6));
  return [...list]
    .sort((a, b) => b.hypes - a.hypes || a.title.localeCompare(b.title))
    .map((game) => ({ ...game, featured: max >= 5 && game.hypes >= floor }));
}

function utcMonthStart(now: Date): string {
  const month = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${now.getUTCFullYear()}-${month}-01`;
}

function nextMonth(monthStart: string): string {
  const [year, month] = monthStart.split("-").map(Number);
  const next = new Date(Date.UTC(year, month, 1));
  const value = String(next.getUTCMonth() + 1).padStart(2, "0");
  return `${next.getUTCFullYear()}-${value}-01T00:00:00Z`;
}
