import nestedEstimates from "../fixtures/station-departures/nested-estimates.json";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import {
  createGenericStationsSource,
  STATION_FEED_CACHE_TTL_MS,
  STATION_FEED_FAILURE_TTL_MS,
  STATION_DEPARTURES_CONCURRENCY,
} from "~/infrastructure/realtime/genericStationsSource";
import { logger } from "~/infrastructure/logging/logger";
import { makeStationSchematic } from "../helpers/agency-fixtures";
const railSchematic = makeStationSchematic(["North Terminal", "Middle", "South Terminal"], "rail");
const middle = railSchematic.stationIndex![1]!;
const stationIndex = railSchematic.stationIndex!.map((entry) =>
  entry === middle ? { ...entry, platformIds: ["north-platform", "south-platform"] } : entry,
);
import {
  concatBuffers,
  encodeAlertEntity,
  encodeFeed,
  encodeFeedHeader,
  encodeMessage,
  encodeString,
  encodeSubwayTripUpdateEntity,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

function buildTripFeedBytes(
  entityId = "entity-1",
  predictedSeconds = 1_700_000_300,
  tripId = "trip-1",
): Uint8Array {
  const tripDescriptor = concatBuffers(
    encodeString(1, tripId),
    encodeString(5, "LW"),
    encodeVarintField(6, 0),
  );
  const arrival = concatBuffers(encodeVarintField(1, 0), encodeVarintField(2, predictedSeconds));
  const stopUpdate = concatBuffers(
    encodeVarintField(1, 1),
    encodeMessage(2, arrival),
    encodeString(4, "UN"),
  );
  const tripUpdate = concatBuffers(encodeMessage(1, tripDescriptor), encodeMessage(2, stopUpdate));
  const entity = encodeMessage(
    2,
    concatBuffers(encodeString(1, entityId), encodeMessage(3, tripUpdate)),
  );
  return concatBuffers(encodeFeedHeader(1_700_000_000), entity);
}

const unionStation = {
  id: "UN",
  name: "Union Station GO",
  lat: 43.645195,
  lon: -79.3806,
  lines: ["LW"],
  platformIds: ["UN"],
} as const;

it("keeps seeded suffixed route identities separate on one station board", async () => {
  const now = 1_700_000_000_000;
  const routeIds = ["41-NET", "42-NET"];
  const bytes = encodeFeed(
    now / 1000,
    routeIds.map((routeId, index) =>
      encodeSubwayTripUpdateEntity({
        entityId: `trip-${index}`,
        routeId,
        stopId: "platform",
        arrivalTimeSec: now / 1000 + (index + 1) * 60,
      }),
    ),
  );
  const source = createGenericStationsSource({
    agencyId: "sample",
    routeType: "bus",
    now: () => now,
    stations: [
      {
        id: "hub",
        name: "Hub",
        lat: 43.7,
        lon: -79.4,
        lines: routeIds,
        departureRouteIds: routeIds,
        platformIds: ["platform"],
      },
    ],
    feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))),
  });
  const [station] = await Effect.runPromise(source.fetchByIds({ stationIds: ["hub"] }));
  expect(station.lineIds).toEqual(routeIds);
  expect(station.arrivals.map((row) => ({ lineId: row.lineId, times: row.times }))).toEqual([
    { lineId: "41-NET", times: [now + 60_000] },
    { lineId: "42-NET", times: [now + 120_000] },
  ]);
});

it("separates directionless rail station departures by their static trip direction", async () => {
  const station = middle;
  const now = 1_700_000_000_000;
  const bytes = encodeFeed(now / 1000, [
    encodeSubwayTripUpdateEntity({
      entityId: "north",
      routeId: "301",
      stopId: "north-platform",
      stopSequence: 12,
      arrivalTimeSec: now / 1000 + 60,
    }),
    encodeSubwayTripUpdateEntity({
      entityId: "south",
      routeId: "301",
      stopId: "south-platform",
      stopSequence: 12,
      arrivalTimeSec: now / 1000 + 120,
    }),
  ]);
  const lookup = vi.fn(() =>
    Effect.succeed(
      new Map([
        ["north", 0],
        ["south", 1],
      ]),
    ),
  );
  const source = createGenericStationsSource({
    agencyId: "grt",
    stations: stationIndex,
    lineSequences: railSchematic.sequences,
    routeType: "rail",
    routeLineMap: { "301": "rail" },
    feeds: [{ kind: "trip_updates", url: "https://example.test/ion-trips", format: "protobuf" }],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    now: () => now,
    getDirectionsForTrips: lookup,
  });
  const [result] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));
  expect(lookup).toHaveBeenCalledWith("301", ["north", "south"]);
  expect(result.arrivals).toEqual([
    expect.objectContaining({
      directionId: 0,
      label: "→ North Terminal",
      times: [now + 60_000],
    }),
    expect.objectContaining({ directionId: 1, label: "→ South Terminal", times: [now + 120_000] }),
  ]);
});

it("keeps inverted north-south IDs aligned with fallback labels in station departures", async () => {
  const now = 1_700_000_000_000;
  const station = {
    id: "fixture-station",
    name: "Fixture Station",
    lat: 43.7,
    lon: -79.4,
    lines: ["fixture510"],
    platformIds: ["fixture-platform"],
  } as const;
  const bytes = encodeFeed(now / 1000, [
    encodeSubwayTripUpdateEntity({
      entityId: "trip-south",
      tripId: "trip-south",
      routeId: "fixture510",
      stopId: "fixture-platform",
      arrivalTimeSec: now / 1000 + 60,
    }),
    encodeSubwayTripUpdateEntity({
      entityId: "trip-north",
      tripId: "trip-north",
      routeId: "fixture510",
      stopId: "fixture-platform",
      arrivalTimeSec: now / 1000 + 120,
    }),
  ]);
  const source = createGenericStationsSource({
    agencyId: "fictional-agency",
    stations: [station],
    feeds: [
      { kind: "station_trip_updates", url: "https://example.test/trips", format: "protobuf" },
    ],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    now: () => now,
    routeType: "bus",
    routeInterpretation: {
      directionInference: {
        routeOverrides: { fixture510: "north-south" },
        invertNorthSouth: true,
      },
    },
    getDirectionsForTrips: () =>
      Effect.succeed(
        new Map([
          ["trip-south", 0],
          ["trip-north", 1],
        ]),
      ),
  });

  const [result] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));

  expect(result.arrivals).toEqual([
    expect.objectContaining({ directionId: 0, label: "Southbound", times: [now + 60_000] }),
    expect.objectContaining({ directionId: 1, label: "Northbound", times: [now + 120_000] }),
  ]);
});

it("never turns a bare direction index into a compass word on a station board", async () => {
  const now = 1_700_000_000_000;
  const station = { ...unionStation, id: "LOOP", lines: ["7"], platformIds: ["loop-bay"] };
  const bytes = encodeFeed(now / 1000, [
    encodeSubwayTripUpdateEntity({
      entityId: "loop-trip",
      routeId: "7",
      stopId: "loop-bay",
      arrivalTimeSec: now / 1000 + 60,
      stopHeadsign: "Hillside",
    }),
    encodeSubwayTripUpdateEntity({
      entityId: "silent-trip",
      routeId: "7",
      stopId: "loop-bay",
      arrivalTimeSec: now / 1000 + 120,
    }),
  ]);
  const source = createGenericStationsSource({
    agencyId: "fictional-agency",
    stations: [station],
    feeds: [
      { kind: "station_trip_updates", url: "https://example.test/trips", format: "protobuf" },
    ],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    now: () => now,
    routeType: "bus",
    getDirectionsForTrips: () =>
      Effect.succeed(
        new Map([
          ["loop-trip", 0],
          ["silent-trip", 0],
        ]),
      ),
  });

  const [result] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));

  expect(result.arrivals.map(({ label, generatedLabel }) => ({ label, generatedLabel }))).toEqual([
    { label: "→ Hillside", generatedLabel: undefined },
    { label: "", generatedLabel: undefined },
  ]);
});

