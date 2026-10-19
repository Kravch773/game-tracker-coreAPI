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
  themes: string[];
  ageRatings: string[];
  timeToBeat: TimeToBeat | null;
  similar: GameSummary[];
  community: CommunityScore;
  reviews: CommunityReview[];
};

export type GameSearchResponse = {
  games: GameSummary[];
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

export type SearchFilters = {
  genre?: SearchGenreId;
  platform?: CatalogPlatformId;
  year?: number;
};

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
};

export type GameEntry = {
  status: LibraryStatus | null;
  rating: number | null;
  review: string | null;
  favorite: boolean;
};

export type LibraryGame = GameSummary & {
  rating: number | null;
  review: string | null;
  addedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  metacriticScore: number | null;
};

export type UserLibrary = {
  user: { username: string };
  playing: LibraryGame[];
  finished: LibraryGame[];
  dropped: LibraryGame[];
  backlog: LibraryGame[];
  favorites: LibraryGame[];
  followers: number;
  following: number;
  followedByMe: boolean;
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
