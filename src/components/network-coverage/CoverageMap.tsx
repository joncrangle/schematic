/**
 * The coverage map canvas. One continuous projection with the
 * same camera, wheel zoom, drag pan, pinch, and double-click gestures as the
 * main map. The production viewport hook and controls are reused directly.
 */
import type { JSX } from "@solidjs/web";
import { type Accessor, createMemo, createSignal, For, onSettled, Show, untrack } from "solid-js";
import { handleActionKey } from "~/lib/keyboard";
import { MapControls } from "~/components/map/MapControls";
import { createMapViewport } from "~/components/map/viewport";
import { useI18n } from "~/i18n/I18nContext";
import {
  boundaryOpacityForZoom,
  coveragePath,
  createProjection,
  geographyPath,
  layoutLabels,
  outlineChunks,
  runsPath,
  scaleBarFor,
  type CoverageAgency,
  type CoverageView,
  type GeoBounds,
  type GeoCenter,
  type Point,
  zonePath,
} from "./coverageModel";
import type { CoverageGeography } from "./generated/geography";

export interface CoverageMapProps {
  readonly children?: (map: JSX.Element, center: Accessor<GeoCenter>) => JSX.Element;
  readonly id: string;
  readonly view: CoverageView;
  readonly agencies: readonly CoverageAgency[];
  /** National and international agencies drawn as station dots and a distinct marker. */
  readonly networkAgencies?: readonly CoverageAgency[];
  readonly geography: CoverageGeography;
  /** Optional province, territory, and state rings drawn over the landmass. */
  readonly boundaries?: readonly CoverageGeography[];
  readonly width: number;
  readonly height: number;
  readonly padding?: number;
  readonly focusBounds?: GeoBounds;
  readonly ariaLabel: string;
  readonly hint: string;
  readonly interactive?: boolean;
  readonly showLabels?: boolean;
  readonly showCoverage?: boolean;
  readonly selectedId?: string;
  readonly hoveredId?: string;
  readonly onHover?: (id: string | undefined) => void;
  readonly onSelect?: (id: string | undefined) => void;
}

const PAN_SLACK_RATIO = 0.28;
const OUTLINE_CELL_DEGREES = 4;
const SCALE_BAR_INSET = 22;
const SCALE_BAR_BOTTOM_INSET = 20;
const COMPASS_INSET = 22;
const COMPASS_TOP_INSET = 26;

