import { Show } from "solid-js";
import type { Accessor } from "solid-js";
import { cn } from "~/lib/utils";
import { MAP_OPACITY, createLineDimming } from "./line-dimming";
import type { StatusOverlaySegment } from "~/core/map";
import { formatSegmentTooltip } from "./tooltips";
import { useI18n } from "~/i18n/I18nContext";

interface StatusSegmentPathProps {
  segment: StatusOverlaySegment;
  isSelected: Accessor<boolean>;
  onToggle: (id: string, clickPosition?: { clientX: number; clientY: number }) => void;
  /**
   * Selected/hovered line id threaded from NetworkMap. When another line
   * is selected, this segment's alert strokes dim to match LinePath dimming.
   */
  hoveredLineId?: Accessor<string | null>;
}

const STROKE_COLORS = {
  severe: "var(--destructive)",
  delay: "var(--color-warning)",
  rsz: "var(--color-warning)",
  upcoming: "var(--muted-foreground)",
} as const;

export function StatusSegmentPath(props: StatusSegmentPathProps) {
  const { t } = useI18n();
  const isUpcoming = () => props.segment.kind === "upcoming";
  const isRsz = () => props.segment.kind === "rsz";
  const strokeColor = STROKE_COLORS[props.segment.kind];
  // Slow zones read as informational, not warnings: dashed amber slightly
  // wider than the base track (8) so it edges onto the dark background,
  // but narrower than warnings (12), with no halo and no pulse.
  const strokeWidth = () => {
    if (props.isSelected()) return isRsz() ? "12" : isUpcoming() ? "6" : "14";
    if (isRsz()) return "10";
    if (isUpcoming()) return "6";
    return "12";
  };

  const { isDimmed } = createLineDimming(props.segment.lineId, props.hoveredLineId);

  const tooltipText = () =>
    formatSegmentTooltip(
      {
        lineName: props.segment.lineName,
        fromStation: props.segment.fromStation,
        toStation: props.segment.toStation,
        kind: props.segment.kind,
        note: props.segment.note,
      },
      t,
    );

  return (
    <g
      style={{ opacity: "var(--status-segment-pulse-opacity, 1)" }}
      class={cn(
        "cursor-pointer outline-none",
        // Fully hidden alerts must not swallow taps aimed at the line beneath.
        isDimmed() && "pointer-events-none",
      )}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle(props.segment.id, { clientX: event.clientX, clientY: event.clientY });
      }}
    >
      <title>{tooltipText()}</title>
      <path
        d={props.segment.pathD}
        fill="none"
        stroke="transparent"
        stroke-width="24"
        stroke-linecap="round"
        stroke-linejoin="round"
        class="cursor-pointer"
      />

      <Show when={!isUpcoming() && !isRsz()}>
        <path
          d={props.segment.pathD}
          fill="none"
          stroke={strokeColor}
          stroke-width="18"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity={isDimmed() ? MAP_OPACITY.hidden : MAP_OPACITY.alertHalo}
          class="status-halo-aura pointer-events-none transition-opacity duration-100"
        />
      </Show>

      <path
        d={props.segment.pathD}
        fill="none"
        stroke={strokeColor}
        stroke-width={strokeWidth()}
        stroke-linecap="round"
        stroke-linejoin="round"
        stroke-dasharray={isRsz() ? "10 14" : undefined}
        opacity={
          isDimmed()
            ? MAP_OPACITY.hidden
            : isRsz()
              ? MAP_OPACITY.rszStroke
              : MAP_OPACITY.alertStroke
        }
        class="transition-[stroke-width,opacity] duration-300"
      />
    </g>
  );
}
