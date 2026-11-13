import type { Schematic } from "~/agencies/types";
import type { InterchangeBadgePosition, InterchangeHub } from "~/domain/map/Interchange";
import {
  buildMapModel,
  normalizeInterchangeBadgeRequests,
  placeInterchangeBadges,
  placeWalkingInterchangeMarkers,
  type InterchangeBadgeAgency,
  type InterchangeBadgeRequest,
  type MapModel,
  type Point,
} from "~/core/map";
import {
  interchangeBadgeBounds,
  stationNodeBounds,
  stationLabelBounds,
  stationLabelPolygon,
  rectangleIntersectsPolygon,
  segmentIntersectsPolygon,
  walkingStationLabel,
  walkingLinkLabel,
  textBounds,
  rectangleOverlapArea,
  segmentIntersectsRect,
  type LayoutRect,
} from "~/core/map/interchange-geometry";

export interface PlacementConflict {
  readonly agencyId: string;
  readonly hubId: string;
  readonly kind: "badge" | "walking";
  readonly obstacle: string;
}
export interface PlacementChange {
  readonly agencyId: string;
  readonly hubId: string;
  readonly previous?: InterchangeBadgePosition;
  readonly next: InterchangeBadgePosition;
  readonly reason: "authored" | "automatic";
}
export interface WalkingPlacementFallback {
  readonly agencyId: string;
  readonly hubId: string;
  readonly targetAgencyId: string;
  readonly targetStationId: string;
  readonly reasons: readonly string[];
}
export interface InterchangeLayoutReport {
  readonly walkingFallbacks: readonly WalkingPlacementFallback[];
  readonly changes: readonly PlacementChange[];
  readonly conflicts: readonly PlacementConflict[];
}
export interface InterchangePlacementOptions {
  readonly agencies?: readonly InterchangeBadgeAgency[];
  readonly previous?: readonly InterchangeHub[];
  readonly onReport?: (report: InterchangeLayoutReport) => void;
}
interface Obstacle {
  readonly id: string;
  readonly rect?: LayoutRect;
  readonly polygon?: readonly Point[];
  readonly segment?: readonly [Point, Point];
  readonly padding?: number;
}
interface Row {
  readonly hub: InterchangeHub;
  readonly agencyId: string;
  readonly model: MapModel;
  readonly requests: readonly InterchangeBadgeRequest[];
  readonly anchor: Point;
  readonly anchorBounds: LayoutRect;
  readonly authored?: InterchangeBadgePosition;
  readonly previous?: InterchangeBadgePosition;
  readonly reportedPrevious?: InterchangeBadgePosition;
}
const INITIAL: InterchangeBadgePosition = { dx: 0, dy: -28 };
const MAX_ASSOCIATION_GAP = 32;

/**
 * Offline plan using the runtime's exact target filtering and badge layout.
 * Existing rows reserve their space before new rows are considered. Authored
 * placements never move silently; impossible placements are returned with conflicts.
 */
