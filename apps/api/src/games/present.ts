import type {
  GameDetails,
  GameLink,
  GameLinkKind,
  GameScreenshot,
  GameSummary,
  GameVideo,
  TimeToBeat,
} from "@gametracker/shared";
import type { GameDetailRow, GameLinkRow, GameRow } from "../db/schema.js";

const LINK_ORDER: GameLinkKind[] = [
  "steam",
  "gog",
  "epic",
  "playstation",
  "xbox",
  "official",
  "wikipedia",
  "metacritic",
];

export function toSummary(game: GameRow): GameSummary {
  return {
    id: game.id,
    slug: game.slug,
    title: game.title,
    coverUrl: game.coverUrl,
    releaseDate: game.releaseDate,
    platforms: platformsOf(game.platforms),
  };
}

export function toDetails(
  game: GameRow,
  links: GameLinkRow[],
  details: GameDetailRow | null,
): GameDetails {
  return {
    ...toSummary(game),
    summary: game.summary,
    metacriticScore: game.metacriticScore,
    links: links
      .map(toLink)
      .filter((link): link is GameLink => link !== null)
      .sort((a, b) => LINK_ORDER.indexOf(a.kind) - LINK_ORDER.indexOf(b.kind)),
    storyline: details?.storyline ?? null,
    igdbRating: typeof details?.igdbRating === "number" ? details.igdbRating : null,
    genres: stringList(details?.genres),
    screenshots: screenshotsOf(details?.screenshots),
    videos: videosOf(details?.videos),
    developers: stringList(details?.developers),
    publishers: stringList(details?.publishers),
    russianDevelopers: [],
    russianPublishers: [],
    series: details?.series?.trim() || null,
    themes: stringList(details?.themes),
    ageRatings: stringList(details?.ageRatings),
    timeToBeat: timeToBeatOf(details?.timeToBeat),
    similar: [],
    community: { average: null, count: 0 },
    reviews: [],
    origins: [],
    ukrainianText: details?.ukrainianText ?? false,
    ukrainianAudio: details?.ukrainianAudio ?? false,
  };
}

function toLink(link: GameLinkRow): GameLink | null {
  if (!LINK_ORDER.includes(link.kind as GameLinkKind)) return null;
  return {
    kind: link.kind as GameLinkKind,
    url: link.url,
    externalId: link.externalId,
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function screenshotsOf(value: unknown): GameScreenshot[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("url" in item) || typeof item.url !== "string") {
      return [];
    }
    return [{ url: item.url }];
  });
}

function videosOf(value: unknown): GameVideo[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (!item || typeof item !== "object" || !("url" in item) || typeof item.url !== "string") {
      return [];
    }
    const name = "name" in item && typeof item.name === "string" ? item.name : null;
    return [{ name, url: item.url }];
  });
}

function timeToBeatOf(value: unknown): TimeToBeat | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const hastily = hoursOf(record.hastily);
  const normally = hoursOf(record.normally);
  const completely = hoursOf(record.completely);
  if (hastily == null && normally == null && completely == null) return null;
  return { hastily, normally, completely };
}

function hoursOf(value: unknown): number | null {
  return typeof value === "number" && value > 0 ? value : null;
}

function platformsOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}
