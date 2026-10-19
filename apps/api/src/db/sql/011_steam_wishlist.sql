CREATE TABLE IF NOT EXISTS steam_wishes (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id)
);

CREATE TABLE IF NOT EXISTS steam_wish_missing (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  app_id text NOT NULL,
  title text,
  synced_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, app_id)
);
