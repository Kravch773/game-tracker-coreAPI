import postgres from "postgres";
import { env } from "../src/env.ts";

const sql = postgres("postgres://gametracker:gametracker@localhost:5432/gametracker");
const rows = await sql`
  select g.slug, count(l.id)::int as links
  from games g
  left join game_links l on l.game_id = g.id
  where g.title ilike 'hades%'
  group by g.slug
`;
console.log(JSON.stringify(rows));

const tokenResponse = await fetch("https://id.twitch.tv/oauth2/token", {
  method: "POST",
  body: new URLSearchParams({
    client_id: env.twitchClientId,
    client_secret: env.twitchClientSecret,
    grant_type: "client_credentials",
  }),
});
const token = (await tokenResponse.json() as { access_token: string }).access_token;
const response = await fetch("https://api.igdb.com/v4/games", {
  method: "POST",
  headers: {
    "Client-ID": env.twitchClientId,
    Authorization: `Bearer ${token}`,
    "Content-Type": "text/plain",
  },
  body: "fields websites.*; where id = 113112;",
});
console.log(await response.text());
await sql.end({ timeout: 1 });
