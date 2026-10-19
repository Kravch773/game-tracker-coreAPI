import postgres from "postgres";

const sql = postgres("postgres://gametracker:gametracker@localhost:5432/gametracker");
await sql`delete from search_cache`;
await sql`delete from games`;
console.log("reset");
await sql.end({ timeout: 1 });
