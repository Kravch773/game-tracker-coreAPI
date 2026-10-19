CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE IF NOT EXISTS games (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  igdb_id integer NOT NULL UNIQUE,
  slug text NOT NULL UNIQUE,
  title text NOT NULL,
  summary text,
  cover_url text,
  release_date date,
  platforms jsonb NOT NULL DEFAULT '[]'::jsonb,
  metacritic_score integer,
  metacritic_checked_at timestamptz,
  fetched_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS games_title_trgm_idx
  ON games USING gin (lower(title) gin_trgm_ops);

CREATE TABLE IF NOT EXISTS game_links (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  kind text NOT NULL,
  url text NOT NULL,
  external_id text,
  source text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT game_links_kind_check CHECK (
    kind IN ('steam', 'gog', 'epic', 'official', 'wikipedia', 'metacritic')
  ),
  CONSTRAINT game_links_source_check CHECK (source IN ('igdb', 'rawg', 'manual')),
  CONSTRAINT game_links_game_kind_idx UNIQUE (game_id, kind)
);

CREATE TABLE IF NOT EXISTS search_cache (
  query text PRIMARY KEY,
  game_ids uuid[] NOT NULL,
  fetched_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE,
  username text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS list_entries (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  status text NOT NULL,
  rating integer,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id),
  CONSTRAINT list_entries_status_check CHECK (
    status IN ('playing', 'finished', 'dropped', 'on_hold', 'wishlist')
  )
);
