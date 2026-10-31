import { env } from "../env.js";
import type { IgdbGame } from "./map.js";

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const GAMES_URL = "https://api.igdb.com/v4/games";
const EXTERNAL_URL = "https://api.igdb.com/v4/external_games";
const ALTERNATIVE_URL = "https://api.igdb.com/v4/alternative_names";
const COMPANIES_URL = "https://api.igdb.com/v4/companies";
const FRANCHISES_URL = "https://api.igdb.com/v4/franchises";
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
  const [rated, hyped, named] = await Promise.all([
    postGames([SEARCH_FIELDS, `where ${where};`, "sort total_rating_count desc;", `limit ${size};`].join("\n"), "IGDB search"),
    postGames([SEARCH_FIELDS, `where ${where} & hypes > 0;`, "sort hypes desc;", "limit 20;"].join("\n"), "IGDB search hypes"),
    postGames(
      [SEARCH_FIELDS, `search "${term}";`, `where game_type = (${SEARCH_TYPES}) & version_parent = null;`, "limit 20;"].join("\n"),
      "IGDB name search",
    ),
  ]);
  const byId = new Map<number, IgdbGame>();
  for (const game of [...gamesFrom(rated), ...gamesFrom(hyped), ...gamesFrom(named)]) {
    if (typeof game.id === "number" && !byId.has(game.id)) byId.set(game.id, game);
  }
  return [...byId.values()];
}

