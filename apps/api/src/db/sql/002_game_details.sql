CREATE TABLE IF NOT EXISTS game_details (
  game_id uuid PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
  storyline text,
  igdb_rating real,
  genres jsonb NOT NULL DEFAULT '[]'::jsonb,
  screenshots jsonb NOT NULL DEFAULT '[]'::jsonb,
  videos jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL
);
