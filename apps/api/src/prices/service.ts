import {
  DEAL_MIN_CUTS,
  PRICE_REGIONS,
  t,
  type Deal,
  type DealSettings,
  type DealsResponse,
  type GamePrices,
  type PriceRegion,
  type PriceStore,
  type StorePrice,
} from "@gametracker/shared";
import { and, eq, inArray, min, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { gameLinks, gamePrices, games, listEntries, priceHistory, steamWishes, users } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { storeExternalsFor } from "../igdb/client.js";
import { mapStoreLinks } from "../igdb/map.js";
import { toSummary } from "../games/present.js";
import { playstationOffer, psStoreUrl, steamOffers, steamStoreUrl, type Offer } from "./fetch.js";

const FRESH_MS = 6 * 60 * 60 * 1000;
// PlayStation pages are fetched one by one; a request waits for a few and leaves the rest to the background queue.
const PS_INLINE = 3;
const PS_GAP_MS = 1200;
const PS_LINK_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const LOWEST_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export class PriceInputError extends Error {}

type Target = { gameId: string; igdbId: number; steamAppId: string | null; psConceptId: string | null };
type PriceRow = typeof gamePrices.$inferSelect;

export function parseRegion(value: unknown): PriceRegion {
  return (PRICE_REGIONS as readonly unknown[]).includes(value) ? (value as PriceRegion) : "ua";
}

export async function pricesForGame(slug: string, region: PriceRegion): Promise<GamePrices | null> {
  const rows = await db.select({ id: games.id }).from(games).where(eq(games.slug, slug)).limit(1);
  const game = rows[0];
  if (!game) return null;
  const targets = await targetsFor([game.id]);
  await fillPlaystationLinks(targets);
  await refresh(targets, region);
  const target = targets[0];

  const prices = await db
    .select()
    .from(gamePrices)
    .where(and(eq(gamePrices.gameId, game.id), eq(gamePrices.region, region)));
  const stores = prices.flatMap((row) => {
    const price = toStorePrice(row);
    return price ? [price] : [];
  });
  stores.sort((a, b) => (a.store === "steam" ? -1 : 1) - (b.store === "steam" ? -1 : 1));

  const history = await db
    .select()
    .from(priceHistory)
    .where(and(eq(priceHistory.gameId, game.id), eq(priceHistory.region, region)));
  const lowestRow = history.reduce<(typeof history)[number] | null>(
    (best, row) => (!best || row.amount < best.amount || (row.amount === best.amount && row.seenOn > best.seenOn) ? row : best),
    null,
  );
  const since = history.reduce<string | null>((first, row) => (!first || row.seenOn < first ? row.seenOn : first), null);

  return {
    region,
    stores,
    lowest: lowestRow
      ? { store: lowestRow.store as PriceStore, currency: lowestRow.currency, amount: lowestRow.amount, seenOn: lowestRow.seenOn }
      : null,
    trackedSince: since,
    steamAppId: target?.steamAppId ?? null,
  };
}

export async function dealsForUser(userId: string, region: PriceRegion): Promise<DealsResponse> {
  const settingsRow = await userDealRow(userId);
  const settings = toSettings(settingsRow);

  const backlog = await db
    .select({ gameId: listEntries.gameId })
    .from(listEntries)
    .where(and(eq(listEntries.userId, userId), eq(listEntries.status, "backlog")));
  const wished = settings.wishlist
    ? await db.select({ gameId: steamWishes.gameId }).from(steamWishes).where(eq(steamWishes.userId, userId))
    : [];
  const gameIds = [...new Set([...backlog, ...wished].map((row) => row.gameId))];
  if (gameIds.length === 0) return { region, deals: [], newCount: 0, settings };

  const targets = await targetsFor(gameIds);
  await fillPlaystationLinks(targets);
  await refresh(targets, region);

  const prices = await db
    .select()
    .from(gamePrices)
    .where(and(inArray(gamePrices.gameId, gameIds), eq(gamePrices.region, region)));
  const best = new Map<string, PriceRow>();
  for (const row of prices) {
    if (row.amount == null || row.cut < Math.max(1, settings.minCut)) continue;
    const current = best.get(row.gameId);
    if (!current || (current.amount ?? Infinity) > row.amount) best.set(row.gameId, row);
  }
  if (best.size === 0) return { region, deals: [], newCount: 0, settings };

  const ids = [...best.keys()];
  const [gameRows, lows] = await Promise.all([
    db.select().from(games).where(inArray(games.id, ids)),
    db
      .select({ gameId: priceHistory.gameId, amount: min(priceHistory.amount), since: min(priceHistory.seenOn) })
      .from(priceHistory)
      .where(and(inArray(priceHistory.gameId, ids), eq(priceHistory.region, region)))
      .groupBy(priceHistory.gameId),
  ]);
  // "Lowest" means something only once the history is long enough to have seen other prices.
  const trackedBefore = new Date(Date.now() - LOWEST_AFTER_MS).toISOString().slice(0, 10);
  const lowOf = new Map(lows.flatMap((row) => (row.since && row.since <= trackedBefore ? [[row.gameId, row.amount] as const] : [])));
  const seenAt = settingsRow?.dealsSeenAt ?? null;

  const deals: Deal[] = gameRows.flatMap((game) => {
    const row = best.get(game.id);
    const price = row ? toStorePrice(row) : null;
    if (!row || !price) return [];
    const low = lowOf.get(game.id);
    return [
      {
        game: toSummary(game),
        price,
        lowest: low != null && price.amount <= low,
        fresh: !seenAt || (row.saleSince != null && row.saleSince > seenAt),
      },
    ];
  });
  deals.sort((a, b) => Number(b.fresh) - Number(a.fresh) || b.price.cut - a.price.cut);
  return { region, deals, newCount: settings.alerts ? deals.filter((deal) => deal.fresh).length : 0, settings };
}

export async function markDealsSeen(userId: string): Promise<void> {
  await db.update(users).set({ dealsSeenAt: new Date() }).where(eq(users.id, userId));
}

export async function saveDealSettings(userId: string, body: unknown): Promise<DealSettings> {
  const record = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const patch: Partial<typeof users.$inferInsert> = {};
  if (record.alerts !== undefined) {
    if (typeof record.alerts !== "boolean") throw new PriceInputError(t("api.badPayload"));
    patch.dealAlerts = record.alerts;
  }
  if (record.wishlist !== undefined) {
    if (typeof record.wishlist !== "boolean") throw new PriceInputError(t("api.badPayload"));
    patch.dealWishlist = record.wishlist;
  }
  if (record.minCut !== undefined) {
    if (!(DEAL_MIN_CUTS as readonly unknown[]).includes(record.minCut)) throw new PriceInputError(t("api.badPayload"));
    patch.dealMinCut = record.minCut as number;
  }
  if (Object.keys(patch).length > 0) await db.update(users).set(patch).where(eq(users.id, userId));
  return toSettings(await userDealRow(userId));
}

export async function dealSettingsFor(userId: string): Promise<DealSettings> {
  return toSettings(await userDealRow(userId));
}

async function userDealRow(userId: string) {
  const rows = await db
    .select({ alerts: users.dealAlerts, minCut: users.dealMinCut, wishlist: users.dealWishlist, dealsSeenAt: users.dealsSeenAt })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return rows[0] ?? null;
}

function toSettings(row: { alerts: boolean; minCut: number; wishlist: boolean } | null): DealSettings {
  return { alerts: row?.alerts ?? true, minCut: row?.minCut ?? 10, wishlist: row?.wishlist ?? true };
}

function toStorePrice(row: PriceRow): StorePrice | null {
  if (row.amount == null || row.base == null || !row.currency || !row.url) return null;
  return {
    store: row.store as PriceStore,
    currency: row.currency,
    amount: row.amount,
    base: row.base,
    cut: row.cut,
    endsAt: row.endsAt ? row.endsAt.toISOString() : null,
    url: row.url,
  };
}

async function targetsFor(gameIds: string[]): Promise<Target[]> {
  if (gameIds.length === 0) return [];
  const [rows, links] = await Promise.all([
    db.select({ id: games.id, igdbId: games.igdbId }).from(games).where(inArray(games.id, gameIds)),
    db
      .select({ gameId: gameLinks.gameId, kind: gameLinks.kind, externalId: gameLinks.externalId })
      .from(gameLinks)
      .where(and(inArray(gameLinks.gameId, gameIds), inArray(gameLinks.kind, ["steam", "playstation"]))),
  ]);
  return rows.map((row) => ({
    gameId: row.id,
    igdbId: row.igdbId,
    steamAppId: links.find((link) => link.gameId === row.id && link.kind === "steam")?.externalId ?? null,
    psConceptId: links.find((link) => link.gameId === row.id && link.kind === "playstation")?.externalId ?? null,
  }));
}

// Store links normally arrive with a game's details; games nobody has opened yet get theirs from IGDB in one batch.
const psLinkChecked = new Map<string, number>();

async function fillPlaystationLinks(targets: Target[]): Promise<void> {
  if (!igdbConfigured()) return;
  const now = Date.now();
  const missing = targets.filter((target) => !target.psConceptId && now - (psLinkChecked.get(target.gameId) ?? 0) > PS_LINK_RECHECK_MS);
  if (missing.length === 0) return;
  for (const target of missing) psLinkChecked.set(target.gameId, now);
  try {
    const found = await storeExternalsFor(missing.map((target) => target.igdbId));
    for (const target of missing) {
      const links = mapStoreLinks({ external_games: found.get(target.igdbId) ?? [] });
      if (links.length === 0) continue;
      await db
        .insert(gameLinks)
        .values(links.map((link) => ({ ...link, gameId: target.gameId })))
        .onConflictDoNothing({ target: [gameLinks.gameId, gameLinks.kind] });
      target.psConceptId = links.find((link) => link.kind === "playstation")?.externalId ?? target.psConceptId;
    }
  } catch (error) {
    console.error("PlayStation link lookup failed", error);
  }
}

async function refresh(targets: Target[], region: PriceRegion): Promise<void> {
  if (targets.length === 0) return;
  const rows = await db
    .select({ gameId: gamePrices.gameId, store: gamePrices.store, checkedAt: gamePrices.checkedAt })
    .from(gamePrices)
    .where(and(inArray(gamePrices.gameId, targets.map((target) => target.gameId)), eq(gamePrices.region, region)));
  const checked = new Map(rows.map((row) => [`${row.gameId}|${row.store}`, row.checkedAt.getTime()]));
  const stale = (gameId: string, store: PriceStore) => Date.now() - (checked.get(`${gameId}|${store}`) ?? 0) > FRESH_MS;

  const steam = targets.filter((target) => target.steamAppId && stale(target.gameId, "steam"));
  if (steam.length > 0) {
    try {
      const offers = await steamOffers(steam.map((target) => target.steamAppId as string), region);
      for (const target of steam) {
        const appId = target.steamAppId as string;
        if (!offers.has(appId)) continue;
        await save(target.gameId, "steam", region, offers.get(appId) ?? null, steamStoreUrl(appId));
      }
    } catch (error) {
      console.error("Steam prices failed", error);
    }
  }

  const playstation = targets.filter((target) => target.psConceptId && stale(target.gameId, "playstation"));
  for (const [index, target] of playstation.entries()) {
    if (index < PS_INLINE) await refreshPlaystation(target.gameId, target.psConceptId as string, region);
    else queuePlaystation(target.gameId, target.psConceptId as string, region);
  }
}

async function refreshPlaystation(gameId: string, conceptId: string, region: PriceRegion): Promise<void> {
  try {
    await save(gameId, "playstation", region, await playstationOffer(conceptId, region), psStoreUrl(conceptId, region));
  } catch (error) {
    console.error(`PlayStation price for ${conceptId} failed`, error);
  }
}

const psQueue = new Map<string, { gameId: string; conceptId: string; region: PriceRegion }>();
let psDraining = false;

function queuePlaystation(gameId: string, conceptId: string, region: PriceRegion): void {
  psQueue.set(`${gameId}|${region}`, { gameId, conceptId, region });
  if (psDraining) return;
  psDraining = true;
  void (async () => {
    try {
      for (const [key, job] of psQueue) {
        psQueue.delete(key);
        await refreshPlaystation(job.gameId, job.conceptId, job.region);
        await new Promise((resolve) => setTimeout(resolve, PS_GAP_MS));
      }
    } finally {
      psDraining = false;
    }
  })();
}

// The sale keeps the moment it started while it lasts, so the bell can tell new sales from ones already seen.
async function save(gameId: string, store: PriceStore, region: PriceRegion, offer: Offer | null, url: string): Promise<void> {
  const now = new Date();
  const previous = await db
    .select({ cut: gamePrices.cut, saleSince: gamePrices.saleSince })
    .from(gamePrices)
    .where(and(eq(gamePrices.gameId, gameId), eq(gamePrices.store, store), eq(gamePrices.region, region)))
    .limit(1);
  const before = previous[0];
  const saleSince = offer && offer.cut > 0 ? (before && before.cut > 0 && before.saleSince ? before.saleSince : now) : null;
  const values = {
    currency: offer?.currency ?? null,
    amount: offer?.amount ?? null,
    base: offer?.base ?? null,
    cut: offer?.cut ?? 0,
    endsAt: offer?.endsAt ?? null,
    saleSince,
    url,
    checkedAt: now,
  };
  await db
    .insert(gamePrices)
    .values({ gameId, store, region, ...values })
    .onConflictDoUpdate({ target: [gamePrices.gameId, gamePrices.store, gamePrices.region], set: values });
  if (!offer) return;
  await db
    .insert(priceHistory)
    .values({ gameId, store, region, currency: offer.currency, amount: offer.amount, base: offer.base, seenOn: now.toISOString().slice(0, 10) })
    .onConflictDoUpdate({
      target: [priceHistory.gameId, priceHistory.store, priceHistory.region, priceHistory.seenOn],
      set: { amount: sql`LEAST(${priceHistory.amount}, excluded.amount)`, base: sql`excluded.base` },
    });
}
