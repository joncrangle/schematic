import { coldPollingSubrequestsForSources } from "~/services/notifications/cycleBudget";
import * as Effect from "effect/Effect";
import { vi } from "vitest";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { createGenericStationsSource } from "~/infrastructure/realtime/genericStationsSource";
import { buildZenbusArchive, buildZenbusIndex } from "~/infrastructure/gtfs/zenbusArchive";
import { processArchiveCsv, readGtfsArchive } from "~/infrastructure/gtfs/archive";
import { describe, expect, it } from "vitest";
import { decodeZenbusDocument } from "~/infrastructure/realtime/zenbus/zenbusDecoder";
import { decodeZenbusStatic } from "~/infrastructure/realtime/zenbus/zenbusProtocol";

const varint = (value: number | bigint) => {
  let n = BigInt(value);
  const out: number[] = [];
  do {
    const b = Number(n & 127n);
    n >>= 7n;
    out.push(b | (n ? 128 : 0));
  } while (n);
  return out;
};
const integer = (field: number, value: number | bigint) => [...varint(field * 8), ...varint(value)];
const message = (field: number, bytes: number[]) => [
  ...varint(field * 8 + 2),
  ...varint(bytes.length),
  ...bytes,
];
const text = (field: number, value: string) => message(field, [...new TextEncoder().encode(value)]);
const float = (field: number, value: number) => {
  const bytes = new Uint8Array(4);
  new DataView(bytes.buffer).setFloat32(0, value, true);
  return [...varint(field * 8 + 5), ...bytes];
};
const now = Date.UTC(2026, 10, 11, 17);
const midnight = now / 1000 - 43200;
const itineraryId = "9223372036854775806";
const index = {
  [itineraryId]: {
    routeId: "A",
    stopIds: ["origin", "middle", "end"],
    directionId: 0 as const,
    headsign: "Harbour",
  },
};
function wire(
  options: {
    live?: boolean;
    age?: number;
    relationship?: number;
    estimate?: number;
    target?: number;
    column?: number;
  } = {},
) {
  const time = (index: number, seconds: number) => [...integer(1, index), ...integer(6, seconds)];
  const column = [
    ...message(1, time(1, 43260)),
    ...integer(3, options.target ?? 1),
    ...message(4, time(0, 43300)),
    ...message(4, time(1, options.estimate ?? 43320)),
    ...message(4, time(2, 43380)),
    ...(options.live === false
      ? []
      : message(5, [
          ...float(1, 48),
          ...float(2, -79),
          ...integer(3, 43200 - (options.age ?? 10)),
        ])),
    ...integer(7, options.column ?? 4),
    ...integer(12, 345),
    ...integer(14, options.relationship ?? 100),
  ];
  return new Uint8Array([
    ...message(1, [
      ...integer(2, BigInt(itineraryId)),
      ...integer(6, midnight),
      ...message(7, column),
    ]),
    ...integer(4, now),
  ]);
}
describe("Zenbus live departures", () => {
  it("joins exact int64 itinerary IDs and emits only future boardable live estimates", () => {
    const data = decodeZenbusDocument(wire(), index, now);
    expect(data.arrivals).toEqual([
      expect.objectContaining({
        routeId: "A",
        stopId: "middle",
        predictedTime: now + 120000,
        delaySeconds: 60,
        directionInferred: true,
      }),
    ]);
    expect(data.vehicles).toEqual([
      expect.objectContaining({
        vehicleId: "345",
        latitude: 48,
        longitude: -79,
        timestamp: now - 10000,
      }),
    ]);
  });
  it.each([
    { live: false },
    { age: 301 },
    { age: -61 },
    { relationship: 103 },
    { relationship: 400 },
  ])("excludes untracked, stale, future, cancelled and non-passenger trips: %j", (options) => {
    expect(decodeZenbusDocument(wire(options), index, now)).toEqual({ vehicles: [], arrivals: [] });
  });
  it("keeps interlined trip predictions while collapsing their shared vehicle fix", () => {
    const first = wire();
    const second = wire({ column: 5, estimate: 43400 });
    const data = decodeZenbusDocument(new Uint8Array([...first, ...second]), index, now);
    expect(data.vehicles).toHaveLength(1);
    expect(data.arrivals.map((a) => a.predictedTime)).toEqual([now + 120000, now + 200000]);
  });
  it("does not turn a past estimate into a scheduled departure", () => {
    expect(decodeZenbusDocument(wire({ estimate: 43190 }), index, now).arrivals).toEqual([]);
  });
  it("fails unknown live itineraries instead of displaying an empty healthy board", () => {
    expect(() => decodeZenbusDocument(wire(), {}, now)).toThrow(/itinerary/i);
  });
  it.each([new Uint8Array(), new Uint8Array([10, 127, 0])])(
    "rejects incomplete documents",
    (bytes) => {
      expect(() => decodeZenbusDocument(bytes, index, now)).toThrow();
    },
  );
  it("rejects a frozen processing timestamp", () => {
    expect(() => decodeZenbusDocument(wire(), index, now + 301000)).toThrow(/stale/i);
  });
});
describe("Zenbus static identities", () => {
  it("preserves exact source-native IDs", () => {
    const bytes = new Uint8Array([
      ...message(1, [
        ...integer(1, BigInt(itineraryId)),
        ...text(2, "Harbour bus"),
        ...text(4, "A"),
      ]),
      ...message(2, [
        ...integer(1, 1),
        ...integer(2, BigInt(itineraryId)),
        ...message(4, integer(1, 20)),
        ...message(4, integer(1, 21)),
      ]),
      ...message(5, [
        ...integer(1, 20),
        ...text(3, "Harbour"),
        ...message(2, [...float(1, 48), ...float(2, -79)]),
      ]),
    ]);
    expect(decodeZenbusStatic(bytes).lines[0].id).toBe(itineraryId);
  });
});

