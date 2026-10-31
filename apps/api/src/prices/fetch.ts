import type { PriceRegion } from "@gametracker/shared";

// One store's offer in one region, in minor units. null from a fetcher means the store does not sell the game there.
export type Offer = {
  currency: string;
  amount: number;
  base: number;
  cut: number;
  endsAt: Date | null;
};

const STEAM_CC: Record<PriceRegion, string> = { ua: "ua", us: "us" };
const PS_LOCALE: Record<PriceRegion, string> = { ua: "uk-ua", us: "en-us" };
const STEAM_BATCH = 50;
const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export function steamStoreUrl(appId: string): string {
  return `https://store.steampowered.com/app/${appId}/`;
}

export function psStoreUrl(conceptId: string, region: PriceRegion): string {
  return `https://store.playstation.com/${PS_LOCALE[region]}/concept/${conceptId}`;
}

// Steam answers for many apps at once when only price_overview is asked for. An app it skips stays out of the
// map (try again later); an app it knows but does not sell maps to null.
export async function steamOffers(appIds: string[], region: PriceRegion): Promise<Map<string, Offer | null>> {
  const offers = new Map<string, Offer | null>();
  const ids = appIds.filter((id) => /^\d+$/.test(id));
  for (let index = 0; index < ids.length; index += STEAM_BATCH) {
    const chunk = ids.slice(index, index + STEAM_BATCH);
    const url = `https://store.steampowered.com/api/appdetails?appids=${chunk.join(",")}&cc=${STEAM_CC[region]}&filters=price_overview`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Steam prices failed with ${response.status}`);
    const payload = (await response.json()) as Record<
      string,
      { success?: boolean; data?: { price_overview?: { currency?: string; initial?: number; final?: number; discount_percent?: number } } | unknown[] }
    > | null;
    for (const id of chunk) {
      const entry = payload?.[id];
      if (!entry) continue;
      const price = entry.success && entry.data && !Array.isArray(entry.data) ? entry.data.price_overview : undefined;
      if (!price || typeof price.final !== "number" || typeof price.initial !== "number" || !price.currency) {
        offers.set(id, null);
        continue;
      }
      offers.set(id, {
        currency: price.currency,
        amount: price.final,
        base: price.initial,
        cut: price.discount_percent ?? 0,
        endsAt: null,
      });
    }
  }
  return offers;
}

type PsPrice = {
  basePriceValue?: number;
  discountedValue?: number;
  currencyCode?: string;
  endTime?: string | null;
  serviceBranding?: string[];
  isTiedToSubscription?: boolean;
  qualifications?: unknown[];
  isFree?: boolean;
};

// PlayStation Store has no public API; its concept page carries the main product (schema.org) and the price of
// every edition it offers. The main product's cheapest price for everyone (not a PS Plus one) is the offer.
export async function playstationOffer(conceptId: string, region: PriceRegion): Promise<Offer | null> {
  if (!/^\d+$/.test(conceptId)) return null;
  const response = await fetch(psStoreUrl(conceptId, region), {
    headers: { "User-Agent": BROWSER, "Accept-Language": region === "ua" ? "uk-UA,uk;q=0.9" : "en-US,en;q=0.9" },
    signal: AbortSignal.timeout(15000),
  });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`PlayStation Store failed with ${response.status}`);
  const html = await response.text();

  const sku = /"@type"\s*:\s*"Product"[^]*?"sku"\s*:\s*"([^"]+)"/.exec(html)?.[1] ?? null;
  const offers: Offer[] = [];
  for (const match of html.matchAll(/"price":\{"__typename":"Price"/g)) {
    const start = (match.index ?? 0) + '"price":'.length;
    // Each price sits in a buy button whose action names the edition's sku a little earlier in the page.
    const before = html.slice(Math.max(0, start - 1500), start);
    const owner = [...before.matchAll(/"name":"skuId","value":"([^"]+)"/g)].pop()?.[1];
    if (sku && (!owner || !owner.startsWith(sku))) continue;
    const body = jsonObjectAt(html, start);
    if (!body) continue;
    let price: PsPrice;
    try {
      price = JSON.parse(body) as PsPrice;
    } catch {
      continue;
    }
    const plusOnly =
      price.isTiedToSubscription || (price.qualifications?.length ?? 0) > 0 || (price.serviceBranding ?? []).some((name) => name !== "NONE");
    if (plusOnly || price.isFree || typeof price.discountedValue !== "number" || typeof price.basePriceValue !== "number" || !price.currencyCode) {
      continue;
    }
    offers.push({
      currency: price.currencyCode,
      amount: price.discountedValue,
      base: price.basePriceValue,
      cut: price.basePriceValue > 0 ? Math.round((1 - price.discountedValue / price.basePriceValue) * 100) : 0,
      endsAt: price.endTime ? new Date(Number(price.endTime) || price.endTime) : null,
    });
  }
  if (offers.length > 0) return offers.reduce((best, offer) => (offer.amount < best.amount ? offer : best));

  // Without a buy button for the main product, the schema.org offer still gives the current price.
  const ld = /"offers"\s*:\s*\{[^{}]*"price"\s*:\s*([\d.]+)[^{}]*"priceCurrency"\s*:\s*"([A-Z]{3})"/.exec(html);
  if (!ld) return null;
  const amount = Math.round(Number(ld[1]) * 100);
  return { currency: ld[2], amount, base: amount, cut: 0, endsAt: null };
}

// The JSON object that opens at text[start], up to its matching brace; strings may hold braces and escapes.
function jsonObjectAt(text: string, start: number): string | null {
  if (text[start] !== "{") return null;
  let depth = 0;
  let inString = false;
  for (let index = start; index < text.length && index < start + 20000; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, index + 1);
    }
  }
  return null;
}
