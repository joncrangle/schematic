import { createMemo, For, Show } from "solid-js";
import type { LiveVehiclePosition, RouteTrackingData, SurfaceStop } from "~/domain/surface/types";
import { DEFAULT_SURFACE_ROUTE_COLOR, SURFACE_MODE_COLORS } from "~/domain/surface/types";
import { buildRouteSvgPathD, type GeometryPort, type SnapAttribution } from "~/core/map";
import { keyListById } from "~/lib/keyedList";
import type { Point, StationInfo } from "~/core/map";
import type { SchematicStationIndexEntry } from "~/agencies/types";
import { resolveSchematicStationIdFromFeedId } from "~/domain/stationAlerts";
import { Dynamic } from "@solidjs/web";
import {
  getSurfaceModeMeta,
  formatSurfaceVehicleLabel,
} from "~/components/route/routeTrackingHelpers";
import { useI18n } from "~/i18n/I18nContext";

import type { TargetedRouteTracking } from "~/lib/routeTrackingLifecycle";

export interface TargetedRouteOverlayProps {
  readonly geometry: GeometryPort;
  /**
   * Rail line resolved from the feed route ID through the manifest's branch
   * mapping. Rail nodes follow its schematic corridor; surface nodes and lines
   * retain the detailed feed geometry even when this ID is supplied.
   */
  readonly activeLineId?: string;
  readonly tracking?: TargetedRouteTracking;
  readonly trackingData: RouteTrackingData;
  readonly interchangeStations?: readonly StationInfo[];
  readonly stationIndex?: readonly SchematicStationIndexEntry[];
  readonly onSelectStation?: (stationId: string) => void;
  readonly prefersReducedMotion?: boolean;
  readonly onSelectVehicle?: (vehicle: LiveVehiclePosition, point: Point) => void;
  readonly selectedVehicleId?: string | null;
  readonly onSelectStop?: (stop: SurfaceStop, point: Point) => void;
  readonly selectedStopId?: string | null;
}

/**
 * Prominent targeted route layer.
 *
 * Consumes live snapshots that change identity every renewal tick (each fetch
 * builds a fresh RouteTrackingData). All geometry derives through reactive
 * memos and both stop/vehicle lists render through stable-id keyed <For>s, so
 * a data refresh PATCHES nodes in place instead of synchronously tearing down
 * hundreds of SVG elements, and in-flight vehicle CSS transitions
 * (`transform 10s linear`) keep animating across ticks.
 */
