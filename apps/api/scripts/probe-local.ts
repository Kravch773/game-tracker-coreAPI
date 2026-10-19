import postgres from "postgres";

const sql = postgres(process.env.DATABASE_URL ?? "postgres://gametracker:gametracker@localhost:5432/gametracker");
const rows = await sql`
  select title from games
  where similarity(lower(title), 'phantom liberty') > 0.25
     or title ilike '%phantom liberty%'
  order by similarity(lower(title), 'phantom liberty') desc
  limit 20
`;
console.log(rows.map((row) => row.title).join("\n") || "none");
const cached = await sql`select query, cardinality(game_ids) as n from search_cache where query ilike '%phantom%'`;
console.log("cache", cached);
await sql.end();
