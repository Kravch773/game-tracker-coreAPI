import { eq } from "drizzle-orm";
import { db } from "../db/client.js";
import type { GameLinkRow, GameRow } from "../db/schema.js";
import { gameLinks, games } from "../db/schema.js";
import { env, rawgConfigured } from "../env.js";
import { loose } from "../games/text.js";

type RawgGame = {
  id: number;
  name: string;
  metacritic: number | null;
  metacritic_url?: string | null;
};

const inFlight = new Set<string>();
// A game without a score is asked about again after this long: new releases get their Metacritic score weeks later.
const RECHECK_MS = 14 * 24 * 60 * 60 * 1000;

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
    (game.metacriticCheckedAt === null || Date.now() - game.metacriticCheckedAt.getTime() > RECHECK_MS) &&
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
  const results = payload.results ?? [];
  const wanted = title.trim().toLowerCase();
  const folded = loose(title);
  // RAWG and IGDB punctuate titles differently ("Mass Effect: Legendary Edition", curly apostrophes), so an
  // exact match comes first and a match ignoring punctuation and spaces is the fallback.
  return (
    results.find((game) => game.name.trim().toLowerCase() === wanted) ??
    (folded.length > 0 ? results.find((game) => loose(game.name) === folded) : undefined) ??
    null
  );
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
