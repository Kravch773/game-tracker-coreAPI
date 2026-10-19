export const CATALOG_GENRES = [
  { id: "rpg", igdbId: 12 },
  { id: "shooter", igdbId: 5 },
  { id: "adventure", igdbId: 31 },
  { id: "strategy", igdbId: 15 },
  { id: "indie", igdbId: 32 },
  { id: "racing", igdbId: 10 },
] as const;

export const SEARCH_GENRES = [
  ...CATALOG_GENRES,
  { id: "fighting", igdbId: 4 },
  { id: "platform", igdbId: 8 },
  { id: "puzzle", igdbId: 9 },
  { id: "sport", igdbId: 14 },
  { id: "simulator", igdbId: 13 },
  { id: "hack-and-slash", igdbId: 25 },
  { id: "tactical", igdbId: 24 },
  { id: "rts", igdbId: 11 },
  { id: "tbs", igdbId: 16 },
  { id: "music", igdbId: 7 },
  { id: "arcade", igdbId: 33 },
  { id: "visual-novel", igdbId: 34 },
  { id: "moba", igdbId: 36 },
  { id: "card", igdbId: 35 },
  { id: "point-and-click", igdbId: 2 },
  { id: "quiz", igdbId: 26 },
  { id: "pinball", igdbId: 30 },
] as const;

export const CATALOG_PLATFORMS = [
  { id: "pc", igdbId: 6, name: "PC (Microsoft Windows)" },
  { id: "ps5", igdbId: 167, name: "PlayStation 5" },
  { id: "ps4", igdbId: 48, name: "PlayStation 4" },
  { id: "xbox-series", igdbId: 169, name: "Xbox Series X|S" },
  { id: "xbox-one", igdbId: 49, name: "Xbox One" },
  { id: "switch", igdbId: 130, name: "Nintendo Switch" },
] as const;

export type CatalogGenreId = (typeof CATALOG_GENRES)[number]["id"];
export type SearchGenreId = (typeof SEARCH_GENRES)[number]["id"];
export type CatalogPlatformId = (typeof CATALOG_PLATFORMS)[number]["id"];

export function catalogGenre(id: string) {
  return SEARCH_GENRES.find((item) => item.id === id) ?? null;
}

export function catalogPlatform(id: string) {
  return CATALOG_PLATFORMS.find((item) => item.id === id) ?? null;
}
