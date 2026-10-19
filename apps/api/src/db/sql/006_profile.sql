ALTER TABLE game_details ADD COLUMN IF NOT EXISTS developers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE game_details ADD COLUMN IF NOT EXISTS publishers jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE game_details ADD COLUMN IF NOT EXISTS themes jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE game_details ADD COLUMN IF NOT EXISTS age_ratings jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE game_details ADD COLUMN IF NOT EXISTS time_to_beat jsonb;
ALTER TABLE game_details ADD COLUMN IF NOT EXISTS similar_igdb_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE game_details ADD COLUMN IF NOT EXISTS detail_version integer NOT NULL DEFAULT 1;

ALTER TABLE list_entries ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE list_entries ADD COLUMN IF NOT EXISTS finished_at timestamptz;

CREATE TABLE IF NOT EXISTS follows (
  follower_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  following_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, following_id),
  CONSTRAINT follows_not_self CHECK (follower_id <> following_id)
);

DELETE FROM collection_cache
WHERE key IN ('rpg', 'shooter', 'adventure', 'strategy', 'indie', 'racing');
