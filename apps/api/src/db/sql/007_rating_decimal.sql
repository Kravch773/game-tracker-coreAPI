ALTER TABLE list_entries DROP CONSTRAINT IF EXISTS list_entries_rating_check;
ALTER TABLE list_entries ALTER COLUMN rating TYPE numeric(3, 1);
ALTER TABLE list_entries ADD CONSTRAINT list_entries_rating_check CHECK (
  rating IS NULL OR (rating >= 1 AND rating <= 11)
);
