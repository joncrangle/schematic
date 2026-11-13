import type { RouteInterpretationConfig } from "~/agencies";
import type { AgencyAlert, FreshnessState } from "~/agencies/types";
import type { GeneratedDirectionLabel } from "./direction/types";

/**
 * Route modes used across static topology, route tracking, and station cards.
 * Subway remains a first-class mode because station cards can expose the same
 * route-tracking strip as surface cards.
 */
export type SurfaceRouteType = "bus" | "streetcar" | "express" | "rail" | "subway" | "ferry";

export const DEFAULT_SURFACE_ROUTE_COLOR = "#64748B";

/**
 * Mode theme colors.
 */
export const SURFACE_MODE_COLORS: Record<SurfaceRouteType, string> = {
  streetcar: DEFAULT_SURFACE_ROUTE_COLOR,
  express: "#15803d",
  bus: DEFAULT_SURFACE_ROUTE_COLOR,
  rail: "#00853F",
  subway: DEFAULT_SURFACE_ROUTE_COLOR,
  ferry: "#746661",
};

/**
 * Infers surface route type from route ID number range.
 * Generic Core utility, TTC's 500-514 streetcar and 900-999 express ranges
 * are extracted as reusable helpers so YRT/GO do not duplicate magic numbers.
 * Agencies with Viva/express BRT branding re-use `isExpressRoute` (modifier)
 * rather than duplicating a separate mode.
 */
export function inferRouteType(
  routeId: string,
  policy?: RouteInterpretationConfig,
): SurfaceRouteType {
  const numericId = Number(routeId);
  const rule = policy?.routeTypeRules?.find((candidate) => {
    if (candidate.routeIds?.includes(routeId)) return true;
    if (!Number.isFinite(numericId)) return false;
    if (candidate.minId !== undefined && numericId < candidate.minId) return false;
    if (candidate.maxId !== undefined && numericId > candidate.maxId) return false;
    return candidate.minId !== undefined || candidate.maxId !== undefined;
  });
  return rule?.routeType ?? "bus";
}

/** Name-contains-express check, generic modifier detection across agencies. */
function isExpressRouteName(name: string | undefined): boolean {
  return typeof name === "string" && /express/i.test(name);
}

/**
 * Express as modifier, Core generic helper.
 * A route is express if its stored type is `express` OR its name/description
 * contains "express" (case-insensitive).
 * This lets YRT Viva (route_type 3 with "Viva" branding) be flagged via name
 * without a separate route_type.
 */
export function isExpressRoute(
  route: Pick<SurfaceRoute, "id" | "routeType" | "shortName" | "longName"> & {
    readonly isExpress?: boolean;
  },
): boolean {
  if (route.isExpress === true) return true;
  if (route.routeType === "express") return true;
  if (isExpressRouteName(route.shortName) || isExpressRouteName(route.longName)) return true;
  return false;
}

/**
 * Infers direction ID from vehicle bearing using the provider's declared
 * orientation policy. Generic feeds use the east-west convention.
 */
export function inferDirectionFromBearing(
  routeId: string,
  bearing?: number,
  policy?: RouteInterpretationConfig,
): 0 | 1 {
  if (bearing === undefined || isNaN(bearing)) return 0;
  const b = ((bearing % 360) + 360) % 360;

  const mode =
    policy?.directionInference?.routeOverrides?.[routeId] ??
    policy?.directionInference?.default ??
    "east-west";
  if (mode === "north-south") {
    // Core convention: Direction 0 = Northbound, Direction 1 = Southbound.
    // Use the north/south component of the bearing. Eastbound and westbound
    // headings are ties, so they stay with Core's direction 0 default.
    const directionId: 0 | 1 = b <= 90 || b >= 270 ? 0 : 1;
    return policy?.directionInference?.invertNorthSouth ? (directionId === 0 ? 1 : 0) : directionId;
  }

  // Direction 0 = Eastbound (0° to 180°), Direction 1 = Westbound (180° to 360°).
  return b >= 0 && b < 180 ? 0 : 1;
}

/**
 * GTFS wheelchair accessibility code:
 * 0 = unknown, 1 = accessible, 2 = inaccessible.
 */
export type WheelchairBoarding = 0 | 1 | 2;