export function planInterchangeLayout(
  input: readonly InterchangeHub[],
  schematics: ReadonlyMap<string, Schematic>,
  options: InterchangePlacementOptions = {},
): InterchangeLayoutReport & { readonly hubs: readonly InterchangeHub[] } {
  let hubs = [...input].sort((a, b) => a.id.localeCompare(b.id));
  const agencies =
    options.agencies ??
    [...schematics].map(([agencyId, s]) => ({
      agencyId,
      name: agencyId,
      modes: [],
      schematicStationIds: s.stations.map((station) => station.id),
    }));
  const models = new Map([...schematics].map(([id, schematic]) => [id, buildMapModel(schematic)]));
  const previous = new Map(options.previous?.map((hub) => [hub.id, hub]));
  // Temporary offsets allow the same normalization seam to resolve undrawn peers
  // before any row exists. These offsets are never used as the compiled result.
  let provisional = hubs.map((hub) => ({
    ...hub,
    badgeOffsets: Object.fromEntries(
      hub.endpoints.map((e) => [e.agencyId, hub.badgeOffsets?.[e.agencyId] ?? INITIAL]),
    ),
  }));
  const walkingFallbacks: WalkingPlacementFallback[] = [];
  for (const [agencyId, model] of models) {
    const requests = normalizeInterchangeBadgeRequests(agencyId, provisional, agencies);
    for (const marker of placeWalkingInterchangeMarkers(model, requests)) {
      const peer = models.get(marker.targetAgencyId)?.stationsById.get(marker.targetStationId);
      if (!peer) continue;
      const station = {
        ...peer,
        name: marker.label,
        x: marker.x,
        y: marker.y,
        ...walkingStationLabel(marker),
      };
      const viewport = schematics.get(agencyId)!.viewport.bounds;
      const reasons: string[] = [];
      if (
        [
          stationNodeBounds(station),
          stationLabelBounds(station),
          textBounds("walk", walkingLinkLabel(marker), "middle", 0, 9),
        ].some((rect) => !inside(rect, viewport))
      )
        reasons.push("viewport");
      const source = model.stationsById.get(marker.activeStationId)!;
      if (!walkingIsNearby(model, source, station)) reasons.push("walking-proximity");
      if (reasons.length)
        walkingFallbacks.push({
          agencyId,
          hubId: marker.hubId,
          targetAgencyId: marker.targetAgencyId,
          targetStationId: marker.targetStationId,
          reasons,
        });
    }
  }
  // Hard constraints suppress only this map's presentation. Transfer identities,
  // boarding stops and reciprocal-map opt-ins are retained. Peer-relative authored
  // badge positions cannot survive without their peer node.
  hubs = hubs.map((hub) => {
    const fallbacks = walkingFallbacks.filter((f) => f.hubId === hub.id);
    if (!fallbacks.length) return hub;
    const badgeOffsets = { ...hub.badgeOffsets };
    for (const fallback of fallbacks) delete badgeOffsets[fallback.agencyId];
    return {
      ...hub,
      badgeOffsets,
      endpoints: hub.endpoints.map((endpoint) => {
        const walkingMarkers = { ...endpoint.walkingMarkers };
        for (const fallback of fallbacks)
          if (
            endpoint.agencyId === fallback.targetAgencyId &&
            endpoint.stationId === fallback.targetStationId
          )
            delete walkingMarkers[fallback.agencyId];
        return endpoint.walkingMarkers ? { ...endpoint, walkingMarkers } : endpoint;
      }),
    };
  });
  provisional = hubs.map((hub) => ({
    ...hub,
    badgeOffsets: Object.fromEntries(
      hub.endpoints.map((e) => [e.agencyId, hub.badgeOffsets?.[e.agencyId] ?? INITIAL]),
    ),
  }));
  const rows: Row[] = [];
  const fixed = new Map<string, Obstacle[]>();
  for (const [agencyId, model] of models) {
    const requests = normalizeInterchangeBadgeRequests(agencyId, provisional, agencies);
    const obstacles = networkObstacles(schematics.get(agencyId)!, model);
    for (const marker of placeWalkingInterchangeMarkers(model, requests)) {
      const target = models.get(marker.targetAgencyId)?.stationsById.get(marker.targetStationId);
      if (!target) continue;
      const station = {
        ...target,
        name: marker.label,
        x: marker.x,
        y: marker.y,
        ...walkingStationLabel(marker),
      };
      const key = `${marker.hubId}:${marker.targetAgencyId}:${marker.targetStationId}`;
      obstacles.push(
        { id: `walk-node:${key}`, rect: stationNodeBounds(station) },
        { id: `walk-label:${key}`, rect: stationLabelBounds(station) },
        {
          id: `walk-caption:${key}`,
          rect: textBounds("walk", walkingLinkLabel(marker), "middle", 0, 9),
        },
        {
          id: `walk-link:${key}`,
          segment: [
            { x: marker.sourceX, y: marker.sourceY },
            { x: marker.x, y: marker.y },
          ],
          padding: 2,
        },
      );
    }
    fixed.set(agencyId, obstacles);
    for (const hub of hubs) {
      const group = requests.filter((r) => r.hubId === hub.id);
      const source = group[0] && model.stationsById.get(group[0].activeStationId);
      if (!source) continue;
      const walking = group.find((r) => r.walkingMarker)?.walkingMarker;
      const priorHub = previous.get(hub.id);
      const priorHasSameSource = priorHub?.endpoints.some(
        (e) => e.agencyId === agencyId && e.stationId === source.id,
      );
      const fallback = walkingFallbacks.some((f) => f.hubId === hub.id && f.agencyId === agencyId);
      const priorWasWalking = priorHub?.endpoints.some((e) => e.walkingMarkers?.[agencyId]);
      rows.push({
        hub,
        agencyId,
        model,
        requests: group,
        anchor: { x: source.x + (walking?.dx ?? 0), y: source.y + (walking?.dy ?? 0) },
        anchorBounds: walking
          ? (obstacles.find((o) => o.id.startsWith(`walk-node:${hub.id}:`))?.rect ??
            stationNodeBounds(source))
          : stationNodeBounds(source),
        authored: hub.badgeOffsets?.[agencyId],
        reportedPrevious: priorHasSameSource ? priorHub?.badgeOffsets?.[agencyId] : undefined,
        previous:
          priorHasSameSource && !(fallback && priorWasWalking)
            ? priorHub?.badgeOffsets?.[agencyId]
            : undefined,
      });
    }
  }
  const placements = new Map<Row, InterchangeBadgePosition>();
  for (const row of rows) {
    const prior = row.authored ?? row.previous;
    if (prior) placements.set(row, prior);
  }
  const conflictsFor = (
    row: Row,
    offset: InterchangeBadgePosition,
    includeRows = true,
  ): string[] => {
    const rects = rowBounds(row, offset);
    const obstacles = [...(fixed.get(row.agencyId) ?? [])];
    for (const [other, placement] of placements)
      if (includeRows && other !== row && other.agencyId === row.agencyId) {
        for (const rect of rowBounds(other, placement))
          obstacles.push({ id: `badge:${other.hub.id}`, rect });
      }
    const conflicts = new Set<string>();
    for (const rect of rects) {
      if (!inside(rect, schematics.get(row.agencyId)!.viewport.bounds)) conflicts.add("viewport");
      for (const obstacle of obstacles) if (intersects(rect, obstacle)) conflicts.add(obstacle.id);
    }
    // Distance between the row's and owning node's nearest edges accommodates
    // multi-agency rows while keeping a short badge visibly attached to its station.
    const sourceId = row.requests[0]!.activeStationId;
    const otherAnchors = (fixed.get(row.agencyId) ?? []).filter(
      (o) =>
        o.rect &&
        (o.id.startsWith("node:") || o.id.startsWith("walk-node:")) &&
        o.id !== `node:${sourceId}` &&
        !o.id.startsWith(`walk-node:${row.hub.id}:`),
    );
    for (const presentation of rowPresentations(row, offset)) {
      const ownDistance = Math.min(
        ...presentation.map((rect) => distanceBetweenRects(row.anchorBounds, rect)),
      );
      if (ownDistance > MAX_ASSOCIATION_GAP) conflicts.add("station-association");
      for (const other of otherAnchors) {
        const rect = other.rect!;
        if (
          Math.min(...presentation.map((badge) => distanceBetweenRects(rect, badge))) + 4 <
          ownDistance
        )
          conflicts.add(`station-association:${other.id}`);
      }
    }
    return [...conflicts].sort();
  };
  // Resolve intrinsically invalid old rows first, while all prior neighbours still
  // reserve space. A row/row clash counts twice because moving it affects both rows.
  // Every accepted move strictly decreases the layout's integer conflict cost.
  // Settling before emission makes an unchanged reseed a fixed point, even when
  // the finite set of nearby candidates cannot resolve all conflicts.
  const cost = (conflicts: readonly string[]) =>
    conflicts.reduce((sum, id) => sum + (id.startsWith("badge:") ? 2 : 1), 0);
  const ordered = [...rows].sort(
    (a, b) =>
      cost(conflictsFor(b, b.authored ?? b.previous ?? INITIAL, false)) -
        cost(conflictsFor(a, a.authored ?? a.previous ?? INITIAL, false)) ||
      a.agencyId.localeCompare(b.agencyId) ||
      a.hub.id.localeCompare(b.hub.id),
  );
  for (const row of ordered) {
    if (placements.has(row)) continue;
    const candidates = candidateOffsets(row);
    let best = candidates[0]!;
    let bestCost = cost(conflictsFor(row, best));
    for (const candidate of candidates) {
      const nextCost = cost(conflictsFor(row, candidate));
      if (nextCost < bestCost) {
        best = candidate;
        bestCost = nextCost;
      }
    }
    placements.set(row, best);
  }
  let moved: boolean;
  do {
    moved = false;
    for (const row of ordered) {
      if (row.authored) continue;
      let best = placements.get(row)!;
      let bestCost = cost(conflictsFor(row, best));
      for (const candidate of candidateOffsets(row)) {
        const nextCost = cost(conflictsFor(row, candidate));
        if (nextCost < bestCost) {
          best = candidate;
          bestCost = nextCost;
        }
      }
      if (!samePosition(placements.get(row), best)) {
        placements.set(row, best);
        moved = true;
      }
    }
  } while (moved);
  const changes: PlacementChange[] = [];
  const conflicts: PlacementConflict[] = walkingFallbacks.flatMap((f) =>
    f.reasons.map((obstacle) => ({
      agencyId: f.agencyId,
      hubId: f.hubId,
      kind: "walking" as const,
      obstacle,
    })),
  );
  for (const [row, offset] of placements) {
    if (!samePosition(row.reportedPrevious, offset))
      changes.push({
        agencyId: row.agencyId,
        hubId: row.hub.id,
        ...(row.reportedPrevious ? { previous: row.reportedPrevious } : {}),
        next: offset,
        reason: row.authored ? "authored" : "automatic",
      });
    for (const obstacle of conflictsFor(row, offset))
      conflicts.push({ agencyId: row.agencyId, hubId: row.hub.id, kind: "badge", obstacle });
  }
  const result = hubs.map((hub) => {
    const badgeOffsets = {
      ...previous.get(hub.id)?.badgeOffsets,
      ...hub.badgeOffsets,
      ...Object.fromEntries(
        [...placements]
          .filter(([row]) => row.hub === hub)
          .map(([row, offset]) => [row.agencyId, offset]),
      ),
    };
    return Object.keys(badgeOffsets).length ? { ...hub, badgeOffsets } : hub;
  });
  // Walking placements are authored: report collisions and exaggerated separation
  // rather than silently moving stations or deleting a reviewed connection.
  for (const [agencyId, model] of models) {
    const requests = normalizeInterchangeBadgeRequests(agencyId, result, agencies);
    const badges = [...placements]
      .filter(([row]) => row.agencyId === agencyId)
      .flatMap(([row, offset]) =>
        rowBounds(row, offset).map((rect) => ({ id: `badge:${row.hub.id}`, rect })),
      );
    for (const marker of placeWalkingInterchangeMarkers(model, requests)) {
      const key = `${marker.hubId}:${marker.targetAgencyId}:${marker.targetStationId}`;
      const pieces = fixed.get(agencyId)!.filter((o) => o.id.endsWith(key));
      const obstacles: Obstacle[] = [
        ...fixed.get(agencyId)!.filter((o) => !o.id.endsWith(key)),
        ...badges,
      ];
      const seen = new Set<string>();
      const viewport = schematics.get(agencyId)!.viewport.bounds;
      for (const piece of pieces) {
        if (piece.rect && !inside(piece.rect, viewport)) seen.add("viewport");
        if (
          piece.segment &&
          piece.segment.some(
            (point) =>
              point.x < viewport.minX ||
              point.x > viewport.maxX ||
              point.y < viewport.minY ||
              point.y > viewport.maxY,
          )
        )
          seen.add("viewport");
      }
      for (const piece of pieces)
        for (const obstacle of obstacles) {
          // The walk necessarily starts at its own station and crosses its own route
          // at that endpoint. Trim the link only at the endpoint, not along its length.
          if (piece.segment) {
            if (obstacle.id === `node:${marker.activeStationId}`) continue;
            const sourceBounds = stationNodeBounds(model.stationsById.get(marker.activeStationId)!);
            const dx = Math.abs(marker.x - marker.sourceX),
              dy = Math.abs(marker.y - marker.sourceY),
              length = Math.hypot(dx, dy);
            const exitDistance = Math.min(
              dx ? ((sourceBounds.maxX - marker.sourceX) * length) / dx : Infinity,
              dy ? ((sourceBounds.maxY - marker.sourceY) * length) / dy : Infinity,
            );
            const segment = trimLink(piece.segment, exitDistance + 8, 8);
            if (
              obstacle.rect &&
              (obstacle.polygon
                ? segmentIntersectsPolygon(...segment, obstacle.polygon, 2)
                : segmentIntersectsRect(...segment, obstacle.rect, 2))
            )
              seen.add(obstacle.id);
            if (
              obstacle.segment &&
              segmentsNear(segment, obstacle.segment, (obstacle.padding ?? 0) + 2)
            )
              seen.add(obstacle.id);
          } else if (piece.rect && intersects(piece.rect, obstacle)) seen.add(obstacle.id);
        }
      const source = model.stationsById.get(marker.activeStationId)!;
      if (!walkingIsNearby(model, source, { x: marker.x, y: marker.y }))
        seen.add("walking-proximity");
      for (const obstacle of [...seen].sort())
        conflicts.push({ agencyId, hubId: marker.hubId, kind: "walking", obstacle });
    }
  }
  const sort = (a: { agencyId: string; hubId: string }, b: { agencyId: string; hubId: string }) =>
    a.agencyId.localeCompare(b.agencyId) || a.hubId.localeCompare(b.hubId);
  return {
    hubs: result,
    changes: changes.sort(sort),
    conflicts: conflicts.sort(sort),
    walkingFallbacks: walkingFallbacks.sort(sort),
  };
}

