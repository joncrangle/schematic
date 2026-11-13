import { createMemo, Show, untrack } from "solid-js";
import type { Accessor } from "solid-js";
import { cn } from "~/lib/utils";
import { WheelchairIcon } from "../icons/WheelchairIcon";
import type { StationInfo } from "~/core/map";
import { stationLabelLeaderStart } from "~/core/map/interchange-geometry";
import {
  isMajorHub as isMajorHubLines,
  STATION_DOT_RADIUS,
  stationPillShape,
} from "~/core/map/station-marker-shape";
import { formatStationTooltip } from "./tooltips";
import { handleActionKey } from "~/lib/keyboard";
import { formatStationAriaLabel } from "./tooltips";
import { useI18n } from "~/i18n/I18nContext";

interface StationMarkerProps {
  station: StationInfo;
  isSelected: Accessor<boolean>;
  onToggle: (stationId: string) => void;
  registerElement: (stationId: string, element: SVGGElement) => void;
  onHoverStation?: (stationId: string) => void;
  status?: Accessor<"normal" | "degraded" | "severe" | "unavailable">;
  accessibilityOutage?: Accessor<boolean>;
  /** Optional short map label; the station's canonical name still informs aria copy. */
  displayName?: string;
  /** A walking interchange adds its peer label before the station details. */
  ariaPrefix?: string;
}

