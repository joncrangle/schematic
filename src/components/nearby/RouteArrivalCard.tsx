import { createControllableSignal } from "~/lib/createControllableSignal";
import { createMemo, For, Show, untrack } from "solid-js";
import { cn } from "~/lib/utils";
import type {
  NearbyDirectionInfo,
  NearbyRouteArrival,
  RouteTrackingData,
} from "~/domain/surface/types";
import { classifySurfaceAlert, sortSurfaceAlerts } from "~/domain/surface/surfaceAlerts";
import { formatDistance } from "./nearbyHelpers";
import { DirectionArrivalsRow } from "./DirectionArrivalsRow";
import { useLiveCountdown } from "~/hooks/useLiveCountdown";
import {
  readCachedRouteTracking,
  type RouteEnlargeRequest,
  useRouteTrackingHandle,
} from "~/lib/routeTrackingLifecycle";
import { useAgencySession } from "~/context/AgencySessionContext";
import { LinearStopStrip } from "~/components/route/LinearStopStrip";
import { RouteAlertBanner, surfaceAlertTone } from "~/components/route/RouteAlertBanner";
import { getAgencyById } from "~/agencies/browserRegistry";
import {
  buildDirectionOptions,
  deriveApproachingVehicleEtas,
  getRouteDirectionsForRoute,
} from "~/domain/surface/direction";
import { indexVehicleStops } from "~/domain/surface/corridor/index";
import { getSurfaceModeMeta } from "~/components/route/routeTrackingHelpers";
import { StarIcon } from "~/components/icons/StarIcon";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { handleActionKey } from "~/lib/keyboard";
import { agencyBadgeStyle, routeBadgeStyle } from "./nearbyHelpers";
import { isFavouriteSurfaceRoute } from "~/domain/preferences/UserPreferences";
import { useI18n } from "~/i18n/I18nContext";
import { presentDirectionLabel } from "~/components/route/directionPresentation";

/**
 * Collapsed rows read tracking data non-reactively via readCachedRouteTracking
 * without owning the 10s renewal lifecycle (routeTrackingLifecycle), so their
 * cached vehicle positions can age arbitrarily. Positions staler than this
 * window must not drive countdown derivation. Expanded rows hold an active
 * handle that renews every 10s and are exempt from the gate.
 *
 * Server vs presentation derivation (C1 decision 2026-08-27):
 * NearbyTransit is the SOLE authoritative server-side deriveApproachingVehicleEtas
 * call site (selection→fetch→fuse→stale owns the heuristic). This component's
 * derive call is presentation-only fallback for collapsed-row stale cache reads
 * where no server payload exists and the 10s lifecycle isn't owned. Keeping it
 * here avoids empty countdowns on stale client cache; removing it would hide
 * live data behind an empty state. Documented explicitly so single-site audits
 * distinguish server authority (NearbyTransit) from client presentation.
 * The staleness window itself lives in the direction seam as
 * COLLAPSED_TRACKING_MAX_AGE_MS.
 */

export interface RouteArrivalCardProps {
  arrival: NearbyRouteArrival;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  selectedDirectionId?: number;
  onSelectDirection?: (directionId: number) => void;
  onEnlargeRoute?: (request: RouteEnlargeRequest) => void;
  onCaptureTargetedInvoker?: (element: HTMLElement) => void;
  onRegisterFirstActionable?: (element: HTMLElement) => void;
  showAgencyBadge?: boolean;
}

function AgencyBadge(props: { agencyId: string }) {
  const label = () => props.agencyId.toUpperCase();
  const style = () => agencyBadgeStyle(props.agencyId);
  return (
    <span
      data-testid="agency-badge"
      class="inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold uppercase tracking-wide shadow-xs"
      style={style()}
    >
      {label()}
    </span>
  );
}

/**
 * Collapsed-row label for one direction (honest inferred-direction rule).
 * A rider must never see a factually incorrect direction: when the direction
 * was inferred (not read from the operator), the compass word is our guess,
 * not the feed's, so it is dropped and only the operator's own text is
 * shown. Rule, gated ONLY on directionInferred (core-generic, no agency
 * branch): (a) destination present and NOT inferred -> `Eastbound → Fairway`
 * (known direction keeps compass context); (b) destination present and
 * inferred -> `→ Fairway` ONLY (drop the guessed compass, show to-station);
 * (c) else headsign present and != label -> `→ headsign` (operator text,
 * regardless of inferred); (d) else inferred -> "" (stop + times only, never
 * a false compass claim); (e) else bare label (legacy/real payloads without
 * the flag). Never invents text when neither exists; never renders " to "
 * with an empty destination. Whitespace-only destination/headsign counts as
 * absent.
 */
