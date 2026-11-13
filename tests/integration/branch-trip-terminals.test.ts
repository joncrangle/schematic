import { describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { loadDatabaseSync } from "../helpers/sqlite-fixture";
import { gtfsZip } from "../helpers/gtfsArchive";
import {
  concatBuffers,
  encodeFeedHeader,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";
import {
  type SqliteDatabaseLike,
  createSyncSqliteBinding,
} from "~/infrastructure/storage/RuntimeBindings";
import { SURFACE_SCHEMA_STATEMENTS } from "~/infrastructure/storage/surfaceStore/schema";
import {
  createD1SeedSyncStore,
  reconcileSeedTopology,
} from "~/infrastructure/storage/surfaceStore/seedSync";
import { projectGtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import { makeD1SurfaceDataStoreService } from "~/infrastructure/storage/d1SurfaceDataStore";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import {
  NearbyTransit,
  NearbyTransitLive,
  NearbySnapshotSource,
  SurfaceAgencyDefaults,
  createRealtimeCacheLayer,
} from "~/services/surface/NearbyTransit";

const DatabaseSync = await loadDatabaseSync();
const now = Date.now();
const config = {
  id: "ttc",
  routeTypes: new Set([3]),
  routeIdField: "id" as const,
  defaultColor: "#000",
  defaultTextColor: "#fff",
};
const archive = () =>
  gtfsZip({
    "routes.txt": "route_id,route_short_name,route_long_name,route_type\nBR,BR,Branch Line,3\n",
    "trips.txt":
      "route_id,trip_id,direction_id,shape_id\nBR,short,0,s0\nBR,short-copy,0,s0\nBR,through,0,s1\nBR,return,1,s2\n",
    "stops.txt":
      "stop_id,stop_name,stop_lat,stop_lon\nA,Start,43.6,-79.3857\nM,Mid Line,43.6709,-79.3857\nW,Branch Terminal,43.8,-79.3857\n",
    "stop_times.txt":
      "trip_id,stop_id,stop_sequence\nshort,A,1\nshort,M,34\nshort-copy,A,1\nshort-copy,M,34\nthrough,A,1\nthrough,M,34\nthrough,W,38\nreturn,W,1\nreturn,M,5\nreturn,A,9\n",
    "shapes.txt":
      "shape_id,shape_pt_lat,shape_pt_lon,shape_pt_sequence\ns0,43.6,-79.3857,1\ns0,43.6709,-79.3857,2\ns1,43.6,-79.3857,1\ns1,43.8,-79.3857,2\ns2,43.8,-79.3857,1\ns2,43.6,-79.3857,2\n",
  });

function entity(tripId: string, directionId: number, calls: readonly [string, number][]) {
  return encodeMessage(
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
              encodeString(5, "BR"),
              encodeVarintField(6, directionId),
            ),
          ),
          ...calls.map(([stopId, time]) =>
            encodeMessage(
              2,
              concatBuffers(
                encodeString(4, stopId),
                encodeMessage(2, encodeVarintField(2, Math.floor(time / 1000))),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

describe.skipIf(!DatabaseSync)(
  "branch boarding through SQLite, the filtered realtime decoder, and NearbyTransit",
  () => {
    it.each([
      { stopId: "M", lat: 43.6709, directionId: 0, departure: now + 120_000 },
      { stopId: "W", lat: 43.8, directionId: 1, departure: now + 600_000 },
    ])(
      "keeps boardable trips at $stopId through an additive schema upgrade",
      async ({ stopId, lat, directionId, departure }) => {
        const sqlite = new DatabaseSync!(":memory:") as SqliteDatabaseLike & { close(): void };
        try {
          sqlite.exec(
            SURFACE_SCHEMA_STATEMENTS.filter((sql) => !sql.includes("route_trip_terminals")).join(
              ";",
            ),
          );
          const db = createSyncSqliteBinding(sqlite);
          const topology = await projectGtfsTopology([archive()], config);
          const { route_trip_terminals: terminals, ...legacy } = topology;
          const seedStore = createD1SeedSyncStore(db);
          await reconcileSeedTopology({
            agencyId: "ttc",
            topology: legacy,
            store: seedStore,
            feedHash: "legacy",
          });
          const store = makeD1SurfaceDataStoreService(db, { agencyId: "ttc" });
          expect(await Effect.runPromise(store.getTripTerminals("BR", ["through"]))).toEqual(
            new Map(),
          );
          expect(await Effect.runPromise(store.getDirectionsForTrips("BR", ["through"]))).toEqual(
            new Map([["through", 0]]),
          );
          await reconcileSeedTopology({
            agencyId: "ttc",
            topology: { ...legacy, route_trip_terminals: terminals },
            store: seedStore,
            feedHash: "new",
          });
          expect(
            await reconcileSeedTopology({
              agencyId: "ttc",
              topology,
              store: seedStore,
              feedHash: "new",
              verifyDestination: true,
            }),
          ).toEqual({ outcome: "unchanged", writes: 0 });
          expect(
            await Effect.runPromise(store.getTripTerminals("BR", ["through", "unknown"])),
          ).toEqual(new Map([["through", { stopId: "W", stopSequence: 38 }]]));
          const bytes = concatBuffers(
            encodeFeedHeader(Math.floor(now / 1000)),
            entity("short", 0, [["M", now + 60_000]]),
            entity("through", 0, [
              ["M", now + 120_000],
              ["W", now + 480_000],
            ]),
            entity("return", 1, [
              ["W", now + 600_000],
              ["M", now + 900_000],
            ]),
          );
          const realtime = createGenericGtfsRealtimeSource({
            agencyId: "ttc",
            now: () => now,
            feeds: [
              {
                kind: "vehicle_positions",
                url: "https://example.test/vehicles",
                format: "protobuf",
              },
              { kind: "trip_updates", url: "https://example.test/trips", format: "protobuf" },
            ],
            fetch: vi.fn(async () => new Response(new Uint8Array(bytes))) as typeof fetch,
          });
          const deps = Layer.mergeAll(
            Layer.succeed(SurfaceDataStore, store),
            createRealtimeCacheLayer({}, { realtimeByAgencyId: new Map([["ttc", realtime]]) }),
            Layer.succeed(NearbySnapshotSource, {
              getSnapshot: Effect.succeed({
                agencyId: "ttc",
                generatedAt: now,
                freshness: "live" as const,
                alerts: [],
              }),
            }),
            Layer.succeed(SurfaceAgencyDefaults, {
              agencyId: "ttc",
              focus: { lat, lon: -79.3857 },
              fallbackBounds: { minLat: 43.5, maxLat: 43.9, minLon: -79.5, maxLon: -79.3 },
            }),
          );
          const result = await Effect.runPromise(
            Effect.gen(function* () {
              const service = yield* NearbyTransit;
              return yield* service.getNearbyTransit({
                agencyId: "ttc",
                lat,
                lon: -79.3857,
                radius: 500,
              });
            }).pipe(Effect.provide(Layer.provide(NearbyTransitLive, deps))),
          );
          expect(result).toHaveLength(1);
          expect(result[0].stopId).toBe(stopId);
          const directions = result[0].directions?.map((direction) => ({
            directionId: direction.directionId,
            arrivals: direction.arrivals,
          }));
          expect(directions).toContainEqual({
            directionId,
            arrivals: [Math.floor(departure / 1000) * 1000],
          });
          expect(directions?.flatMap((direction) => direction.arrivals)).not.toContain(
            Math.floor((now + 60_000) / 1000) * 1000,
          );
          const includesDirectionZero = expect.arrayContaining([0]);
          expect(directions?.map((direction) => direction.directionId)).toEqual(
            stopId === "W" ? [1] : includesDirectionZero,
          );
        } finally {
          sqlite.close();
        }
      },
    );
  },
);

describe.skipIf(!DatabaseSync)("scheduled trip headsigns through SQLite", () => {
  it("returns each trip's own headsign with its terminal, after an additive upgrade", async () => {
    const sqlite = new DatabaseSync!(":memory:") as SqliteDatabaseLike & { close(): void };
    try {
      sqlite.exec(
        SURFACE_SCHEMA_STATEMENTS.filter((sql) => !sql.includes("route_trip_headsigns")).join(";"),
      );
      const db = createSyncSqliteBinding(sqlite);
      const topology = await projectGtfsTopology(
        [
          gtfsZip({
            "routes.txt":
              "route_id,route_short_name,route_long_name,route_type\nBR,BR,Branch Line,3\n",
            "trips.txt":
              "route_id,trip_id,direction_id,trip_headsign\nBR,short,0,Mid Line\nBR,through,0,Branch Terminal\nBR,plain,0,\n",
            "stops.txt":
              "stop_id,stop_name,stop_lat,stop_lon\nA,Start,43.6,-79.3857\nM,Mid Line,43.6709,-79.3857\nW,Branch Terminal,43.8,-79.3857\n",
            "stop_times.txt":
              "trip_id,stop_id,stop_sequence\nshort,A,1\nshort,M,2\nthrough,A,1\nthrough,M,2\nthrough,W,3\nplain,A,1\nplain,W,3\n",
          }),
        ],
        { ...config, id: "town" },
      );
      await reconcileSeedTopology({
        agencyId: "town",
        topology,
        store: createD1SeedSyncStore(db),
        feedHash: "headsigns",
      });
      const store = makeD1SurfaceDataStoreService(db, { agencyId: "town" });

      expect(
        await Effect.runPromise(store.getTripTerminals("BR", ["short", "through", "plain"])),
      ).toEqual(
        new Map([
          ["short", { stopId: "M", stopSequence: 2, headsign: "Mid Line" }],
          ["through", { stopId: "W", stopSequence: 3, headsign: "Branch Terminal" }],
          ["plain", { stopId: "W", stopSequence: 3 }],
        ]),
      );
    } finally {
      sqlite.close();
    }
  });
});
