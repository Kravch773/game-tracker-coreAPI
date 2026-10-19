ALTER TABLE list_entries DROP CONSTRAINT IF EXISTS list_entries_status_check;

ALTER TABLE list_entries ADD CONSTRAINT list_entries_status_check CHECK (
  status IN ('playing', 'finished', 'dropped', 'backlog')
);

ALTER TABLE list_entries RENAME COLUMN note TO review;

ALTER TABLE list_entries DROP CONSTRAINT IF EXISTS list_entries_rating_check;
ALTER TABLE list_entries ADD CONSTRAINT list_entries_rating_check CHECK (
  rating IS NULL OR (rating BETWEEN 1 AND 11)
);

ALTER TABLE list_entries DROP CONSTRAINT IF EXISTS list_entries_review_length_check;
ALTER TABLE list_entries ADD CONSTRAINT list_entries_review_length_check CHECK (
  review IS NULL OR char_length(review) <= 2000
);

ALTER TABLE list_entries DROP CONSTRAINT IF EXISTS list_entries_review_status_check;
ALTER TABLE list_entries ADD CONSTRAINT list_entries_review_status_check CHECK (
  status IN ('finished', 'dropped') OR (rating IS NULL AND review IS NULL)
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (lower(email));
CREATE UNIQUE INDEX IF NOT EXISTS users_username_lower_idx ON users (lower(username));

CREATE TABLE IF NOT EXISTS favorites (
  user_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  game_id uuid NOT NULL REFERENCES games (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, game_id)
);
