import { LIBRARY_STATUSES, REVIEW_MAX_LENGTH, stripReviewLinks, t, type LibraryStatus, type MyGamesListImportResult, type MyGamesListImportRow } from "@gametracker/shared";
import { db } from "../db/client.js";
import { listEntries } from "../db/schema.js";
import { searchIgdb } from "../igdb/client.js";
import type { IgdbGame } from "../igdb/map.js";
import { storeIgdbGames } from "../games/service.js";
import { LibraryInputError, normalizeUserRating } from "./service.js";

const SCORED = new Set<LibraryStatus>(["playing", "finished", "dropped"]);
const BATCH_LIMIT = 20;

export async function importMyGamesList(userId: string, rows: MyGamesListImportRow[]): Promise<MyGamesListImportResult> {
  if (rows.length > BATCH_LIMIT) throw new LibraryInputError(t("api.badPayload"));

  const result: MyGamesListImportResult = { imported: 0, missing: [], skipped: 0 };
  for (const row of rows) {
    const title = row.title.trim();
    if (!title) {
      result.skipped += 1;
      continue;
    }
    const gameId = await findGameId(title);
    if (!gameId) {
      result.missing.push(title);
      continue;
    }
    await writeEntry(userId, gameId, row);
    result.imported += 1;
  }
  return result;
}

export function parseImportRows(body: unknown): MyGamesListImportRow[] {
  const record = body && typeof body === "object" ? (body as { rows?: unknown }) : {};
  if (!Array.isArray(record.rows)) throw new LibraryInputError(t("api.badPayload"));
  return record.rows.map(parseRow);
}

async function findGameId(title: string): Promise<string | null> {
    const remote = await searchIgdb(title);
  const match = remote
    .filter((game): game is IgdbGame & { name: string; id: number } => Boolean(game.name && game.id))
    .map((game) => ({ game, rank: titleRank(game.name, title) }))
    .filter((item) => item.rank > 0)
    .sort((a, b) => b.rank - a.rank || (b.game.first_release_date ?? 0) - (a.game.first_release_date ?? 0))[0]?.game;
  if (!match) return null;
  const ids = await storeIgdbGames([match]);
  return ids[0] ?? null;
}

async function writeEntry(userId: string, gameId: string, row: MyGamesListImportRow): Promise<void> {
  const scored = SCORED.has(row.status);
  const createdAt = parseStamp(row.createdAt) ?? new Date();
  const updatedAt = parseStamp(row.updatedAt) ?? createdAt;
  await db
    .insert(listEntries)
    .values({
      userId,
      gameId,
      status: row.status,
      rating: scored ? row.rating : null,
      review: scored ? clipReview(row.review) : null,
      startedAt: row.status === "playing" ? createdAt : null,
      finishedAt: row.status === "finished" ? updatedAt : null,
      createdAt,
      updatedAt,
    })
    .onConflictDoUpdate({
      target: [listEntries.userId, listEntries.gameId],
      set: {
        status: row.status,
        rating: scored ? row.rating : null,
        review: scored ? clipReview(row.review) : null,
        startedAt: row.status === "playing" ? createdAt : null,
        finishedAt: row.status === "finished" ? updatedAt : null,
        createdAt,
        updatedAt,
      },
    });
}

function parseRow(value: unknown): MyGamesListImportRow {
  const record = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const title = typeof record.title === "string" ? record.title.trim() : "";
  const status = record.status;
  if (!title || title.length > 180 || !isStatus(status)) throw new LibraryInputError(t("api.badPayload"));
  let rating: number | null = null;
  if (record.rating != null) {
    if (typeof record.rating !== "number" || !Number.isFinite(record.rating)) {
      throw new LibraryInputError(t("library.ratingInvalid"));
    }
    rating = normalizeUserRating(record.rating);
    if (rating == null || rating === 11) throw new LibraryInputError(t("library.ratingInvalid"));
  }
  const review = typeof record.review === "string" ? record.review : null;
  return {
    title,
    rating,
    status,
    review,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : null,
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : null,
  };
}

function isStatus(value: unknown): value is LibraryStatus {
  return typeof value === "string" && (LIBRARY_STATUSES as readonly string[]).includes(value);
}

function clipReview(review: string | null): string | null {
  if (!review) return null;
  const stripped = stripReviewLinks(review);
  if (!stripped) return null;
  return [...stripped].slice(0, REVIEW_MAX_LENGTH).join("");
}

function parseStamp(value: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function titleRank(candidate: string, query: string): number {
  if (sameTitle(candidate, query)) return 2;
  const tail = candidate.split(/\s+[-–—:]\s+/).at(-1)?.trim() ?? "";
  if (tail !== candidate && tail.includes(" ") && sameTitle(tail, query)) return 1;
  return 0;
}

function sameTitle(left: string, right: string): boolean {
  return normalizeTitle(left) === normalizeTitle(right);
}

function normalizeTitle(value: string): string {
  return value
    .toLowerCase()
    .replace(/['’ʼ]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}
