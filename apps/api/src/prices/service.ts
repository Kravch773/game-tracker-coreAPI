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
import { gameLinks, gamePrices, games, listEntries, priceHistory, priceWatch, steamWishes, users } from "../db/schema.js";
import { igdbConfigured } from "../env.js";
import { storeExternalsFor } from "../igdb/client.js";
import { mapStoreLinks } from "../igdb/map.js";
import { toSummary } from "../games/present.js";
import { STEAM_BATCH, playstationOffer, psStoreUrl, steamOffers, steamStoreUrl, type Offer } from "./fetch.js";
import { StoreBusyError, StoreLimitError, playstationGate, sleep, steamGate, type StoreGate } from "./gate.js";

// The daily sweep keeps prices fresh; a visitor's request only refreshes a price the sweep has not touched for a day.
const FRESH_MS = 24 * 60 * 60 * 1000;
// A visitor waits this long at most for fresh prices; anything slower finishes in the background.
const VISITOR_WAIT_MS = 6_000;
// How long a visitor's request may wait for its turn at a store before it settles for the stored price.
const TURN_WAIT_MS = 1_500;
// PlayStation pages are fetched one by one; a request fetches a few and leaves the rest to the background queue.
const PS_INLINE = 3;
const PS_LINK_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const LOWEST_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

export class PriceInputError extends Error {}

export type Target = { gameId: string; igdbId: number; steamAppId: string | null; psConceptId: string | null };
type PriceRow = typeof gamePrices.$inferSelect;

export function parseRegion(value: unknown): PriceRegion {
  return (PRICE_REGIONS as readonly unknown[]).includes(value) ? (value as PriceRegion) : "ua";
}

