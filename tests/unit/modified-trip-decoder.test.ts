import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { decodeGtfsRealtimeSync } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeStationTripUpdates } from "~/infrastructure/realtime/stationTripDecoder";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { createGenericStationsSource } from "~/infrastructure/realtime/genericStationsSource";
import { createRealtimeCacheLayer, NearbyRealtimeState } from "~/services/surface/NearbyTransit";
import {
  concatBuffers,
  encodeFeed,
  encodeFloat,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

// Reduced vendor capture from 2026-10-09. Identities and epochs are fictional;
// descriptor/event field layout matches the captured wire data.
const bytes = new Uint8Array(
  Buffer.from(
    readFileSync(new URL("../fixtures/gtfs-rt/modified-trip.hex", import.meta.url), "utf8").replace(
      /\s/g,
      "",
    ),
    "hex",
  ),
);
const tripRoutes = new Map([["trip-42", { routeId: "R", directionId: 1 }]]);

describe.each([
  [
    "general",
    () => decodeGtfsRealtimeSync(bytes, { tripRoutes, routeIds: new Set(["R"]) }).tripUpdates,
  ],
  ["station", () => decodeStationTripUpdates(bytes, new Set(["hub-platform"]), tripRoutes)],
] as const)("%s modified trip decoding", (_name, decode) => {
  it("joins the affected trip to its static route and direction and calculates actual delay", () => {
    expect(decode()).toMatchObject([
      {
        tripId: "trip-42",
        routeId: "R",
        directionId: 1,
        stopId: "hub-platform",
        predictedTime: 1700000320000,
        delaySeconds: 320,
      },
    ]);
  });
});

it.each([undefined, "static"] as const)(
  "keeps ordinary vehicles in their tracking direction with tripDirectionSource=%s",
  async (tripDirectionSource) => {
    const directions = [0, 17, 27, 28, 0];
    const staticDirections = [0, 1, 0, 1, 1];
    const vehicleFeed = encodeFeed(
      1700000000,
      directions.map((direction, index) =>
        encodeMessage(
          2,
          concatBuffers(
            encodeString(1, `entity-${index}`),
            encodeMessage(
              4,
              concatBuffers(
                encodeMessage(
                  1,
                  concatBuffers(
                    encodeString(1, `trip-${index}`),
                    encodeString(5, "R"),
                    encodeVarintField(6, direction),
                  ),
                ),
                encodeMessage(2, concatBuffers(encodeFloat(1, 43), encodeFloat(2, -80))),
                encodeMessage(8, encodeString(1, `vehicle-${index}`)),
              ),
            ),
          ),
        ),
      ),
    );
    const lookupCalls: string[][] = [];
    const source = createGenericGtfsRealtimeSource({
      agencyId: "sample",
      feeds: [
        {
          kind: "vehicle_positions",
          url: "https://example.test/vehicles",
          format: "protobuf",
          tripDirectionSource,
        },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: (async (url) =>
        new Response(
          new Uint8Array(String(url).endsWith("/trips") ? encodeFeed(1700000000, []) : vehicleFeed),
        )) as typeof fetch,
      getRoutesForTrips: (ids) => {
        lookupCalls.push([...ids]);
        return Effect.succeed(
          new Map(
            staticDirections.map((directionId, index) => [
              `trip-${index}`,
              { routeId: "R", directionId },
            ]),
          ),
        );
      },
      now: () => 1700000000000,
    });
    const vehicles = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* NearbyRealtimeState;
        return yield* repository.getRouteVehicles({
          agencyId: "sample",
          routeId: "R",
          directionId: 0,
        });
      }).pipe(
        Effect.provide(
          createRealtimeCacheLayer(
            {},
            {
              realtimeByAgencyId: new Map([["sample", source]]),
            },
          ),
        ),
      ),
    );
    expect(vehicles.map((vehicle) => vehicle.vehicleId)).toEqual(
      tripDirectionSource === "static" ? ["vehicle-0", "vehicle-2"] : ["vehicle-0", "vehicle-4"],
    );
    expect(lookupCalls).toEqual(
      tripDirectionSource === "static" ? [["trip-0", "trip-1", "trip-2", "trip-3", "trip-4"]] : [],
    );
  },
);

it("resolves modified trips for saved station departures", async () => {
  const source = createGenericStationsSource({
    agencyId: "sample",
    stations: [
      { id: "hub", name: "Hub", lat: 43, lon: -80, lines: ["R"], platformIds: ["hub-platform"] },
    ],
    routeType: "bus",
    feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
    fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    getRoutesForTrips: () => Effect.succeed(tripRoutes),
    now: () => 1700000000000,
  });
  const [station] = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
  expect(station.arrivals).toMatchObject([{ directionId: 1, times: [1700000320000] }]);
});

describe.each([
  ["general", (feed: Uint8Array) => decodeGtfsRealtimeSync(feed, { tripRoutes }).tripUpdates],
  [
    "station",
    (feed: Uint8Array) => decodeStationTripUpdates(feed, new Set(["hub-platform"]), tripRoutes),
  ],
] as const)("%s descriptor safeguards", (_name, decode) => {
  const feed = (descriptor: Uint8Array) =>
    encodeFeed(1700000000, [
      encodeMessage(
        2,
        concatBuffers(
          encodeString(1, "entity"),
          encodeMessage(
            3,
            concatBuffers(
              encodeMessage(1, descriptor),
              encodeMessage(
                2,
                concatBuffers(
                  encodeString(4, "hub-platform"),
                  encodeMessage(2, encodeVarintField(2, 1700000320)),
                ),
              ),
            ),
          ),
        ),
      ),
    ]);
  const modified = encodeMessage(7, encodeString(2, "trip-42"));
  it("honours explicit descriptors over the modified fallback", () => {
    expect(
      decode(
        feed(
          concatBuffers(
            modified,
            encodeString(1, "explicit"),
            encodeString(5, "X"),
            encodeVarintField(6, 0),
          ),
        ),
      ),
    ).toMatchObject([{ tripId: "explicit", routeId: "X", directionId: 0 }]);
  });
  it("does not revive canceled trips or invent routes for unknown modified trips", () => {
    expect(decode(feed(concatBuffers(modified, encodeVarintField(4, 3))))).toEqual([]);
    expect(decode(feed(encodeMessage(7, encodeString(2, "unknown"))))).toEqual([]);
  });
});

it("keeps a modified trip in filtered live arrivals after resolving its route from static topology", async () => {
  const { Effect } = await import("effect");
  const { createGenericGtfsRealtimeSource } =
    await import("~/infrastructure/realtime/genericGtfsRealtimeSource");
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    feeds: [
      { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
    ],
    fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    getRoutesForTrips: (ids) => {
      expect(ids).toEqual(["trip-42"]);
      return Effect.succeed(tripRoutes);
    },
    now: () => 1700000000000,
  });
  const snapshot = await Effect.runPromise(
    source.fetchRealtime(
      { agencyId: "sample", generatedAt: 0, routes: [] },
      {
        routeIds: new Set(["R"]),
        stopIds: new Set(["hub-platform"]),
      },
    ),
  );
  expect(snapshot.arrivals).toMatchObject([{ tripId: "trip-42", routeId: "R", directionId: 1 }]);
});
