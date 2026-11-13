import { inferDirectionFromBearing } from "~/domain/surface/types";
import type { PredictionIdentityOptions, readLiveStopUpdate } from "./scheduledPredictions";

/** Complete upstream call order proves a trip's destination independently of its static ID. */
export function completeTripPattern(
  stops: readonly ReturnType<typeof readLiveStopUpdate>[],
  routeId: string,
  options: PredictionIdentityOptions,
) {
  if (!options.completeTripUpdates || stops.length === 0) return undefined;
  const first = stops[0]!.stopId;
  const last = stops.at(-1)!.stopId;
  const origin = first ? options.stopLocations?.get(first) : undefined;
  const destination = last ? options.stopLocations?.get(last) : undefined;
  const bearing =
    origin && destination && (origin.lat !== destination.lat || origin.lon !== destination.lon)
      ? ((Math.atan2(
          (destination.lon - origin.lon) * Math.cos((origin.lat * Math.PI) / 180),
          destination.lat - origin.lat,
        ) *
          180) /
          Math.PI +
          360) %
        360
      : undefined;
  return {
    headsign: destination?.name,
    directionId:
      bearing === undefined
        ? undefined
        : inferDirectionFromBearing(routeId, bearing, options.routeInterpretation),
  };
}
