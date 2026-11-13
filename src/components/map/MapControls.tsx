import { Show } from "solid-js";
import { cn } from "~/lib/utils";
import { NearbyFloatingPill } from "../nearby/NearbyFloatingPill";
import type { RouteEnlargeRequest } from "~/lib/routeTrackingLifecycle";
import { useI18n } from "~/i18n/I18nContext";

export interface MapControlsProps {
  onZoomIn: () => void;
  onZoomOut: () => void;
  onRecenter: () => void;
  /** Genuine map event relayed up to the route (pill "Enlarge" affordance). */
  onEnlargeRoute?: (request: RouteEnlargeRequest) => void;
  class?: string;
}

export function MapControls(props: MapControlsProps) {
  const { t } = useI18n();
  return (
    <div
      class={cn(
        "absolute right-3.5 bottom-[max(0.875rem,env(safe-area-inset-bottom,0.875rem))] z-40 flex flex-col items-center gap-2",
        props.class,
      )}
      onPointerDown={(event) => event.stopPropagation()}
      onWheel={(event) => event.stopPropagation()}
      onClick={(event) => event.stopPropagation()}
      onDblClick={(event) => event.stopPropagation()}
    >
      {/* 1. Nearby Transit Button (Icon-only, positioned above zoom controls).
          Reads its coordination state from NearbyCoordinationContext itself —
          this component is pure composition and stays out of the relay.
          Only rendered when the host supplies the route enlarging affordance. */}
      <Show when={props.onEnlargeRoute}>
        <NearbyFloatingPill onEnlargeRoute={props.onEnlargeRoute} />
      </Show>

      {/* 2. Zoom controls */}
      <div
        aria-label={t("Map zoom controls")}
        class="flex flex-col overflow-hidden rounded-xl border border-border bg-card/90 shadow-xl backdrop-blur-sm"
      >
        <button
          type="button"
          onClick={props.onZoomIn}
          aria-label={t("Zoom in")}
          class="flex h-10.5 w-10.5 cursor-pointer items-center justify-center border-b border-border text-xl font-medium text-foreground transition-colors hover:bg-accent active:bg-accent"
        >
          +
        </button>

        <button
          type="button"
          onClick={props.onZoomOut}
          aria-label={t("Zoom out")}
          class="flex h-10.5 w-10.5 cursor-pointer items-center justify-center text-xl font-medium text-foreground transition-colors hover:bg-accent active:bg-accent"
        >
          −
        </button>
      </div>

      {/* 3. Recenter Map Button */}
      <button
        type="button"
        onClick={props.onRecenter}
        aria-label={t("Recentre map")}
        class="flex h-10.5 w-10.5 shrink-0 cursor-pointer items-center justify-center rounded-full border border-border bg-card/90 text-lg text-foreground shadow-xl backdrop-blur-sm transition-colors hover:bg-accent active:bg-accent"
      >
        <span aria-hidden="true">⊙</span>
      </button>
    </div>
  );
}
