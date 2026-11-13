/**
 * Shared station marker dimensions in schematic units. The renderer draws the
 * outer outline from `outline`; label leaders clip to `leaderOutline`, which
 * sits just inside the stroked edge so the leader meets the visible marker.
 * Resize both together.
 */
export interface StationPillShape {
  readonly halfWidth: number;
  readonly halfHeight: number;
  readonly cornerRadius: number;
}

export const STATION_DOT_RADIUS = 6.2;
export const STATION_DOT_LEADER_RADIUS = 4.8;

const PILL_SHAPES = {
  major: {
    outline: { halfWidth: 10, halfHeight: 20, cornerRadius: 9 },
    leaderOutline: { halfWidth: 8.9, halfHeight: 17.9, cornerRadius: 8.9 },
  },
  minor: {
    outline: { halfWidth: 7, halfHeight: 12, cornerRadius: 5 },
    leaderOutline: { halfWidth: 6.2, halfHeight: 10.7, cornerRadius: 4.7 },
  },
} as const satisfies Record<
  string,
  { readonly outline: StationPillShape; readonly leaderOutline: StationPillShape }
>;

/** A hub served by four or more lines draws the enlarged pill. */
export function isMajorHub(lines: readonly unknown[]): boolean {
  return lines.length >= 4;
}

export function stationPillShape(lines: readonly unknown[]) {
  return isMajorHub(lines) ? PILL_SHAPES.major : PILL_SHAPES.minor;
}
