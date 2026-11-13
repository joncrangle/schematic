import { Show, type Accessor } from "solid-js";
import { cn } from "~/lib/utils";
import type { BadgeInfo } from "~/core/map";
import { handleActionKey } from "~/lib/keyboard";
import { useI18n } from "~/i18n/I18nContext";

interface LineBadgeMarkerProps {
  badge: BadgeInfo;
  hoveredLineId: Accessor<string | null>;
  onToggle: (lineId: string) => void;
  onHover: (lineId: string | null) => void;
}

export function LineBadgeMarker(props: LineBadgeMarkerProps) {
  const { t } = useI18n();
  const isHovered = () => props.hoveredLineId() === props.badge.line;

  const handleKeyDown = handleActionKey(() => props.onToggle(props.badge.line));

  const handlePointerEnter = (event: PointerEvent) => {
    if (event.pointerType === "mouse") {
      props.onHover(props.badge.line);
    }
  };

  const handlePointerLeave = (event: PointerEvent) => {
    if (event.pointerType === "mouse") {
      props.onHover(null);
    }
  };

  const label = () => props.badge.num || props.badge.line;

  return (
    <g
      transform={`translate(${props.badge.x}, ${props.badge.y})`}
      class="group/badge cursor-pointer outline-none [-webkit-tap-highlight-color:transparent]"
      tabindex={0}
      role="button"
      aria-pressed={isHovered() ? "true" : "false"}
      aria-label={t("Highlight line {{name}}", { name: label() })}
      onPointerEnter={handlePointerEnter}
      onPointerLeave={handlePointerLeave}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle(props.badge.line);
      }}
      onKeyDown={handleKeyDown}
    >
      <title>{t("Line {{name}} — Click to highlight", { name: label() })}</title>
      <circle
        r="12"
        fill={props.badge.color}
        stroke="var(--background)"
        stroke-width="2"
        class={cn(
          "transition-transform duration-150",
          isHovered()
            ? "scale-125"
            : "group-hover/badge:scale-125 group-focus-visible/badge:scale-125",
        )}
        style={{
          "transform-origin": "center",
          "transform-box": "fill-box",
        }}
      />

      <Show when={props.badge.num}>
        <text
          x="0"
          y="0"
          fill={props.badge.textColor || "#ffffff"}
          font-size={String(Math.min(12, 32 / label().length))}
          font-weight="bold"
          font-family="system-ui, sans-serif"
          dominant-baseline="central"
          text-anchor="middle"
          class="pointer-events-none select-none"
        >
          {props.badge.num}
        </text>
      </Show>
    </g>
  );
}
