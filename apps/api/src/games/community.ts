import { stripReviewLinks, type CommunityReview, type CommunityScore } from "@gametracker/shared";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { listEntries, users } from "../db/schema.js";

export async function communityForGame(gameId: string): Promise<{
  community: CommunityScore;
  reviews: CommunityReview[];
}> {
  const scoreRows = await db
    .select({
      average: sql<number | null>`avg(${listEntries.rating})`,
      count: sql<number>`cast(count(${listEntries.rating}) as int)`,
    })
    .from(listEntries)
    .where(and(eq(listEntries.gameId, gameId), isNotNull(listEntries.rating)));
  const score = scoreRows[0];
  const count = Number(score?.count ?? 0);
  const average = count > 0 && score?.average != null ? Math.round(Number(score.average) * 10) / 10 : null;

  const reviewRows = await db
    .select({
      username: users.username,
      rating: listEntries.rating,
      review: listEntries.review,
      at: sql<Date>`coalesce(${listEntries.finishedAt}, ${listEntries.updatedAt})`,
    })
    .from(listEntries)
    .innerJoin(users, eq(users.id, listEntries.userId))
    .where(and(eq(listEntries.gameId, gameId), isNotNull(listEntries.review)))
    .orderBy(desc(listEntries.updatedAt))
    .limit(20);

  return {
    community: { average, count },
    reviews: reviewRows.flatMap((row) => {
      const review = row.review ? stripReviewLinks(row.review) : "";
      if (!review) return [];
      const at = row.at instanceof Date ? row.at.toISOString() : new Date(row.at).toISOString();
      return [{ username: row.username, rating: row.rating == null ? null : Number(row.rating), review, at }];
    }),
  };
}
