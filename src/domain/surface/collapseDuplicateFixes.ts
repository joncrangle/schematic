/**
 * Shared reduction for vehicle feeds that report one bus more than once. Each
 * feed family decides what makes two fixes the same bus (a trip id for
 * GTFS-RT, an identical position for AnyRide) and which copy to keep. This
 * module owns the fold and the id ordering, so the two cannot drift.
 */

/** Lowest vehicle id: numeric when both are plain integers, otherwise lexical. */
export function compareVehicleIds(first: string, second: string): number {
  if (/^\d+$/.test(first) && /^\d+$/.test(second)) {
    const difference = BigInt(first) - BigInt(second);
    return difference < 0n ? -1 : difference > 0n ? 1 : 0;
  }
  return first < second ? -1 : first > second ? 1 : 0;
}

/**
 * Keeps one item per non-empty key. `isPreferred` decides whether a later
 * candidate replaces the item kept so far. Items without a key pass through
 * untouched, and surviving items keep the position of the key's first sighting.
 */
export function collapseByKey<T>(
  items: readonly T[],
  keyOf: (item: T) => string | undefined,
  isPreferred: (candidate: T, kept: T) => boolean,
): T[] {
  const indexByKey = new Map<string, number>();
  const out: T[] = [];
  for (const item of items) {
    const key = keyOf(item);
    if (!key) {
      out.push(item);
      continue;
    }
    const index = indexByKey.get(key);
    if (index === undefined) {
      indexByKey.set(key, out.length);
      out.push(item);
    } else if (isPreferred(item, out[index]!)) {
      out[index] = item;
    }
  }
  return out;
}
