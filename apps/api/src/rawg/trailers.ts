import type { GameTrailer } from "@gametracker/shared";
import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import type { GameRow, StoredTrailer } from "../db/schema.js";
import { gameTrailers, games } from "../db/schema.js";
import { env, rawgConfigured } from "../env.js";
import { findExactRawgGame } from "./enrich.js";

const TRAILER_LIMIT = 12;

const trailerRequests = new Map<string, Promise<GameTrailer[]>>();

export class TrailersUnavailableError extends Error {
  constructor() {
    super("RAWG is not configured");
  }
}

export async function trailersForSlug(slug: string): Promise<GameTrailer[] | null> {
  const rows = await db.select().from(games).where(eq(games.slug, slug)).limit(1);
  const game = rows[0];
  if (!game) return null;
  return ensureTrailers(game);
}

async function ensureTrailers(game: GameRow): Promise<GameTrailer[]> {
  const existing = await readTrailers(game.id);
  if (existing) return existing;

  const pending = trailerRequests.get(game.id);
  if (pending) return pending;

  const request = loadTrailers(game).finally(() => {
    trailerRequests.delete(game.id);
  });
  trailerRequests.set(game.id, request);
  return request;
}

async function loadTrailers(game: GameRow): Promise<GameTrailer[]> {
  const existing = await readTrailers(game.id);
  if (existing) return existing;
  if (!rawgConfigured()) throw new TrailersUnavailableError();

  const match = await findExactRawgGame(game.title);
  const trailers = match ? await fetchRawgMovies(match.id) : [];
  const now = new Date();

  await db
    .insert(gameTrailers)
    .values({
      gameId: game.id,
      rawgId: match?.id ?? null,
      trailers,
      fetchedAt: now,
    })
    .onConflictDoNothing({ target: gameTrailers.gameId });

  return (await readTrailers(game.id)) ?? trailers;
}

async function readTrailers(gameId: string): Promise<GameTrailer[] | null> {
  const rows = await db.select().from(gameTrailers).where(eq(gameTrailers.gameId, gameId)).limit(1);
  const row = rows[0];
  if (!row) return null;
  return presentTrailers(row.trailers);
}

type RawgMovie = {
  name?: unknown;
  preview?: unknown;
  data?: unknown;
};

async function fetchRawgMovies(rawgId: number): Promise<StoredTrailer[]> {
  const first = new URL(`https://api.rawg.io/api/games/${rawgId}/movies`);
  first.searchParams.set("key", env.rawgApiKey);
  first.searchParams.set("page_size", String(TRAILER_LIMIT));

  const collected: StoredTrailer[] = [];
  let nextUrl: string | null = first.toString();

  while (nextUrl && collected.length < TRAILER_LIMIT) {
    const response = await fetch(nextUrl, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) {
      throw new Error(`RAWG movies failed with ${response.status}`);
    }

    const payload = (await response.json()) as { next?: unknown; results?: RawgMovie[] };
    for (const movie of payload.results ?? []) {
      const trailer = mapMovie(movie);
      if (!trailer) continue;
      collected.push(trailer);
      if (collected.length >= TRAILER_LIMIT) break;
    }

    nextUrl = typeof payload.next === "string" && payload.next.startsWith("https://") ? payload.next : null;
  }

  return collected;
}

function mapMovie(movie: RawgMovie): StoredTrailer | null {
  const data = movie.data && typeof movie.data === "object" ? (movie.data as Record<string, unknown>) : {};
  const videoUrl = httpsUrl(data.max) ?? httpsUrl(data["480"]);
  if (!videoUrl) return null;

  const name = typeof movie.name === "string" ? movie.name.trim() : "";
  return {
    name: name || null,
    previewUrl: httpsUrl(movie.preview),
    videoUrl,
  };
}

function httpsUrl(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const url = value.trim();
  return url.startsWith("https://") ? url : null;
}

function presentTrailers(value: unknown): GameTrailer[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const videoUrl = httpsUrl(record.videoUrl);
    if (!videoUrl) return [];
    const name = typeof record.name === "string" ? record.name : null;
    return [{ name, previewUrl: httpsUrl(record.previewUrl), videoUrl }];
  });
}
