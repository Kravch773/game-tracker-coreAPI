CREATE TABLE IF NOT EXISTS collection_cache (
  key text PRIMARY KEY,
  game_ids uuid[] NOT NULL,
  fetched_at timestamptz NOT NULL
);
