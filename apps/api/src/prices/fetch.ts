import type { PriceRegion } from "@gametracker/shared";
import { StoreLimitError } from "./gate.js";

// One store's offer in one region, in minor units. null from a fetcher means the store does not sell the game there.
export type Offer = {
  currency: string;
  amount: number;
  base: number;
  cut: number;
  endsAt: Date | null;
};

const STEAM_COUNTRY: Record<PriceRegion, string> = { ua: "UA", us: "US" };
// Steam prices Ukraine in hryvnias and the US in dollars; the browse service gives amounts without a currency code.
const STEAM_CURRENCY: Record<PriceRegion, string> = { ua: "UAH", us: "USD" };
const PS_LOCALE: Record<PriceRegion, string> = { ua: "uk-ua", us: "en-us" };
export const STEAM_BATCH = 50;
const BROWSER =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

export function steamStoreUrl(appId: string): string {
  return `https://store.steampowered.com/app/${appId}/`;
}

export function psStoreUrl(conceptId: string, region: PriceRegion): string {
  return `https://store.playstation.com/${PS_LOCALE[region]}/concept/${conceptId}`;
}

type SteamItem = {
  appid?: number;
  success?: number;
  is_free?: boolean;
  best_purchase_option?: {
    final_price_in_cents?: string;
    original_price_in_cents?: string;
    discount_pct?: number;
    active_discounts?: { discount_end_date?: number }[];
  };
};

