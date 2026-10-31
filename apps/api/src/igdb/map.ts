import type { GameLinkKind, GameLinkSource } from "@gametracker/shared";
import type { StoredScreenshot, StoredTimeToBeat, StoredVideo } from "../db/schema.js";
import type { IgdbGameDetail, IgdbTimeToBeat } from "./client.js";

const WEBSITE_KIND: Record<number, GameLinkKind> = {
  1: "official",
  3: "wikipedia",
  13: "steam",
  16: "epic",
  17: "gog",
};

// IGDB external game sources whose ids the stores' prices are looked up by; only links to the store itself are kept.
const STORE_SOURCE: Record<number, { kind: GameLinkKind; host: RegExp }> = {
  36: { kind: "playstation", host: /^store\.playstation\.com$/ },
  11: { kind: "xbox", host: /^(www\.)?xbox\.com$/ },
  5: { kind: "gog", host: /^(www\.)?gog\.com$/ },
};

export const STORE_LINK_KINDS: GameLinkKind[] = ["playstation", "xbox", "gog"];
// GOG also comes as a plain website link and Xbox from a search of the Microsoft catalog, so those stay until IGDB
// gives one of its own.
export const REPLACED_LINK_KINDS: GameLinkKind[] = ["playstation"];

export type MappedLink = {
  kind: GameLinkKind;
  url: string;
  externalId: string | null;
  source: GameLinkSource;
};

export type MappedGame = {
  igdbId: number;
  slug: string;
  title: string;
  summary: string | null;
  coverUrl: string | null;
  releaseDate: string | null;
  platforms: string[];
  links: MappedLink[];
};

type IgdbWebsite = {
  url?: string;
  category?: number;
  type?: number;
};

export type IgdbGame = {
  id?: number;
  name?: string;
  slug?: string;
  summary?: string;
  first_release_date?: number;
  cover?: { image_id?: string };
  platforms?: { name?: string }[];
  websites?: IgdbWebsite[];
  hypes?: number;
  total_rating_count?: number;
  release_dates?: {
    date?: number;
    date_format?: number;
    platform?: { name?: string; abbreviation?: string };
  }[];
};

