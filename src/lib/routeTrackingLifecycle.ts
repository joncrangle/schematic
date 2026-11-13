import { createMemo, createSignal, onCleanup } from "solid-js";
import type { Accessor } from "solid-js";
import { queryClient } from "~/lib/queryClient";
import { fetchRouteTracking } from "~/services/surface/SurfaceClient";
import type { RouteTrackingData } from "~/domain/surface/types";
import type { Coordinates } from "~/domain/location/locationLadder";
import { findNearestStopIndex } from "~/domain/surface/corridor/index";
import { DEFAULT_UI_LOCALE, type UiLocale } from "~/domain/locale";
import { useI18n } from "~/i18n/I18nContext";

/**
 * Single owner of the surface Route Tracking data lifecycle: cache key,
 * renewal cadence, request deduplication, freshness policy, and reactive
 * hooks for targeted route mode and nearby cards.
 *
 * Both surfaces that consume live route tracking, the targeted map overlay
 * and expanded Nearby transit rows, go through `acquireRouteTracking`, so a
 * route/direction shared between them resolves to ONE TanStack cache entry
 * refreshed by ONE renewal timer with TanStack supplying single-flight
 * deduplication across concurrent ticks.
 *
 * Freshness note (ADR-0003): the service worker is network-first, so this
 * client-side renewal cadence is the only freshness guard for tracking data.
 */

/** How often an acquired route-tracking query is renewed from the network. */
export const ROUTE_TRACKING_RENEWAL_MS = 10_000;

/**
 * Canonical cache key for a route-tracking snapshot, scoped by agency so
 * route ids from different agencies never collide. Every consumer keys off
 * this exact tuple.
 */
export const ROUTE_TRACKING_KEY = (
  agencyId: string,
  routeId: string,
  directionId: number,
  locale: UiLocale = DEFAULT_UI_LOCALE,
) => ["route-tracking", agencyId, routeId, directionId, locale] as const;

export type RouteTrackingKey = ReturnType<typeof ROUTE_TRACKING_KEY>;

export interface CachedRouteTrackingTarget {
  readonly agencyId: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly locale?: UiLocale;
}

/** Synchronous warm-cache read used by the map shell and nearby rows. */
export const readCachedRouteTracking = (
  target: CachedRouteTrackingTarget,
): RouteTrackingData | null =>
  (queryClient.getQueryData(
    ROUTE_TRACKING_KEY(target.agencyId, target.routeId, target.directionId, target.locale),
  ) as RouteTrackingData | undefined) ?? null;

/** Identifies a tracked route/direction pair; the two fields always travel together. */
export interface RouteDirection {
  readonly routeId: string;
  readonly directionId: number;
}

/**
 * Agency-scoped tracking request: extends the pair with the
 * shell-resolved agency id so TTC route "1" and GO route "1" land in
 * disjoint cache entries.
 */
export interface AgencyRouteDirection extends RouteDirection {
  readonly agencyId: string;
}

/** User intent to open a route in targeted mode, carried as one value. */
export interface RouteEnlargeRequest extends AgencyRouteDirection {
  readonly stopId?: string;
  readonly nearestAnchorCoords?: Coordinates | null;
}

export interface RouteTrackingHandle {
  /** Reactive accessor for the latest tracking snapshot (null until one exists). */
  data: () => RouteTrackingData | null;
  /** Drops this subscriber's claim; renewal stops when the last claim is released. */
  release: () => void;
}

interface RenewalEntry {
  key: RouteTrackingKey;
  refCount: number;
  timer: ReturnType<typeof setInterval> | null;
}

// Refcounted per key: one interval per route/direction regardless of how many
// surfaces are subscribed. Entries are keyed by the serialized query-key tuple.
const renewals = new Map<string, RenewalEntry>();

const isPageHidden = (): boolean =>
  typeof document !== "undefined" && document.visibilityState === "hidden";

// Hidden tabs skip renewal ticks (no network or decode work nobody can see).
// Returning to the tab refreshes every live key once instead of waiting out a
// full interval on stale vehicle positions.
const renewAllOnVisible = (): void => {
  if (isPageHidden()) return;
  for (const { key } of renewals.values()) renewRouteTracking(key);
};

