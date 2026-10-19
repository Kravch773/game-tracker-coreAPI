ALTER TABLE users ADD COLUMN IF NOT EXISTS steam_id text;
CREATE UNIQUE INDEX IF NOT EXISTS users_steam_id_idx ON users (steam_id);

CREATE TABLE IF NOT EXISTS steam_plays (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  playtime_minutes integer NOT NULL,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id)
);
