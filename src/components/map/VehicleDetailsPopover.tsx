import { Show } from "solid-js";

import type { LiveVehiclePosition, SurfaceRouteType } from "~/domain/surface/types";
import type { Point } from "~/core/map";

import { BaseMapPopover } from "./popovers/BaseMapPopover";
import {
  formatOccupancyStatus,
  formatSurfaceVehicleLabel,
  formatVehicleSpeed,
} from "~/components/route/routeTrackingHelpers";
import { VehicleStatRows } from "~/components/route/VehicleStatRows";
import { useI18n } from "~/i18n/I18nContext";

export interface VehicleDetailsPopoverProps {
  readonly vehicle: LiveVehiclePosition;
  readonly routeShortName: string;
  readonly routeType: SurfaceRouteType;
  /** Container coordinates of the selected vehicle; null suppresses render. */
  readonly coords: Point | null;
  readonly containerSize: { width: number; height: number };
  readonly onClose: () => void;
  readonly setRef: (element: HTMLDivElement) => void;
}

/**
 * Selected surface vehicle details: the markup that used to live
 * inline in NetworkMap, sharing VehicleStatRows so speed/crowding read
 * identically to the LinearStopStrip micro-popover.
 */
export function VehicleDetailsPopover(props: VehicleDetailsPopoverProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const publicLabel = () => formatSurfaceVehicleLabel(props.routeShortName, props.routeType, i18n);

  return (
    <Show when={props.coords}>
      {(resolved) => (
        <BaseMapPopover
          coords={resolved()}
          containerSize={props.containerSize}
          topOffset={12}
          bottomOffset={12}
          onClose={props.onClose}
          setRef={props.setRef}
          ariaLabel={t("{{name}} details", { name: publicLabel() })}
          class="w-64"
          header={
            <div class="flex items-center justify-between">
              <div class="flex items-center gap-1.5 font-bold text-white text-xs">
                <span>🚍</span>
                <span>{publicLabel()}</span>
              </div>
              <span class="text-[10px] text-live font-semibold bg-live/10 px-1.5 py-0.5 rounded">
                {t("In Service")}
              </span>
            </div>
          }
        >
          <VehicleStatRows
            speed={formatVehicleSpeed(props.vehicle.speed, i18n)}
            occupancy={formatOccupancyStatus(props.vehicle.occupancyStatus, i18n)}
          />
        </BaseMapPopover>
      )}
    </Show>
  );
}