export function collapsedDirectionLabel(
  direction: Pick<NearbyDirectionInfo, "label" | "destination" | "headsign" | "generatedLabel">,
  displayLabel = direction.label,
): string {
  const destination = direction.destination?.trim() ?? "";
  // `directionInferred` describes the realtime wire, not the label. A label
  // read from the route's own shape geometry is the operator's geometry, and
  // the shape runs in the direction the vehicle travels, so it is rendered
  // even when the wire named no direction. Withholding it here is what kept a
  // rail route reading "→ Aldershot GO" when Core had derived "Westbound" from
  // the operator's own polyline.
  //
  // The arrow belongs to the destination, not to the label. A stated bearing
  // reads "Northbound → Steeles Ave"; with no bearing stated it reads
  // "→ Steeles Ave". Dropping the arrow because the label is empty removes the
  // only cue that a terminal is being named at all.
  const withDirection = (label: string) =>
    label.trim() ? `${label} → ${destination}` : `→ ${destination}`;
  if (destination) {
    return withDirection(displayLabel);
  }
  const headsign = direction.headsign?.trim() ?? "";
  if (headsign && headsign !== direction.label) {
    return `→ ${headsign}`;
  }
  return displayLabel;
}

export function RouteArrivalCard(props: RouteArrivalCardProps) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const userPrefs = useUserPreferences();
  const session = useAgencySession();
  const fallbackAgencyId = () => session.displayedAgencyId() ?? "";
  const cardAgencyId = () => props.arrival?.agencyId || fallbackAgencyId();

  const isFavourited = () =>
    props.arrival
      ? isFavouriteSurfaceRoute(userPrefs.preferences, cardAgencyId(), props.arrival.routeId)
      : false;

  const [isExpanded, setIsExpanded] = createControllableSignal(
    () => props.isExpanded,
    () => false,
  );
  const [activeDirectionId, setActiveDirectionId] = createControllableSignal(
    () => props.selectedDirectionId,
    () => props.arrival?.directionId ?? 0,
  );
  const { formatCountdown } = useLiveCountdown();

  // When NearbyTransit omits a terminal direction, keep that direction out of
  // both the client fallback and the expanded route controls. Older payloads
  // without per-direction data retain the existing two-direction behavior.
  const isDirectionAvailable = (directionId: number): boolean => {
    const directions = props.arrival?.directions;
    return (
      directions === undefined ||
      directions.some((direction) => direction.directionId === directionId)
    );
  };

  // Keyed target for the active direction while expanded; changing direction
  // (or collapsing) swaps/releases the acquired handle cleanly.
  const trackingTarget = createMemo(
    () =>
      isExpanded() && props.arrival && isDirectionAvailable(activeDirectionId())
        ? {
            agencyId: cardAgencyId(),
            routeId: props.arrival.routeId,
            directionId: activeDirectionId(),
          }
        : null,
    {
      equals: (a, b) =>
        a === b ||
        (!!a &&
          !!b &&
          a.agencyId === b.agencyId &&
          a.routeId === b.routeId &&
          a.directionId === b.directionId),
    },
  );

  const trackingHandle = useRouteTrackingHandle(trackingTarget);

  // Expanded rows own a live tracking lifecycle (10s renewal, single-flight
  // dedup) through routeTrackingLifecycle. Collapsed rows take a read-only
  // view of the shared TanStack cache so countdown derivation keeps working
  // without driving the network.
  const trackingData = (): RouteTrackingData | null => {
    const live = trackingHandle()?.data();
    if (live) return live;
    const routeId = props.arrival?.routeId;
    return routeId
      ? readCachedRouteTracking({
          agencyId: cardAgencyId(),
          routeId,
          directionId: activeDirectionId(),
          locale: locale(),
        })
      : null;
  };

  const vehicleStopIndices = createMemo(() => {
    const tracking = trackingData();
    return tracking ? indexVehicleStops(tracking.vehicles, tracking.stops) : undefined;
  });

  const toggleExpanded = () => {
    if (props.onToggleExpand) {
      props.onToggleExpand();
    } else {
      setIsExpanded(!isExpanded());
    }
  };

  const handleSelectDirection = (dir: number) => {
    if (props.onSelectDirection) {
      props.onSelectDirection(dir);
    } else {
      setActiveDirectionId(dir);
    }
  };

  const currentDirectionInfo = createMemo(() =>
    props.arrival?.directions?.find((d) => d.directionId === activeDirectionId()),
  );

  const currentStopName = createMemo(
    () => currentDirectionInfo()?.stopName ?? props.arrival?.stopName ?? "",
  );

  const currentDistanceMeters = createMemo(
    () => currentDirectionInfo()?.distanceMeters ?? props.arrival?.distanceMeters ?? 0,
  );

  // Whether the direction row repeats the station name. On rail it does not,
  // because the name row above already carries it.
  const showsStopNameInDirectionRow = createMemo(
    () => props.arrival?.routeType !== "rail" && Boolean(currentStopName()),
  );

  // The name beside the route badge.
  //
  // A bus or streetcar card is identified by its route, and the operator names
  // that route: "504 King". The badge alone is a number, so the long name earns
  // its place.
  //
  // A rail card is anchored to a station instead, and its badge is a line code
  // ("LW") that expands to a corridor rather than naming where the rider is
  // standing. So on rail the station is the more useful of the two, and the
  // corridor name is what gets dropped.
  const headerName = createMemo(() => {
    if (props.arrival?.routeType !== "rail") return props.arrival?.routeLongName ?? "";
    // Never leave the name row empty: a card whose header says nothing about
    // itself is worse than one repeating the corridor.
    return currentStopName() || props.arrival?.routeLongName || "";
  });

  const currentStopLat = createMemo(
    () => currentDirectionInfo()?.stopLat ?? props.arrival?.stopLat ?? 0,
  );

  const currentStopLon = createMemo(
    () => currentDirectionInfo()?.stopLon ?? props.arrival?.stopLon ?? 0,
  );

  const currentStopId = createMemo(
    () => currentDirectionInfo()?.stopId ?? props.arrival?.stopId ?? "",
  );

  const riderStop = createMemo(() => ({
    id: currentStopId(),
    lat: currentStopLat(),
    lon: currentStopLon(),
  }));

  const stripTracking = createMemo(() => trackingData());

  const currentArrivals = createMemo(() => {
    if (!isDirectionAvailable(activeDirectionId())) return [];

    const dirInfo = currentDirectionInfo();
    if (dirInfo && dirInfo.arrivals.length > 0) {
      return dirInfo.arrivals;
    }
    if (
      activeDirectionId() === props.arrival?.directionId &&
      (props.arrival?.arrivals?.length ?? 0) > 0
    ) {
      return props.arrival!.arrivals;
    }

    // Derive arrival countdowns from live approaching vehicles on the corridor
    const tracking = trackingData();
    if (tracking && tracking.stops.length > 0 && tracking.vehicles.length > 0) {
      return deriveApproachingVehicleEtas({
        stops: tracking.stops,
        vehicles: tracking.vehicles,
        riderStop: riderStop(),
        directionId: activeDirectionId(),
        now: Date.now(),
        maxResults: 3,
        vehicleStopIndices: vehicleStopIndices(),
        // No active handle → non-reactive cache read that nobody renews, so
        // omit the gate to take the direction-seam default
        // (COLLAPSED_TRACKING_MAX_AGE_MS) and keep stale vehicle positions
        // out of countdowns. An active handle means expanded-row renewal
        // (10s) owns freshness and stays explicitly age-blind.
        ...(trackingHandle() ? { maxVehicleAgeMs: undefined as number | undefined } : {}),
      });
    }

    return [];
  });

  const hasAlerts = () => (props.arrival?.alerts?.length ?? 0) > 0;
  const hasKnownArrivals = () =>
    (props.arrival?.arrivals?.length ?? 0) > 0 ||
    (props.arrival?.directions?.some((direction) => direction.arrivals.length > 0) ?? false);

  // Collapsed card: both directions' due times when the server payload
  // carries per-direction data. Null (expanded, or no directions data)
  // falls back to the active-direction row below.
  const collapsedDirections = createMemo(() => {
    if (isExpanded()) return null;
    const dirs = props.arrival?.directions?.filter((d) => d.arrivals.length > 0) ?? [];
    return dirs.length > 0 ? dirs : null;
  });

  // Per-direction options use the same domain helper as RouteControls and the
  // strip. The server payload supplies both directions; a live tracking
  // headsign is layered onto the active direction through that helper too.
  const directionOptions = createMemo(() => {
    // The axis applies wherever the feed states no direction of its own, which
    // is where the canonical routeType pair can be the wrong axis. It only ever
    // fills a direction nothing was stated for.
    const agency = getAgencyById(cardAgencyId());
    const base = getRouteDirectionsForRoute(
      props.arrival?.routeType ?? "bus",
      props.arrival?.routeId ?? "",
      agency?.manifest.routeInterpretation,
    );
    const availableDirections = props.arrival?.directions;
    const payloadLabels: Record<
      number,
      { label: string; destination: string; generatedLabel?: NearbyDirectionInfo["generatedLabel"] }
    > = {};
    for (const d of props.arrival?.directions ?? []) {
      payloadLabels[d.directionId] = {
        label: d.label,
        destination: d.destination,
        ...(d.generatedLabel ? { generatedLabel: d.generatedLabel } : {}),
      };
    }
    // A route can declare more than two directions, and the
    // canonical pair only ever supplies 0/1. Any further direction gets an
    // option from the payload's own label and destination so it is selectable.
    const payloadOptions = availableDirections
      ? [
          ...base.filter((direction) =>
            availableDirections.some(
              (available) => available.directionId === direction.directionId,
            ),
          ),
          ...availableDirections
            .filter((available) => !base.some((d) => d.directionId === available.directionId))
            .map((available) => ({
              directionId: available.directionId,
              label: available.label,
              destination: available.destination ?? "",
              ...(available.generatedLabel ? { generatedLabel: available.generatedLabel } : {}),
            })),
        ]
      : base;

    return buildDirectionOptions({
      base: payloadOptions,
      directionLabels: payloadLabels,
      activeDirectionId: activeDirectionId(),
      inferOppositeDirection: true,
    });
  });

  const currentHeadsign = createMemo(() => {
    const option = directionOptions().find((d) => d.directionId === activeDirectionId());
    if (!option) return props.arrival?.headsign ?? "";
    return collapsedDirectionLabel(
      {
        label: option.label,
        destination: option.destination,
        headsign: currentDirectionInfo()?.headsign ?? "",
        generatedLabel: option.generatedLabel,
      },
      presentDirectionLabel(option.label, option.generatedLabel, t),
    );
  });

  // Collapsed-card severity chip: most critical alert drives label + color
  const chipPresentation = createMemo(() => {
    const alerts = props.arrival?.alerts;
    if (!alerts || alerts.length === 0) return null;
    const sorted = sortSurfaceAlerts(alerts);
    const top = sorted[0];
    return top ? classifySurfaceAlert(top) : null;
  });
  const chipTone = createMemo(() =>
    chipPresentation() ? surfaceAlertTone(chipPresentation()!.severity) : null,
  );

  const routeBadgeClass = createMemo(() => {
    // Background and text colour come from the same source, so the feed's
    // pair is never split across the arrival and the tracking fallback.
    const arrivalColor = props.arrival?.routeColor;
    const colours =
      arrivalColor !== undefined
        ? { routeColor: arrivalColor, routeTextColor: props.arrival?.routeTextColor }
        : {
            routeColor: trackingData()?.route.color,
            routeTextColor: trackingData()?.route.textColor,
          };
    return routeBadgeStyle({
      agencyId: cardAgencyId(),
      ...colours,
      routeId: props.arrival?.routeId,
      routeShortName: props.arrival?.routeShortName,
      routeLongName: props.arrival?.routeLongName,
      routeType: props.arrival?.routeType,
    });
  });

  return (
    <div
      class={cn(
        "rounded-xl border border-border bg-muted p-3 transition-colors group",
        !isExpanded() && "cursor-pointer hover:border-ring hover:bg-accent",
        isExpanded() && "border-ring bg-muted",
      )}
      onClick={() => {
        if (!isExpanded()) {
          toggleExpanded();
        }
      }}
    >
      {/* Clickable Card Header */}
      <div
        ref={(element) => untrack(() => props.onRegisterFirstActionable?.(element))}
        role="button"
        tabindex={0}
        onClick={(e) => {
          if (isExpanded()) {
            e.stopPropagation();
            toggleExpanded();
          }
        }}
        onKeyDown={handleActionKey(toggleExpanded)}
        class="cursor-pointer select-none"
      >
        <div class="flex items-center justify-between gap-2 mb-1.5">
          <div class="flex items-center gap-2 min-w-0">
            <Show when={props.showAgencyBadge && props.arrival}>
              <AgencyBadge agencyId={props.arrival?.agencyId ?? ""} />
            </Show>
            <span
              class="shrink-0 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-bold shadow-xs"
              style={routeBadgeClass()}
            >
              <span class="text-[10px] leading-none inline-flex items-center" aria-hidden="true">
                {props.arrival
                  ? getSurfaceModeMeta(props.arrival.routeType).icon({ size: 12 })
                  : null}
              </span>
              <span>{props.arrival?.routeShortName}</span>
            </span>
            <span class="truncate text-[13px] font-semibold text-foreground group-hover:text-white transition-colors">
              {headerName()}
            </span>
          </div>

          <div class="flex items-center gap-1.5 shrink-0">
            {/* Feed-degraded indicator: countdowns keep
                ticking from retained data; the chip says they're last known. */}
            <Show when={props.arrival?.arrivalsStale && hasKnownArrivals()}>
              <span
                role="status"
                aria-label={t("Showing last known arrivals; live feed unavailable")}
                class={cn(
                  "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
                  "border-warning/30 bg-warning/6 text-warning-400",
                )}
              >
                {t("Last known")}
              </span>
            </Show>
            <Show when={!isExpanded() && hasAlerts() && chipPresentation() && chipTone()}>
              <span
                role="status"
                aria-label={t("{{line}} advisory, {{severity}} severity", {
                  line: chipPresentation()!.label,
                  severity: chipPresentation()!.severity,
                })}
                class={cn(
                  "inline-flex shrink-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
                  chipTone()!.border,
                  chipTone()!.bg,
                  chipTone()!.accentText,
                )}
              >
                <span aria-hidden="true">⚠️</span>
                <span>{chipPresentation()!.label}</span>
              </span>
            </Show>
            <span class="text-[11px] text-muted-foreground flex items-center gap-1">
              <span>📍</span>
              <span>{formatDistance(currentDistanceMeters(), i18n)}</span>
            </span>
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (props.arrival) {
                  userPrefs.toggleFavouriteSurfaceRoute(cardAgencyId(), props.arrival.routeId);
                }
              }}
              aria-label={
                isFavourited()
                  ? t("Remove {{name}} from favourites", {
                      name: t("Route {{id}}", { id: props.arrival?.routeShortName ?? "" }),
                    })
                  : t("Add {{name}} to favourites", {
                      name: t("Route {{id}}", { id: props.arrival?.routeShortName ?? "" }),
                    })
              }
              class={cn(
                "flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded transition-colors",
                isFavourited()
                  ? "text-warning-400 hover:text-warning-300"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              <StarIcon size={14} filled={isFavourited()} />
            </button>
            <span class="text-xs text-muted-foreground group-hover:text-foreground group-hover:scale-110 transition-all duration-200">
              {isExpanded() ? "▲" : "▼"}
            </span>
          </div>
        </div>

        {/* Direction & Stop Name. Both parts are optional and the separator is tied
            to what actually renders, so neither an inferred compass word nor a
            missing direction leaves a dangling "•". On rail the station is
            already in the header's name row and is not repeated here. */}
        <div class="mb-2 text-[11.5px] text-muted-foreground truncate">
          <Show when={currentHeadsign()}>
            <span>{currentHeadsign()}</span>
            <Show when={showsStopNameInDirectionRow()}>
              <span class="mx-1">•</span>
            </Show>
          </Show>
          <Show when={showsStopNameInDirectionRow()}>
            <span class="text-muted-foreground">{currentStopName()}</span>
          </Show>
        </div>
      </div>

      {/* Prominent Alert Banner (expanded only, below route header, above countdowns/minimap) */}
      <Show when={isExpanded() && hasAlerts() && props.arrival}>
        <div class="mb-2" onClick={(e) => e.stopPropagation()}>
          <RouteAlertBanner alerts={props.arrival!.alerts} />
        </div>
      </Show>

      {/* Departure Countdown Pills, one aligned row per direction; collapsed
          shows BOTH directions when per-direction data exists, otherwise/
          expanded: active direction */}
      <div class="flex flex-col gap-1.5">
        <Show when={collapsedDirections()}>
          <For each={collapsedDirections() ?? []}>
            {(dir) => (
              <DirectionArrivalsRow
                label={collapsedDirectionLabel(
                  dir,
                  presentDirectionLabel(dir.label, dir.generatedLabel, t),
                )}
                times={dir.arrivals}
              />
            )}
          </For>
        </Show>
        <Show when={!collapsedDirections()}>
          <div class="flex items-center gap-1.5">
            <Show
              when={currentArrivals().length > 0}
              fallback={
                <span
                  role={props.arrival?.arrivalsStale ? "status" : undefined}
                  class="text-[11px] italic text-muted-foreground"
                >
                  {props.arrival?.arrivalsStale
                    ? t("Live departures unavailable")
                    : t("No active departures")}
                </span>
              }
            >
              <For each={currentArrivals()}>
                {(arrivalEpoch, index) => {
                  const formatted = () => formatCountdown(arrivalEpoch);
                  const isNext = () => index() === 0;

                  return (
                    <span
                      class={cn(
                        "rounded-lg px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap tabular-nums transition-colors",
                        isNext()
                          ? "border border-live/40 bg-live/15 text-live-400"
                          : "border border-border bg-accent text-white",
                      )}
                    >
                      {formatted()}
                    </span>
                  );
                }}
              </For>
              <Show when={currentHeadsign()}>
                <span class="text-[10px] text-muted-foreground ml-0.5 truncate">
                  {currentHeadsign()}
                </span>
              </Show>
            </Show>
          </div>
        </Show>
      </div>

      {/* Inline Linear Stop Strip & Direction Switcher Accordion */}
      <Show when={isExpanded()}>
        <div onClick={(e) => e.stopPropagation()}>
          <Show
            when={stripTracking()}
            fallback={
              <div
                data-testid="route-strip-skeleton"
                class="mt-3 rounded-xl border border-border bg-background p-3.5 animate-in fade-in duration-150"
              >
                <div class="flex items-center justify-between gap-2 mb-3">
                  <div class="h-5 w-28 rounded-md bg-muted animate-pulse" />
                  <div class="h-5 w-20 rounded-md bg-muted animate-pulse" />
                </div>
                <div class="flex items-center justify-between gap-2 py-2 overflow-hidden">
                  <For each={[1, 2, 3, 4, 5, 6]}>
                    {() => (
                      <div class="flex flex-col items-center gap-1.5 shrink-0">
                        <div class="h-3 w-3 rounded-full bg-accent animate-pulse" />
                        <div class="h-2 w-8 rounded bg-muted animate-pulse" />
                      </div>
                    )}
                  </For>
                </div>
              </div>
            }
          >
            <LinearStopStrip
              tracking={stripTracking()!}
              riderStop={riderStop()}
              directionOptions={directionOptions()}
              selectedDirectionId={activeDirectionId()}
              onSelectDirection={handleSelectDirection}
              onCaptureTargetedInvoker={props.onCaptureTargetedInvoker}
              onEnlargeRoute={
                props.onEnlargeRoute
                  ? () => {
                      if (!props.arrival) return;
                      props.onEnlargeRoute?.({
                        routeId: props.arrival.routeId,
                        directionId: activeDirectionId(),
                        stopId: currentStopId(),
                        agencyId: cardAgencyId(),
                      });
                    }
                  : undefined
              }
              prefersReducedMotion={userPrefs.isEffectiveReducedMotion()}
              vehicleStopIndices={vehicleStopIndices()}
            />
          </Show>
        </div>
      </Show>
    </div>
  );
}
