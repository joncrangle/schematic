import type { WheelchairBoarding } from "./types";

/**
 * Normalizes GTFS wheelchair_boarding to 0 (unknown), 1 (accessible), or
 * 2 (inaccessible). All other inputs normalize to 0.
 */
export function normalizeWheelchairBoarding(value: unknown): WheelchairBoarding {
  return (value === 1 ? 1 : value === 2 ? 2 : 0) as WheelchairBoarding;
}
