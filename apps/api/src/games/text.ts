export function loose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9Ѐ-ӿ]+/gi, "");
}

// Titles and queries are compared in one shape: no accents ("Pokémon", "Ragnarök"), "&" read as "and", and
// whole-word Roman numerals up to XX as their Arabic number ("Baldur's Gate III" is "Baldur's Gate 3").
export function searchForm(value: string): string {
  return arabicNumerals(
    value
      .normalize("NFD")
      .replace(/\p{M}+/gu, "")
      .toLowerCase()
      .replace(/\s*&\s*/g, " and "),
  );
}

// A title matches when it holds the query as typed (punctuation and spaces aside) or holds its words in order,
// each at the start of a word, so "red dead 2" finds "Red Dead Redemption 2".
export function looseIncludes(value: string, needle: string): boolean {
  const query = searchForm(needle.trim());
  if (query.length < 2) return false;
  const title = searchForm(value);
  // A few letters turn up inside all sorts of words ("gta" in "SpringTale"), so a short query must start a word.
  if (loose(query).length < 4) return matchTier(value, needle) < 3;
  if (title.includes(query)) return true;
  const folded = loose(query);
  if (folded.length >= 2 && loose(title).includes(folded)) return true;
  const words = wordsOf(query);
  if (words.length < 2) return false;
  const titleWords = wordsOf(title);
  let at = 0;
  for (const word of words) {
    while (at < titleWords.length && !titleWords[at].startsWith(word)) at += 1;
    if (at === titleWords.length) return false;
    at += 1;
  }
  return true;
}

// How closely a title answers the query: 0 the title itself, 1 the title starts with it, 2 one of its words
// does, 3 anything looser. A leading "The" is ignored.
export function matchTier(value: string, needle: string): 0 | 1 | 2 | 3 {
  const query = loose(withoutArticle(searchForm(needle)));
  const title = withoutArticle(searchForm(value));
  if (!query) return 3;
  if (loose(title) === query) return 0;
  if (loose(title).startsWith(query)) return 1;
  const words = wordsOf(title);
  for (let index = 1; index < words.length; index += 1) {
    if (words.slice(index).join("").startsWith(query)) return 2;
  }
  return 3;
}

// Popularity counts in orders of magnitude and a looser match costs some of it, so a famous game whose word
// merely starts with the query ("Marvel's Spider-Man") still beats an obscure exact title, but not a close one.
const TIER_COST = [0, 0.5, 1.5, 3];

export function matchScore(tier: number, popularity: number): number {
  return Math.log1p(Math.max(0, popularity)) - (TIER_COST[tier] ?? 3);
}

// Other spellings worth asking IGDB for: sequel numbers the other way ("3" and "III") and "and" for "&".
export function queryVariants(query: string): string[] {
  const variants = new Set<string>([query]);
  const numeral = numeralVariant(query);
  if (numeral) variants.add(numeral);
  for (const variant of [...variants]) {
    if (/\s&\s/.test(variant)) variants.add(variant.replace(/\s&\s/g, " and "));
    else if (/\sand\s/i.test(variant)) variants.add(variant.replace(/\sand\s/gi, " & "));
  }
  variants.delete(query);
  return [...variants].slice(0, 3);
}

// The same query with its sequel numbers written the other way, or null when it has none: "baldur's gate 3"
// gives "baldur's gate iii" and back.
export function numeralVariant(query: string): string | null {
  const flipped = query.replace(NUMERAL_WORD, (word) => {
    const lower = word.toLowerCase();
    if (/^\d+$/.test(lower)) {
      const number = Number(lower);
      return number >= 1 && number < ROMAN.length ? ROMAN[number] : word;
    }
    const number = ROMAN.indexOf(lower);
    return number > 0 ? String(number) : word;
  });
  return flipped === query ? null : flipped;
}

const ROMAN = ["", "i", "ii", "iii", "iv", "v", "vi", "vii", "viii", "ix", "x", "xi", "xii", "xiii", "xiv", "xv", "xvi", "xvii", "xviii", "xix", "xx"];
const NUMERAL_WORD = /(?<![\p{L}\p{N}])(?:\d+|[ivx]+)(?![\p{L}\p{N}])/giu;

function arabicNumerals(value: string): string {
  return value.replace(NUMERAL_WORD, (word) => {
    const number = ROMAN.indexOf(word.toLowerCase());
    return number > 0 ? String(number) : word;
  });
}

function wordsOf(value: string): string[] {
  return value.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function withoutArticle(value: string): string {
  return value.replace(/^the\s+/, "");
}
