import {
  DEAL_MIN_CUTS,
  PRICE_REGIONS,
  PRICE_STORES,
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
import { loose, searchForm } from "../games/text.js";
import { GOG_BATCH, STEAM_BATCH, XBOX_BATCH, gogOffers, playstationOffer, psStoreUrl, steamOffers, steamStoreUrl, xboxOffers, xboxSearch, xboxStoreUrl, type Offer } from "./fetch.js";
import { StoreBusyError, StoreLimitError, gogGate, playstationGate, sleep, steamGate, xboxGate, type StoreGate } from "./gate.js";

// The daily sweep keeps prices fresh; a visitor's request only refreshes a price the sweep has not touched for a day.
const FRESH_MS = 24 * 60 * 60 * 1000;
// A visitor waits this long at most for fresh prices; anything slower finishes in the background.
const VISITOR_WAIT_MS = 6_000;
// How long a visitor's request may wait for its turn at a store before it settles for the stored price.
const TURN_WAIT_MS = 1_500;
// PlayStation pages are fetched one by one; a request fetches a few and leaves the rest to the background queue.
const PAGES_INLINE = 3;
const STORE_LINK_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
const LOWEST_AFTER_MS = 14 * 24 * 60 * 60 * 1000;

const REGION_CURRENCY: Record<PriceRegion, string> = { ua: "UAH", us: "USD" };

export class PriceInputError extends Error {}

// The better deal of two stores: the region's own currency first, then the lower price.
function cheaper(row: PriceRow, than: PriceRow, region: PriceRegion): boolean {
  const local = (price: PriceRow) => price.currency === REGION_CURRENCY[region];
  if (local(row) !== local(than)) return local(row);
  return (row.amount ?? Infinity) < (than.amount ?? Infinity);
}

export type Target = {
  gameId: string;
  igdbId: number;
  title: string;
  platforms: string[];
  stores: Partial<Record<PriceStore, { id: string; url: string }>>;
};
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
  await withinVisitorWait(fillStoreLinks(targets).then(() => refresh(targets, region)));
  const target = targets[0];

  const prices = await db
    .select()
    .from(gamePrices)
    .where(and(eq(gamePrices.gameId, game.id), eq(gamePrices.region, region)));
  const stores = prices.flatMap((row) => {
    const price = toStorePrice(row);
    return price ? [price] : [];
  });
  stores.sort((a, b) => PRICE_STORES.indexOf(a.store) - PRICE_STORES.indexOf(b.store));

  const history = await db
    .select()
    .from(priceHistory)
    .where(and(eq(priceHistory.gameId, game.id), eq(priceHistory.region, region)));
  // Stores price a region in different currencies (GOG Ukraine in dollars), so only the region's own currency is
  // compared, unless no store uses it.
  const local = history.filter((row) => row.currency === REGION_CURRENCY[region]);
  const lowestRow = (local.length > 0 ? local : history).reduce<(typeof history)[number] | null>(
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
    steamAppId: target?.stores.steam?.id ?? null,
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
  await withinVisitorWait(fillStoreLinks(targets).then(() => refresh(targets, region)));

  const prices = await db
    .select()
    .from(gamePrices)
    .where(and(inArray(gamePrices.gameId, gameIds), eq(gamePrices.region, region)));
  const best = new Map<string, PriceRow>();
  for (const row of prices) {
    if (row.amount == null || row.cut < Math.max(1, settings.minCut)) continue;
    const current = best.get(row.gameId);
    if (!current || cheaper(row, current, region)) best.set(row.gameId, row);
  }
  if (best.size === 0) return { region, deals: [], newCount: 0, settings };

  const ids = [...best.keys()];
  const [gameRows, lows] = await Promise.all([
    db.select().from(games).where(inArray(games.id, ids)),
    db
      .select({ gameId: priceHistory.gameId, currency: priceHistory.currency, amount: min(priceHistory.amount), since: min(priceHistory.seenOn) })
      .from(priceHistory)
      .where(and(inArray(priceHistory.gameId, ids), eq(priceHistory.region, region)))
      .groupBy(priceHistory.gameId, priceHistory.currency),
  ]);
  // "Lowest" means something only once the history is long enough to have seen other prices.
  const trackedBefore = new Date(Date.now() - LOWEST_AFTER_MS).toISOString().slice(0, 10);
  const lowOf = new Map(
    lows.flatMap((row) => (row.since && row.since <= trackedBefore ? [[`${row.gameId}|${row.currency}`, row.amount] as const] : [])),
  );
  const seenAt = settingsRow?.dealsSeenAt ?? null;

  const deals: Deal[] = gameRows.flatMap((game) => {
    const row = best.get(game.id);
    const price = row ? toStorePrice(row) : null;
    if (!row || !price) return [];
    const low = lowOf.get(`${game.id}|${price.currency}`);
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
    db
      .select({ id: games.id, igdbId: games.igdbId, title: games.title, platforms: games.platforms })
      .from(games)
      .where(inArray(games.id, gameIds)),
    db
      .select({ gameId: gameLinks.gameId, kind: gameLinks.kind, externalId: gameLinks.externalId, url: gameLinks.url })
      .from(gameLinks)
      .where(and(inArray(gameLinks.gameId, gameIds), inArray(gameLinks.kind, [...PRICE_STORES]))),
  ]);
  return rows.map((row) => {
    const stores: Target["stores"] = {};
    for (const link of links) {
      if (link.gameId === row.id && link.externalId) stores[link.kind as PriceStore] = { id: link.externalId, url: link.url };
    }
    return { gameId: row.id, igdbId: row.igdbId, title: row.title, platforms: row.platforms, stores };
  });
}

// Store ids normally arrive with a game's details; games nobody has opened yet get theirs from IGDB in one batch.
const LOOKED_UP: PriceStore[] = ["playstation", "xbox", "gog"];
const storeLinksChecked = new Map<string, number>();

export async function fillStoreLinks(targets: Target[]): Promise<void> {
  if (!igdbConfigured()) return;
  const now = Date.now();
  const missing = targets.filter(
    (target) =>
      LOOKED_UP.some((store) => !target.stores[store]) && now - (storeLinksChecked.get(target.gameId) ?? 0) > STORE_LINK_RECHECK_MS,
  );
  if (missing.length === 0) return;
  for (const target of missing) storeLinksChecked.set(target.gameId, now);
  try {
    const found = await storeExternalsFor(missing.map((target) => target.igdbId));
    for (const target of missing) {
      const links = mapStoreLinks({ external_games: found.get(target.igdbId) ?? [] }).filter(
        (link) => link.externalId && !target.stores[link.kind as PriceStore],
      );
      if (links.length === 0) continue;
      // A GOG website link without a product id takes the id; links set by hand stay as they are.
      await db
        .insert(gameLinks)
        .values(links.map((link) => ({ ...link, gameId: target.gameId })))
        .onConflictDoUpdate({
          target: [gameLinks.gameId, gameLinks.kind],
          set: { url: sql`excluded.url`, externalId: sql`excluded.external_id` },
          setWhere: sql`${gameLinks.externalId} IS NULL AND ${gameLinks.source} = 'igdb'`,
        });
      for (const link of links) target.stores[link.kind as PriceStore] = { id: link.externalId as string, url: link.url };
    }
  } catch (error) {
    console.error("Store link lookup failed", error);
  }
  await findXboxPages(missing);
}

// IGDB lists the Xbox among a game's platforms well before it adds the store page, so the Microsoft catalog is
// asked for a game of exactly that title; editions, demos and add-ons have titles of their own and are left out.
const XBOX_SEARCHES_PER_CALL = 20;

async function findXboxPages(targets: Target[]): Promise<void> {
  const wanted = targets.filter((target) => !target.stores.xbox && target.platforms.some((name) => /xbox/i.test(name)));
  for (const [index, target] of wanted.entries()) {
    // The rest wait for the next call instead of keeping this one busy.
    if (index >= XBOX_SEARCHES_PER_CALL) {
      storeLinksChecked.delete(target.gameId);
      continue;
    }
    try {
      const match = (await xboxSearch(target.title)).find((product) => sameTitle(product.title, target.title));
      if (!match) continue;
      const link = { kind: "xbox" as const, url: xboxStoreUrl(match.id, match.title), externalId: match.id, source: "igdb" as const };
      await db
        .insert(gameLinks)
        .values({ ...link, gameId: target.gameId })
        .onConflictDoNothing({ target: [gameLinks.gameId, gameLinks.kind] });
      target.stores.xbox = { id: match.id, url: link.url };
    } catch (error) {
      console.error(`Xbox Store search for ${target.title} failed`, error);
      if (error instanceof StoreLimitError) return;
    }
  }
}

function sameTitle(a: string, b: string): boolean {
  return loose(searchForm(a)) === loose(searchForm(b));
}

// Steam, GOG and the Xbox Store answer for many games in one request; the PlayStation Store one page at a time.
type BatchStore = "steam" | "gog" | "xbox";
const BATCH: Record<BatchStore, number> = { steam: STEAM_BATCH, gog: GOG_BATCH, xbox: XBOX_BATCH };
const GATES: Record<PriceStore, StoreGate> = { steam: steamGate, xbox: xboxGate, playstation: playstationGate, gog: gogGate };
const STORE_NAMES: Record<PriceStore, string> = { steam: "Steam", xbox: "Xbox Store", playstation: "PlayStation Store", gog: "GOG" };

function isBatchStore(store: PriceStore): store is BatchStore {
  return store !== "playstation";
}

export function batchSize(store: PriceStore): number {
  return isBatchStore(store) ? BATCH[store] : 1;
}

export type QueueJob = { store: PriceStore; gameId: string; externalId: string; url: string; region: PriceRegion };

export function jobsFor(targets: Target[], region: PriceRegion, wanted: (gameId: string, store: PriceStore) => boolean): QueueJob[] {
  return targets.flatMap((target) =>
    PRICE_STORES.flatMap((store) => {
      const link = target.stores[store];
      return link && wanted(target.gameId, store)
        ? [{ store, gameId: target.gameId, externalId: link.id, url: link.url, region }]
        : [];
    }),
  );
}

// A visitor's refresh: stale prices are fetched ahead of the sweep, but never kept waiting. A store that is parked
// after a 429, or whose turn is far off, is left to the background queue and the stored price is shown meanwhile.
async function refresh(targets: Target[], region: PriceRegion): Promise<void> {
  if (targets.length === 0) return;
  const checked = await checkedTimes(targets.map((target) => target.gameId), region);
  const jobs = jobsFor(targets, region, (gameId, store) => Date.now() - (checked.get(`${gameId}|${store}`) ?? 0) > FRESH_MS);

  await Promise.all(
    PRICE_STORES.map(async (store) => {
      const mine = jobs.filter((job) => job.store === store);
      const size = batchSize(store);
      for (let index = 0; index < mine.length; index += size) {
        const chunk = mine.slice(index, index + size);
        const inline = isBatchStore(store) || index < PAGES_INLINE;
        const done = inline && (await urgentTurn(GATES[store])) && (await runJobs(store, chunk, region));
        if (!done) chunk.forEach(queueRefresh);
      }
    }),
  );
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

// One turn at a store: a batch of games at Steam, GOG or the Xbox Store, one game's page at PlayStation.
// Returns false when the store asked to slow down, so the jobs can be tried again later.
export async function runJobs(store: PriceStore, jobs: QueueJob[], region: PriceRegion): Promise<boolean> {
  if (jobs.length === 0) return true;
  try {
    if (isBatchStore(store)) {
      const ids = jobs.map((job) => job.externalId);
      const offers = await (store === "steam" ? steamOffers : store === "gog" ? gogOffers : xboxOffers)(ids, region);
      for (const job of jobs) {
        if (!offers.has(job.externalId)) continue;
        await save(job.gameId, store, region, offers.get(job.externalId) ?? null, store === "steam" ? steamStoreUrl(job.externalId) : job.url);
      }
      return true;
    }
    const job = jobs[0];
    await save(job.gameId, store, region, await playstationOffer(job.externalId, region), psStoreUrl(job.externalId, region));
    return true;
  } catch (error) {
    if (error instanceof StoreLimitError) {
      GATES[store].backOff(error.retryAfter);
      console.warn(`${STORE_NAMES[store]} asked to slow down (${error.status})`);
      return false;
    }
    console.error(`${STORE_NAMES[store]} prices for ${jobs.map((job) => job.externalId).join(" ")} failed`, error);
    return true;
  }
}

// The sweep's turn at a store: it waits for the store's slow pace first.
export async function sweepJobs(store: PriceStore, jobs: QueueJob[], region: PriceRegion): Promise<boolean> {
  await GATES[store].sweep();
  return runJobs(store, jobs, region);
}

// What a visitor's request could not fetch in time, done at the sweep's pace; each store drains on its own.
const queue = new Map<string, QueueJob>();
const draining = new Set<PriceStore>();

function queueRefresh(job: QueueJob): void {
  queue.set(`${job.store}|${job.gameId}|${job.region}`, job);
  const store = job.store;
  if (draining.has(store)) return;
  draining.add(store);
  void (async () => {
    try {
      for (;;) {
        const waiting = [...queue.values()].filter((item) => item.store === store);
        if (waiting.length === 0) break;
        const region = waiting[0].region;
        const batch = waiting.filter((item) => item.region === region).slice(0, batchSize(store));
        if (await sweepJobs(store, batch, region)) for (const item of batch) queue.delete(`${store}|${item.gameId}|${region}`);
      }
    } finally {
      draining.delete(store);
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
