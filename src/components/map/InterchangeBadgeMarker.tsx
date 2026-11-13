import { For, Show, type Accessor } from "solid-js";
import { handleActionKey } from "~/lib/keyboard";
import type { PositionedInterchangeBadge } from "~/core/map";
import { BusIcon, RailIcon } from "~/components/icons/TransitIcons";
import { useI18n } from "~/i18n/I18nContext";

interface InterchangeBadgeMarkerProps {
  readonly badges: readonly PositionedInterchangeBadge[];
  readonly onSelect: (badge: PositionedInterchangeBadge) => void;
  readonly isActive?: Accessor<boolean>;
}

/** Branded, non-line-selecting transfer controls for one hub's peer agencies. */
export function InterchangeBadgeMarker(props: InterchangeBadgeMarkerProps) {
  const { t } = useI18n();
  return (
    <Show when={props.badges.length > 0}>
      <g
        transform={`translate(${props.badges[0]?.x ?? 0}, ${props.badges[0]?.y ?? 0})`}
        class="interchange-badge-row"
        aria-hidden={props.isActive ? (!props.isActive() ? "true" : "false") : undefined}
      >
        <For each={props.badges}>
          {(badge) => {
            const handleKeyDown = handleActionKey(() => props.onSelect(badge));

            return (
              <g
                transform={`translate(${badge.xOffsetFromCenter}, ${badge.yOffsetFromCenter})`}
                role="button"
                tabindex={0}
                aria-label={t("Switch to {{agency}} at {{station}}", {
                  agency: badge.targetAgencyName,
                  station: badge.targetStationName,
                })}
                class="group/interchange cursor-pointer outline-none [-webkit-tap-highlight-color:transparent]"
                onClick={(event) => {
                  event.stopPropagation();
                  props.onSelect(badge);
                }}
                onKeyDown={handleKeyDown}
              >
                <title>
                  {t("Switch to {{agency}} at {{station}}", {
                    agency: badge.targetAgencyName,
                    station: badge.targetStationName,
                  })}
                </title>
                <rect
                  x={0}
                  y={badge.rectY}
                  width={badge.width}
                  height={badge.height}
                  rx={badge.cornerRadius}
                  fill={badge.color}
                  stroke="var(--background)"
                  stroke-width="1.5"
                  class="transition-transform duration-150 group-hover/interchange:scale-110 group-focus-visible/interchange:scale-110"
                  style={{ "transform-origin": badge.transformOrigin }}
                />
                <Show when={badge.hasIcon && badge.mode === "bus"}>
                  <BusIcon x={5} y={-5.5} size={11} class="text-white" />
                </Show>
                <Show when={badge.hasIcon && badge.mode === "rail"}>
                  <RailIcon x={5} y={-5.5} size={11} class="text-white" />
                </Show>
                <text
                  x={badge.textX}
                  y="0"
                  fill="#ffffff"
                  font-size="10"
                  font-weight="bold"
                  font-family="system-ui, sans-serif"
                  dominant-baseline="central"
                  text-anchor={badge.hasIcon ? "start" : "middle"}
                  class="pointer-events-none select-none"
                >
                  {badge.isCompact ? badge.agencyLabel : `⇄ ${badge.agencyLabel}`}
                </text>
              </g>
            );
          }}
        </For>
      </g>
    </Show>
  );
}