/**
 * Static route definition.
 * `isExpress` is the modifier-pattern flag: when true the route
 * renders with the express tint regardless of underlying `routeType` (bus/rail).
 * Persisted routes that already use `routeType: "express"` (TTC 900 series)
 * are still considered express via `isExpressRoute()` without requiring a DB
 * migration; new agencies set `routeType: "bus"` + `isExpress: true` via name.
 */
export interface SurfaceRoute {
  readonly id: string;
  readonly shortName: string;
  readonly longName: string;
  readonly routeType: SurfaceRouteType;
  readonly color: string;
  readonly textColor: string;
  readonly isExpress?: boolean;
}

/**
 * Static physical surface stop / platform.
 */
export interface SurfaceStop {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly wheelchair: WheelchairBoarding;
  /** Feed-owned display fallback, retained for presentation only. */
  readonly parentStation?: string;
  /** Repository-owned station identity used for topology and map anchoring. */
  readonly parentStationId?: string;
  readonly routes: readonly string[];
}

/**
 * Proximity query result for a single stop.
 */
export interface NearbyStopResult {
  readonly stop: SurfaceStop;
  readonly distanceMeters: number;
  readonly walkingMinutes: number;
}

/**
 * Spatial bounding box coordinates.
 */
export interface BoundingBox {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
}

/**
 * Simplified route polyline shape and precomputed bounding box.
 */
export interface RouteShape {
  readonly id: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly headsign: string;
  readonly polyline: string;
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLon: number;
  readonly maxLon: number;
  readonly pointCount: number;
  /** Canonical directional label derived server-side from headsign + direction_id via agency literals (D4). Additive; nullable until backfill completes. */
  readonly directionLabel?: string;
}

/**
 * Complete route topology for Phase 7 (Targeted Route View).
 */
export interface RouteDetails {
  readonly route: SurfaceRoute;
  readonly shape: RouteShape;
  readonly stops: readonly SurfaceStop[];
}

/**
 * Ordered stop sequence along a route direction pattern.
 */
export interface RouteStopAssociation {
  readonly routeId: string;
  readonly directionId: number;
  readonly stopSequence: number;
  readonly stopId: string;
}

/**
 * Realtime GTFS-RT arrival prediction for a trip at a given stop.
 */
export interface ArrivalPrediction {
  /** The final call in a feed explicitly declared to publish complete trips. */
  readonly isTerminalCall?: boolean;
  readonly tripId: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly vehicleId?: string;
  readonly stopSequence: number;
  readonly stopId?: string;
  readonly predictedTime: number; // Epoch ms
  readonly delaySeconds: number;
  readonly scheduleRelationship: "SCHEDULED" | "ADDED" | "SKIPPED" | "NO_DATA";
  readonly isRealtime: boolean;
  /** The upstream explicitly confirms boarding at this call, including a loop origin. */
  readonly departureConfirmed?: boolean;
  /** The feed supplies destination names but its numeric direction IDs carry no compass meaning. */
  readonly headsignPreferred?: boolean;
  /**
   * Destination display from the stop update (`stop_headsign`): the terminal
   * the trip is travelling to. Absent when the feed omits it. Station groups
   * qualify colliding direction labels with it ("Northbound to Aldershot");
   * nothing else reads it, so feeds without headsigns behave exactly as
   * before.
   */
  readonly headsign?: string;
  /**
   * Additive fusion marker: freshness of the source that served this
   * prediction. Absent (= live) when fetched from upstream in this call;
   * "stale" when re-served from the repository's last-good cache after an
   * upstream RealtimeError.
   */
  readonly freshness?: VehicleFeedFreshness;
  /**
   * Raw FeedEntity.id before TripDescriptor overwrites it as tripId. The
   * subway trips feed encodes travel direction only here
   * ("subway-{trip_id}|{South|North|East|West}"), so subway consumers parse
   * direction from this suffix; surface decoding leaves it undefined-agnostic.
   */
  readonly rawEntityId?: string;
  /**
   * True when the feed published no direction and the adapter inferred
   * `directionId` from other evidence (a vehicle bearing, schematic topology)
   * rather than reading it from the operator.
   *
   * This exists because an inferred id renders as a confident compass word.
   * Tmix states no direction anywhere, so its departures would otherwise show
   * as "Northbound" for buses described by a terminal headsign —
   * a specific claim the feed never made. Where this is set, the agency
   * headsign is the operator's own answer and outranks the inferred word.
   *
   * Absent (= false) means the feed genuinely established the direction, which
   * is the case for every GTFS-RT feed and therefore the behaviour of record.
   * Set only where inference happened; never set it to soften a real id.
   */
  readonly directionInferred?: boolean;
  /** An operator-stated direction must not be replaced by schematic endpoint geometry. */
  readonly directionAuthoritative?: boolean;
}

