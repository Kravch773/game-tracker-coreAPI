import {
  LIBRARY_STATUSES,
  REVIEW_MAX_LENGTH,
  stripReviewLinks,
  t,
  type GameEntry,
  type LibraryGame,
  type LibraryStatus,
  type UserLibrary,
} from "@gametracker/shared";
import { and, desc, eq, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { queueMetacriticBackfill } from "../rawg/enrich.js";
import { favorites, follows, games, listEntries, steamPlays, steamWishMissing, steamWishes, users } from "../db/schema.js";

export class LibraryInputError extends Error {}

export async function libraryForUsername(username: string, viewerId: string | null): Promise<UserLibrary | null> {
  const found = await db
    .select({ id: users.id, username: users.username })
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  const user = found[0];
  if (!user) return null;
  const own = viewerId === user.id;

  const entries = await db
    .select({
      status: listEntries.status,
      rating: listEntries.rating,
      review: listEntries.review,
      addedAt: listEntries.createdAt,
      startedAt: listEntries.startedAt,
      finishedAt: listEntries.finishedAt,
      id: games.id,
      slug: games.slug,
      title: games.title,
      coverUrl: games.coverUrl,
      releaseDate: games.releaseDate,
      platforms: games.platforms,
      metacriticScore: games.metacriticScore,
      playtimeMinutes: steamPlays.playtimeMinutes,
    })
    .from(listEntries)
    .innerJoin(games, eq(games.id, listEntries.gameId))
    .leftJoin(steamPlays, own ? and(eq(steamPlays.userId, listEntries.userId), eq(steamPlays.gameId, listEntries.gameId)) : sql`false`)
    .where(eq(listEntries.userId, user.id))
    .orderBy(desc(listEntries.updatedAt));

  const favoriteRows = await db
    .select({
      rating: listEntries.rating,
      review: listEntries.review,
      addedAt: favorites.createdAt,
      startedAt: listEntries.startedAt,
      finishedAt: listEntries.finishedAt,
      id: games.id,
      slug: games.slug,
      title: games.title,
      coverUrl: games.coverUrl,
      releaseDate: games.releaseDate,
      platforms: games.platforms,
      metacriticScore: games.metacriticScore,
      playtimeMinutes: steamPlays.playtimeMinutes,
    })
    .from(favorites)
    .innerJoin(games, eq(games.id, favorites.gameId))
    .leftJoin(
      listEntries,
      and(eq(listEntries.userId, favorites.userId), eq(listEntries.gameId, favorites.gameId)),
    )
    .leftJoin(steamPlays, own ? and(eq(steamPlays.userId, favorites.userId), eq(steamPlays.gameId, favorites.gameId)) : sql`false`)
    .where(eq(favorites.userId, user.id))
    .orderBy(desc(favorites.createdAt));

  const library: UserLibrary = {
    user: { username: user.username },
    playing: [],
    finished: [],
    dropped: [],
    backlog: [],
    favorites: favoriteRows.map((row) => toLibraryGame(row, own)),
    steamWishlist: own ? (await steamWishlistRows(user.id)).map((row) => toLibraryGame(row, true)) : [],
    steamWishlistMissing: own ? await missingWishlistCount(user.id) : 0,
    followers: await countOf(eq(follows.followingId, user.id)),
    following: await countOf(eq(follows.followerId, user.id)),
    followedByMe: viewerId ? await followsUser(viewerId, user.id) : false,
  };

  void queueMetacriticBackfill(entries.map((entry) => entry.id)).catch((error: unknown) => {
    console.error("Metacritic backfill queue failed", error);
  });

  for (const entry of entries) {
    if (!isLibraryStatus(entry.status)) continue;
    library[entry.status].push(toLibraryGame(entry, own));
  }

  return library;
}

export async function entryForSlug(userId: string, slug: string): Promise<GameEntry | null> {
  const game = await gameBySlug(slug);
  if (!game) return null;

  const entryRows = await db
    .select()
    .from(listEntries)
    .where(and(eq(listEntries.userId, userId), eq(listEntries.gameId, game.id)))
    .limit(1);
  const favoriteRows = await db
    .select({ gameId: favorites.gameId })
    .from(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.gameId, game.id)))
    .limit(1);
  const entry = entryRows[0];

  return {
    status: entry && isLibraryStatus(entry.status) ? entry.status : null,
    rating: entry?.rating ?? null,
    review: entry?.review ? stripReviewLinks(entry.review) || null : null,
    favorite: favoriteRows.length > 0,
    steamMinutes: await steamMinutesFor(userId, game.id),
  };
}

