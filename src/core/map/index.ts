import { sequenceBetween } from "~/domain/map/stationSequence";
import {
  buildSmoothPathD,
  createMapGeometry,
  polylineSpanPoints,
  type SnapAttribution,
} from "~/domain/map/MapGeometry";
import { createMapCamera } from "~/domain/map/MapCamera";
import type {
  AgencyAlertTarget,
  AgencyStationReference,
  AlertScope,
  SchematicStationId,
} from "~/agencies/types";
import type {
  InterchangeEndpoint,
  InterchangeHub,
  WalkingInterchangeMarker,
} from "~/domain/map/Interchange";
import type { InterchangeBadgeVisibility } from "~/domain/preferences/UserPreferences";
import { SEVERITY_RANK } from "~/domain/severity";
import { alertStationReferences, alertStationRouteImpact } from "~/domain/stationAlerts";

export {
  anchorKey,
  buildRouteSvgPathD,
  deriveSnapDistanceRatio,
  distancePointToPolyline,
  snapLineKey,
  MAX_SNAP_DISTANCE_RATIO,
  SNAP_HEADROOM,
} from "~/domain/map/MapGeometry";
export type { SnapAttribution, StylisedStationGeometry } from "~/domain/map/MapGeometry";
export { clamp } from "~/domain/map/MapCamera";

export type StatusSegmentKind = "severe" | "delay" | "rsz" | "upcoming";

export interface StationInfo {
  readonly id: SchematicStationId;
  readonly name: string;
  readonly x: number;
  readonly y: number;
  readonly lines: string[];
  readonly accessible?: boolean;
  readonly isInterchange: boolean;
  readonly isTerminal: boolean;
  readonly labelLeader?: boolean;
  readonly labelX: number;
  readonly labelY: number;
  readonly labelRotation: number;
  readonly labelAnchor: "start" | "middle" | "end" | "inherit";
  readonly status?: "normal" | "degraded" | "severe";
  readonly accessibilityOutage?: boolean;
}

export interface LineInfo {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly pathD: string;
}

export interface BadgeInfo {
  readonly line: string;
  readonly num: string;
  readonly x: number;
  readonly y: number;
  readonly color: string;
  readonly textColor: string;
}

export type InterchangeBadgeMode = "bus" | "rail";

export interface InterchangeBadgeInfo {
  readonly hubId: string;
  readonly activeStationId: SchematicStationId;
  readonly activeStationName: string;
  readonly targetAgencyId: string;
  readonly targetAgencyName: string;
  readonly targetStationId: SchematicStationId;
  readonly targetStationName: string;
  readonly agencyLabel: string;
  readonly mode?: InterchangeBadgeMode;
  readonly color: string;
  readonly x: number;
  readonly y: number;
  readonly layout?: "horizontal" | "vertical";
}

export interface PositionedInterchangeBadge extends InterchangeBadgeInfo {
  readonly width: number;
  readonly height: number;
  readonly rectY: number;
  readonly cornerRadius: number;
  readonly transformOrigin: string;
  readonly xOffsetFromCenter: number;
  readonly yOffsetFromCenter: number;
  readonly rowTotalWidth: number;
  readonly rowTotalHeight?: number;
  readonly textX: number;
  readonly hasIcon: boolean;
  readonly isCompact: boolean;
}

export interface StatusOverlaySegment {
  readonly id: string;
  readonly kind: StatusSegmentKind;
  readonly lineId: string;
  readonly lineName: string;
  readonly lineColor: string;
  readonly fromStation: string;
  readonly toStation: string;
  readonly note: string;
  readonly pathD: string;
  readonly midpoint: Point;
}

/** Provider-neutral schematic input owned by Core Map. */
export interface MapCornerInsertion {
  readonly lineId: string;
  readonly stationId: SchematicStationId;
  readonly before: Point;
  readonly after: Point;
}

