import sharedFeed from "../fixtures/complete-trip-updates.json";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeGtfsRealtimeSync } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeStationTripUpdates } from "~/infrastructure/realtime/stationTripDecoder";
import { createGenericStationsSource } from "~/infrastructure/realtime/genericStationsSource";
import {
  concatBuffers,
  encodeFeed,
  encodeFloat,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

const stops = [
  { id: "south", name: "South Terminal", lat: 43, lon: -79 },
  { id: "middle", name: "Middle", lat: 43.5, lon: -79 },
  { id: "north", name: "North Turnback", lat: 44, lon: -79 },
];
const options = {
  completeTripUpdates: true as const,
  vehicleTripSource: "entity-trip-update" as const,
  stopLocations: new Map(stops.map((s) => [s.id, s])),
  routeInterpretation: { directionInference: { default: "north-south" as const } },
};
function feed(reverse = false, vehicleRoute?: string) {
  const ids = reverse ? ["north", "middle", "south"] : ["south", "middle", "north"];
  const update = encodeMessage(
    3,
    concatBuffers(
      encodeMessage(1, concatBuffers(encodeString(1, "live-trip"), encodeString(5, "R"))),
      ...ids.map((id, i) =>
        encodeMessage(
          2,
          concatBuffers(
            encodeString(4, id),
            encodeMessage(3, encodeVarintField(2, 1_700_000_100 + i * 120)),
          ),
        ),
      ),
    ),
  );
  const vehicle = encodeMessage(
    4,
    concatBuffers(
      encodeMessage(
        1,
        concatBuffers(
          encodeString(1, "train-number"),
          ...(vehicleRoute ? [encodeString(5, vehicleRoute)] : []),
        ),
      ),
      encodeMessage(2, concatBuffers(encodeFloat(1, 43.4), encodeFloat(2, -79))),
      encodeMessage(8, encodeString(1, "car-7")),
    ),
  );
  return encodeFeed(1_700_000_000, [
    encodeMessage(2, concatBuffers(vehicle, update, encodeString(1, "entity-7"))),
  ]);
}

describe("complete ordered trip updates", () => {
  it.each([
    { reverse: false, direction: 0, destination: "North Turnback" },
    { reverse: true, direction: 1, destination: "South Terminal" },
  ])(
    "preserves trip direction and destination before stop filtering, reverse=$reverse",
    ({ reverse, direction, destination }) => {
      const bytes = feed(reverse);
      const selected = new Set(["middle"]);
      const full = decodeGtfsRealtimeSync(bytes, {
        ...options,
        stopIds: selected,
        routeIds: new Set(["R"]),
      });
      const narrow = decodeStationTripUpdates(bytes, selected, undefined, options);
      expect(full.tripUpdates).toEqual(narrow);
      expect(full.tripUpdates).toMatchObject([
        { tripId: "live-trip", directionId: direction, headsign: destination, stopSequence: 2 },
      ]);
      expect(full.vehiclePositions).toMatchObject([
        { vehicleId: "car-7", tripId: "live-trip", routeId: "R", directionId: direction },
      ]);
    },
  );
  it("leaves explicit vehicle identities intact when their route conflicts", () => {
    expect(decodeGtfsRealtimeSync(feed(false, "other"), options).vehiclePositions).toMatchObject([
      { tripId: "train-number", routeId: "other" },
    ]);
  });
  it("does not assume an ordinary partial update ends the trip", () => {
    const result = decodeGtfsRealtimeSync(feed());
    expect(result.vehiclePositions).toEqual([]);
    expect(
      result.tripUpdates.every((p) => p.headsign === undefined && p.isTerminalCall === undefined),
    ).toBe(true);
  });
  it.each([
    { reverse: false, terminal: "north", destination: "North Turnback", direction: 0 },
    { reverse: true, terminal: "south", destination: "South Terminal", direction: 1 },
  ])(
    "keeps through departures at drawn junctions and omits final calls, reverse=$reverse",
    async ({ reverse, terminal, destination, direction }) => {
      const source = createGenericStationsSource({
        agencyId: "railway",
        routeType: "rail",
        lineSequences: { R: ["north", "middle"] },
        routeInterpretation: options.routeInterpretation,
        stations: stops.map((s) => ({ ...s, lines: ["R"], platformIds: [s.id] })),
        feeds: [
          {
            kind: "trip_updates",
            url: "https://example.test/rail",
            format: "protobuf",
            completeTripUpdates: true,
          },
        ],
        fetch: async () => new Response(new Uint8Array(feed(reverse))),
        now: () => 1_700_000_000_000,
      });
      const cards = await Effect.runPromise(
        source.fetchByIds({ stationIds: ["middle", terminal] }),
      );
      expect(
        cards.find((c) => c.id === "middle")?.arrivals.map((a) => [a.label, a.directionId]),
      ).toEqual([[`→ ${destination}`, direction]]);
      expect(cards.find((c) => c.id === terminal)?.arrivals).toEqual([]);
    },
  );
});

it("matches the compound-entity relay contract", () => {
  const bytes = new Uint8Array(Buffer.from(sharedFeed.feedBase64, "base64"));
  const result = decodeGtfsRealtimeSync(bytes, options);
  expect(result.header.version).toBe("1");
  expect(result.vehiclePositions).toMatchObject([
    { vehicleId: "car-7", tripId: "live-trip", routeId: "R", directionId: 0 },
  ]);
  expect(result.tripUpdates.map((p) => [p.headsign, p.isTerminalCall])).toEqual([
    ["North Turnback", false],
    ["North Turnback", false],
    ["North Turnback", true],
  ]);
});
