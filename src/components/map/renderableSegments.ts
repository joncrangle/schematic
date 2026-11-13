import {
  excludeReducedSpeedZones,
  type MapProjection,
  type StatusOverlaySegment,
} from "~/core/map";

/**
 * Layer ordering for status overlays, lowest first: upcoming
 * segments sit beneath reduced-speed zones, delays above those, severe
 * closures on top.
 */
const SEGMENT_LAYER_ORDER: Record<StatusOverlaySegment["kind"], number> = {
  upcoming: 1,
  rsz: 2,
  delay: 3,
  severe: 4,
};

/**
 * The segments the map may draw for the current preferences: honours the
 * reduced-speed-zone gate and orders what survives by layer rank
 *.
 */
export function renderableSegments(
  projection: MapProjection,
  prefs: { showReducedSpeedZones: boolean },
): readonly StatusOverlaySegment[] {
  const visible = prefs.showReducedSpeedZones
    ? projection.statusOverlaySegments
    : excludeReducedSpeedZones(projection).statusOverlaySegments;

  return [...visible].sort((a, b) => SEGMENT_LAYER_ORDER[a.kind] - SEGMENT_LAYER_ORDER[b.kind]);
}
