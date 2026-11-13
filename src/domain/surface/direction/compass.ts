/**
 * Compass-word vocabulary for Surface Transit directions.
 *
 * Single-sourced compass words: every compass word maps to its canonical
 * Directional Scope label (GLOSSARY.md). Pure domain logic, no effects.
 */

import type { GeneratedDirectionLabel } from "./types";

const DIRECTION_TEXT: Readonly<Record<GeneratedDirectionLabel, string>> = {
  northbound: "Northbound",
  southbound: "Southbound",
  eastbound: "Eastbound",
  westbound: "Westbound",
  outbound: "Outbound",
  inbound: "Inbound",
};

/** Runtime validation for direction provenance received from a transport. */
export function isGeneratedDirectionLabel(value: unknown): value is GeneratedDirectionLabel {
  return typeof value === "string" && Object.hasOwn(DIRECTION_TEXT, value);
}

/** English fallback text for a Core-generated semantic direction label. */
export function generatedDirectionLabelText(label: GeneratedDirectionLabel): string {
  return DIRECTION_TEXT[label];
}

/** Exact semantic identity for one of the canonical compass labels. */
export function directionSemanticForCanonicalLabel(
  label: string,
): GeneratedDirectionLabel | undefined {
  switch (label) {
    case "Northbound":
      return "northbound";
    case "Southbound":
      return "southbound";
    case "Eastbound":
      return "eastbound";
    case "Westbound":
      return "westbound";
    case "Outbound":
      return "outbound";
    case "Inbound":
      return "inbound";
    default:
      return undefined;
  }
}

/**
 * Single-sourced compass vocabulary: every compass word maps to its
 * canonical Directional Scope label (GLOSSARY.md).
 */
const COMPASS_LABELS: Readonly<Record<string, string>> = {
  n: "Northbound",
  s: "Southbound",
  e: "Eastbound",
  w: "Westbound",
  north: "Northbound",
  northbound: "Northbound",
  south: "Southbound",
  southbound: "Southbound",
  east: "Eastbound",
  eastbound: "Eastbound",
  west: "Westbound",
  westbound: "Westbound",
};

/**
 * Canonical directional labels mapped to their opposites ("Xbound" pairs).
 */
const OPPOSITE_DIRECTION_LABELS: Readonly<Record<string, string>> = {
  Northbound: "Southbound",
  Southbound: "Northbound",
  Eastbound: "Westbound",
  Westbound: "Eastbound",
};

/**
 * The compass label for a path's direction of travel, or "" when there is no
 * usable geometry.
 *
 * A shape runs from its first point to its last in the direction the vehicle
 * actually travels, so the bearing between those endpoints is the operator's
 * own statement of which way the trip goes. That is a different kind of fact
 * from a direction index, which carries no bearing at all, and it is what makes
 * a rail direction inferable when the headsign names only a terminal.
 *
 * Short paths and near-zero net displacement yield "", because the bearing of
 * a shape that barely moves is noise rather than a direction. Note this is the
 * bearing of the whole path, not of every point on it: a route that doubles
 * back is labelled for its net direction of travel.
 */
export function directionSemanticForPath(
  points: readonly (readonly [number, number])[],
): GeneratedDirectionLabel | undefined {
  if (points.length < 2) return undefined;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const [lat1, lon1] = first;
  const [lat2, lon2] = last;
  if (![lat1, lon1, lat2, lon2].every(Number.isFinite)) return undefined;
  // A path that returns near its origin has no net direction of travel.
  if (Math.abs(lat2 - lat1) < 1e-5 && Math.abs(lon2 - lon1) < 1e-5) return undefined;
  const meanLatitude = ((lat1 + lat2) / 2) * (Math.PI / 180);
  const eastwardDistance = (lon2 - lon1) * Math.cos(meanLatitude);
  const northwardDistance = lat2 - lat1;
  const degrees = (Math.atan2(eastwardDistance, northwardDistance) * 180) / Math.PI;
  const bearing = (degrees + 360) % 360;
  if (bearing < 45 || bearing >= 315) return "northbound";
  if (bearing < 135) return "eastbound";
  if (bearing < 225) return "southbound";
  return "westbound";
}

/**
 * Maps a raw compass word ("north", "northbound", any case) to its canonical
 * directional label; empty string when the word is not a compass word.
 */
export function directionLabelFor(word: string): string {
  return COMPASS_LABELS[word.trim().toLowerCase()] ?? "";
}

/**
 * Returns the opposing directional label ("Northbound" ↔ "Southbound",
 * "Eastbound" ↔ "Westbound"); empty string for unknown labels.
 */
export function oppositeDirectionLabel(label: string): string {
  return OPPOSITE_DIRECTION_LABELS[label] ?? "";
}

/**
 * Which of the canonical direction ids a compass label belongs to.
 *
 * A GTFS `direction_id` carries no bearing, so something has to decide whether
 * a stated word is the lower or the higher index. This is that decision, shared
 * by the stations source and NextBus parser so compass text maps to the same
 * feed ID in nearby and station panels.
 *
 * The split follows the axis: north and east are direction 0, south and west
 * are direction 1. A route manifest may reverse north/south feed IDs when an
 * operator uses the opposite ordering.
 */
const DIRECTION_ID_BY_COMPASS_LABEL: Readonly<Record<string, 0 | 1>> = {
  Northbound: 0,
  Eastbound: 0,
  Southbound: 1,
  Westbound: 1,
};

/**
 * The canonical direction id a compass label belongs to, or undefined when the
 * label is not a compass word and so states no direction at all.
 */
export function directionIdForLabel(label: string, invertNorthSouth = false): 0 | 1 | undefined {
  const directionId = DIRECTION_ID_BY_COMPASS_LABEL[label];
  if (
    invertNorthSouth &&
    directionId !== undefined &&
    (label === "Northbound" || label === "Southbound")
  ) {
    return directionId === 0 ? 1 : 0;
  }
  return directionId;
}
