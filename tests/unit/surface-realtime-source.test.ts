import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import { RealtimeError } from "~/domain/surface/realtimeSource";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { logger } from "~/infrastructure/logging/logger";
import type { RealtimeFeedConfig } from "~/agencies/types";
import { makeTestManifest } from "../helpers/agency-fixtures";
const sampleManifest = makeTestManifest({ id: "sample" });
import {
  concatBuffers,
  encodeFeedHeader,
  encodeFloat,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

function makeStaticSnapshot(agencyId = "sample"): StaticSnapshot {
  return { agencyId, generatedAt: Date.now(), routes: [] };
}

function makeNextBusStaticSnapshot(): StaticSnapshot {
  const stop = {
    id: "stop-1",
    code: "stop-1",
    name: "Sample Stop",
    lat: 43.7,
    lon: -79.4,
  };
  return {
    agencyId: "sample",
    generatedAt: Date.now(),
    routes: [
      {
        routeId: "route-1",
        shortName: "R1",
        longName: "Sample Route",
        color: "#000000",
        textColor: "#FFFFFF",
        routeType: "bus",
        polyline: "",
        directionId: 0,
        headsign: "South - Sample Route towards Terminal",
        stops: [stop],
      },
    ],
  };
}

function buildVehicleFeedBytes(routeId = "501"): Uint8Array {
  const tripDesc = concatBuffers(
    encodeString(1, "trip-1"),
    encodeString(5, routeId),
    encodeVarintField(6, 0),
  );
  const pos = concatBuffers(encodeFloat(1, 43.65), encodeFloat(2, -79.38), encodeFloat(3, 90));
  const vehContent = concatBuffers(
    encodeMessage(1, tripDesc),
    encodeMessage(2, pos),
    encodeMessage(8, encodeString(1, "veh-1")),
  );
  const entity = encodeMessage(
    2,
    concatBuffers(encodeString(1, "e1"), encodeMessage(4, vehContent)),
  );
  return concatBuffers(encodeFeedHeader(1700000000), entity);
}

function buildTripFeedBytes(routeId = "501"): Uint8Array {
  const tripDesc = concatBuffers(
    encodeString(1, "trip-1"),
    encodeString(5, routeId),
    encodeVarintField(6, 0),
  );
  const arrivalEvent = concatBuffers(encodeVarintField(1, 0), encodeVarintField(2, 1700000300));
  const stopUpdate = concatBuffers(
    encodeVarintField(1, 1),
    encodeMessage(2, arrivalEvent),
    encodeString(4, "stop-1"),
  );
  const tripContent = concatBuffers(encodeMessage(1, tripDesc), encodeMessage(2, stopUpdate));
  const entity = encodeMessage(
    2,
    concatBuffers(encodeString(1, "e1"), encodeMessage(3, tripContent)),
  );
  return concatBuffers(encodeFeedHeader(1700000000), entity);
}

describe("RealtimeSource (Core seam, D1)", () => {
  it("fetches both declared GTFS-RT feeds, decodes via Core, and returns an honest snapshot", async () => {
    const vehicleBytes = buildVehicleFeedBytes();
    const tripBytes = buildTripFeedBytes();
    const requestHeaders: Headers[] = [];

    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      requestHeaders.push(new Headers(init?.headers));
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });

    const src = createGenericGtfsRealtimeSource({
      agencyId: sampleManifest.id,
      feeds: sampleManifest.realtime.feeds as unknown as readonly RealtimeFeedConfig[],
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 12345,
    });
    const snap = await Effect.runPromise(src.fetchRealtime(makeStaticSnapshot()));

    expect(snap.agencyId).toBe("sample");
    expect(snap.updatedAt).toBe(12345);
    expect(snap.vehicles.length).toBeGreaterThanOrEqual(1);
    expect(snap.arrivals.length).toBeGreaterThanOrEqual(1);
    expect(fakeFetch).toHaveBeenCalledTimes(2);
    expect(fakeFetch.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining(["https://example.test/vehicles", "https://example.test/trips"]),
    );
    expect(
      requestHeaders.every((headers) => headers.get("Accept") === "application/x-protobuf"),
    ).toBe(true);
  });

  it("uses Hamilton's explicit media type for vehicle and trip GTFS-RT feeds", async () => {
    const vehicleBytes = buildVehicleFeedBytes();
    const tripBytes = buildTripFeedBytes();
    const observedAccepts: (string | null)[] = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get("Accept");
      observedAccepts.push(accept);
      if (accept === "application/x-protobuf") return new Response("unsupported", { status: 406 });
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { status: 200 },
      );
    });

    const source = createGenericGtfsRealtimeSource({
      agencyId: "hamilton",
      feeds: [
        {
          kind: "vehicle_positions",
          url: "https://feeds.example.test/hamilton-vehicles",
          format: "protobuf",
          accept: "application/octet-stream",
        },
        {
          kind: "trip_updates",
          url: "https://feeds.example.test/hamilton-trips",
          format: "protobuf",
          accept: "application/octet-stream",
        },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const snapshot = await Effect.runPromise(source.fetchRealtime(makeStaticSnapshot("hamilton")));

    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.arrivals).toHaveLength(1);
    expect(observedAccepts).toEqual(["application/octet-stream", "application/octet-stream"]);
  });

  it("marks a usable GTFS-RT snapshot partial when one declared trip feed fails", async () => {
    const vehicleBytes = buildVehicleFeedBytes();
    const tripBytes = buildTripFeedBytes();
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/trips-down")) return new Response("offline", { status: 503 });
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    });
    const source = createGenericGtfsRealtimeSource({
      agencyId: "sample",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips-down", format: "protobuf" },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 12_345,
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const snapshot = await Effect.runPromise(source.fetchRealtime(makeStaticSnapshot()));

    expect(snapshot.partial).toBe(true);
    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.arrivals).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("sample realtime snapshot is partial"),
      expect.objectContaining({ agencyId: "sample", tripFeedsFailed: true }),
    );
    warn.mockRestore();
  });
  it("applies a proximity route allowlist before materializing feed entities", async () => {
    const vehicleBytes = concatBuffers(buildVehicleFeedBytes("501"), buildVehicleFeedBytes("504"));
    const tripBytes = concatBuffers(buildTripFeedBytes("501"), buildTripFeedBytes("504"));
    const fakeFetch = vi.fn(async (url: string) => {
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });

    const source = createGenericGtfsRealtimeSource({
      agencyId: "sample",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
    });

    const snapshot = await Effect.runPromise(
      source.fetchRealtime(makeStaticSnapshot(), { routeIds: new Set(["501"]) }),
    );

    expect(snapshot.vehicles.map((vehicle) => vehicle.routeId)).toEqual(["501"]);
    expect(snapshot.arrivals.map((arrival) => arrival.routeId)).toEqual(["501"]);
  });

  it("keeps feed credentials and protobuf negotiation when using the dev proxy", async () => {
    const vehicleBytes = buildVehicleFeedBytes();
    const tripBytes = buildTripFeedBytes();
    const requests: Array<{ url: string; headers: Headers }> = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      requests.push({ url, headers: new Headers(init?.headers) });
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });

    const source = createGenericGtfsRealtimeSource({
      agencyId: "go",
      feeds: [
        {
          kind: "vehicle_positions",
          url: "https://api.example.com/OpenDataAPI/VehiclePosition",
          format: "protobuf",
          devProxyPrefix: "/__dev/upstream/example",
          auth: { type: "query_param", parameterName: "key", secretName: "FEED_KEY" },
        },
        {
          kind: "trip_updates",
          url: "https://api.example.com/OpenDataAPI/TripUpdates",
          format: "protobuf",
          devProxyPrefix: "/__dev/upstream/example",
          auth: { type: "query_param", parameterName: "key", secretName: "FEED_KEY" },
        },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
      getSecret: (name) => (name === "FEED_KEY" ? "secret-value" : undefined),
      devProxyOrigin: "http://127.0.0.1:3000",
    });

    await Effect.runPromise(source.fetchRealtime(makeStaticSnapshot("go")));

    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.url).toMatch(
        /^http:\/\/127\.0\.0\.1:3000\/__dev\/upstream\/example\/OpenDataAPI\/(?:VehiclePosition|TripUpdates)\?key=secret-value$/,
      );
      expect(request.headers.get("Accept")).toBe("application/x-protobuf");
    }
  });

  it("combines multiple vehicle and trip feeds declared for one agency", async () => {
    const vehicleBytes = buildVehicleFeedBytes();
    const tripBytes = buildTripFeedBytes();
    const fakeFetch = vi.fn(async (url: string) => {
      const bytes = url.includes("vehicle") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });
    const feeds: RealtimeFeedConfig[] = [
      { kind: "vehicle_positions", url: "https://example.test/go-vehicles", format: "protobuf" },
      { kind: "vehicle_positions", url: "https://example.test/up-vehicle", format: "protobuf" },
      { kind: "trip_updates", url: "https://example.test/go-trips", format: "protobuf" },
      { kind: "trip_updates", url: "https://example.test/up-trips", format: "protobuf" },
    ];

    const source = createGenericGtfsRealtimeSource({
      agencyId: "go",
      feeds,
      fetch: fakeFetch as unknown as typeof fetch,
    });
    const snapshot = await Effect.runPromise(source.fetchRealtime(makeStaticSnapshot("go")));

    expect(fakeFetch).toHaveBeenCalledTimes(4);
    expect(snapshot.vehicles).toHaveLength(2);
    expect(snapshot.arrivals).toHaveLength(2);
  });

  it("propagates fetch failure as RealtimeError with agencyId (no silent empty)", async () => {
    const fakeFetch = vi.fn(async () => {
      return {
        ok: false,
        status: 500,
        arrayBuffer: async () => new ArrayBuffer(0),
      } as unknown as Response;
    });

    const src = createGenericGtfsRealtimeSource({
      agencyId: sampleManifest.id,
      feeds: sampleManifest.realtime.feeds as unknown as readonly RealtimeFeedConfig[],
      fetch: fakeFetch as unknown as typeof fetch,
    });
    let caught: unknown;
    try {
      await Effect.runPromise(src.fetchRealtime(makeStaticSnapshot()));
    } catch (e) {
      caught = e;
    }
    expect((caught as RealtimeError)._tag).toBe("RealtimeError");
    expect((caught as RealtimeError).agencyId).toBe("sample");
  });

  it("keeps one usable vehicle/trip feed when another declared feed fails", async () => {
    const vehicleBytes = buildVehicleFeedBytes();
    const tripBytes = buildTripFeedBytes();
    const topology: StaticSnapshot = {
      agencyId: "go",
      generatedAt: 1_900_000_000_000,
      routes: [],
    };
    const source = createGenericGtfsRealtimeSource({
      agencyId: "go",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/go-vehicles", format: "protobuf" },
        { kind: "vehicle_positions", url: "https://example.test/up-vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/go-trips", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/up-trips", format: "protobuf" },
      ],
      fetch: vi.fn(async (url: string) => {
        if (url.includes("up-")) return { ok: false, status: 503 } as Response;
        const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 1_900_000_000_000,
    });

    const snapshot = await Effect.runPromise(source.fetchRealtime(topology));

    expect(snapshot.vehicles).toHaveLength(1);
    expect(snapshot.arrivals).toHaveLength(1);
  });

  it("uses a declared generic NextBus fallback when surface GTFS-RT feeds fail", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      if (url.includes("nextbus.example.test")) {
        return new Response(
          JSON.stringify({
            predictions: {
              routeTag: "route-1",
              stopTag: "nextbus-stop-1",
              direction: {
                title: "South - Sample Route towards Terminal",
                prediction: [
                  {
                    tripTag: "sample-trip-1",
                    vehicle: "vehicle-1",
                    epochTime: "1900000300000",
                    seconds: "300",
                  },
                ],
              },
            },
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }
      return new Response("upstream unavailable", { status: 503 });
    });

    const source = createGenericGtfsRealtimeSource({
      agencyId: "sample",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
        {
          kind: "nextbus",
          url: "https://nextbus.example.test/service/publicJSONFeed?a=sample",
          format: "json",
        },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 1_900_000_000_000,
    });

    const snapshot = await Effect.runPromise(
      source.fetchRealtime(makeStaticSnapshot("sample"), {
        routeIds: new Set(["route-1"]),
        stopIds: new Set(["stop-1"]),
        stopIdsByRoute: new Map([["route-1", new Set(["stop-1"])]]),
      }),
    );

    expect(snapshot.arrivals).toEqual([
      expect.objectContaining({
        routeId: "route-1",
        stopId: "stop-1",
        directionId: 1,
        predictedTime: 1_900_000_300_000,
        vehicleId: "vehicle-1",
        isRealtime: true,
      }),
    ]);
    expect(fakeFetch.mock.calls.map(([url]) => url)).toEqual(
      expect.arrayContaining([
        "https://nextbus.example.test/service/publicJSONFeed?a=sample&command=predictions&stopId=stop-1&r=route-1",
      ]),
    );
  });

  it("uses a declared generic NextBus vehicle feed for route-scoped tracking", async () => {
    const fakeFetch = vi.fn(async (url: string) => {
      expect(url).toBe(
        "https://nextbus.example.test/service/publicJSONFeed?a=sample&command=vehicleLocations&r=route-1&t=0",
      );
      return new Response(
        JSON.stringify({
          lastTime: { time: "1900000000000" },
          vehicle: [
            {
              id: "vehicle-1",
              routeTag: "route-1",
              dirTag: "route-1_0_branch",
              lat: "43.7",
              lon: "-79.4",
              secsSinceReport: "12",
              heading: "180",
              speedKmHr: "18",
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const source = createGenericGtfsRealtimeSource({
      agencyId: "sample",
      feeds: [
        {
          kind: "nextbus",
          url: "https://nextbus.example.test/service/publicJSONFeed?a=sample",
          format: "json",
        },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
      now: () => 1_900_000_000_000,
    });

    const snapshot = await Effect.runPromise(
      source.fetchRealtime(makeNextBusStaticSnapshot(), {
        routeIds: new Set(["route-1"]),
      }),
    );

    expect(snapshot.vehicles).toEqual([
      expect.objectContaining({
        vehicleId: "vehicle-1",
        routeId: "route-1",
        directionId: 0,
        latitude: 43.7,
        longitude: -79.4,
        timestamp: 1_899_999_988_000,
      }),
    ]);
  });

  it("warns with the credential hint when a feed rejects with 401", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const source = createGenericGtfsRealtimeSource({
        agencyId: "go",
        feeds: [
          {
            kind: "vehicle_positions",
            url: "https://example.test/go-vehicles",
            format: "protobuf",
          },
          { kind: "trip_updates", url: "https://example.test/go-trips", format: "protobuf" },
        ],
        fetch: vi.fn(
          async () => ({ ok: false, status: 401 }) as Response,
        ) as unknown as typeof fetch,
        now: () => 1_900_000_000_000,
      });

      const error = await Effect.runPromise(
        Effect.flip(
          source.fetchRealtime({ agencyId: "go", generatedAt: 1_900_000_000_000, routes: [] }),
        ),
      );

      expect(String(error)).toContain("401");
      expect(warn).toHaveBeenCalledWith(expect.stringContaining("requires credentials"));
    } finally {
      warn.mockRestore();
    }
  });

  it.each([
    ["5829", "10"],
    ["5793", "20"],
  ])("translates raw GTFS-RT route %s to canonical %s via routeLineMap", async (raw, canonical) => {
    const vehicleBytes = buildVehicleFeedBytes(raw);
    const tripBytes = buildTripFeedBytes(raw);
    const fakeFetch = vi.fn(async (url: string) => {
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });
    const topology: StaticSnapshot = {
      agencyId: "hamilton-shaped",
      generatedAt: 1_900_000_000_000,
      routes: [
        {
          routeId: "10",
          shortName: "10",
          longName: "B-Line Express",
          color: "#0093DD",
          textColor: "#FFFFFF",
          routeType: "bus",
          polyline: "",
          directionId: 0,
          headsign: "B-Line",
          stops: [],
        },
        {
          routeId: "20",
          shortName: "20",
          longName: "A-Line Express",
          color: "#0093DD",
          textColor: "#FFFFFF",
          routeType: "bus",
          polyline: "",
          directionId: 0,
          headsign: "A-Line",
          stops: [],
        },
      ],
    };

    const source = createGenericGtfsRealtimeSource({
      agencyId: "hamilton-shaped",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
      routeLineMap: { "5829": "10", "5793": "20" },
    });

    const snapshot = await Effect.runPromise(source.fetchRealtime(topology));

    expect(snapshot.vehicles.map((vehicle) => vehicle.routeId)).toEqual([canonical]);
    expect(snapshot.arrivals.map((arrival) => arrival.routeId)).toEqual([canonical]);
  });

  it("keeps unmapped raw route IDs with the current safe fallback", async () => {
    const vehicleBytes = buildVehicleFeedBytes("9999");
    const tripBytes = buildTripFeedBytes("9999");
    const fakeFetch = vi.fn(async (url: string) => {
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });
    const topology: StaticSnapshot = {
      agencyId: "hamilton-shaped",
      generatedAt: 1_900_000_000_000,
      routes: [
        {
          routeId: "10",
          shortName: "10",
          longName: "B-Line Express",
          color: "#0093DD",
          textColor: "#FFFFFF",
          routeType: "bus",
          polyline: "",
          directionId: 0,
          headsign: "B-Line",
          stops: [],
        },
      ],
    };

    const source = createGenericGtfsRealtimeSource({
      agencyId: "hamilton-shaped",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
      routeLineMap: { "5829": "10" },
    });

    const snapshot = await Effect.runPromise(source.fetchRealtime(topology));

    expect(snapshot.vehicles.map((vehicle) => vehicle.routeId)).toEqual(["9999"]);
    expect(snapshot.arrivals.map((arrival) => arrival.routeId)).toEqual(["9999"]);
  });

  it("expands a canonical route allowlist to mapped raw IDs before decoding", async () => {
    const vehicleBytes = concatBuffers(
      buildVehicleFeedBytes("5829"),
      buildVehicleFeedBytes("9999"),
    );
    const tripBytes = concatBuffers(buildTripFeedBytes("5829"), buildTripFeedBytes("9999"));
    const fakeFetch = vi.fn(async (url: string) => {
      const bytes = url.includes("vehicles") ? vehicleBytes : tripBytes;
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      } as Response;
    });
    const topology: StaticSnapshot = {
      agencyId: "hamilton-shaped",
      generatedAt: 1_900_000_000_000,
      routes: [
        {
          routeId: "10",
          shortName: "10",
          longName: "B-Line Express",
          color: "#0093DD",
          textColor: "#FFFFFF",
          routeType: "bus",
          polyline: "",
          directionId: 0,
          headsign: "B-Line",
          stops: [],
        },
      ],
    };

    const source = createGenericGtfsRealtimeSource({
      agencyId: "hamilton-shaped",
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: fakeFetch as unknown as typeof fetch,
      routeLineMap: { "5829": "10" },
    });

    const snapshot = await Effect.runPromise(
      source.fetchRealtime(topology, { routeIds: new Set(["10"]) }),
    );

    expect(snapshot.vehicles.map((vehicle) => vehicle.routeId)).toEqual(["10"]);
    expect(snapshot.arrivals.map((arrival) => arrival.routeId)).toEqual(["10"]);
  });
});

it.each([true, false])(
  "scopes shared vehicle and arrival feeds to seeded trips when selection is %s",
  async (restrictToSeededTrips) => {
    const source = createGenericGtfsRealtimeSource({
      agencyId: "sample",
      restrictToSeededTrips,
      feeds: [
        { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
        { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: vi.fn(
        async (url) =>
          new Response(
            new Uint8Array(
              String(url).endsWith("vehicles")
                ? buildVehicleFeedBytes("foreign")
                : buildTripFeedBytes("foreign"),
            ),
          ),
      ),
      getRoutesForTrips: () => Effect.succeed(new Map()),
    });
    const result = await Effect.runPromise(source.fetchRealtime(makeStaticSnapshot()));
    expect(result.vehicles).toHaveLength(restrictToSeededTrips ? 0 : 1);
    expect(result.arrivals).toHaveLength(restrictToSeededTrips ? 0 : 1);
  },
);

it("keeps a selected operator's live vehicle and departures", async () => {
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    restrictToSeededTrips: true,
    feeds: [
      { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
      { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
    ],
    fetch: vi.fn(
      async (url) =>
        new Response(
          new Uint8Array(
            String(url).endsWith("vehicles")
              ? buildVehicleFeedBytes("ours")
              : buildTripFeedBytes("ours"),
          ),
        ),
    ),
    getRoutesForTrips: () =>
      Effect.succeed(new Map([["trip-1", { routeId: "ours", directionId: 0 }]])),
  });
  const result = await Effect.runPromise(source.fetchRealtime(makeStaticSnapshot()));
  expect(result.vehicles.map((vehicle) => vehicle.routeId)).toEqual(["ours"]);
  expect(result.arrivals.map((arrival) => arrival.routeId)).toEqual(["ours"]);
});

it("fails shared realtime reads through the typed feed error when membership is unavailable", async () => {
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    restrictToSeededTrips: true,
    feeds: [
      { kind: "vehicle_positions", url: "https://example.test/vehicles", format: "protobuf" },
      { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
    ],
    fetch: vi.fn(
      async (url) =>
        new Response(
          new Uint8Array(
            String(url).endsWith("vehicles")
              ? buildVehicleFeedBytes("ours")
              : buildTripFeedBytes("ours"),
          ),
        ),
    ),
  });
  await expect(
    Effect.runPromise(source.fetchRealtime(makeStaticSnapshot())),
  ).rejects.toBeInstanceOf(RealtimeError);
});

it("serves a vehicle-only request without reading an unavailable departure feed", async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).includes("/trips")) throw new Error("Trip feed unavailable");
    return new Response(new Uint8Array(buildVehicleFeedBytes()).buffer);
  });
  const source = createGenericGtfsRealtimeSource({
    agencyId: "sample",
    fetch: fetcher,
    feeds: [
      { kind: "vehicle_positions", url: "https://sample.test/vehicles-only", format: "protobuf" },
      {
        kind: "trip_updates",
        url: "https://sample.test/trips-unavailable",
        format: "protobuf",
        emptyTripUpdates: "error",
      },
    ],
  });
  const result = await Effect.runPromise(
    source.fetchRealtime(makeStaticSnapshot(), { vehiclesOnly: true }),
  );
  expect(result.vehicles).toHaveLength(1);
  expect(result.arrivals).toEqual([]);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(String(fetcher.mock.calls[0]?.[0])).toContain("vehicles-only");
});
