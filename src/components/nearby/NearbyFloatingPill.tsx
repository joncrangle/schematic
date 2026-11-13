import { createMemo, createSignal, onSettled, Show, Loading } from "solid-js";
import { cn } from "~/lib/utils";
import { useGeolocation } from "~/hooks/useGeolocation";
import { graceRemainingSeconds } from "~/domain/location/locationLadder";
import { useEscapeKey } from "~/lib/keyboard";
import { useNearbyCoordination } from "~/context/NearbyCoordinationContext";
import { Portal } from "@solidjs/web";
import type { RouteEnlargeRequest } from "~/lib/routeTrackingLifecycle";
import { NearbyPanel } from "./NearbyPanel";
import { NearbyLoadingSkeleton } from "./NearbyLoadingSkeleton";
import { preloadNearbyQueries } from "~/hooks/useNearbyQueries";
import { useAppClock } from "~/lib/appClock";
import { useI18n } from "~/i18n/I18nContext";
import { formatClockCountdown } from "./nearbyHelpers";

export interface NearbyFloatingPillProps {
  readonly onEnlargeRoute?: (request: RouteEnlargeRequest) => void;
}

export function NearbyFloatingPill(props: NearbyFloatingPillProps = {}) {
  const i18n = useI18n();
  const { t } = i18n;
  // Open state and per-route card coordination are owned by the route and
  // supplied through NearbyCoordinationContext, no internal fallback.
  const coordination = useNearbyCoordination();
  const isOpen = coordination.nearbyOpen;
  const setIsOpen = coordination.setNearbyOpen;

  const routeDirectionsRecord = createMemo(() => {
    const result: Record<string, number> = {};
    for (const [routeId, directions] of coordination.routeDirections()) {
      const selected = directions.at(-1);
      if (selected) result[routeId] = selected.directionId;
    }
    return result;
  });

  // Hydration-safe mount gate, server renders empty, client renders after mount
  const [clientReady, setClientReady] = createSignal(false);

  const [popoverRef, setPopoverRef] = createSignal<HTMLDivElement>();
  const [pillRef, setPillRef] = createSignal<HTMLButtonElement>();

  const geo = useGeolocation();
  // A dev spoof is a fresh, explicitly applied position even if the ladder's
  // previous GPS fix was stale. The countdown describes location evidence,
  // not the transit feed's freshness.
  const isStale = () => geo.status() === "stale" && geo.locationSource() !== "dev-spoof";

  // Local grace tick: the ladder owns the math (graceRemainingSeconds);
  // the shared app clock drives the pill's countdown label.
  const graceNow = useAppClock();
  const formattedTime = () => {
    const total = graceRemainingSeconds(geo.coords(), graceNow());
    return formatClockCountdown(total, i18n);
  };

  useEscapeKey(() => setIsOpen(false), isOpen);

  // Close pill on outside clicks
  onSettled(() => {
    setClientReady(true);

    const handlePointerDown = (event: PointerEvent) => {
      const popover = popoverRef();
      const pill = pillRef();

      if (
        popover &&
        !popover.contains(event.target as Node) &&
        pill &&
        !pill.contains(event.target as Node)
      ) {
        setIsOpen(false);
      }
    };

    document.addEventListener("pointerdown", handlePointerDown);

    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
    };
  });

  const handlePillClick = () => {
    const wasOpen = isOpen();
    coordination.toggleNearby();
    if (!wasOpen) {
      if (geo.status() === "granted" || geo.status() === "stale") {
        geo.requestLocation(true);
      } else if (geo.status() !== "granted") {
        geo.requestLocation();
      }
    }
  };

  return (
    <>
      {/* Icon-Only Nearby Transit Action Button */}
      <button
        ref={(el) => {
          setPillRef(el);
          coordination.registerTriggerElement(el);
        }}
        type="button"
        onClick={handlePillClick}
        onPointerEnter={() => void preloadNearbyQueries()}
        onFocus={() => void preloadNearbyQueries()}
        aria-label={t("Open nearby transit departures")}
        class={cn(
          "flex h-10.5 w-10.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-card/90 text-lg shadow-xl backdrop-blur-sm transition-colors hover:bg-accent active:bg-accent",
          isStale()
            ? "border-warning/80 bg-card/95 text-warning-300 shadow-warning/20"
            : geo.status() === "granted"
              ? "border-info/50 text-info"
              : "text-foreground",
        )}
      >
        <span aria-hidden="true">◎</span>
      </button>

      <Portal>
        {/* Anchored Popover, always mounted; visibility is toggled so opening
            nearby cannot replace or suspend the map shell. */}
        <div
          ref={setPopoverRef}
          role="dialog"
          aria-modal="false"
          aria-label={t("Nearby transit departures")}
          aria-hidden={!isOpen() ? "true" : "false"}
          class={cn(
            "fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-card text-foreground shadow-2xl pointer-events-auto touch-pan-y transition-opacity duration-200",
            // Mobile (< sm): Centered full-frame
            "top-18 bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+3.5rem)] left-1/2 -translate-x-1/2 w-[min(480px,95vw)] max-h-[calc(100dvh-8rem)]",
            // Non-mobile (>= sm): Docked in bottom-right corner with strict height limit
            "sm:top-auto sm:bottom-[0.87rem] sm:right-3.5 sm:left-auto sm:translate-x-0 sm:w-96 sm:h-120 sm:max-h-[calc(100dvh-6rem)]",
            isOpen() ? "visible opacity-100" : "hidden invisible opacity-0 pointer-events-none",
          )}
          onWheel={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              setIsOpen(false);
            }
          }}
        >
          {/* Utility Bar Topbar with comfortable horizontal padding */}
          <div class="flex h-11 shrink-0 items-center justify-between border-b border-border px-4">
            <div class="flex items-center gap-2 text-xs font-semibold text-foreground">
              <span class={cn("text-xs", isStale() ? "text-warning-400" : "text-info")}>
                {isStale() ? "⚠️" : "◎"}
              </span>
              <span>
                {isStale()
                  ? t("Last Known ({{time}})", { time: formattedTime() })
                  : t("Nearby Transit")}
              </span>
            </div>

            <button
              type="button"
              ref={(element) => coordination.registerCloseControl(element)}
              onClick={() => setIsOpen(false)}
              aria-label={t("Close nearby panel")}
              class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
            >
              <span aria-hidden="true" class="text-lg leading-none">
                ×
              </span>
            </button>
          </div>

          {/* Popover scrollable body with map zoom and pan isolation.
              overscroll-contain stops scroll chaining at this container so a
              swipe past the top or bottom edge never reaches the page scroller
              and triggers the browser's native pull-to-refresh (page reload). */}
          <div
            class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3 touch-pan-y select-text"
            onWheel={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
            onTouchStart={(event) => event.stopPropagation()}
          >
            {/* clientReady gates on mount-settle, so a slow first flight would
                otherwise leave this body empty with no fallback: the Show
                carries the same skeleton statically for the pre-settle window. */}
            <Show
              when={clientReady()}
              fallback={
                <div role="status" aria-label={t("Loading nearby transit")}>
                  <NearbyLoadingSkeleton />
                </div>
              }
            >
              <Loading
                fallback={
                  <div role="status" aria-label={t("Loading nearby transit")}>
                    <NearbyLoadingSkeleton />
                  </div>
                }
              >
                <NearbyPanel
                  isOpen={isOpen}
                  onClose={() => setIsOpen(false)}
                  expandedRouteId={coordination.expandedRouteId()}
                  onToggleExpandRoute={coordination.toggleExpandRoute}
                  routeDirections={routeDirectionsRecord()}
                  onSelectRouteDirection={coordination.selectRouteDirection}
                  onCaptureTargetedInvoker={coordination.captureTargetedInvoker}
                  onRegisterFirstActionable={coordination.registerFirstActionable}
                  onEnlargeRoute={(request) => {
                    props.onEnlargeRoute?.(request);
                  }}
                />
              </Loading>
            </Show>
          </div>
        </div>
      </Portal>
    </>
  );
}