const matchesKey = (queryKey: readonly unknown[], key: RouteTrackingKey): boolean =>
  queryKey.length === key.length && queryKey.every((part, index) => part === key[index]);

/**
 * Failure semantics: the tracking RPC rejects on real failures, and
 * those rejections must propagate so TanStack's error state drives keep-last
 * (a failed poll never overwrites the last good snapshot in the cache). The
 * one remaining resolved-null case, an unknown route id resolving to
 * Option.none(), is a legitimate empty, converted here to a rejection for
 * the same reason: only successful payloads ever reach the cache.
 */
const createTrackingQueryFn = (target: AgencyRouteDirection, locale: UiLocale) => async () => {
  const data = await fetchRouteTracking({ ...target, locale });
  if (!data) {
    throw new Error(
      `Route tracking unavailable for route ${target.routeId} direction ${target.directionId}`,
    );
  }
  return data;
};

const renewRouteTracking = (key: RouteTrackingKey): void => {
  const [, agencyId, routeId, directionId] = key;
  const locale = key[4];
  // Shared client default `retry: 1` applies here too: a failing tick makes up
  // to 2 attempts within its renewal window before giving up. Keep-last is
  // unaffected, only successful payloads ever reach the cache.
  // staleTime: 0 forces a refresh per tick; concurrent fetches on the same key
  // (another surface's tick, a mount-time prime) share the in-flight request.
  queryClient
    .fetchQuery({
      queryKey: key,
      queryFn: createTrackingQueryFn({ agencyId, routeId, directionId }, locale),
      staleTime: 0,
    })
    .catch(() => {
      // Keep-last: leave the previous snapshot cached on failure.
    });
};

/**
 * Acquires a reactive handle to live tracking data for a route/direction.
 *
 * - Seeds immediately from the shared TanStack cache (instant render on
 *   remount or when another surface already fetched the key).
 * - Keeps the accessor fresh by subscribing to the query cache, so external
 *   writes (any other surface fetching the same key) update subscribers
 *   reactively.
 * - Starts at most one renewal timer per key; each tick goes through
 *   `queryClient.fetchQuery` so overlapping requests deduplicate.
 * - Released snapshots stay in the cache and age out via gcTime.
 */
export function acquireRouteTracking(
  target: AgencyRouteDirection,
  onArrival?: (data: RouteTrackingData) => void,
  locale: UiLocale = DEFAULT_UI_LOCALE,
): RouteTrackingHandle {
  let released = false;
  const key = ROUTE_TRACKING_KEY(target.agencyId, target.routeId, target.directionId, locale);
  const initialData = (queryClient.getQueryData(key) as RouteTrackingData | undefined) ?? null;
  const [data, setData] = createSignal<RouteTrackingData | null>(initialData, {
    ownedWrite: true,
  });

  if (initialData && onArrival) {
    queueMicrotask(() => {
      if (!released) onArrival(initialData);
    });
  }

  // Client-scoped lifecycle: no timers or cache subscriptions during SSR.
  if (typeof window === "undefined") {
    return { data, release: () => {} };
  }

  const registryKey = JSON.stringify(key);
  let entry = renewals.get(registryKey);
  if (!entry) {
    entry = { key, refCount: 0, timer: null };
    if (renewals.size === 0) document.addEventListener("visibilitychange", renewAllOnVisible);
    renewals.set(registryKey, entry);
    entry.timer = setInterval(() => {
      if (!isPageHidden()) renewRouteTracking(key);
    }, ROUTE_TRACKING_RENEWAL_MS);
    // Prime without waiting for the first tick; skips the network while the
    // cached snapshot is still within the renewal window, refetches once it
    // is stale. (query-core >= 5.101 requires revalidateIfStale for the
    // stale-refetch branch of ensureQueryData.)
    queryClient
      .ensureQueryData({
        queryKey: key,
        queryFn: createTrackingQueryFn(target, locale),
        staleTime: ROUTE_TRACKING_RENEWAL_MS,
        revalidateIfStale: true,
      })
      .then((fresh) => {
        if (!released && fresh && onArrival) {
          onArrival(fresh);
        }
      })
      .catch(() => {
        // Keep-last: nothing to do if the priming fetch fails.
      });
  } else if (!initialData && onArrival) {
    queryClient
      .ensureQueryData({
        queryKey: key,
        queryFn: createTrackingQueryFn(target, locale),
        staleTime: ROUTE_TRACKING_RENEWAL_MS,
        revalidateIfStale: true,
      })
      .then((fresh) => {
        if (!released && fresh && onArrival) {
          onArrival(fresh);
        }
      })
      .catch(() => {});
  }
  entry.refCount += 1;

  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (
      event.type !== "updated" ||
      (event.action.type !== "success" && event.action.type !== "setState")
    ) {
      return;
    }
    if (!matchesKey(event.query.queryKey, key)) return;
    const next = (event.query.state.data as RouteTrackingData | null | undefined) ?? null;
    if (next !== data()) setData(next);
  });

  return {
    data,
    release: () => {
      if (released) return;
      released = true;
      unsubscribe();
      const current = renewals.get(registryKey);
      if (!current) return;
      current.refCount -= 1;
      if (current.refCount <= 0) {
        if (current.timer !== null) clearInterval(current.timer);
        // Leave the data in queryClient, gcTime evicts it once unused.
        renewals.delete(registryKey);
        if (renewals.size === 0)
          document.removeEventListener("visibilitychange", renewAllOnVisible);
      }
    },
  };
}

