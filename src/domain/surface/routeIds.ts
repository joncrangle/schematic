import type { RouteTopology } from "./topologySource";

/**
 * Compares feed route IDs with the canonical IDs declared by static topology.
 * Some GTFS feeds version route IDs (for example, `date-LW`) while exposing
 * the stable public line designator (`LW`) as `short_name`.
 */
export function canonicalRouteId(
  routeId: string | undefined,
  routes: readonly Pick<RouteTopology, "routeId" | "shortName">[],
): string | undefined {
  const value = routeId?.trim();
  if (!value) return undefined;
  const normalized = value.toUpperCase();
  const exact = routes.find(
    (route) =>
      route.routeId.toUpperCase() === normalized || route.shortName.toUpperCase() === normalized,
  );
  if (exact) return exact.routeId;

  const suffix = normalized.slice(normalized.lastIndexOf("-") + 1);
  const suffixed = routes.find((route) => route.shortName.toUpperCase() === suffix);
  return suffixed?.routeId;
}

export function routeIdsMatch(left: string | undefined, right: string | undefined): boolean {
  const leftValue = left?.trim().toUpperCase();
  const rightValue = right?.trim().toUpperCase();
  if (!leftValue || !rightValue) return false;
  return (
    leftValue === rightValue ||
    leftValue.slice(leftValue.lastIndexOf("-") + 1) === rightValue ||
    rightValue.slice(rightValue.lastIndexOf("-") + 1) === leftValue
  );
}

/**
 * Translates a raw GTFS-RT route ID through an agency's manifest map to the
 * canonical agency-local route ID. Mirrors station interpretation
 * (`genericStationsSource`): exact hit first, then the dash-suffix form, each
 * with a lowercase fallback. No mapping means trim identity.
 *
 * One translation, one place: the realtime source normalises vehicle and
 * arrival route IDs through it, and the map shell resolves the line it is
 * drawing through it, so a route cannot be folded for one and not the other.
 */
export function translateRawRouteId(
  routeId: string,
  routeLineMap: Readonly<Record<string, string>> | undefined,
): string {
  const trimmed = routeId.trim();
  if (!trimmed || !routeLineMap) return trimmed;
  const direct = routeLineMap[trimmed] ?? routeLineMap[trimmed.toLowerCase()];
  if (direct?.trim()) return direct.trim();
  const stripped = trimmed.slice(trimmed.lastIndexOf("-") + 1).trim();
  if (stripped !== trimmed) {
    const viaSuffix = routeLineMap[stripped] ?? routeLineMap[stripped.toLowerCase()];
    if (viaSuffix?.trim()) return viaSuffix.trim();
  }
  return trimmed;
}
