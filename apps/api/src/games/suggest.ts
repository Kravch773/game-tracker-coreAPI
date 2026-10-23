import { sql } from "../db/client.js";
import { loose } from "./text.js";

export type CreditField = "developer" | "publisher" | "series";

const FOLD = "'[^a-z0-9а-яіїєґё]+'";

export async function suggestCredits(field: CreditField, query: string): Promise<string[]> {
  const folded = loose(query.trim().slice(0, 80));
  const needle = folded.length >= 2 ? folded : "";
  if (field === "series") return suggestSeries(needle);
  return suggestCompanies(field, needle);
}

async function suggestSeries(folded: string): Promise<string[]> {
  const rows = await sql<{ name: string }[]>`
    SELECT name
    FROM (
      SELECT btrim(series) AS name,
             count(*) AS games,
             regexp_replace(lower(btrim(series)), ${sql.unsafe(FOLD)}, '', 'g') AS folded
      FROM game_details
      WHERE series IS NOT NULL AND char_length(btrim(series)) >= 2
      GROUP BY btrim(series)
    ) names
    WHERE ${folded} = '' OR folded LIKE ${"%" + folded + "%"}
    ORDER BY
      CASE
        WHEN ${folded} = '' THEN 0
        WHEN folded = ${folded} THEN 0
        WHEN folded LIKE ${folded + "%"} THEN 1
        ELSE 2
      END,
      games DESC,
      name ASC
    LIMIT 10
  `;
  return rows.map((row) => row.name);
}

async function suggestCompanies(field: "developer" | "publisher", folded: string): Promise<string[]> {
  const column = sql.unsafe(field === "developer" ? "developers" : "publishers");
  const rows = await sql<{ name: string }[]>`
    SELECT name
    FROM (
      SELECT btrim(value) AS name,
             count(*) AS games,
             regexp_replace(lower(btrim(value)), ${sql.unsafe(FOLD)}, '', 'g') AS folded
      FROM game_details
      CROSS JOIN LATERAL jsonb_array_elements_text(${column}) AS value
      WHERE char_length(btrim(value)) >= 2
      GROUP BY btrim(value)
    ) names
    WHERE ${folded} = '' OR folded LIKE ${"%" + folded + "%"}
    ORDER BY
      CASE
        WHEN ${folded} = '' THEN 0
        WHEN folded = ${folded} THEN 0
        WHEN folded LIKE ${folded + "%"} THEN 1
        ELSE 2
      END,
      games DESC,
      name ASC
    LIMIT 10
  `;
  return rows.map((row) => row.name);
}
