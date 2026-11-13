import type * as Effect from "effect/Effect";

export interface ScheduledStopRequest {
  readonly tripId: string;
  readonly routeId: string;
  readonly stopSequence: number;
  readonly stopId?: string;
  readonly startDate?: string;
  readonly startTime?: string;
}
export interface ScheduledStopTime {
  readonly stopId: string;
  readonly arrivalTime?: number;
  readonly departureTime?: number;
}
export type ScheduledStopLookup = (
  requests: readonly ScheduledStopRequest[],
) => Effect.Effect<ReadonlyMap<string, ScheduledStopTime>, unknown>;
export function scheduledStopKey(request: ScheduledStopRequest): string {
  return JSON.stringify([
    request.tripId,
    request.routeId,
    request.stopSequence,
    request.stopId ?? "",
    request.startDate ?? "",
    request.startTime ?? "",
  ]);
}
