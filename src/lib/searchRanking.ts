/**
 * Compares two items based on search query matching priority:
 * 1. Exact match (case-insensitive) on any exact key
 * 2. Prefix match (case-insensitive) on any prefix key
 * Returns negative if a ranks before b, positive if b ranks before a, or 0 if tied.
 */
export function compareSearchRank(
  query: string,
  aKeys: { readonly exact?: readonly string[]; readonly prefix?: readonly string[] },
  bKeys: { readonly exact?: readonly string[]; readonly prefix?: readonly string[] },
): number {
  const q = query.trim().toLowerCase();
  if (!q) return 0;

  const aExact = aKeys.exact?.some((k) => k.toLowerCase() === q) ?? false;
  const bExact = bKeys.exact?.some((k) => k.toLowerCase() === q) ?? false;
  if (aExact && !bExact) return -1;
  if (!aExact && bExact) return 1;

  const aStarts = aKeys.prefix?.some((k) => k.toLowerCase().startsWith(q)) ?? false;
  const bStarts = bKeys.prefix?.some((k) => k.toLowerCase().startsWith(q)) ?? false;
  if (aStarts && !bStarts) return -1;
  if (!aStarts && bStarts) return 1;

  return 0;
}
