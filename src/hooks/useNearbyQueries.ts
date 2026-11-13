import { createMemo, type Accessor } from "solid-js";
import type { BrowserAgency } from "~/agencies/types";
import { allProviders } from "~/agencies/browserRegistry";
import type { EffectiveAgencySnapshot } from "~/domain/location/EffectiveAgency";
import {
  excludeByIds,
  isCoLocatedService,
  routeArrivalEqual,
  sortFavouritesByAgency,
  sortNearbyByRanking,
  stationArrivalEqual,
} from "~/domain/nearbyStability";
import type {
  FavouriteStationRef,
  FavouriteSurfaceRouteRef,
} from "~/domain/preferences/UserPreferences";
import { MAX_PROXIMITY_RADIUS_METERS } from "~/domain/proximity";
import type { NearbyRouteArrival, NearbyStationArrival } from "~/domain/surface/types";
import { useI18n } from "~/i18n/I18nContext";
import { useStableQuery } from "~/hooks/useStableQuery";
import { queryClient } from "~/lib/queryClient";
import { sameListItems } from "~/lib/stableList";
import type { fetchNearbyStations, fetchSavedStations } from "~/services/StationsClient";
import { fetchNearbyTransit, fetchSavedTransit } from "~/services/surface/SurfaceClient";

type CallableServerFunction<T extends (...args: never[]) => unknown> = (
  ...args: Parameters<T>
) => Promise<Awaited<ReturnType<T>>>;

export type NearbyTransitFetcher = CallableServerFunction<typeof fetchNearbyTransit>;
export type SavedTransitFetcher = CallableServerFunction<typeof fetchSavedTransit>;
export type NearbyStationsFetcher = CallableServerFunction<typeof fetchNearbyStations>;
export type SavedStationsFetcher = CallableServerFunction<typeof fetchSavedStations>;

export interface NearbyQueryLocation {
  readonly lat: number;
  readonly lon: number;
}

export interface NearbyQueriesDeps {
  readonly fetchNearbyTransit?: NearbyTransitFetcher;
  readonly fetchSavedTransit?: SavedTransitFetcher;
  readonly fetchNearbyStations?: NearbyStationsFetcher;
  readonly fetchSavedStations?: SavedStationsFetcher;
}

export interface NearbyQueriesResult {
  readonly mergedNearby: Accessor<readonly (NearbyRouteArrival | NearbyStationArrival)[]>;
  readonly savedArrivals: Accessor<readonly NearbyRouteArrival[]>;
  readonly savedStations: Accessor<readonly NearbyStationArrival[]>;
  readonly hasData: Accessor<boolean>;
  readonly isLoading: Accessor<boolean>;
  readonly fetchError: Accessor<string | null>;
  readonly isOutsideServiceArea: Accessor<boolean>;
  /**
   * Honest outside-everywhere flag: a real fix with zero fan-out ids, so no
   * proving fetch was ever issued. Consumers use it to avoid naming the
   * display-fallback agency in empty copy.
   */
  readonly isOutsideCoverage: Accessor<boolean>;
  readonly retry: () => void;
  readonly prefetch: () => Promise<void>;
  /** True while no family has a fetch in flight (sync meta read). */
  readonly allQueriesIdle: Accessor<boolean>;
}

interface NearbyFavourites {
  readonly favouriteStations: readonly FavouriteStationRef[];
  readonly favouriteSurfaceRoutes: readonly FavouriteSurfaceRouteRef[];
}

interface NearbyQueriesContext {
  /** Already resolved by EffectiveAgency; this module never recomputes it. */
  readonly coveringIds: readonly string[];
  /** Already filtered by EffectiveAgency to agencies with station ports. */
  readonly stationCoveringIds: readonly string[];
  /** All registered providers that expose a station port, for favourites. */
  readonly stationProviderIds: readonly string[];
  /** Provider-declared proximity policies, normalized by the app-shell adapter. */
  readonly proximityByAgency: Readonly<Record<string, NearbyProximityPolicy>>;
}

interface NearbyProximityPolicy {
  readonly radiusMeters: number;
  readonly bucketMeters: number;
}

