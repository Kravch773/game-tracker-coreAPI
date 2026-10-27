CREATE TABLE IF NOT EXISTS game_franchises (
  game_id uuid PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
  franchise_id integer,
  franchise_name text,
  fetched_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS game_franchises_franchise_idx ON game_franchises (franchise_id);

CREATE TABLE IF NOT EXISTS franchise_games (
  franchise_id integer PRIMARY KEY,
  games jsonb NOT NULL,
  fetched_at timestamptz NOT NULL
);
