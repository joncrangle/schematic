import { createMemo, For, onSettled, Show } from "solid-js";
import { cn } from "~/lib/utils";
import type { SurfaceRouteType } from "~/domain/surface/types";
import type { AgencyAlert } from "~/agencies/types";
import {
  buildDirectionOptions,
  getDirectionCompassMeta,
  getRouteDirectionsForRoute,
  type ParsedHeadsign,
  type RouteDirectionOption,
} from "~/domain/surface/direction";
import { getSurfaceModeMeta } from "~/components/route/routeTrackingHelpers";
import { RouteDisruptionPill } from "~/components/route/RouteAlertBanner";
import { useEscapeKey } from "~/lib/keyboard";
import { routeBadgeStyle } from "~/components/nearby/nearbyHelpers";
import { useI18n } from "~/i18n/I18nContext";
import { presentDirectionLabel } from "~/components/route/directionPresentation";
import { getAgencyById } from "~/agencies/browserRegistry";

import type { TargetedRouteTracking } from "~/lib/routeTrackingLifecycle";

export interface RouteControlsProps {
  readonly tracking: TargetedRouteTracking;
  readonly routeId: string;
  readonly routeShortName: string;
  readonly routeLongName: string;
  readonly routeType?: SurfaceRouteType;
  readonly routeColor?: string;
  readonly agencyId?: string;
  readonly onClearRoute: () => void;
  readonly onSelectDirection?: (directionId: number) => void;
  readonly activeVehicleCount?: number;
  readonly vehiclePositionsOnly?: boolean;
  readonly vehiclePositionsFreshness?: "live" | "stale" | "unavailable";
  readonly alerts?: readonly AgencyAlert[];
  /** Live headsign from routeConfig for real direction labels/destinations. */
  readonly headsign?: string;
  /** Per-direction label+destination from tracking payload (stable, both directions). */
  readonly directionLabels?: Record<number, ParsedHeadsign>;
  readonly availableDirectionIds?: readonly number[];
  /**
   * Same reduced-motion primitive TargetedRouteOverlay consumes: suppresses
   * the pending-state `animate-pulse`.
   */
  readonly prefersReducedMotion?: boolean;
}

