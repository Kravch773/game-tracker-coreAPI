import { PRICE_REGIONS, PRICE_STORES, type PriceRegion } from "@gametracker/shared";
import { eq, gt } from "drizzle-orm";
import { db } from "../db/client.js";
import { listEntries, priceSweeps, priceWatch, steamWishes } from "../db/schema.js";
import { batchSize, checkedTimes, fillStoreLinks, jobsFor, sweepJobs, targetsFor, type Target } from "./service.js";

// Steam turns its daily and weekly sales on at 10:00 Pacific: 17:00 UTC in summer, 18:00 in winter.
const SWEEP_AT_MINUTE = 18 * 60 + 15;
const CHECK_EVERY_MS = 10 * 60 * 1000;
const WATCH_DAYS = 30;
// A store that keeps asking to slow down is left for tomorrow after this many tries on one batch or page.
const TRIES = 4;

type Log = { info: (message: string) => void; warn: (obj: object, message: string) => void };

let running = false;

// Once a day, every game someone keeps in Want to play or their Steam wishlist, or opened lately, gets its prices
// checked in both regions, slowly enough to leave the stores' limits to visitors. The day's row lets a restart
// pick the sweep up where it stopped instead of running it twice.
export function startPriceSweeps(log: Log): void {
  const tick = () => {
    void maybeSweep(log).catch((error: unknown) => log.warn({ err: error }, "price sweep failed"));
  };
  setTimeout(tick, 60_000).unref();
  setInterval(tick, CHECK_EVERY_MS).unref();
}

async function maybeSweep(log: Log): Promise<void> {
  if (running) return;
  const now = new Date();
  const due = now.getUTCHours() * 60 + now.getUTCMinutes() >= SWEEP_AT_MINUTE ? now : new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const day = due.toISOString().slice(0, 10);
  const rows = await db.select().from(priceSweeps).where(eq(priceSweeps.day, day)).limit(1);
  if (rows[0]?.finishedAt) return;

  running = true;
  try {
    const startedAt = rows[0]?.startedAt ?? now;
    if (!rows[0]) await db.insert(priceSweeps).values({ day, startedAt }).onConflictDoNothing();
    log.info(`price sweep for ${day} ${rows[0] ? "resumed" : "started"}`);
    const games = await sweep(startedAt);
    await db.update(priceSweeps).set({ finishedAt: new Date(), games }).where(eq(priceSweeps.day, day));
    log.info(`price sweep for ${day} finished: ${games} games`);
  } finally {
    running = false;
  }
}

async function sweep(startedAt: Date): Promise<number> {
  const since = new Date(Date.now() - WATCH_DAYS * 24 * 60 * 60 * 1000);
  const [backlog, wished, watched] = await Promise.all([
    db.selectDistinct({ gameId: listEntries.gameId }).from(listEntries).where(eq(listEntries.status, "backlog")),
    db.selectDistinct({ gameId: steamWishes.gameId }).from(steamWishes),
    db.select({ gameId: priceWatch.gameId }).from(priceWatch).where(gt(priceWatch.viewedAt, since)),
  ]);
  const gameIds = [...new Set([...backlog, ...wished, ...watched].map((row) => row.gameId))];

  const targets: Target[] = [];
  for (let index = 0; index < gameIds.length; index += 500) targets.push(...(await targetsFor(gameIds.slice(index, index + 500))));
  for (let index = 0; index < targets.length; index += 200) await fillStoreLinks(targets.slice(index, index + 200));

  for (const region of PRICE_REGIONS) await sweepRegion(targets, region, startedAt.getTime());
  return targets.length;
}

// Prices a visitor already refreshed after the sweep started are skipped, which is also how a resumed sweep
// knows what is left.
async function sweepRegion(targets: Target[], region: PriceRegion, startedAt: number): Promise<void> {
  const checked = await checkedTimes(targets.map((target) => target.gameId), region);
  const jobs = jobsFor(targets, region, (gameId, store) => (checked.get(`${gameId}|${store}`) ?? 0) < startedAt);

  // The stores keep their own pace, so they are swept side by side.
  await Promise.all(
    PRICE_STORES.map(async (store) => {
      const mine = jobs.filter((job) => job.store === store);
      const size = batchSize(store);
      for (let index = 0; index < mine.length; index += size) {
        const chunk = mine.slice(index, index + size);
        for (let attempt = 0; attempt < TRIES; attempt += 1) {
          if (await sweepJobs(store, chunk, region)) break;
        }
      }
    }),
  );
}