export interface MapSchematic {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly lines: readonly {
    readonly id: string;
    readonly name: string;
    readonly color: string;
    readonly points: readonly Point[];
  }[];
  readonly stations: readonly {
    readonly id: SchematicStationId;
    readonly name: string;
    readonly x: number;
    readonly y: number;
    readonly lines: readonly string[];
    readonly accessible?: boolean;
    readonly terminal?: boolean;
    readonly label?: {
      readonly leader?: boolean;
      readonly x: number;
      readonly y: number;
      readonly rot?: number;
      readonly anchor?: "start" | "middle" | "end" | "inherit";
    };
  }[];
  readonly badges?: readonly BadgeInfo[];
  readonly viewport: {
    readonly bounds: Omit<MapBoundingBox, "width" | "height" | "centerX" | "centerY">;
    readonly minZoom: number;
    readonly maxZoom: number;
  };
  readonly geoProjection: {
    readonly refLonWest: number;
    readonly refLonEast: number;
    readonly refXWest: number;
    readonly refXEast: number;
    readonly refLatNorth: number;
    readonly refLatSouth: number;
    readonly refYNorth: number;
    readonly refYSouth: number;
  };
  readonly sequences?: Readonly<Record<string, readonly SchematicStationId[]>>;
  readonly branchSequences?: Readonly<Record<string, readonly (readonly SchematicStationId[])[]>>;
  readonly cornerInsertions?: readonly MapCornerInsertion[];
  /**
   * Drawn station anchors with their true WGS84 positions. Optional and
   * already-declared by every Schematic that seeds one; the geometry engine
   * reads it to size its own snap cutoff from this schematic's drawn geometry
   * rather than assuming a constant.
   */
  readonly stationIndex?: readonly {
    readonly id: string;
    readonly schematicId?: SchematicStationId;
    readonly lat: number;
    readonly lon: number;
  }[];
}

/** Normalized alert fields consumed by map projection. */
export interface MapAlert {
  readonly id: string;
  readonly kind: string;
  readonly severity: "normal" | "degraded" | "severe";
  readonly lifecycle: "upcoming" | "active" | "expired";
  readonly scope: AlertScope;
  readonly affectedLineIds?: readonly string[];
  readonly affectedRouteIds?: readonly string[];
  readonly targets?: readonly AgencyAlertTarget[];
  readonly affectedStations?: readonly AgencyStationReference[];
  readonly fromStation?: AgencyStationReference;
  readonly toStation?: AgencyStationReference;
  readonly title: string;
  readonly description?: string;
  readonly startsAt?: number;
  readonly endsAt?: number;
  readonly updatedAt?: number;
}

export interface MapSnapshot {
  readonly alerts: readonly MapAlert[];
  readonly agencyId?: string;
  readonly generatedAt?: number;
  readonly freshness?: "live" | "recent" | "stale" | "unavailable";
}

export interface MapProjection {
  readonly statusOverlaySegments: readonly StatusOverlaySegment[];
  readonly stationSeverities: ReadonlyMap<SchematicStationId, "normal" | "degraded" | "severe">;
  readonly stationAccessibilityOutages: ReadonlySet<SchematicStationId>;
}

/**
 * Compares the parts of a projection consumed by the SVG map. Alert IDs alone
 * are not sufficient: an operator can update the same alert with narrower
 * endpoints or a different station set.
 */
export function areMapProjectionsEqual(
  previous: MapProjection | undefined,
  next: MapProjection | undefined,
): boolean {
  if (!previous || !next) return false;
  if (previous.statusOverlaySegments.length !== next.statusOverlaySegments.length) return false;
  if (previous.stationSeverities.size !== next.stationSeverities.size) return false;
  if (previous.stationAccessibilityOutages.size !== next.stationAccessibilityOutages.size)
    return false;

  for (let index = 0; index < previous.statusOverlaySegments.length; index++) {
    const first = previous.statusOverlaySegments[index];
    const second = next.statusOverlaySegments[index];
    if (
      !first ||
      !second ||
      first.id !== second.id ||
      first.kind !== second.kind ||
      first.lineId !== second.lineId ||
      first.lineName !== second.lineName ||
      first.lineColor !== second.lineColor ||
      first.fromStation !== second.fromStation ||
      first.toStation !== second.toStation ||
      first.note !== second.note ||
      first.pathD !== second.pathD ||
      first.midpoint.x !== second.midpoint.x ||
      first.midpoint.y !== second.midpoint.y
    ) {
      return false;
    }
  }

  for (const [station, severity] of previous.stationSeverities) {
    if (next.stationSeverities.get(station) !== severity) return false;
  }
  for (const station of previous.stationAccessibilityOutages) {
    if (!next.stationAccessibilityOutages.has(station)) return false;
  }
  return true;
}

import type {
  MapBoundingBox,
  MapCamera,
  Point,
  Size,
  TargetViewportInsets,
  ViewportTransform,
} from "~/domain/map/MapCamera";

export type { MapBoundingBox, MapCamera, Point, Size, TargetViewportInsets, ViewportTransform };