export async function saveEntry(
  userId: string,
  slug: string,
  input: { status: LibraryStatus; rating: number | null; review: string | null },
): Promise<GameEntry> {
  const game = await gameBySlug(slug);
  if (!game) throw new MissingGameError();

  const rating = input.rating != null ? normalizeUserRating(input.rating) : null;
  const review = normalizeReview(input.review);
  if (input.rating != null && rating == null) {
    throw new LibraryInputError(t("library.ratingInvalid"));
  }

  const now = new Date();
  const currentRows = await db
    .select({
      status: listEntries.status,
      startedAt: listEntries.startedAt,
      finishedAt: listEntries.finishedAt,
    })
    .from(listEntries)
    .where(and(eq(listEntries.userId, userId), eq(listEntries.gameId, game.id)))
    .limit(1);
  const current = currentRows[0];
  const startedAt =
    input.status === "playing"
      ? current?.status === "playing" && current.startedAt
        ? current.startedAt
        : now
      : (current?.startedAt ?? null);
  const finishedAt =
    input.status === "finished"
      ? current?.status === "finished" && current.finishedAt
        ? current.finishedAt
        : now
      : (current?.finishedAt ?? null);
  await db
    .insert(listEntries)
    .values({
      userId,
      gameId: game.id,
      status: input.status,
      rating,
      review,
      startedAt,
      finishedAt,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [listEntries.userId, listEntries.gameId],
      set: { status: input.status, rating, review, startedAt, finishedAt, updatedAt: now },
    });

  return {
    status: input.status,
    rating,
    review,
    favorite: await isFavorite(userId, game.id),
    steamMinutes: await steamMinutesFor(userId, game.id),
  };
}

export async function removeEntry(userId: string, slug: string): Promise<void> {
  const game = await gameBySlug(slug);
  if (!game) throw new MissingGameError();
  await db
    .delete(listEntries)
    .where(and(eq(listEntries.userId, userId), eq(listEntries.gameId, game.id)));
}

export async function setFavorite(userId: string, slug: string, favorite: boolean): Promise<void> {
  const game = await gameBySlug(slug);
  if (!game) throw new MissingGameError();

  if (!favorite) {
    await db
      .delete(favorites)
      .where(and(eq(favorites.userId, userId), eq(favorites.gameId, game.id)));
    return;
  }

  await db.insert(favorites).values({ userId, gameId: game.id }).onConflictDoNothing();
}

export class MissingGameError extends Error {
  constructor() {
    super("Game not found");
  }
}

export function parseEntryBody(body: unknown): {
  status: LibraryStatus;
  rating: number | null;
  review: string | null;
} {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  if (!isLibraryStatus(record.status)) {
    throw new LibraryInputError(t("library.chooseSection"));
  }

  let rating: number | null = null;
  if (record.rating != null) {
    if (typeof record.rating !== "number" || !Number.isFinite(record.rating)) {
      throw new LibraryInputError(t("library.ratingInvalid"));
    }
    rating = normalizeUserRating(record.rating);
    if (rating == null) throw new LibraryInputError(t("library.ratingInvalid"));
  }

  const review = typeof record.review === "string" ? record.review : null;
  return { status: record.status, rating, review };
}

function normalizeReview(review: string | null): string | null {
  if (!review) return null;
  const stripped = stripReviewLinks(review);
  if (!stripped) return null;
  if ([...stripped].length > REVIEW_MAX_LENGTH) {
    throw new LibraryInputError(t("library.reviewTooLong"));
  }
  return stripped;
}

