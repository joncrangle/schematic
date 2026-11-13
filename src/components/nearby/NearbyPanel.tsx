import {
  createMemo,
  Errored,
  For,
  Match,
  onSettled,
  Show,
  Switch,
  untrack,
  type Accessor,
} from "solid-js";
import { getLocationLadder, useGeolocation } from "~/hooks/useGeolocation";
import { graceRemainingSeconds } from "~/domain/location/locationLadder";
import { useAppClock } from "~/lib/appClock";
import { useNearbyQueries } from "~/hooks/useNearbyQueries";
import { createControllableSignal } from "~/lib/createControllableSignal";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useAgencySession } from "~/context/AgencySessionContext";
import { keyListById } from "~/lib/keyedList";
import type { NearbyRouteArrival, NearbyStationArrival } from "~/domain/surface/types";
import { RouteArrivalCard } from "./RouteArrivalCard";
import { StationArrivalCard } from "./StationArrivalCard";
import { NearbyEmptyState } from "./NearbyEmptyState";
import { NearbyLocationGate } from "./NearbyLocationGate";
import { NearbyLoadingSkeleton } from "./NearbyLoadingSkeleton";
import { StarIcon } from "~/components/icons/StarIcon";
import type { RouteEnlargeRequest } from "~/lib/routeTrackingLifecycle";
import { useI18n } from "~/i18n/I18nContext";
import { formatClockCountdown } from "./nearbyHelpers";

const routeCardKey = (agencyId: string, routeId: string): string => `${agencyId}:${routeId}`;
const stationCardKey = (agencyId: string, stationId: string): string =>
  `station:${agencyId}:${stationId}`;

/**
 * Mount rows once data is available or every query is idle. Waiting for all
 * families hides usable cards during a slow request or cached revalidation,
 * after hasData has already dismissed the loading indicator. Latch until the
 * panel closes so background polls keep the existing rows mounted.
 */
export function computeListArmed(
  previouslyArmed: boolean,
  isOpen: boolean,
  locationReady: boolean,
  allIdle: boolean,
  hasData: boolean,
): boolean {
  if (!isOpen) return false;
  if (previouslyArmed) return true;
  return locationReady && (hasData || allIdle);
}

export interface NearbyPanelProps {
  /** Keeps the mounted portal shell closed until the user opens Nearby. */
  isOpen?: Accessor<boolean>;
  onClose?: () => void;
  onEnlargeRoute?: (request: RouteEnlargeRequest) => void;
  expandedRouteId?: string | null;
  onToggleExpandRoute?: (routeId: string) => void;
  routeDirections?: Record<string, number>;
  onSelectRouteDirection?: (routeId: string, directionId: number) => void;
  onCaptureTargetedInvoker?: (element: HTMLElement) => void;
  onRegisterFirstActionable?: (routeId: string, element: HTMLElement) => void;
}

/**
 * Nearby surface departures panel, agency-scoped via `useAgencySession()`.
 * Threads `agencyId` into `NearbyLocationGate` and `NearbyEmptyState` so
 * priming and in-coverage empty copy reflect the shell-resolved
 * agency (e.g. "Kingston Transit" when kingston selected) instead of hardcoded TTC.
 * Truly-outside-everywhere copy stays agency-generic via `isOutsideCoverage`,
 * so a rider in NYC never reads "No nearby TTC stops".
 * CoveringIds are sole-sourced from the EffectiveAgency snapshot via context
 * (routes/index.tsx → AgencySessionContext); this panel never recomputes them.
 */
