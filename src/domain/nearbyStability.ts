import type { NearbyDirectionInfo, NearbyRouteArrival } from "~/domain/surface/types";
import type { NearbyStationArrival } from "~/domain/surface/types";
import { areAgencyAlertsEqual } from "~/lib/routeMemoComparators";
import { calculateHaversineMeters } from "./map/MapGeometry";
import { routeIdsMatch } from "./surface/routeIds";

/**
 * Rendered-relevance comparators and list transforms for the Nearby panel.
 *
 * The solid-query adapter force-disables structural sharing, so identity
 * preservation across refetches is app-side: stableList reuses the previous
 * object whenever one of these comparators says the fresh payload would render
 * identically. A missed field means a needless card remount (countdown ticker
 * phase resets); an over-broad field means a stale card. Comparators cover
 * every rendered-relevant field, containers elementwise.
 *
 * Framework-free by design: no solid imports, pure data in / boolean out.
 */

function numberListEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/**
 * Absent directions equal only absent directions; present arrays compare
 * elementwise. An undefined-vs-present switch always means a re-render.
 */
function directionsEqual(
  a: readonly NearbyDirectionInfo[] | undefined,
  b: readonly NearbyDirectionInfo[] | undefined,
): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((direction, i) => directionInfoEqual(direction, b[i]!));
}

function directionInfoEqual(a: NearbyDirectionInfo, b: NearbyDirectionInfo): boolean {
  return (
    a.directionId === b.directionId &&
    a.headsign === b.headsign &&
    a.label === b.label &&
    a.generatedLabel === b.generatedLabel &&
    a.destination === b.destination &&
    a.directionInferred === b.directionInferred &&
    a.stopId === b.stopId &&
    a.stopName === b.stopName &&
    a.stopLat === b.stopLat &&
    a.stopLon === b.stopLon &&
    a.distanceMeters === b.distanceMeters &&
    a.walkingMinutes === b.walkingMinutes &&
    numberListEqual(a.arrivals, b.arrivals)
  );
}

/**
 * Full rendered-relevance equality for nearby route arrivals: every scalar the
 * card renders plus elementwise arrivals, directions (the old clones never
 * compared these at all), and alerts (the old clones compared length only).
 */
export function routeArrivalEqual(a: NearbyRouteArrival, b: NearbyRouteArrival): boolean {
  return (
    a.id === b.id &&
    a.routeId === b.routeId &&
    a.routeShortName === b.routeShortName &&
    a.routeLongName === b.routeLongName &&
    a.routeType === b.routeType &&
    a.agencyId === b.agencyId &&
    a.directionId === b.directionId &&
    a.headsign === b.headsign &&
    a.stopId === b.stopId &&
    a.stopName === b.stopName &&
    a.stopLat === b.stopLat &&
    a.stopLon === b.stopLon &&
    a.distanceMeters === b.distanceMeters &&
    a.walkingMinutes === b.walkingMinutes &&
    numberListEqual(a.arrivals, b.arrivals) &&
    directionsEqual(a.directions, b.directions) &&
    areAgencyAlertsEqual(a.alerts, b.alerts) &&
    a.arrivalsStale === b.arrivalsStale &&
    a.routeColor === b.routeColor &&
    a.routeTextColor === b.routeTextColor
  );
}

/**
 * Full rendered-relevance equality for nearby station arrivals, including
 * distanceMeters (the saved-stations clone skipped it entirely), lineIds, and
 * lineName (used for rail station-card titles).
 */
export function stationArrivalEqual(a: NearbyStationArrival, b: NearbyStationArrival): boolean {
  return (
    a.id === b.id &&
    a.livePredictionsOnly === b.livePredictionsOnly &&
    a.trackingRouteId === b.trackingRouteId &&
    a.stationName === b.stationName &&
    a.lineIds.length === b.lineIds.length &&
    a.lineIds.every((lineId, i) => lineId === b.lineIds[i]) &&
    a.lineName === b.lineName &&
    a.agencyId === b.agencyId &&
    a.routeType === b.routeType &&
    a.lat === b.lat &&
    a.lon === b.lon &&
    a.distanceMeters === b.distanceMeters &&
    a.walkingMinutes === b.walkingMinutes &&
    a.arrivalsStale === b.arrivalsStale &&
    a.arrivals.length === b.arrivals.length &&
    a.arrivals.every(
      (group, i) =>
        group.directionId === b.arrivals[i]?.directionId &&
        group.label === b.arrivals[i]?.label &&
        group.generatedLabel === b.arrivals[i]?.generatedLabel &&
        group.lineId === b.arrivals[i]?.lineId &&
        numberListEqual(group.times, b.arrivals[i]?.times ?? []),
    )
  );
}

/**
 * Removes items whose key appears in `ids`, preserving order and object
 * identity of everything kept. Used to dedupe saved items against the
 * nearby lists without disturbing stabilization state.
 */
