import { expect, it } from "vitest";
import { decodeGtfsRealtimeSync } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeStationTripUpdates } from "~/infrastructure/realtime/stationTripDecoder";
import {
  concatBuffers,
  encodeFeed,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

it.each([
  [7, undefined, 0, undefined],
  [9, undefined, 1, undefined],
  [9, 0, 0, undefined],
  [8, undefined, 0, true],
] as const)(
  "reads configured direction enums consistently across departure ports (%s, %s)",
  (wireDirection, standard, directionId, directionInferred) => {
    const descriptor = concatBuffers(
      encodeString(1, "journey-a"),
      encodeString(5, "R"),
      encodeMessage(1012, encodeVarintField(4, wireDirection)),
      ...(standard === undefined ? [] : [encodeVarintField(6, standard)]),
    );
    const bytes = encodeFeed(1_700_000_000, [
      encodeMessage(
        2,
        concatBuffers(
          encodeString(1, "entity-a"),
          encodeMessage(
            3,
            concatBuffers(
              encodeMessage(1, descriptor),
              encodeMessage(
                2,
                concatBuffers(
                  encodeString(4, "platform-a"),
                  encodeMessage(3, encodeVarintField(2, 1_700_000_300)),
                ),
              ),
            ),
          ),
        ),
      ),
    ]);
    const options = {
      tripDirectionExtension: {
        fieldNumber: 1012,
        directionFieldNumber: 4,
        values: { "7": 0 as const, "9": 1 as const },
      },
    };
    const surface = decodeGtfsRealtimeSync(bytes, options).tripUpdates[0];
    const station = decodeStationTripUpdates(bytes, undefined, undefined, options)[0];
    expect(
      [surface, station].map((prediction) => ({
        directionId: prediction?.directionId,
        directionInferred: prediction?.directionInferred,
      })),
    ).toEqual([
      { directionId, directionInferred },
      { directionId, directionInferred },
    ]);
  },
);