/**
 * Reusable reactive lifecycle bridge: acquires `RouteTrackingHandle` when `target()`
 * is non-null, cleanly releases previous handle on retarget, and releases on unmount.
 * Does not use signal writes inside `createEffect`.
 */
export function useRouteTrackingHandle(
  target: Accessor<AgencyRouteDirection | null>,
  onArrival?: (data: RouteTrackingData | null) => void,
): Accessor<RouteTrackingHandle | null> {
  const { locale } = useI18n();
  const handle = createMemo<RouteTrackingHandle | null>((prev = null) => {
    prev?.release();
    const t = target();
    if (!t) {
      onArrival?.(null);
      return null;
    }
    return acquireRouteTracking(t, onArrival, locale());
  });

  onCleanup(() => {
    handle()?.release();
  });

  return handle;
}

export interface TargetedRouteTracking {
  /** Live or held tracking data for the targeted route/direction (null when inactive). */
  readonly data: Accessor<RouteTrackingData | null>;
  /** True while data is a held snapshot from a previous direction during an in-flight switch. */
  readonly isStaleForDirection: Accessor<boolean>;
  /** ID of the nearest surface stop to the rider's position/anchor. */
  readonly nearestStopId: Accessor<string | undefined>;
  /** Data arrival subscription driving viewport camera auto-framing. */
  readonly onDataArrival: (listener: (data: RouteTrackingData) => void) => () => void;
  /** Switch direction action. */
  readonly selectDirection: (directionId: number) => void;
  /** Currently selected/targeted direction ID. */
  readonly selectedDirectionId?: Accessor<number | undefined>;
  /** Requested route identity, available before its first tracking response. */
  readonly selectedRouteId?: Accessor<string | undefined>;
}

