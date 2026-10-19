import { queryIgdbGames } from "../src/igdb/client.js";

const titles = [
  "Elden Ring: Shadow of the Erdtree",
  "Shadow of the Erdtree",
  "Gothic II: The Night of the Raven",
  "Night of the Raven",
  "Resident Evil 4: Separate Ways",
  "Separate Ways",
  "Mass Effect Legendary Edition",
  "Dark Souls II: Scholar of the First Sin",
  "Scholar of the First Sin",
];

for (const title of titles) {
  const body = [
    `search "${title}";`,
    "fields name,game_type;",
    "where game_type = (0,1,2,4,8,9) & version_parent = null;",
    "limit 8;",
  ].join("\n");
  const games = await queryIgdbGames(body);
  console.log("\n" + title);
  for (const game of games) {
    const row = game as { name?: string; game_type?: number };
    console.log(`${row.game_type} | ${row.name}`);
  }
  if (games.length === 0) console.log("none");
}
