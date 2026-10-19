import type { SitemapPayload } from "@gametracker/shared";
import { asc, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { games, users } from "../db/schema.js";

const PAGE_SIZE = 5000;

export async function sitemapPage(page: number): Promise<SitemapPayload> {
  const safePage = Number.isInteger(page) && page > 0 ? page : 1;
  const counted = await db.select({ count: sql<number>`cast(count(*) as int)` }).from(games);
  const total = Number(counted[0]?.count ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const current = Math.min(safePage, pageCount);
  const gameRows = await db
    .select({ slug: games.slug, updatedAt: games.updatedAt })
    .from(games)
    .orderBy(asc(games.slug))
    .limit(PAGE_SIZE)
    .offset((current - 1) * PAGE_SIZE);
  const userRows =
    current === 1
      ? await db
          .select({ username: users.username, createdAt: users.createdAt })
          .from(users)
          .orderBy(asc(users.username))
          .limit(PAGE_SIZE)
      : [];

  return {
    page: current,
    pageCount,
    games: gameRows.map((row) => ({ slug: row.slug, updatedAt: row.updatedAt.toISOString() })),
    users: userRows.map((row) => ({ username: row.username, createdAt: row.createdAt.toISOString() })),
  };
}