/**
 * Vehicle occupancy levels per GTFS-RT v2.
 */
export type OccupancyStatus =
  | "EMPTY"
  | "MANY_SEATS_AVAILABLE"
  | "FEW_SEATS_AVAILABLE"
  | "STANDING_ROOM_ONLY"
  | "CRUSHED_STANDING_ROOM_ONLY"
  | "FULL"
  | "NOT_ACCEPTING_PASSENGERS";

/**
 * Vehicle stop status relative to currentStopSequence / stopId.
 */
export type VehicleStopStatus = "INCOMING_AT" | "STOPPED_AT" | "IN_TRANSIT_TO";

/**
 * Freshness vocabulary for fused vehicle feeds. Reuses the shared snapshot
 * freshness thresholds (via `calculateFreshness`) minus "unavailable": a
 * fused vehicle always carries a source timestamp, so the marker is simply
 * omitted when that timestamp carries no usable epoch value.
 */
export type VehicleFeedFreshness = Exclude<FreshnessState, "unavailable">;

/**
 * Live vehicle position entity parsed from GTFS-RT /vehicles/position.
 */
export interface LiveVehiclePosition {
  readonly vehicleId: string;
  readonly routeId: string;
  readonly directionId: number;
  readonly tripId?: string;
  readonly latitude: number;
  readonly longitude: number;
  readonly bearing?: number; // 0-360 degrees
  readonly speed?: number; // meters/sec
  readonly currentStopSequence?: number;
  readonly stopId?: string;
  readonly currentStatus?: VehicleStopStatus;
  readonly occupancyStatus?: OccupancyStatus;
  readonly timestamp: number; // Epoch ms
  /**
   * Additive fusion marker: freshness of the winning feed timestamp
   * (live/recent/stale per the shared calculateFreshness thresholds).
   * Absent when no usable epoch value exists to derive it from.
   */
  readonly freshness?: VehicleFeedFreshness;
}

/**
 * Composite route tracking data combining static topology, live vehicle fleet,
 * and active GTFS-RT service alerts matched to this surface route.
 */
export interface RouteTrackingData {
  /** The operator publishes live vehicle fixes without stop-call predictions. */
  readonly vehiclePositionsOnly?: boolean;
  readonly vehiclePositionsFreshness?: "live" | "stale" | "unavailable";
  readonly route: SurfaceRoute;
  readonly shape: RouteShape;
  readonly stops: readonly SurfaceStop[];
  readonly vehicles: readonly LiveVehiclePosition[];
  readonly alerts: readonly AgencyAlert[];
  /** Feed-declared direction groups, independent of headsign availability. */
  readonly availableDirectionIds?: readonly number[];
  readonly directionLabels?: Record<
    number,
    {
      readonly label: string;
      readonly destination: string;
      readonly generatedLabel?: GeneratedDirectionLabel;
    }
  >;
}

/**
 * In-memory surface transit cache state snapshot.
 */
export interface SurfaceTransitState {
  readonly generatedAt: number;
  readonly feedTimestamp: number;
  readonly stopArrivals: ReadonlyMap<string, readonly ArrivalPrediction[]>;
  readonly routeVehicles?: ReadonlyMap<string, readonly LiveVehiclePosition[]>;
  readonly activeTripCount: number;
  readonly etags: {
    readonly tripUpdates?: string;
    readonly vehiclePositions?: string;
  };
  /**
   * True once every upstream poll has failed consecutively past the
   * degradation threshold: the state still carries last-known data,
   * but it must no longer present as fresh.
   */
  readonly degraded?: boolean;
}

/**
 * Proximity RPC input query parameters.
 */
export interface GetNearbyTransitInput {
  readonly lat: number;
  readonly lon: number;
  readonly radius?: number; // default 500m
}

