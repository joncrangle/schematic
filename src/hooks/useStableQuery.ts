import { createMemo } from "solid-js";
import { hashKey, useQuery, keepPreviousData, type UseQueryResult } from "@tanstack/solid-query";
import { sameListItems, stableList } from "~/lib/stableList";
import { queryClient } from "~/lib/queryClient";
import { useSettledQueryData } from "~/hooks/useSettledQueryData";

/**
 * Query wrapper that owns the Nearby panel's shared polling config plus
 * app-side identity stabilization.
 *
 * The @tanstack/solid-query adapter force-disables TanStack's structural
 * sharing, so every poll delivers a fresh object graph. This hook runs each
 * result through stableList so field-equal items keep their prior reference —
 * Solid's `<For>` diffs by reference, and remounted cards restart their
 * countdown ticker phase. One instance-scoped previous-key map per call,
 * rebuilt from the current list every tick (disappeared keys evict).
 *
 * Shared cadence lives here once: refetchInterval 15s, settled cache data keeps
 * the last good list rendering during background refreshes. staleTime is
 * intentionally NOT set, the shared QueryClient default (30s) covers it.
 *
 * Invariant: a DISABLED stable query surfaces NO items, even while its
 * settled cache value remains available for the next opening.
 */

export interface StableQueryOptions<T> {
  readonly queryKey: readonly unknown[];
  readonly queryFn: () => Promise<T[]>;
  readonly enabled?: boolean;
  /** Stable domain key driving identity across refetches. */
  readonly getKey: (item: T) => string;
  /** Rendered-relevance equality; true ⇒ previous object is reused. */
  readonly isEqual: (a: T, b: T) => boolean;
}

export interface StableQuery<T> {
  /** Raw query result, status flags, error, data, refetch for panel-local state conjunctions. */
  readonly query: UseQueryResult<T[], Error>;
  /** Stabilized items in payload order; safe to feed straight to `<For>`. */
  readonly items: () => readonly T[];
}

export function useStableQuery<T>(options: () => StableQueryOptions<T>): StableQuery<T> {
  // Query functions capture their inputs, which are represented by queryKey.
  // Location receipt/status updates can recreate equivalent keys and closures.
  // Stop those updates before they restart the adapter's async projections or
  // relay observer metadata through its options effect.
  const stableOptions = createMemo(options, {
    // Inactive families have no data to expose or request to issue. Keep their
    // observer parked until enabled, then adopt the latest complete identity.
    equals: (a, b) =>
      (a.enabled === false && b.enabled === false) ||
      (a.enabled === b.enabled && hashKey(a.queryKey) === hashKey(b.queryKey)),
  });
  const query = useQuery<T[], Error>(
    () => ({
      queryKey: stableOptions().queryKey,
      queryFn: stableOptions().queryFn,
      enabled: stableOptions().enabled,
      refetchInterval: 15_000,
      placeholderData: keepPreviousData,
    }),
    () => queryClient,
  );

  // Same tolerated mutate-in-memo pattern as the four clones this replaces:
  // the map is written as a side effect of deriving items, centralized here.
  let previousByKey: ReadonlyMap<string, T> = new Map();
  const settledData = useSettledQueryData<T[]>(() =>
    stableOptions().enabled === false ? undefined : stableOptions().queryKey,
  );

  const items = createMemo(
    () => {
      // A disabled stable query surfaces no items: when its own gate
      // (e.g. the per-kind favourite gates) turns off, cached data must
      // not flow through, placeholderData never gets to resurrect it. The
      // previous-key map is left untouched so re-enabling preserves documented
      // re-entry identity semantics.
      if (stableOptions().enabled === false) return [];
      // Track cache settlements through synchronous events. The v6 data
      // projection suspends during refetches, which can hold the panel's open
      // or close transition even when cached departures are available. Nearby
      // owns loading and error presentation, so read its last settled cache
      // value without subscribing the list to that async projection.
      const settled = settledData() ?? [];
      const stabilized = stableList(settled, previousByKey, {
        getKey: stableOptions().getKey,
        isEqual: stableOptions().isEqual,
      });
      previousByKey = stabilized.byKey;
      return stabilized.items;
    },
    { equals: sameListItems },
  );

  return { query, items };
}
