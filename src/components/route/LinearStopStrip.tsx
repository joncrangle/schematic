import { createMemo, For, onCleanup, onSettled, Show, untrack } from "solid-js";
import { cn } from "~/lib/utils";
import type { RouteTrackingData } from "~/domain/surface/types";
import { VehicleMarker } from "./VehicleMarker";
import {
  buildDirectionOptions,
  getRouteDirectionsForRoute,
  type RiderStop,
  type RouteDirectionOption,
} from "~/domain/surface/direction";
import {
  findClosestApproachingVehicle,
  indexVehicleStops,
  resolveStopIndex,
  type VehicleStopIndices,
} from "~/domain/surface/corridor/index";
import { formatStopsAwayText } from "./routeTrackingHelpers";
import { MaximizeIcon } from "~/components/icons/MaximizeIcon";
import { useI18n } from "~/i18n/I18nContext";
import { presentDirectionLabel } from "~/components/route/directionPresentation";
import { getAgencyById } from "~/agencies/browserRegistry";

export interface LinearStopStripProps {
  readonly tracking: RouteTrackingData;
  readonly agencyId?: string;
  /** The rider's boarding stop, resolved against the tracking stop sequence. */
  readonly riderStop: RiderStop;
  /** Reuse the card's enriched options when it already built them. */
  readonly directionOptions?: readonly RouteDirectionOption[];
  readonly selectedDirectionId?: number;
  readonly onSelectDirection?: (directionId: number) => void;
  readonly onEnlargeRoute?: () => void;
  readonly onCaptureTargetedInvoker?: (element: HTMLElement) => void;
  /**
   * Same reduced-motion primitive TargetedRouteOverlay consumes: suppresses
   * the live-status dot `animate-pulse`.
   */
  readonly prefersReducedMotion?: boolean;
  /** Reuse the parent card's index when it already derived the same snapshot. */
  readonly vehicleStopIndices?: VehicleStopIndices;
}

