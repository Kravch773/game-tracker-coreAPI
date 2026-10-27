-- Series now come from IGDB collections (franchises only as a fallback), so the franchise-based cache is dropped.
DELETE FROM game_franchises;
DELETE FROM franchise_games;