describe("Zenbus provider ports", () => {
  it("shares one network read between filtered surface and bus station consumers", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(wire()));
    const feed = {
      kind: "zenbus" as const,
      format: "protobuf" as const,
      url: "https://example.test/shared-native",
      pollIntervalSeconds: 30,
      gtfsIndex: index,
    };
    const options = { agencyId: "harbour-native", feeds: [feed], fetch: fetcher, now: () => now };
    const surface = createGenericGtfsRealtimeSource(options);
    const stations = createGenericStationsSource({
      ...options,
      routeType: "bus",
      stations: [
        { id: "middle", name: "Harbour", lat: 48, lon: -79, lines: ["A"], platformIds: ["middle"] },
      ],
    });
    const topology = { agencyId: options.agencyId, generatedAt: now, routes: [] };
    const result = await Effect.runPromise(
      surface.fetchRealtime(topology, { routeIds: new Set(["other"]) }),
    );
    expect(result.arrivals).toEqual([]);
    expect(result.vehicles).toEqual([]);
    const cards = await Effect.runPromise(stations.fetchByIds({ stationIds: ["middle"] }));
    expect(cards).toEqual([
      expect.objectContaining({
        routeType: "bus",
        arrivals: [
          expect.objectContaining({ label: "A → Harbour", lineId: "A", times: [now + 120000] }),
        ],
      }),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("propagates an upstream failure rather than fabricating a quiet board", async () => {
    const source = createGenericGtfsRealtimeSource({
      agencyId: "harbour-failing",
      feeds: [
        {
          kind: "zenbus",
          format: "protobuf",
          url: "https://example.test/failing-native",
          gtfsIndex: index,
        },
      ],
      fetch: vi.fn<typeof fetch>().mockResolvedValue(new Response("missing", { status: 404 })),
      now: () => now,
    });
    await expect(
      Effect.runPromise(
        source.fetchRealtime({ agencyId: "harbour-failing", generatedAt: now, routes: [] }),
      ),
    ).rejects.toBeDefined();
  });
});
describe("Zenbus topology archive", () => {
  it("retains weekend stop patterns and native shapes in a weekday refresh", async () => {
    const staticWire = (weekend: boolean) => {
      const id = weekend ? 200 : 100;
      return new Uint8Array([
        ...message(1, [
          ...integer(1, id),
          ...text(2, "Harbour service"),
          ...text(4, weekend ? "B" : "A"),
        ]),
        ...message(2, [
          ...integer(1, id + 1),
          ...integer(2, id),
          ...message(4, integer(1, 20)),
          ...message(4, integer(1, 21)),
        ]),
        ...message(3, [
          ...integer(1, id + 2),
          ...integer(2, id + 1),
          ...message(6, [
            ...message(1, [...float(1, 48), ...float(2, -79)]),
            ...message(1, [...float(1, 48.01), ...float(2, -79.01)]),
          ]),
        ]),
        ...[20, 21].flatMap((stop) =>
          message(5, [
            ...integer(1, stop),
            ...text(3, `Platform ${stop}`),
            ...message(2, [...float(1, 48), ...float(2, -79)]),
          ]),
        ),
      ]);
    };
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async (input) => {
      const day = new URL(String(input)).searchParams.get("yyyymmdd");
      return new Response(staticWire(day === "20261114" || day === "20261115"));
    });
    const bytes = await buildZenbusArchive({
      feed: {
        url: "https://example.test/topology?alias=harbour",
        zenbus: { timeZone: "America/Toronto" },
      },
      fetch: fetcher,
      now,
    });
    expect(await buildZenbusIndex([bytes])).toMatchObject({
      "101": { routeId: "A", stopIds: ["20", "21"] },
      "201": { routeId: "B", stopIds: ["20", "21"] },
    });
    const shapes: string[] = [];
    await processArchiveCsv(readGtfsArchive(bytes), "shapes.txt", ["shape_id"], (get) => {
      shapes.push(get("shape_id"));
    });
    expect(shapes).toEqual(["102", "102", "202", "202"]);
    expect(fetcher).toHaveBeenCalledTimes(7);
  });
});

it("budgets a native message board on the minute polling cadence", () => {
  const sources = [
    { type: "zenbus-messages" as const, url: "https://example.test/native-messages" },
  ];
  expect(coldPollingSubrequestsForSources(sources, "fast")).toBe(3);
  expect(coldPollingSubrequestsForSources(sources, "slow")).toBe(0);
});
