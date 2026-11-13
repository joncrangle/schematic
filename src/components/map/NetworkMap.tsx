import { createMemo, createSignal, For, lazy, onSettled, Show, Loading, untrack } from "solid-js";
import { cn } from "~/lib/utils";

import {
  groupInterchangeBadges,
  normalizeInterchangeBadgeRequests,
  placeInterchangeBadges,
  placeWalkingInterchangeMarkers,
  deriveMapProjection,
  selectBadgeOrder,
  snapLineKey,
  type MapModel,
  type MapCamera,
  type Point,
} from "~/core/map";
import { allProviders, interchanges } from "~/agencies/browserRegistry";
import { peekSchematic } from "~/services/schematic/SchematicLoader";
import { useAgencySchematic } from "~/hooks/useAgencySchematic";
import { isDevServer } from "~/lib/devFlags";
import { DEFAULT_SURFACE_ROUTE_COLOR } from "~/domain/surface/types";

import type { BrowserAgency } from "~/agencies/types";
import { translateRawRouteId } from "~/domain/surface/routeIds";

import { LineBadgeMarker } from "./LineBadgeMarker";
import { InterchangeBadgeMarker } from "./InterchangeBadgeMarker";
import { WalkingInterchangeMarker } from "./WalkingInterchangeMarker";
import { walkingStationLabel } from "~/core/map/interchange-geometry";
import { projectInterchangeBadgeAgencies } from "~/core/map/interchange-agencies";
import { createInterchangeNavigation, type InterchangeFocus } from "./interchange-navigation";

import { LinePath } from "./LinePath";

import { MapControls } from "./MapControls";

import { StationMarker } from "./StationMarker";

import { StationPopover, type StationPopoverProps } from "./StationPopover";

import { StatusSegmentPath } from "./StatusSegmentPath";

import { createMapViewport } from "./viewport";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useNearbyCoordination } from "~/context/NearbyCoordinationContext";
import {
  favouriteLineIdsForAgency,
  type InterchangeBadgeVisibility,
} from "~/domain/preferences/UserPreferences";

import type { MapProjection, StatusOverlaySegment } from "~/core/map";
import {
  createTopologyCache,
  MAX_WARMED_SCHEMATICS,
  type TopologyCache,
} from "~/services/schematic/TopologyCache";
import { renderableSegments } from "./renderableSegments";
import { createSelectionController } from "./controllers/SelectionController";
import type { RouteEnlargeRequest, TargetedRouteTracking } from "~/lib/routeTrackingLifecycle";

const SpoofDrawer = lazy(() =>
  import("./SpoofDrawer").then(({ SpoofDrawer }) => ({ default: SpoofDrawer })),
);
const SegmentPopover = lazy(() =>
  import("./SegmentPopover").then(({ SegmentPopover }) => ({ default: SegmentPopover })),
);
const VehicleDetailsPopover = lazy(() =>
  import("./VehicleDetailsPopover").then(({ VehicleDetailsPopover }) => ({
    default: VehicleDetailsPopover,
  })),
);
const StopDetailsPopover = lazy(() =>
  import("./StopDetailsPopover").then(({ StopDetailsPopover }) => ({
    default: StopDetailsPopover,
  })),
);
import { RouteControls } from "./RouteControls";
import { TargetedRouteOverlay } from "./TargetedRouteOverlay";
import { prefetchStationDepartures, resolveStationEndpoints } from "~/hooks/useStationDepartures";
import { useAgencySnapshot } from "~/hooks/useAgencySnapshot";
import { useI18n } from "~/i18n/I18nContext";

/**
 * The alert surface the map renders is whatever its station popover consumes;
 * naming it structurally keeps this file free of any agency identifier.
 */
type StationAlerts = StationPopoverProps["alerts"];

export interface NetworkMapProps {
  /** The active agency: schematic source and manifest identity. */
  readonly provider: BrowserAgency;
  /** Topology already derived by the app shell for the active agency. */
  readonly topology?: MapModel;
  /** Shared cache used to retain progressively warmed pure topology. */
  readonly topologyCache?: TopologyCache;
  /** Snapshot projection: overlay segments, station severities, accessibility outages. */
  readonly projection: MapProjection;
  readonly alerts?: StationAlerts;
  readonly tracking?: TargetedRouteTracking;
  readonly onClearTargetedRoute?: () => void;
  readonly onEnlargeRoute?: (request: RouteEnlargeRequest) => void;
  /** Resolved by the app shell from preferences, viewport, and hydration state. */
  readonly interchangeBadgeVisibility: () => InterchangeBadgeVisibility;
  /** Temporary interchange state transition owned by the app shell. */
  readonly onTemporaryAgencyView: (focus: InterchangeFocus) => void;
}