describe("generic stations source", () => {
  describe("cancelledTripsFrom", () => {
    const now = 1_700_000_000_000;
    const testStation = {
      id: "sample-stop",
      name: "Sample Station",
      lat: 0,
      lon: 0,
      lines: ["sample-route"],
      platformIds: ["sample-stop"],
    } as const;
    const trips = encodeFeed(now / 1000, [
      encodeSubwayTripUpdateEntity({
        entityId: "t-cancelled",
        tripId: "t-cancelled",
        routeId: "sample-route",
        stopId: "sample-stop",
        arrivalTimeSec: now / 1000 + 300,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "t-running",
        tripId: "t-running",
        routeId: "sample-route",
        stopId: "sample-stop",
        arrivalTimeSec: now / 1000 + 600,
      }),
    ]);
    const alerts = encodeFeed(now / 1000, [
      encodeAlertEntity({
        id: "cancel",
        selectors: [{ tripId: "t-cancelled" }],
        effect: 1,
        startSec: now / 1000 - 600,
      }),
    ]);
    const sourceWith = (alertsResponse: () => Response) =>
      createGenericStationsSource({
        agencyId: "sample",
        stations: [testStation],
        feeds: [
          {
            kind: "trip_updates",
            url: "https://example.test/trips",
            format: "protobuf",
            cancelledTripsFrom: "https://example.test/alerts",
          },
        ],
        fetch: vi.fn(async (input: RequestInfo | URL) =>
          String(input).includes("alerts") ? alertsResponse() : new Response(new Uint8Array(trips)),
        ) as typeof fetch,
        now: () => now,
      });
    const times = async (source: ReturnType<typeof sourceWith>) =>
      (
        await Effect.runPromise(source.fetchByIds({ stationIds: ["sample-stop"] }))
      )[0]?.arrivals.flatMap((group) => group.times);

    it("drops predictions for trips an active alert cancels", async () => {
      expect(await times(sourceWith(() => new Response(new Uint8Array(alerts))))).toEqual([
        now + 600_000,
      ]);
    });

    it("shows every prediction when the alerts feed is unreadable", async () => {
      expect(await times(sourceWith(() => new Response("down", { status: 503 })))).toEqual([
        now + 300_000,
        now + 600_000,
      ]);
    });
  });

  it("returns nearby and saved station arrivals from the shared trip feed seam", async () => {
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [unionStation],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
      lineMetadata: [
        { id: "LW", name: "Lakeshore West", color: "#000" },
        { id: "MI", name: "Milton", color: "#000" },
      ],
    });

    const nearby = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );
    const saved = await Effect.runPromise(source.fetchSaved({ stationNames: [unionStation.name] }));

    expect(nearby[0]).toEqual(
      expect.objectContaining({ id: "UN", stationName: unionStation.name }),
    );
    expect(nearby[0]?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
    expect(saved[0]?.stationName).toBe(unionStation.name);
  });

  it("uses Hamilton's explicit media type for the fallback trip_updates station feed", async () => {
    const station = {
      id: "HAMILTON-GO",
      schematicId: "hamilton-go-centre",
      name: "Hamilton GO Centre",
      lat: 43.252494,
      lon: -79.868582,
      lines: ["01", "02"],
      platformIds: ["HAMILTON-GO"],
    } as const;
    const observedAccepts: (string | null)[] = [];
    const bytes = encodeFeed(1_700_000_000, [
      encodeSubwayTripUpdateEntity({
        entityId: "hamilton-trip-1",
        routeId: "01",
        stopId: "HAMILTON-GO",
        stopSequence: 1,
        arrivalTimeSec: 1_700_000_300,
      }),
    ]);
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      const accept = new Headers(init?.headers).get("Accept");
      observedAccepts.push(accept);
      if (accept === "application/x-protobuf") return new Response("unsupported", { status: 406 });
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
        { status: 200 },
      );
    });
    const source = createGenericStationsSource({
      agencyId: "hamilton",
      stations: [station],
      feeds: [
        {
          kind: "trip_updates",
          url: "https://feeds.example.test/hamilton-trips",
          format: "protobuf",
          accept: "application/octet-stream",
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 1_700_000_000_000,
    });

    const [result] = await Effect.runPromise(
      source.fetchNearby({ lat: station.lat, lon: station.lon, radiusMeters: 500 }),
    );

    expect(result?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
    expect(observedAccepts).toEqual(["application/octet-stream"]);
  });

  it("maps TTC entity-id compass directions and removes near-duplicate platform times", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [{ ...unionStation, lines: ["LW"] }],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const first = buildTripFeedBytes("subway-trip-1|South", 1_700_000_300, "subway-trip-1");
        const second = buildTripFeedBytes("subway-trip-2|South", 1_700_000_330, "subway-trip-2");
        const third = buildTripFeedBytes("subway-trip-3|South", 1_700_000_450, "subway-trip-3");
        const merged = concatBuffers(first, second, third);
        return {
          ok: true,
          arrayBuffer: async () =>
            merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals[0]).toEqual({
      directionId: 1,
      label: "Southbound",
      generatedLabel: "southbound",
      times: [1_700_000_300_000, 1_700_000_450_000],
    });
  });

  it("lists one visit across two kerbs once and keeps a circuit's later pass", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [{ ...unionStation, lines: ["LW"], platformIds: ["UN", "UN-EAST"] }],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const kerb = (entityId: string, stopId: string, sequence: number, seconds: number) => {
          const trip = concatBuffers(encodeString(1, "loop-trip"), encodeString(5, "LW"));
          const arrival = concatBuffers(encodeVarintField(1, 0), encodeVarintField(2, seconds));
          const update = concatBuffers(
            encodeVarintField(1, sequence),
            encodeMessage(2, arrival),
            encodeString(4, stopId),
          );
          return encodeMessage(
            2,
            concatBuffers(
              encodeString(1, entityId),
              encodeMessage(3, concatBuffers(encodeMessage(1, trip), encodeMessage(2, update))),
            ),
          );
        };
        const merged = concatBuffers(
          encodeFeedHeader(1_700_000_000),
          kerb("west", "UN", 2, 1_700_000_420),
          kerb("east", "UN-EAST", 1, 1_700_000_300),
          kerb("return", "UN", 9, 1_700_001_320),
        );
        return {
          ok: true,
          arrayBuffer: async () =>
            merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals.flatMap((arrival) => arrival.times)).toEqual([
      1_700_000_300_000, 1_700_001_320_000,
    ]);
  });

  it("keeps a multi-line station together unless its manifest opts into line cards", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [{ ...unionStation, lines: ["LW", "MI"] }],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const nearby = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(nearby).toHaveLength(1);
    expect(nearby[0]?.lineIds).toEqual(["LW", "MI"]);
  });

  it("labels rail departures with their route termini instead of inbound/outbound", async () => {
    const oshawa = {
      id: "OS",
      schematicId: "oshawa",
      name: "Oshawa GO",
      lat: 43.87,
      lon: -78.88,
      lines: ["LE"],
      platformIds: ["OS"],
    } as const;
    const danforth = {
      id: "DA",
      schematicId: "danforth",
      name: "Danforth GO",
      lat: 43.686462,
      lon: -79.300358,
      lines: ["LE"],
      platformIds: ["DA"],
    } as const;
    const union = {
      id: "UN",
      schematicId: "union",
      name: "Union Station GO",
      lat: 43.645195,
      lon: -79.3806,
      lines: ["LE"],
      platformIds: ["UN"],
    } as const;
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [oshawa, danforth, union],
      lineSequences: { LE: ["oshawa", "danforth", "union"] },
      routeType: "rail",
      directionLiterals: { outbound: "Outbound", inbound: "Inbound" },
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "trip-to-oshawa|Outbound",
            routeId: "LE",
            stopId: "DA",
            arrivalTimeSec: 1_700_000_300,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "trip-to-union|Inbound",
            routeId: "LE",
            stopId: "DA",
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: danforth.lat, lon: danforth.lon, radiusMeters: 500 }),
    );

    expect(station?.arrivals.map((group) => group.label)).toEqual([
      "→ Oshawa GO",
      "→ Union Station GO",
    ]);
  });

  it("prefers a mode-specific station trip feed over the agency surface feed", async () => {
    const fetch = vi.fn(async (url: string) => {
      expect(url).toBe("https://example.test/subway-trips");
      const bytes = buildTripFeedBytes();
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response;
    });
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [unionStation],
      feeds: [
        { kind: "trip_updates", url: "https://example.test/surface-trips", format: "protobuf" },
        {
          kind: "station_trip_updates",
          url: "https://example.test/subway-trips",
          format: "protobuf",
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 12_345,
    });

    await Effect.runPromise(source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }));

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("does not refetch the station feed for repeated polling-shaped calls", async () => {
    const fetch = vi.fn(async () => {
      const bytes = buildTripFeedBytes();
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response;
    });
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [unionStation],
      feeds: [
        { kind: "station_trip_updates", url: "https://example.test/subway", format: "protobuf" },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 12_345,
    });

    await Promise.all([
      Effect.runPromise(
        source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
      ),
      Effect.runPromise(
        source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
      ),
    ]);
    await Effect.runPromise(
      source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
    );

    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("recovers from one transient station-feed connection failure", async () => {
    let calls = 0;
    const fetch = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("connection reset");
      const bytes = buildTripFeedBytes();
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response;
    });
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [unionStation],
      feeds: [
        { kind: "station_trip_updates", url: "https://example.test/subway", format: "protobuf" },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
    );

    expect(calls).toBe(2);
    expect(station?.arrivals).toHaveLength(1);
    expect(station?.arrivalsStale).toBeUndefined();
  });

  it("shares a successful station snapshot through the edge cache", async () => {
    const responses = new Map<string, Response>();
    vi.stubGlobal("caches", {
      default: {
        match: async (request: Request) => responses.get(request.url)?.clone(),
        put: async (request: Request, response: Response) => {
          responses.set(request.url, response.clone());
        },
      },
    });
    try {
      const bytes = buildTripFeedBytes();
      const fetch = vi.fn(
        async () =>
          ({
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          }) as Response,
      );
      const feed = [
        {
          kind: "station_trip_updates" as const,
          url: "https://example.test/subway",
          format: "protobuf" as const,
        },
      ];
      const createSource = () =>
        createGenericStationsSource({
          agencyId: "ttc",
          stations: [unionStation],
          feeds: feed,
          fetch: fetch as unknown as typeof globalThis.fetch,
          now: () => 12_345,
        });

      await Effect.runPromise(
        createSource().fetchNearby({
          lat: unionStation.lat,
          lon: unionStation.lon,
          radiusMeters: 500,
        }),
      );
      const [station] = await Effect.runPromise(
        createSource().fetchNearby({
          lat: unionStation.lat,
          lon: unionStation.lon,
          radiusMeters: 500,
        }),
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(station?.arrivals).toHaveLength(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("returns decoded arrivals when the edge cache write fails", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: async () => undefined,
        put: vi.fn(async () => {
          throw new Error("edge cache unavailable");
        }),
      },
    });
    try {
      const bytes = buildTripFeedBytes();
      const fetch = vi.fn(
        async () =>
          new Response(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ),
      );
      const source = createGenericStationsSource({
        agencyId: "ttc",
        stations: [unionStation],
        feeds: [
          { kind: "station_trip_updates", url: "https://example.test/subway", format: "protobuf" },
        ],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => 12_345,
      });

      const [station] = await Effect.runPromise(
        source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(station?.arrivals).toHaveLength(1);
      expect(station?.arrivalsStale).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("fetches upstream arrivals when the edge cache read fails", async () => {
    vi.stubGlobal("caches", {
      default: {
        match: vi.fn(async () => {
          throw new Error("edge cache unavailable");
        }),
        put: vi.fn(async () => undefined),
      },
    });
    try {
      const bytes = buildTripFeedBytes();
      const fetch = vi.fn(
        async () =>
          new Response(
            bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ) as ArrayBuffer,
          ),
      );
      const source = createGenericStationsSource({
        agencyId: "ttc",
        stations: [unionStation],
        feeds: [
          { kind: "station_trip_updates", url: "https://example.test/subway", format: "protobuf" },
        ],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => 12_345,
      });

      const [station] = await Effect.runPromise(
        source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      expect(station?.arrivals).toHaveLength(1);
      expect(station?.arrivalsStale).toBeUndefined();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps the station visible with a last-known marker when the trip feed is unavailable", async () => {
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [unionStation],
      feeds: [
        {
          kind: "trip_updates",
          url: "https://example.test/trips",
          format: "protobuf",
        },
      ],
      fetch: vi.fn(async () => ({ ok: false, status: 503 }) as Response) as unknown as typeof fetch,
    });

    const nearby = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(nearby).toEqual([
      expect.objectContaining({
        id: unionStation.id,
        stationName: unionStation.name,
        arrivals: [],
        arrivalsStale: true,
      }),
    ]);
  });

  it("cools down repeated station-feed failures and recovers with last-good arrivals", async () => {
    const startAt = 1_700_000_000_000;
    let mode: "healthy" | "outage" | "recovered" = "healthy";
    const fetch = vi.fn(async () => {
      if (mode === "outage") return new Response("rate limited", { status: 429 });
      const bytes =
        mode === "healthy"
          ? buildTripFeedBytes("good-trip", 1_700_000_300)
          : buildTripFeedBytes("recovered-trip", 1_700_001_000);
      return new Response(
        bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
      );
    });
    vi.useFakeTimers();
    vi.setSystemTime(startAt);
    try {
      const source = createGenericStationsSource({
        agencyId: "ttc",
        stations: [unionStation],
        feeds: [
          { kind: "station_trip_updates", url: "https://example.test/subway", format: "protobuf" },
        ],
        fetch: fetch as unknown as typeof globalThis.fetch,
        now: () => Date.now(),
      });
      const request = () =>
        Effect.runPromise(
          source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
        );

      const [initial] = await request();
      expect(initial?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
      expect(initial?.arrivalsStale).toBeUndefined();

      mode = "outage";
      vi.advanceTimersByTime(STATION_FEED_CACHE_TTL_MS + 1);
      const [stale] = await request();
      expect(stale?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
      expect(stale?.arrivalsStale).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);

      const [stillStale] = await request();
      expect(stillStale?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
      expect(stillStale?.arrivalsStale).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);

      vi.advanceTimersByTime(STATION_FEED_FAILURE_TTL_MS + 1);
      const [repeatedFailure] = await request();
      expect(repeatedFailure?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
      expect(repeatedFailure?.arrivalsStale).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);

      const [stillStaleAgain] = await request();
      expect(stillStaleAgain?.arrivals[0]?.times).toEqual([1_700_000_300_000]);
      expect(stillStaleAgain?.arrivalsStale).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(3);

      mode = "recovered";
      vi.advanceTimersByTime(STATION_FEED_FAILURE_TTL_MS + 1);
      const [fresh] = await request();
      expect(fresh?.arrivals[0]?.times).toEqual([1_700_001_000_000]);
      expect(fresh?.arrivalsStale).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("splits a multi-line station into one card per line with route-specific arrivals", async () => {
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [{ ...unionStation, lines: ["LW", "MI"] }],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
      splitByLine: true,
      lineMetadata: [
        { id: "LW", name: "Lakeshore West", color: "#000" },
        { id: "MI", name: "Milton", color: "#000" },
      ],
    });

    const nearby = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(nearby.map((station) => [station.id, station.lineIds, station.arrivals.length])).toEqual(
      [
        ["UN:LW", ["LW"], 1],
        ["UN:MI", ["MI"], 0],
      ],
    );
    expect(nearby.map((station) => station.lineName)).toEqual(["Lakeshore West", "Milton"]);
  });

  it("resolves Xbound entity-id suffixes through the shared direction vocabulary", async () => {
    // Intentional unification, pinned explicitly: directionIdFor previously
    // resolved only bare compass words ("north"/"south"/...); both bare
    // and Xbound suffixes route through directionLabelFor so
    // "northbound"/"southbound"/"eastbound"/"westbound" map to 0/1 just like
    // their bare-word counterparts. This unification stays pinned here
    // at the stations seam rather than reverted.
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [unionStation],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const merged = concatBuffers(
          buildTripFeedBytes("trip-north|Northbound", 1_700_000_300, "trip-north"),
          buildTripFeedBytes("trip-south|Southbound", 1_700_000_400, "trip-south"),
          buildTripFeedBytes("trip-east|Eastbound", 1_700_000_500, "trip-east"),
          buildTripFeedBytes("trip-west|Westbound", 1_700_000_600, "trip-west"),
        );
        return {
          ok: true,
          arrayBuffer: async () =>
            merged.buffer.slice(merged.byteOffset, merged.byteOffset + merged.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals).toEqual([
      {
        directionId: 0,
        label: "Northbound",
        generatedLabel: "northbound",
        times: [1_700_000_300_000],
      },
      {
        directionId: 1,
        label: "Southbound",
        generatedLabel: "southbound",
        times: [1_700_000_400_000],
      },
      {
        directionId: 0,
        label: "Eastbound",
        generatedLabel: "eastbound",
        times: [1_700_000_500_000],
      },
      {
        directionId: 1,
        label: "Westbound",
        generatedLabel: "westbound",
        times: [1_700_000_600_000],
      },
    ]);
  });

  it("uses the GTFS direction id when a trip entity id is not directional", async () => {
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [unionStation],
      routeType: "rail",
      directionLiterals: { outbound: "Outbound", inbound: "Inbound" },
      feeds: [{ kind: "trip_updates", url: "https://example.test/go-trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes("non-directional-trip", 1_900_000_300);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 1_800_000_000_000,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
    );

    expect(station?.arrivals).toEqual([
      { directionId: 0, label: "Outbound", times: [1_900_000_300_000] },
    ]);
  });

  it.each([
    ["is unavailable", { ok: false, status: 503 } as Response],
    // One entity whose nested trip_update overruns it, so nothing decodes.
    ["has no decodable entities", new Response(new Uint8Array([0x12, 0x03, 0x1a, 0x05, 0x00]))],
  ])(
    "keeps station arrivals but marks the board stale when an auxiliary trip feed %s",
    async (_, auxiliary) => {
      const source = createGenericStationsSource({
        agencyId: "go",
        stations: [unionStation],
        routeType: "rail",
        directionLiterals: { outbound: "Outbound", inbound: "Inbound" },
        feeds: [
          { kind: "trip_updates", url: "https://example.test/go-trips", format: "protobuf" },
          { kind: "trip_updates", url: "https://example.test/up-trips", format: "protobuf" },
        ],
        fetch: vi.fn(async (url: string) => {
          if (url.includes("up-trips")) return auxiliary;
          const bytes = buildTripFeedBytes("go-trip", 1_900_000_300);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          } as Response;
        }) as unknown as typeof fetch,
        now: () => 1_800_000_000_000,
      });

      const [station] = await Effect.runPromise(
        source.fetchNearby({ lat: unionStation.lat, lon: unionStation.lon, radiusMeters: 500 }),
      );

      expect(station?.arrivals[0]?.times).toEqual([1_900_000_300_000]);
      expect(station?.arrivalsStale).toBe(true);
    },
  );

  it("resolves a schematic station id to its index entry for departures lookup", async () => {
    // Map identity (StationInfo.id) rides the schematic id; card identity
    // rides the index id, and the two never match directly, so the lookup
    // matches `schematicId ?? id` and answers with the index-keyed card.
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [{ ...unionStation, id: "UN-index", schematicId: "union-schematic" }],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchByIds({ stationIds: ["union-schematic"] }),
    );

    expect(station).toEqual(expect.objectContaining({ id: "UN-index" }));
    expect(station?.arrivals[0]?.times).toEqual([1_700_000_300_000]);

    const nameLookup = await Effect.runPromise(
      source.fetchByIds({ stationIds: ["Union Station GO"] }),
    );
    expect(nameLookup).toEqual([]);
  });

  it("returns a legitimate empty for unknown station ids", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [unionStation],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const stations = await Effect.runPromise(
      source.fetchByIds({ stationIds: ["no-such-station"] }),
    );

    expect(stations).toEqual([]);
  });

  it("returns every line split for a multi-line station id", async () => {
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [{ ...unionStation, lines: ["LW", "MI"] }],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = buildTripFeedBytes();
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
      splitByLine: true,
      lineMetadata: [
        { id: "LW", name: "Lakeshore West", color: "#000" },
        { id: "MI", name: "Milton", color: "#000" },
      ],
    });

    const stations = await Effect.runPromise(source.fetchByIds({ stationIds: ["UN"] }));

    expect(stations.map((station) => station.id)).toEqual(["UN:LW", "UN:MI"]);
  });

  it("qualifies same-direction rows with their terminal when headsigns differ", async () => {
    // Bottom-of-the-U stations read one compass word for both service
    // directions. The rows must name the terminal instead of merging into a
    // single ambiguous direction.
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [unionStation],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-a|North",
            routeId: "LW",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_300,
            stopHeadsign: "Aldershot GO",
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-b|North",
            routeId: "LW",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_400,
            stopHeadsign: "Oshawa GO",
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals).toEqual([
      { directionId: 0, label: "→ Aldershot GO", times: [1_700_000_300_000] },
      { directionId: 0, label: "→ Oshawa GO", times: [1_700_000_400_000] },
    ]);
  });

  it("keeps the plain direction label when every trip shares one terminal", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [unionStation],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-a|North",
            routeId: "LW",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_300,
            stopHeadsign: "Aldershot GO",
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-b|North",
            routeId: "LW",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_400,
            stopHeadsign: "Aldershot GO",
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals).toEqual([
      {
        directionId: 0,
        label: "Northbound",
        generatedLabel: "northbound",
        times: [1_700_000_300_000, 1_700_000_400_000],
      },
    ]);
  });

  it("drops terminating arrivals and badges departures at both line termini", async () => {
    // Finch ends line 1: the North trip ends there (arrival, out of
    // service) while the South trip starts there and continues. Only the
    // departure direction may render.
    const finch = {
      id: "43277",
      schematicId: "finch",
      name: "Finch",
      lat: 43.780846,
      lon: -79.415291,
      lines: ["1"],
      platformIds: ["F1"],
    } as const;
    const sheppard = {
      id: "43278",
      schematicId: "sheppard-yonge",
      name: "Sheppard-Yonge",
      lat: 43.761539,
      lon: -79.411079,
      lines: ["1"],
      platformIds: ["SH1"],
    } as const;
    const vaughan = {
      id: "15209",
      schematicId: "vaughan",
      name: "Vaughan Metropolitan Centre",
      lat: 43.794239,
      // Align the simplified test sequence with the north/south direction
      // inferred from its adjacent station.
      lon: -79.411079,
      lines: ["1"],
      platformIds: ["V1"],
    } as const;
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [finch, sheppard, vaughan],
      lineSequences: { "1": ["vaughan", "sheppard-yonge", "finch"] },
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-vaughan|South",
            routeId: "1",
            stopId: "V1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_250,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-north|North",
            routeId: "1",
            stopId: "F1",
            stopSequence: 10,
            arrivalTimeSec: 1_700_000_300,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-south|South",
            routeId: "1",
            stopId: "F1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_400,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-south|South",
            routeId: "1",
            stopId: "SH1",
            stopSequence: 2,
            arrivalTimeSec: 1_700_000_500,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const stations = await Effect.runPromise(
      source.fetchNearby({ lat: finch.lat, lon: finch.lon, radiusMeters: 500 }),
    );

    expect(stations.map((station) => station.stationName)).toContain("Finch");
    const finchCard = stations.find((station) => station.stationName === "Finch");
    expect(finchCard?.arrivals).toEqual([
      {
        directionId: 1,
        label: "Southbound",
        generatedLabel: "southbound",
        times: [1_700_000_400_000],
        lineId: "1",
      },
    ]);

    const [vaughanCard] = await Effect.runPromise(
      source.fetchNearby({ lat: vaughan.lat, lon: vaughan.lon, radiusMeters: 500 }),
    );
    expect(vaughanCard?.arrivals).toEqual([
      {
        directionId: 1,
        label: "Southbound",
        generatedLabel: "southbound",
        times: [1_700_000_250_000],
        lineId: "1",
      },
    ]);
  });

  it("names the terminal from the station entry when declared", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [
        {
          ...unionStation,
          lines: ["1"],
          directionTermini: { northbound: "Vaughan Metropolitan Centre", southbound: "Finch" },
        },
      ],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-trip-1|South",
            routeId: "1",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_300,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-trip-2|North",
            routeId: "1",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals.map((group) => group.label).sort()).toEqual([
      "→ Finch",
      "→ Vaughan Metropolitan Centre",
    ]);
    expect(station?.arrivals.map((group) => group.lineId)).toEqual(["1", "1"]);
  });

  it("prefers live headsigns over the declared terminal on collision", async () => {
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [
        {
          ...unionStation,
          lines: ["1"],
          directionTermini: { northbound: "Finch" },
        },
      ],
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-a|North",
            routeId: "1",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_300,
            stopHeadsign: "Aldershot GO",
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-b|North",
            routeId: "1",
            stopId: "UN",
            arrivalTimeSec: 1_700_000_400,
            stopHeadsign: "Oshawa GO",
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [station] = await Effect.runPromise(
      source.fetchNearby({ lat: 43.6455, lon: -79.3806, radiusMeters: 500 }),
    );

    expect(station?.arrivals.map((group) => group.label)).toEqual([
      "→ Aldershot GO",
      "→ Oshawa GO",
    ]);
  });

  it("keeps terminating arrivals mid-sequence and without sequence data", async () => {
    const finch = {
      id: "43277",
      schematicId: "finch",
      name: "Finch",
      lat: 43.780846,
      lon: -79.415291,
      lines: ["1"],
      platformIds: ["F1"],
    } as const;
    const feed = (url: string) => ({
      kind: "trip_updates" as const,
      url,
      format: "protobuf" as const,
    });
    const fetchFn = vi.fn(async () => {
      const bytes = encodeFeed(1_700_000_000, [
        encodeSubwayTripUpdateEntity({
          entityId: "subway-north|North",
          routeId: "1",
          stopId: "F1",
          stopSequence: 10,
          arrivalTimeSec: 1_700_000_300,
        }),
        encodeSubwayTripUpdateEntity({
          entityId: "subway-south|South",
          routeId: "1",
          stopId: "F1",
          stopSequence: 1,
          arrivalTimeSec: 1_700_000_400,
        }),
      ]);
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response;
    }) as unknown as typeof fetch;
    const createSource = (lineSequences?: Record<string, readonly string[]>) =>
      createGenericStationsSource({
        agencyId: "ttc",
        stations: [finch],
        lineSequences,
        feeds: [feed("https://example.test/trips")],
        fetch: fetchFn,
        now: () => 12_345,
      });

    // Mid-sequence: the rule is terminus-gated, so both rows render.
    const midSequence = await Effect.runPromise(
      createSource({ "1": ["vaughan", "finch", "sheppard-yonge"] }).fetchNearby({
        lat: finch.lat,
        lon: finch.lon,
        radiusMeters: 500,
      }),
    );
    expect(midSequence[0]?.arrivals.map((group) => group.label).sort()).toEqual([
      "Northbound",
      "Southbound",
    ]);

    // No sequences at all: the rule is inert, both rows render.
    const noSequences = await Effect.runPromise(
      createSource().fetchNearby({ lat: finch.lat, lon: finch.lon, radiusMeters: 500 }),
    );
    expect(noSequences[0]?.arrivals.map((group) => group.label).sort()).toEqual([
      "Northbound",
      "Southbound",
    ]);
  });

  it("keeps terminus departures when the departing trip only contains the terminus stop", async () => {
    const finch = {
      id: "43277",
      schematicId: "finch",
      name: "Finch",
      lat: 43.780846,
      lon: -79.415291,
      lines: ["1"],
      platformIds: ["F1"],
    } as const;
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [
        finch,
        {
          id: "43278",
          schematicId: "sheppard-yonge",
          name: "Sheppard-Yonge",
          lat: 43.761539,
          lon: -79.411079,
          lines: ["1"],
          platformIds: ["SH1"],
        },
      ],
      lineSequences: { "1": ["vaughan", "sheppard-yonge", "finch"] },
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-north|North",
            routeId: "1",
            stopId: "F1",
            stopSequence: 10,
            arrivalTimeSec: 1_700_000_300,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "subway-south|South",
            routeId: "1",
            stopId: "F1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const stations = await Effect.runPromise(
      source.fetchNearby({ lat: finch.lat, lon: finch.lon, radiusMeters: 500 }),
    );
    const finchCard = stations.find((station) => station.stationName === "Finch");
    expect(finchCard?.arrivals).toEqual([
      {
        directionId: 1,
        label: "Southbound",
        generatedLabel: "southbound",
        times: [1_700_000_400_000],
        lineId: "1",
      },
    ]);
  });

  it("populates departing direction from turnaround incoming trips when no departure trip is active", async () => {
    const finch = {
      id: "43277",
      schematicId: "finch",
      name: "Finch",
      lat: 43.780846,
      lon: -79.415291,
      lines: ["1"],
      platformIds: ["F1"],
    } as const;
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [
        finch,
        {
          id: "43278",
          schematicId: "sheppard-yonge",
          name: "Sheppard-Yonge",
          lat: 43.761539,
          lon: -79.411079,
          lines: ["1"],
          platformIds: ["SH1"],
        },
      ],
      lineSequences: { "1": ["vaughan", "sheppard-yonge", "finch"] },
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "subway-north|North",
            routeId: "1",
            stopId: "F1",
            stopSequence: 10,
            arrivalTimeSec: 1_700_000_300,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const stations = await Effect.runPromise(
      source.fetchNearby({ lat: finch.lat, lon: finch.lon, radiusMeters: 500 }),
    );
    const finchCard = stations.find((station) => station.stationName === "Finch");
    expect(finchCard?.arrivals).toEqual([
      {
        directionId: 1,
        label: "Southbound",
        generatedLabel: "southbound",
        times: [1_700_000_300_000],
        lineId: "1",
      },
    ]);
  });

  it("labels rail terminus departures with destinations and keeps routeLineMap turnaround fallbacks", async () => {
    function encodeRailTrip(options: {
      entityId: string;
      tripId: string;
      routeId: string;
      directionId: number;
      stopId: string;
      arrivalTimeSec: number;
    }): Uint8Array {
      const tripDesc = concatBuffers(
        encodeString(1, options.tripId),
        encodeString(5, options.routeId),
        encodeVarintField(6, options.directionId),
      );
      const arrival = concatBuffers(
        encodeVarintField(1, 0),
        encodeVarintField(2, options.arrivalTimeSec),
      );
      const stopUpdate = concatBuffers(
        encodeVarintField(1, 1),
        encodeMessage(2, arrival),
        encodeString(4, options.stopId),
      );
      const tripUpdate = concatBuffers(encodeMessage(1, tripDesc), encodeMessage(2, stopUpdate));
      return encodeMessage(
        2,
        concatBuffers(encodeString(1, options.entityId), encodeMessage(3, tripUpdate)),
      );
    }

    const union = {
      id: "UN",
      schematicId: "union",
      name: "Union Station GO",
      lat: 43.645195,
      lon: -79.3806,
      lines: ["LW", "KI"],
      platformIds: ["UN"],
    } as const;

    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [
        union,
        {
          id: "EX",
          schematicId: "exhibition",
          name: "Exhibition GO",
          lat: 43.6353,
          lon: -79.4189,
          lines: ["LW"],
          platformIds: ["EX"],
        },
        {
          id: "BL",
          schematicId: "bloor",
          name: "Bloor GO",
          lat: 43.6566,
          lon: -79.4533,
          lines: ["KI"],
          platformIds: ["BL"],
        },
      ],
      lineSequences: {
        LW: ["exhibition", "union"],
        KI: ["bloor", "union"],
      },
      routeLineMap: {
        GT: "KI",
      },
      routeType: "rail",
      splitByLine: true,
      directionLiterals: {
        outbound: "Outbound",
        inbound: "Inbound",
      },
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          // LW Outbound departure
          encodeRailTrip({
            entityId: "trip-lw-out",
            tripId: "trip-lw-out",
            routeId: "LW",
            directionId: 0,
            stopId: "UN",
            arrivalTimeSec: 1_700_000_400,
          }),
          // LW Inbound terminating arrival (should be dropped because LW has an outbound departure)
          encodeRailTrip({
            entityId: "trip-lw-in",
            tripId: "trip-lw-in",
            routeId: "LW",
            directionId: 1,
            stopId: "UN",
            arrivalTimeSec: 1_700_000_300,
          }),
          // KI Inbound terminating arrival with GT route prefix (should turnaround to Outbound because no outbound trips exist)
          encodeRailTrip({
            entityId: "trip-ki-in",
            tripId: "trip-ki-in",
            routeId: "09261126-GT",
            directionId: 1,
            stopId: "UN",
            arrivalTimeSec: 1_700_000_500,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const stations = await Effect.runPromise(
      source.fetchNearby({ lat: union.lat, lon: union.lon, radiusMeters: 500 }),
    );

    const lwCard = stations.find((s) => s.id === "UN:LW");
    expect(lwCard?.arrivals).toEqual([
      { directionId: 0, label: "→ Exhibition GO", times: [1_700_000_400_000], lineId: "LW" },
    ]);

    const kiCard = stations.find((s) => s.id === "UN:KI");
    expect(kiCard?.arrivals).toEqual([
      { directionId: 0, label: "→ Bloor GO", times: [1_700_000_500_000], lineId: "KI" },
    ]);
  });

  it("ingests multiple station_trip_updates feeds together", async () => {
    const stationA = {
      id: "STA",
      schematicId: "sta",
      name: "Station A",
      lat: 43.7,
      lon: -79.4,
      lines: ["1", "5"],
      platformIds: ["P1"],
    } as const;

    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [stationA],
      feeds: [
        {
          kind: "station_trip_updates",
          url: "https://example.test/subway",
          format: "protobuf",
        },
        {
          kind: "station_trip_updates",
          url: "https://example.test/lrt",
          format: "protobuf",
        },
      ],
      fetch: vi.fn(async (url: string | URL | Request) => {
        const urlStr = typeof url === "string" ? url : "url" in url ? url.url : url.toString();
        if (urlStr.includes("subway")) {
          const bytes = encodeFeed(1_700_000_000, [
            encodeSubwayTripUpdateEntity({
              entityId: "subway-1",
              routeId: "1",
              stopId: "P1",
              stopSequence: 1,
              arrivalTimeSec: 1_700_000_300,
            }),
          ]);
          return {
            ok: true,
            arrayBuffer: async () =>
              bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
          } as Response;
        }
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "lrt-5",
            routeId: "5",
            stopId: "P1",
            stopSequence: 2,
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [card] = await Effect.runPromise(
      source.fetchNearby({ lat: stationA.lat, lon: stationA.lon, radiusMeters: 500 }),
    );

    expect(card?.arrivals).toBeDefined();
    const allTimes = card?.arrivals.flatMap((a) => a.times) ?? [];
    expect(allTimes).toContain(1_700_000_300_000);
    expect(allTimes).toContain(1_700_000_400_000);
  });

  it("matches predictions where stopId is the station id, schematicId, or platformId", async () => {
    const bessarion = {
      id: "14578",
      schematicId: "bessarion",
      name: "Bessarion",
      lat: 43.769199,
      lon: -79.376312,
      lines: ["4"],
      platformIds: ["13845", "13846"],
    } as const;

    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [bessarion],
      feeds: [
        {
          kind: "station_trip_updates",
          url: "https://example.test/subway",
          format: "protobuf",
        },
      ],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          // Platform ID prediction
          encodeSubwayTripUpdateEntity({
            entityId: "subway-east",
            routeId: "4",
            stopId: "13845",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_300,
          }),
          // Station ID prediction
          encodeSubwayTripUpdateEntity({
            entityId: "subway-west",
            routeId: "4",
            stopId: "14578",
            stopSequence: 2,
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const cards = await Effect.runPromise(source.fetchByIds({ stationIds: ["bessarion"] }));
    expect(cards).toHaveLength(1);
    const times = cards[0]?.arrivals.flatMap((a) => a.times) ?? [];
    expect(times).toContain(1_700_000_300_000);
    expect(times).toContain(1_700_000_400_000);
  });

  it("orders transfer station directions consistently: Northbound, Southbound, Westbound, Eastbound with lineId on each group", async () => {
    const bloorYonge = {
      id: "BY",
      schematicId: "bloor-yonge",
      name: "Bloor-Yonge",
      lat: 43.6709,
      lon: -79.3857,
      lines: ["1", "2"],
      platformIds: ["BY1", "BY2"],
    } as const;

    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [bloorYonge],
      feeds: [
        { kind: "station_trip_updates", url: "https://example.test/subway", format: "protobuf" },
      ],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          // Eastbound Line 2 arrives earliest (should NOT be first)
          encodeSubwayTripUpdateEntity({
            entityId: "subway-east|East",
            routeId: "2",
            stopId: "BY2",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_100,
          }),
          // Southbound Line 1 arrives second
          encodeSubwayTripUpdateEntity({
            entityId: "subway-south|South",
            routeId: "1",
            stopId: "BY1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_200,
          }),
          // Westbound Line 2 arrives third
          encodeSubwayTripUpdateEntity({
            entityId: "subway-west|West",
            routeId: "2",
            stopId: "BY2",
            stopSequence: 2,
            arrivalTimeSec: 1_700_000_300,
          }),
          // Northbound Line 1 arrives latest (must be FIRST in order)
          encodeSubwayTripUpdateEntity({
            entityId: "subway-north|North",
            routeId: "1",
            stopId: "BY1",
            stopSequence: 2,
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [card] = await Effect.runPromise(
      source.fetchNearby({ lat: bloorYonge.lat, lon: bloorYonge.lon, radiusMeters: 500 }),
    );

    expect(card?.arrivals).toBeDefined();
    expect(card?.arrivals.map((a) => ({ label: a.label, lineId: a.lineId }))).toEqual([
      { label: "Northbound", lineId: "1" },
      { label: "Southbound", lineId: "1" },
      { label: "Westbound", lineId: "2" },
      { label: "Eastbound", lineId: "2" },
    ]);
  });

  it("groups opposing directions of the same line together at surface transfer stations", async () => {
    const transferHub = {
      id: "hub",
      schematicId: "hub",
      name: "Transfer Hub",
      lat: 43.4,
      lon: -79.8,
      lines: ["2", "6", "11"],
      platformIds: ["H1"],
    } as const;

    const source = createGenericStationsSource({
      agencyId: "burlington",
      stations: [transferHub],
      feeds: [
        { kind: "station_trip_updates", url: "https://example.test/trips", format: "protobuf" },
      ],
      fetch: vi.fn(async () => {
        const bytes = encodeFeed(1_700_000_000, [
          encodeSubwayTripUpdateEntity({
            entityId: "bus-6-north|North",
            routeId: "6",
            stopId: "H1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_100,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "bus-11-north|North",
            routeId: "11",
            stopId: "H1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_200,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "bus-2-south|South",
            routeId: "2",
            stopId: "H1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_300,
          }),
          encodeSubwayTripUpdateEntity({
            entityId: "bus-6-south|South",
            routeId: "6",
            stopId: "H1",
            stopSequence: 1,
            arrivalTimeSec: 1_700_000_400,
          }),
        ]);
        return {
          ok: true,
          arrayBuffer: async () =>
            bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
        } as Response;
      }) as unknown as typeof fetch,
      now: () => 12_345,
    });

    const [card] = await Effect.runPromise(
      source.fetchNearby({ lat: transferHub.lat, lon: transferHub.lon, radiusMeters: 500 }),
    );

    expect(card?.arrivals.map((a) => ({ label: a.label, lineId: a.lineId }))).toEqual([
      { label: "Southbound", lineId: "2" },
      { label: "Northbound", lineId: "6" },
      { label: "Southbound", lineId: "6" },
      { label: "Northbound", lineId: "11" },
    ]);
  });

  it("ingests per-platform JSON station departures for LRT stations", async () => {
    const now = 1_700_000_000_000;
    const avenue = {
      id: "16776",
      schematicId: "avenue",
      name: "Avenue",
      lat: 43.704742,
      lon: -79.408844,
      lines: ["5"],
      platformIds: ["16071", "16072"],
    } as const;
    const humberCollege = {
      id: "16811",
      schematicId: "humber-college",
      name: "Humber College",
      lat: 43.72963,
      lon: -79.60141,
      lines: ["6"],
      platformIds: ["16289", "16290"],
    } as const;
    const eglinton = {
      id: "14574",
      schematicId: "eglinton",
      name: "Eglinton",
      lat: 43.7069,
      lon: -79.398,
      lines: ["1"],
      platformIds: ["13859"],
    } as const;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const stopCode = url.split("/").at(-1);
      const payload =
        stopCode === "16071"
          ? [
              {
                line: "5",
                direction: "0",
                nextTrains: "7, 13, 14",
                directionText: "Eastbound to Kennedy",
                stopCode,
              },
            ]
          : stopCode === "16072"
            ? [
                {
                  line: "5",
                  direction: "1",
                  nextTrains: "1, 6",
                  directionText: "Westbound to Mount Dennis",
                  stopCode,
                },
              ]
            : stopCode === "16289"
              ? [
                  {
                    line: "6",
                    direction: "0",
                    nextTrains: "0, 4",
                    directionText: "Eastbound to Finch West",
                    stopCode,
                  },
                ]
              : [
                  {
                    line: "6",
                    direction: "1",
                    nextTrains: "2, 8",
                    directionText: "Westbound to Humber College",
                    stopCode,
                  },
                ];
      return new Response(JSON.stringify(payload), { status: 200 });
    });

    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [avenue, humberCollege, eglinton],
      feeds: [
        {
          kind: "station_departures",
          url: "https://example.test/next-train/{stopId}",
          format: "json",
          lineIds: ["5", "6"],
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
      directionLiterals: {
        east: "Eastbound",
        west: "Westbound",
      },
      routeType: "subway",
    });

    const stations = await Effect.runPromise(
      source.fetchByIds({ stationIds: ["avenue", "humber-college", "eglinton"] }),
    );
    const station = stations.find((candidate) => candidate.stationName === "Avenue");
    const humber = stations.find((candidate) => candidate.stationName === "Humber College");
    const eglintonCard = stations.find((candidate) => candidate.stationName === "Eglinton");

    expect(station?.arrivals).toEqual([
      {
        directionId: 1,
        label: "Westbound",
        times: [now + 60_000, now + 360_000],
      },
      {
        directionId: 0,
        label: "Eastbound",
        times: [now + 420_000, now + 780_000, now + 840_000],
      },
    ]);
    expect(humber?.arrivals).toEqual([
      {
        directionId: 0,
        label: "Eastbound",
        times: [now + 1_000, now + 240_000],
      },
      {
        directionId: 1,
        label: "Westbound",
        times: [now + 120_000, now + 480_000],
      },
    ]);
    expect(eglintonCard?.arrivals).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("ignores empty TTC next-train values instead of rendering false Due departures", async () => {
    const now = 1_700_000_000_000;
    const albion = {
      id: "16814",
      schematicId: "albion",
      name: "Albion",
      lat: 43.741295,
      lon: -79.58934,
      lines: ["6"],
      platformIds: ["16295", "16296"],
    } as const;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const stopCode = url.split("/").at(-1);
      const direction = stopCode === "16295" ? "0" : "1";
      const nextTrains = stopCode === "16295" ? "" : "   ";
      return new Response(
        JSON.stringify([
          {
            line: "6",
            direction,
            nextTrains,
            directionText:
              direction === "0" ? "Eastbound to Finch West" : "Westbound to Humber College",
            stopCode,
          },
        ]),
        { status: 200 },
      );
    });

    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [albion],
      feeds: [
        {
          kind: "station_departures",
          url: "https://example.test/next-train/{stopId}",
          format: "json",
          lineIds: ["6"],
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
      directionLiterals: { east: "Eastbound", west: "Westbound" },
      routeType: "subway",
    });

    const [station] = await Effect.runPromise(source.fetchByIds({ stationIds: ["albion"] }));

    expect(station?.arrivals).toEqual([]);
  });

  it("marks only the station whose departures feed failed as stale", async () => {
    const stationA = {
      id: "station-a",
      name: "Station A",
      lat: 43.7,
      lon: -79.4,
      lines: ["1"],
      platformIds: ["platform-a"],
    } as const;
    const stationB = {
      id: "station-b",
      name: "Station B",
      lat: 43.71,
      lon: -79.4,
      lines: ["1"],
      platformIds: ["platform-b"],
    } as const;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const stopId = url.split("/").at(-1);
      if (stopId === "platform-a") return new Response("unavailable", { status: 503 });
      return new Response(
        JSON.stringify([
          {
            line: "1",
            direction: "0",
            nextTrains: "5",
            directionText: "Northbound to Terminal",
            stopCode: stopId,
          },
        ]),
        { status: 200 },
      );
    });
    const source = createGenericStationsSource({
      agencyId: "ttc",
      stations: [stationA, stationB],
      feeds: [
        {
          kind: "station_departures",
          url: "https://example.test/next-train/{stopId}",
          format: "json",
          lineIds: ["1"],
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => 1_700_000_000_000,
    });

    const stations = await Effect.runPromise(
      source.fetchByIds({ stationIds: ["station-a", "station-b"] }),
    );
    const byName = new Map(stations.map((station) => [station.stationName, station]));

    expect(byName.get("Station A")?.arrivalsStale).toBe(true);
    expect(byName.get("Station B")?.arrivalsStale).toBeUndefined();
    expect(byName.get("Station B")?.arrivals).toEqual([
      {
        directionId: 0,
        label: "Northbound",
        generatedLabel: "northbound",
        times: [1_700_000_300_000],
      },
    ]);
  });

  it("settles platform failures, keeps successful departures, and bounds station fanout", async () => {
    const platformIds = Array.from({ length: 12 }, (_, index) => `platform-${index}`);
    const station = {
      id: "fictional-hub",
      name: "Fictional Hub",
      lat: 43.7,
      lon: -79.4,
      lines: ["R1"],
      platformIds,
    } as const;
    let active = 0;
    let maxActive = 0;
    const fetch = vi.fn(async (input: string | URL | Request) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const stopId = url.split("/").at(-1);
      await new Promise((resolve) => setTimeout(resolve, 2));
      active -= 1;
      if (stopId === "platform-4") return new Response("upstream", { status: 503 });
      return new Response(
        JSON.stringify([
          {
            line: "R1",
            direction: 0,
            nextTrains: [3],
            directionText: "Northbound to Terminal",
            stopCode: stopId,
          },
        ]),
        { status: 200 },
      );
    });
    const source = createGenericStationsSource({
      agencyId: "fictional-transit",
      stations: [station],
      feeds: [
        {
          kind: "station_departures",
          url: "https://feeds.example.test/departures/{stopId}",
          format: "json",
          lineIds: ["R1"],
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => Date.parse("2026-10-15T12:00:00Z"),
      routeType: "bus",
    });
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);

    const [card] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));

    expect(fetch).toHaveBeenCalledTimes(platformIds.length);
    expect(maxActive).toBeGreaterThan(1);
    expect(maxActive).toBeLessThanOrEqual(STATION_DEPARTURES_CONCURRENCY);
    expect(card?.arrivalsStale).toBe(true);
    expect(card?.arrivals.length).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("station departures are partial"),
      expect.objectContaining({ agencyId: "fictional-transit", failedRequests: 1 }),
    );
    warn.mockRestore();
  });

  it("retains last complete platform departures after a partial refresh", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const station = {
      id: "fictional-station",
      name: "Fictional Station",
      lat: 43.7,
      lon: -79.4,
      lines: ["R1"],
      platformIds: ["fictional-platform"],
    } as const;
    let fail = false;
    const fetch = vi.fn(async () =>
      fail
        ? new Response("upstream", { status: 503 })
        : new Response(
            JSON.stringify([
              {
                line: "R1",
                direction: 0,
                nextTrains: [3],
                directionText: "Northbound to Terminal",
                stopCode: "fictional-platform",
              },
            ]),
            { status: 200 },
          ),
    );
    const source = createGenericStationsSource({
      agencyId: "fictional-transit",
      stations: [station],
      feeds: [
        {
          kind: "station_departures",
          url: "https://feeds.example.test/departures/{stopId}",
          format: "json",
          lineIds: ["R1"],
        },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
      routeType: "bus",
    });

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const [complete] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));
      expect(complete?.arrivals.flatMap((arrival) => arrival.times)).toEqual([now + 180_000]);

      fail = true;
      vi.advanceTimersByTime(STATION_FEED_CACHE_TTL_MS + 1);
      const [partial] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));

      expect(partial?.arrivals.flatMap((arrival) => arrival.times)).toEqual([now + 180_000]);
      expect(partial?.arrivalsStale).toBe(true);
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("marks bulk station arrivals stale when one trip feed fails beside a usable feed", async () => {
    const now = 1_700_000_000_000;
    const station = {
      id: "fictional-platform",
      name: "Fictional Station",
      lat: 43.7,
      lon: -79.4,
      lines: ["R1"],
      platformIds: ["fictional-platform"],
    } as const;
    const bytes = encodeFeed(now / 1_000, [
      encodeSubwayTripUpdateEntity({
        entityId: "fictional-trip",
        routeId: "R1",
        stopId: station.platformIds[0],
        stopSequence: 1,
        arrivalTimeSec: now / 1_000 + 300,
      }),
    ]);
    const fetch = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.endsWith("/trips-down")) return new Response("upstream", { status: 503 });
      return new Response(new Uint8Array(bytes));
    });
    const source = createGenericStationsSource({
      agencyId: "fictional-transit",
      stations: [station],
      feeds: [
        { kind: "trip_updates", url: "https://feeds.example.test/trips-good", format: "protobuf" },
        { kind: "trip_updates", url: "https://feeds.example.test/trips-down", format: "protobuf" },
      ],
      fetch: fetch as unknown as typeof globalThis.fetch,
      now: () => now,
    });

    const [card] = await Effect.runPromise(source.fetchByIds({ stationIds: [station.id] }));

    expect(card?.arrivalsStale).toBe(true);
    expect(card?.arrivals.flatMap((arrival) => arrival.times)).toEqual([now + 300_000]);
  });

  it.each([
    {
      name: "keeps an active terminal departure and omits the inbound arrival",
      rows: [
        { direction: "0", nextTrains: "5", directionText: "Outbound to Oshawa" },
        { direction: "1", nextTrains: "2", directionText: "Inbound to Union" },
      ],
      expectedTime: 1_700_000_300_000,
      expectedLabel: "→ Oshawa",
    },
    {
      name: "uses an inbound-only terminal prediction as the turnaround estimate",
      rows: [{ direction: "1", nextTrains: "2", directionText: "Inbound to Union" }],
      expectedTime: 1_700_000_120_000,
      expectedLabel: "→ Oshawa GO",
    },
  ])("$name for sequence-less departures", async ({ rows, expectedTime, expectedLabel }) => {
    const terminal = {
      id: "UN",
      schematicId: "union",
      name: "Union",
      lat: 43.645195,
      lon: -79.3806,
      lines: ["LE"],
      platformIds: ["UN"],
    } as const;
    const oshawa = {
      id: "OS",
      schematicId: "oshawa",
      name: "Oshawa GO",
      lat: 43.87,
      lon: -78.88,
      lines: ["LE"],
      platformIds: ["OS"],
    } as const;
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [terminal, oshawa],
      lineSequences: { LE: ["oshawa", "union"] },
      feeds: [
        {
          kind: "station_departures",
          url: "https://example.test/next-train/{stopId}",
          format: "json",
          lineIds: ["LE"],
        },
      ],
      fetch: vi.fn(
        async () =>
          new Response(
            JSON.stringify(
              rows.map((row) => ({
                line: "LE",
                ...row,
                stopCode: "UN",
              })),
            ),
            { status: 200 },
          ),
      ) as unknown as typeof globalThis.fetch,
      now: () => 1_700_000_000_000,
      directionLiterals: { inbound: "Inbound", outbound: "Outbound" },
      routeType: "rail",
    });

    const [station] = await Effect.runPromise(source.fetchByIds({ stationIds: ["union"] }));

    expect(station?.arrivals).toEqual([
      { directionId: 0, label: expectedLabel, times: [expectedTime], lineId: "LE" },
    ]);
  });

  it("filters out extraneous platform routes and infers directions from routeInterpretation", async () => {
    const northCampus = {
      id: "698",
      schematicId: "ontario-tech-north-campus",
      name: "Ontario Tech / Durham College North Campus",
      lat: 43.9436,
      lon: -78.8955,
      lines: ["901"],
      platformIds: ["698"],
      directionTermini: { southbound: "Oshawa Centre Terminal" },
    } as const;
    const simcoeTaunton = {
      id: "691",
      schematicId: "simcoe-at-taunton",
      name: "Simcoe at Taunton",
      lat: 43.9342,
      lon: -78.8793,
      lines: ["901"],
      platformIds: ["691"],
    } as const;

    const now = 1_700_000_000_000;
    const bytes = encodeFeed(1_700_000_000, [
      // 901 trip departing Ontario Tech towards Simcoe at Taunton (Southbound)
      encodeSubwayTripUpdateEntity({
        entityId: "trip-901-south",
        routeId: "901",
        stopId: "698",
        stopSequence: 1,
        arrivalTimeSec: 1_700_000_600,
      }),
      // Extraneous local bus 407 stopping at the same platform 698
      encodeSubwayTripUpdateEntity({
        entityId: "trip-407",
        routeId: "407",
        stopId: "698",
        stopSequence: 1,
        arrivalTimeSec: 1_700_000_300,
      }),
    ]);

    const source = createGenericStationsSource({
      agencyId: "drt",
      stations: [northCampus, simcoeTaunton],
      lineSequences: { "901": ["simcoe-at-taunton", "ontario-tech-north-campus"] },
      routeType: "bus",
      directionLiterals: {
        north: "Northbound",
        south: "Southbound",
        east: "Eastbound",
        west: "Westbound",
      },
      routeInterpretation: {
        directionInference: {
          default: "east-west",
          routeOverrides: {
            "901": "north-south",
          },
        },
      },
      feeds: [{ kind: "trip_updates", url: "https://example.test/drt-trips", format: "protobuf" }],
      fetch: vi.fn(async () => ({
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      })) as unknown as typeof fetch,
      now: () => now,
    });

    const [station] = await Effect.runPromise(
      source.fetchByIds({ stationIds: ["ontario-tech-north-campus"] }),
    );

    // Route 407 should be filtered out because it is not in station.lines (only 901 is).
    // Route 901 departure from northern terminus should be Southbound, resolved via directionTermini to Oshawa Centre.
    expect(station?.arrivals).toHaveLength(1);
    expect(station?.arrivals[0]).toEqual({
      directionId: 1,
      label: "→ Oshawa Centre Terminal",
      times: [now + 600_000],
      lineId: "901",
    });
  });
});