export function excludeByIds<T>(
  items: readonly T[],
  ids: ReadonlySet<string>,
  getKey: (item: T) => string,
): readonly T[] {
  return items.filter((item) => !ids.has(getKey(item)));
}

/** Physical envelope used when two rail feeds describe one station differently. */
export const RAIL_COLOCATION_MAX_METERS = 150;
/** Physical envelope for bus stations/terminals where platforms and on-street bays differ. */
export const BUS_COLOCATION_MAX_METERS = 350;

/**
 * Identifies the same transit service when both nearby providers expose it:
 * a route card from the surface feed and a line-specific station card from a
 * station feed. The location guard is important because the same line can
 * legitimately appear at multiple nearby stops.
 */
export function isCoLocatedService(
  station: NearbyStationArrival,
  route: NearbyRouteArrival,
  maxDistanceMeters?: number,
): boolean {
  if (station.agencyId !== route.agencyId) return false;
  // Multi-line interchange stations should not be collapsed into a single route card.
  if (station.lineIds.length > 1) return false;
  const stationLat = station.lat;
  const stationLon = station.lon;
  if (
    typeof stationLat !== "number" ||
    !Number.isFinite(stationLat) ||
    typeof stationLon !== "number" ||
    !Number.isFinite(stationLon)
  ) {
    return false;
  }
  if (!station.lineIds.some((lineId) => routeIdsMatch(lineId, route.routeId))) return false;
  const threshold =
    maxDistanceMeters ??
    (station.routeType === "bus" || route.routeType === "bus"
      ? BUS_COLOCATION_MAX_METERS
      : RAIL_COLOCATION_MAX_METERS);
  return (
    calculateHaversineMeters(stationLat, stationLon, route.stopLat, route.stopLon) <= threshold
  );
}

// ---------------------------------------------------------------------------
// Multi-agency proximity ranking: 75 m bucketing + 4-tier priority
// ---------------------------------------------------------------------------

export const NEARBY_BUCKET_METERS = 75;

export function nearbyBucket(
  distanceMeters: number,
  bucketMeters: number = NEARBY_BUCKET_METERS,
): number {
  return Math.floor(distanceMeters / bucketMeters);
}

type RankableNearbyItem = NearbyRouteArrival | NearbyStationArrival;

function isStationArrival(item: RankableNearbyItem): boolean {
  return "stationName" in item;
}

function getNearbyTier(item: RankableNearbyItem, selectedAgencyId: string): number {
  const isStation = isStationArrival(item);
  const isRailRoute = !isStation && (item as NearbyRouteArrival).routeType === "rail";
  const isSelected = item.agencyId === selectedAgencyId;
  if (isSelected) {
    return isStation ? 1 : 2;
  }
  return isStation || isRailRoute ? 3 : 4;
}

function nearbyIdentity(item: RankableNearbyItem): string {
  if ("stationName" in item) return item.id;
  return (item as NearbyRouteArrival).routeId;
}

/**
 * Comparator implementing the 75 m bucket + 4-tier priority policy:
 * 1. bucket = floor(distance / 75) dominates
 * 2. four-tier agency/mode priority within the bucket
 * 3. raw distanceMeters within the tier
 * 4. stable identity (routeId / station id) for determinism
 */
export function compareNearbyRanking(
  a: RankableNearbyItem,
  b: RankableNearbyItem,
  selectedAgencyId: string,
  bucketMeters: number = NEARBY_BUCKET_METERS,
): number {
  const bucketA = nearbyBucket(a.distanceMeters, bucketMeters);
  const bucketB = nearbyBucket(b.distanceMeters, bucketMeters);
  if (bucketA !== bucketB) return bucketA - bucketB;
  const tierA = getNearbyTier(a, selectedAgencyId);
  const tierB = getNearbyTier(b, selectedAgencyId);
  if (tierA !== tierB) return tierA - tierB;
  if (a.distanceMeters !== b.distanceMeters) return a.distanceMeters - b.distanceMeters;
  return nearbyIdentity(a).localeCompare(nearbyIdentity(b));
}

export function sortNearbyByRanking(
  items: readonly RankableNearbyItem[],
  selectedAgencyId: string,
  bucketMeters: number = NEARBY_BUCKET_METERS,
): readonly RankableNearbyItem[] {
  return [...items].sort((a, b) => compareNearbyRanking(a, b, selectedAgencyId, bucketMeters));
}

/**
 * Favourites ordering: selected-agency favourites first, then nearest.
 * Used for both saved stations and saved surface routes.
 */
export function sortFavouritesByAgency<T extends { agencyId?: string; distanceMeters?: number }>(
  items: readonly T[],
  selectedAgencyId: string,
): readonly T[] {
  return [...items].sort((a, b) => {
    const aSel = a.agencyId === selectedAgencyId ? 0 : 1;
    const bSel = b.agencyId === selectedAgencyId ? 0 : 1;
    if (aSel !== bSel) return aSel - bSel;
    const da = a.distanceMeters ?? 0;
    const db = b.distanceMeters ?? 0;
    if (da !== db) return da - db;
    return 0;
  });
}