/**
 * Graceful degradation for agencies that declare no schematic yet:
 * service status remains reachable through the sheet panels while the map
 * surface explains itself instead of rendering an empty canvas.
 */
function SchematicFallbackCard(props: { agencyName: string }) {
  return (
    <div
      role="status"
      class="flex h-full w-full flex-col items-center justify-center gap-2 p-6 text-center"
    >
      <p class="text-sm font-semibold text-foreground">
        {props.agencyName} schematic isn&apos;t available yet
      </p>
      <p class="max-w-72 text-xs text-muted-foreground">
        Service status is still available in the panels below.
      </p>
    </div>
  );
}

export function StationFocusTrigger(props: { onFocus: () => boolean | void }) {
  let disposed = false;
  let retryFrame: number | undefined;

  onSettled(() => {
    // Snapshot the focus callback before the queued callback leaves Solid's
    // render owner; the keyed focus owner can also be replaced before this
    // microtask runs, so cancel stale callbacks on disposal.
    const onFocus = props.onFocus;
    const attemptFocus = () => {
      retryFrame = undefined;
      if (disposed) return;

      if (onFocus() === false) {
        retryFrame = requestAnimationFrame(attemptFocus);
      }
    };

    queueMicrotask(() => {
      attemptFocus();
    });

    return () => {
      disposed = true;
      if (retryFrame !== undefined) cancelAnimationFrame(retryFrame);
    };
  });

  return null;
}

/**
 * Agency-agnostic schematic renderer. Everything agency-shaped, line
 * ids, station names, colors, badges, camera framing, arrives through the
 * provider's declared `Schematic`; this file contains no transit literals.
 */
export function NetworkMap(props: NetworkMapProps) {
  const [interchangeFocus, setInterchangeFocus] = createSignal<InterchangeFocus>();
  const activeProvider = createMemo(() => props.provider);
  const rendererCache =
    props.topologyCache ?? createTopologyCache({ allProviders, maxEntries: MAX_WARMED_SCHEMATICS });

  const activeId = () => activeProvider().manifest.id;
  // NetworkMap's existing public seam requires both contexts. Validate the
  // nearby context before the preference-aware warm-up so its error remains
  // the first failure when the map is rendered outside the app shell.
  useNearbyCoordination();
  const userPrefs = useUserPreferences();
  const focusInterchange = createInterchangeNavigation({
    setFocus: setInterchangeFocus,
    setTemporaryAgency: props.onTemporaryAgencyView,
  });

  // Warm only pure topology during idle time. Mounting inactive canvases here
  // looks like a fast switch, but it creates a second full interactive SVG
  // immediately after first paint and blocks input while Solid reconciles it.
  // A switch still gets the cached D1-derived topology without paying that
  // initial DOM cost.
  onSettled(() => {
    let disposed = false;
    let idleId: number | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const warmedTopologyIds = new Set([activeId()]);

    const scheduleNext = (delayMs = 0): void => {
      if (disposed || warmedTopologyIds.size >= MAX_WARMED_SCHEMATICS) return;

      const warmNext = () => {
        if (disposed) return;
        const candidateId = rendererCache
          .warmProviderIds(activeId(), userPrefs.preferences.favouriteAgencies)
          .find((id) => !warmedTopologyIds.has(id));
        const candidate = allProviders().find(
          (provider) => provider.manifest.id === candidateId && provider.light,
        );
        if (!candidate) return;
        warmedTopologyIds.add(candidate.manifest.id);
        // Warming also pulls the candidate's lazy schematic chunk, which
        // keeps favourite agencies available offline once visited.
        void rendererCache
          .ensureTopology(candidate)
          .catch(() => undefined)
          .then(() => {
            if (!disposed) timer = setTimeout(() => scheduleNext(0), 1000);
          });
      };

      if (delayMs > 0) {
        timer = setTimeout(() => scheduleNext(0), delayMs);
      } else if (typeof window !== "undefined" && "requestIdleCallback" in window) {
        idleId = window.requestIdleCallback(warmNext, { timeout: 1500 });
      } else {
        timer = setTimeout(warmNext, 250);
      }
    };

    scheduleNext();

    return () => {
      disposed = true;
      if (timer !== undefined) clearTimeout(timer);
      if (idleId !== undefined) window.cancelIdleCallback(idleId);
    };
  });

  const providersById = new Map<string, BrowserAgency>();
  const stableProvider = (provider: BrowserAgency): BrowserAgency => {
    const existing = providersById.get(provider.manifest.id);
    if (existing) return existing;
    providersById.set(provider.manifest.id, provider);
    return provider;
  };
  // The full geometry is lazy: `light` says the agency draws a map, and the
  // canvas mounts once its schematic (or a caller-supplied topology) is ready.
  const activeSchematic = useAgencySchematic(activeId);
  const renderProviders = createMemo(() => {
    const provider = activeProvider();
    return provider.light && (props.topology || activeSchematic())
      ? [stableProvider(provider)]
      : [];
  });

  return (
    <Show
      when={activeProvider().light}
      fallback={<SchematicFallbackCard agencyName={activeProvider().manifest.name} />}
    >
      <div
        class="relative h-full w-full"
        aria-busy={renderProviders().length === 0 ? "true" : "false"}
      >
        <For each={renderProviders()}>
          {(provider) => {
            const isActive = () => provider.manifest.id === activeId();
            return (
              <div
                class={cn(
                  "absolute inset-0",
                  isActive() ? "visible" : "invisible pointer-events-none",
                )}
                aria-hidden={!isActive() ? "true" : "false"}
              >
                <SchematicCanvas
                  provider={provider}
                  topology={props.topology ?? rendererCache.topologyFor(provider)}
                  topologyCache={rendererCache}
                  projection={() => (isActive() ? props.projection : EMPTY_MAP_PROJECTION)}
                  alerts={() => (isActive() ? props.alerts : undefined)}
                  tracking={() => (isActive() ? props.tracking : undefined)}
                  onClearTargetedRoute={props.onClearTargetedRoute}
                  onEnlargeRoute={props.onEnlargeRoute}
                  onTemporaryAgencyView={props.onTemporaryAgencyView}
                  interchangeBadgeVisibility={props.interchangeBadgeVisibility}
                  interchangeFocus={() => {
                    const focus = interchangeFocus();
                    return focus?.agencyId === provider.manifest.id ? focus : undefined;
                  }}
                  onInterchangeSelect={focusInterchange}
                  onInterchangeFocusHandled={() => setInterchangeFocus(undefined)}
                  active={isActive}
                />
              </div>
            );
          }}
        </For>
      </div>
    </Show>
  );
}