/**
 * Direction-specific arrival and stop information for a nearby surface route.
 */
export interface NearbyDirectionInfo {
  readonly directionId: number;
  readonly headsign: string;
  readonly label: string; // "Northbound", "Eastbound", etc.
  /** Present only when the application generated the label from defaults or shape geometry. */
  readonly generatedLabel?: GeneratedDirectionLabel;
  readonly destination: string; // Real destination from routeConfig (e.g. "Steeles Ave")
  /**
   * True when the realtime wire named no direction, so which of a route's
   * declared groups a departure belongs to is Core's attribution rather than
   * the operator's statement. That is a fact about the wire, not about the
   * label: a label read from the route's own shape geometry is the operator's
   * geometry and is rendered regardless of this flag, because the shape runs
   * first point to last point in the direction the vehicle travels.
   *
   * What must be withheld is a direction Core derived from a direction index,
   * which carries no bearing at all. `label` carries that distinction itself:
   * it is empty when nothing was stated, so an empty label plus this flag is
   * the only combination that means "we do not know which way this goes."
   *
   * Absent (= false) means the feed named a direction.
   */
  readonly directionInferred?: boolean;
  readonly stopId: string;
  readonly stopName: string;
  readonly stopLat: number;
  readonly stopLon: number;
  readonly distanceMeters: number;
  readonly walkingMinutes: number;
  readonly arrivals: readonly number[]; // Next 3 arrival epoch ms timestamps
}

/**
 * Final client-facing nearby arrival card data structure.
 */
export interface NearbyRouteArrival {
  readonly id: string;
  readonly routeId: string;
  readonly routeShortName: string;
  readonly routeLongName: string;
  readonly routeType: SurfaceRouteType;
  readonly agencyId: string;
  readonly directionId: number;
  readonly headsign: string;
  readonly stopId: string;
  readonly stopName: string;
  readonly stopLat: number;
  readonly stopLon: number;
  readonly distanceMeters: number;
  readonly walkingMinutes: number;
  readonly arrivals: readonly number[]; // Next 3 arrival epoch ms timestamps
  readonly directions?: readonly NearbyDirectionInfo[]; // Direction-specific information
  readonly alerts: readonly AgencyAlert[]; // Active detour/delay alerts
  /**
   * True while the realtime feed is degraded: countdowns are derived
   * from last-known data and must not present as live.
   */
  readonly arrivalsStale?: boolean;
  readonly routeColor?: string;
  readonly routeTextColor?: string;
}

/** One direction's upcoming subway departures at a nearby station. */
export interface NearbyStationArrivalGroup {
  /** 0 = East/Northbound, 1 = West/Southbound (TTC convention). */
  readonly directionId: 0 | 1;
  readonly label: string; // "Southbound", ...
  /** Present only when the application generated this fallback direction label. */
  readonly generatedLabel?: GeneratedDirectionLabel;
  /** Up to three next arrival epoch-ms timestamps, ascending. */
  readonly times: readonly number[];
  /** Optional line ID representing this direction's service (e.g. "1", "2"). */
  readonly lineId?: string;
}

/**
 * Subway station arrivals for the Nearby panel: agency-neutral card
 * shape; providers own the feed parsing that fills it.
 */
export interface NearbyStationArrival {
  /** Source predicts tracked trains only; absence does not mean no scheduled service. */
  readonly livePredictionsOnly?: boolean;
  /** Canonical feed route for expansion when map line IDs differ. */
  readonly trackingRouteId?: string;
  readonly id: string;
  readonly stationName: string;
  readonly lineIds: readonly string[];
  /** Schematic-declared name for the line represented by this card. */
  readonly lineName?: string;
  readonly agencyId: string;
  /** Mode of the line represented by this station card's lineIds. */
  readonly routeType?: SurfaceRouteType;
  /** Geographic anchor used to center a cross-agency horizontal route strip. */
  readonly lat?: number;
  readonly lon?: number;
  readonly distanceMeters: number;
  readonly walkingMinutes: number;
  readonly arrivals: readonly NearbyStationArrivalGroup[];
  /** True when arrivals came from the station source's last-known snapshot. */
  readonly arrivalsStale?: boolean;
}

/** Route-metadata requests cost one database read per id, so each is bounded. */
export const MAX_ROUTES_METADATA_IDS = 100;
