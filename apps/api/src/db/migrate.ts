import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type postgres from "postgres";

const sqlDir = resolve(dirname(fileURLToPath(import.meta.url)), "sql");
const migrations = ["001_init", "002_game_details", "003_game_trailers", "004_library", "005_collections", "006_profile", "007_rating_decimal", "008_review_any_status", "009_rating_zero", "010_steam", "011_steam_wishlist", "012_origin", "013_origin_studios"] as const;

export async function migrate(sql: postgres.Sql): Promise<void> {
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  for (const id of migrations) {
    const applied = await sql<{ id: string }[]>`
      SELECT id FROM schema_migrations WHERE id = ${id}
    `;
    if (applied.length > 0) continue;

    const script = readFileSync(resolve(sqlDir, `${id}.sql`), "utf8");
    await sql.begin(async (tx) => {
      await tx.unsafe(script);
      await tx`INSERT INTO schema_migrations (id) VALUES (${id})`;
    });
  }
}