export function TargetedRouteOverlay(props: TargetedRouteOverlayProps) {
  const i18n = useI18n();
  const data = () => props.trackingData;
  const activeDirectionId = () =>
    props.tracking?.selectedDirectionId?.() ?? data()?.shape?.directionId ?? 0;
  const effectiveNearestStopId = () => props.tracking?.nearestStopId();

  const routeColor = () => {
    const d = data();
    return (
      d?.route?.color ||
      (d ? SURFACE_MODE_COLORS[d.route.routeType] : undefined) ||
      DEFAULT_SURFACE_ROUTE_COLOR
    );
  };
  const routeShortName = () => data()?.route?.shortName ?? "";
  const routeLongName = () => data()?.route?.longName ?? "";
  const routeType = () => data()?.route?.routeType ?? "bus";
  const vehicleModeMeta = createMemo(() => getSurfaceModeMeta(routeType()));

  // Share rail attribution between the corridor, stops, and vehicles.
  const drawnLineId = () =>
    routeType() === "rail" || routeType() === "subway" ? props.activeLineId : undefined;
  const attribution = createMemo<SnapAttribution | undefined>(() => {
    const lineId = drawnLineId();
    return lineId ? { lineId } : undefined;
  });

  // Rail follows the schematic's drawn line. Surface routes use the detailed
  // feed corridor so every stop and vehicle shares the line's geographic space.
  const routePoints = createMemo<Point[]>(() => {
    const lineId = drawnLineId();
    const drawnPoints = lineId ? props.geometry.drawnLineMapPoints(lineId) : undefined;
    if (drawnPoints && drawnPoints.length > 1) return drawnPoints;

    const d = data();
    return d?.shape && d?.stops
      ? props.geometry.extractRouteMapPoints(d.shape, d.stops, attribution())
      : [];
  });

  const pathD = createMemo(() => buildRouteSvgPathD(routePoints()));

  // Filter vehicles for active direction and place them at their geographic
  // positions. Keyed by vehicleId so marker nodes survive per-tick payload
  // replacement; positions/bearings re-read reactively inside each node.
  const positionedVehicles = createMemo(() => {
    const d = data();
    if (!d?.vehicles) {
      return keyListById(
        [] as { vehicle: LiveVehiclePosition; point: Point; bearing: number }[],
        (entry) => entry.vehicle.vehicleId,
      );
    }
    return keyListById(
      d.vehicles
        .filter((v) => v.directionId === activeDirectionId())
        .map((v) => ({
          vehicle: v,
          point: props.geometry.projectGeoToMapPoint(v.latitude, v.longitude, attribution()),
          bearing: v.bearing ?? 0,
        })),
      (entry) => entry.vehicle.vehicleId,
    );
  });

  // Set of connected schematic station ids. The display name is never used
  // to infer topology at this component seam.
  const connectedParentStations = createMemo(() => {
    const set = new Set<string>();
    const d = data();
    if (d?.stops) {
      for (const stop of d.stops) {
        if (stop.parentStationId) {
          set.add(stop.parentStationId);
        }
      }
    }
    return set;
  });

  // Connecting interchange stations to highlight brightly (strictly interchange stations connected to this route)
  // Items come straight from the static stationList, so unchanged memberships
  // keep referential identities and <For> patches rather than recreating pills.
  const connectingInterchanges = createMemo(() => {
    if (!props.interchangeStations) return [];
    const connected = connectedParentStations();
    return props.interchangeStations.filter((st) => {
      return connected.has(st.id) && st.isInterchange;
    });
  });

  const activeLineStations = createMemo(() => {
    const lineId = drawnLineId();
    return new Map(
      (props.interchangeStations ?? [])
        .filter((station) => lineId && station.lines.includes(lineId))
        .map((station) => [station.id, station]),
    );
  });

  const stationIdForStop = (stop: SurfaceStop) =>
    stop.parentStationId ?? resolveSchematicStationIdFromFeedId(stop.id, props.stationIndex);

  // The drawn line represents the whole route. Fill branch stops from the
  // generated feed index, so a representative trip ending at Aldershot cannot
  // truncate the nodes. Every node keeps a feed stop ID and uses the stop card.
  const keyedStops = createMemo(() => {
    const d = data();
    const stops = [...(d?.stops ?? [])];
    const represented = new Set(stops.map(stationIdForStop));
    if (d) {
      for (const entry of props.stationIndex ?? []) {
        if (
          !entry.schematicId ||
          !activeLineStations().has(entry.schematicId) ||
          represented.has(entry.schematicId)
        )
          continue;
        represented.add(entry.schematicId);
        stops.push({
          id: entry.platformIds.includes(entry.id) ? entry.id : (entry.platformIds[0] ?? entry.id),
          name: entry.name,
          lat: entry.lat,
          lon: entry.lon,
          wheelchair: 0,
          routes: [d.route.id],
        });
      }
    }
    return keyListById(stops, (stop) => stop.id);
  });

  const resolveStopPoint = (stop: SurfaceStop): Point => {
    // A drawn corridor covers the background station markers. Its foreground
    // stop nodes must use those same anchors, rather than a nearby geographic
    // projection. Resolve identity from the feed index, never the display name.
    const stationId = stationIdForStop(stop);
    const station = stationId ? activeLineStations().get(stationId) : undefined;
    if (station) return { x: station.x, y: station.y };
    return props.geometry.projectGeoToMapPoint(stop.lat, stop.lon, attribution());
  };

  return (
    <g class="targeted-route-layer">
      {/* Route Path Glow / Casing */}
      <Show when={pathD()}>
        <path
          d={pathD()}
          fill="none"
          stroke="var(--background)"
          stroke-width="14"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="opacity-90 pointer-events-none"
        />

        {/* Core Vibrant Route Path */}
        <path
          d={pathD()}
          fill="none"
          stroke={routeColor()}
          stroke-width="7"
          stroke-linecap="round"
          stroke-linejoin="round"
          class="drop-shadow-[0_0_8px_rgba(218,37,29,0.5)] pointer-events-none"
        />
      </Show>

      {/* Route stop nodes, keyed by stop id so renewals patch in place.
          Single read, keyed: the checked entry is the rendered entry. A bare
          `byId.get(id)!` can miss when the key list and the lookup straddle an
          update pass, throwing mid-flush and halting reactivity. */}
      <For each={keyedStops().ids}>
        {(stopId) => {
          const stop = () => keyedStops().byId.get(stopId);
          return (
            <Show when={stop()} keyed>
              {(value) => (
                <g
                  class="cursor-pointer select-none"
                  transform={`translate(${resolveStopPoint(value).x}, ${resolveStopPoint(value).y})`}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onSelectStop?.(value, resolveStopPoint(value));
                  }}
                >
                  {/* Tap Target Expansion Area - Sized precisely to avoid adjacent overlap */}
                  <circle r="8" fill="transparent" pointer-events="all" />

                  {/* Pulsing ring for nearest stop */}
                  <Show
                    when={effectiveNearestStopId() != null && value.id === effectiveNearestStopId()}
                  >
                    <circle
                      r="14"
                      fill="none"
                      stroke="var(--color-info)"
                      stroke-width="2.5"
                      class={
                        props.prefersReducedMotion
                          ? "opacity-40 pointer-events-none"
                          : "animate-ping opacity-40 pointer-events-none"
                      }
                    />
                    <circle
                      r="9"
                      fill="none"
                      stroke="var(--color-info)"
                      stroke-width="2"
                      class="opacity-70 pointer-events-none"
                    />
                  </Show>

                  {/* Selection Ring */}
                  <Show when={props.selectedStopId === value.id}>
                    <circle
                      r="11"
                      fill="none"
                      stroke="var(--color-info)"
                      stroke-width="2"
                      class="pointer-events-none"
                    />
                  </Show>

                  <circle
                    r={
                      (effectiveNearestStopId() != null && value.id === effectiveNearestStopId()) ||
                      props.selectedStopId === value.id
                        ? "7"
                        : value.parentStationId
                          ? "6"
                          : "4"
                    }
                    fill={
                      props.selectedStopId === value.id
                        ? "var(--color-info)"
                        : effectiveNearestStopId() != null && value.id === effectiveNearestStopId()
                          ? "var(--color-info)"
                          : value.parentStationId
                            ? "#ffcb05"
                            : "#ffffff"
                    }
                    stroke={
                      (effectiveNearestStopId() != null && value.id === effectiveNearestStopId()) ||
                      props.selectedStopId === value.id
                        ? "var(--color-info)"
                        : "var(--card)"
                    }
                    stroke-width={
                      value.parentStationId || props.selectedStopId === value.id ? "3" : "2"
                    }
                    class="transition-transform duration-150 pointer-events-none"
                  >
                    <title>
                      {effectiveNearestStopId() != null && value.id === effectiveNearestStopId()
                        ? `${value.name} (${i18n.t("Nearest stop")})`
                        : value.name}
                    </title>
                  </circle>
                </g>
              )}
            </Show>
          );
        }}
      </For>

      {/* Connecting Interchange Stations Bright Highlight Pills */}
      <For each={connectingInterchanges()}>
        {(station) => (
          <g
            class="connecting-interchange-highlight cursor-pointer"
            transform={`translate(${station.x}, ${station.y})`}
            onClick={() => props.onSelectStation?.(station.id)}
          >
            <title>
              {i18n.t("Transfer to {{lines}} at {{station}}", {
                lines: i18n.t(station.lines.length > 1 ? "Lines {{lines}}" : "Line {{lines}}", {
                  lines: station.lines.join(", "),
                }),
                station: station.name,
              })}
            </title>
            {/* Pulsing ring aura */}
            <circle
              r="16"
              fill="none"
              stroke="#ffcb05"
              stroke-width="2"
              class={
                props.prefersReducedMotion
                  ? "opacity-30 pointer-events-none"
                  : "animate-ping opacity-30 pointer-events-none"
              }
            />
            {/* Transfer Badge Pill */}
            <rect
              x="-24"
              y="-10"
              width="48"
              height="20"
              rx="10"
              fill="var(--card)"
              stroke="#ffcb05"
              stroke-width="2.5"
              class="shadow-lg"
            />
            <text
              text-anchor="middle"
              dominant-baseline="central"
              fill="#ffffff"
              font-size="9"
              font-weight="bold"
              font-family="sans-serif"
            >
              {station.lines.join(" • ")}
            </text>
          </g>
        )}
      </For>

      {/* Live vehicle markers snapped to the route polyline, keyed
          by vehicleId so renewals move existing nodes (keeping their 10s
          linear CSS motion) instead of recreating them every tick.
          Single read, keyed: the checked entry is the rendered entry (see the
          stop-node note above). */}
      <For each={positionedVehicles().ids}>
        {(vehicleId) => {
          const entry = () => positionedVehicles().byId.get(vehicleId);
          return (
            <Show when={entry()} keyed>
              {(value) => (
                <g
                  class="vehicle-marker-node cursor-pointer select-none"
                  opacity={value.vehicle.freshness === "stale" ? 0.5 : 1}
                  style={{
                    transform: `translate(${value.point.x}px, ${value.point.y}px)`,
                    transition: props.prefersReducedMotion ? "none" : "transform 10s linear",
                  }}
                  onClick={(e) => {
                    e.stopPropagation();
                    props.onSelectVehicle?.(value.vehicle, value.point);
                  }}
                >
                  <title>
                    {formatSurfaceVehicleLabel(routeShortName(), routeType(), i18n)}
                    {routeLongName() ? ` — ${routeLongName()}` : ""}
                  </title>
                  {/* Bearing Arrow Direction Halo */}
                  <Show when={value.bearing !== undefined}>
                    <g transform={`rotate(${value.bearing})`}>
                      <path
                        d="M 0 -18 L 6 -10 L -6 -10 Z"
                        fill="var(--color-warning-400)"
                        class="drop-shadow-md"
                      />
                    </g>
                  </Show>

                  {/* Vehicle Badge Circle */}
                  <circle
                    r="13"
                    fill="var(--muted)"
                    stroke={
                      props.selectedVehicleId === value.vehicle.vehicleId
                        ? "var(--color-warning-400)"
                        : "#ffffff"
                    }
                    stroke-width={props.selectedVehicleId === value.vehicle.vehicleId ? "3" : "2"}
                    class="shadow-xl"
                  />

                  {/* Crisp Vector Vehicle Icon, SVG context consumes the mode
                  table directly: VehicleGlyph's root is an HTML <span>, which
                  does not render inside an SVG tree. */}
                  <g class="pointer-events-none" transform="translate(-7, -7)">
                    <Dynamic
                      component={vehicleModeMeta().icon}
                      size={14}
                      class={vehicleModeMeta().iconClass}
                    />
                  </g>
                </g>
              )}
            </Show>
          );
        }}
      </For>
    </g>
  );
}
