import { Show } from "solid-js";
import { Dynamic } from "@solidjs/web";
import type { SurfaceRouteType } from "~/domain/surface/types";
import { getSurfaceModeMeta } from "./routeTrackingHelpers";

export interface VehicleGlyphProps {
  readonly routeType?: SurfaceRouteType;
  readonly size?: number;
  readonly class?: string;
}

/**
 * Single mode→icon mapping for vehicle markers and overlays: the
 * canonical tint lives on getSurfaceModeMeta so express never drifts.
 */
export function VehicleGlyph(props: VehicleGlyphProps) {
  const meta = () => getSurfaceModeMeta(props.routeType);

  return (
    <span data-mode={meta().name.toLowerCase()} class="inline-flex">
      <Show when={meta().icon}>
        <Dynamic
          component={meta().icon}
          size={props.size ?? 14}
          class={`pointer-events-none ${meta().iconClass} ${props.class ?? ""}`}
        />
      </Show>
    </span>
  );
}
