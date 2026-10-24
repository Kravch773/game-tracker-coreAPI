import type { CatalogPlatformId, SearchGenreId } from "./catalog";

export const GAME_LINK_KINDS = [
  "steam",
  "gog",
  "epic",
  "official",
  "wikipedia",
  "metacritic",
] as const;

export type GameLinkKind = (typeof GAME_LINK_KINDS)[number];

export const GAME_LINK_SOURCES = ["igdb", "rawg", "manual"] as const;

export type GameLinkSource = (typeof GAME_LINK_SOURCES)[number];

export const LIBRARY_STATUSES = ["playing", "finished", "dropped", "backlog"] as const;

export type LibraryStatus = (typeof LIBRARY_STATUSES)[number];

export {
  LOCALES,
  bindLocale,
  getLocale,
  isLocale,
  setLocale,
  t,
  type Locale,
  type MessageKey,
} from "./i18n";

export const REVIEW_MAX_LENGTH = 2000;
export const RATING_MAX = 11;

const REVIEW_LINK = /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)\S+/gi;
const HAS_REVIEW_LINK = /(?:[a-z][a-z0-9+.-]*:\/\/|www\.)/i;

export function stripReviewLinks(value: string): string {
  const withoutLabels = value
    .replace(/\[([^\]]*)\]\(\s*(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^)\s]+\s*\)/gi, (_match, label: string) =>
      HAS_REVIEW_LINK.test(label) ? "" : label,
    )
    .replace(/<a\b[^>]*>([\s\S]*?)<\/a>/gi, (_match, label: string) => (HAS_REVIEW_LINK.test(label) ? "" : label));
  const withoutUrls = withoutLabels.replace(REVIEW_LINK, (match) => match.match(/[.,!?;:)\]'"]+$/)?.[0] ?? "");
  return withoutUrls
    .replace(/[ \t]+([.,!?;:])/g, "$1")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export type GameSummary = {
  id: string;
  slug: string;
  title: string;
  coverUrl: string | null;
  releaseDate: string | null;
  platforms: string[];
};

export type GameLink = {
  kind: GameLinkKind;
  url: string;
  externalId: string | null;
};

export type GameScreenshot = {
  url: string;
};

export type GameVideo = {
  name: string | null;
  url: string;
};

export type TimeToBeat = {
  hastily: number | null;
  normally: number | null;
  completely: number | null;
};

export type CommunityScore = {
  average: number | null;
  count: number;
};

export type CommunityReview = {
  username: string;
  rating: number | null;
  review: string;
  at: string;
};

export const TRAILERS_ENABLED = false;

export type GameTrailer = {
  name: string | null;
  previewUrl: string | null;
  videoUrl: string;
};

export type GameTrailersResponse = {
  trailers: GameTrailer[];
};

export type GameDetails = GameSummary & {
  summary: string | null;
  metacriticScore: number | null;
  links: GameLink[];
  storyline: string | null;
  igdbRating: number | null;
  genres: string[];
  screenshots: GameScreenshot[];
  videos: GameVideo[];
  developers: string[];
  publishers: string[];
  russianDevelopers: string[];
  russianPublishers: string[];
  series: string | null;
  themes: string[];
  ageRatings: string[];
  timeToBeat: TimeToBeat | null;
  similar: GameSummary[];
  community: CommunityScore;
  reviews: CommunityReview[];
  origins: GameOrigin[];
  ukrainianText: boolean;
  ukrainianAudio: boolean;
};

export type GameOrigin = "ua" | "ru";

export type SitemapPayload = {
  page: number;
  pageCount: number;
  games: { slug: string; updatedAt: string }[];
  users: { username: string; createdAt: string }[];
};

export type GameSearchResponse = {
  games: GameSummary[];
  hasMore: boolean;
};

export const HOME_COLLECTION_IDS = [
  "popular",
  "recent",
  "upcoming",
  "rpg",
  "shooter",
  "adventure",
  "strategy",
  "indie",
  "racing",
] as const;

export type HomeCollectionId = (typeof HOME_COLLECTION_IDS)[number];

export type HomeCollection = {
  id: HomeCollectionId;
  games: GameSummary[];
};

export type HomeResponse = {
  collections: HomeCollection[];
  backlog: GameSummary[] | null;
  upcomingBacklog: GameSummary[] | null;
  playing: GameSummary[] | null;
  favorites: GameSummary[] | null;
};

export type ReleaseGame = GameSummary & {
  hypes: number;
  featured: boolean;
  releasePlatforms: string[];
};

export type ReleaseDay = {
  date: string;
  games: ReleaseGame[];
};

export type ReleaseCalendar = {
  month: string;
  days: ReleaseDay[];
  mine: GameSummary[];
};

export type SearchSort = "popular" | "release" | "title";

// Each list matches any of its values; different lists must all match.
export type SearchFilters = {
  genre?: SearchGenreId[];
  platform?: CatalogPlatformId[];
  year?: number;
  sort?: SearchSort;
  developer?: string[];
  publisher?: string[];
  series?: string[];
};

export const MAX_FILTER_VALUES = 10;

export type ActivityEvent = {
  username: string;
  status: "finished" | "dropped";
  rating: number | null;
  review: string | null;
  at: string;
  game: GameSummary;
};

export type ActivityResponse = {
  events: ActivityEvent[];
};

export type { CatalogGenreId, CatalogPlatformId, SearchGenreId } from "./catalog";
export { CATALOG_GENRES, CATALOG_PLATFORMS, SEARCH_GENRES, catalogGenre, catalogPlatform } from "./catalog";

export type AuthUser = {
  id: string;
  username: string;
  email: string;
  steamId: string | null;
};

export type GameEntry = {
  status: LibraryStatus | null;
  rating: number | null;
  review: string | null;
  favorite: boolean;
  steamMinutes: number | null;
};

export type LibraryGame = GameSummary & {
  rating: number | null;
  review: string | null;
  addedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metacriticScore: number | null;
  steamMinutes: number | null;
};

export type SteamSyncResult = {
  steamId: string;
  matched: number;
  added: number;
  unmatched: number;
};

export type SteamWishlistResult = {
  steamId: string;
  matched: number;
  unmatched: number;
};

export type SteamWishlistMissingApp = {
  appId: string;
  title: string | null;
};

export type UserLibrary = {
  user: { username: string };
  playing: LibraryGame[];
  finished: LibraryGame[];
  dropped: LibraryGame[];
  backlog: LibraryGame[];
  favorites: LibraryGame[];
  steamWishlist: LibraryGame[];
  steamWishlistMissing: number;
  followers: number;
  following: number;
  followedByMe: boolean;
};

export type FollowPerson = {
  username: string;
};

export type MyGamesListImportRow = {
  title: string;
  rating: number | null;
  status: LibraryStatus;
  review: string | null;
  createdAt: string | null;
  updatedAt: string | null;
};

export type MyGamesListImportResult = {
  imported: number;
  missing: string[];
  skipped: number;
};