interface SchematicCanvasProps extends Omit<
  NetworkMapProps,
  "topology" | "projection" | "alerts" | "tracking"
> {
  readonly topology: MapModel;
  readonly topologyCache: TopologyCache;
  readonly projection: () => MapProjection;
  readonly alerts: () => StationAlerts | undefined;
  readonly tracking: () => TargetedRouteTracking | undefined;
  readonly interchangeBadgeVisibility: () => InterchangeBadgeVisibility;
  readonly active: () => boolean;
  readonly interchangeFocus: () => InterchangeFocus | undefined;
  readonly onInterchangeSelect: (focus: InterchangeFocus) => void;
  readonly onInterchangeFocusHandled: () => void;
}

const EMPTY_MAP_PROJECTION: MapProjection = {
  statusOverlaySegments: [],
  stationSeverities: new Map(),
  stationAccessibilityOutages: new Set(),
};

function TargetedRouteControls(props: {
  readonly tracking: TargetedRouteTracking;
  readonly provider: BrowserAgency;
  readonly onClearRoute: () => void;
  readonly onSelectDirection: (directionId: number) => void;
  readonly prefersReducedMotion: boolean;
}) {
  const data = () => props.tracking.data();
  const activeDirVehicles = () => {
    const d = data();
    return d ? d.vehicles.filter((v) => v.directionId === d.shape.directionId) : [];
  };

  return (
    <RouteControls
      tracking={props.tracking}
      routeId={data()?.route.id ?? props.tracking.selectedRouteId?.() ?? ""}
      routeShortName={data()?.route.shortName ?? props.tracking.selectedRouteId?.() ?? ""}
      routeLongName={data()?.route.longName ?? ""}
      routeType={data()?.route.routeType ?? "bus"}
      routeColor={data()?.route.color ?? DEFAULT_SURFACE_ROUTE_COLOR}
      agencyId={props.provider.manifest.id}
      onClearRoute={props.onClearRoute}
      onSelectDirection={props.onSelectDirection}
      activeVehicleCount={activeDirVehicles().length}
      vehiclePositionsOnly={data()?.vehiclePositionsOnly}
      vehiclePositionsFreshness={data()?.vehiclePositionsFreshness}
      alerts={data()?.alerts ?? []}
      headsign={data()?.shape.headsign}
      directionLabels={data()?.directionLabels}
      availableDirectionIds={
        data()?.availableDirectionIds ?? [props.tracking.selectedDirectionId?.() ?? 0]
      }
      prefersReducedMotion={props.prefersReducedMotion}
    />
  );
}