it.each([
  { routeId: "301", lineId: "ion", staticRouteIdField: "id" as const, seededRouteId: "301" },
  { routeId: "5687", lineId: "01", staticRouteIdField: "short_name" as const, seededRouteId: "01" },
])(
  "looks up trip terminals using the seeded $staticRouteIdField route ID",
  async ({ routeId, lineId, staticRouteIdField, seededRouteId }) => {
    const bytes = encodeFeed(1_700_000_000, [
      encodeSubwayTripUpdateEntity({
        entityId: "ending",
        routeId,
        stopId: "6001",
        stopSequence: 19,
        arrivalTimeSec: 1_700_000_060,
      }),
    ]);
    const lookup = vi.fn((queriedRouteId: string) =>
      Effect.succeed(
        queriedRouteId === seededRouteId
          ? new Map([["ending", { stopId: "6001", stopSequence: 19 }]])
          : new Map(),
      ),
    );
    const source = createGenericStationsSource({
      agencyId: "grt",
      stations: [{ ...unionStation, id: "6001", lines: [lineId], platformIds: ["6001"] }],
      routeLineMap: { [routeId]: lineId },
      staticRouteIdField,
      feeds: [{ kind: "trip_updates", url: "https://example.test/ion-trips", format: "protobuf" }],
      fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
      now: () => 1_700_000_000_000,
      getTripTerminals: lookup,
    });
    const [result] = await Effect.runPromise(source.fetchByIds({ stationIds: ["6001"] }));
    expect(lookup).toHaveBeenCalledWith(seededRouteId, ["ending"]);
    expect(result.arrivals).toEqual([]);
  },
);

