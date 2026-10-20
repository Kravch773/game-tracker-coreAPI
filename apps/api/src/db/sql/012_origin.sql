ALTER TABLE game_details
  ADD COLUMN IF NOT EXISTS ukrainian_text boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ukrainian_audio boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS curator_apps (
  list text NOT NULL,
  app_id text NOT NULL,
  PRIMARY KEY (list, app_id)
);

CREATE INDEX IF NOT EXISTS curator_apps_app_idx ON curator_apps (app_id);

CREATE TABLE IF NOT EXISTS curator_meta (
  id text PRIMARY KEY,
  fetched_at timestamptz NOT NULL
);
