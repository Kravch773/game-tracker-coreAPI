-- Search now matches sequel numbers both ways (3 and III), accents, "&" and acronyms, and orders by how closely
-- titles match; cached results were ordered the old way, so they all go.
DELETE FROM search_cache;