it.each([
  { position: "intermediate", known: true },
  { position: "schematic terminal", known: true },
  { position: "schematic terminal", known: false },
])(
  "uses trip terminals at an $position station without realtime sequences, known=$known",
  async ({ position, known }) => {
    const station = {
      ...unionStation,
      id: "AL",
      schematicId: "aldershot",
      name: "Aldershot GO",
      platformIds: ["AL"],
    };
    const tripEntity = (tripId: string, seconds: number) =>
      encodeMessage(
        2,
        concatBuffers(
          encodeString(1, tripId),
          encodeMessage(
            3,
            concatBuffers(
              encodeMessage(
                1,
                concatBuffers(
                  encodeString(1, tripId),
                  encodeString(5, "LW"),
                  encodeVarintField(6, 0),
                ),
              ),
              encodeMessage(
                2,
                concatBuffers(
                  encodeString(4, "AL"),
                  encodeMessage(2, encodeVarintField(2, seconds)),
                ),
              ),
            ),
          ),
        ),
      );
    const bytes = concatBuffers(
      encodeFeedHeader(1_700_000_000),
      tripEntity("ending", 1_700_000_060),
      tripEntity("through", 1_700_000_120),
    );
    const lookup = vi.fn(() =>
      Effect.succeed(
        new Map(
          known
            ? [
                ["ending", { stopId: "AL", stopSequence: 34 }],
                ["through", { stopId: "WR", stopSequence: 38 }],
              ]
            : [],
        ),
      ),
    );
    const source = createGenericStationsSource({
      agencyId: "go",
      stations: [station],
      routeType: "rail",
      lineSequences: {
        LW:
          position === "intermediate"
            ? ["west-harbour", "aldershot", "union"]
            : ["aldershot", "union"],
      },
      feeds: [
        { kind: "trip_updates", url: "https://example.test/branch-trips", format: "protobuf" },
      ],
      fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
      now: () => 1_700_000_000_000,
      getTripTerminals: lookup,
    });
    const [result] = await Effect.runPromise(source.fetchByIds({ stationIds: ["aldershot"] }));
    // Known terminals: the trip whose final call is this stop is an arrival
    // into the terminus and is withheld, and the through trip keeps the
    // direction it came in on.
    //
    // Unknown terminals: nothing can prove either trip ends here, so the
    // schematic terminus governs and both render in the departing direction,
    // which is Outbound away from Aldershot. Falling back to the feed's own
    // direction claim here is what rendered a terminating arrival as a
    // departure to the station the rider is already standing at.
    expect(
      result.arrivals.map((group) => ({ directionId: group.directionId, times: group.times })),
    ).toEqual(
      known
        ? [{ directionId: 0, times: [1_700_000_120_000] }]
        : [{ directionId: 1, times: [1_700_000_060_000, 1_700_000_120_000] }],
    );
    expect(lookup).toHaveBeenCalledWith("LW", ["ending", "through"]);
  },
);