export function NearbyPanel(props: NearbyPanelProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const geo = useGeolocation();
  const userPrefs = useUserPreferences();
  const session = useAgencySession();
  const agencyId = () => session.displayedAgencyId() ?? "";
  const effectiveAgency = () => session.snapshot();

  const [expandedRouteId, setExpandedRouteId] = createControllableSignal(
    () => props.expandedRouteId,
    () => null,
  );
  const [routeDirections, setRouteDirections] = createControllableSignal<Record<string, number>>(
    () => props.routeDirections,
    () => ({}),
  );

  const handleToggleExpand = (cardKey: string) => {
    if (!cardKey) return;
    if (props.onToggleExpandRoute) {
      props.onToggleExpandRoute(cardKey);
    } else {
      setExpandedRouteId(expandedRouteId() === cardKey ? null : cardKey);
    }
  };

  const handleSelectDirection = (cardKey: string, dir: number) => {
    if (!cardKey) return;
    if (props.onSelectRouteDirection) {
      props.onSelectRouteDirection(cardKey, dir);
    } else {
      setRouteDirections((prev) => ({ ...prev, [cardKey]: dir }));
    }
  };

  const graceNow = useAppClock();
  const formattedTime = () => {
    const total = graceRemainingSeconds(geo.coords(), graceNow());
    return formatClockCountdown(total, i18n);
  };

  const isSpoofActive = () => geo.locationSource() === "dev-spoof";

  const queryLocation = () => {
    const snap = effectiveAgency();
    const fix = snap?.fix;
    if (!fix) return null;
    if (
      snap.source !== "dev-spoof" &&
      snap.source !== "coarse-ip" &&
      snap.status !== "granted" &&
      snap.status !== "stale"
    ) {
      return null;
    }
    return { lat: fix.latitude, lon: fix.longitude };
  };
  const locationReady = () => queryLocation() !== null;

  const {
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
  } = useNearbyQueries(
    queryLocation,
    userPrefs.preferences,
    agencyId,
    effectiveAgency,
    () => props.isOpen?.() ?? true,
  );

  const listArmed = createMemo((prev: boolean = false) =>
    computeListArmed(prev, props.isOpen?.() ?? true, locationReady(), allQueriesIdle(), hasData()),
  );

  // One-shot cache-identity snapshot for the idle warm-up scheduler below.
  // Always invoked from untracked contexts (microtasks, visibility events,
  // ladder notifications), so take it explicitly untracked.
  const prefetchIdentity = () =>
    untrack(() => {
      const snapshot = effectiveAgency();
      const locationPermissionApproved =
        snapshot?.source === "dev-spoof" ||
        snapshot?.status === "granted" ||
        snapshot?.status === "stale";
      if (!locationPermissionApproved) return null;

      const location = queryLocation();
      if (!location) return null;

      return JSON.stringify({
        location,
        agencyId: agencyId(),
        coveringIds: effectiveAgency()?.coveringIds ?? [],
        stationCoveringIds: effectiveAgency()?.stationCoveringIds ?? [],
        favouriteStations: userPrefs.preferences.favouriteStations,
        favouriteSurfaceRoutes: userPrefs.preferences.favouriteSurfaceRoutes,
      });
    });

  let scheduledPrefetchIdentity: string | null = null;
  let prefetchDelayTimer: ReturnType<typeof setTimeout> | undefined;
  let idlePrefetchId: number | undefined;
  let prefetchDisposed = false;

  const cancelScheduledPrefetch = () => {
    if (prefetchDelayTimer !== undefined) {
      clearTimeout(prefetchDelayTimer);
      prefetchDelayTimer = undefined;
    }
    if (
      idlePrefetchId !== undefined &&
      typeof window !== "undefined" &&
      typeof window.cancelIdleCallback === "function"
    ) {
      window.cancelIdleCallback(idlePrefetchId);
      idlePrefetchId = undefined;
    }
  };

  const idlePrefetchEligible = () => {
    if (typeof window === "undefined" || document.visibilityState === "hidden") return false;
    if (navigator.onLine === false) return false;

    const connection = (
      navigator as Navigator & {
        connection?: { effectiveType?: string; saveData?: boolean };
      }
    ).connection;
    return (
      !connection?.saveData &&
      connection?.effectiveType !== "slow-2g" &&
      connection?.effectiveType !== "2g"
    );
  };

  const scheduleIdlePrefetch = (identity: string) => {
    if (prefetchDisposed || scheduledPrefetchIdentity === identity) return;

    cancelScheduledPrefetch();
    scheduledPrefetchIdentity = identity;

    const run = () => {
      prefetchDelayTimer = undefined;
      idlePrefetchId = undefined;

      if (prefetchDisposed || prefetchIdentity() !== identity || !idlePrefetchEligible()) {
        scheduledPrefetchIdentity = null;
        return;
      }

      // This is deliberately fire-and-forget: the panel's visible query owns
      // error presentation, while the idle warm-up remains best-effort.
      void prefetch();
    };

    const requestIdle = () => {
      if (prefetchDisposed) return;
      if (typeof window !== "undefined" && typeof window.requestIdleCallback === "function") {
        idlePrefetchId = window.requestIdleCallback(run, { timeout: 1500 });
      } else {
        prefetchDelayTimer = setTimeout(run, 250);
      }
    };

    // Give hydration, the first map paint, and the initial status snapshot a
    // quiet head start before asking the browser for an idle slice.
    prefetchDelayTimer = setTimeout(requestIdle, 1000);
  };

  onSettled(() => {
    const scheduleForCurrentLocation = () => {
      // EffectiveAgency is updated from the same ladder notification. Queue
      // this read so the context exposes the new snapshot before deriving the
      // cache identity.
      queueMicrotask(() => {
        if (prefetchDisposed) return;
        const identity = prefetchIdentity();
        if (identity) scheduleIdlePrefetch(identity);
      });
    };
    const handleVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      const identity = prefetchIdentity();
      if (identity) scheduleIdlePrefetch(identity);
    };
    const unsubscribeLocation = getLocationLadder().subscribe(scheduleForCurrentLocation);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    scheduleForCurrentLocation();
    return () => {
      prefetchDisposed = true;
      unsubscribeLocation();
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      cancelScheduledPrefetch();
      scheduledPrefetchIdentity = null;
    };
  });

  const hasMultipleAgencies = createMemo(() => {
    const all = [
      ...(mergedNearby() as readonly { agencyId?: string }[]),
      ...(savedStations() as readonly { agencyId?: string }[]),
      ...(savedArrivals() as readonly { agencyId?: string }[]),
    ];
    const ids = new Set(all.map((i) => i.agencyId ?? ""));
    ids.delete("");
    return ids.size > 1;
  });

  const keyedMergedNearby = createMemo(() =>
    keyListById(mergedNearby() as readonly (NearbyRouteArrival | NearbyStationArrival)[], (item) =>
      "stationName" in item
        ? `station:${(item as NearbyStationArrival).agencyId}:${item.id}`
        : `route:${(item as NearbyRouteArrival).agencyId}:${item.routeId}`,
    ),
  );

  const keyedSavedStations = createMemo(() =>
    keyListById(savedStations(), (station) => `${station.agencyId}:${station.id}`),
  );

  const keyedSavedArrivals = createMemo(() =>
    keyListById(savedArrivals(), (arrival) => `${arrival.agencyId}:${arrival.routeId}`),
  );

  const hasStaleArrivals = createMemo(() =>
    [...mergedNearby(), ...savedArrivals(), ...savedStations()].some(
      (item) => item.arrivalsStale === true,
    ),
  );

  onSettled(() => {
    // One-shot mount check, not a subscription.
    if (untrack(() => props.isOpen?.() ?? true) && untrack(() => geo.status()) === "idle") {
      geo.startPriming();
    }
  });

  return (
    <Errored
      fallback={(err) => {
        const error = typeof err === "function" ? err() : err;
        console.error("NEARBY PANEL ERROR:", error);
        return (
          <div class="flex flex-col items-center rounded-2xl border border-destructive/30 bg-muted p-5 text-center">
            <div class="text-[15px] font-semibold text-destructive">
              {t("Transit Data Unavailable")}
            </div>
            <div class="mt-1 text-[13px] text-muted-foreground">
              {error instanceof Error
                ? error.message
                : t("An error occurred loading nearby departures.")}
            </div>
            <button
              type="button"
              onClick={retry}
              class="mt-3.5 cursor-pointer rounded-xl bg-foreground px-4 py-2 text-[13px] font-semibold text-black transition-opacity hover:opacity-90 active:scale-98"
            >
              {t("Retry")}
            </button>
          </div>
        );
      }}
    >
      <div class="flex flex-col gap-2.5">
        <NearbyLocationGate
          status={geo.status()}
          spoofActive={isSpoofActive()}
          locationReady={locationReady()}
          hasData={hasData()}
          graceText={formattedTime()}
          agencyId={agencyId()}
          onRequestPermission={() => geo.requestLocation()}
          onDeferPriming={() => {
            geo.cancelPriming();
            props.onClose?.();
          }}
        />

        <Show when={isLoading() && locationReady()}>
          <div class="w-full">
            <NearbyLoadingSkeleton />
          </div>
        </Show>

        <Show when={locationReady()}>
          <Show when={hasStaleArrivals() && !fetchError()}>
            <div
              role="status"
              class="flex items-center gap-2.5 rounded-xl border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning-400"
            >
              <span class="text-base shrink-0">📡</span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold">{t("Live departure data delayed")}</div>
                <div class="text-[11px] text-warning-400/80 truncate">
                  {t("Showing destinations and any last-known times")}
                </div>
              </div>
              <button
                type="button"
                onClick={retry}
                class="shrink-0 cursor-pointer rounded-lg border border-warning/30 bg-warning/15 px-2.5 py-1 text-[11px] font-semibold text-warning-400 transition-colors hover:bg-warning/25"
              >
                {t("Retry")}
              </button>
            </div>
          </Show>

          <Show when={fetchError()}>
            <div class="flex items-center gap-2.5 rounded-xl border border-destructive/30 bg-destructive/10 p-2.5 text-xs text-destructive">
              <span class="text-base shrink-0">📡</span>
              <div class="flex-1 min-w-0">
                <div class="font-semibold text-destructive">{t("Connection issue")}</div>
                <div class="text-[11px] text-destructive/70 truncate">
                  {hasData()
                    ? t("Showing last known departures")
                    : t("Unable to load nearby transit data")}
                </div>
              </div>
              <button
                type="button"
                onClick={retry}
                class="shrink-0 cursor-pointer rounded-lg border border-destructive/30 bg-destructive/15 px-2.5 py-1 text-[11px] font-semibold text-destructive transition-colors hover:bg-destructive/25 hover:text-destructive-300"
              >
                {t("Retry")}
              </button>
            </div>
          </Show>

          <Show when={!hasData() && !isLoading() && !fetchError()}>
            <NearbyEmptyState
              agencyId={agencyId()}
              isOutsideServiceArea={isOutsideServiceArea()}
              isOutsideCoverage={isOutsideCoverage()}
              onRefresh={retry}
            />
          </Show>

          {/* Concrete row elements keep each card's conditional reads in its
              own binding instead of collecting the whole list in one effect. */}
          <div class="flex flex-col gap-2">
            <For each={listArmed() ? keyedMergedNearby().ids : []}>
              {(id) => {
                // Rows mount only once armed; the lookup itself
                // stays a plain map read so Show values track normally.
                const item = () => keyedMergedNearby().byId.get(id);

                return (
                  <div class="contents">
                    <Show when={item()}>
                      {(it) => {
                        // One-time immutable snapshot: Show-child bodies are
                        // owners, not tracking scopes, so read it() explicitly
                        // untracked here. Keys are
                        // immutable per row; live data keeps flowing through the
                        // item() lookups used in JSX below.
                        const snap = untrack(() => {
                          const snapshot = it();
                          const stationRow = "stationName" in snapshot;
                          return {
                            isStationRow: stationRow,
                            routeKey: stationRow
                              ? ""
                              : routeCardKey(
                                  (snapshot as NearbyRouteArrival).agencyId,
                                  (snapshot as NearbyRouteArrival).routeId,
                                ),
                            stationKey: stationRow
                              ? stationCardKey(
                                  (snapshot as NearbyStationArrival).agencyId,
                                  (snapshot as NearbyStationArrival).id,
                                )
                              : "",
                          };
                        });
                        const isStation = () => snap.isStationRow;
                        const stationItem = () => it() as NearbyStationArrival;
                        const routeItem = () => it() as NearbyRouteArrival;
                        const isExpanded = () => expandedRouteId() === snap.routeKey;
                        const isStationExpanded = () => expandedRouteId() === snap.stationKey;
                        const directionId = () =>
                          (snap.routeKey ? routeDirections()[snap.routeKey] : undefined) ??
                          routeItem()?.directionId ??
                          0;

                        return (
                          <Switch>
                            <Match when={isStation()}>
                              <StationArrivalCard
                                station={stationItem()}
                                showAgencyBadge={hasMultipleAgencies()}
                                allowExpand={Boolean(
                                  stationItem().agencyId !== agencyId() ||
                                  stationItem().routeType !== "subway",
                                )}
                                isExpanded={isStationExpanded()}
                                onToggleExpand={() => handleToggleExpand(snap.stationKey)}
                                onRegisterFirstActionable={(element) =>
                                  untrack(() =>
                                    props.onRegisterFirstActionable?.(snap.stationKey, element),
                                  )
                                }
                              />
                            </Match>
                            <Match when={!isStation()}>
                              <RouteArrivalCard
                                arrival={routeItem()}
                                isExpanded={isExpanded()}
                                onToggleExpand={() => handleToggleExpand(snap.routeKey)}
                                selectedDirectionId={directionId()}
                                onSelectDirection={(dir) =>
                                  handleSelectDirection(snap.routeKey, dir)
                                }
                                onCaptureTargetedInvoker={props.onCaptureTargetedInvoker}
                                onRegisterFirstActionable={(element) =>
                                  untrack(() =>
                                    props.onRegisterFirstActionable?.(snap.routeKey, element),
                                  )
                                }
                                onEnlargeRoute={props.onEnlargeRoute}
                                showAgencyBadge={hasMultipleAgencies()}
                              />
                            </Match>
                          </Switch>
                        );
                      }}
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>

          <Show when={savedStations().length > 0 || savedArrivals().length > 0}>
            <div class="flex flex-col gap-2">
              <div class="flex items-center gap-1.5 px-1 pt-1 text-[11px] font-bold uppercase tracking-wider text-muted-foreground">
                <StarIcon size={12} filled class="text-warning-400" />
                <span>{t("Favourites")}</span>
              </div>
              <For each={listArmed() ? keyedSavedStations().ids : []}>
                {(stationId) => {
                  const station = () => keyedSavedStations().byId.get(stationId);
                  return (
                    <div class="contents">
                      <Show when={station()}>
                        {(st) => {
                          // One-time immutable snapshot, explicitly untracked:
                          // Show-child bodies are owners, not tracking scopes.
                          // Station identity never
                          // changes per row; live data flows via station={st()}.
                          const key = untrack(() => stationCardKey(st().agencyId, st().id));
                          return (
                            <StationArrivalCard
                              station={st()}
                              showAgencyBadge={hasMultipleAgencies()}
                              onRegisterFirstActionable={(element) =>
                                untrack(() => {
                                  props.onRegisterFirstActionable?.(key, element);
                                })
                              }
                            />
                          );
                        }}
                      </Show>
                    </div>
                  );
                }}
              </For>
              <For each={listArmed() ? keyedSavedArrivals().ids : []}>
                {(routeId) => {
                  const arrival = () => keyedSavedArrivals().byId.get(routeId);

                  return (
                    <div class="contents">
                      <Show when={arrival()}>
                        {(arr) => {
                          // One-time immutable snapshot in a single untracked
                          // read (Show-child bodies are owners, not tracking
                          // scopes). Route identity
                          // never changes per row; live data flows via
                          // arrival={arr()} in JSX below.
                          const snap = untrack(() => {
                            const s = arr();
                            return {
                              routeKey: routeCardKey(s.agencyId, s.routeId),
                              fallbackDirection: s.directionId ?? 0,
                            };
                          });
                          const isExpanded = () => expandedRouteId() === snap.routeKey;
                          const directionId = () =>
                            routeDirections()[snap.routeKey] ?? snap.fallbackDirection;

                          return (
                            <RouteArrivalCard
                              arrival={arr()}
                              isExpanded={isExpanded()}
                              onToggleExpand={() => handleToggleExpand(snap.routeKey)}
                              selectedDirectionId={directionId()}
                              onSelectDirection={(dir) => handleSelectDirection(snap.routeKey, dir)}
                              onCaptureTargetedInvoker={props.onCaptureTargetedInvoker}
                              onRegisterFirstActionable={(element) =>
                                untrack(() =>
                                  props.onRegisterFirstActionable?.(snap.routeKey, element),
                                )
                              }
                              onEnlargeRoute={props.onEnlargeRoute}
                              showAgencyBadge={hasMultipleAgencies()}
                            />
                          );
                        }}
                      </Show>
                    </div>
                  );
                }}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </Errored>
  );
}
