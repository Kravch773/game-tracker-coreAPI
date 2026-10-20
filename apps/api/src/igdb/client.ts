import { env } from "../env.js";
import type { IgdbGame } from "./map.js";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const GAMES_URL = "https://api.igdb.com/v4/games";
const COMPANIES_URL = "https://api.igdb.com/v4/companies";
const TIME_URL = "https://api.igdb.com/v4/game_time_to_beats";

let tokenCache: { value: string; expiresAt: number } | null = null;
let requestTail: Promise<void> = Promise.resolve();
let lastRequestAt = 0;
const REQUEST_GAP_MS = 280;

const SEARCH_TYPES = "0,1,2,3,4,8,9,10";

const SEARCH_FIELDS =
  "fields name,slug,summary,first_release_date,cover.image_id,platforms.name,websites.url,websites.type,total_rating_count,hypes;";

export async function searchIgdb(query: string, limit = 20): Promise<IgdbGame[]> {
  const term = query.replace(/["\\*\n\r]/g, "").trim().slice(0, 80);
  if (!term) return [];
  const size = Math.min(80, Math.max(1, Math.floor(limit)));
  const where = `name ~ *"${term}"* & game_type = (${SEARCH_TYPES}) & version_parent = null`;
  const [rated, hyped] = await Promise.all([
    postGames([SEARCH_FIELDS, `where ${where};`, "sort total_rating_count desc;", `limit ${size};`].join("\n"), "IGDB search"),
    postGames([SEARCH_FIELDS, `where ${where} & hypes > 0;`, "sort hypes desc;", "limit 20;"].join("\n"), "IGDB search hypes"),
  ]);
  const byId = new Map<number, IgdbGame>();
  for (const game of [...gamesFrom(rated), ...gamesFrom(hyped)]) {
    if (typeof game.id === "number" && !byId.has(game.id)) byId.set(game.id, game);
  }
  return [...byId.values()];
}

export async function queryIgdbGames(body: string): Promise<IgdbGame[]> {
  return gamesFrom(await postGames(body, "IGDB query"));
}

export async function findCompanyIds(name: string): Promise<number[]> {
  const term = name.replace(/["\\*\n\r;]/g, "").trim().slice(0, 120);
  if (term.length < 2) return [];
  const payload = await postIgdb(
    COMPANIES_URL,
    ["fields name;", `where name ~ *"${term}"*;`, "limit 8;"].join("\n"),
    "IGDB companies",
  );
  if (!Array.isArray(payload)) return [];
  const wanted = term.toLowerCase();
  const ids: number[] = [];
  for (const row of payload) {
    if (!row || typeof row !== "object") continue;
    const company = row as { id?: unknown; name?: unknown };
    if (typeof company.id === "number" && typeof company.name === "string" && company.name.toLowerCase() === wanted) {
      ids.push(company.id);
    }
  }
  return ids.slice(0, 4);
}

export type IgdbGameDetail = {
  storyline?: string;
  rating?: number;
  genres?: { name?: string }[];
  screenshots?: { image_id?: string }[];
  videos?: { video_id?: string; name?: string }[];
  themes?: { name?: string }[];
  involved_companies?: {
    developer?: boolean;
    publisher?: boolean;
    company?: { name?: string };
  }[];
  age_ratings?: { organization?: number; rating_category?: { rating?: string } }[];
  similar_games?: number[];
  language_supports?: { language?: { locale?: string }; language_support_type?: number }[];
};

export type IgdbTimeToBeat = {
  hastily?: number;
  normally?: number;
  completely?: number;
};

export async function fetchIgdbGame(igdbId: number): Promise<IgdbGameDetail | null> {
  if (!Number.isInteger(igdbId)) {
    throw new Error("IGDB id must be an integer");
  }

  const body = [
    "fields storyline,rating,genres.name,screenshots.image_id,videos.video_id,videos.name,themes.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,age_ratings.organization,age_ratings.rating_category.rating,similar_games,language_supports.language.locale,language_supports.language_support_type;",
    `where id = ${igdbId};`,
  ].join("\n");

  const payload = await postGames(body, "IGDB game request");
  if (!Array.isArray(payload)) {
    throw new Error("IGDB game request returned an unexpected payload");
  }

  return (payload[0] as IgdbGameDetail | undefined) ?? null;
}

export async function fetchTimeToBeat(igdbId: number): Promise<IgdbTimeToBeat | null> {
  if (!Number.isInteger(igdbId)) return null;
  try {
    const payload = await postIgdb(
      TIME_URL,
      `fields hastily,normally,completely; where game_id = ${igdbId}; limit 1;`,
      "IGDB time to beat",
    );
    if (!Array.isArray(payload)) return null;
    return (payload[0] as IgdbTimeToBeat | undefined) ?? null;
  } catch (error) {
    console.error("IGDB time to beat failed", error);
    return null;
  }
}

async function postGames(body: string, label: string): Promise<unknown> {
  return postIgdb(GAMES_URL, body, label);
}

async function postIgdb(url: string, body: string, label: string): Promise<unknown> {
  await pace();
  const token = await getToken();
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Client-ID": env.twitchClientId,
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "Content-Type": "text/plain",
    },
    body,
    signal: AbortSignal.timeout(8000),
  });

  if (response.status === 401) {
    tokenCache = null;
  }

  if (!response.ok) {
    throw new Error(`${label} failed with ${response.status}`);
  }

  return response.json() as Promise<unknown>;
}

function gamesFrom(payload: unknown): IgdbGame[] {
  if (!Array.isArray(payload)) {
    throw new Error("IGDB query returned an unexpected payload");
  }
  return payload as IgdbGame[];
}

function pace(): Promise<void> {
  const next = requestTail.then(async () => {
    const wait = REQUEST_GAP_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    lastRequestAt = Date.now();
  });
  requestTail = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

async function getToken(): Promise<string> {
  if (tokenCache && tokenCache.expiresAt > Date.now()) {
    return tokenCache.value;
  }

  const body = new URLSearchParams({
    client_id: env.twitchClientId,
    client_secret: env.twitchClientSecret,
    grant_type: "client_credentials",
  });

  const response = await fetch(TOKEN_URL, {
    method: "POST",
    body,
    signal: AbortSignal.timeout(8000),
  });

  if (!response.ok) {
    throw new Error(`Twitch token request failed with ${response.status}`);
  }

  const payload = (await response.json()) as { access_token?: string; expires_in?: number };
  if (!payload.access_token) {
    throw new Error("Twitch token response did not include access_token");
  }

  const expiresIn = payload.expires_in ?? 3600;
  tokenCache = {
    value: payload.access_token,
    expiresAt: Date.now() + Math.max(expiresIn - 60, 30) * 1000,
  };
  return payload.access_token;
}