export interface GeometryPort {
  /** This schematic's snap cutoff as a fraction of its canvas diagonal; 0 when there is nothing to measure. */
  readonly snapCutoffRatio: number;
  /**
   * Projects WGS84 into schematic pixels and, when `attribution` names a drawn
   * line and the correction is bounded, snaps the result onto that line.
   */
  readonly projectGeoToMapPoint: (lat: number, lon: number, attribution?: SnapAttribution) => Point;
  /**
   * The drawn line's own points at the scale the schematic draws them, or
   * `undefined` when no line by that name is drawn. The corridor to show and
   * frame for a route the schematic draws, because the affine projection
   * disagrees with a stylised drawing by a per-schematic factor.
   */
  readonly drawnLineMapPoints: (lineId: string) => Point[] | undefined;
  /** Shares SnapAttribution so the corridor and the markers on it stay aligned. */
  readonly extractRouteMapPoints: (
    shape?: { polyline?: string } | null,
    stops?: readonly { lat: number; lon: number }[] | null,
    attribution?: SnapAttribution,
  ) => Point[];
  readonly projectGeoBoundingBoxToMapBounds: (box: {
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
  }) => MapBoundingBox;
  readonly computeRouteBoundingBox: (
    points: readonly (Point | [number, number])[],
  ) => MapBoundingBox;
}

export interface CameraPort {
  readonly computeFitTransform: (width: number, height: number) => ViewportTransform | null;
  readonly computeTargetViewport: (
    bounds: MapBoundingBox,
    containerSize: Size,
    paddingFactor?: number,
    insets?: TargetViewportInsets,
  ) => ViewportTransform | null;
  readonly transformMapPointToContainer: (point: Point, camera: MapCamera) => Point | undefined;
  readonly transformContainerPointToMap: (point: Point, camera: MapCamera) => Point | undefined;
}

export interface MapModel {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly stationList: readonly StationInfo[];
  readonly stationsById: ReadonlyMap<SchematicStationId, StationInfo>;
  readonly lineList: readonly LineInfo[];
  readonly linesById: ReadonlyMap<string, LineInfo>;
  readonly badgeList: readonly BadgeInfo[];
  readonly geometry: GeometryPort;
  readonly camera: CameraPort;
  readonly initialZoom: number;
  readonly initialPan: Point;
  readonly initialCamera: MapCamera;
  readonly sequenceFor: (lineId: string) => readonly SchematicStationId[];
  readonly sequenceBetween: (
    lineId: string,
    from: string,
    to: string,
  ) => readonly SchematicStationId[];
  readonly anchorFor: (stationId: SchematicStationId) => Point | undefined;
  readonly cornerInsertion: (
    lineId: string,
    subSequence: readonly SchematicStationId[],
  ) => readonly Point[];
  /**
   * The points a status span between two stations is drawn through, in the line's
   * own geometry. Follows the declared polyline between the endpoints, and
   * splices a declared `cornerInsertions` entry where a polyline cannot express
   * the turn.
   */
  readonly spanFor: (
    lineId: string,
    subSequence: readonly SchematicStationId[],
  ) => readonly Point[];
}