/**
 * A station groups its platforms under one parent, so several of a multi-bay
 * terminal's bays are some trip's final call. Matching the terminal against the
 * station's whole platform set silenced every through bus at the terminal:
 * 463 Brampton Gateway trips call at more than one bay, and the bay a rider
 * stands at was dropped whenever a sibling bay was the trip's last stop.
 * No stop sequence is published, which is the case where only the stop id can
 * decide, so the comparison has to be against the prediction's own stop.
 */
it("keeps a bus at the bay a rider is at when a sibling bay is the trip's last stop", async () => {
  const station = {
    ...unionStation,
    id: "GATE",
    schematicId: "gore-meadows",
    name: "Brampton Gateway Terminal",
    platformIds: ["BAY_A", "BAY_B"],
  };
  const tripAt = (tripId: string, stopId: string, seconds: number) =>
    encodeMessage(
      2,
      concatBuffers(
        encodeString(1, tripId),
        encodeMessage(
          3,
          concatBuffers(
            encodeMessage(
              1,
              concatBuffers(
                encodeString(1, tripId),
                encodeString(5, "LW"),
                encodeVarintField(6, 0),
              ),
            ),
            encodeMessage(
              2,
              concatBuffers(
                encodeString(4, stopId),
                encodeMessage(2, encodeVarintField(2, seconds)),
              ),
            ),
          ),
        ),
      ),
    );
  const bytes = concatBuffers(
    encodeFeedHeader(1_700_000_000),
    // Calls at the rider's bay, then runs on to the bay where it finishes.
    tripAt("through", "BAY_A", 1_700_000_060),
  );
  const source = createGenericStationsSource({
    agencyId: "brampton",
    stations: [station],
    routeType: "bus",
    lineSequences: { LW: ["union", "gore-meadows", "brampton"] },
    feeds: [{ kind: "trip_updates", url: "https://example.test/branch-trips", format: "protobuf" }],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    now: () => 1_700_000_000_000,
    getTripTerminals: () =>
      Effect.succeed(new Map([["through", { stopId: "BAY_B", stopSequence: 20 }]])),
  });

  const [result] = await Effect.runPromise(source.fetchByIds({ stationIds: ["gore-meadows"] }));

  expect(result.arrivals.flatMap((group) => group.times)).toEqual([1_700_000_060_000]);
});