// Steam's store browse service answers for many apps at once and carries the sale's end date. The storefront's
// appdetails throttles the shared IPs cloud hosts give out (429 on Render); this service has limits of its own.
// An app it skips stays out of the map (try again later); an app it knows but does not sell maps to null.
export async function steamOffers(appIds: string[], region: PriceRegion): Promise<Map<string, Offer | null>> {
  const offers = new Map<string, Offer | null>();
  const ids = appIds.filter((id) => /^\d+$/.test(id));
  for (let index = 0; index < ids.length; index += STEAM_BATCH) {
    const chunk = ids.slice(index, index + STEAM_BATCH);
    const input = {
      ids: chunk.map((id) => ({ appid: Number(id) })),
      context: { language: "english", country_code: STEAM_COUNTRY[region] },
      data_request: {},
    };
    const url = `https://api.steampowered.com/IStoreBrowseService/GetItems/v1/?input_json=${encodeURIComponent(JSON.stringify(input))}`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 429 || response.status === 403) throw new StoreLimitError(response.status, response.headers.get("retry-after"));
    if (!response.ok) throw new Error(`Steam prices failed with ${response.status}`);
    const payload = (await response.json()) as { response?: { store_items?: SteamItem[] } } | null;
    for (const item of payload?.response?.store_items ?? []) {
      if (typeof item.appid !== "number" || item.success !== 1) continue;
      const option = item.best_purchase_option;
      const final = Number(option?.final_price_in_cents);
      if (item.is_free || !option || !Number.isFinite(final)) {
        offers.set(String(item.appid), null);
        continue;
      }
      const original = Number(option.original_price_in_cents);
      const end = option.active_discounts?.find((discount) => discount.discount_end_date)?.discount_end_date;
      offers.set(String(item.appid), {
        currency: STEAM_CURRENCY[region],
        amount: final,
        base: Number.isFinite(original) && original > final ? original : final,
        cut: option.discount_pct ?? 0,
        endsAt: end ? new Date(end * 1000) : null,
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
  if (response.status === 429 || response.status === 403) throw new StoreLimitError(response.status, response.headers.get("retry-after"));
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

export const XBOX_BATCH = 20;
const XBOX_MARKET: Record<PriceRegion, string> = { ua: "UA", us: "US" };

type XboxAvailability = {
  Actions?: string[];
  RemediationRequired?: boolean;
  Conditions?: { EndDate?: string };
  OrderManagementData?: { Price?: { CurrencyCode?: string; ListPrice?: number; MSRP?: number } };
};
type XboxProduct = { ProductId?: string; DisplaySkuAvailabilities?: { Availabilities?: XboxAvailability[] }[] };

// The Microsoft Store catalog answers for many products at once. A product's offer is its cheapest purchase that
// needs no subscription (Game Pass discounts come as availabilities to remediate first). The Ukrainian store sells
// mostly games that also run on PC and lists console-only ones with nothing to buy; players in Ukraine buy those
// on a US account, so such a game gets its US price in dollars.
export async function xboxOffers(bigIds: string[], region: PriceRegion): Promise<Map<string, Offer | null>> {
  const ids = bigIds.filter((id) => /^[0-9A-Z]{12}$/.test(id));
  const offers = await xboxMarketOffers(ids, region);
  if (region === "us") return offers;
  const unsold = ids.filter((id) => offers.has(id) && offers.get(id) == null);
  for (const [id, offer] of await xboxMarketOffers(unsold, "us")) if (offer) offers.set(id, offer);
  return offers;
}

async function xboxMarketOffers(ids: string[], region: PriceRegion): Promise<Map<string, Offer | null>> {
  const offers = new Map<string, Offer | null>();
  for (let index = 0; index < ids.length; index += XBOX_BATCH) {
    const chunk = ids.slice(index, index + XBOX_BATCH);
    const url = `https://displaycatalog.mp.microsoft.com/v7.0/products?bigIds=${chunk.join(",")}&market=${XBOX_MARKET[region]}&languages=en-us&MS-CV=DGU1mcuYo0WMMp`;
    const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
    if (response.status === 429 || response.status === 403) throw new StoreLimitError(response.status, response.headers.get("retry-after"));
    if (!response.ok) throw new Error(`Xbox Store prices failed with ${response.status}`);
    const payload = (await response.json()) as { Products?: XboxProduct[] } | null;
    for (const product of payload?.Products ?? []) {
      if (!product.ProductId) continue;
      let best: Offer | null = null;
      for (const sku of product.DisplaySkuAvailabilities ?? []) {
        for (const availability of sku.Availabilities ?? []) {
          const price = availability.OrderManagementData?.Price;
          if (!availability.Actions?.includes("Purchase") || availability.RemediationRequired || !price?.CurrencyCode) continue;
          if (typeof price.ListPrice !== "number" || price.ListPrice <= 0) continue;
          const amount = Math.round(price.ListPrice * 100);
          const base = Math.max(amount, Math.round((price.MSRP ?? 0) * 100));
          if (best && best.amount <= amount) continue;
          const end = availability.Conditions?.EndDate ? new Date(availability.Conditions.EndDate) : null;
          best = {
            currency: price.CurrencyCode,
            amount,
            base,
            cut: base > amount ? Math.round((1 - amount / base) * 100) : 0,
            // Full-price availabilities run until a far-off date (or year 9998), which says nothing about a sale.
            endsAt: base > amount && end && end.getUTCFullYear() < 9000 ? end : null,
          };
        }
      }
      offers.set(product.ProductId, best);
    }
  }
  return offers;
}

type XboxSuggestion = { ProductId?: string; Type?: string; Title?: string };

// Games the Microsoft catalog suggests for a title, for games IGDB knows on Xbox but has no store page for.
export async function xboxSearch(title: string): Promise<{ id: string; title: string }[]> {
  const url = `https://displaycatalog.mp.microsoft.com/v7.0/productFamilies/autosuggest?market=US&languages=en-us&productFamilyNames=Games&query=${encodeURIComponent(title)}`;
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (response.status === 429 || response.status === 403) throw new StoreLimitError(response.status, response.headers.get("retry-after"));
  if (!response.ok) throw new Error(`Xbox Store search failed with ${response.status}`);
  const payload = (await response.json()) as { Results?: { Products?: XboxSuggestion[] }[] } | null;
  return (payload?.Results ?? []).flatMap((result) =>
    (result.Products ?? []).flatMap((product) =>
      product.Type === "Game" && product.ProductId && product.Title ? [{ id: product.ProductId, title: product.Title }] : [],
    ),
  );
}

export function xboxStoreUrl(id: string, title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "game";
  return `https://www.xbox.com/games/store/${slug}/${id}`;
}

const GOG_COUNTRY: Record<PriceRegion, string> = { ua: "UA", us: "US" };
export const GOG_BATCH = 25;

type GogPriceItem = {
  _embedded?: { product?: { id?: number }; prices?: { currency?: { code?: string }; basePrice?: string; finalPrice?: string }[] };
};

// GOG prices each product per country (Ukraine in dollars, lower than the US) and answers for many products at
// once, leaving out those not for sale. A game may sit under several product ids, comma-separated in its link
// (an old build, the game in a pack), and its offer is the first of them GOG prices.
export async function gogOffers(gameIds: string[], region: PriceRegion): Promise<Map<string, Offer | null>> {
  const offers = new Map<string, Offer | null>();
  for (let index = 0; index < gameIds.length; index += GOG_BATCH) {
    const chunk = gameIds.slice(index, index + GOG_BATCH);
    const products = [...new Set(chunk.flatMap((ids) => ids.split(",")).filter((id) => /^\d+$/.test(id)))];
    if (products.length === 0) continue;
    const response = await fetch(`https://api.gog.com/products/prices?ids=${products.join(",")}&countryCode=${GOG_COUNTRY[region]}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(10000),
    });
    if (response.status === 429 || response.status === 403) throw new StoreLimitError(response.status, response.headers.get("retry-after"));
    if (!response.ok) throw new Error(`GOG prices failed with ${response.status}`);
    const payload = (await response.json()) as { _embedded?: { items?: GogPriceItem[] } } | null;
    const priced = new Map<string, Offer | null>();
    for (const item of payload?._embedded?.items ?? []) {
      const id = item._embedded?.product?.id;
      const price = item._embedded?.prices?.[0];
      const amount = minorUnits(price?.finalPrice);
      const base = minorUnits(price?.basePrice);
      const currency = price?.currency?.code;
      if (id == null || amount == null || base == null || !currency) continue;
      priced.set(
        String(id),
        base === 0 ? null : { currency, amount, base: Math.max(base, amount), cut: base > amount ? Math.round((1 - amount / base) * 100) : 0, endsAt: null },
      );
    }
    for (const ids of chunk) {
      const id = ids.split(",").find((product) => priced.has(product));
      offers.set(ids, id ? (priced.get(id) ?? null) : null);
    }
  }
  return offers;
}

// GOG writes prices as "2999 USD".
function minorUnits(value: string | undefined): number | null {
  const match = /^(\d+)\s/.exec(value ?? "");
  return match ? Number(match[1]) : null;
}
