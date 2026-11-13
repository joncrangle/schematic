import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { SurfaceRouteType } from "./types";

/**
 * Core surface topology seam over D1.
 *
 * A TopologySource supplies the *static* surface network for one agency:
 * every route's identity, polyline, and ordered stops as materialized from
 * D1 (or asset/memory). It is the smallest honest seam that lets a new
 * agency arrive as manifest + adapter, no Core file needs an `if (agencyId)`
 * branch.
 *
 * Failure is honest: a missing D1 table is an error, not an empty
 * list. Realtime degradation is owned by the nearby transit service, the
 * single degradation point.
 */

export class TopologyError extends Data.TaggedError("TopologyError")<{
  readonly agencyId: string;
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface StopTopology {
  readonly id: string;
  readonly code?: string;
  readonly name: string;
  readonly lat: number;
  readonly lon: number;
  readonly wheelchair?: number;
  /** Feed-owned display fallback, not used for topology identity. */
  readonly parentStation?: string;
  /** Repository-owned station identity used for topology joins. */
  readonly parentStationId?: string;
}

export interface RouteTopology {
  readonly routeId: string;
  readonly shortName: string;
  readonly longName: string;
  readonly color: string;
  readonly textColor: string;
  readonly routeType: SurfaceRouteType;
  readonly polyline: string;
  readonly directionId: number;
  readonly headsign: string;
  /** D4: canonical directional label derived server-side via buildDirectionLabels (nullable until backfill). */
  readonly directionLabel?: string;
  readonly stops: readonly StopTopology[];
}

/**
 * Static snapshot as seen by realtime: one agency's fused topology at a point
 * in time. Minimal normalized shape, no ServiceStatusWithGtfs, weekStartMs,
 * missingRoutes, or raw bytes cross the seam.
 */
export interface StaticSnapshot {
  readonly agencyId: string;
  readonly generatedAt: number;
  readonly routes: readonly RouteTopology[];
}

/**
 * Topology refresh TTL (7 days). Each topology source decides freshness
 * through shouldRefreshTopology (ADR-0005).
 */
export const TOPOLOGY_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export interface TopologyReader {
  readonly fetchTopology: () => Effect.Effect<StaticSnapshot, TopologyError>;
}

export interface TopologySource extends TopologyReader {
  /** Whether the adapter's persisted topology has exceeded its TTL or is absent. */
  readonly shouldRefreshTopology: () => Effect.Effect<boolean, TopologyError>;
  /** Refresh topology from upstream and persist to the adapter's store. */
  readonly syncTopology: () => Effect.Effect<void, TopologyError>;
}
