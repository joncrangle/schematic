import { createSignal, onCleanup, Show } from "solid-js";
import { Portal } from "@solidjs/web";
import { cn } from "~/lib/utils";
import type { LiveVehiclePosition, SurfaceRouteType } from "~/domain/surface/types";
import {
  formatOccupancyStatus,
  formatSurfaceVehicleLabel,
  formatVehicleSpeed,
} from "./routeTrackingHelpers";
import { VehicleGlyph } from "./VehicleGlyph";
import { VehicleStatRows } from "./VehicleStatRows";
import { useEscapeKey } from "~/lib/keyboard";
import { useI18n } from "~/i18n/I18nContext";

export interface VehicleMarkerProps {
  readonly vehicle: LiveVehiclePosition;
  readonly routeShortName: string;
  readonly routeType?: SurfaceRouteType;
  readonly stopsAwayText?: string;
  readonly isSelected?: boolean;
  readonly onClick?: () => void;
}

export function VehicleMarker(props: VehicleMarkerProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const [showDetails, setShowDetails] = createSignal(false);
  const [anchorRect, setAnchorRect] = createSignal<DOMRect | null>(null);
  let removeOutsidePointerListener: (() => void) | undefined;

  const closeDetails = () => {
    removeOutsidePointerListener?.();
    removeOutsidePointerListener = undefined;
    setShowDetails(false);
  };

  const openDetails = () => {
    const onPointerDown = () => closeDetails();
    document.addEventListener("pointerdown", onPointerDown);
    removeOutsidePointerListener = () => document.removeEventListener("pointerdown", onPointerDown);
    setShowDetails(true);
  };

  useEscapeKey(closeDetails, showDetails);
  onCleanup(() => removeOutsidePointerListener?.());

  // Outside-pointerdown dismissal for the portalled popover: the panel
  // lives in document.body, so the strip's scroll container can't swallow the
  // event, attach the document listener from the explicit open/close events.

  /**
   * Fixed positioning anchored to the marker's viewport rect. Prefers opening
   * above; flips below when there isn't room for the ~170px popover between
   * the marker and the top of the screen.
   */
  const placementStyle = () => {
    const rect = anchorRect();

    if (!rect) {
      return {};
    }

    const POPOVER_WIDTH = 176; // w-44
    const EDGE_GUTTER_PX = 8;
    const FLIP_THRESHOLD_PX = 180;
    const centerX = Math.min(
      Math.max(rect.left + rect.width / 2, POPOVER_WIDTH / 2 + EDGE_GUTTER_PX),
      window.innerWidth - POPOVER_WIDTH / 2 - EDGE_GUTTER_PX,
    );

    if (rect.top < FLIP_THRESHOLD_PX) {
      return {
        left: `${centerX}px`,
        top: `${rect.bottom + EDGE_GUTTER_PX}px`,
        transform: "translateX(-50%)",
      };
    }

    return {
      left: `${centerX}px`,
      top: `${rect.top - EDGE_GUTTER_PX}px`,
      transform: "translate(-50%, -100%)",
    };
  };

  const bearingRotation = () => props.vehicle.bearing ?? 0;
  const occupancy = () => formatOccupancyStatus(props.vehicle.occupancyStatus, i18n);
  const speed = () => formatVehicleSpeed(props.vehicle.speed, i18n);
  const mode = () => props.routeType ?? "bus";
  const publicLabel = () => formatSurfaceVehicleLabel(props.routeShortName, mode(), i18n);

  return (
    <div class="relative inline-flex items-center justify-center">
      {/* Interactive Marker Button */}
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setAnchorRect(e.currentTarget.getBoundingClientRect());
          if (showDetails()) closeDetails();
          else openDetails();
          props.onClick?.();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        class={cn(
          "group relative flex h-7 w-7 cursor-pointer items-center justify-center rounded-full border border-white/20 bg-muted text-white shadow-md transition-transform hover:scale-110 active:scale-95",
          props.isSelected && "ring-2 ring-warning-400",
        )}
        title={publicLabel()}
        aria-label={publicLabel()}
      >
        {/* Direction Arrow Aura */}
        <Show when={props.vehicle.bearing !== undefined}>
          <svg
            class="pointer-events-none absolute -inset-1 h-9 w-9 text-warning-400/70 transition-transform duration-500"
            viewBox="0 0 36 36"
            style={{ transform: `rotate(${bearingRotation()}deg)` }}
            aria-hidden="true"
          >
            <path d="M 18 2 L 23 11 L 13 11 Z" fill="currentColor" />
          </svg>
        </Show>

        <VehicleGlyph routeType={mode()} size={14} />
      </button>

      {/* Micro-Popover on Tap, portalled to document.body so the strip's
          overflow-x-auto scroll container can't clip it. */}
      <Show when={showDetails()}>
        <Portal>
          <div
            role="dialog"
            aria-label={t("{{name}} details", { name: publicLabel() })}
            class="fixed z-60 w-44 rounded-lg border border-border bg-card p-2 text-left shadow-2xl backdrop-blur-md animate-in fade-in zoom-in-95 duration-150"
            style={placementStyle()}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          >
            {/* Header */}
            <div class="flex items-center justify-between border-b border-border pb-1 text-xs">
              <span class="font-bold text-foreground">{publicLabel()}</span>
              <button
                type="button"
                onClick={() => setShowDetails(false)}
                class="cursor-pointer text-muted-foreground hover:text-white"
              >
                ×
              </button>
            </div>

            {/* Details */}
            <Show when={props.stopsAwayText}>
              <div class="mt-1 text-[11px] font-medium text-warning-300">{props.stopsAwayText}</div>
            </Show>

            <VehicleStatRows speed={speed()} occupancy={occupancy()} />
          </div>
        </Portal>
      </Show>
    </div>
  );
}