export function StationMarker(props: StationMarkerProps) {
  const { t } = useI18n();
  const stationStatus = () => props.status?.() ?? props.station.status ?? "normal";
  const accessibilityOutage = () =>
    props.accessibilityOutage?.() ?? props.station.accessibilityOutage ?? false;
  const isSevere = () => stationStatus() === "severe";
  const isMajorHub = () => isMajorHubLines(props.station.lines);
  const pill = () => stationPillShape(props.station.lines).outline;
  const leaderStart = createMemo(() =>
    props.station.labelLeader ? stationLabelLeaderStart(props.station) : undefined,
  );

  const tooltipText = () =>
    formatStationTooltip(
      {
        name: props.displayName ?? props.station.name,
        lines: props.station.lines,
        status: stationStatus(),
        accessibilityOutage: accessibilityOutage(),
      },
      t,
    );
  const ariaLabel = () => {
    const details = formatStationAriaLabel(
      {
        name: props.station.name,
        lines: props.station.lines,
        accessible: props.station.accessible,
      },
      t,
    );
    return props.ariaPrefix
      ? t("{{prefix}}, {{details}}", { prefix: props.ariaPrefix, details })
      : details;
  };

  const handleKeyDown = handleActionKey(() => props.onToggle(props.station.id));

  return (
    <g
      ref={(element) =>
        props.registerElement(
          untrack(() => props.station.id),
          element,
        )
      }
      class="station-group group cursor-pointer outline-none [-webkit-tap-highlight-color:transparent]"
      tabindex={0}
      role="button"
      aria-haspopup="dialog"
      aria-expanded={props.isSelected() ? "true" : "false"}
      aria-label={ariaLabel()}
      onClick={(event) => {
        event.stopPropagation();
        props.onToggle(props.station.id);
      }}
      onPointerEnter={(event) => {
        if (event.pointerType === "mouse") {
          props.onHoverStation?.(props.station.id);
        }
      }}
      onKeyDown={handleKeyDown}
    >
      <title>{tooltipText()}</title>
      <Show when={leaderStart()} keyed>
        {(start) => (
          <line
            x1={start.x}
            y1={start.y}
            x2={props.station.labelX}
            y2={props.station.labelY}
            stroke="currentColor"
            stroke-width="0.7"
            class="text-muted-foreground/60 pointer-events-none"
          />
        )}
      </Show>
      <g transform={`translate(${props.station.x}, ${props.station.y})`}>
        <Show
          when={props.station.isInterchange}
          fallback={
            <circle
              r={STATION_DOT_RADIUS}
              fill={
                isSevere()
                  ? "color-mix(in srgb, var(--destructive) 25%, transparent)"
                  : "color-mix(in srgb, var(--color-info) 18%, transparent)"
              }
              stroke={isSevere() ? "var(--destructive)" : "var(--color-info)"}
              stroke-width="1.2"
              class={cn(
                "pointer-events-none transition-opacity duration-150",
                props.isSelected() || isSevere()
                  ? "opacity-100"
                  : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
              )}
            />
          }
        >
          <rect
            x={-pill().halfWidth}
            y={-pill().halfHeight}
            width={pill().halfWidth * 2}
            height={pill().halfHeight * 2}
            rx={pill().cornerRadius}
            fill={
              isSevere()
                ? "color-mix(in srgb, var(--destructive) 25%, transparent)"
                : "color-mix(in srgb, var(--color-info) 18%, transparent)"
            }
            stroke={isSevere() ? "var(--destructive)" : "var(--color-info)"}
            stroke-width="1.2"
            class={cn(
              "pointer-events-none transition-opacity duration-150",
              props.isSelected() || isSevere()
                ? "opacity-100"
                : "opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100",
            )}
          />
        </Show>

        <g
          class={cn(
            "transition-transform duration-150",
            props.isSelected()
              ? "scale-150"
              : "group-hover:scale-150 group-focus-visible:scale-150",
          )}
          style={{
            "transform-origin": "0px 0px",
          }}
        >
          <Show
            when={props.station.isInterchange}
            fallback={
              <>
                <Show when={isSevere()}>
                  <circle
                    r="8"
                    fill="color-mix(in srgb, var(--destructive) 40%, transparent)"
                    class="animate-ping motion-reduce:animate-none pointer-events-none"
                  />
                </Show>

                <circle
                  r="4.2"
                  fill="none"
                  stroke={isSevere() ? "var(--destructive)" : "#000000"}
                  stroke-width="1.2"
                  class="pointer-events-none"
                />

                <circle
                  r="4.2"
                  fill={
                    isSevere()
                      ? "var(--destructive)"
                      : props.station.accessible
                        ? accessibilityOutage()
                          ? "var(--color-destructive-300)"
                          : "var(--color-accessible)"
                        : "#ffffff"
                  }
                  class="pointer-events-none"
                />

                <Show when={props.station.accessible && !isSevere()}>
                  <WheelchairIcon
                    x="-3.0"
                    y="-3.0"
                    width="6.0"
                    height="6.0"
                    class="pointer-events-none"
                  />
                </Show>

                <Show when={!props.station.accessible && !isSevere() && accessibilityOutage()}>
                  <line
                    x1="-3.2"
                    y1="3.2"
                    x2="3.2"
                    y2="-3.2"
                    stroke="var(--color-destructive-300)"
                    stroke-width="1.8"
                    stroke-linecap="round"
                    class="pointer-events-none"
                  />
                </Show>
              </>
            }
          >
            <Show when={isSevere()}>
              <rect
                x={isMajorHub() ? "-10" : "-7"}
                y={isMajorHub() ? "-20" : "-12"}
                width={isMajorHub() ? "20" : "14"}
                height={isMajorHub() ? "40" : "24"}
                rx={isMajorHub() ? "8" : "4"}
                fill="color-mix(in srgb, var(--destructive) 40%, transparent)"
                class="animate-ping motion-reduce:animate-none pointer-events-none"
              />
            </Show>

            <rect
              x={isMajorHub() ? "-8" : "-5.5"}
              y={isMajorHub() ? "-17" : "-10"}
              width={isMajorHub() ? "16" : "11"}
              height={isMajorHub() ? "34" : "20"}
              rx={isMajorHub() ? "8" : "4"}
              fill={isSevere() ? "var(--destructive)" : "#ffffff"}
              stroke={isSevere() ? "var(--destructive)" : "#000000"}
              stroke-width={isMajorHub() ? "1.8" : "1.4"}
              class="pointer-events-none"
            />

            <Show when={props.station.accessible && !isSevere()}>
              <g class="pointer-events-none">
                <circle
                  r={isMajorHub() ? "4.5" : "3.6"}
                  fill={
                    accessibilityOutage()
                      ? "var(--color-destructive-300)"
                      : "var(--color-accessible)"
                  }
                />

                <WheelchairIcon
                  x={isMajorHub() ? "-3.2" : "-2.5"}
                  y={isMajorHub() ? "-3.2" : "-2.5"}
                  width={isMajorHub() ? "6.4" : "5.0"}
                  height={isMajorHub() ? "6.4" : "5.0"}
                  class="pointer-events-none"
                />
              </g>
            </Show>

            <Show when={!props.station.accessible && !isSevere() && accessibilityOutage()}>
              <line
                x1="-3.2"
                y1="3.2"
                x2="3.2"
                y2="-3.2"
                stroke="var(--color-destructive-300)"
                stroke-width="1.8"
                stroke-linecap="round"
                class="pointer-events-none"
              />
            </Show>
          </Show>
        </g>

        <Show
          when={props.station.isInterchange}
          fallback={<circle r="8" fill="transparent" class="cursor-pointer" />}
        >
          <rect
            x={isMajorHub() ? "-12" : "-9"}
            y={isMajorHub() ? "-22" : "-13"}
            width={isMajorHub() ? "24" : "18"}
            height={isMajorHub() ? "44" : "26"}
            rx={isMajorHub() ? "10" : "6"}
            fill="transparent"
            class="cursor-pointer"
          />
        </Show>
      </g>

      <g
        transform={
          `translate(${props.station.labelX}, ${props.station.labelY}) ` +
          `rotate(${props.station.labelRotation})`
        }
        class="cursor-pointer"
      >
        <text
          x="0"
          y="0"
          stroke={props.station.labelLeader ? "var(--background)" : undefined}
          stroke-width={props.station.labelLeader ? "3" : undefined}
          paint-order="stroke"
          font-size="11"
          font-weight={
            props.station.isInterchange || props.station.isTerminal || isSevere()
              ? "bold"
              : "normal"
          }
          font-family="system-ui, sans-serif"
          dominant-baseline="central"
          text-anchor={props.station.labelAnchor}
          class={cn(
            "select-none transition-colors duration-150",
            isSevere() && !props.isSelected()
              ? "fill-destructive"
              : props.isSelected()
                ? "fill-white"
                : "fill-muted-foreground group-hover:fill-white group-focus-visible:fill-white",
          )}
        >
          {props.station.name}
        </text>
      </g>
    </g>
  );
}
