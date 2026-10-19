import { t, type ActivityEvent } from "@gametracker/shared";
import { and, desc, eq, inArray, isNotNull, or, sql } from "drizzle-orm";
import { AuthInputError } from "../auth/service.js";
import { db } from "../db/client.js";
import { follows, games, listEntries, users } from "../db/schema.js";
import { toSummary } from "../games/present.js";

export async function listFollows(
  username: string,
  kind: "followers" | "following",
): Promise<{ username: string }[] | null> {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  const user = found[0];
  if (!user) return null;

  const person = kind === "following" ? follows.followingId : follows.followerId;
  const owner = kind === "following" ? follows.followerId : follows.followingId;
  return db
    .select({ username: users.username })
    .from(follows)
    .innerJoin(users, eq(users.id, person))
    .where(eq(owner, user.id))
    .orderBy(desc(follows.createdAt))
    .limit(100);
}

export async function setFollow(
  followerId: string,
  username: string,
  follow: boolean,
): Promise<{ following: boolean } | null> {
  const found = await db
    .select({ id: users.id })
    .from(users)
    .where(sql`lower(${users.username}) = ${username.toLowerCase()}`)
    .limit(1);
  const target = found[0];
  if (!target) return null;
  if (target.id === followerId) throw new AuthInputError(t("profile.followSelf"));

  if (!follow) {
    await db
      .delete(follows)
      .where(and(eq(follows.followerId, followerId), eq(follows.followingId, target.id)));
    return { following: false };
  }

  await db.insert(follows).values({ followerId, followingId: target.id }).onConflictDoNothing();
  return { following: true };
}

export async function activityFeed(viewerId: string | null, followingOnly: boolean): Promise<ActivityEvent[]> {
  const filters = [
    inArray(listEntries.status, ["finished", "dropped"]),
    or(isNotNull(listEntries.rating), isNotNull(listEntries.review)),
  ];
  const query = db
    .select({
      username: users.username,
      status: listEntries.status,
      rating: listEntries.rating,
      review: listEntries.review,
      at: sql<Date>`coalesce(${listEntries.finishedAt}, ${listEntries.updatedAt})`,
      game: games,
    })
    .from(listEntries)
    .innerJoin(users, eq(users.id, listEntries.userId))
    .innerJoin(games, eq(games.id, listEntries.gameId))
    .where(and(...filters))
    .orderBy(desc(sql`coalesce(${listEntries.finishedAt}, ${listEntries.updatedAt})`))
    .limit(30);

  if (followingOnly && viewerId) {
    const followed = await db
      .select({ id: follows.followingId })
      .from(follows)
      .where(eq(follows.followerId, viewerId));
    const ids = followed.map((row) => row.id);
    if (ids.length === 0) return [];
    const rows = await db
      .select({
        username: users.username,
        status: listEntries.status,
        rating: listEntries.rating,
        review: listEntries.review,
        at: sql<Date>`coalesce(${listEntries.finishedAt}, ${listEntries.updatedAt})`,
        game: games,
      })
      .from(listEntries)
      .innerJoin(users, eq(users.id, listEntries.userId))
      .innerJoin(games, eq(games.id, listEntries.gameId))
      .where(and(...filters, inArray(listEntries.userId, ids)))
      .orderBy(desc(sql`coalesce(${listEntries.finishedAt}, ${listEntries.updatedAt})`))
      .limit(30);
    return rows.flatMap(toEvent);
  }

  return (await query).flatMap(toEvent);
}

function toEvent(row: {
  username: string;
  status: string;
  rating: number | null;
  review: string | null;
  at: Date;
  game: typeof games.$inferSelect;
}): ActivityEvent[] {
  if (row.status !== "finished" && row.status !== "dropped") return [];
  const at = row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString();
  return [
    {
      username: row.username,
      status: row.status,
      rating: row.rating == null ? null : Number(row.rating),
      review: row.review,
      at,
      game: toSummary(row.game),
    },
  ];
}