async function steamWishlistRows(userId: string) {
  return db
    .select({
      rating: listEntries.rating,
      review: listEntries.review,
      addedAt: steamWishes.syncedAt,
      startedAt: listEntries.startedAt,
      finishedAt: listEntries.finishedAt,
      id: games.id,
      slug: games.slug,
      title: games.title,
      coverUrl: games.coverUrl,
      releaseDate: games.releaseDate,
      platforms: games.platforms,
      metacriticScore: games.metacriticScore,
      playtimeMinutes: steamPlays.playtimeMinutes,
    })
    .from(steamWishes)
    .innerJoin(games, eq(games.id, steamWishes.gameId))
    .leftJoin(listEntries, and(eq(listEntries.userId, steamWishes.userId), eq(listEntries.gameId, steamWishes.gameId)))
    .leftJoin(steamPlays, and(eq(steamPlays.userId, steamWishes.userId), eq(steamPlays.gameId, steamWishes.gameId)))
    .where(eq(steamWishes.userId, userId))
    .orderBy(desc(steamWishes.syncedAt));
}

async function missingWishlistCount(userId: string): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(steamWishMissing)
    .where(eq(steamWishMissing.userId, userId));
  return Number(rows[0]?.count ?? 0);
}

function toLibraryGame(row: {
  rating: number | null;
  review: string | null;
  addedAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  id: string;
  slug: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
  platforms: unknown;
  metacriticScore: number | null;
  playtimeMinutes: number | null;
}, includeSteam: boolean): LibraryGame {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    coverUrl: row.coverUrl,
    releaseDate: row.releaseDate,
    platforms: Array.isArray(row.platforms)
      ? row.platforms.filter((item): item is string => typeof item === "string")
      : [],
    rating: row.rating == null ? null : Number(row.rating),
    review: row.review ? stripReviewLinks(row.review) || null : null,
    addedAt: row.addedAt.toISOString(),
    startedAt: row.startedAt ? row.startedAt.toISOString() : null,
    finishedAt: row.finishedAt ? row.finishedAt.toISOString() : null,
    metacriticScore: row.metacriticScore,
    steamMinutes: includeSteam ? row.playtimeMinutes : null,
  };
}

async function steamMinutesFor(userId: string, gameId: string): Promise<number | null> {
  const rows = await db
    .select({ minutes: steamPlays.playtimeMinutes })
    .from(steamPlays)
    .where(and(eq(steamPlays.userId, userId), eq(steamPlays.gameId, gameId)))
    .limit(1);
  return rows[0]?.minutes ?? null;
}

async function countOf(where: ReturnType<typeof eq>): Promise<number> {
  const rows = await db
    .select({ count: sql<number>`cast(count(*) as int)` })
    .from(follows)
    .where(where);
  return Number(rows[0]?.count ?? 0);
}

async function followsUser(followerId: string, followingId: string): Promise<boolean> {
  const rows = await db
    .select({ followerId: follows.followerId })
    .from(follows)
    .where(and(eq(follows.followerId, followerId), eq(follows.followingId, followingId)))
    .limit(1);
  return rows.length > 0;
}

export function normalizeUserRating(value: number): number | null {
  if (!Number.isFinite(value)) return null;
  const rounded = Math.round(value * 10) / 10;
  if (rounded === 11) return 11;
  if (rounded < 0 || rounded > 10) return null;
  return rounded;
}

function isLibraryStatus(value: unknown): value is LibraryStatus {
  return typeof value === "string" && (LIBRARY_STATUSES as readonly string[]).includes(value);
}

async function gameBySlug(slug: string) {
  const rows = await db.select({ id: games.id }).from(games).where(eq(games.slug, slug)).limit(1);
  return rows[0] ?? null;
}

async function isFavorite(userId: string, gameId: string): Promise<boolean> {
  const rows = await db
    .select({ gameId: favorites.gameId })
    .from(favorites)
    .where(and(eq(favorites.userId, userId), eq(favorites.gameId, gameId)))
    .limit(1);
  return rows.length > 0;
}
