/**
 * Identity-preserving list reconciliation for query-backed rendering.
 *
 * The @tanstack/solid-query adapter force-disables TanStack's structural
 * sharing, so every poll delivers a fully fresh object graph. Solid's `<For>`
 * diffs by reference: feeding it those raw arrays tears down and recreates
 * every card on each refresh, which resets countdown ticker phase (each
 * useLiveCountdown interval restarts on mount).
 *
 * stableList walks the incoming items once, reusing the previous tick's object
 * whenever an item's rendered-relevant fields compare equal, adopting the
 * fresh payload otherwise. Output preserves input order; downstream sorting
 * and filtering keep working because they only reorder/exclude stabilized
 * instances.
 *
 * `byKey` is rebuilt from the CURRENT items on every call, so keys that
 * disappeared are evicted and empty input yields an empty map. This is
 * intentional: unlike a component-scope accumulator that grows forever, the
 * map mirrors exactly what is rendered.
 */

export interface StableList<T> {
  /** Stabilized items in input order; safe to feed straight to `<For>`. */
  readonly items: readonly T[];
  /** Key → stabilized instance for this call; feeds back in as `previous`. */
  readonly byKey: ReadonlyMap<string, T>;
}

/** Equality for ordered lists whose records already preserve identity. */
export function sameListItems<T>(a: readonly T[], b: readonly T[]): boolean {
  return a.length === b.length && a.every((item, index) => item === b[index]);
}

/**
 * Reconciles `items` against `previous` so field-equal items keep their prior
 * object identity.
 *
 * Duplicate keys: every occurrence stabilizes against the same previous entry,
 * and `byKey` keeps the LAST occurrence (Map.set semantics), mirroring
 * keyListById.
 */
export function stableList<T>(
  items: readonly T[],
  previous: ReadonlyMap<string, T>,
  options: { getKey: (item: T) => string; isEqual: (a: T, b: T) => boolean },
): StableList<T> {
  const { getKey, isEqual } = options;
  const stabilized: T[] = [];
  const byKey = new Map<string, T>();

  for (const item of items) {
    const key = getKey(item);
    const existing = previous.get(key);
    const kept = existing !== undefined && isEqual(existing, item) ? existing : item;
    stabilized.push(kept);
    byKey.set(key, kept);
  }

  return { items: stabilized, byKey };
}