export function CoverageMap(props: CoverageMapProps) {
  const i18n = useI18n();
  const { t } = i18n;
  const padding = () => props.padding ?? 16;
  const [mapSize, setMapSize] = createSignal({ width: props.width, height: props.height });
  const projection = createMemo(() =>
    createProjection(props.view.bounds, mapSize().width, mapSize().height, padding()),
  );

  const homeCamera = createMemo(() => {
    if (!props.focusBounds) return { zoom: 1, pan: { x: 0, y: 0 } };
    const { width, height } = mapSize();
    const topLeft = projection().project(props.focusBounds.minLon, props.focusBounds.maxLat);
    const bottomRight = projection().project(props.focusBounds.maxLon, props.focusBounds.minLat);
    const inset = 24;
    const focusWidth = Math.abs(bottomRight.x - topLeft.x);
    const focusHeight = Math.abs(bottomRight.y - topLeft.y);
    const zoom = Math.max(
      1,
      Math.min(
        (width - inset * 2) / Math.max(focusWidth, 1),
        (height - inset * 2) / Math.max(focusHeight, 1),
      ),
    );
    const centerX = (topLeft.x + bottomRight.x) / 2;
    const centerY = (topLeft.y + bottomRight.y) / 2;
    return {
      zoom,
      pan: {
        x: width / 2 - centerX * zoom,
        y: height / 2 - centerY * zoom,
      },
    };
  });

  const [containerRef, setContainerRef] = createSignal<HTMLDivElement>();
  const initialCamera = untrack(homeCamera);
  const clampPan = (next: Point, zoomValue: number): Point => {
    const { width, height } = mapSize();
    const mapWidth = width * zoomValue;
    const mapHeight = height * zoomValue;
    // Loose bounds: the map can be dragged well past the edges, but roughly a
    // quarter of the viewport always keeps part of the map reachable.
    const slackX = width * PAN_SLACK_RATIO;
    const slackY = height * PAN_SLACK_RATIO;
    return {
      x: Math.min(width - slackX, Math.max(slackX - mapWidth, next.x)),
      y: Math.min(height - slackY, Math.max(slackY - mapHeight, next.y)),
    };
  };
  const viewport = createMapViewport(containerRef, {
    get viewBoxWidth() {
      return mapSize().width;
    },
    get viewBoxHeight() {
      return mapSize().height;
    },
    minZoom: 0.35,
    maxZoom: 64,
    initialZoom: initialCamera.zoom,
    initialPan: initialCamera.pan,
    fitTransform: () => homeCamera(),
    clampPan,
    wheelZoomFactor: (delta) => Math.min(1.18, Math.max(0.85, Math.exp(-delta * 0.0012))),
  });

  // The SVG viewBox matches the real container, so the map fills the screen
  // without letterboxing and pointer-to-map math stays 1:1.
  onSettled(() => {
    const container = containerRef();
    if (!container) return;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      const { width, height } = entry.contentRect;
      if (width <= 0 || height <= 0) return;
      const current = mapSize();
      if (current.width === width && current.height === height) return;
      setMapSize({ width, height });
      if (!viewport.hasManualTransform()) viewport.resetViewport();
    });
    observer.observe(container);
    return () => observer.disconnect();
  });

  const landPath = createMemo(() => geographyPath(props.geography, projection().project));
  const boundaryPaths = createMemo(() =>
    (props.boundaries ?? []).map((region) => geographyPath(region, projection().project)),
  );
  const coastlineRuns = createMemo(() => outlineChunks(props.geography, OUTLINE_CELL_DEGREES));
  const coastlinePaths = createMemo(() =>
    coastlineRuns().map((runs) => runsPath(runs, projection().project)),
  );
  const markerAgencies = createMemo(() => [...props.agencies, ...(props.networkAgencies ?? [])]);
  // Round-capped zero-length segments, grouped by cell, draw screen-sized dots.
  const networkStations = createMemo(() =>
    (props.networkAgencies ?? []).flatMap((agency) => {
      const cells = new Map<string, string>();
      for (const bounds of agency.bounds) {
        const lon = (bounds.minLon + bounds.maxLon) / 2;
        const lat = (bounds.minLat + bounds.maxLat) / 2;
        const point = projection().project(lon, lat);
        const key = `${Math.floor(lon / OUTLINE_CELL_DEGREES)},${Math.floor(lat / OUTLINE_CELL_DEGREES)}`;
        cells.set(key, `${cells.get(key) ?? ""}M${point.x.toFixed(3)},${point.y.toFixed(3)}h0`);
      }
      return [...cells.values()].map((d) => ({ agency, d }));
    }),
  );
  const labelPlacements = createMemo(() => {
    if (!props.showLabels) return new Map();
    const { width, height } = mapSize();
    return layoutLabels(
      markerAgencies().map((agency) => {
        const point = projection().project(agency.labelCenter.lon, agency.labelCenter.lat);
        return {
          id: agency.id,
          x: point.x,
          y: point.y,
          text: agency.shortName,
          priority: agency.isCurrent
            ? 3
            : agency.scope !== "regional"
              ? 2
              : agency.status === "active"
                ? 1
                : 0,
        };
      }),
      width,
      height,
      1 / viewport.zoom(),
    );
  });
  const scaleBar = createMemo(() => {
    const mapY = (mapSize().height - SCALE_BAR_BOTTOM_INSET - viewport.pan().y) / viewport.zoom();
    const bar = scaleBarFor(
      projection().horizontalScaleAt(mapY),
      viewport.zoom(),
      i18n.unitSystem(),
    );
    const label = t(bar.unit === "km" ? "{{distance}} km" : "{{distance}} mi", {
      distance: i18n.formatNumber(bar.distance),
    });
    return {
      length: bar.length,
      label,
      y: mapSize().height - SCALE_BAR_BOTTOM_INSET,
      x: SCALE_BAR_INSET,
    };
  });

  const activeId = () => props.hoveredId ?? props.selectedId;
  // Halos are the costliest repaint per drag frame. Latch so a second finger keeps them hidden.
  const isMoving = createMemo<boolean>(
    (moved) => viewport.isDragging() && (viewport.hasMovedDistance() || moved === true),
  );
  const markerScale = () => 1 / viewport.zoom();
  const boundaryOpacity = () => boundaryOpacityForZoom(viewport.zoom());
  // 6px between hatch lines, drawn as diagonals in an axis-aligned tile.
  const hatchCell = () => 6 * Math.SQRT2 * markerScale();
  const hatchPath = () => {
    const cell = hatchCell();
    const corner = cell / 4;
    return `M${-corner},${corner}L${corner},${-corner}M0,${cell}L${cell},0M${cell - corner},${cell + corner}L${cell + corner},${cell - corner}`;
  };
  const filterId = (kind: string) => `${props.id}-${kind}`;
  const agencyPointerHandlers = (id: string) => ({
    onPointerEnter: (event: PointerEvent) => {
      if (event.pointerType !== "touch") props.onHover?.(id);
    },
    onPointerLeave: () => props.onHover?.(undefined),
    onClick: () => {
      if (viewport.hasMovedDistance()) return;
      props.onSelect?.(props.selectedId === id ? undefined : id);
    },
  });

  const center = createMemo(() =>
    projection().unproject({
      x: (mapSize().width / 2 - viewport.pan().x) / viewport.zoom(),
      y: (mapSize().height / 2 - viewport.pan().y) / viewport.zoom(),
    }),
  );

  const map = (
    <div
      ref={setContainerRef}
      class={`relative h-full w-full touch-none overflow-hidden ${
        props.interactive ? (viewport.isDragging() ? "cursor-grabbing" : "cursor-grab") : ""
      }`}
      {...(props.interactive ? viewport.pointerHandlers : {})}
    >
      <svg
        viewBox={`0 0 ${mapSize().width} ${mapSize().height}`}
        class="h-full w-full select-none"
        role="group"
        aria-label={props.ariaLabel}
      >
        <defs>
          <linearGradient id={filterId("land")} x1="0" y1="0" x2="0.7" y2="1">
            <stop offset="0%" stop-color="#141b27" />
            <stop offset="55%" stop-color="#0f141d" />
            <stop offset="100%" stop-color="#0a0d13" />
          </linearGradient>
          <radialGradient id={filterId("vignette")} cx="50%" cy="38%" r="72%">
            <stop offset="0%" stop-color="#38bdf8" stop-opacity="0.07" />
            <stop offset="100%" stop-color="#38bdf8" stop-opacity="0" />
          </radialGradient>
          {/* A rotated pattern repaints very slowly in WebKit; the tile draws the diagonal itself. */}
          <pattern
            id={filterId("hatch")}
            width={hatchCell()}
            height={hatchCell()}
            patternUnits="userSpaceOnUse"
          >
            <path
              d={hatchPath()}
              stroke="#7dd3fc"
              stroke-opacity="0.1"
              stroke-width={markerScale() / 2}
            />
          </pattern>
        </defs>

        <rect
          width={mapSize().width}
          height={mapSize().height}
          fill={`url(#${filterId("vignette")})`}
        />

        <g transform={viewport.transform()}>
          <path d={landPath()} fill={`url(#${filterId("land")})`} fill-rule="evenodd" />
          <path d={landPath()} fill={`url(#${filterId("hatch")})`} fill-rule="evenodd" />
          <g
            aria-hidden="true"
            class="pointer-events-none"
            fill="none"
            stroke="#4d6078"
            stroke-opacity="0.6"
            stroke-width="1.2"
            stroke-linejoin="round"
          >
            <For each={coastlinePaths()}>
              {(d) => <path d={d} vector-effect="non-scaling-stroke" />}
            </For>
          </g>
          <Show when={boundaryOpacity() > 0}>
            <g
              aria-hidden="true"
              class="pointer-events-none"
              fill="none"
              stroke="#7dd3fc"
              stroke-opacity={boundaryOpacity()}
              stroke-width="0.8"
              stroke-linejoin="round"
            >
              <For each={boundaryPaths()}>
                {(d) => <path d={d} vector-effect="non-scaling-stroke" />}
              </For>
            </g>
          </Show>

          <Show when={props.showCoverage !== false}>
            <For each={props.agencies}>
              {(agency) => {
                const isActive = () => agency.id === activeId();
                const isDimmed = () => Boolean(activeId()) && !isActive();
                // One halo path per agency; recomputes when the map box settles.
                const halo = createMemo(() => coveragePath(agency, projection().project));
                return (
                  <g
                    class="cursor-pointer"
                    style={{ opacity: isDimmed() ? 0.38 : 1 }}
                    {...agencyPointerHandlers(agency.id)}
                  >
                    <title>{agency.name}</title>
                    {/* Screen-pixel strokes need no width updates while zooming. */}
                    <path
                      d={halo()}
                      visibility={isActive() || !isMoving() ? "visible" : "hidden"}
                      fill="none"
                      stroke={agency.glow}
                      stroke-opacity={isActive() ? 0.28 : 0.12}
                      stroke-width={isActive() ? 9 : 7}
                      vector-effect="non-scaling-stroke"
                    />
                    {/* Zones stay separate so overlaps stack. Includes the former halo
                    fill: 0.05 under 0.2 composites to 0.24. */}
                    <For each={agency.bounds}>
                      {(_, index) => (
                        <path
                          d={zonePath(agency, index(), projection().project)}
                          fill={agency.color}
                          fill-opacity={
                            isActive() ? 0.46 : agency.status === "active" ? 0.24 : 0.18
                          }
                          stroke={agency.glow}
                          stroke-opacity={isActive() ? 0.95 : 0.42}
                          stroke-width={isActive() ? 2 : 1}
                          vector-effect="non-scaling-stroke"
                        />
                      )}
                    </For>
                  </g>
                );
              }}
            </For>
          </Show>

          <Show when={networkStations().length > 0}>
            <g aria-hidden="true" class="pointer-events-none" fill="none" stroke-linecap="round">
              <For each={networkStations()}>
                {(stations) => (
                  <>
                    <path
                      d={stations.d}
                      stroke="#06080c"
                      stroke-width="4.2"
                      vector-effect="non-scaling-stroke"
                    />
                    <path
                      d={stations.d}
                      stroke={stations.agency.glow}
                      stroke-opacity="0.65"
                      stroke-width="3"
                      vector-effect="non-scaling-stroke"
                    />
                  </>
                )}
              </For>
            </g>
          </Show>

          <g>
            <For each={markerAgencies()}>
              {(agency) => {
                // Keep marker geometry in screen pixels. One inverse-zoom
                // transform avoids tiny reactive radii inside the zoomed map.
                const point = () =>
                  projection().project(agency.labelCenter.lon, agency.labelCenter.lat);
                const isActive = () => agency.id === activeId();
                return (
                  <g
                    class="cursor-pointer"
                    transform={`translate(${point().x}, ${point().y}) scale(${markerScale()})`}
                    role="button"
                    tabindex={0}
                    aria-label={agency.name}
                    aria-pressed={props.selectedId === agency.id ? "true" : "false"}
                    onKeyDown={handleActionKey(() =>
                      props.onSelect?.(props.selectedId === agency.id ? undefined : agency.id),
                    )}
                    onFocus={() => props.onHover?.(agency.id)}
                    onBlur={() => props.onHover?.(undefined)}
                    {...agencyPointerHandlers(agency.id)}
                  >
                    <title>{agency.name}</title>
                    <Show when={agency.scope !== "regional"}>
                      <rect
                        x={isActive() ? -10 : -8}
                        y={isActive() ? -10 : -8}
                        width={isActive() ? 20 : 16}
                        height={isActive() ? 20 : 16}
                        transform="rotate(45)"
                        fill="none"
                        stroke={agency.glow}
                        stroke-opacity={isActive() ? 0.8 : 0.45}
                        stroke-width="1"
                      />
                    </Show>
                    <Show when={agency.isCurrent}>
                      <circle
                        cx="0"
                        cy="0"
                        r={isActive() ? 18 : 14}
                        fill="none"
                        stroke={agency.glow}
                        stroke-opacity="0.4"
                        stroke-width="1"
                        stroke-dasharray="3 4"
                      />
                    </Show>
                    <circle
                      cx="0"
                      cy="0"
                      r={isActive() ? 9 : 6}
                      fill="#06080c"
                      stroke={agency.glow}
                      stroke-opacity={isActive() ? 0.7 : 0.3}
                      stroke-width="1"
                    />
                    <circle
                      cx="0"
                      cy="0"
                      r={isActive() ? 11 : 8}
                      fill={agency.glow}
                      fill-opacity={isActive() ? 0.28 : 0.16}
                    />
                    <circle cx="0" cy="0" r={isActive() ? 6 : 4} fill={agency.glow} />
                    <circle cx="0" cy="0" r={isActive() ? 3 : 2} fill="#ffffff" />
                    <circle cx="0" cy="0" r="14" fill="transparent" />
                  </g>
                );
              }}
            </For>
          </g>

          <Show when={props.showLabels}>
            <g aria-hidden="true" class="pointer-events-none">
              <For each={markerAgencies()}>
                {(agency) => {
                  const placement = () => labelPlacements().get(agency.id);
                  return (
                    <Show when={placement()}>
                      {(label) => (
                        <text
                          x={label().x}
                          y={label().y}
                          text-anchor={label().anchor}
                          fill={
                            agency.id === activeId()
                              ? "#ffffff"
                              : agency.scope !== "regional"
                                ? agency.glow
                                : "#cbd5e1"
                          }
                          font-size={String(10.5 / viewport.zoom())}
                          font-weight="500"
                          letter-spacing="0.01em"
                          stroke="#06080c"
                          stroke-width={String(3 / viewport.zoom())}
                          paint-order="stroke"
                        >
                          {agency.shortName}
                        </text>
                      )}
                    </Show>
                  );
                }}
              </For>
            </g>
          </Show>
        </g>

        <Show when={props.interactive}>
          <g aria-hidden="true">
            <line
              x1={scaleBar().x}
              y1={scaleBar().y}
              x2={scaleBar().x + scaleBar().length}
              y2={scaleBar().y}
              stroke="#7dd3fc"
              stroke-opacity="0.5"
              stroke-width="1.5"
            />
            <line
              x1={scaleBar().x}
              y1={scaleBar().y - 4}
              x2={scaleBar().x}
              y2={scaleBar().y + 4}
              stroke="#7dd3fc"
              stroke-opacity="0.5"
              stroke-width="1.5"
            />
            <line
              x1={scaleBar().x + scaleBar().length}
              y1={scaleBar().y - 4}
              x2={scaleBar().x + scaleBar().length}
              y2={scaleBar().y + 4}
              stroke="#7dd3fc"
              stroke-opacity="0.5"
              stroke-width="1.5"
            />
            <text
              x={scaleBar().x}
              y={scaleBar().y - 7}
              fill="#7dd3fc"
              fill-opacity="0.65"
              font-size="9"
            >
              {scaleBar().label}
            </text>
          </g>
          <g aria-hidden="true">
            <text
              x={mapSize().width - COMPASS_INSET}
              y={COMPASS_TOP_INSET}
              text-anchor="end"
              fill="#7dd3fc"
              fill-opacity="0.55"
              font-size="11"
            >
              {t("North")} ↑
            </text>
          </g>
        </Show>
      </svg>

      <Show when={props.interactive}>
        <MapControls
          onZoomIn={() => viewport.zoomFromCenter(1.2)}
          onZoomOut={() => viewport.zoomFromCenter(0.8)}
          onRecenter={viewport.resetViewport}
          class="bottom-4"
        />
        <div class="pointer-events-none absolute bottom-5 left-1/2 z-10 -translate-x-1/2 rounded-full border border-white/8 bg-[#0a0e14]/70 px-3 py-1 text-[9px] tracking-[0.08em] text-slate-500 uppercase backdrop-blur-sm">
          {props.hint}
        </div>
      </Show>
    </div>
  );
  return props.children ? props.children(map, center) : map;
}