type NearbyQueryKind = "nearby-transit" | "nearby-stations" | "saved-transit" | "saved-stations";

interface NearbyQueryError {
  readonly kind: NearbyQueryKind;
  readonly agencyId: string;
  readonly error: unknown;
}

interface FanoutResult<T> {
  readonly items: readonly T[];
  readonly errors: readonly NearbyQueryError[];
  readonly failed: boolean;
}

interface QueryOptions<T> {
  readonly queryKey: readonly unknown[];
  readonly queryFn: () => Promise<T[]>;
  readonly enabled: boolean;
  readonly getKey: (item: T) => string;
  readonly isEqual: (a: T, b: T) => boolean;
}

interface NearbyQueryOptions {
  readonly nearbyTransit: QueryOptions<NearbyRouteArrival>;
  readonly nearbyStations: QueryOptions<NearbyStationArrival>;
  readonly savedTransit: QueryOptions<NearbyRouteArrival>;
  readonly savedStations: QueryOptions<NearbyStationArrival>;
}

const DEFAULT_RADIUS_METERS = MAX_PROXIMITY_RADIUS_METERS;
const DEFAULT_BUCKET_METERS = 75;

// Keep the station server-function implementations out of the nearby interaction
// chunk. Cache the module promise so simultaneous queries share one load.
let stationClients: Promise<typeof import("~/services/StationsClient")> | undefined;

const getStationClients = () => (stationClients ??= import("~/services/StationsClient"));

let nearbyQueriesPreload: Promise<void> | undefined;

/** Preloads the same lazy RPC providers used by production query execution. */
export function preloadNearbyQueries(): Promise<void> {
  nearbyQueriesPreload ??= getStationClients().then(() => undefined);
  return nearbyQueriesPreload;
}

const fetchNearbyTransitLazy: NearbyTransitFetcher = (...args) => fetchNearbyTransit(...args);

const fetchSavedTransitLazy: SavedTransitFetcher = (...args) => fetchSavedTransit(...args);

const fetchNearbyStationsLazy: NearbyStationsFetcher = (...args) =>
  getStationClients().then(({ fetchNearbyStations }) => fetchNearbyStations(...args));

const fetchSavedStationsLazy: SavedStationsFetcher = (...args) =>
  getStationClients().then(({ fetchSavedStations }) => fetchSavedStations(...args));

