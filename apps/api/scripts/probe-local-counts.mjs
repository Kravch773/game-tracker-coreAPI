import postgres from "postgres";

const sql = postgres("postgres://gametracker:gametracker@localhost:5432/gametracker");
const queries = [
  "elden ring: shadow of the erdtree",
  "mass effect legendary edition",
  "uncharted: legacy of thieves collection",
  "uncharted: the nathan drake collection",
  "gothic ii: the night of the raven",
  "dark souls ii: scholar of the first sin",
  "resident evil 4: separate ways",
];
for (const query of queries) {
  const rows = await sql`
    select title from games
    where similarity(lower(title), ${query}) > 0.25
       or title ilike ${"%" + query + "%"}
    limit 8
  `;
  const cached = await sql`select query from search_cache where query ilike ${"%" + query + "%"}`;
  console.log(query, "local", rows.length, "cache", cached.map((row) => row.query).join(",") || "-");
}
await sql.end();