export function resolveInterchangeBadgeOffsets(
  hubs: readonly InterchangeHub[],
  schematics: ReadonlyMap<string, Schematic>,
  options: InterchangePlacementOptions = {},
): readonly InterchangeHub[] {
  const result = planInterchangeLayout(hubs, schematics, options);
  options.onReport?.({
    changes: result.changes,
    conflicts: result.conflicts,
    walkingFallbacks: result.walkingFallbacks,
  });
  return result.hubs;
}

function rowPresentations(
  row: Row,
  offset: InterchangeBadgePosition,
): readonly (readonly LayoutRect[])[] {
  const requests = row.requests.map((request) => ({ ...request, offset }));
  return (["full", "compact"] as const).map((mode) =>
    placeInterchangeBadges(row.model, requests, mode).map(interchangeBadgeBounds),
  );
}
function rowBounds(row: Row, offset: InterchangeBadgePosition): readonly LayoutRect[] {
  return rowPresentations(row, offset).flat();
}
function candidateOffsets(row: Row): readonly InterchangeBadgePosition[] {
  const source = row.model.stationsById.get(row.requests[0]!.activeStationId)!;
  const baseX = row.anchor.x - source.x,
    baseY = row.anchor.y - source.y;
  const bounds = rowBounds(row, { dx: 0, dy: 0 });
  const halfWidth =
    Math.max(...bounds.map((rect) => rect.maxX)) - Math.min(...bounds.map((rect) => rect.minX));
  const sourceBounds = row.anchorBounds;
  const lift =
    Math.ceil(
      (sourceBounds.maxY -
        row.anchor.y +
        Math.max(...bounds.map((rect) => rect.maxY)) -
        source.y +
        4) /
        4,
    ) * 4;
  const side = Math.round((halfWidth / 2 + sourceBounds.maxX - row.anchor.x + 4) * 100) / 100;
  const offsets = [
    { dx: 0, dy: -lift },
    { dx: 0, dy: lift },
    { dx: -side, dy: 0 },
    { dx: side, dy: 0 },
    { dx: -28, dy: -28 },
    { dx: 28, dy: -28 },
    { dx: -28, dy: 28 },
    { dx: 28, dy: 28 },
    { dx: -side, dy: -28 },
    { dx: side, dy: -28 },
    { dx: -side, dy: 28 },
    { dx: side, dy: 28 },
  ];
  const horizontal = offsets.map((offset) => ({ dx: baseX + offset.dx, dy: baseY + offset.dy }));
  const verticalRects = rowBounds(row, { dx: 0, dy: 0, layout: "vertical" });
  const verticalSide = Math.round(
    (Math.max(...verticalRects.map((r) => r.maxX)) -
      Math.min(...verticalRects.map((r) => r.minX))) /
      2 +
      sourceBounds.maxX -
      row.anchor.x +
      4,
  );
  const verticalLift =
    Math.ceil(
      (sourceBounds.maxY -
        row.anchor.y +
        Math.max(...verticalRects.map((r) => r.maxY)) -
        source.y +
        4) /
        4,
    ) * 4;
  return [
    ...horizontal,
    { dx: baseX, dy: baseY - verticalLift, layout: "vertical" },
    { dx: baseX, dy: baseY + verticalLift, layout: "vertical" },
    ...[-1, 1].flatMap((sign) =>
      [-verticalLift, -28, 0, 28, verticalLift].map((dy) => ({
        dx: baseX + sign * verticalSide,
        dy: baseY + dy,
        layout: "vertical" as const,
      })),
    ),
  ];
}
function networkObstacles(schematic: Schematic, model: MapModel): Obstacle[] {
  return [
    ...model.stationList.flatMap((s) => [
      { id: `node:${s.id}`, rect: stationNodeBounds(s) },
      { id: `label:${s.id}`, rect: stationLabelBounds(s), polygon: stationLabelPolygon(s) },
      ...(s.labelLeader
        ? [
            {
              id: `leader:${s.id}`,
              segment: [
                { x: s.x, y: s.y },
                { x: s.labelX, y: s.labelY },
              ] as const,
              padding: 1,
            },
          ]
        : []),
    ]),
    ...schematic.lines.flatMap((line) =>
      line.points.slice(1).map((point, i) => ({
        id: `route:${line.id}`,
        segment: [line.points[i]!, point] as const,
        padding: 8,
      })),
    ),
    ...model.badgeList.map((b) => ({
      id: `route-badge:${b.line}`,
      rect: { minX: b.x - 17, maxX: b.x + 17, minY: b.y - 17, maxY: b.y + 17 },
    })),
  ];
}
function intersects(rect: LayoutRect, obstacle: Obstacle): boolean {
  if (obstacle.polygon) return rectangleIntersectsPolygon(rect, obstacle.polygon);
  return obstacle.rect
    ? rectangleOverlapArea(rect, obstacle.rect) > 0
    : Boolean(
        obstacle.segment && segmentIntersectsRect(...obstacle.segment, rect, obstacle.padding),
      );
}

