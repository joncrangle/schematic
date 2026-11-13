import { type Accessor, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { MAP_OPACITY, createLineDimming } from "./line-dimming";
import type { LineInfo } from "~/core/map";

interface LinePathProps {
  line: LineInfo;
  hoveredLineId: Accessor<string | null>;
  onToggle: (lineId: string) => void;
}

export function LinePath(props: LinePathProps) {
  const { isSelected: isHovered, isDimmed } = createLineDimming(props.line.id, props.hoveredLineId);

  return (
    <g
      class={cn("cursor-pointer outline-none")}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle(props.line.id);
      }}
    >
      <title>{props.line.name}</title>
      <Show when={isHovered()}>
        <path
          d={props.line.pathD}
          fill="none"
          stroke={props.line.color}
          stroke-width="16"
          stroke-linecap="round"
          stroke-linejoin="round"
          opacity={MAP_OPACITY.lineHoverHalo}
          class="pointer-events-none"
        />
      </Show>

      <path
        d={props.line.pathD}
        fill="none"
        stroke={props.line.color}
        stroke-width={isHovered() ? "10" : "8"}
        stroke-linecap="round"
        stroke-linejoin="round"
        opacity={isDimmed() ? MAP_OPACITY.lineDimmed : MAP_OPACITY.lineStroke}
        class="transition-[stroke-width,opacity] duration-200"
      />
    </g>
  );
}