export function RouteControls(props: RouteControlsProps) {
  const { t, plural } = useI18n();
  // Focus hand-off on entering Targeted Route Mode: the click that enlarged
  // the map left focus inside the Nearby pill right as it flipped
  // aria-hidden (Chrome blocks aria-hidden elements retaining focus), so
  // pull focus into the overlay controls. Mount-scoped by construction:
  // NetworkMap renders these controls under a NON-keyed <Show> keyed only on
  // targeted-mode truthiness, so this fires once per session, never on the
  // 10s renewal ticks or direction switches, which patch props in place.
  let closeButtonElement: HTMLButtonElement | undefined;
  onSettled(() => {
    queueMicrotask(() => closeButtonElement?.focus());
  });

  const selectedDirId = () => props.tracking.selectedDirectionId?.() ?? 0;
  const handleSelectDirection = (dir: number) => {
    if (dir === selectedDirId()) return;
    if (props.onSelectDirection) props.onSelectDirection(dir);
    else props.tracking.selectDirection(dir);
  };
  const isDataPending = () => props.tracking.isStaleForDirection();

  const directions = createMemo(() => {
    const agency = props.agencyId ? getAgencyById(props.agencyId) : undefined;
    const base = getRouteDirectionsForRoute(
      props.routeType ?? "bus",
      props.routeId,
      agency?.manifest.routeInterpretation,
    );
    const available = props.availableDirectionIds;
    const options = buildDirectionOptions({
      base: available
        ? available.map((directionId) => ({ directionId, label: "", destination: "" }))
        : base,
      directionLabels: props.directionLabels,
      headsign: props.headsign,
      activeDirectionId: selectedDirId(),
    });
    return available ? options.filter((option) => available.includes(option.directionId)) : options;
  });
  const positionLabel = () =>
    props.vehiclePositionsFreshness === "unavailable"
      ? t("Live vehicle positions unavailable")
      : props.vehiclePositionsFreshness === "stale"
        ? t("Last known vehicle positions")
        : t("Live vehicle positions");
  const canSwitchDirection = () => !props.vehiclePositionsOnly && directions().length > 1;
  const directionLabel = (direction: {
    label: string;
    generatedLabel?: ParsedHeadsign["generatedLabel"];
  }) => presentDirectionLabel(direction.label, direction.generatedLabel, t);

  // Listen for Escape key to clear targeted route mode
  useEscapeKey(() => props.onClearRoute());

  const modeBadge = createMemo(() => {
    const meta = getSurfaceModeMeta(props.routeType);
    const badgeStyle = routeBadgeStyle({
      agencyId: props.agencyId,
      routeColor: props.routeColor,
      routeId: props.routeId,
      routeShortName: props.routeShortName,
      routeLongName: props.routeLongName,
      routeType: props.routeType,
    });
    return { icon: meta.icon, badgeStyle };
  });

  const activeDirection = createMemo(() => {
    return directions().find((d) => d.directionId === selectedDirId()) || directions()[0];
  });

  const compassMeta = createMemo(() => getDirectionCompassMeta(activeDirection()?.label || ""));
  const directionAngle = () => compassMeta().angle;
  const directionText = (direction: RouteDirectionOption | undefined) =>
    direction
      ? directionLabel(direction) ||
        direction.destination ||
        (canSwitchDirection()
          ? t("Direction {{number}}", {
              number:
                directions().findIndex((option) => option.directionId === direction.directionId) +
                1,
            })
          : t("Route direction unavailable"))
      : t("Route direction unavailable");
  const indicatorText = () =>
    activeDirection()?.label ? compassMeta().shortCode : directionText(activeDirection());

  const oppositeDirection = createMemo(() => {
    const all = directions();
    return all.find((d) => d.directionId !== selectedDirId()) || all[0];
  });

  const handleToggleDirection = (e: MouseEvent) => {
    e.stopPropagation();
    const next = oppositeDirection();
    if (next) {
      handleSelectDirection(next.directionId);
    }
  };

  return (
    <div
      role="region"
      aria-label={t("Targeted route mode controls")}
      class="pointer-events-none fixed top-4 left-1/2 -translate-x-1/2 z-30 flex flex-col items-center gap-2 w-[min(560px,95vw)] animate-in fade-in slide-in-from-top-3 duration-200"
    >
      {/* Main Top Bar: Route Badge + Segmented Direction Pill + Clear Route Button */}
      <div class="pointer-events-auto w-full flex items-center justify-between gap-2 rounded-2xl sm:rounded-full border border-border bg-card/95 p-2 sm:px-3 sm:py-1.5 shadow-2xl backdrop-blur-md">
        {/* Route Identifier Pill */}
        <div class="flex items-center gap-1.5 shrink-0 pl-0.5">
          <div
            class="flex h-6 min-w-6 items-center justify-center rounded-md px-1.5 text-xs font-black shadow-xs"
            style={modeBadge().badgeStyle}
          >
            <span class="mr-1 text-[11px] inline-flex items-center">
              {modeBadge().icon({ size: 14 })}
            </span>
            <span>{props.routeShortName}</span>
          </div>
          <span class="hidden sm:inline text-xs font-semibold text-foreground truncate max-w-28">
            {props.routeLongName}
          </span>
        </div>

        <div aria-hidden="true" class="hidden sm:block h-4 w-px bg-accent" />

        {/* Only feed-declared alternatives are selectable. */}
        <Show
          when={canSwitchDirection()}
          fallback={
            <p
              class="min-w-0 flex-1 px-2 text-center text-xs font-semibold"
              title={
                props.vehiclePositionsOnly ? positionLabel() : directionText(activeDirection())
              }
            >
              {props.vehiclePositionsOnly ? positionLabel() : directionText(activeDirection())}
            </p>
          }
        >
          <div
            role="tablist"
            aria-label={t("Route direction options")}
            class="flex min-w-0 flex-1 items-center justify-center gap-1 rounded-xl sm:rounded-full bg-background p-1 border border-border/60"
          >
            <For each={directions()}>
              {(dir) => {
                const isSelected = () => selectedDirId() === dir.directionId;
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected() ? "true" : "false"}
                    onClick={() => handleSelectDirection(dir.directionId)}
                    class={cn(
                      "flex-1 min-w-0 overflow-hidden cursor-pointer rounded-lg sm:rounded-full px-2 py-1 text-center text-xs transition-all",
                      isSelected()
                        ? "bg-accent font-bold text-white shadow-xs"
                        : "text-muted-foreground hover:bg-accent hover:text-foreground",
                    )}
                  >
                    <span class="truncate block min-w-0">
                      {directionLabel(dir) || (!dir.destination ? directionText(dir) : "")}
                      {dir.destination && (
                        <>
                          {" "}
                          <span class="text-muted-foreground font-normal">→</span> {dir.destination}
                        </>
                      )}
                    </span>
                  </button>
                );
              }}
            </For>
          </div>
        </Show>

        <div aria-hidden="true" class="hidden sm:block h-4 w-px bg-accent" />

        {/* Floating Clear/Close Route Button */}
        <button
          type="button"
          ref={(el) => (closeButtonElement = el)}
          onClick={(e) => {
            e.stopPropagation();
            props.onClearRoute();
          }}
          aria-label={t("Close route overlay and return to network map")}
          class="flex shrink-0 cursor-pointer items-center gap-1 rounded-xl sm:rounded-full border border-ring/50 bg-muted px-3 py-1.5 text-xs font-semibold text-foreground transition-colors hover:bg-destructive/20 hover:border-destructive/50 hover:text-destructive active:scale-95"
        >
          <span class="text-[12px] leading-none font-bold">✕</span>
          <span class="hidden md:inline">{t("Close")}</span>
        </button>
      </div>

      <Show when={props.vehiclePositionsOnly}>
        <p class="rounded-full border border-border bg-card/95 px-3 py-1 text-xs text-muted-foreground">
          {props.vehiclePositionsFreshness === "unavailable"
            ? t("Live vehicle positions unavailable")
            : props.vehiclePositionsFreshness === "stale"
              ? t("Vehicle positions may be out of date")
              : plural("Active vehicles", props.activeVehicleCount ?? 0)}{" "}
          · {t("Stop predictions unavailable")}
        </p>
      </Show>

      {/* Under Header Sub-Row: Left Disruption Alert & Right Large Direction Indicator */}
      <div class="w-full flex items-start justify-between gap-3 px-1">
        {/* Surface Route Disruption Advisory Pill (Left) */}
        <div class="flex-1 min-w-0">
          <Show when={props.alerts && props.alerts.length > 0}>
            <RouteDisruptionPill alerts={props.alerts ?? []} />
          </Show>
        </div>

        {/* Large Floating Direction Indicator on Right Under Header */}
        <Show when={canSwitchDirection()}>
          <button
            type="button"
            onClick={handleToggleDirection}
            aria-label={t("Switch route direction (currently {{direction}})", {
              direction: directionText(activeDirection()),
            })}
            title={t("Click to switch route direction to {{direction}}", {
              direction: oppositeDirection()
                ? directionText(oppositeDirection())
                : t("opposite direction"),
            })}
            class={cn(
              "pointer-events-auto shrink-0 flex flex-col items-center gap-1 rounded-2xl border border-border bg-card/95 p-2 shadow-2xl backdrop-blur-md cursor-pointer transition-all hover:bg-accent hover:border-live/60 hover:scale-105 active:scale-95 group ml-auto",
              isDataPending() && !props.prefersReducedMotion && "animate-pulse",
            )}
          >
            <Show when={activeDirection()?.label}>
              <div class="relative flex h-10.5 w-10.5 items-center justify-center rounded-xl bg-muted border border-border shadow-inner group-hover:border-live/40">
                <div
                  class="flex items-center justify-center transition-transform duration-500 ease-out"
                  style={{ transform: `rotate(${directionAngle()}deg)` }}
                >
                  <svg
                    class="h-6.5 w-6.5 text-live drop-shadow-[0_0_10px_color-mix(in_srgb,var(--color-live)_60%,transparent)] group-hover:text-live-400"
                    viewBox="0 0 24 24"
                    fill="currentColor"
                  >
                    <path d="M12 2L4.5 20.29l.71.71L12 18l6.79 3 .71-.71L12 2z" />
                  </svg>
                </div>
              </div>
            </Show>
            <span class="max-w-40 text-center text-[11px] font-black tracking-wider text-live group-hover:text-live-400">
              {indicatorText()}
            </span>
          </button>
        </Show>
      </div>
    </div>
  );
}