function inside(rect: LayoutRect, viewport: LayoutRect): boolean {
  return (
    rect.minX >= viewport.minX &&
    rect.maxX <= viewport.maxX &&
    rect.minY >= viewport.minY &&
    rect.maxY <= viewport.maxY
  );
}
function distanceBetweenRects(a: LayoutRect, b: LayoutRect): number {
  return Math.hypot(
    Math.max(a.minX - b.maxX, b.minX - a.maxX, 0),
    Math.max(a.minY - b.maxY, b.minY - a.maxY, 0),
  );
}
function samePosition(
  a: InterchangeBadgePosition | undefined,
  b: InterchangeBadgePosition,
): boolean {
  return (
    a?.dx === b.dx && a.dy === b.dy && (a.layout ?? "horizontal") === (b.layout ?? "horizontal")
  );
}
function trimLink(
  [start, end]: readonly [Point, Point],
  sourceAmount: number,
  targetAmount: number,
): readonly [Point, Point] {
  const length = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y));
  const sourceFraction = Math.min(0.45, sourceAmount / length);
  const targetFraction = Math.min(0.45, targetAmount / length);
  return [
    {
      x: start.x + (end.x - start.x) * sourceFraction,
      y: start.y + (end.y - start.y) * sourceFraction,
    },
    {
      x: end.x - (end.x - start.x) * targetFraction,
      y: end.y - (end.y - start.y) * targetFraction,
    },
  ];
}
function segmentsNear(
  a: readonly [Point, Point],
  b: readonly [Point, Point],
  padding: number,
): boolean {
  const cross = (p: Point, q: Point, r: Point) =>
    (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x);
  const [a1, a2] = a,
    [b1, b2] = b;
  if (cross(a1, a2, b1) * cross(a1, a2, b2) < 0 && cross(b1, b2, a1) * cross(b1, b2, a2) < 0)
    return true;
  const distance = (p: Point, [start, end]: readonly [Point, Point]) => {
    const dx = end.x - start.x,
      dy = end.y - start.y,
      t = Math.max(
        0,
        Math.min(1, ((p.x - start.x) * dx + (p.y - start.y) * dy) / (dx * dx + dy * dy || 1)),
      );
    return Math.hypot(p.x - start.x - t * dx, p.y - start.y - t * dy);
  };
  return Math.min(distance(a1, b), distance(a2, b), distance(b1, a), distance(b2, a)) <= padding;
}

function walkingIsNearby(
  model: MapModel,
  source: Point & { readonly id: string },
  peer: Point,
): boolean {
  const neighbourDistance = Math.min(
    ...model.stationList
      .filter((s) => s.id !== source.id)
      .map((s) => Math.hypot(s.x - source.x, s.y - source.y)),
  );
  const limit = Math.min(
    100,
    Number.isFinite(neighbourDistance) ? Math.max(80, neighbourDistance * 0.8) : 100,
  );
  return Math.hypot(peer.x - source.x, peer.y - source.y) <= limit;
}