it("includes boarding routes omitted from the simplified schematic", async () => {
  const now = 1_700_000_000_000;
  const bytes = encodeFeed(now / 1000, [
    encodeSubwayTripUpdateEntity({
      entityId: "express",
      routeId: "E9",
      stopId: "forecourt",
      stopSequence: 1,
      arrivalTimeSec: now / 1000 + 120,
    }),
  ]);
  const source = createGenericStationsSource({
    agencyId: "fixture-forecourt",
    stations: [
      {
        id: "central",
        name: "Central",
        lat: 44,
        lon: -76,
        lines: ["L1"],
        departureRouteIds: ["L1", "E9"],
        platformIds: ["forecourt"],
      },
    ],
    feeds: [{ kind: "trip_updates", url: "https://example.test/forecourt", format: "protobuf" }],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))),
    now: () => now,
    splitByLine: true,
    routeType: "bus",
  });
  const cards = await Effect.runPromise(source.fetchByIds!({ stationIds: ["central"] }));
  expect(cards.find((card) => card.lineIds.includes("E9"))?.arrivals[0]?.times).toEqual([
    now + 120_000,
  ]);
});

describe("nested station departures", () => {
  it.each([
    { stopTimes: [] },
    { stopTimes: [{ estimatedDepartTimeUtc: "2026-10-14T01:05:00Z", isCancelled: true }] },
  ])(
    "does not restore absent or cancelled calls from the bulk trip feed",
    async ({ stopTimes }) => {
      const now = Date.parse("2026-10-14T01:00:00Z");
      const binary = encodeFeed(now / 1000, [
        encodeSubwayTripUpdateEntity({
          entityId: "call",
          tripId: "example-trip",
          routeId: "rail",
          stopId: middle.platformIds[0]!,
          arrivalTimeSec: now / 1000 + 300,
        }),
      ]);
      const source = createGenericStationsSource({
        agencyId: "fictional",
        stations: [middle],
        now: () => now,
        feeds: [
          { kind: "trip_updates", format: "protobuf", url: "https://example.test/trips" },
          {
            kind: "station_departures",
            format: "json",
            url: "https://example.test/estimates/{stopId}",
            responseMapping: {
              routesPath: "routeStopSchedules",
              routeIdField: "routeNumber",
              departuresField: "stopTimes",
              timeField: "estimatedDepartTimeUtc",
              cancelledField: "isCancelled",
            },
          },
        ],
        fetch: async (url) =>
          String(url).endsWith("/trips")
            ? new Response(new Uint8Array(binary).buffer)
            : new Response(
                JSON.stringify({ routeStopSchedules: [{ routeNumber: "rail", stopTimes }] }),
              ),
      });
      const result = await Effect.runPromise(source.fetchByIds({ stationIds: [middle.id] }));
      expect(result[0]?.arrivals).toEqual([]);
    },
  );

  it.each([
    { payload: {} },
    { payload: { routeStopSchedules: [{ routeNumber: "rail", stopTimes: [{}] }] } },
  ])("marks changed nested wire formats stale instead of fresh empty", async ({ payload }) => {
    const source = createGenericStationsSource({
      agencyId: "fictional",
      stations: [middle],
      now: () => Date.parse("2026-10-14T01:00:00Z"),
      feeds: [
        {
          kind: "station_departures",
          format: "json",
          url: "https://example.test/estimates/{stopId}",
          responseMapping: {
            routesPath: "routeStopSchedules",
            routeIdField: "routeNumber",
            departuresField: "stopTimes",
            timeField: "estimatedDepartTimeUtc",
          },
        },
      ],
      fetch: async () => new Response(JSON.stringify(payload)),
    });
    const result = await Effect.runPromise(source.fetchByIds({ stationIds: [middle.id] }));
    expect(result[0]).toEqual(expect.objectContaining({ arrivals: [], arrivalsStale: true }));
  });

  it("preserves an operator departure direction at a conflicting schematic terminus", async () => {
    const now = Date.parse("2026-10-14T01:00:00Z");
    const endpoint = {
      ...middle,
      id: "departure-hub",
      schematicId: "departure-hub",
      name: "Departure Hub",
      lat: 44,
      lon: -79,
    };
    const neighbour = {
      ...middle,
      id: "neighbour",
      schematicId: "neighbour",
      name: "Neighbour",
      lat: 44,
      lon: -79.1,
      platformIds: ["neighbour-platform"],
    };
    const source = createGenericStationsSource({
      agencyId: "fictional",
      stations: [endpoint, neighbour],
      now: () => now,
      routeType: "bus",
      lineSequences: { rail: ["departure-hub", "neighbour"] },
      getDirectionsForTrips: () => Effect.succeed(new Map()),
      getTripTerminals: () => Effect.succeed(new Map()),
      feeds: [
        {
          kind: "station_departures",
          format: "json",
          url: "https://example.test/estimates/{stopId}",
          responseMapping: {
            routesPath: "routeStopSchedules",
            routeIdField: "routeNumber",
            departuresField: "stopTimes",
            timeField: "estimatedDepartTimeUtc",
            directionField: "directionName",
            tripIdField: "tripPointId",
          },
        },
      ],
      fetch: async () => new Response(JSON.stringify(nestedEstimates)),
    });
    const result = await Effect.runPromise(source.fetchByIds({ stationIds: [endpoint.id] }));
    expect(result[0]?.arrivals).toEqual([
      expect.objectContaining({
        directionId: 1,
        label: "Southbound",
        times: [now + 300_000, now + 360_000, now + 420_000],
      }),
    ]);
  });

  it("decodes the recorded nested wire shape and preserves its compass direction", async () => {
    const now = Date.parse("2026-10-14T01:00:00Z");
    const source = createGenericStationsSource({
      agencyId: "fictional",
      stations: [middle],
      now: () => now,
      routeType: "bus",
      feeds: [
        {
          kind: "station_departures",
          format: "json",
          method: "POST",
          url: "https://example.test/estimates",
          bodyTemplate: { stopCode: "{stopId}", date: "{date}" },
          responseMapping: {
            routesPath: "routeStopSchedules",
            routeIdField: "routeNumber",
            departuresField: "stopTimes",
            timeField: "estimatedDepartTimeUtc",
            directionField: "directionName",
            realtimeField: "isRealtime",
            tripIdField: "tripPointId",
          },
        },
      ],
      fetch: async () => new Response(JSON.stringify(nestedEstimates)),
    });
    const result = await Effect.runPromise(source.fetchByIds({ stationIds: [middle.id] }));
    expect(result[0]?.arrivals).toEqual([
      expect.objectContaining({
        directionId: 1,
        label: "Southbound",
        times: [now + 300_000, now + 360_000, now + 420_000],
      }),
    ]);
  });

  it("posts stop and local date and omits cancelled, off-route and closed calls", async () => {
    const now = Date.parse("2026-10-14T01:00:00Z");
    const fetch = vi.fn(
      async (_input: string | URL | Request, _init?: RequestInit) =>
        new Response(
          JSON.stringify({
            routeStopSchedules: [
              {
                routeNumber: "rail",
                directionName: "South Terminal",
                stopTimes: [
                  { estimatedDepartTimeUtc: "2026-10-14T01:05:00Z", isRealtime: true },
                  { estimatedDepartTimeUtc: "2026-10-14T01:06:00Z", isCancelled: true },
                  { estimatedDepartTimeUtc: "2026-10-14T01:07:00Z", isOffRoute: true },
                  { estimatedDepartTimeUtc: "2026-10-14T01:08:00Z", isStopClosed: true },
                  { estimatedDepartTimeUtc: "2026-10-14T01:09:00Z", isLastPoint: true },
                ],
              },
            ],
          }),
        ),
    );
    const source = createGenericStationsSource({
      agencyId: "fictional",
      stations: [middle],
      now: () => now,
      feeds: [
        {
          kind: "station_departures",
          format: "json",
          method: "POST",
          url: "https://example.test/estimates",
          bodyTemplate: { stopCode: "{stopId}", date: "{date}" },
          dateTimezone: "America/Toronto",
          responseMapping: {
            routesPath: "routeStopSchedules",
            routeIdField: "routeNumber",
            departuresField: "stopTimes",
            timeField: "estimatedDepartTimeUtc",
            headsignField: "directionName",
            realtimeField: "isRealtime",
            cancelledField: "isCancelled",
            offRouteField: "isOffRoute",
            stopClosedField: "isStopClosed",
            terminalField: "isLastPoint",
          },
        },
      ],
      fetch: fetch as typeof globalThis.fetch,
    });
    const result = await Effect.runPromise(source.fetchByIds({ stationIds: [middle.id] }));
    expect(result[0]?.arrivals.flatMap((group) => group.times)).toEqual([now + 300_000]);
    expect(fetch.mock.calls[0]).toEqual([
      "https://example.test/estimates",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ stopCode: middle.platformIds[0], date: "2026-10-13" }),
      }),
    ]);
  });
});

