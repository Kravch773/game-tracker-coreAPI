CREATE TABLE IF NOT EXISTS game_trailers (
  game_id uuid PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
  rawg_id integer,
  trailers jsonb NOT NULL DEFAULT '[]'::jsonb,
  fetched_at timestamptz NOT NULL
);
