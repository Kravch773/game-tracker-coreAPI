import type { GameOrigin } from "@gametracker/shared";
import { eq, inArray } from "drizzle-orm";
import { db } from "../db/client.js";
import { curatorApps, curatorMeta } from "../db/schema.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const PAGE_SIZE = 50;
const META_ID = "steam";

const LISTS = [
  { origin: "ua", clanId: "43011665" },
  { origin: "ru", clanId: "42985013" },
] as const;

let pending: Promise<void> | null = null;

export function startCuratorRefresh(): void {
  void refreshCurators();
  const timer = setInterval(() => void refreshCurators(), 6 * 60 * 60 * 1000);
  timer.unref();
}

export async function originsFor(appIds: string[]): Promise<GameOrigin[]> {
  const ids = [...new Set(appIds.map((id) => id.trim()).filter(Boolean))];
  if (ids.length === 0) return [];
  const known = await db
    .select({ id: curatorMeta.id })
    .from(curatorMeta)
    .where(eq(curatorMeta.id, META_ID))
    .limit(1);
  if (known.length === 0) await refreshCurators();

  const rows = await db
    .select({ list: curatorApps.list })
    .from(curatorApps)
    .where(inArray(curatorApps.appId, ids));
  const found = new Set(rows.map((row) => row.list));
  const origins: GameOrigin[] = [];
  if (found.has("ua")) origins.push("ua");
  if (found.has("ru")) origins.push("ru");
  return origins;
}

export function refreshCurators(): Promise<void> {
  if (!pending) {
    pending = sync().finally(() => {
      pending = null;
    });
  }
  return pending;
}

async function sync(): Promise<void> {
  try {
    const rows = await db.select().from(curatorMeta).where(eq(curatorMeta.id, META_ID)).limit(1);
    const fetchedAt = rows[0]?.fetchedAt;
    if (fetchedAt && Date.now() - fetchedAt.getTime() < TTL_MS) return;

    const lists = await Promise.all(LISTS.map(async (list) => ({ origin: list.origin, appIds: await fetchCurator(list.clanId) })));
    const values = lists.flatMap((list) => [...list.appIds].map((appId) => ({ list: list.origin, appId })));

    await db.transaction(async (tx) => {
      await tx.delete(curatorApps);
      for (let index = 0; index < values.length; index += 400) {
        await tx.insert(curatorApps).values(values.slice(index, index + 400));
      }
      await tx
        .insert(curatorMeta)
        .values({ id: META_ID, fetchedAt: new Date() })
        .onConflictDoUpdate({ target: curatorMeta.id, set: { fetchedAt: new Date() } });
    });

    const counts = lists.map((list) => `${list.origin}=${list.appIds.size}`).join(" ");
    console.info(`Curator lists refreshed ${counts}`);
  } catch (error) {
    console.error("Curator list refresh failed", error);
  }
}

async function fetchCurator(clanId: string): Promise<Set<string>> {
  const ids = new Set<string>();
  let start = 0;
  let total = Number.POSITIVE_INFINITY;

  for (let page = 0; page < 80 && start < total; page += 1) {
    const url = new URL(`https://store.steampowered.com/curator/${clanId}/ajaxgetfilteredrecommendations/`);
    url.searchParams.set("query", "");
    url.searchParams.set("start", String(start));
    url.searchParams.set("count", String(PAGE_SIZE));
    url.searchParams.set("tagids", "");
    url.searchParams.set("sort", "recent");
    url.searchParams.set("app_types", "");
    url.searchParams.set("curations", "");
    url.searchParams.set("reset", "false");

    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        Accept: "application/json",
        Cookie: "birthtime=568022401; wants_mature_content=1; lastagecheckage=1-0-1988",
      },
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) throw new Error(`Curator ${clanId} failed with ${response.status}`);

    const payload = (await response.json()) as {
      success?: number;
      total_count?: number;
      pagesize?: string | number;
      results_html?: string;
    };
    if (payload.success !== 1) throw new Error(`Curator ${clanId} was not successful`);

    for (const match of String(payload.results_html ?? "").matchAll(/data-ds-appid="(\d+)"/g)) {
      const appId = match[1];
      if (appId) ids.add(appId);
    }

    total = Number(payload.total_count ?? 0);
    const size = Number(payload.pagesize ?? PAGE_SIZE);
    if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(size) || size <= 0) break;
    start += size;
    if (start < total) await new Promise((resolve) => setTimeout(resolve, 200));
  }

  if (ids.size === 0) throw new Error(`Curator ${clanId} returned no games`);
  return ids;
}