export function mapIgdbGame(game: IgdbGame): MappedGame | null {
  if (!game.id || !game.name?.trim()) return null;

  const slug = (game.slug?.trim() || `game-${game.id}`).toLowerCase();
  const platforms = [
    ...new Set(
      (game.platforms ?? [])
        .map((platform) => platform.name?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];

  return {
    igdbId: game.id,
    slug,
    title: game.name.trim(),
    summary: game.summary?.trim() || null,
    coverUrl: coverUrl(game.cover?.image_id),
    releaseDate: releaseDate(game.first_release_date),
    platforms,
    links: mapLinks(game.websites),
  };
}

function coverUrl(imageId: string | undefined): string | null {
  if (!imageId) return null;
  return `https://images.igdb.com/igdb/image/upload/t_cover_big/${imageId}.jpg`;
}

function releaseDate(unixSeconds: number | undefined): string | null {
  if (!unixSeconds) return null;
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

function mapLinks(websites: IgdbWebsite[] | undefined): MappedLink[] {
  const links: MappedLink[] = [];
  const seen = new Set<GameLinkKind>();

  for (const website of websites ?? []) {
    const websiteType = website.type ?? website.category;
    const kind = typeof websiteType === "number" ? WEBSITE_KIND[websiteType] : undefined;
    const url = website.url?.trim();
    if (!kind || !url || seen.has(kind)) continue;
    seen.add(kind);
    links.push({
      kind,
      url,
      externalId: kind === "steam" ? steamAppId(url) : null,
      source: "igdb",
    });
  }

  return links;
}

export function mapStoreLinks(game: IgdbGameDetail | null): MappedLink[] {
  const links = new Map<GameLinkKind, MappedLink>();
  for (const item of game?.external_games ?? []) {
    const store = item.external_game_source == null ? undefined : STORE_SOURCE[item.external_game_source];
    const url = item.url?.trim();
    const uid = item.uid?.trim() || null;
    const known = store ? links.get(store.kind) : undefined;
    // GOG lists a game under several product ids (old and new builds, the game in a pack); each is tried for a price.
    if (known && store?.kind === "gog" && uid && known.externalId && !known.externalId.split(",").includes(uid)) {
      known.externalId = `${known.externalId},${uid}`;
      continue;
    }
    if (!store || !url || known) continue;
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "https:" || !store.host.test(parsed.hostname)) continue;
      // Without the locale segment the stores open in the visitor's own region and language.
      parsed.pathname = parsed.pathname.replace(/^\/[a-z]{2}(?:-[a-z]{2})?(?=\/)/i, "");
      links.set(store.kind, { kind: store.kind, url: parsed.href, externalId: uid, source: "igdb" });
    } catch {
      continue;
    }
  }
  return [...links.values()];
}

export type MappedDetails = {
  storyline: string | null;
  igdbRating: number | null;
  genres: string[];
  screenshots: StoredScreenshot[];
  videos: StoredVideo[];
  developers: string[];
  publishers: string[];
  series: string | null;
  themes: string[];
  ageRatings: string[];
  timeToBeat: StoredTimeToBeat | null;
  similarIgdbIds: number[];
  ukrainianText: boolean;
  ukrainianAudio: boolean;
  detailVersion: number;
};

const AGE_ORG: Record<number, string> = {
  1: "ESRB",
  2: "PEGI",
};

export function mapIgdbDetails(game: IgdbGameDetail | null, beat: IgdbTimeToBeat | null): MappedDetails {
  const screenshots = (game?.screenshots ?? [])
    .map((shot) => shot.image_id?.trim())
    .filter((imageId): imageId is string => Boolean(imageId))
    .slice(0, 12)
    .map((imageId) => ({
      url: `https://images.igdb.com/igdb/image/upload/t_screenshot_med/${imageId}.jpg`,
    }));

  const videos = (game?.videos ?? [])
    .flatMap((video) => {
      const videoId = video.video_id?.trim();
      if (!videoId) return [];
      return [
        {
          name: video.name?.trim() || null,
          url: `https://www.youtube.com/watch?v=${videoId}`,
        },
      ];
    })
    .slice(0, 6);

  const rating = typeof game?.rating === "number" ? Math.round(game.rating * 10) / 10 : null;

  return {
    storyline: game?.storyline?.trim() || null,
    igdbRating: rating,
    genres: [
      ...new Set(
        (game?.genres ?? [])
          .map((genre) => genre.name?.trim())
          .filter((name): name is string => Boolean(name)),
      ),
    ],
    screenshots,
    videos,
    developers: companyNames(game, "developer"),
    publishers: companyNames(game, "publisher"),
    series: game?.franchises?.find((item) => item.name?.trim())?.name?.trim() || null,
    themes: uniqueNames(game?.themes),
    ageRatings: ageLabels(game),
    timeToBeat: mapBeat(beat),
    similarIgdbIds: (game?.similar_games ?? []).filter((id) => Number.isInteger(id)).slice(0, 8),
    ...ukrainianSupport(game),
    detailVersion: 5,
  };
}

function ukrainianSupport(game: IgdbGameDetail | null): { ukrainianText: boolean; ukrainianAudio: boolean } {
  let ukrainianText = false;
  let ukrainianAudio = false;
  for (const support of game?.language_supports ?? []) {
    const locale = support.language?.locale?.toLowerCase() ?? "";
    if (!locale.startsWith("uk")) continue;
    if (support.language_support_type === 1) ukrainianAudio = true;
    if (support.language_support_type === 2 || support.language_support_type === 3) ukrainianText = true;
  }
  return { ukrainianText, ukrainianAudio };
}

function companyNames(game: IgdbGameDetail | null, role: "developer" | "publisher"): string[] {
  return [
    ...new Set(
      (game?.involved_companies ?? [])
        .filter((company) => company[role])
        .map((company) => company.company?.name?.trim())
        .filter((name): name is string => Boolean(name)),
    ),
  ];
}

function uniqueNames(items: { name?: string }[] | undefined): string[] {
  return [
    ...new Set(
      (items ?? []).map((item) => item.name?.trim()).filter((name): name is string => Boolean(name)),
    ),
  ];
}

function ageLabels(game: IgdbGameDetail | null): string[] {
  const labels: string[] = [];
  for (const rating of game?.age_ratings ?? []) {
    const org = typeof rating.organization === "number" ? AGE_ORG[rating.organization] : undefined;
    const value = rating.rating_category?.rating?.trim();
    if (!org || !value || labels.includes(`${org} ${value}`)) continue;
    labels.push(`${org} ${value}`);
  }
  return labels;
}

function mapBeat(beat: IgdbTimeToBeat | null): StoredTimeToBeat | null {
  if (!beat) return null;
  const hastily = hours(beat.hastily);
  const normally = hours(beat.normally);
  const completely = hours(beat.completely);
  if (hastily == null && normally == null && completely == null) return null;
  return { hastily, normally, completely };
}

function hours(seconds: number | undefined): number | null {
  if (typeof seconds !== "number" || seconds <= 0) return null;
  return Math.round((seconds / 3600) * 10) / 10;
}

function steamAppId(url: string): string | null {
  const match = url.match(/\/app\/(\d+)/);
  return match?.[1] ?? null;
}
