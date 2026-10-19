import { queryIgdbGames } from "../src/igdb/client.js";

const queries = [
  `search "Phantom Liberty"; fields name,game_type,parent_game.name; where game_type = (0,1,2,4,8,9) & version_parent = null; limit 15;`,
  `search "Phantom Liberty"; fields name,game_type; where game_type = (0,8,9) & version_parent = null; limit 15;`,
  `fields name,game_type,parent_game.name; where name ~ *"Phantom Liberty"* & game_type = (0,1,2,4,8,9); limit 15;`,
];

for (const body of queries) {
  const games = await queryIgdbGames(body);
  console.log("---");
  for (const game of games) {
    const row = game as { name?: string; game_type?: number; parent_game?: { name?: string } };
    console.log([row.game_type, row.name, row.parent_game?.name].filter(Boolean).join(" | "));
  }
  if (games.length === 0) console.log("none");
}