export function buildMapModel(schematic: MapSchematic): MapModel {
  const stationAnchorsById = new Map<SchematicStationId, Point>(
    schematic.stations.map((station) => [station.id, { x: station.x, y: station.y }]),
  );
  const bounds = schematic.viewport.bounds;
  const defaultBounds = {
    minX: bounds.minX,
    maxX: bounds.maxX,
    minY: bounds.minY,
    maxY: bounds.maxY,
    width: bounds.maxX - bounds.minX,
    height: bounds.maxY - bounds.minY,
    centerX: (bounds.minX + bounds.maxX) / 2,
    centerY: (bounds.minY + bounds.maxY) / 2,
  };
  const stationLinesById = new Map(
    schematic.stations.map((station) => [station.id, station.lines] as const),
  );
  const geometry = createMapGeometry({
    projection: schematic.geoProjection,
    viewport: {
      viewBoxWidth: schematic.viewBoxWidth,
      viewBoxHeight: schematic.viewBoxHeight,
      minZoom: schematic.viewport.minZoom,
      maxZoom: schematic.viewport.maxZoom,
    },
    // The schematic's own drawn polylines are the snap targets, so a stylised
    // line corrects every projection placed against it from geometry the
    // schematic already declares. Unconditional: every schematic's drawing
    // stands in for its geography to some degree, and the per-agency gate that
    // used to decide this had to be edited by hand for each new agency, which
    // is exactly how it came to leave ten of them visibly uncorrected.
    snapLines: schematic.lines.map((line) => ({ id: line.id, points: line.points })),
    // Each station's true position plus the drawn lines it sits on is the
    // evidence the engine measures its cutoff against: the same quantity the
    // snap gate will compare, drawn from what this schematic already declares.
    stylisedStations: (schematic.stationIndex ?? []).flatMap((entry) => {
      const lineIds = entry.schematicId ? stationLinesById.get(entry.schematicId) : undefined;
      if (!lineIds || lineIds.length === 0) return [];
      return [{ id: entry.id, lineIds, lat: entry.lat, lon: entry.lon }];
    }),
    defaultBounds,
  });
  const rawCamera = createMapCamera({
    viewBoxWidth: schematic.viewBoxWidth,
    viewBoxHeight: schematic.viewBoxHeight,
    minZoom: schematic.viewport.minZoom,
    maxZoom: schematic.viewport.maxZoom,
    defaultBounds,
  });
  const camera: CameraPort = {
    computeFitTransform: rawCamera.computeFitTransform,
    computeTargetViewport: (bounds, containerSize, paddingFactor, insets) =>
      rawCamera.computeTargetViewport(
        bounds,
        containerSize.width,
        containerSize.height,
        paddingFactor,
        insets,
      ),
    transformMapPointToContainer: rawCamera.transformMapPointToContainer,
    transformContainerPointToMap: rawCamera.transformContainerPointToMap,
  };
  const stationList: StationInfo[] = schematic.stations.map((station) => {
    const isInterchange = station.lines.length > 1;
    const accessible = station.accessible;
    return {
      id: station.id,
      name: station.name,
      x: station.x,
      y: station.y,
      lines: [...station.lines],
      accessible,
      isInterchange,
      isTerminal: station.terminal ?? false,
      labelLeader: station.label?.leader,
      labelX: station.label?.x ?? station.x + 12,
      labelY: station.label?.y ?? station.y + 4,
      labelRotation: station.label?.rot ?? 0,
      labelAnchor: station.label?.anchor ?? "start",
    };
  });
  const stationsById = new Map(stationList.map((station) => [station.id, station]));
  const lineList: LineInfo[] = schematic.lines.map((line) => ({
    id: line.id,
    name: line.name,
    color: line.color,
    pathD: buildSmoothPathD(line.points),
  }));
  const linesById = new Map(lineList.map((line) => [line.id, line]));
  const badgeList: BadgeInfo[] = (schematic.badges ?? []).map((badge) => ({ ...badge }));
  const initial = camera.computeFitTransform(schematic.viewBoxWidth, schematic.viewBoxHeight);
  if (!initial) throw new Error("Schematic viewport must have non-zero dimensions");
  const initialZoom = initial.zoom;
  const initialPan = initial.pan;
  const sequences = schematic.sequences ?? {};
  const cornersByLineStation = new Map<string, MapCornerInsertion>();
  for (const insertion of schematic.cornerInsertions ?? []) {
    cornersByLineStation.set(`${insertion.lineId}\u0000${insertion.stationId}`, insertion);
  }
  const anchorFor = (stationId: SchematicStationId): Point | undefined =>
    stationAnchorsById.get(stationId);
  const sequenceFor = (lineId: string): readonly SchematicStationId[] => sequences[lineId] ?? [];
  const cornerInsertion = (
    lineId: string,
    subSequence: readonly SchematicStationId[],
  ): readonly Point[] => {
    const fullSequence = sequenceFor(lineId);
    const points: Point[] = [];
    subSequence.forEach((stationId, index) => {
      const insertion = cornersByLineStation.get(`${lineId}\u0000${stationId}`);
      const stationPoint = anchorFor(stationId);
      if (!insertion || !stationPoint) {
        if (stationPoint) points.push(stationPoint);
        return;
      }
      const stationIndex = fullSequence.indexOf(stationId);
      const previousId = subSequence[index - 1];
      const nextId = subSequence[index + 1];
      const previousIndex = previousId ? fullSequence.indexOf(previousId) : -1;
      const nextIndex = nextId ? fullSequence.indexOf(nextId) : -1;
      const hasBefore =
        (previousIndex !== -1 && previousIndex < stationIndex) ||
        (nextIndex !== -1 && nextIndex < stationIndex);
      const hasAfter =
        (previousIndex !== -1 && previousIndex > stationIndex) ||
        (nextIndex !== -1 && nextIndex > stationIndex);
      if (hasBefore && hasAfter) {
        if (previousIndex < stationIndex) {
          points.push(insertion.before, stationPoint, insertion.after);
        } else {
          points.push(insertion.after, stationPoint, insertion.before);
        }
      } else if (hasBefore) {
        points.push(
          ...(index === 0 ? [stationPoint, insertion.before] : [insertion.before, stationPoint]),
        );
      } else if (hasAfter) {
        points.push(
          ...(index === 0 ? [stationPoint, insertion.after] : [insertion.after, stationPoint]),
        );
      } else {
        points.push(stationPoint);
      }
    });
    return points;
  };
  const linePointsById = new Map(schematic.lines.map((line) => [line.id, line.points]));
  const spanFor = (
    lineId: string,
    subSequence: readonly SchematicStationId[],
  ): readonly Point[] => {
    // A reversal is the one case a polyline cannot describe: the line arrives at
    // a station the way it leaves, and a single stroke through it has to lie
    // about one of the two legs. The declared corner is that leg, so a span
    // crossing one is spliced from the corners rather than from the polyline.
    const crossesDeclaredCorner = subSequence.some((stationId) =>
      cornersByLineStation.has(`${lineId}\u0000${stationId}`),
    );
    if (crossesDeclaredCorner) return cornerInsertion(lineId, subSequence);
    const polyline = linePointsById.get(lineId);
    if (!polyline) return cornerInsertion(lineId, subSequence);
    const anchored = subSequence.map((stationId) => anchorFor(stationId));
    if (anchored.some((anchor) => !anchor)) return cornerInsertion(lineId, subSequence);
    // No polyline reading means the drawing cannot support this span, so the
    // anchors alone are drawn rather than a shape invented for it.
    return (
      polylineSpanPoints(
        polyline,
        anchored,
        Boolean(schematic.branchSequences?.[lineId]?.length),
      ) ?? cornerInsertion(lineId, subSequence)
    );
  };
  return {
    viewBoxWidth: schematic.viewBoxWidth,
    viewBoxHeight: schematic.viewBoxHeight,
    minZoom: schematic.viewport.minZoom,
    maxZoom: schematic.viewport.maxZoom,
    stationList,
    stationsById,
    lineList,
    linesById,
    badgeList,
    geometry,
    camera,
    initialZoom,
    initialPan,
    initialCamera: {
      width: schematic.viewBoxWidth,
      height: schematic.viewBoxHeight,
      zoom: initialZoom,
      pan: { ...initialPan },
    },
    sequenceFor,
    sequenceBetween: (lineId, from, to) =>
      sequenceBetween(
        [sequences[lineId] ?? [], ...(schematic.branchSequences?.[lineId] ?? [])],
        from,
        to,
      ),
    anchorFor,
    cornerInsertion,
    spanFor,
  };
}

