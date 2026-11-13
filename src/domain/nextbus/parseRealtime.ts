import type { RouteInterpretationConfig } from "~/agencies/types";
import { isNorthSouthDirectionIdsInverted, resolveDirectionId } from "~/domain/surface/direction";
import {
  inferDirectionFromBearing,
  type ArrivalPrediction,
  type LiveVehiclePosition,
} from "~/domain/surface/types";
import { classifyNextBusInBandError } from "./parseRouteConfig";

interface NextBusPrediction {
  readonly tripTag?: string;
  readonly vehicle?: string;
  readonly epochTime?: string;
  readonly seconds?: string;
  readonly dirTag?: string;
}

interface NextBusDirection {
  readonly tag?: string;
  readonly title?: string;
  readonly name?: string;
  readonly prediction?: NextBusPrediction | readonly NextBusPrediction[];
}

interface NextBusPredictions {
  readonly routeTag?: string;
  readonly direction?: NextBusDirection | readonly NextBusDirection[];
  readonly prediction?: NextBusPrediction | readonly NextBusPrediction[];
}

interface NextBusVehicle {
  readonly id?: string;
  readonly routeTag?: string;
  readonly dirTag?: string;
  readonly lat?: string;
  readonly lon?: string;
  readonly secsSinceReport?: string;
  readonly heading?: string;
  readonly speedKmHr?: string;
}

const asArray = <T>(value: T | readonly T[] | undefined): readonly T[] => {
  if (value === undefined) return [];
  return Array.isArray(value) ? value : [value as T];
};

function parseEpochTime(prediction: NextBusPrediction, now: number): number | undefined {
  const epochTime = Number(prediction.epochTime);
  if (Number.isFinite(epochTime) && epochTime > 0) return epochTime;

  const seconds = Number(prediction.seconds);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return now + seconds * 1_000;
}

function parsePrediction(
  prediction: NextBusPrediction,
  input: {
    readonly routeId: string;
    readonly stopId: string;
    readonly directionId: 0 | 1;
    readonly index: number;
    readonly now: number;
  },
): ArrivalPrediction | undefined {
  const predictedTime = parseEpochTime(prediction, input.now);
  if (predictedTime === undefined) return undefined;

  return {
    tripId: prediction.tripTag || `nextbus-${input.routeId}-${prediction.vehicle || input.index}`,
    routeId: input.routeId,
    directionId: input.directionId,
    vehicleId: prediction.vehicle,
    stopSequence: input.index + 1,
    stopId: input.stopId,
    predictedTime,
    delaySeconds: 0,
    scheduleRelationship: "SCHEDULED",
    isRealtime: true,
  };
}

/** Converts a NextBus predictions response into Core arrival predictions. */
export function parseNextBusPredictions(
  payload: unknown,
  input: {
    readonly routeId: string;
    readonly stopId: string;
    readonly now: number;
    readonly routeInterpretation?: RouteInterpretationConfig;
  },
): readonly ArrivalPrediction[] {
  const inBandError = classifyNextBusInBandError(payload);
  if (inBandError) throw new Error(`NextBus predictions: ${inBandError.content}`);

  const wrapper = (payload as { predictions?: NextBusPredictions | readonly NextBusPredictions[] })
    ?.predictions;
  const results: ArrivalPrediction[] = [];

  for (const predictions of asArray(wrapper)) {
    const directions = asArray(predictions.direction);
    if (directions.length > 0) {
      for (const direction of directions) {
        const directionId = resolveDirectionId(
          direction.tag,
          `${direction.title ?? ""} ${direction.name ?? ""}`,
          0,
          {
            invertNorthSouth: isNorthSouthDirectionIdsInverted(
              input.routeId,
              input.routeInterpretation,
            ),
          },
        );
        for (const [index, prediction] of asArray(direction.prediction).entries()) {
          const parsed = parsePrediction(prediction, {
            ...input,
            directionId,
            index,
          });
          if (parsed) results.push(parsed);
        }
      }
      continue;
    }

    for (const [index, prediction] of asArray(predictions.prediction).entries()) {
      const directionId = resolveDirectionId(prediction.dirTag, undefined, 0);
      const parsed = parsePrediction(prediction, { ...input, directionId, index });
      if (parsed) results.push(parsed);
    }
  }

  return results;
}

/** Converts a NextBus vehicleLocations response into Core vehicle positions. */
export function parseNextBusVehicles(
  payload: unknown,
  input: {
    readonly routeId: string;
    readonly now: number;
    readonly routeInterpretation?: RouteInterpretationConfig;
  },
): readonly LiveVehiclePosition[] {
  const inBandError = classifyNextBusInBandError(payload);
  if (inBandError) throw new Error(`NextBus vehicle locations: ${inBandError.content}`);

  const vehicles = (payload as { vehicle?: NextBusVehicle | readonly NextBusVehicle[] })?.vehicle;
  return asArray(vehicles).flatMap((vehicle) => {
    const latitude = Number(vehicle.lat);
    const longitude = Number(vehicle.lon);
    if (!vehicle.id || !Number.isFinite(latitude) || !Number.isFinite(longitude)) return [];

    const bearing = Number(vehicle.heading);
    const hasBearing = Number.isFinite(bearing);
    const directionId = vehicle.dirTag
      ? resolveDirectionId(vehicle.dirTag, undefined, 0)
      : inferDirectionFromBearing(
          input.routeId,
          hasBearing ? bearing : undefined,
          input.routeInterpretation,
        );
    const speedKmHr = Number(vehicle.speedKmHr);
    const speed = Number.isFinite(speedKmHr) ? Math.max(0, speedKmHr) / 3.6 : 0;
    const secondsSinceReport = Number(vehicle.secsSinceReport);

    return [
      {
        vehicleId: vehicle.id,
        // The requested route is authoritative. NextBus can report a shared
        // branch tag here even though the vehicle was returned for this route
        // query; retaining it would make the vehicle disappear at the Core
        // route-matching seam.
        routeId: input.routeId,
        directionId,
        latitude,
        longitude,
        ...(hasBearing ? { bearing } : {}),
        speed,
        currentStatus: speed <= 1 ? ("STOPPED_AT" as const) : ("IN_TRANSIT_TO" as const),
        timestamp:
          input.now -
          (Number.isFinite(secondsSinceReport) ? Math.max(0, secondsSinceReport) : 0) * 1_000,
      },
    ];
  });
}
