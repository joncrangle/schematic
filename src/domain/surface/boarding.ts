import type * as Effect from "effect/Effect";
import type { ArrivalPrediction } from "./types";

/** The final scheduled call of a static GTFS trip. */
export interface TripTerminal {
  readonly stopId: string;
  readonly stopSequence: number;
  /** The destination the trip's sign states in the static feed, when it states one. */
  readonly headsign?: string;
}

export type TripTerminalLookup = (
  routeId: string,
  tripIds: readonly string[],
) => Effect.Effect<ReadonlyMap<string, TripTerminal>, unknown>;

export type TripDirectionLookup = (
  routeId: string,
  tripIds: readonly string[],
) => Effect.Effect<ReadonlyMap<string, number>, unknown>;

/** Static route identity for a trip whose realtime descriptor omits its route. */
export interface TripRoute {
  readonly routeId: string;
  readonly directionId: number;
}
export type TripRouteLookup = (
  tripIds: readonly string[],
) => Effect.Effect<ReadonlyMap<string, TripRoute>, unknown>;

/**
 * Unknown trips stay visible. A canonical route shape cannot prove their end.
 *
 * The terminal is compared against the prediction's own stop, never against a
 * station's wider set of stops. A station groups its platforms under one
 * parent, so matching any platform in that group would silence a through
 * vehicle standing at a sibling platform the rider can still board.
 */
export function isTerminatingPrediction(
  prediction: ArrivalPrediction,
  terminal: TripTerminal | undefined,
): boolean {
  if (prediction.isTerminalCall !== undefined) return prediction.isTerminalCall;
  if (prediction.departureConfirmed === true) return false;
  if (!terminal || terminal.stopId !== prediction.stopId) return false;
  // A loop may call at its terminal before its final lap. Feeds without
  // sequences still identify the terminal call by stop id.
  return prediction.stopSequence <= 0 || prediction.stopSequence >= terminal.stopSequence;
}

/** Seeded membership used to scope shared upstream alert selectors. */
export interface SourceAgencyScope {
  readonly agencyIds: ReadonlySet<string>;
  readonly directionsByRoute?: ReadonlyMap<string, number>;
  readonly routesByShortName?: ReadonlyMap<string, readonly string[]>;
  readonly stopsByCode?: ReadonlyMap<string, readonly string[]>;
  readonly routeIds: ReadonlySet<string>;
  readonly stopIds: ReadonlySet<string>;
}
export type SourceAgencyScopeLookup = () => Effect.Effect<
  Omit<SourceAgencyScope, "agencyIds">,
  unknown
>;
