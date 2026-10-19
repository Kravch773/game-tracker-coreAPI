import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import type { GameLinkRow, GameRow } from "../db/schema.js";
import { gameLinks, games } from "../db/schema.js";
import { env, rawgConfigured } from "../env.js";

type RawgGame = {
  id: number;
  name: string;
  metacritic: number | null;
  metacritic_url?: string | null;
};

const inFlight = new Set<string>();

export function scheduleMetacriticEnrich(game: GameRow, links: GameLinkRow[]): void {
  if (!shouldEnrich(game, links) || inFlight.has(game.id)) return;
  inFlight.add(game.id);
  void enrichMetacritic(game.id, game.title)
    .catch((error: unknown) => {
      console.error("Metacritic enrichment failed", error);
    })
    .finally(() => {
      inFlight.delete(game.id);
    });
}

function shouldEnrich(game: GameRow, links: GameLinkRow[]): boolean {
  return (
    rawgConfigured() &&
    game.metacriticCheckedAt === null &&
    game.metacriticScore === null &&
    !links.some((link) => link.kind === "metacritic")
  );
}

async function enrichMetacritic(gameId: string, title: string): Promise<void> {
  const match = await findExactRawgGame(title);
  const now = new Date();

  if (!match) {
    await db.update(games).set({ metacriticCheckedAt: now }).where(eq(games.id, gameId));
    return;
  }

  const url = match.metacritic_url ?? (await metacriticUrl(match));
  await db.transaction(async (tx) => {
    await tx
      .update(games)
      .set({
        metacriticScore: match.metacritic,
        metacriticCheckedAt: now,
        updatedAt: now,
      })
      .where(eq(games.id, gameId));

    if (url) {
      await tx
        .insert(gameLinks)
        .values({
          gameId,
          kind: "metacritic",
          url,
          externalId: null,
          source: "rawg",
        })
        .onConflictDoNothing({ target: [gameLinks.gameId, gameLinks.kind] });
    }
  });
}

export async function findExactRawgGame(title: string): Promise<RawgGame | null> {
  const url = new URL("https://api.rawg.io/api/games");
  url.searchParams.set("key", env.rawgApiKey);
  url.searchParams.set("search", title);
  url.searchParams.set("page_size", "5");
  url.searchParams.set("search_precise", "true");

  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) {
    throw new Error(`RAWG search failed with ${response.status}`);
  }

  const payload = (await response.json()) as { results?: RawgGame[] };
  const wanted = title.trim().toLowerCase();
  return payload.results?.find((game) => game.name.trim().toLowerCase() === wanted) ?? null;
}

async function metacriticUrl(game: RawgGame): Promise<string | null> {
  if (game.metacritic == null) return null;

  const url = new URL(`https://api.rawg.io/api/games/${game.id}`);
  url.searchParams.set("key", env.rawgApiKey);
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return null;

  const details = (await response.json()) as { metacritic_url?: string | null };
  return details.metacritic_url?.trim() || null;
}
