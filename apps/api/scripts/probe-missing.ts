import { queryIgdbGames } from "../src/igdb/client.js";

const titles = [
  "Elden Ring: Shadow of the Erdtree",
  "Mass Effect Legendary Edition",
  "Uncharted: Legacy of Thieves Collection",
  "Uncharted: The Nathan Drake Collection",
  "Gothic II: The Night of the Raven",
  "Dark Souls II: Scholar of the First Sin",
  "Resident Evil 4: Separate Ways",
];

for (const title of titles) {
  const body = [
    `search "${title}";`,
    "fields name,game_type,version_parent,parent_game;",
    "limit 8;",
  ].join("\n");
  const games = await queryIgdbGames(body);
  console.log("\n" + title);
  for (const game of games) {
    const row = game as {
      name?: string;
      game_type?: number;
      version_parent?: number;
      parent_game?: number;
    };
    console.log(
      [row.game_type ?? "-", row.version_parent ? "edition" : "base", row.parent_game ? "child" : "solo", row.name].join(
        " | ",
      ),
    );
  }
  if (games.length === 0) console.log("none");
}