export function LinearStopStrip(props: LinearStopStripProps) {
  const i18n = useI18n();
  const { t } = i18n;
  let scrollContainerRef: HTMLDivElement | undefined = undefined;

  // --- Click-and-drag horizontal scrolling ---
  let isDragging = false;
  let dragStartX = 0;
  let dragScrollLeft = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (!scrollContainerRef) return;
    isDragging = true;
    dragStartX = e.clientX;
    dragScrollLeft = scrollContainerRef.scrollLeft;
    scrollContainerRef.setPointerCapture(e.pointerId);
    scrollContainerRef.style.cursor = "grabbing";
    scrollContainerRef.style.userSelect = "none";
  };

  const onPointerMove = (e: PointerEvent) => {
    if (!isDragging || !scrollContainerRef) return;
    const dx = e.clientX - dragStartX;
    scrollContainerRef.scrollLeft = dragScrollLeft - dx;
  };

  const onPointerUp = (e: PointerEvent) => {
    if (!isDragging || !scrollContainerRef) return;
    isDragging = false;
    scrollContainerRef.releasePointerCapture(e.pointerId);
    scrollContainerRef.style.cursor = "grab";
    scrollContainerRef.style.userSelect = "";
  };

  onCleanup(() => {
    isDragging = false;
  });

  const activeDirectionId = () => props.selectedDirectionId ?? 0;
  const stops = () => props.tracking?.stops ?? [];
  const vehicles = () => props.tracking?.vehicles ?? [];

  const directions = createMemo(
    () =>
      props.directionOptions ??
      (props.tracking
        ? buildDirectionOptions({
            base: getRouteDirectionsForRoute(
              props.tracking.route.routeType,
              props.tracking.route.id,
              props.agencyId
                ? getAgencyById(props.agencyId)?.manifest.routeInterpretation
                : undefined,
            ),
            directionLabels: props.tracking.directionLabels,
            headsign: props.tracking.shape.headsign,
            activeDirectionId: activeDirectionId(),
            inferOppositeDirection: true,
          })
        : []),
  );

  const vehicleStopIndices = createMemo(
    () =>
      props.vehicleStopIndices ??
      (props.tracking ? indexVehicleStops(vehicles(), stops()) : new Map()),
  );

  // Resolve the rider's boarding stop index by geo-proximity (pure derivation).
  // Centering is imperative-only by design: on mount/ref-attach and on
  // explicit selection changes, never from inside a derivation.
  const currentStopIndex = createMemo(() =>
    props.tracking ? resolveStopIndex(props.riderStop, stops()) : -1,
  );

  // Subway station strips are intentionally static: station feeds provide
  // directional arrivals, but vehicle positions are not cleanly meaningful
  // at this scale and should not compete with the stop sequence. Surface
  // routes retain the live vehicle treatment.
  const showsVehicles = () => props.tracking?.route.routeType !== "subway";

  // Filter vehicles for active direction
  const activeDirectionVehicles = createMemo(() =>
    showsVehicles() ? vehicles().filter((v) => v.directionId === activeDirectionId()) : [],
  );

  // Find vehicle closest to rider boarding stop (selection policy lives in
  // the domain seam, including the "all passed" graceful degradation).
  const closestVehicleInfo = createMemo(() => {
    if (!props.tracking) return null;
    const info = findClosestApproachingVehicle(
      activeDirectionVehicles(),
      stops(),
      currentStopIndex(),
      vehicleStopIndices(),
    );
    if (!info) return null;

    const bannerText = formatStopsAwayText(
      props.tracking.route.shortName,
      info.stopsAway,
      undefined,
      props.tracking.route.routeType,
      i18n,
    );

    return { vehicle: info.vehicle, bannerText };
  });

  // Scroll to boarding stop instantly on mount, when direction changes, or when stop list content changes
  const centerCurrentStop = (el?: HTMLDivElement | null) => {
    const targetEl = el || scrollContainerRef;
    if (!targetEl) return;
    // Imperative scroll positioning runs outside tracking scopes (ref attach,
    // onSettled): take a one-time snapshot without subscribing.
    const idx = untrack(currentStopIndex);
    if (idx < 0) return;
    const columnWidth = 112; // w-28 = 112px
    const containerWidth = targetEl.clientWidth || 360;
    const scrollTarget = idx * columnWidth - containerWidth / 2 + columnWidth / 2;
    targetEl.scrollLeft = Math.max(0, Math.round(scrollTarget));

    // Re-check on next animation frame in case container dimensions were just calculated
    requestAnimationFrame(() => {
      if (targetEl) {
        const actualWidth = targetEl.clientWidth || containerWidth;
        const target = idx * columnWidth - actualWidth / 2 + columnWidth / 2;
        targetEl.scrollLeft = Math.max(0, Math.round(target));
      }
    });
  };

  onSettled(() => {
    centerCurrentStop(scrollContainerRef);
  });

  return (
    <div class="mt-3 rounded-xl border border-border bg-background p-3 text-left">
      {/* Direction switching is useful for live surface routes. Subway cards
          already arrive scoped to one station direction and use a static map. */}
      <Show when={showsVehicles()}>
        <div class="mb-3 flex min-w-0 w-full gap-1 rounded-xl border border-border bg-card p-1">
          <For each={directions()}>
            {(dir) => {
              const isSelected = () => activeDirectionId() === dir.directionId;
              return (
                <button
                  type="button"
                  onClick={() => {
                    props.onSelectDirection?.(dir.directionId);
                    queueMicrotask(() => centerCurrentStop());
                  }}
                  class={cn(
                    "flex-1 min-w-0 overflow-hidden cursor-pointer rounded-lg py-1.5 px-2 text-center transition-all",
                    isSelected()
                      ? "bg-accent text-white shadow-xs"
                      : "text-muted-foreground hover:bg-accent hover:text-foreground",
                  )}
                >
                  {/* A label is a compass word only when the operator stated
                      one. Otherwise the destination IS the direction, so it
                      takes the primary line rather than leaving the button
                      with an empty heading. */}
                  <Show
                    when={dir.label.trim()}
                    fallback={
                      <div class="truncate text-[11.5px] font-semibold">→ {dir.destination}</div>
                    }
                  >
                    <div class="truncate text-[11.5px] font-semibold">
                      {presentDirectionLabel(dir.label, dir.generatedLabel, t)}
                    </div>
                    <Show when={dir.destination}>
                      <div class="truncate text-[10px] text-muted-foreground font-normal">
                        → {dir.destination}
                      </div>
                    </Show>
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>

      {/* Top Banner: Status & Enlarge Map CTA */}
      <div class="flex items-center justify-between gap-2 mb-2 px-0.5">
        <div class="flex items-center gap-1.5 text-xs text-foreground truncate">
          <span
            class={cn(
              "inline-block h-2 w-2 rounded-full shrink-0",
              showsVehicles() ? "bg-live" : "bg-muted-foreground",
              showsVehicles() && !props.prefersReducedMotion && "animate-pulse",
            )}
          />
          <span class="font-semibold text-[11.5px] truncate">
            {showsVehicles()
              ? (closestVehicleInfo()?.bannerText ??
                i18n.plural("Active vehicles", activeDirectionVehicles().length))
              : t("Static line map")}
          </span>
        </div>

        <Show when={props.onEnlargeRoute}>
          <button
            type="button"
            onClick={(e) => {
              props.onCaptureTargetedInvoker?.(e.currentTarget);
              e.currentTarget.blur();
              props.onEnlargeRoute?.();
            }}
            class="shrink-0 cursor-pointer inline-flex items-center gap-1 rounded-md border border-border bg-muted px-2 py-1 text-[10.5px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-white active:bg-accent"
          >
            <MaximizeIcon size={12} />
            <span>{t("Enlarge Map")}</span>
          </button>
        </Show>
      </div>

      {/* Horizontal Scrollable Stop Strip (Discrete Columns - Zero Label Collision) */}
      <div
        ref={(el) => {
          scrollContainerRef = el;
          centerCurrentStop(el);
        }}
        class="relative overflow-x-auto pb-3 pt-2 px-1 cursor-grab"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={onPointerUp}
      >
        <div class="relative flex items-start min-w-max py-2">
          {/* Continuous Corridor Line behind nodes */}
          <div class="absolute left-14 right-14 top-10 h-1 rounded-full bg-accent z-0" />

          {/* Stops along Corridor */}
          <For each={stops()}>
            {(stop, index) => {
              const isCurrent = () => index() === currentStopIndex();

              // The shared index keeps this bucket lookup O(V) across the
              // entire strip instead of resolving every vehicle per stop.
              const vehiclesAtStop = () =>
                activeDirectionVehicles().filter(
                  (v) => vehicleStopIndices().get(v.vehicleId) === index(),
                );

              return (
                <div class="relative z-10 flex w-28 shrink-0 flex-col items-center px-1 text-center group">
                  {/* Vehicle markers are omitted for static subway station strips. */}
                  <Show when={showsVehicles()} fallback={<div class="h-0 mb-1" />}>
                    <div class="h-8 flex items-end justify-center mb-1">
                      {/* Single read, keyed: the checked value is the rendered
                          value. Reading vehiclesAtStop() twice (once in `when`,
                          once for `[0]`) can straddle an update pass and
                          hand VehicleMarker an undefined vehicle, which throws
                          mid-flush and tears the update. */}
                      <Show when={vehiclesAtStop()[0]} keyed>
                        {(vehicle) => (
                          <VehicleMarker
                            vehicle={vehicle}
                            routeShortName={props.tracking.route.shortName}
                            routeType={props.tracking.route.routeType}
                          />
                        )}
                      </Show>
                    </div>
                  </Show>

                  {/* Stop Dot Node */}
                  <div
                    class={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full border-2 transition-all",
                      isCurrent()
                        ? "border-warning-400 bg-warning-400 shadow-md ring-4 ring-warning-400/25"
                        : "border-ring bg-card group-hover:border-muted-foreground",
                    )}
                  />

                  {/* Stop Name Label - clean line-clamp-2 with zero overlapping */}
                  <div class="mt-2 w-full px-1">
                    <div
                      class={cn(
                        "text-[10.5px] leading-tight line-clamp-2 transition-colors",
                        isCurrent()
                          ? "font-bold text-warning-300"
                          : "text-muted-foreground group-hover:text-foreground",
                      )}
                      title={stop.name}
                    >
                      {isCurrent() ? `📍 ${stop.name}` : stop.name}
                    </div>
                  </div>
                </div>
              );
            }}
          </For>
        </div>
      </div>
    </div>
  );
}