export function selectBadgeOrder(
  badgeList: readonly BadgeInfo[],
  favouriteLines: readonly string[],
): readonly BadgeInfo[] {
  if (favouriteLines.length === 0) return badgeList;
  const favourites = new Set(favouriteLines);
  return [...badgeList].sort(
    (first, second) => Number(favourites.has(second.line)) - Number(favourites.has(first.line)),
  );
}

export interface InterchangeBadgeRequest {
  readonly hubId: string;
  readonly activeStationId: SchematicStationId;
  readonly activeStationName: string;
  readonly targetAgencyId: string;
  readonly targetAgencyName: string;
  readonly targetStationId: SchematicStationId;
  readonly targetStationName: string;
  readonly agencyLabel: string;
  readonly mode?: InterchangeBadgeMode;
  readonly color: string;
  readonly walkingMarker?: WalkingInterchangeMarker;
  readonly offset: {
    readonly dx: number;
    readonly dy: number;
    readonly layout?: "horizontal" | "vertical";
  };
}

/** Provider-neutral agency facts needed to normalize static interchange data. */
export interface InterchangeBadgeAgency {
  readonly agencyId: string;
  readonly name: string;
  readonly shortName?: string;
  readonly modes: readonly string[];
  readonly brandColor?: string;
  readonly schematicStationIds: readonly SchematicStationId[];
}

export const INTERCHANGE_BADGE_GAP = 4;
export const INTERCHANGE_BADGE_HEIGHT = 18;
export const COMPACT_INTERCHANGE_BADGE_HEIGHT = 14;

