import type {
  Point,
  PositionedInterchangeBadge,
  PositionedWalkingInterchangeMarker,
  StationInfo,
} from "./index";
import { isMajorHub, STATION_DOT_LEADER_RADIUS, stationPillShape } from "./station-marker-shape";

export interface LayoutRect {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

/** Clip the leader to the marker's stroked outline, including rounded pill corners. */
export function stationLabelLeaderStart(
  station: Pick<StationInfo, "x" | "y" | "labelX" | "labelY" | "isInterchange" | "lines">,
): Point | undefined {
  const dx = station.labelX - station.x;
  const dy = station.labelY - station.y;
  const length = Math.hypot(dx, dy);
  if (!length) return undefined;
  let distance = STATION_DOT_LEADER_RADIUS;
  if (station.isInterchange) {
    const {
      halfWidth,
      halfHeight,
      cornerRadius: radius,
    } = stationPillShape(station.lines).leaderOutline;
    let inside = 0;
    let outside = Math.hypot(halfWidth, halfHeight);
    for (let i = 0; i < 30; i++) {
      const middle = (inside + outside) / 2;
      const x = Math.abs((dx / length) * middle) - halfWidth + radius;
      const y = Math.abs((dy / length) * middle) - halfHeight + radius;
      const edge = Math.hypot(Math.max(x, 0), Math.max(y, 0)) + Math.min(Math.max(x, y), 0);
      if (edge <= radius) inside = middle;
      else outside = middle;
    }
    distance = outside;
  }
  if (length <= distance) return undefined;
  return { x: station.x + (dx / length) * distance, y: station.y + (dy / length) * distance };
}

/** Includes the badge's 1.1 focus enlargement, stroke, and breathing room. */
export function interchangeBadgeBounds(badge: PositionedInterchangeBadge): LayoutRect {
  const x = badge.x + badge.xOffsetFromCenter;
  const y = badge.y + badge.yOffsetFromCenter;
  return {
    minX: x - badge.width * 0.05 - 3,
    maxX: x + badge.width * 1.05 + 3,
    minY: y - badge.height * 0.55 - 3,
    maxY: y + badge.height * 0.55 + 3,
  };
}

/** The renderer and offline placement use the same peer label and walk caption. */
export function walkingStationLabel(marker: PositionedWalkingInterchangeMarker) {
  return {
    labelX: marker.x,
    labelY: marker.y + (marker.y < marker.sourceY ? -32 : 32),
    labelRotation: 0,
    labelAnchor: "middle" as const,
    labelLeader: false,
  };
}

export function walkingLinkLabel(marker: PositionedWalkingInterchangeMarker): Point {
  const dx = marker.x - marker.sourceX;
  const dy = marker.y - marker.sourceY;
  const offset = (dx > 0 && dy > 0 ? -16 : 16) / Math.max(1, Math.hypot(dx, dy));
  return {
    x: (marker.x + marker.sourceX) / 2 + dy * offset,
    y: (marker.y + marker.sourceY) / 2 - dx * offset,
  };
}

/** Conservative ink bounds at the largest station focus state. */
export function stationNodeBounds(station: StationInfo): LayoutRect {
  const major = isMajorHub(station.lines);
  const halfWidth = station.isInterchange ? (major ? 14 : 10) : 8;
  const halfHeight = station.isInterchange ? (major ? 27 : 17) : 8;
  return {
    minX: station.x - halfWidth,
    maxX: station.x + halfWidth,
    minY: station.y - halfHeight,
    maxY: station.y + halfHeight,
  };
}

/** Text width is conservative; rotation is around the actual SVG label anchor. */
export function stationLabelBounds(
  station: Pick<
    StationInfo,
    "name" | "labelX" | "labelY" | "labelAnchor" | "labelRotation" | "labelLeader"
  >,
): LayoutRect {
  return textBounds(
    station.name,
    { x: station.labelX, y: station.labelY },
    station.labelAnchor,
    station.labelRotation,
    11,
    station.labelLeader ? 3 : 1,
  );
}

export function textBounds(
  text: string,
  point: Point,
  anchor: string,
  rotation: number,
  fontSize: number,
  padding = 1,
): LayoutRect {
  const corners = textPolygon(text, point, anchor, rotation, fontSize, padding);
  return {
    minX: Math.min(...corners.map((p) => p.x)),
    maxX: Math.max(...corners.map((p) => p.x)),
    minY: Math.min(...corners.map((p) => p.y)),
    maxY: Math.max(...corners.map((p) => p.y)),
  };
}

export function stationLabelPolygon(
  station: Pick<
    StationInfo,
    "name" | "labelX" | "labelY" | "labelAnchor" | "labelRotation" | "labelLeader"
  >,
): readonly Point[] {
  return textPolygon(
    station.name,
    { x: station.labelX, y: station.labelY },
    station.labelAnchor,
    station.labelRotation,
    11,
    station.labelLeader ? 3 : 1,
  );
}
function textPolygon(
  text: string,
  point: Point,
  anchor: string,
  rotation: number,
  fontSize: number,
  padding: number,
): readonly Point[] {
  const width = Math.max(fontSize, text.length * fontSize * 0.64);
  const left = (anchor === "middle" ? -width / 2 : anchor === "end" ? -width : 0) - padding;
  const right = left + width + padding * 2;
  const top = -fontSize / 2 - padding,
    bottom = fontSize / 2 + padding;
  const angle = (rotation * Math.PI) / 180;
  return [
    [left, top],
    [right, top],
    [right, bottom],
    [left, bottom],
  ].map(([x, y]) => ({
    x: point.x + x * Math.cos(angle) - y * Math.sin(angle),
    y: point.y + x * Math.sin(angle) + y * Math.cos(angle),
  }));
}
function rectPolygon(rect: LayoutRect): readonly Point[] {
  return [
    { x: rect.minX, y: rect.minY },
    { x: rect.maxX, y: rect.minY },
    { x: rect.maxX, y: rect.maxY },
    { x: rect.minX, y: rect.maxY },
  ];
}
export function rectangleIntersectsPolygon(rect: LayoutRect, polygon: readonly Point[]): boolean {
  return polygonsIntersect(rectPolygon(rect), polygon);
}
export function segmentIntersectsPolygon(
  start: Point,
  end: Point,
  polygon: readonly Point[],
  padding: number,
): boolean {
  const length = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y)),
    dx = ((end.y - start.y) * padding) / length,
    dy = ((start.x - end.x) * padding) / length;
  return polygonsIntersect(
    [
      { x: start.x + dx, y: start.y + dy },
      { x: end.x + dx, y: end.y + dy },
      { x: end.x - dx, y: end.y - dy },
      { x: start.x - dx, y: start.y - dy },
    ],
    polygon,
  );
}
function polygonsIntersect(first: readonly Point[], second: readonly Point[]): boolean {
  for (const polygon of [first, second])
    for (let i = 0; i < polygon.length; i++) {
      const a = polygon[i]!,
        b = polygon[(i + 1) % polygon.length]!;
      const axis = { x: a.y - b.y, y: b.x - a.x };
      const p = first.map((point) => point.x * axis.x + point.y * axis.y),
        q = second.map((point) => point.x * axis.x + point.y * axis.y);
      if (Math.max(...p) < Math.min(...q) || Math.max(...q) < Math.min(...p)) return false;
    }
  return true;
}

export function rectangleOverlapArea(first: LayoutRect, second: LayoutRect): number {
  return (
    Math.max(0, Math.min(first.maxX, second.maxX) - Math.max(first.minX, second.minX)) *
    Math.max(0, Math.min(first.maxY, second.maxY) - Math.max(first.minY, second.minY))
  );
}

export function segmentIntersectsRect(
  first: Point,
  second: Point,
  rect: LayoutRect,
  padding = 0,
): boolean {
  // Liang-Barsky clipping also handles vertical, horizontal and zero-length links.
  let near = 0,
    far = 1;
  const dx = second.x - first.x,
    dy = second.y - first.y;
  for (const [p, q] of [
    [-dx, first.x - rect.minX + padding],
    [dx, rect.maxX - first.x + padding],
    [-dy, first.y - rect.minY + padding],
    [dy, rect.maxY - first.y + padding],
  ]) {
    if (p === 0) {
      if (q < 0) return false;
    } else if (p < 0) near = Math.max(near, q / p);
    else far = Math.min(far, q / p);
    if (near > far) return false;
  }
  return true;
}
