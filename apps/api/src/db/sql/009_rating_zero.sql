ALTER TABLE list_entries DROP CONSTRAINT IF EXISTS list_entries_rating_check;
ALTER TABLE list_entries ADD CONSTRAINT list_entries_rating_check CHECK (
  rating IS NULL OR (rating >= 0 AND rating <= 11)
);