/** Shared width estimate for the full and compact interchange presentations. */
export function interchangeBadgeWidth(label: string, hasIcon: boolean, compact = false): number {
  if (compact) return Math.max(30, label.length * 7 + 12);
  return Math.max(42, label.length * 7 + (hasIcon ? 42 : 22));
}

function hasTransitIcon(mode: InterchangeBadgeMode | undefined): boolean {
  return mode === "bus" || mode === "rail";
}

/**
 * Converts provider-neutral agency facts and static interchange data into
 * requests that Core Map can place without consulting an agency registry.
 */
export function normalizeInterchangeBadgeRequests(
  activeAgencyId: string,
  hubs: readonly InterchangeHub[],
  agencies: readonly InterchangeBadgeAgency[],
): readonly InterchangeBadgeRequest[] {
  const agenciesById = new Map(agencies.map((agency) => [agency.agencyId, agency]));
  const requests: InterchangeBadgeRequest[] = [];

  for (const hub of hubs) {
    const endpoint = hub.endpoints.find((candidate) => candidate.agencyId === activeAgencyId);
    if (!endpoint?.stationId) continue;
    const offset = hub.badgeOffsets?.[activeAgencyId];

    for (const target of hub.endpoints) {
      if (target.agencyId === activeAgencyId) continue;
      if (
        hub.excludedPairs?.some(
          (pair) =>
            (sameEndpoint(pair.left, endpoint) && sameEndpoint(pair.right, target)) ||
            (sameEndpoint(pair.right, endpoint) && sameEndpoint(pair.left, target)),
        )
      )
        continue;
      const targetAgency = agenciesById.get(target.agencyId);
      if (!target.stationId || !targetAgency) continue;
      if (!targetAgency.schematicStationIds.includes(target.stationId)) continue;
      if (!offset) {
        throw new Error(
          `[map] Missing compiled interchange badge position for active agency "${activeAgencyId}" in hub "${hub.id}"`,
        );
      }

      const targetShortName = targetAgency.shortName ?? targetAgency.name ?? target.agencyId;
      const isMultiMode = targetAgency.modes.length > 1;
      const inferredMode: InterchangeBadgeMode | undefined = isMultiMode
        ? targetAgency.modes.includes("rail") || targetAgency.modes.includes("subway")
          ? "rail"
          : undefined
        : targetAgency.modes[0] === "bus"
          ? "bus"
          : targetAgency.modes[0] === "rail" || targetAgency.modes[0] === "subway"
            ? "rail"
            : undefined;
      requests.push({
        hubId: hub.id,
        activeStationId: endpoint.stationId,
        activeStationName: endpoint.stationName,
        targetAgencyId: target.agencyId,
        targetAgencyName: targetAgency.name,
        targetStationId: target.stationId,
        targetStationName: target.stationName,
        agencyLabel:
          target.badgeLabel ??
          (hub.badgeLabel === targetShortName ? hub.badgeLabel : undefined) ??
          targetShortName,
        mode: inferredMode,
        color: targetAgency.brandColor ?? "var(--color-info)",
        walkingMarker: target.walkingMarkers?.[activeAgencyId],
        offset,
      });
    }
  }

  return requests;
}

function sameEndpoint(first: InterchangeEndpoint, second: InterchangeEndpoint): boolean {
  if (first.agencyId !== second.agencyId) return false;
  if (first.stationId && second.stationId) return first.stationId === second.stationId;
  return first.stationName.trim().toLowerCase() === second.stationName.trim().toLowerCase();
}

