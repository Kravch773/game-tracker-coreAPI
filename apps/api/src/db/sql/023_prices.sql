-- Store prices per game, store and region, the daily low of each, and how each user wants to hear about sales.
CREATE TABLE IF NOT EXISTS game_prices (
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  store text NOT NULL,
  region text NOT NULL,
  currency text,
  amount integer,
  base integer,
  cut integer NOT NULL DEFAULT 0,
  ends_at timestamptz,
  sale_since timestamptz,
  url text,
  checked_at timestamptz NOT NULL,
  PRIMARY KEY (game_id, store, region)
);

CREATE TABLE IF NOT EXISTS price_history (
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  store text NOT NULL,
  region text NOT NULL,
  currency text NOT NULL,
  amount integer NOT NULL,
  base integer NOT NULL,
  seen_on date NOT NULL,
  PRIMARY KEY (game_id, store, region, seen_on)
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS deal_alerts boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deal_min_cut integer NOT NULL DEFAULT 10;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deal_wishlist boolean NOT NULL DEFAULT true;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deals_seen_at timestamptz;