export async function pricesForGame(slug: string, region: PriceRegion): Promise<GamePrices | null> {
  const rows = await db.select({ id: games.id }).from(games).where(eq(games.slug, slug)).limit(1);
  const game = rows[0];
  if (!game) return null;
  const targets = await targetsFor([game.id]);
  await db
    .insert(priceWatch)
    .values({ gameId: game.id, viewedAt: new Date() })
    .onConflictDoUpdate({ target: priceWatch.gameId, set: { viewedAt: new Date() } });
  await withinVisitorWait(fillPlaystationLinks(targets).then(() => refresh(targets, region)));
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
  await withinVisitorWait(fillPlaystationLinks(targets).then(() => refresh(targets, region)));

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

export async function targetsFor(gameIds: string[]): Promise<Target[]> {
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

export async function fillPlaystationLinks(targets: Target[]): Promise<void> {
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

// A visitor's refresh: stale prices are fetched ahead of the sweep, but never kept waiting. A store that is parked
// after a 429, or whose turn is far off, is left to the background queue and the stored price is shown meanwhile.
async function refresh(targets: Target[], region: PriceRegion): Promise<void> {
  if (targets.length === 0) return;
  const checked = await checkedTimes(targets.map((target) => target.gameId), region);
  const stale = (gameId: string, store: PriceStore) => Date.now() - (checked.get(`${gameId}|${store}`) ?? 0) > FRESH_MS;

  const steam = targets.filter((target) => target.steamAppId && stale(target.gameId, "steam"));
  for (let index = 0; index < steam.length; index += STEAM_BATCH) {
    const chunk = steam.slice(index, index + STEAM_BATCH);
    if (!(await urgentTurn(steamGate)) || !(await refreshSteam(chunk, region, steamGate))) {
      for (const target of chunk) queueRefresh({ store: "steam", gameId: target.gameId, externalId: target.steamAppId as string, region });
    }
  }

  const playstation = targets.filter((target) => target.psConceptId && stale(target.gameId, "playstation"));
  for (const [index, target] of playstation.entries()) {
    const job: QueueJob = { store: "playstation", gameId: target.gameId, externalId: target.psConceptId as string, region };
    const done = index < PS_INLINE && (await urgentTurn(playstationGate)) && (await refreshPlaystation(job, playstationGate));
    if (!done) queueRefresh(job);
  }
}

async function urgentTurn(gate: StoreGate): Promise<boolean> {
  try {
    await gate.urgent(TURN_WAIT_MS);
    return true;
  } catch (error) {
    if (error instanceof StoreBusyError) return false;
    throw error;
  }
}

function withinVisitorWait(work: Promise<void>): Promise<void> {
  return Promise.race([work.catch((error: unknown) => console.error("Price refresh failed", error)), sleep(VISITOR_WAIT_MS)]);
}

export async function checkedTimes(gameIds: string[], region: PriceRegion): Promise<Map<string, number>> {
  const checked = new Map<string, number>();
  for (let index = 0; index < gameIds.length; index += 1000) {
    const rows = await db
      .select({ gameId: gamePrices.gameId, store: gamePrices.store, checkedAt: gamePrices.checkedAt })
      .from(gamePrices)
      .where(and(inArray(gamePrices.gameId, gameIds.slice(index, index + 1000)), eq(gamePrices.region, region)));
    for (const row of rows) checked.set(`${row.gameId}|${row.store}`, row.checkedAt.getTime());
  }
  return checked;
}

// One Steam request for up to STEAM_BATCH games. Returns false when the store asked to slow down.
export async function refreshSteam(targets: Target[], region: PriceRegion, gate: StoreGate): Promise<boolean> {
  try {
    const offers = await steamOffers(targets.map((target) => target.steamAppId as string), region);
    for (const target of targets) {
      const appId = target.steamAppId as string;
      if (offers.has(appId)) await save(target.gameId, "steam", region, offers.get(appId) ?? null, steamStoreUrl(appId));
    }
    return true;
  } catch (error) {
    if (error instanceof StoreLimitError) {
      gate.backOff(error.retryAfter);
      console.warn(`Steam asked to slow down (${error.status})`);
      return false;
    }
    console.error("Steam prices failed", error);
    return true;
  }
}

export async function refreshPlaystation(job: QueueJob, gate: StoreGate): Promise<boolean> {
  try {
    await save(job.gameId, "playstation", job.region, await playstationOffer(job.externalId, job.region), psStoreUrl(job.externalId, job.region));
    return true;
  } catch (error) {
    if (error instanceof StoreLimitError) {
      gate.backOff(error.retryAfter);
      console.warn(`PlayStation Store asked to slow down (${error.status})`);
      return false;
    }
    console.error(`PlayStation price for ${job.externalId} failed`, error);
    return true;
  }
}

export type QueueJob = { store: PriceStore; gameId: string; externalId: string; region: PriceRegion };

// What a visitor's request could not fetch in time, done at the sweep's pace.
const queue = new Map<string, QueueJob>();
let draining = false;

function queueRefresh(job: QueueJob): void {
  queue.set(`${job.store}|${job.gameId}|${job.region}`, job);
  if (draining) return;
  draining = true;
  void (async () => {
    try {
      while (queue.size > 0) {
        const steam = [...queue.values()].filter((item) => item.store === "steam").slice(0, STEAM_BATCH);
        if (steam.length > 0) {
          const region = steam[0].region;
          const batch = steam.filter((item) => item.region === region);
          await steamGate.sweep();
          const done = await refreshSteam(
            batch.map((item) => ({ gameId: item.gameId, igdbId: 0, steamAppId: item.externalId, psConceptId: null })),
            region,
            steamGate,
          );
          if (done) for (const item of batch) queue.delete(`steam|${item.gameId}|${region}`);
          continue;
        }
        const [key, job] = [...queue.entries()][0];
        await playstationGate.sweep();
        if (await refreshPlaystation(job, playstationGate)) queue.delete(key);
      }
    } finally {
      draining = false;
    }
  })();
}

// The sale keeps the moment it started while it lasts, so the bell can tell new sales from ones already seen.
export async function save(gameId: string, store: PriceStore, region: PriceRegion, offer: Offer | null, url: string): Promise<void> {
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
