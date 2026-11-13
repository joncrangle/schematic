/**
 * Stable-identity keying for list rendering.
 *
 * Live tracking renewals produce fresh object graphs on every fetch (new
 * `RouteTrackingData`, new stop/vehicle objects). Solid's `<For>` diffs by
 * reference, so feeding it raw per-fetch arrays tears down and recreates every
 * DOM node each tick, measured as 100ms+ main-thread janks on the targeted
 * route overlay and broken CSS motion transitions on vehicle markers.
 *
 * Keying by a stable domain id (`vehicleId`, `stop.id`) splits each list into
 * a primitive `ids` array (identical strings are referentially equal, so
 * `<For>` patches in place) plus an id → entry map that render closures read
 * through reactive accessors for the latest payload.
 */

export interface KeyedList<T> {
  /** Stable keys in first-appearance order; drives `<For each={...}>`. */
  readonly ids: readonly string[];
  /** Latest entry per key; render closures look up through this. */
  readonly byId: ReadonlyMap<string, T>;
}

/**
 * Groups `items` into a {@link KeyedList} keyed by `getKey`.
 *
 * Duplicate keys keep the LAST occurrence (Map.set semantics), matching how a
 * feed resending the same vehicle id supersedes its earlier snapshot.
 */
export function keyListById<T>(items: readonly T[], getKey: (item: T) => string): KeyedList<T> {
  const byId = new Map<string, T>();
  const ids: string[] = [];

  for (const item of items) {
    const key = getKey(item);
    if (!byId.has(key)) {
      ids.push(key);
    }
    byId.set(key, item);
  }

  return { ids, byId };
}
