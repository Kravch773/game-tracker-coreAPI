import {
  date,
  integer,
  numeric,
  jsonb,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const games = pgTable("games", {
  id: uuid("id").primaryKey().defaultRandom(),
  igdbId: integer("igdb_id").notNull().unique(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  summary: text("summary"),
  coverUrl: text("cover_url"),
  releaseDate: date("release_date"),
  platforms: jsonb("platforms").$type<string[]>().notNull().default([]),
  metacriticScore: integer("metacritic_score"),
  metacriticCheckedAt: timestamp("metacritic_checked_at", { withTimezone: true }),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const gameLinks = pgTable(
  "game_links",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    kind: text("kind").notNull(),
    url: text("url").notNull(),
    externalId: text("external_id"),
    source: text("source").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex("game_links_game_kind_idx").on(table.gameId, table.kind)],
);

export const gameDetails = pgTable("game_details", {
  gameId: uuid("game_id")
    .primaryKey()
    .references(() => games.id, { onDelete: "cascade" }),
  storyline: text("storyline"),
  igdbRating: real("igdb_rating"),
  genres: jsonb("genres").$type<string[]>().notNull().default([]),
  screenshots: jsonb("screenshots").$type<StoredScreenshot[]>().notNull().default([]),
  videos: jsonb("videos").$type<StoredVideo[]>().notNull().default([]),
  developers: jsonb("developers").$type<string[]>().notNull().default([]),
  publishers: jsonb("publishers").$type<string[]>().notNull().default([]),
  themes: jsonb("themes").$type<string[]>().notNull().default([]),
  ageRatings: jsonb("age_ratings").$type<string[]>().notNull().default([]),
  timeToBeat: jsonb("time_to_beat").$type<StoredTimeToBeat | null>(),
  similarIgdbIds: jsonb("similar_igdb_ids").$type<number[]>().notNull().default([]),
  detailVersion: integer("detail_version").notNull().default(1),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export type StoredTimeToBeat = {
  hastily: number | null;
  normally: number | null;
  completely: number | null;
};
export type StoredScreenshot = { url: string };
export type StoredVideo = { name: string | null; url: string };
export type StoredTrailer = {
  name: string | null;
  previewUrl: string | null;
  videoUrl: string;
};

export const gameTrailers = pgTable("game_trailers", {
  gameId: uuid("game_id")
    .primaryKey()
    .references(() => games.id, { onDelete: "cascade" }),
  rawgId: integer("rawg_id"),
  trailers: jsonb("trailers").$type<StoredTrailer[]>().notNull().default([]),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const collectionCache = pgTable("collection_cache", {
  key: text("key").primaryKey(),
  gameIds: uuid("game_ids").array().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const searchCache = pgTable("search_cache", {
  query: text("query").primaryKey(),
  gameIds: uuid("game_ids").array().notNull(),
  fetchedAt: timestamp("fetched_at", { withTimezone: true }).notNull(),
});

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  email: text("email").notNull().unique(),
  username: text("username").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  steamId: text("steam_id").unique(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const listEntries = pgTable(
  "list_entries",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    rating: numeric("rating", { precision: 3, scale: 1, mode: "number" }),
    review: text("review"),
    startedAt: timestamp("started_at", { withTimezone: true }),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.gameId] })],
);

export const follows = pgTable(
  "follows",
  {
    followerId: uuid("follower_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    followingId: uuid("following_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.followerId, table.followingId] })],
);

export const steamPlays = pgTable(
  "steam_plays",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    playtimeMinutes: integer("playtime_minutes").notNull(),
    syncedAt: timestamp("synced_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.gameId] })],
);

export const favorites = pgTable(
  "favorites",
  {
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    gameId: uuid("game_id")
      .notNull()
      .references(() => games.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.userId, table.gameId] })],
);

export type GameRow = typeof games.$inferSelect;
export type GameLinkRow = typeof gameLinks.$inferSelect;
export type GameDetailRow = typeof gameDetails.$inferSelect;
export type GameTrailerRow = typeof gameTrailers.$inferSelect;
