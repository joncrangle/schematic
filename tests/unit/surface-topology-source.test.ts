import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import { TopologyError } from "~/domain/surface/topologySource";
import { createD1TopologySource } from "~/infrastructure/storage/surfaceStore/topology";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import { createMemoryD1 } from "../helpers/memoryD1";

async function createFakeD1WithSeed(): Promise<D1DatabaseBinding> {
  const d1 = await createMemoryD1();
  await d1
    .prepare(
      "INSERT INTO routes (agency_id, id, short_name, long_name, route_type, color, text_color) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ttc", "501", "501", "Queen", 1, "#DA251D", "#FFFFFF")
    .run();
  await d1
    .prepare(
      "INSERT INTO route_shapes (agency_id, id, route_id, direction_id, headsign, polyline, min_lat, max_lat, min_lon, max_lon, point_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ttc", "501_0_live", "501", 0, "East — 501 Queen", "poly", 43.6, 43.8, -79.5, -79.3, 2)
    .run();
  await d1
    .prepare(
      "INSERT INTO stops (agency_id, id, code, name, lat, lon, wheelchair, parent_station, routes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ttc", "stop-1", "stop-1", "Queen & Yonge", 43.65, -79.38, 1, null, '["501"]')
    .run();
  await d1
    .prepare(
      "INSERT INTO stops (agency_id, id, code, name, lat, lon, wheelchair, parent_station, routes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .bind("ttc", "stop-2", "stop-2", "Queen & Bay", 43.651, -79.381, 1, null, '["501"]')
    .run();
  await d1
    .prepare(
      "INSERT INTO route_stops (agency_id, route_id, direction_id, stop_sequence, stop_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("ttc", "501", 0, 0, "stop-1")
    .run();
  await d1
    .prepare(
      "INSERT INTO route_stops (agency_id, route_id, direction_id, stop_sequence, stop_id) VALUES (?, ?, ?, ?, ?)",
    )
    .bind("ttc", "501", 0, 1, "stop-2")
    .run();
  return d1;
}

describe("TopologySource (Core seam, D1)", () => {
  it("D1TopologySource materializes routes+stops from D1 (memory fake) and owns generatedAt via now()", async () => {
    const now = () => 999999;
    const d1 = await createFakeD1WithSeed();
    const src = createD1TopologySource({
      d1,
      agencyId: "ttc",
      now,
      fallbackBounds: { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 },
    });
    const result = await Effect.runPromise(src.fetchTopology());
    expect(result.agencyId).toBe("ttc");
    expect(result.generatedAt).toBe(999999);
    expect(result.routes.length).toBeGreaterThanOrEqual(1);
    const r = result.routes.find((x) => x.routeId === "501");
    expect(r).toBeDefined();
    expect(r!.stops).toHaveLength(2);
    expect(r!.stops[0].id).toBe("stop-1");
  });

  it("maps a feed-owned parent station id to the schematic id while retaining the canonical name", async () => {
    const d1 = await createFakeD1WithSeed();
    await d1
      .prepare("UPDATE stops SET parent_station = ? WHERE id = ?")
      .bind("99962", "stop-1")
      .run();
    const src = createD1TopologySource({
      d1,
      agencyId: "ttc",
      stationIndex: [
        {
          id: "99962",
          schematicId: "bathurst",
          name: "Bathurst",
          lat: 43.666447,
          lon: -79.411186,
          lines: ["2"],
          platformIds: ["13759"],
        },
      ],
      fallbackBounds: { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 },
    });

    const result = await Effect.runPromise(src.fetchTopology());
    const stop = result.routes.find((route) => route.routeId === "501")!.stops[0]!;

    expect(stop).toMatchObject({ parentStation: "Bathurst", parentStationId: "bathurst" });
  });

  it("D1TopologySource propagates DB failure as TopologyError with agencyId (honest channel)", async () => {
    const failingD1 = {
      prepare: () => {
        throw new Error("DB down");
      },
      exec: async () => {},
      batch: async () => {},
    } as unknown as D1DatabaseBinding;
    const src = createD1TopologySource({
      d1: failingD1,
      agencyId: "go",
      fallbackBounds: { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 },
    });
    let caught: unknown;
    try {
      await Effect.runPromise(src.fetchTopology());
    } catch (e) {
      caught = e;
    }
    expect((caught as TopologyError)._tag).toBe("TopologyError");
    expect((caught as TopologyError).agencyId).toBe("go");
  });

  it("reports an empty seed-managed database as needs-seed without fetching or writing", async () => {
    const exec = vi.fn(),
      batch = vi.fn(),
      fetch = vi.fn();
    const statement = {
      bind: () => statement,
      all: async () => ({ success: true, results: [] }),
      first: async () => null,
    };
    const d1 = { prepare: () => statement, exec, batch } as unknown as D1DatabaseBinding;
    const src = createD1TopologySource({ d1, agencyId: "go", source: "seed", fetch });

    expect(await Effect.runPromise(src.shouldRefreshTopology())).toBe(true);
    await expect(Effect.runPromise(src.syncTopology())).resolves.toBeUndefined();
    expect(exec).not.toHaveBeenCalled();
    expect(batch).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("bounds the runtime archive download before any storage mutation", async () => {
    const pull = vi.fn((controller) => controller.close());
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({ pull, cancel }, { highWaterMark: 0 });
    const batch = vi.fn();
    const statement = {
      bind: () => statement,
      all: async () => ({ success: true, results: [{ name: "routes" }] }),
      first: async () => ({ id: "r" }),
    };
    const d1 = { prepare: () => statement, batch } as unknown as D1DatabaseBinding;
    const source = createD1TopologySource({
      d1,
      agencyId: "sample",
      source: "seed",
      seedConfig: {
        id: "sample",
        routeTypes: new Set([3]),
        routeIdField: "id",
        defaultColor: "#123456",
        defaultTextColor: "#FFFFFF",
        feeds: [{ url: "https://example.test/gtfs.zip" }],
      },
      fetch: async () => new Response(body, { headers: { "content-length": "134217729" } }),
    });
    await expect(Effect.runPromise(source.syncTopology())).rejects.toThrow(/archive.*limit/i);
    expect(pull).not.toHaveBeenCalled();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(body.locked).toBe(false);
    expect(batch).not.toHaveBeenCalled();
  });

  it("syncTopology addresses NextBus with nextbusSlug when declared distinct from agencyId", async () => {
    const d1 = await createFakeD1WithSeed();
    const requestedUrls: string[] = [];
    const fetchMock: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      requestedUrls.push(url);
      if (url.includes("command=routeList")) {
        return new Response(JSON.stringify({ route: [{ tag: "501" }] }), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          route: {
            tag: "501",
            title: "501-Queen",
            color: "DA251D",
            oppositeColor: "FFFFFF",
            latMin: "43.6",
            latMax: "43.8",
            lonMin: "-79.5",
            lonMax: "-79.3",
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const src = createD1TopologySource({
      d1,
      agencyId: "go-transit",
      nextbusSlug: "go",
      now: () => 1234,
      fetch: fetchMock,
      fallbackBounds: { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 },
    });
    await Effect.runPromise(src.syncTopology());

    const routeListUrls = requestedUrls.filter((u) => u.includes("command=routeList"));
    const routeConfigUrls = requestedUrls.filter((u) => u.includes("command=routeConfig"));
    expect(routeListUrls).toHaveLength(1);
    expect(routeListUrls[0]).toContain("a=go&");
    expect(routeListUrls[0]).not.toContain("a=go-transit");
    expect(routeConfigUrls.length).toBeGreaterThan(0);
    for (const url of routeConfigUrls) {
      expect(url).toContain("a=go&r=501");
      expect(url).not.toContain("go-transit");
    }
  });
});
