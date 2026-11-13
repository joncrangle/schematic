import { createMemo, type Accessor } from "solid-js";
import { walkingLinkLabel } from "~/core/map/interchange-geometry";
import { StationMarker } from "./StationMarker";
import type { StationInfo, PositionedWalkingInterchangeMarker } from "~/core/map";
import { useI18n } from "~/i18n/I18nContext";

interface WalkingInterchangeMarkerProps {
  readonly marker: PositionedWalkingInterchangeMarker;
  readonly station: StationInfo;
  readonly isSelected: Accessor<boolean>;
  readonly registerElement: (stationId: string, element: SVGGElement) => void;
  readonly onSelect: (marker: PositionedWalkingInterchangeMarker) => void;
  readonly status?: Accessor<"normal" | "degraded" | "severe" | "unavailable">;
  readonly accessibilityOutage?: Accessor<boolean>;
}

/** A real peer station beside the active network, connected by a walking path. */
export function WalkingInterchangeMarker(props: WalkingInterchangeMarkerProps) {
  const { t } = useI18n();
  const pathLabel = createMemo(() => walkingLinkLabel(props.marker));

  return (
    <g class="walking-interchange-marker">
      <path
        d={`M ${props.marker.sourceX} ${props.marker.sourceY} L ${props.marker.x} ${props.marker.y}`}
        fill="none"
        stroke="currentColor"
        stroke-width="1.5"
        stroke-dasharray="5 5"
        class="text-muted-foreground pointer-events-none"
        aria-hidden="true"
      />
      <text
        x={pathLabel().x}
        y={pathLabel().y}
        text-anchor="middle"
        dominant-baseline="central"
        font-size="9"
        font-family="system-ui, sans-serif"
        class="fill-muted-foreground pointer-events-none select-none"
      >
        {t("walk")}
      </text>
      <StationMarker
        station={props.station}
        displayName={props.marker.label}
        ariaPrefix={props.marker.label}
        isSelected={props.isSelected}
        registerElement={props.registerElement}
        onToggle={() => props.onSelect(props.marker)}
        status={props.status}
        accessibilityOutage={props.accessibilityOutage}
      />
    </g>
  );
}
