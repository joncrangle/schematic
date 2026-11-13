import { calculateFreshness } from "~/domain/freshness";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import type { NetworkTrainSnapshot } from "../networkTrains";
import {
  boardRides,
  ownsStop,
  rideLine,
  type StationTimetablesFeed,
  type TimetableRide,
} from "./stationTimetablesProtocol";

/** An estimate older than this is an announcement, not a live forecast. */
const MAX_ESTIMATE_AGE_MS = 60 * 60_000;
/** A position older than this no longer shows where the coach is. */
const MAX_FIX_AGE_MS = 10 * 60_000;

const instant = (value: string | null | undefined) => {
  const time = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(time) ? time : undefined;
};
const freshnessOf = (now: number, updatedAt: number) => {
  const state = calculateFreshness(now, updatedAt).state;
  return state === "unavailable" ? ("stale" as const) : state;
};

function decodeRide(
  ride: TimetableRide,
  feed: StationTimetablesFeed,
  now: number,
): { vehicle?: LiveVehiclePosition; arrivals: ArrivalPrediction[] } {
  const { routeId, headsign } = rideLine(ride);
  const directionId = feed.directions[routeId]?.[headsign] ?? 0;
  const vehicleId = ride.vehicle?.id || ride.id;
  const owned = ride.calls.filter((call) => ownsStop(call, feed));
  const arrivals: ArrivalPrediction[] = [];
  for (const call of owned) {
    // A ride ending here is not a departure riders can board.
    const event = call.departure;
    const deviation = event?.deviation;
    if (deviation?.deviation_type !== "ESTIMATED" || deviation.deviation_class === "CANCELLED")
      continue;
    const predictedTime = instant(deviation.deviation_timestamp);
    const updatedAt = instant(deviation.updated_at);
    if (predictedTime === undefined || updatedAt === undefined || predictedTime <= now) continue;
    if (now - updatedAt > MAX_ESTIMATE_AGE_MS) continue;
    const scheduled = instant(event?.scheduled);
    arrivals.push({
      tripId: ride.id,
      vehicleId,
      routeId,
      directionId,
      stopSequence: call.sequence,
      stopId: call.stop.id,
      predictedTime,
      delaySeconds:
        deviation.deviation_seconds ??
        (scheduled === undefined ? 0 : (predictedTime - scheduled) / 1000),
      scheduleRelationship: "SCHEDULED",
      isRealtime: true,
      headsign,
      freshness: freshnessOf(now, updatedAt),
    });
  }
  const fixAt = instant(ride.location?.updated_at);
  const vehicle =
    ride.location && fixAt !== undefined && owned.length > 0 && now - fixAt <= MAX_FIX_AGE_MS
      ? {
          vehicleId,
          tripId: ride.id,
          routeId,
          directionId,
          latitude: ride.location.coordinates.latitude,
          longitude: ride.location.coordinates.longitude,
          timestamp: fixAt,
          freshness: freshnessOf(now, fixAt),
        }
      : undefined;
  return { vehicle, arrivals };
}

/** Boards that list no rides at all are a failed read, not a quiet network. */
export function decodeStationTimetablesDocument(
  bytes: Uint8Array,
  feed: StationTimetablesFeed,
  now: number,
): NetworkTrainSnapshot {
  const boards: unknown = JSON.parse(new TextDecoder().decode(bytes));
  if (!Array.isArray(boards)) throw new Error("Station timetable document is not a board list");
  const { rides, malformed } = boardRides(boards);
  if (rides.length === 0)
    throw malformed[0] ?? new Error("No rides on any polled board; recovery is unconfirmed");
  const vehicles: LiveVehiclePosition[] = [];
  const arrivals: ArrivalPrediction[] = [];
  for (const ride of rides) {
    const decoded = decodeRide(ride, feed, now);
    if (decoded.vehicle) vehicles.push(decoded.vehicle);
    arrivals.push(...decoded.arrivals);
  }
  return { vehicles, arrivals };
}