it("names an unlabelled row by its trip's terminal station, then its scheduled headsign", async () => {
  // A drawn terminal outranks the sign; a trip ending here names nothing.
  const main = {
    id: "main",
    schematicId: "main",
    name: "Main Street",
    lat: 44,
    lon: -76,
    lines: ["4"],
    platformIds: ["main-kerb"],
  };
  const uptown = {
    ...main,
    id: "uptown",
    schematicId: "uptown",
    name: "Uptown Terminal",
    lat: 44.05,
    platformIds: ["uptown-kerb"],
  };
  const call = (tripId: string, minutes: number) =>
    encodeSubwayTripUpdateEntity({
      entityId: tripId,
      routeId: "4",
      stopId: "main-kerb",
      stopSequence: 3,
      arrivalTimeSec: 1_700_000_000 + minutes * 60,
    });
  const bytes = encodeFeed(1_700_000_000, [
    call("to-uptown", 2),
    call("to-harbour", 4),
    call("loops-here", 6),
    call("unknown-trip", 8),
  ]);
  const source = createGenericStationsSource({
    agencyId: "town",
    stations: [main, uptown],
    feeds: [{ kind: "trip_updates", url: "https://example.test/town-trips", format: "protobuf" }],
    fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
    now: () => 1_700_000_000_000,
    getTripTerminals: () =>
      Effect.succeed(
        new Map([
          ["to-uptown", { stopId: "uptown-kerb", stopSequence: 9, headsign: "Downtown" }],
          ["to-harbour", { stopId: "harbour-kerb", stopSequence: 9, headsign: "Harbour" }],
          ["loops-here", { stopId: "main-kerb", stopSequence: 9, headsign: "Main Street" }],
        ]),
      ),
  });

  const [card] = await Effect.runPromise(source.fetchByIds({ stationIds: ["main"] }));

  expect(card?.arrivals.map((arrival) => [arrival.label, arrival.times.length])).toEqual([
    ["→ Uptown Terminal", 1],
    ["→ Harbour", 1],
    ["", 2],
  ]);
});
