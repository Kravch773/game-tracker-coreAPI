-- PlayStation Store and Xbox Store pages, taken from IGDB external games.
ALTER TABLE game_links DROP CONSTRAINT IF EXISTS game_links_kind_check;
ALTER TABLE game_links ADD CONSTRAINT game_links_kind_check CHECK (
  kind IN ('steam', 'gog', 'epic', 'playstation', 'xbox', 'official', 'wikipedia', 'metacritic')
);
