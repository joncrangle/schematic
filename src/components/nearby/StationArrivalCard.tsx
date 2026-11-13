import { createMemo, createSignal, For, Show, untrack } from "solid-js";
import { cn } from "~/lib/utils";
import type { NearbyStationArrival } from "~/domain/surface/types";
import { formatDistance, agencyBadgeStyle } from "./nearbyHelpers";
import { LineBadgeCircle } from "./LineBadgeCircle";
import { DirectionArrivalsRow } from "./DirectionArrivalsRow";
import { StationDeparturesSection } from "./StationDeparturesSection";
import { StarIcon } from "~/components/icons/StarIcon";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { LinearStopStrip } from "~/components/route/LinearStopStrip";
import { readCachedRouteTracking, useRouteTrackingHandle } from "~/lib/routeTrackingLifecycle";
import { indexVehicleStops } from "~/domain/surface/corridor/index";
import { handleActionKey } from "~/lib/keyboard";
import { isFavouriteStation } from "~/domain/preferences/UserPreferences";
import { useI18n } from "~/i18n/I18nContext";

export interface StationArrivalCardProps {
  station: NearbyStationArrival;
  showAgencyBadge?: boolean;
  /** Cross-agency station cards may expose the existing horizontal route strip. */
  allowExpand?: boolean;
  isExpanded?: boolean;
  onToggleExpand?: () => void;
  onRegisterFirstActionable?: (element: HTMLElement) => void;
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

export function StationArrivalCard(props: StationArrivalCardProps) {
  const i18n = useI18n();
  const { t, locale } = i18n;
  const userPrefs = useUserPreferences();
  const cardAgencyId = () => props.station?.agencyId ?? "";
  const lineId = () => props.station?.lineIds?.[0];
  const trackingRouteId = () =>
    props.station?.trackingRouteId ?? (props.station?.livePredictionsOnly ? undefined : lineId());
  const stationTitle = () =>
    props.station
      ? props.station.routeType === "rail"
        ? props.station.lineName
          ? t("{{line}} at {{station}}", {
              line: props.station.lineName,
              station: props.station.stationName,
            })
          : props.station.stationName
        : props.station.stationName
      : "";
  const hasKnownArrivals = () =>
    Boolean(props.station?.arrivals?.some((group) => group.times.length > 0));
  // Fallback identity: panel cards ride the index id (`${indexId}:${lineId}`
  // when split by line); the departures lookup matches either namespace, so
  // the base id is enough to recover rows the bulk payload missed.
  const fallbackStationId = () => (props.station?.id ?? "").split(":")[0] ?? "";
  const canExpand = () =>
    Boolean(props.station && props.allowExpand === true && trackingRouteId() !== undefined);
  const isExpanded = () => props.isExpanded === true;
  // The route and the direction of one expanded strip must come from the same
  // place. The route is `lineIds[0]` while `arrivals` is stored in time order,
  // so `arrivals[0]` is whichever mode departs soonest, not the mode the route
  // belongs to. Picking each independently put one mode's direction on another
  // mode's train: at a station where ION and route 7 both call, a bus leaving
  // first seeded direction 0 onto the ION strip. Every mode numbers its
  // directions from 0, so nothing detected the swap. Resolving the direction
  // from the groups that belong to the tracked line is the fix.
  const statedDirectionFor = (line: string | undefined): 0 | 1 => {
    const groups = props.station?.arrivals ?? [];
    // A group with no line id belongs to whichever line the card tracks.
    const own =
      line === undefined
        ? groups
        : groups.filter((g) => g.lineId === line || g.lineId === undefined);
    // No group states this line's direction. Another line's direction is the
    // mistake being fixed here, so the type's default stands rather than a
    // direction that is stated to belong to something else.
    return own[0]?.directionId ?? 0;
  };
  // The rider's own pick is remembered against the line it was made on, so it
  // survives a data refresh yet never carries across to a different line.
  const [chosenDirection, setChosenDirection] = createSignal<{
    lineId: string | undefined;
    directionId: 0 | 1;
  }>();
  // Keyed on the line alone. Re-deriving when the card switches station is
  // wanted; re-deriving when the feed refreshes is not, because a sooner
  // departure in the other direction would swap the strip out from under a
  // rider who has it open. Reading arrivals untracked keeps the refresh out of
  // the dependency set.
  const activeDirectionId = createMemo<0 | 1>(() => {
    const line = lineId();
    const chosen = chosenDirection();
    if (chosen?.lineId === line) return chosen.directionId;
    return untrack(() => statedDirectionFor(line));
  });
  const trackingTarget = createMemo(() => {
    const route = trackingRouteId();
    return canExpand() && isExpanded() && route
      ? { agencyId: cardAgencyId(), routeId: route, directionId: activeDirectionId() }
      : null;
  });
  const trackingHandle = useRouteTrackingHandle(trackingTarget);
  const trackingData = () => {
    const live = trackingHandle()?.data();
    if (live) return live;
    const routeId = trackingRouteId();
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

  const riderStop = createMemo(() => ({
    lat: props.station?.lat ?? 0,
    lon: props.station?.lon ?? 0,
  }));
  const stripTracking = createMemo(() => trackingData());

  const toggleExpanded = () => {
    if (canExpand()) props.onToggleExpand?.();
  };

  const isFavourited = () =>
    props.station
      ? isFavouriteStation(userPrefs.preferences, props.station.agencyId, props.station.stationName)
      : false;

  return (
    <div
      data-testid="station-arrival-card"
      class={cn(
        "group rounded-xl border border-border bg-muted p-3 transition-colors",
        canExpand() && !isExpanded() && "cursor-pointer hover:border-ring hover:bg-accent",
        canExpand() && isExpanded() && "border-ring",
      )}
      onClick={() => {
        if (canExpand() && !isExpanded()) toggleExpanded();
      }}
    >
      {/* Card header */}
      <div
        ref={(element) => {
          if (untrack(canExpand)) untrack(() => props.onRegisterFirstActionable?.(element));
        }}
        role={canExpand() ? "button" : undefined}
        tabindex={canExpand() ? 0 : undefined}
        aria-expanded={canExpand() ? (isExpanded() ? "true" : "false") : undefined}
        onClick={(event) => {
          if (canExpand()) {
            event.stopPropagation();
            toggleExpanded();
          }
        }}
        onKeyDown={(event) => {
          if (canExpand()) handleActionKey(toggleExpanded)(event);
        }}
        class={cn(
          "mb-1.5 flex items-center justify-between gap-2",
          canExpand() && "cursor-pointer",
        )}
      >
        <div class="flex min-w-0 items-center gap-2">
          <Show when={props.showAgencyBadge && props.station?.agencyId}>
            <AgencyBadge agencyId={props.station!.agencyId} />
          </Show>
          <LineBadgeCircle
            lineIds={props.station?.lineIds ?? []}
            agencyId={props.station?.agencyId ?? ""}
          />
          <span class="truncate text-[13px] font-semibold text-foreground transition-colors group-hover:text-white">
            {stationTitle()}
          </span>
        </div>

        <div class="flex shrink-0 items-center gap-1.5">
          <Show when={props.station?.arrivalsStale && hasKnownArrivals()}>
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
          <span class="flex items-center gap-1 text-[11px] text-muted-foreground">
            <span>📍</span>
            <span>{formatDistance(props.station?.distanceMeters ?? 0, i18n)}</span>
          </span>
          <Show when={canExpand()}>
            <span class="text-xs text-muted-foreground group-hover:text-foreground">
              {isExpanded() ? "▲" : "▼"}
            </span>
          </Show>
          <button
            ref={(element) => {
              if (!untrack(canExpand)) untrack(() => props.onRegisterFirstActionable?.(element));
            }}
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              if (props.station) {
                userPrefs.toggleFavouriteStation(props.station.agencyId, props.station.stationName);
              }
            }}
            aria-label={
              isFavourited()
                ? t("Remove {{name}} from favourites", {
                    name: t("{{name}} Station", { name: props.station?.stationName ?? "Station" }),
                  })
                : t("Add {{name}} to favourites", {
                    name: t("{{name}} Station", { name: props.station?.stationName ?? "Station" }),
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
        </div>
      </div>

      {/* Per-direction departures, bulk rows when known. An expanded card
          with a fresh but empty payload may have missed live data, so it falls
          back to the same arrivals-only source the map popover reads. A stale
          empty payload stays static because another request would only repeat
          the known feed failure. */}
      <Show
        when={hasKnownArrivals()}
        fallback={
          <Show
            when={!props.station?.arrivalsStale && fallbackStationId() && isExpanded()}
            fallback={
              <span
                role={props.station?.arrivalsStale ? "status" : undefined}
                class="text-[11px] italic text-muted-foreground"
              >
                {props.station?.arrivalsStale
                  ? t("Live departures unavailable")
                  : props.station?.livePredictionsOnly
                    ? t("No live predictions available")
                    : t("No active departures")}
              </span>
            }
          >
            <StationDeparturesSection
              agencyId={cardAgencyId()}
              stationId={fallbackStationId()}
              lineIds={props.station.lineIds}
            />
          </Show>
        }
      >
        <div class="flex flex-col gap-1.5">
          <For each={props.station?.arrivals ?? []}>
            {(group) => {
              const isTransfer = () =>
                (props.station?.lineIds?.length ?? 0) > 1 ||
                new Set(props.station?.arrivals?.map((a) => a.lineId).filter(Boolean)).size > 1;

              return (
                <DirectionArrivalsRow
                  label={group.label}
                  generatedLabel={group.generatedLabel}
                  times={group.times}
                  lineId={isTransfer() ? group.lineId : undefined}
                  agencyId={cardAgencyId()}
                />
              );
            }}
          </For>
        </div>
      </Show>

      <Show
        when={
          props.station?.livePredictionsOnly &&
          (hasKnownArrivals() || !isExpanded() || props.station?.arrivalsStale)
        }
      >
        <p class="mt-1 text-[11px] text-muted-foreground">
          {t(
            "Only tracked departures appear. Check the operator's timetable for scheduled service.",
          )}
        </p>
      </Show>
      <Show when={canExpand() && isExpanded()}>
        <Show
          when={stripTracking()}
          fallback={
            <div
              data-testid="station-route-strip-skeleton"
              class="mt-3 rounded-xl border border-border bg-background p-3.5"
            >
              <div class="flex items-center justify-between gap-2 mb-3">
                <div class="h-5 w-28 rounded-md bg-muted animate-pulse" />
                <div class="h-5 w-20 rounded-md bg-muted animate-pulse" />
              </div>
              <div class="flex items-center justify-between gap-2 py-2 overflow-hidden">
                <For each={[1, 2, 3, 4, 5, 6]}>
                  {() => <div class="h-3 w-3 shrink-0 rounded-full bg-accent animate-pulse" />}
                </For>
              </div>
            </div>
          }
        >
          <LinearStopStrip
            tracking={stripTracking()!}
            riderStop={riderStop()}
            agencyId={cardAgencyId()}
            selectedDirectionId={activeDirectionId()}
            onSelectDirection={(directionId) =>
              setChosenDirection({ lineId: lineId(), directionId: directionId === 0 ? 0 : 1 })
            }
            prefersReducedMotion={userPrefs.isEffectiveReducedMotion()}
            vehicleStopIndices={vehicleStopIndices()}
          />
        </Show>
      </Show>
    </div>
  );
}
