import * as Effect from "effect/Effect";
import type {
  TripDirectionLookup,
  TripRoute,
  TripRouteLookup,
  TripTerminal,
  TripTerminalLookup,
} from "~/domain/surface/boarding";
import type { AlertIdentityLookups } from "~/infrastructure/alerts/staticAlertIdentities";
import { logger } from "~/infrastructure/logging/logger";
import type { SurfaceDataStoreService } from "~/infrastructure/storage/SurfaceDataStore";

type StationTripStore = Pick<
  SurfaceDataStoreService,
  "getRoutesForTrips" | "getDirectionsForTrips" | "getTripTerminals"
>;

const MEMO_TTL_MS = 60 * 60 * 1000;
// A trip D1 does not know yet may appear on the next refresh, so misses expire quickly.
const MISS_TTL_MS = 120 * 1000;
const MEMO_MAX_ENTRIES = 20_000;
const INDEX_WARN_INTERVAL_MS = 10 * 60 * 1000;

// Per-isolate memo of D1 trip answers, `null` meaning D1 knows no such trip; Map order gives LRU eviction.
class TripMemo<V> {
  private readonly entries = new Map<
    string,
    { readonly expiresAt: number; readonly value: V | null }
  >();

  get(key: string): { readonly value: V | null } | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key);
    if (entry.expiresAt <= Date.now()) return undefined;
    this.entries.set(key, entry);
    return entry;
  }

  set(key: string, value: V | null): void {
    this.entries.delete(key);
    this.entries.set(key, {
      expiresAt: Date.now() + (value === null ? MISS_TTL_MS : MEMO_TTL_MS),
      value,
    });
    if (this.entries.size > MEMO_MAX_ENTRIES) {
      const oldest = this.entries.keys().next();
      if (!oldest.done) this.entries.delete(oldest.value);
    }
  }
}

const routeMemo = new TripMemo<TripRoute>();
const directionMemo = new TripMemo<number>();
const terminalMemo = new TripMemo<TripTerminal>();

// Repeat polls query D1 only for trip ids it has not answered within the TTL.
function memoizedLookup<V>(
  memo: TripMemo<V>,
  keyPrefix: string,
  tripIds: readonly string[],
  fromDatabase: (ids: readonly string[]) => Effect.Effect<ReadonlyMap<string, V>, unknown>,
): Effect.Effect<ReadonlyMap<string, V>, unknown> {
  const resolved = new Map<string, V>();
  const uncached: string[] = [];
  for (const id of tripIds) {
    const cached = memo.get(`${keyPrefix}\u0000${id}`);
    if (!cached) uncached.push(id);
    else if (cached.value !== null) resolved.set(id, cached.value);
  }
  if (uncached.length === 0) return Effect.succeed(resolved);
  return fromDatabase(uncached).pipe(
    Effect.map((found) => {
      for (const id of uncached) {
        const value = found.get(id);
        memo.set(`${keyPrefix}\u0000${id}`, value ?? null);
        if (value !== undefined) resolved.set(id, value);
      }
      return resolved;
    }),
  );
}

const lastIndexWarning = new Map<string, number>();
function warnIndexUnavailable(agencyId: string, cause: unknown): void {
  const now = Date.now();
  if (now - (lastIndexWarning.get(agencyId) ?? -Infinity) < INDEX_WARN_INTERVAL_MS) return;
  lastIndexWarning.set(agencyId, now);
  logger.warn("Static trip index unavailable; resolving trips in D1", {
    agencyId,
    cause: cause instanceof Error ? cause.message : String(cause),
  });
}

// Trips missing from the seed-time index (D1 refreshes each agency about weekly; the index only on a
// redeploy) resolve in D1 until a redeploy restores savings. Terminals are not indexed: always D1, memoized.
export function selectStationTripLookups(
  agencyId: string,
  identities: Pick<AlertIdentityLookups, "hasTripIdentities" | "getRoutesForTrips">,
  getStore: Effect.Effect<StationTripStore, unknown, never>,
): {
  readonly getRoutesForTrips: TripRouteLookup;
  readonly getDirectionsForTrips: TripDirectionLookup;
  readonly getTripTerminals: TripTerminalLookup;
} {
  const databaseRoutes = (ids: readonly string[]) =>
    memoizedLookup(routeMemo, agencyId, ids, (uncached) =>
      getStore.pipe(
        Effect.flatMap((db) =>
          db.getRoutesForTrips
            ? db.getRoutesForTrips(uncached)
            : Effect.succeed(new Map<string, TripRoute>()),
        ),
      ),
    );

  // A failed index load degrades to D1 for every trip.
  const indexedRoutes = (tripIds: readonly string[]) =>
    identities.getRoutesForTrips(tripIds).pipe(
      Effect.catch((cause) =>
        Effect.sync(() => {
          warnIndexUnavailable(agencyId, cause);
          return new Map<string, TripRoute>() as ReadonlyMap<string, TripRoute>;
        }),
      ),
    );

  // Index hits answer directly; only the index's misses go to D1.
  const resolveTrips = <V>(
    tripIds: readonly string[],
    project: (trip: TripRoute) => V | undefined,
    fromDatabase: (ids: readonly string[]) => Effect.Effect<ReadonlyMap<string, V>, unknown>,
  ): Effect.Effect<ReadonlyMap<string, V>, unknown> => {
    if (!identities.hasTripIdentities) return fromDatabase(tripIds);
    return indexedRoutes(tripIds).pipe(
      Effect.flatMap((trips) => {
        const resolved = new Map<string, V>();
        for (const [id, trip] of trips) {
          const value = project(trip);
          if (value !== undefined) resolved.set(id, value);
        }
        const misses = tripIds.filter((id) => !trips.has(id));
        if (misses.length === 0) return Effect.succeed<ReadonlyMap<string, V>>(resolved);
        return fromDatabase(misses).pipe(
          Effect.map((found): ReadonlyMap<string, V> => new Map([...resolved, ...found])),
        );
      }),
    );
  };

  return {
    getRoutesForTrips: (tripIds) => resolveTrips(tripIds, (trip) => trip, databaseRoutes),
    getDirectionsForTrips: (routeId, tripIds) =>
      resolveTrips(
        tripIds,
        (trip) => (trip.routeId === routeId ? trip.directionId : undefined),
        (ids) =>
          memoizedLookup(directionMemo, `${agencyId}\u0000${routeId}`, ids, (uncached) =>
            getStore.pipe(Effect.flatMap((db) => db.getDirectionsForTrips(routeId, uncached))),
          ),
      ),
    getTripTerminals: (routeId, tripIds) =>
      memoizedLookup(terminalMemo, `${agencyId}\u0000${routeId}`, tripIds, (uncached) =>
        getStore.pipe(Effect.flatMap((db) => db.getTripTerminals(routeId, uncached))),
      ),
  };
}