export function useTargetedRouteTracking(
  target: Accessor<RouteEnlargeRequest | null>,
  options?: {
    readonly getNearestAnchorCoords?: () => Coordinates | null;
    readonly onSelectDirection?: (directionId: number) => void;
  },
): TargetedRouteTracking {
  const { locale } = useI18n();
  const listeners = new Set<(data: RouteTrackingData) => void>();
  let lastFreshArrival: { agencyId: string; data: RouteTrackingData } | undefined;

  const notifyFreshArrival = (current: RouteTrackingData | null) => {
    const t = target();
    if (!current || !t) {
      lastFreshArrival = undefined;
      return;
    }
    if (current.shape.directionId !== t.directionId || current.route.id !== t.routeId) {
      return;
    }

    const previous = lastFreshArrival;
    lastFreshArrival = { agencyId: t.agencyId, data: current };
    if (
      previous &&
      previous.agencyId === t.agencyId &&
      previous.data.route.id === current.route.id &&
      previous.data.shape.directionId === current.shape.directionId
    ) {
      return;
    }

    for (const listener of listeners) listener(current);
  };

  const handle = useRouteTrackingHandle(target, (freshData) => {
    notifyFreshArrival(freshData);
  });
  const liveData: Accessor<RouteTrackingData | null> = () => handle()?.data() ?? null;

  const held = createMemo<{
    agencyId: string;
    locale: UiLocale;
    data: RouteTrackingData;
  } | null>((prev = null) => {
    const t = target();
    if (!t) return null;
    const currentLocale = locale();

    const live = liveData();
    const trustedLive = live && live.route.id === t.routeId ? live : null;
    if (trustedLive && trustedLive.shape.directionId === t.directionId) {
      return { agencyId: t.agencyId, locale: currentLocale, data: trustedLive };
    }

    const cached = readCachedRouteTracking({
      agencyId: t.agencyId,
      routeId: t.routeId,
      directionId: t.directionId,
      locale: currentLocale,
    });
    if (cached) return { agencyId: t.agencyId, locale: currentLocale, data: cached };

    if (trustedLive) return { agencyId: t.agencyId, locale: currentLocale, data: trustedLive };

    if (
      prev?.agencyId === t.agencyId &&
      prev.locale === currentLocale &&
      prev.data.route.id === t.routeId
    ) {
      return prev;
    }

    return null;
  });
  const data = createMemo(() => held()?.data ?? null);

  const isStaleForDirection = createMemo(() => {
    const t = target();
    const d = data();
    if (!t || !d) return false;
    return d.shape.directionId !== t.directionId;
  });

  const nearestStopId = createMemo<string | undefined>(() => {
    const tracking = data();
    const t = target();
    if (!tracking || tracking.stops.length === 0) return t?.stopId;

    const explicitId = t?.stopId;
    const explicitStop = explicitId ? tracking.stops.find((s) => s.id === explicitId) : undefined;

    const anchor = options?.getNearestAnchorCoords?.() ?? t?.nearestAnchorCoords ?? null;
    const coords: Coordinates | null =
      anchor ??
      (explicitStop
        ? { latitude: explicitStop.lat, longitude: explicitStop.lon, timestamp: Date.now() }
        : null);

    if (coords) {
      const nearestIdx = findNearestStopIndex(coords.latitude, coords.longitude, tracking.stops);
      const geoNearestId = nearestIdx === -1 ? undefined : tracking.stops[nearestIdx]?.id;
      if (geoNearestId) return geoNearestId;
    }

    if (explicitStop) {
      return explicitStop.id;
    }

    return undefined;
  });

  if (typeof window !== "undefined") {
    const unsubscribeCache = queryClient.getQueryCache().subscribe((event) => {
      if (
        event.type !== "updated" ||
        (event.action.type !== "success" && event.action.type !== "setState")
      ) {
        return;
      }
      const t = target();
      if (!t) return;
      const key = ROUTE_TRACKING_KEY(t.agencyId, t.routeId, t.directionId, locale());
      if (!matchesKey(event.query.queryKey, key)) return;
      const next = (event.query.state.data as RouteTrackingData | null | undefined) ?? null;
      notifyFreshArrival(next);
    });

    onCleanup(() => {
      unsubscribeCache();
    });
  }

  const onDataArrival = (listener: (d: RouteTrackingData) => void): (() => void) => {
    listeners.add(listener);
    const current = data();
    const t = target();
    if (
      current &&
      t &&
      current.shape.directionId === t.directionId &&
      current.route.id === t.routeId
    ) {
      listener(current);
      lastFreshArrival = { agencyId: t.agencyId, data: current };
    }
    return () => listeners.delete(listener);
  };

  const selectDirection = (directionId: number): void => {
    const t = target();
    if (!t || t.directionId === directionId) return;
    options?.onSelectDirection?.(directionId);
  };

  const selectedDirectionId = createMemo<number | undefined>(() => {
    return target()?.directionId ?? data()?.shape.directionId;
  });

  return {
    data,
    isStaleForDirection,
    nearestStopId,
    onDataArrival,
    selectDirection,
    selectedDirectionId,
    selectedRouteId: () => target()?.routeId,
  };
}