export function placeInterchangeBadges(
  model: MapModel,
  requests: readonly InterchangeBadgeRequest[],
  visibility: InterchangeBadgeVisibility,
): readonly PositionedInterchangeBadge[] {
  if (visibility === "hidden") return [];

  const badgesByRow = new Map<string, InterchangeBadgeInfo[]>();
  for (const request of requests) {
    const station = model.stationsById.get(request.activeStationId);
    if (!station) continue;
    const badge: InterchangeBadgeInfo = {
      hubId: request.hubId,
      activeStationId: request.activeStationId,
      activeStationName: request.activeStationName,
      targetAgencyId: request.targetAgencyId,
      targetAgencyName: request.targetAgencyName,
      targetStationId: request.targetStationId,
      targetStationName: request.targetStationName,
      agencyLabel: request.agencyLabel,
      mode: request.mode,
      color: request.color,
      x: station.x + request.offset.dx,
      y: station.y + request.offset.dy,
      layout: request.offset.layout,
    };
    const key = `${badge.hubId}\u0000${badge.activeStationId}`;
    const row = badgesByRow.get(key) ?? [];
    row.push(badge);
    badgesByRow.set(key, row);
  }

  const isCompact = visibility === "compact";
  const positioned: PositionedInterchangeBadge[] = [];
  for (const row of badgesByRow.values()) {
    const widths = row.map((badge) =>
      interchangeBadgeWidth(badge.agencyLabel, hasTransitIcon(badge.mode), isCompact),
    );
    const height = isCompact ? COMPACT_INTERCHANGE_BADGE_HEIGHT : INTERCHANGE_BADGE_HEIGHT;
    const isVertical = row[0]?.layout === "vertical";

    if (isVertical) {
      const rowTotalHeight =
        row.length * height + Math.max(0, row.length - 1) * INTERCHANGE_BADGE_GAP;
      const rowTotalWidth = Math.max(...widths);
      let heightBefore = 0;
      row.forEach((badge, index) => {
        const width = widths[index]!;
        const hasIcon = !isCompact && hasTransitIcon(badge.mode);
        positioned.push({
          ...badge,
          width,
          height,
          rectY: -height / 2,
          cornerRadius: height / 2,
          transformOrigin: `${width / 2}px 0px`,
          xOffsetFromCenter: -width / 2,
          yOffsetFromCenter: -rowTotalHeight / 2 + heightBefore + height / 2,
          rowTotalWidth,
          rowTotalHeight,
          textX: hasIcon ? 19 : width / 2,
          hasIcon,
          isCompact,
        });
        heightBefore += height + INTERCHANGE_BADGE_GAP;
      });
    } else {
      const rowTotalWidth =
        widths.reduce((total, width) => total + width, 0) +
        Math.max(0, row.length - 1) * INTERCHANGE_BADGE_GAP;
      let widthBefore = 0;
      row.forEach((badge, index) => {
        const width = widths[index]!;
        const hasIcon = !isCompact && hasTransitIcon(badge.mode);
        positioned.push({
          ...badge,
          width,
          height,
          rectY: -height / 2,
          cornerRadius: height / 2,
          transformOrigin: `${width / 2}px 0px`,
          xOffsetFromCenter: -rowTotalWidth / 2 + widthBefore,
          yOffsetFromCenter: 0,
          rowTotalWidth,
          rowTotalHeight: height,
          textX: hasIcon ? 19 : width / 2,
          hasIcon,
          isCompact,
        });
        widthBefore += width + (index < row.length - 1 ? INTERCHANGE_BADGE_GAP : 0);
      });
    }
  }
  return positioned;
}

export interface PositionedWalkingInterchangeMarker extends InterchangeBadgeRequest {
  readonly sourceX: number;
  readonly sourceY: number;
  readonly x: number;
  readonly y: number;
  readonly label: string;
}

/** Peer nodes are stations, so badge visibility preferences do not hide them. */
export function placeWalkingInterchangeMarkers(
  model: MapModel,
  requests: readonly InterchangeBadgeRequest[],
): readonly PositionedWalkingInterchangeMarker[] {
  return requests.flatMap((request) => {
    const placement = request.walkingMarker;
    const station = model.stationsById.get(request.activeStationId);
    if (!placement || !station) return [];
    return [
      {
        ...request,
        sourceX: station.x,
        sourceY: station.y,
        x: station.x + placement.dx,
        y: station.y + placement.dy,
        label: placement.label,
      },
    ];
  });
}

export function groupInterchangeBadges<T extends InterchangeBadgeInfo>(
  badges: readonly T[],
): readonly (readonly T[])[] {
  const groups = new Map<string, T[]>();
  for (const badge of badges) {
    const key = `${badge.hubId}\u0000${badge.activeStationId}`;
    const group = groups.get(key) ?? [];
    group.push(badge);
    groups.set(key, group);
  }
  return [...groups.values()];
}