function validPositive(value: number | undefined, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** Applies safe defaults and the shared proximity ceiling to provider metadata. */
function normalizeNearbyProximityPolicy(
  config: BrowserAgency["manifest"]["proximity"] | undefined,
): NearbyProximityPolicy {
  return {
    radiusMeters: Math.min(
      validPositive(config?.radiusMeters, DEFAULT_RADIUS_METERS),
      MAX_PROXIMITY_RADIUS_METERS,
    ),
    bucketMeters: validPositive(config?.bucketMeters, DEFAULT_BUCKET_METERS),
  };
}

function buildNearbyContext(
  effectiveAgency: EffectiveAgencySnapshot | null,
  providers: readonly BrowserAgency[],
): NearbyQueriesContext {
  const proximityByAgency: Record<string, NearbyProximityPolicy> = {};
  for (const provider of providers) {
    proximityByAgency[provider.manifest.id] = normalizeNearbyProximityPolicy(
      provider.manifest.proximity,
    );
  }

  return {
    coveringIds: effectiveAgency?.coveringIds ?? [],
    stationCoveringIds: effectiveAgency?.stationCoveringIds ?? [],
    stationProviderIds: providers
      .filter((provider) => Boolean(provider.manifest.stationService))
      .map((provider) => provider.manifest.id),
    proximityByAgency,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "Failed to load nearby transit data";
}

function hasStaleItems(
  items: readonly { readonly arrivalsStale?: boolean }[] | undefined,
): boolean {
  return items?.some((item) => item.arrivalsStale === true) ?? false;
}

function tagWithAgency<T extends { agencyId?: string }>(
  items: readonly T[],
  agencyId: string,
): readonly T[] {
  return items.map((item) => (item.agencyId ? item : ({ ...item, agencyId } as T)));
}

function deduplicate<T>(items: readonly T[], getKey: (item: T) => string): readonly T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = getKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function proximity(context: NearbyQueriesContext, agencyId: string): NearbyProximityPolicy {
  return context.proximityByAgency[agencyId] ?? normalizeNearbyProximityPolicy(undefined);
}

async function fanOut<T>(
  kind: NearbyQueryKind,
  agencyIds: readonly string[],
  fetch: (agencyId: string) => Promise<readonly T[]>,
): Promise<FanoutResult<T>> {
  if (agencyIds.length === 0) return { items: [], errors: [], failed: false };

  const settled = await Promise.allSettled(agencyIds.map((agencyId) => fetch(agencyId)));
  const items: T[] = [];
  const errors: NearbyQueryError[] = [];
  settled.forEach((result, index) => {
    const agencyId = agencyIds[index]!;
    if (result.status === "fulfilled") {
      items.push(...result.value);
    } else {
      errors.push({ kind, agencyId, error: result.reason });
    }
  });
  return { items, errors, failed: errors.length === settled.length };
}

function queryItems<T>(result: FanoutResult<T>): T[] {
  if (result.failed) throw result.errors[0]?.error;
  return [...result.items];
}

export function useNearbyQueries(
  location: Accessor<NearbyQueryLocation | null>,
  favourites: NearbyFavourites,
  agencyId: Accessor<string>,
  effectiveAgency: Accessor<EffectiveAgencySnapshot | null>,
  enabled: Accessor<boolean> = () => true,
  injectedDeps: NearbyQueriesDeps = {},
): NearbyQueriesResult {
  const { locale } = useI18n();
  const fetchNearbyTransit = injectedDeps.fetchNearbyTransit ?? fetchNearbyTransitLazy;
  const fetchSavedTransit = injectedDeps.fetchSavedTransit ?? fetchSavedTransitLazy;
  const fetchNearbyStations = injectedDeps.fetchNearbyStations ?? fetchNearbyStationsLazy;
  const fetchSavedStations = injectedDeps.fetchSavedStations ?? fetchSavedStationsLazy;

  const context = (): NearbyQueriesContext => buildNearbyContext(effectiveAgency(), allProviders());
  const input = () => ({
    location: location(),
    favouriteRouteRefs: favourites.favouriteSurfaceRoutes,
    favouriteStationNames: favourites.favouriteStations
      .filter((ref) => ref.agencyId === agencyId())
      .map((ref) => ref.stationName),
    selectedAgencyId: agencyId(),
    locale: locale(),
  });

  const fetchNearby = async (
    currentInput: ReturnType<typeof input>,
    currentContext: NearbyQueriesContext,
  ): Promise<FanoutResult<NearbyRouteArrival>> => {
    if (!currentInput.location) return { items: [], errors: [], failed: false };
    return fanOut("nearby-transit", currentContext.coveringIds, async (id) => {
      const data = await fetchNearbyTransit({
        agencyId: id,
        lat: currentInput.location!.lat,
        lon: currentInput.location!.lon,
        radius: proximity(currentContext, id).radiusMeters,
        locale: currentInput.locale,
      });
      return tagWithAgency((data || []) as NearbyRouteArrival[], id);
    });
  };

  const fetchStations = async (
    currentInput: ReturnType<typeof input>,
    currentContext: NearbyQueriesContext,
  ): Promise<FanoutResult<NearbyStationArrival>> => {
    if (!currentInput.location) return { items: [], errors: [], failed: false };
    return fanOut("nearby-stations", currentContext.stationCoveringIds, async (id) => {
      const data = await fetchNearbyStations({
        agencyId: id,
        lat: currentInput.location!.lat,
        lon: currentInput.location!.lon,
        radius: proximity(currentContext, id).radiusMeters,
        locale: currentInput.locale,
      });
      return tagWithAgency((data || []) as NearbyStationArrival[], id);
    });
  };

  const fetchSavedRoutes = async (
    currentInput: ReturnType<typeof input>,
  ): Promise<FanoutResult<NearbyRouteArrival>> => {
    const routesByAgency = new Map<string, string[]>();
    for (const ref of currentInput.favouriteRouteRefs) {
      const routes = routesByAgency.get(ref.agencyId) ?? [];
      routes.push(ref.routeId);
      routesByAgency.set(ref.agencyId, routes);
    }
    return fanOut("saved-transit", [...routesByAgency.keys()], async (id) => {
      const data = await fetchSavedTransit({
        agencyId: id,
        favouriteRoutes: routesByAgency.get(id)!,
        lat: currentInput.location?.lat,
        lon: currentInput.location?.lon,
        locale: currentInput.locale,
      });
      return tagWithAgency((data || []) as NearbyRouteArrival[], id);
    });
  };

  const fetchSavedStationArrivals = async (
    currentInput: ReturnType<typeof input>,
    currentContext: NearbyQueriesContext,
  ): Promise<FanoutResult<NearbyStationArrival>> => {
    if (currentInput.favouriteStationNames.length === 0) {
      return { items: [], errors: [], failed: false };
    }
    return fanOut("saved-stations", currentContext.stationProviderIds, async (id) => {
      const data = await fetchSavedStations({
        agencyId: id,
        stationNames: [...currentInput.favouriteStationNames],
        lat: currentInput.location?.lat,
        lon: currentInput.location?.lon,
        locale: currentInput.locale,
      });
      return tagWithAgency((data || []) as NearbyStationArrival[], id);
    });
  };

  const mergeNearby = (
    nearby: readonly NearbyRouteArrival[],
    stations: readonly NearbyStationArrival[],
    selectedAgencyId: string,
    currentContext: NearbyQueriesContext,
  ): readonly (NearbyRouteArrival | NearbyStationArrival)[] => {
    const surface = deduplicate(
      nearby.filter((item) => item.routeType !== "subway"),
      (item) => `${item.agencyId}:${item.routeId}`,
    );
    const stationItems = deduplicate(stations, (item) => `${item.agencyId}:${item.id}`).filter(
      (station) => !surface.some((route) => isCoLocatedService(station, route)),
    );
    return sortNearbyByRanking(
      [...stationItems, ...surface],
      selectedAgencyId,
      proximity(currentContext, selectedAgencyId).bucketMeters,
    ) as readonly (NearbyRouteArrival | NearbyStationArrival)[];
  };

  const mergeSavedArrivals = (
    saved: readonly NearbyRouteArrival[],
    nearby: readonly NearbyRouteArrival[],
    selectedAgencyId: string,
  ): readonly NearbyRouteArrival[] => {
    const nearbyIds = new Set(
      nearby
        .filter((item) => item.routeType !== "subway")
        .map((item) => `${item.agencyId}:${item.routeId}`),
    );
    return sortFavouritesByAgency(
      excludeByIds(
        deduplicate(saved, (item) => `${item.agencyId}:${item.routeId}`),
        nearbyIds,
        (item) => `${item.agencyId}:${item.routeId}`,
      ),
      selectedAgencyId,
    ) as readonly NearbyRouteArrival[];
  };

  const mergeSavedStations = (
    saved: readonly NearbyStationArrival[],
    nearby: readonly NearbyStationArrival[],
    selectedAgencyId: string,
  ): readonly NearbyStationArrival[] => {
    const nearbyIds = new Set(nearby.map((item) => `${item.agencyId}:${item.id}`));
    return sortFavouritesByAgency(
      excludeByIds(
        deduplicate(saved, (item) => `${item.agencyId}:${item.id}`),
        nearbyIds,
        (item) => `${item.agencyId}:${item.id}`,
      ),
      selectedAgencyId,
    ) as readonly NearbyStationArrival[];
  };

  const queryOptions = (): NearbyQueryOptions => {
    const currentInput = input();
    const currentContext = context();
    const locationKey = currentInput.location;
    const localeKey = [currentInput.locale];
    return {
      nearbyTransit: {
        queryKey: [
          "nearby-transit",
          currentInput.selectedAgencyId,
          ...localeKey,
          locationKey,
          currentContext.coveringIds,
        ],
        queryFn: async () => queryItems(await fetchNearby(currentInput, currentContext)),
        enabled: currentInput.location !== null && currentContext.coveringIds.length > 0,
        getKey: (arrival) => `${arrival.agencyId}:${arrival.routeId}`,
        isEqual: routeArrivalEqual,
      },
      nearbyStations: {
        queryKey: [
          "nearby-stations",
          currentInput.selectedAgencyId,
          ...localeKey,
          locationKey,
          currentContext.stationCoveringIds,
        ],
        queryFn: async () => queryItems(await fetchStations(currentInput, currentContext)),
        enabled: currentInput.location !== null && currentContext.stationCoveringIds.length > 0,
        getKey: (station) => `${station.agencyId}:${station.id}`,
        isEqual: stationArrivalEqual,
      },
      savedTransit: {
        queryKey: [
          "saved-transit",
          currentInput.selectedAgencyId,
          ...localeKey,
          locationKey,
          currentInput.favouriteRouteRefs,
        ],
        queryFn: async () => queryItems(await fetchSavedRoutes(currentInput)),
        enabled: currentInput.favouriteRouteRefs.length > 0,
        getKey: (arrival) => `${arrival.agencyId}:${arrival.routeId}`,
        isEqual: routeArrivalEqual,
      },
      savedStations: {
        queryKey: [
          "saved-stations",
          currentInput.selectedAgencyId,
          ...localeKey,
          currentInput.favouriteStationNames,
          locationKey,
          currentContext.stationProviderIds,
        ],
        queryFn: async () =>
          queryItems(await fetchSavedStationArrivals(currentInput, currentContext)),
        enabled:
          currentInput.favouriteStationNames.length > 0 &&
          currentContext.stationProviderIds.length > 0,
        getKey: (station) => `${station.agencyId}:${station.id}`,
        isEqual: stationArrivalEqual,
      },
    };
  };

  const enabledQueryOptions = <T>(options: QueryOptions<T>) => ({
    ...options,
    // The panel gate stays out of the query identity. Keying the
    // activation bit minted a fresh disabled, dataless cache entry on every
    // close; the v6 adapter answers those with a never-settling promise, so
    // the closing update never settled (dialog stuck open, targeted
    // mode dead, no error). Gate only via `enabled`: the sync
    // disabled-items invariant in useStableQuery owns emptying the lists,
    // and staleness mechanics (30s staleTime + 15s poll) own freshness on
    // reopen. A stale key refetches in the background while last-known
    // renders through keepPreviousData.
    // No untrack wrapper here. Each queryFn closes over captured
    // input/context consts built in queryOptions(), so it makes no reactive
    // reads when TanStack invokes it. When enabled is false TanStack never
    // calls queryFn, so there is no empty-resolve branch.
    enabled: enabled() && options.enabled,
  });

  const { query: nearbyQuery, items: nearbyItems } = useStableQuery<NearbyRouteArrival>(() =>
    enabledQueryOptions(queryOptions().nearbyTransit),
  );
  const { query: stationsQuery, items: stationItems } = useStableQuery<NearbyStationArrival>(() =>
    enabledQueryOptions(queryOptions().nearbyStations),
  );
  const { query: savedQuery, items: savedRouteItems } = useStableQuery<NearbyRouteArrival>(() =>
    enabledQueryOptions(queryOptions().savedTransit),
  );
  const { query: savedStationsQuery, items: savedStationItems } =
    useStableQuery<NearbyStationArrival>(() => enabledQueryOptions(queryOptions().savedStations));

  const mergedNearby = createMemo(
    () =>
      mergeNearby(
        nearbyItems() as readonly NearbyRouteArrival[],
        stationItems() as readonly NearbyStationArrival[],
        agencyId(),
        context(),
      ),
    { equals: sameListItems },
  );
  const hasData = createMemo(
    () =>
      mergedNearby().length > 0 || savedRouteItems().length > 0 || savedStationItems().length > 0,
  );
  const savedArrivals = createMemo(
    () =>
      mergeSavedArrivals(
        savedRouteItems() as readonly NearbyRouteArrival[],
        nearbyItems() as readonly NearbyRouteArrival[],
        agencyId(),
      ),
    { equals: sameListItems },
  );
  const savedStations = createMemo(
    () =>
      mergeSavedStations(
        savedStationItems() as readonly NearbyStationArrival[],
        stationItems() as readonly NearbyStationArrival[],
        agencyId(),
      ),
    { equals: sameListItems },
  );

  const isOutsideCoverage = (): boolean => {
    // Honest outside: a real fix with zero fan-out ids. Disabled nearby
    // queries would otherwise sit pending forever with no cache, leaving the
    // panel on skeleton. Saved favourites still load; see isLoading below.
    const currentContext = context();
    return (
      location() !== null &&
      currentContext.coveringIds.length === 0 &&
      currentContext.stationCoveringIds.length === 0
    );
  };

  const isLoading = () => {
    if (hasData()) return false;
    if (isOutsideCoverage()) {
      // Proximity can never land outside coverage, so the skeleton holds only
      // for in-flight favourites. Otherwise the generic empty state would
      // flash before saved cards arrive.
      return savedQuery.fetchStatus === "fetching" || savedStationsQuery.fetchStatus === "fetching";
    }
    return (
      nearbyQuery.isPending ||
      (nearbyQuery.fetchStatus === "fetching" && nearbyQuery.isPlaceholderData) ||
      stationsQuery.isPending ||
      (stationsQuery.fetchStatus === "fetching" && stationsQuery.isPlaceholderData)
    );
  };
  const fetchError = createMemo(() => {
    const firstError =
      nearbyQuery.error ?? stationsQuery.error ?? savedQuery.error ?? savedStationsQuery.error;
    return firstError ? errorMessage(firstError) : null;
  });
  const isOutsideServiceArea = createMemo(() => {
    if (hasData() || fetchError()) return false;
    // Explicit outside needs no proving fetch: fan-out is honestly empty.
    if (isOutsideCoverage()) return true;
    return !isLoading() && nearbyQuery.isSuccess && stationsQuery.isSuccess;
  });

  const retry = () => {
    // Read the stabilized (suspension-safe) item lists: retry is a user
    // gesture that may fire before first settle (offline first load), where
    // raw query.data reads would suspend.
    if (nearbyQuery.error || hasStaleItems(nearbyItems())) void nearbyQuery.refetch();
    if (stationsQuery.error || hasStaleItems(stationItems())) void stationsQuery.refetch();
    if (
      favourites.favouriteSurfaceRoutes.length > 0 &&
      (savedQuery.error || hasStaleItems(savedRouteItems()))
    )
      void savedQuery.refetch();
    if (
      favourites.favouriteStations.length > 0 &&
      (savedStationsQuery.error || hasStaleItems(savedStationItems()))
    )
      void savedStationsQuery.refetch();
  };

  const prefetch = async (): Promise<void> => {
    const options = queryOptions();
    const prefetchOption = <T>(option: QueryOptions<T>) =>
      option.enabled
        ? queryClient.prefetchQuery<T[]>({
            // Same identity as the live queries (no activation segment).
            queryKey: [...option.queryKey],
            queryFn: option.queryFn,
          })
        : Promise.resolve();

    await Promise.allSettled([
      prefetchOption<NearbyRouteArrival>(options.nearbyTransit),
      prefetchOption<NearbyStationArrival>(options.nearbyStations),
      prefetchOption<NearbyRouteArrival>(options.savedTransit),
      prefetchOption<NearbyStationArrival>(options.savedStations),
    ]);
  };

  const allQueriesIdle = createMemo(
    () =>
      (nearbyQuery.fetchStatus === "idle" || nearbyQuery.fetchStatus === "paused") &&
      (stationsQuery.fetchStatus === "idle" || stationsQuery.fetchStatus === "paused") &&
      (savedQuery.fetchStatus === "idle" || savedQuery.fetchStatus === "paused") &&
      (savedStationsQuery.fetchStatus === "idle" || savedStationsQuery.fetchStatus === "paused"),
  );

  return {
    mergedNearby,
    savedArrivals,
    savedStations,
    hasData,
    isLoading,
    fetchError,
    isOutsideServiceArea,
    isOutsideCoverage,
    retry,
    prefetch,
    allQueriesIdle,
  };
}
