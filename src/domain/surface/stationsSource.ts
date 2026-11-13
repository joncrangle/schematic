import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { NearbyStationArrival } from "./types";

/**
 * Core stations seam.
 *
 * A StationsSource answers the nearby/saved subway-stations panel for one
 * agency: proximity-ranked stations with per-direction live arrivals. It is
 * the provider contract member that lets Core own the panel while each
 * subway-mode agency supplies its own adapter (TTC: GTFS-RT entity-id grammar
 * + static station index), mirroring the TopologySource/RealtimeSource seams.
 *
 * Failure is honest: feed or index failures reject with StationsError
 * (tagged, carrying agencyId) so TanStack Query surfaces real errors instead
 * of fabricated empty panels.
 */

export class StationsError extends Data.TaggedError("StationsError")<{
  readonly agencyId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface NearbyStationsQuery {
  readonly lat: number;
  readonly lon: number;
  /** Pre-clamped search radius in meters (1.5 km ceiling). */
  readonly radiusMeters: number;
}

export interface SavedStationsQuery {
  /** Favourite station names as stored in user preferences. */
  readonly stationNames: readonly string[];
  /** Rider location when known; favourites render without it. */
  readonly lat?: number;
  readonly lon?: number;
}

export interface StationDeparturesQuery {
  /**
   * Schematic station ids as held by the map (`StationInfo.id`). Index
   * entries resolve through `schematicId ?? id`: schematics never reuse the
   * index id directly (verified for every station agency), so callers must
   * pass map identity, never card identity (`${id}:${lineId}` splits).
   */
  readonly stationIds: readonly string[];
  /** Rider location when known; departures render without it. */
  readonly lat?: number;
  readonly lon?: number;
}

/** One agency's station-proximity answers for the Core-owned panel. */
export interface StationsSource {
  readonly fetchNearby: (
    query: NearbyStationsQuery,
  ) => Effect.Effect<readonly NearbyStationArrival[], StationsError>;
  readonly fetchSaved: (
    query: SavedStationsQuery,
  ) => Effect.Effect<readonly NearbyStationArrival[], StationsError>;
  readonly fetchByIds: (
    query: StationDeparturesQuery,
  ) => Effect.Effect<readonly NearbyStationArrival[], StationsError>;
}
