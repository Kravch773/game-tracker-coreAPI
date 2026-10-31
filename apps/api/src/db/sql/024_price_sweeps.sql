-- The daily price sweep, one row per day so a restart resumes it instead of starting over or running twice,
-- and when each game page was last opened, so the sweep also covers games people look at.
CREATE TABLE IF NOT EXISTS price_sweeps (
  day date PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  games integer
);

CREATE TABLE IF NOT EXISTS price_watch (
  game_id uuid PRIMARY KEY REFERENCES games (id) ON DELETE CASCADE,
  viewed_at timestamptz NOT NULL
);
