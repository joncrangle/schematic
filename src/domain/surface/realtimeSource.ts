import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { ArrivalPrediction, LiveVehiclePosition } from "./types";
import type { StaticSnapshot } from "./topologySource";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";

/**
 * Core surface realtime seam over D1.
 *
 * A RealtimeSource supplies the *live* surface fleet for one agency,
 * normalized from whatever upstream that agency speaks (TTC: NextBus +
 * GTFS-RT TripUpdates/VehiclePositions; GO: GTFS-RT only). It receives the
 * caller's already-resolved topology so it can filter / enrich without
 * re-fetching it.
 *
 * Failure is honest: fetchRealtime rejects with RealtimeError (tagged,
 * carrying agencyId) so the repository can degrade to STALE with last-good.
 */

export class RealtimeError extends Data.TaggedError("RealtimeError")<{
  readonly agencyId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface RealtimeSnapshot {
  readonly agencyId: string;
  readonly updatedAt: number;
  /** True when one or more requested feed sources could not be read completely. */
  readonly partial?: boolean;
  readonly vehicles: readonly LiveVehiclePosition[];
  readonly arrivals: readonly ArrivalPrediction[];
}

export interface RealtimeFetchOptions {
  /** Vehicle-only consumers must not trigger per-stop departure polling. */
  readonly vehiclesOnly?: boolean;
  /** Optional per-invocation subrequest ceiling for bounded vendor fan-outs. */
  readonly maxSubrequests?: number;
  /** Single-flight cache shared by sources polled within one request. */
  readonly requestCache?: RequestScopedEffectCache;
  /** Optional route allowlist for proximity queries. */
  readonly routeIds?: ReadonlySet<string>;
  /** Optional stop allowlist for proximity arrival queries. */
  readonly stopIds?: ReadonlySet<string>;
  /** Route-scoped stop allowlists for proximity arrival queries. */
  readonly stopIdsByRoute?: ReadonlyMap<string, ReadonlySet<string>>;
}

export interface RealtimeSource {
  readonly fetchRealtime: (
    topology: StaticSnapshot,
    options?: RealtimeFetchOptions,
  ) => Effect.Effect<RealtimeSnapshot, RealtimeError>;
}