function SchematicCanvas(props: SchematicCanvasProps) {
  const { t, locale } = useI18n();
  const agencyName = () => props.provider.manifest.name;

  // The route owns the pure topology cache. NetworkMap adds rendered views
  // only after idle, so the active canvas remains the hydration-critical path.
  const topology = untrack(() => props.topology);
  const { stationList, stationsById, lineList, linesById, badgeList } = topology;
  const focusStation = () => {
    const focus = props.interchangeFocus();
    return focus ? stationsById.get(focus.stationId) : undefined;
  };
  const interchangeRequests = createMemo(() =>
    normalizeInterchangeBadgeRequests(
      props.provider.manifest.id,
      interchanges,
      projectInterchangeBadgeAgencies(allProviders()),
    ),
  );
  const walkingInterchangeMarkers = createMemo(() =>
    placeWalkingInterchangeMarkers(topology, interchangeRequests()),
  );
  const [peerSchematicVersion, setPeerSchematicVersion] = createSignal(0);
  const walkingStations = createMemo(() => {
    peerSchematicVersion();
    return walkingInterchangeMarkers().flatMap((marker) => {
      const provider = allProviders().find(
        (candidate) => candidate.manifest.id === marker.targetAgencyId,
      );
      if (!provider?.light) return [];
      // Peer geometry loads in the background (idempotent request); the
      // markers appear once it arrives and bumps the version above.
      if (!peekSchematic(provider.manifest.id)) {
        void props.topologyCache.ensureTopology(provider).then(
          () => setPeerSchematicVersion((version) => version + 1),
          () => undefined,
        );
        return [];
      }
      const peerTopology = props.topologyCache.topologyFor(provider);
      const station = peerTopology.stationsById.get(marker.targetStationId);
      if (!station) return [];
      return [
        {
          selectionId: JSON.stringify([
            marker.hubId,
            marker.targetAgencyId,
            marker.targetStationId,
          ]),
          marker,
          provider,
          station: {
            ...station,
            x: marker.x,
            y: marker.y,
            ...walkingStationLabel(marker),
          },
          linesById: peerTopology.linesById,
        },
      ];
    });
  });
  const interchangeBadgeRows = createMemo(() =>
    groupInterchangeBadges(
      placeInterchangeBadges(topology, interchangeRequests(), props.interchangeBadgeVisibility()),
    ),
  );

  const nearbyCoordination = useNearbyCoordination();
  const userPrefs = useUserPreferences();

  const [containerElement, setContainerElement] = createSignal<HTMLDivElement>();

  /**
   * Drawn line for a tracked rail route. Surface routes retain their detailed
   * geographic corridor for both framing and foreground nodes.
   *
   * Agencies that fold a branch id onto one drawn line declare the fold in
   * their manifest, and it is folded here through the same translation the
   * realtime source already applies to that route id, so an agency cannot
   * alert on one line and render on another. The drawn-line check is what keeps
   * a route the schematic does not draw on the plain affine projection instead
   * of correcting it onto whichever line happens to be nearby.
   */
  const activeLineId = createMemo<string | undefined>(() => {
    const route = props.tracking()?.data()?.route;
    if (!route || (route.routeType !== "rail" && route.routeType !== "subway")) return undefined;
    const routeId = route.id;
    const { routeLineMap } = props.provider.manifest.alertInterpretation ?? {};
    const folded = translateRawRouteId(routeId, routeLineMap);
    const drawnLineIdByKey = new Map(
      [...topology.linesById.keys()].map((id) => [snapLineKey(id), id] as const),
    );
    return [folded, routeId]
      .map((id) => drawnLineIdByKey.get(snapLineKey(id)))
      .find((id): id is string => id !== undefined);
  });

  const viewport = createMapViewport(containerElement, {
    ...topology,
    fitTransform: topology.camera.computeFitTransform,
    geometry: topology.geometry,
    getFraming: (bounds, size) => topology.camera.computeTargetViewport(bounds, size, 0.9),
    activeLineId,
    prefersReducedMotion: userPrefs.isEffectiveReducedMotion,
  });

  onSettled(() => {
    // One-shot subscription: onSettled is not a tracking scope, so snapshot
    // the handle without subscribing.
    const unsubscribe = untrack(() => props.tracking())?.onDataArrival((data) => {
      // Fresh one-shot check per arrival, not a subscription: the listener is
      // registered once, so read active status without tracking.
      if (untrack(() => props.active())) {
        viewport.frameRoute(data.shape, data.stops);
      }
    });
    return () => unsubscribe?.();
  });

  // Single camera value: every popover coordinate transform below
  // reads this derived camera instead of rebuilding {width,height,zoom,pan}.
  const camera = (): MapCamera => ({
    width: viewport.containerSize().width,
    height: viewport.containerSize().height,
    zoom: viewport.zoom(),
    pan: viewport.pan(),
  });

  const getPopoverCoords = (mapPoint: Point) => {
    const size = viewport.containerSize();
    if (!size.width || !size.height) return null;
    return (
      topology.camera.transformMapPointToContainer(mapPoint, {
        ...camera(),
        width: size.width,
        height: size.height,
      }) ?? null
    );
  };

  const selection = createSelectionController({
    hasMovedDistance: viewport.hasMovedDistance,
    camera,
    transformContainerPointToMap: topology.camera.transformContainerPointToMap,
    containerRect: () => {
      const element = containerElement();
      return element ? element.getBoundingClientRect() : null;
    },
  });

  const isTargetedMode = () => {
    const tracking = props.tracking();
    return Boolean(tracking?.selectedRouteId?.() ?? tracking?.data());
  };

  /** Only a direction-matched snapshot may paint the targeted route layer. */
  const activeTargetedData = () => {
    if (!props.active()) return undefined;

    const tracking = props.tracking();
    const data = tracking?.data();
    return data && !tracking?.isStaleForDirection() ? data : undefined;
  };

  const handleClearRoute = () => {
    selection.clearSurfaceSelection();
    props.onClearTargetedRoute?.();
    viewport.exitTargetedMode();
  };

  const handleEnlargeRoute = (request: RouteEnlargeRequest) => {
    viewport.enterTargetedMode();
    props.onEnlargeRoute?.(request);
  };

  const {
    selectedStationId,
    selectedSegmentId,
    hoveredLineId,
    setPopoverElement,
    registerStationElement,
    forgetStationElements,
    selectStation,
    toggleStation,
    toggleSegment,
    toggleLine,
    hoverLine,
    selectVehicle,
    selectStop,
    clearSelection,
  } = selection;

  const selectedStation = createMemo(() => {
    const stationId = selectedStationId();

    if (!stationId) {
      return undefined;
    }

    const station = stationsById.get(stationId);

    if (station) return { name: station.name, station, provider: props.provider, linesById };
    const peer = walkingStations().find((candidate) => candidate.selectionId === stationId);
    return peer
      ? {
          name: peer.station.name,
          station: peer.station,
          provider: peer.provider,
          linesById: peer.linesById,
        }
      : undefined;
  });

  // Peer cards reuse the agency-scoped snapshot cache. Merely drawing a
  // walking node must not start another agency's polling subscription.
  const peerAlerts = useAgencySnapshot(
    () => {
      const selected = selectedStation();
      return selected?.provider.manifest.id !== props.provider.manifest.id &&
        selected?.provider.hasLiveAlerts
        ? selected.provider.manifest.id
        : undefined;
    },
    15_000,
    props.active,
    () => userPrefs.preferences.locale,
  );
  const peerProjection = createMemo(() => {
    const selected = selectedStation();
    const snapshot = peerAlerts.snapshot();
    return selected && snapshot
      ? deriveMapProjection(snapshot, props.topologyCache.topologyFor(selected.provider))
      : undefined;
  });

  const activeStatusSegments = () => props.projection().statusOverlaySegments;

  const sortedStatusSegments = createMemo(() =>
    renderableSegments(props.projection(), {
      showReducedSpeedZones: userPrefs.preferences.showReducedSpeedZones,
    }),
  );

  // Drive one pulse value per alert kind, while StatusSegmentPath applies that
  // value to each segment group. This keeps overlapping segments composited
  // independently while paying for one animation per alert kind.
  const statusSegmentLayers = createMemo(() => {
    const layers: Array<{
      kind: StatusOverlaySegment["kind"];
      segments: StatusOverlaySegment[];
    }> = [];

    for (const segment of sortedStatusSegments()) {
      const previous = layers.at(-1);
      if (previous?.kind === segment.kind) {
        previous.segments.push(segment);
      } else {
        layers.push({ kind: segment.kind, segments: [segment] });
      }
    }

    return layers;
  });

  const sortedBadgeList = createMemo(() =>
    selectBadgeOrder(
      badgeList,
      favouriteLineIdsForAgency(userPrefs.preferences, props.provider.manifest.id),
    ),
  );

  const selectedSegment = createMemo(() => {
    const id = selectedSegmentId();

    if (!id) {
      return undefined;
    }

    return activeStatusSegments().find((segment) => segment.id === id);
  });

  const activeStationCoords = createMemo(() => {
    const selected = selectedStation();

    if (!selected) {
      return undefined;
    }

    // Offset to top edge of station node (interchange pill vs circular node)
    const nodeTopOffset = selected.station.isInterchange ? 10 : 7;

    return getPopoverCoords({
      x: selected.station.x,
      y: selected.station.y - nodeTopOffset,
    });
  });

  const activeSegmentCoords = createMemo(() => {
    const selected = selectedSegment();

    if (!selected) {
      return undefined;
    }

    const anchorMapPoint = selection.segmentClickMapPoint() || selected.midpoint;

    return getPopoverCoords(anchorMapPoint) ?? undefined;
  });

  // Hover warms the departures cache without subscribing; opening the
  // popover below subscribes through one section per serving agency.
  const handleHoverStation = (stationId: string) => {
    if (!props.provider.manifest.stationService) return;
    void prefetchStationDepartures(props.provider.manifest.id, stationId, locale());
  };

  const agencyShortName = (agencyId: string): string =>
    allProviders().find((provider) => provider.manifest.id === agencyId)?.manifest.shortName ??
    agencyId.toUpperCase();

  const hasDeparturesSource = (agencyId: string): boolean =>
    Boolean(
      allProviders().find((provider) => provider.manifest.id === agencyId)?.manifest.stationService,
    );

  // Hub siblings supply their own pairs: linked ids can differ entirely
  // across agencies, so each section fetches under its own identity with the
  // current agency first. Agencies without a stations source are skipped, and
  // the popover keeps its previous shape when there is nothing to show.
  // Section headers name the full station (hub siblings can carry different
  // names per agency), suffixed with the agency short name when several
  // agencies share the popover.
  const departureSections = createMemo(() => {
    const selected = selectedStation();
    if (!selected?.provider.manifest.stationService) return [];
    const endpoints = resolveStationEndpoints(
      selected.provider.manifest.id,
      selected.station.id,
      interchanges,
      hasDeparturesSource,
    );
    return endpoints.map((endpoint) => ({
      ...endpoint,
      header:
        endpoints.length > 1
          ? `${endpoint.stationName ?? selected.name} · ${agencyShortName(endpoint.agencyId)}`
          : undefined,
    }));
  });

  onSettled(() => () => {
    forgetStationElements();
  });

  return (
    <div
      ref={setContainerElement}
      role="group"
      aria-label={t("{{name}} network map", { name: agencyName() })}
      class={cn(
        "relative h-full w-full select-none overflow-hidden bg-background bg-drafting-grid",
        "touch-none cursor-grab active:cursor-grabbing",
        "contain-layout",
      )}
    >
      <svg
        class={cn("h-full w-full touch-none")}
        viewBox={`0 0 ${topology.viewBoxWidth} ${topology.viewBoxHeight}`}
        role="img"
        aria-label={t("{{name}} network map", { name: agencyName() })}
        aria-describedby="network-map-description"
        onPointerDown={viewport.pointerHandlers.onPointerDown}
        onPointerMove={viewport.pointerHandlers.onPointerMove}
        onPointerUp={viewport.pointerHandlers.onPointerUp}
        onPointerCancel={viewport.pointerHandlers.onPointerCancel}
        onDblClick={viewport.pointerHandlers.onDblClick}
        onClick={(event) => {
          if (viewport.hasMovedDistance()) {
            return;
          }

          if (selection.selectedSurfaceVehicle() || selection.selectedSurfaceStop()) {
            selection.clearSurfaceSelection();
            return;
          }

          if (isTargetedMode()) {
            handleClearRoute();
            return;
          }

          const target = event.target as Element;
          if (target === event.currentTarget || target.hasAttribute?.("data-map-bg")) {
            clearSelection();
          }
        }}
      >
        <desc id="network-map-description">
          {t(
            "Interactive map of {{agency}} lines and stations. Drag to pan, pinch or scroll to zoom, and select stations or service disruptions for details.",
            { agency: agencyName() },
          )}
        </desc>

        {/* Transparent background rect for reliable background click detection */}
        <rect
          x="0"
          y="0"
          width={topology.viewBoxWidth}
          height={topology.viewBoxHeight}
          fill="transparent"
          pointer-events="all"
          data-map-bg="true"
        />

        <g transform={viewport.transform()}>
          {/* Background Subway Network (Dimmed to 20% opacity in targeted route mode) */}
          <g
            class={cn(
              "subway-network-base transition-opacity duration-300",
              isTargetedMode() ? "opacity-20 pointer-events-none" : "opacity-100",
            )}
          >
            <For each={lineList}>
              {(line) => (
                <LinePath line={line} hoveredLineId={hoveredLineId} onToggle={toggleLine} />
              )}
            </For>

            <For each={statusSegmentLayers()}>
              {(layer) => (
                <g
                  class={cn(
                    layer.kind === "severe" && "animate-pulse-severe motion-reduce:animate-none",
                    layer.kind === "delay" && "animate-pulse-delay motion-reduce:animate-none",
                  )}
                >
                  <For each={layer.segments}>
                    {(segment) => (
                      <StatusSegmentPath
                        segment={segment}
                        isSelected={() => selectedSegmentId() === segment.id}
                        hoveredLineId={hoveredLineId}
                        onToggle={toggleSegment}
                      />
                    )}
                  </For>
                </g>
              )}
            </For>

            <For each={sortedBadgeList()}>
              {(badge) => (
                <LineBadgeMarker
                  badge={badge}
                  hoveredLineId={hoveredLineId}
                  onToggle={toggleLine}
                  onHover={hoverLine}
                />
              )}
            </For>

            <For each={interchangeBadgeRows()}>
              {(badges) => (
                <InterchangeBadgeMarker
                  badges={badges}
                  onSelect={(badge) => {
                    const activeStation = stationsById.get(badges[0]?.activeStationId ?? "");
                    const screenPosition = activeStation
                      ? getPopoverCoords({ x: activeStation.x, y: activeStation.y })
                      : null;

                    props.onInterchangeSelect({
                      agencyId: badge.targetAgencyId,
                      stationId: badge.targetStationId,
                      stationName: badge.targetStationName,
                      origin: {
                        agencyId: props.provider.manifest.id,
                        stationId: badge.activeStationId,
                      },
                      screenScale: viewport.screenScale(),
                      screenPosition: screenPosition ?? undefined,
                    });
                  }}
                />
              )}
            </For>

            <For each={walkingStations()}>
              {(peer) => (
                <WalkingInterchangeMarker
                  marker={peer.marker}
                  station={peer.station}
                  isSelected={() => selectedStationId() === peer.selectionId}
                  registerElement={(_, element) =>
                    registerStationElement(peer.selectionId, element)
                  }
                  onSelect={() => toggleStation(peer.selectionId)}
                  status={() =>
                    peerAlerts.snapshot()?.agencyId === peer.provider.manifest.id &&
                    peerAlerts.freshness().state !== "unavailable"
                      ? (peerProjection()?.stationSeverities.get(peer.station.id) ??
                        (peerAlerts.freshness().state === "stale" ? "unavailable" : "normal"))
                      : "unavailable"
                  }
                  accessibilityOutage={() =>
                    peerAlerts.snapshot()?.agencyId === peer.provider.manifest.id &&
                    Boolean(peerProjection()?.stationAccessibilityOutages.has(peer.station.id))
                  }
                />
              )}
            </For>

            {/* Isolate each station binding so the parent does not track every marker. */}
            <For each={stationList}>
              {(station) => (
                <g>
                  <StationMarker
                    station={station}
                    status={() => props.projection().stationSeverities?.get(station.id) || "normal"}
                    accessibilityOutage={() =>
                      props.projection().stationAccessibilityOutages?.has(station.id) || false
                    }
                    isSelected={() => selectedStationId() === station.id}
                    onToggle={toggleStation}
                    onHoverStation={handleHoverStation}
                    registerElement={registerStationElement}
                  />
                </g>
              )}
            </For>

            <Show when={focusStation()} keyed>
              {(station) => {
                // Snapshot dynamic props before the queued callback leaves
                // Solid's owner context; the trigger also cancels the callback
                // if this keyed station is replaced before it runs.
                const focus = props.interchangeFocus();
                const onInterchangeFocusHandled = props.onInterchangeFocusHandled;
                return (
                  <StationFocusTrigger
                    onFocus={() => {
                      if (!viewport.isReady()) return false;

                      const requestedZoom =
                        focus?.screenScale === undefined
                          ? undefined
                          : viewport.zoomForScreenScale(focus.screenScale);

                      const focused = focus?.screenPosition
                        ? viewport.placePointAtContainerPoint(
                            { x: station.x, y: station.y },
                            focus.screenPosition,
                            requestedZoom,
                          )
                        : true;

                      if (!focused) return false;

                      if (!focus?.screenPosition) {
                        viewport.centerOnPoint({ x: station.x, y: station.y }, requestedZoom);
                      }
                      onInterchangeFocusHandled();
                      return true;
                    }}
                  />
                );
              }}
            </Show>
          </g>

          {/* Prominent Targeted Route Layer, non-keyed: the overlay mounts
              once per targeted-mode session and PATCHES per data renewal
              (keyed remounts here were the 100ms+ direction-switch jank). */}
          <Show when={activeTargetedData()}>
            <TargetedRouteOverlay
              geometry={topology.geometry}
              activeLineId={activeLineId()}
              tracking={props.tracking()}
              trackingData={activeTargetedData()!}
              interchangeStations={stationList}
              stationIndex={peekSchematic(props.provider.manifest.id)?.stationIndex}
              onSelectStation={selectStation}
              prefersReducedMotion={userPrefs.isEffectiveReducedMotion()}
              onSelectVehicle={selectVehicle}
              selectedVehicleId={selection.selectedVehicleId()}
              onSelectStop={selectStop}
              selectedStopId={selection.selectedStopId()}
            />
          </Show>
        </g>
      </svg>

      {/* Top Direction Switcher and dismissal controls in targeted route mode.
          Extracted component, not a Show function child: a Show child body
          is an owner, not a tracking scope, so reads there evaluate once and
          go stale, while memos and JSX reads inside the component stay live. */}
      <Show when={props.active() && isTargetedMode()}>
        <TargetedRouteControls
          tracking={props.tracking()!}
          provider={props.provider}
          onClearRoute={handleClearRoute}
          onSelectDirection={(directionId) => {
            selection.clearSurfaceSelection();
            props.tracking()?.selectDirection(directionId);
          }}
          prefersReducedMotion={userPrefs.isEffectiveReducedMotion()}
        />
      </Show>

      <Show when={props.active()}>
        <Show when={isDevServer()}>
          <Loading>
            <SpoofDrawer />
          </Loading>
        </Show>

        <MapControls
          onZoomIn={() => viewport.zoomFromCenter(1.2)}
          onZoomOut={() => viewport.zoomFromCenter(0.8)}
          onRecenter={() => {
            const tracking = props.tracking();
            const data = tracking?.data();
            if (data && !tracking?.isStaleForDirection()) {
              viewport.frameRoute(data.shape, data.stops);
            } else if (!data) {
              viewport.resetViewport();
            }
          }}
          onEnlargeRoute={handleEnlargeRoute}
        />
      </Show>

      {/* Popovers stand down while the nearby panel is open */}
      <Show when={props.active() && !nearbyCoordination.nearbyOpen()}>
        <Loading>
          {/* Vehicle details popover clamped to container viewport */}
          <Show when={selection.selectedSurfaceVehicle()}>
            {(item) => (
              <VehicleDetailsPopover
                vehicle={item().vehicle}
                routeShortName={props.tracking()?.data()?.route.shortName ?? ""}
                routeType={props.tracking()?.data()?.route.routeType ?? "bus"}
                coords={getPopoverCoords(item().point)}
                containerSize={viewport.containerSize()}
                onClose={selection.clearSurfaceSelection}
                setRef={setPopoverElement}
              />
            )}
          </Show>

          {/* Stop details popover clamped to container viewport */}
          <Show when={selection.selectedSurfaceStop()}>
            {(item) => (
              <StopDetailsPopover
                stop={item().stop}
                isNearest={
                  props.tracking()?.nearestStopId() != null &&
                  item().stop.id === props.tracking()?.nearestStopId()
                }
                coords={getPopoverCoords(item().point)}
                containerSize={viewport.containerSize()}
                onClose={selection.clearSurfaceSelection}
                setRef={setPopoverElement}
              />
            )}
          </Show>

          {/* Keyed remount resets the station popover's scroll and disclosure
              state when moving from a dense hub such as Union to another
              station. Reusing the scrolled content can hide new rows behind
              the fixed header. */}
          <Show when={selectedStation()} keyed>
            {(selected) => (
              <StationPopover
                agencyId={selected.provider.manifest.id}
                name={selected.name}
                station={selected.station}
                coords={activeStationCoords() || null}
                containerSize={viewport.containerSize()}
                alerts={
                  selected.provider.manifest.id === props.provider.manifest.id
                    ? props.alerts()
                    : peerAlerts.snapshot()?.alerts
                }
                alertsAvailable={
                  selected.provider.manifest.id === props.provider.manifest.id
                    ? props.provider.hasLiveAlerts
                    : selected.provider.hasLiveAlerts &&
                      peerAlerts.freshness().state !== "unavailable"
                }
                alertsFreshness={
                  selected.provider.manifest.id === props.provider.manifest.id
                    ? undefined
                    : peerAlerts.freshness().state
                }
                hoveredLineId={
                  selected.provider.manifest.id === props.provider.manifest.id
                    ? hoveredLineId
                    : undefined
                }
                onHoverLine={
                  selected.provider.manifest.id === props.provider.manifest.id
                    ? hoverLine
                    : undefined
                }
                onToggleLine={
                  selected.provider.manifest.id === props.provider.manifest.id
                    ? toggleLine
                    : undefined
                }
                onClose={clearSelection}
                setRef={setPopoverElement}
                linesById={selected.linesById}
                departureSections={departureSections()}
              />
            )}
          </Show>

          <Show when={selectedSegment()}>
            {(selected) => (
              <SegmentPopover
                segment={selected()}
                coords={activeSegmentCoords()}
                containerSize={viewport.containerSize()}
                onClose={clearSelection}
                setRef={setPopoverElement}
              />
            )}
          </Show>
        </Loading>
      </Show>
    </div>
  );
}
