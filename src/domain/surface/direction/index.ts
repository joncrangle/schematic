/**
 * Direction seam for Surface Transit.
 *
 * Single home for direction + ETA vocabulary: compass words, headsign
 * parsing, direction-id resolution, direction options/labels, compass
 * presentation meta, and approaching-vehicle ETA derivation. Pure functions
 * only, no effects, no manifest imports.
 *
 * Co-located direction vocab (R1): getRouteDirections, inferRouteHeadsign,
 * enrichRouteDirections, and applyParsedHeadsign ride with this seam because
 * buildDirectionOptions/buildDirectionLabels are defined in terms of them;
 * splitting them would reintroduce the fragmentation this seam removes.
 * Corridor geometry (stop-index resolution, vehicle indexing, closest-vehicle
 * selection, corridor ordering) stays in `~/domain/surface/corridor`.
 */
export type {
  DirectionAxis,
  GeneratedDirectionLabel,
  ParsedHeadsign,
  RiderStop,
  RouteDirectionOption,
} from "./types";
export {
  directionIdForLabel,
  directionLabelFor,
  directionSemanticForCanonicalLabel,
  directionSemanticForPath,
  generatedDirectionLabelText,
  isGeneratedDirectionLabel,
  oppositeDirectionLabel,
} from "./compass";
export { parseHeadsign, scheduledHeadsignDestination, statedCompassLabel } from "./headsign";
export { resolveDirectionId } from "./resolve";
export {
  applyParsedHeadsign,
  buildDirectionLabels,
  buildDirectionOptions,
  getRouteDirectionsForRoute,
  enrichRouteDirections,
  getRouteDirections,
  inferRouteHeadsign,
  isNorthSouthDirectionIdsInverted,
  resolveDirectionAxis,
} from "./options";
export { COLLAPSED_TRACKING_MAX_AGE_MS, deriveApproachingVehicleEtas } from "./eta";
export { getDirectionCompassMeta } from "./compassMeta";