// Games known by another name, ignoring case: acronyms such as "GTA V", "RDR2" or "TLoU" live among IGDB's
// alternative names, not in the titles a name search looks at. A name must be one of the terms, or, for a lone
// acronym like "gta", start with it as a word ("GTA V", "GTA: San Andreas", not "GTAP").
export async function searchAlternativeNames(terms: string[], limit = 30): Promise<IgdbGame[]> {
  const quoted = [...new Set(terms.map((term) => term.replace(/["\\*\n\r;]/g, "").trim().slice(0, 80)).filter((term) => term.length >= 2))];
  if (quoted.length === 0) return [];
  const acronyms = quoted.filter((term) => /^[\p{L}\p{N}]{2,6}$/u.test(term));
  const where = [...quoted.map((term) => `name ~ "${term}"`), ...acronyms.map((term) => `name ~ "${term} "* | name ~ "${term}:"*`)].join(" | ");
  const payload = await postIgdb(ALTERNATIVE_URL, `fields game,name; where ${where}; limit 200;`, "IGDB alternative names");
  if (!Array.isArray(payload)) return [];
  const ids = [...new Set(payload.flatMap((row: { game?: unknown }) => (typeof row?.game === "number" ? [row.game] : [])))];
  if (ids.length === 0) return [];
  return gamesFrom(
    await postGames(
      [
        SEARCH_FIELDS,
        `where id = (${ids.slice(0, 200).join(",")}) & game_type = (${SEARCH_TYPES}) & version_parent = null;`,
        "sort total_rating_count desc;",
        `limit ${limit};`,
      ].join("\n"),
      "IGDB alternative name games",
    ),
  );
}

export async function queryIgdbGames(body: string): Promise<IgdbGame[]> {
  return gamesFrom(await postGames(body, "IGDB query"));
}

export async function igdbIdsForSteamApps(appIds: string[]): Promise<number[]> {
  const ids = new Set<number>();
  for (let index = 0; index < appIds.length; index += 40) {
    const quoted = appIds
      .slice(index, index + 40)
      .filter((id) => /^\d+$/.test(id))
      .map((id) => `"${id}"`)
      .join(",");
    if (!quoted) continue;
    const payload = await postIgdb(
      EXTERNAL_URL,
      `fields game; where external_game_source = 1 & uid = (${quoted}); limit 500;`,
      "IGDB steam apps",
    );
    if (!Array.isArray(payload)) continue;
    for (const row of payload) {
      if (!row || typeof row !== "object" || !("game" in row) || typeof row.game !== "number") continue;
      ids.add(row.game);
    }
  }
  return [...ids];
}

// Console store pages (PlayStation, Microsoft) for many games at once, grouped by IGDB game id.
export async function storeExternalsFor(igdbIds: number[]): Promise<Map<number, NonNullable<IgdbGameDetail["external_games"]>>> {
  const found = new Map<number, NonNullable<IgdbGameDetail["external_games"]>>();
  for (let index = 0; index < igdbIds.length; index += 200) {
    const chunk = igdbIds.slice(index, index + 200).filter((id) => Number.isInteger(id)).join(",");
    if (!chunk) continue;
    const payload = await postIgdb(
      EXTERNAL_URL,
      `fields game,external_game_source,url,uid; where game = (${chunk}) & external_game_source = (5,11,36); limit 500;`,
      "IGDB store links",
    );
    if (!Array.isArray(payload)) continue;
    for (const row of payload as { game?: unknown; external_game_source?: number; url?: string; uid?: string }[]) {
      if (typeof row?.game !== "number") continue;
      const list = found.get(row.game) ?? [];
      list.push({ external_game_source: row.external_game_source, url: row.url, uid: row.uid });
      found.set(row.game, list);
    }
  }
  return found;
}

export async function developerCompanies(
  igdbIds: number[],
  role: "developer" | "publisher" = "developer",
): Promise<{ id: number; name: string }[]> {
  const found = new Map<number, string>();
  for (let index = 0; index < igdbIds.length; index += 40) {
    const chunk = igdbIds.slice(index, index + 40).filter((id) => Number.isInteger(id)).join(",");
    if (!chunk) continue;
    const payload = await postGames(
      [
        "fields involved_companies.developer,involved_companies.publisher,involved_companies.company.id,involved_companies.company.name;",
        `where id = (${chunk});`,
        "limit 40;",
      ].join("\n"),
      "IGDB companies",
    );
    if (!Array.isArray(payload)) continue;
    for (const row of payload) {
      if (!row || typeof row !== "object" || !("involved_companies" in row) || !Array.isArray(row.involved_companies)) continue;
      for (const company of row.involved_companies) {
        if (!company || typeof company !== "object" || company[role] !== true) continue;
        const record = "company" in company ? company.company : null;
        if (!record || typeof record !== "object") continue;
        const id = "id" in record && typeof record.id === "number" ? record.id : null;
        const name = "name" in record && typeof record.name === "string" ? record.name.trim() : "";
        if (id == null || !name) continue;
        found.set(id, name);
      }
    }
  }
  return [...found.entries()].map(([id, name]) => ({ id, name }));
}

export async function companyIdsByNames(names: string[]): Promise<number[]> {
  const ids = new Set<number>();
  const safe = names
    .map((name) => name.replace(/[\n\r]/g, " ").trim())
    .filter((name) => name.length > 1 && !/["\\;]/.test(name));
  for (let index = 0; index < safe.length; index += 20) {
    const quoted = safe
      .slice(index, index + 20)
      .map((name) => `"${name}"`)
      .join(",");
    const payload = await postIgdb(
      COMPANIES_URL,
      ["fields name;", `where name = (${quoted});`, "limit 50;"].join("\n"),
      "IGDB company names",
    );
    if (!Array.isArray(payload)) continue;
    for (const row of payload) {
      if (row && typeof row === "object" && "id" in row && typeof row.id === "number") ids.add(row.id);
    }
  }
  return [...ids];
}

export async function fetchGamesByDevelopers(
  companyIds: number[],
  role: "developer" | "publisher" | "any" = "developer",
): Promise<IgdbGame[]> {
  const byId = new Map<number, IgdbGame>();
  const playable = "game_type = (0,8,9) & version_parent = null";
  const credit =
    role === "any"
      ? "(involved_companies.developer = true | involved_companies.publisher = true)"
      : `involved_companies.${role} = true`;
  for (let index = 0; index < companyIds.length; index += 6) {
    const chunk = companyIds.slice(index, index + 6).filter((id) => Number.isInteger(id)).join(",");
    if (!chunk) continue;
    const games = gamesFrom(
      await postGames(
        [
          SEARCH_FIELDS,
          `where involved_companies.company = (${chunk}) & ${credit} & ${playable};`,
          "sort total_rating_count desc;",
          "limit 200;",
        ].join("\n"),
        "IGDB games by company",
      ),
    );
    for (const game of games) {
      if (typeof game.id === "number" && !byId.has(game.id)) byId.set(game.id, game);
    }
  }
  return [...byId.values()];
}

export async function fetchIgdbGamesByIds(ids: number[]): Promise<IgdbGame[]> {
  const games: IgdbGame[] = [];
  for (let index = 0; index < ids.length; index += 50) {
    const chunk = ids.slice(index, index + 50).filter((id) => Number.isInteger(id)).join(",");
    if (!chunk) continue;
    games.push(
      ...gamesFrom(
        await postGames([SEARCH_FIELDS, `where id = (${chunk});`, "limit 50;"].join("\n"), "IGDB games by id"),
      ),
    );
  }
  return games;
}

type IgdbGroupRef = { id?: number; name?: string; games?: number[] };
export type IgdbSeriesOf = IgdbGame & { collections?: IgdbGroupRef[]; franchise?: IgdbGroupRef; franchises?: IgdbGroupRef[] };
export type IgdbSeriesGame = IgdbGame & { collections?: number[]; franchises?: number[] };

// The collections and franchises each game belongs to; IGDB answers up to 500 ids per request.
export async function fetchSeriesOf(ids: number[]): Promise<IgdbSeriesOf[]> {
  const found: IgdbSeriesOf[] = [];
  for (let index = 0; index < ids.length; index += 500) {
    const chunk = ids.slice(index, index + 500).join(",");
    if (!chunk) continue;
    const payload = await postGames(
      ["fields collections.name,collections.games,franchise.name,franchises.name;", `where id = (${chunk});`, "limit 500;"].join("\n"),
      "IGDB series of games",
    );
    found.push(...(gamesFrom(payload) as IgdbSeriesOf[]));
  }
  return found;
}

// Main games of the given collections or franchises. A franchise is only the fallback for games without a
// collection, so its list skips games that have one: Star Wars then shows its loose games, not all of them.
export async function fetchSeriesGames(field: "collections" | "franchises", groupIds: number[]): Promise<IgdbSeriesGame[]> {
  const found: IgdbSeriesGame[] = [];
  for (let index = 0; index < groupIds.length; index += 40) {
    const chunk = groupIds.slice(index, index + 40).join(",");
    for (let offset = 0; offset < 1500; offset += 500) {
      const payload = await postGames(
        [
          SEARCH_FIELDS.replace(";", `,${field};`),
          `where ${field} = (${chunk})${field === "franchises" ? " & collections = null" : ""} & game_type = 0 & version_parent = null & cover != null & (total_rating_count >= 10 | hypes >= 10);`,
          "limit 500;",
          `offset ${offset};`,
        ].join("\n"),
        `IGDB ${field} games`,
      );
      const page = gamesFrom(payload) as IgdbSeriesGame[];
      found.push(...page);
      if (page.length < 500) break;
    }
  }
  return found;
}

// One game by its IGDB slug, for game pages opened before the game reached the catalog.
export async function fetchIgdbGameBySlug(slug: string): Promise<IgdbGame | null> {
  if (!/^[a-z0-9-]+$/.test(slug)) return null;
  const payload = await postGames([SEARCH_FIELDS, `where slug = "${slug}";`, "limit 1;"].join("\n"), "IGDB game by slug");
  return gamesFrom(payload)[0] ?? null;
}

export async function matchCompanies(name: string): Promise<number[]> {
  return matchNames(COMPANIES_URL, name, "IGDB company match");
}

export async function matchFranchises(name: string): Promise<number[]> {
  return matchNames(FRANCHISES_URL, name, "IGDB series match");
}

async function matchNames(url: string, name: string, label: string): Promise<number[]> {
  const term = name.replace(/["\\*\n\r;]/g, "").trim().slice(0, 80);
  const folded = term.toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/gi, "");
  if (folded.length < 2) return [];
  const payload = await postIgdb(url, ["fields name;", `where name ~ *"${term}"*;`, "limit 25;"].join("\n"), label);
  if (!Array.isArray(payload)) return [];
  const rows = payload.flatMap((row) => {
    if (!row || typeof row !== "object") return [];
    const item = row as { id?: unknown; name?: unknown };
    if (typeof item.id !== "number" || typeof item.name !== "string") return [];
    return [{ id: item.id, name: item.name }];
  });
  const ranked = rows
    .map((row) => ({ ...row, rank: nameRank(row.name, term) }))
    .filter((row) => row.rank < 1000)
    .sort((a, b) => a.rank - b.rank);
  const precise = ranked.filter((row) => row.rank < 100);
  return (precise.length > 0 ? precise : ranked).slice(0, 6).map((row) => row.id);
}

function nameRank(name: string, term: string): number {
  const foldedName = name.toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/gi, "");
  const foldedTerm = term.toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/gi, "");
  if (!foldedTerm) return 1000;
  if (foldedName === foldedTerm) return 0;
  const nameTokens = name.toLowerCase().split(/[^a-z0-9\u0400-\u04ff]+/i).filter(Boolean);
  const termTokens = term.toLowerCase().split(/[^a-z0-9\u0400-\u04ff]+/i).filter(Boolean);
  if (termTokens.length > 0 && termTokens.every((token) => nameTokens.includes(token))) return 1 + foldedName.length;
  if (foldedName.includes(foldedTerm)) return 100 + foldedName.length;
  return 1000;
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
  franchises?: { name?: string }[];
  similar_games?: number[];
  language_supports?: { language?: { locale?: string }; language_support_type?: number }[];
  external_games?: { external_game_source?: number; url?: string; uid?: string }[];
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
    "fields storyline,rating,genres.name,screenshots.image_id,videos.video_id,videos.name,themes.name,franchises.name,involved_companies.company.name,involved_companies.developer,involved_companies.publisher,age_ratings.organization,age_ratings.rating_category.rating,similar_games,language_supports.language.locale,language_supports.language_support_type,external_games.external_game_source,external_games.url,external_games.uid;",
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
