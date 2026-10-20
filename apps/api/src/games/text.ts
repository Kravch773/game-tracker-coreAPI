export function loose(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9\u0400-\u04ff]+/gi, "");
}

export function looseIncludes(value: string, needle: string): boolean {
  const query = needle.trim().toLowerCase();
  if (query.length < 2) return false;
  if (value.toLowerCase().includes(query)) return true;
  const folded = loose(needle);
  return folded.length >= 2 && loose(value).includes(folded);
}
