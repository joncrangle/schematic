import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import { createAgencyProvider } from "../../src/agencies/createAgencyProvider";
import { makeTestManifest } from "../helpers/agency-fixtures";
import {
  concatBuffers,
  encodeFeedHeader,
  encodeSubwayTripUpdateEntity,
} from "../helpers/gtfs-rt-binary";

/**
 * Map station cards merge modes; Nearby station cards keep trains only.
 */
describe("multi-mode stationService", () => {
  const manifest = {
    ...makeTestManifest(),
    id: "multimode-test",
    name: "Multimode Test",
    modes: ["rail", "bus"],
    stationService: [{ routeType: "rail" }, { routeType: "bus" }],
    routeInterpretation: {
      routeTypeRules: [{ routeType: "rail", routeIds: ["301"] }],
      directionInference: {
        routeOverrides: { "301": "north-south", "7": "east-west" },
      },
    },
    alertInterpretation: {
      lineIds: ["R1", "7"],
      routeLineMap: { "301": "R1" },
    },
    realtime: {
      feeds: [{ kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" }],
    },
  };

  const schematic = {
    viewBoxWidth: 1000,
    viewBoxHeight: 800,
    lines: [
      {
        id: "R1",
        name: "Campus Rail",
        color: "#006bb7",
        points: [
          { x: 500, y: 100 },
          { x: 500, y: 700 },
        ],
      },
      {
        id: "7",
        name: "King",
        color: "#000000",
        points: [
          { x: 510, y: 110 },
          { x: 520, y: 120 },
        ],
      },
    ],
    stations: [
      { id: "campus", name: "Campus Station", x: 500, y: 100, lines: ["R1", "7"] },
      { id: "terminus", name: "Terminus Station", x: 500, y: 700, lines: ["R1"] },
      { id: "bus-terminal", name: "Bus Terminal", x: 510, y: 110, lines: ["7"] },
    ],
    viewport: {
      bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 800 },
      minZoom: 1,
      maxZoom: 4,
    },
    geoProjection: {
      refLonWest: -80.6,
      refLonEast: -80.4,
      refXWest: 0,
      refXEast: 1000,
      refLatNorth: 43.6,
      refLatSouth: 43.3,
      refYNorth: 0,
      refYSouth: 800,
    },
    sequences: {
      R1: ["campus", "terminus"],
      "7": ["bus-terminal"],
    },
    stationIndex: [
      {
        id: "campus-idx",
        schematicId: "campus",
        name: "Campus Station",
        lat: 43.45,
        lon: -80.49,
        lines: ["R1", "7"],
        platformIds: ["6001", "6123"],
      },
      {
        id: "bus-idx",
        schematicId: "bus-terminal",
        name: "Bus Terminal",
        lat: 43.4505,
        lon: -80.4895,
        lines: ["7"],
        platformIds: ["1511", "1512"],
      },
      {
        id: "terminus-idx",
        schematicId: "terminus",
        name: "Terminus Station",
        lat: 44.5,
        lon: -81.5,
        lines: ["R1"],
        platformIds: ["6016", "6108"],
      },
    ],
  };

  function stubFetch() {
    const bytes = concatBuffers(
      encodeFeedHeader(1_700_000_000),
      encodeSubwayTripUpdateEntity({
        entityId: "131",
        tripId: "131",
        routeId: "301",
        stopId: "6001",
        stopSequence: 1,
        arrivalTimeSec: 1_700_000_300,
      }),
      encodeSubwayTripUpdateEntity({
        entityId: "bus-trip-1",
        tripId: "bus-trip-1",
        routeId: "7",
        stopId: "1511",
        stopSequence: 3,
        arrivalTimeSec: 1_700_000_600,
      }),
      // A second bus trip on the SAME station as the rail trip, so the station
      // serves both modes in the map card.
      encodeSubwayTripUpdateEntity({
        entityId: "bus-trip-2",
        tripId: "bus-trip-2",
        routeId: "7",
        stopId: "6123",
        stopSequence: 3,
        arrivalTimeSec: 1_700_000_900,
      }),
    );
    return vi.fn(async () => {
      return {
        ok: true,
        arrayBuffer: async () =>
          bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
      } as Response;
    }) as unknown as typeof fetch;
  }

  it.each(["nearby", "saved", "map"] as const)(
    "keeps bus departures in the map card while %s station cards only contain trains",
    async (view) => {
      const provider = createAgencyProvider({ manifest, schematic });
      const source = provider.createStationsSource!({
        fetch: stubFetch(),
        now: () => 1_700_000_000_000,
      });
      const cards = await Effect.runPromise(
        view === "nearby"
          ? source.fetchNearby({ lat: 43.45, lon: -80.49, radiusMeters: 500 })
          : view === "saved"
            ? source.fetchSaved({ stationNames: ["Campus Station", "Bus Terminal"] })
            : source.fetchByIds({ stationIds: ["campus", "bus-terminal"] }),
      );
      const campus = cards.find((card) => card.id === "campus-idx");
      expect(campus).toBeDefined();
      expect(campus!.arrivals.flatMap((group) => group.times)).toEqual(
        view === "map" ? [1_700_000_300_000, 1_700_000_900_000] : [1_700_000_300_000],
      );
      expect(campus!.lineIds).toEqual(view === "map" ? ["R1", "7"] : ["R1"]);
      expect(campus!.arrivals.map((group) => group.lineId)).toEqual(
        view === "map" ? ["R1", "7"] : ["R1"],
      );
      expect(campus!.routeType).toBe(view === "map" ? undefined : "rail");
      const bus = cards.find((card) => card.id === "bus-idx");
      expect(bus === undefined).toBe(view !== "map");
      expect(bus?.routeType).toBe(view === "map" ? "bus" : undefined);
      expect(bus?.arrivals[0]?.label).toBe(view === "map" ? "Eastbound" : undefined);
    },
  );

  it("keeps single-service providers unfiltered", async () => {
    const single = createAgencyProvider({
      manifest: { ...makeTestManifest() },
      schematic: undefined,
    });
    expect(single.createStationsSource).toBeDefined();
  });
});