export function deriveMapProjection(
  snapshot: MapSnapshot | null,
  topology: MapModel,
): MapProjection {
  const stationSeverities = new Map<SchematicStationId, "normal" | "degraded" | "severe">();
  const stationAccessibilityOutages = new Set<SchematicStationId>();
  const statusOverlaySegments: StatusOverlaySegment[] = [];
  if (!snapshot) return { statusOverlaySegments, stationSeverities, stationAccessibilityOutages };
  for (const alert of snapshot.alerts) {
    if (alert.lifecycle === "expired") continue;
    if (alert.kind === "accessibility") {
      for (const station of alertStationReferences(alert)) {
        if (station.stationId) stationAccessibilityOutages.add(station.stationId);
      }
      continue;
    }
    if (alert.lifecycle === "upcoming" || alert.kind === "upcoming") continue;
    if (alert.severity !== "normal") {
      const severity = alert.severity;
      for (const station of alertStationReferences(alert)) {
        if (!station.stationId) continue;
        const stationInfo = topology.stationsById.get(station.stationId);
        const stationImpact = alertStationRouteImpact(alert, station.stationId);
        if (!stationImpact.matched) continue;
        const stationRoutes = stationImpact.routeIds;
        if (
          stationInfo &&
          stationInfo.lines.length > 0 &&
          stationRoutes.length > 0 &&
          !stationRoutes.some((route) => stationInfo.lines.includes(route))
        ) {
          continue;
        }
        const existing = stationSeverities.get(station.stationId);
        if (!existing || SEVERITY_RANK[severity] > SEVERITY_RANK[existing]) {
          stationSeverities.set(station.stationId, severity);
        }
      }
    }
    if (alert.severity === "normal") continue;
    const fromStation = alert.fromStation;
    const toStation = alert.toStation;
    const fromId = fromStation?.stationId;
    const toId = toStation?.stationId;
    const hasStationScope =
      Boolean(fromStation || toStation) || (alert.affectedStations?.length ?? 0) > 0;
    const lineIds = alert.affectedLineIds ?? [];
    if (lineIds.length === 0) continue;
    for (const lineId of lineIds) {
      const lineInfo = topology.linesById.get(lineId);
      if (!lineInfo || !lineInfo.pathD) continue;
      const sequenceIds =
        fromId && toId
          ? topology.sequenceBetween(lineId, fromId, toId)
          : topology.sequenceFor(lineId);
      const fromIndex = fromId ? sequenceIds.indexOf(fromId) : -1;
      const toIndex = toId ? sequenceIds.indexOf(toId) : -1;
      let pathD: string | undefined;
      let midpoint: Point = { x: 0, y: 0 };
      let displayFrom = fromStation
        ? (topology.stationsById.get(fromId ?? ("" as SchematicStationId))?.name ??
          fromStation.stationName)
        : undefined;
      let displayTo = toStation
        ? (topology.stationsById.get(toId ?? ("" as SchematicStationId))?.name ??
          toStation.stationName)
        : undefined;
      if (fromIndex !== -1 && toIndex !== -1) {
        const subSequence = sequenceIds.slice(
          Math.min(fromIndex, toIndex),
          Math.max(fromIndex, toIndex) + 1,
        );
        const points = topology.spanFor(lineId, subSequence);
        if (points.length >= 2) {
          pathD = buildSmoothPathD(points);
          midpoint = points[Math.floor(points.length / 2)] ?? midpoint;
        }
      }
      if (!pathD) {
        if (hasStationScope) continue;
        pathD = lineInfo.pathD;
        // A route advisory has no operator-stated station span.
        displayFrom = lineInfo.name;
        displayTo = lineInfo.name;
        midpoint =
          topology.anchorFor(
            sequenceIds[Math.floor(sequenceIds.length / 2)] ?? ("" as SchematicStationId),
          ) ??
          topology.anchorFor(sequenceIds[0] ?? ("" as SchematicStationId)) ??
          midpoint;
      }
      const kind: StatusSegmentKind =
        alert.severity === "severe" ? "severe" : alert.kind === "slow-service" ? "rsz" : "delay";
      statusOverlaySegments.push({
        id: lineIds.length === 1 ? alert.id : `${alert.id}:${lineId}`,
        kind,
        lineId,
        lineName: lineInfo.name,
        lineColor: lineInfo.color,
        fromStation: displayFrom ?? lineInfo.name,
        toStation: displayTo ?? lineInfo.name,
        note: alert.description || alert.title,
        pathD,
        midpoint,
      });
    }
  }
  return { statusOverlaySegments, stationSeverities, stationAccessibilityOutages };
}

export function excludeReducedSpeedZones(projection: MapProjection): MapProjection {
  if (!projection.statusOverlaySegments.some((segment) => segment.kind === "rsz"))
    return projection;
  return {
    ...projection,
    statusOverlaySegments: projection.statusOverlaySegments.filter(
      (segment) => segment.kind !== "rsz",
    ),
  };
}
