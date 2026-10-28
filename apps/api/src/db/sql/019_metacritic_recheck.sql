-- Titles that missed RAWG over punctuation were marked as checked; let the next page visit look them up again.
UPDATE games SET metacritic_checked_at = NULL WHERE metacritic_score IS NULL;
