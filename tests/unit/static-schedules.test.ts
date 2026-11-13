import { expect, it } from "vitest";
import * as Effect from "effect/Effect";
import { gtfsZip } from "../helpers/gtfsArchive";
import { compileGtfsSchedules } from "~/infrastructure/gtfs/schedules/compile";
import { createStaticScheduleResolver } from "~/infrastructure/gtfs/schedules/resolve";
import { createVersionedAssetCache } from "~/infrastructure/staticAssets/versionedAssetCache";
import { scheduledStopKey } from "~/domain/surface/scheduledStopTimes";
const files = {
  "routes.txt": "route_id,route_type\nR,3\n",
  "trips.txt": "route_id,service_id,trip_id\nR,S,T\n",
  "stops.txt": "stop_id,stop_name,stop_lat,stop_lon\nP,Platform,45,-73\n",
  "stop_times.txt":
    "trip_id,stop_id,stop_sequence,arrival_time,departure_time\nT,P,1,25:00:00,25:01:00\n",
  "calendar.txt":
    "service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date\nS,1,1,1,1,1,1,1,20260101,20261231\n",
  "calendar_dates.txt": "service_id,date,exception_type\nS,20261026,2\n",
};
import type { ScheduleArtifact } from "~/infrastructure/gtfs/schedules/artifacts";
async function lookupFor(route: ScheduleArtifact, now: string) {
  const bytes = new TextEncoder().encode(JSON.stringify({ ...route, agencyId: "sample" }));
  const hash = Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)), (x) =>
    x.toString(16).padStart(2, "0"),
  ).join("");
  return createStaticScheduleResolver({
    catalog: {
      version: 1,
      agencies: { sample: { sourceHash: "x", routes: { R: [{ hash, bytes: bytes.length }] } } },
    },
    cache: createVersionedAssetCache({ readAsset: async () => new Response(bytes) }),
  })("sample", "America/Toronto", () => Date.parse(now));
}
it("selects the active static board and respects exceptions and postmidnight service days", async () => {
  const future = {
    ...files,
    "calendar.txt": files["calendar.txt"].replace("20260101,20261231", "20261102,20261231"),
    "stop_times.txt": files["stop_times.txt"].replaceAll("25:0", "26:0"),
  };
  const old = { ...files, "calendar.txt": files["calendar.txt"].replace("20261231", "20261101") };
  const route = (await compileGtfsSchedules([gtfsZip(old), gtfsZip(future)])).get("R")!;
  const lookup = await lookupFor(route, "2026-10-26T05:00:00Z");
  const request = {
    tripId: "T",
    routeId: "R",
    stopId: "P",
    stopSequence: 1,
    startDate: "20261025",
  };
  const result = await Effect.runPromise(
    lookup([request, { ...request, startDate: "20261026" }, { ...request, stopId: "unknown" }]),
  );
  expect(result.get(scheduledStopKey(request))).toEqual({
    stopId: "P",
    arrivalTime: Date.parse("2026-10-26T05:00:00Z"),
    departureTime: Date.parse("2026-10-26T05:01:00Z"),
  });
  expect(result.has(scheduledStopKey({ ...request, startDate: "20261026" }))).toBe(false);
});

import { prepareScheduledPredictions } from "~/infrastructure/realtime/scheduledPredictions";
import { decodeGtfsRealtimeSync } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import { decodeStationTripUpdates } from "~/infrastructure/realtime/stationTripDecoder";
import {
  concatBuffers,
  encodeFeed,
  encodeMessage,
  encodeString,
  encodeVarintField,
  encodeSignedVarintField,
} from "../helpers/gtfs-rt-binary";
it.each([0, -90, 120])(
  "joins only explicit live delays (%s seconds) through both departure paths and resolves unique stop codes before filtering",
  async (delay) => {
    const event = encodeMessage(3, encodeSignedVarintField(1, delay));
    const stop = concatBuffers(encodeVarintField(1, 1), event, encodeString(4, "CODE"));
    const descriptor = concatBuffers(
      encodeString(1, "T"),
      encodeString(5, "R"),
      encodeString(3, "20261025"),
    );
    // Deliberately put the descriptor after the stop update.
    const bytes = encodeFeed(1800000000, [
      encodeMessage(
        2,
        concatBuffers(
          encodeString(1, "E"),
          encodeMessage(3, concatBuffers(encodeMessage(2, stop), encodeMessage(1, descriptor))),
        ),
      ),
    ]);
    const expected = Date.parse("2026-10-25T14:00:00Z");
    const options = await Effect.runPromise(
      prepareScheduledPredictions(bytes, {
        predictionTimeSource: "static-with-delay",
        stopIdAliases: "static-code",
        stopIds: new Set(["P"]),
        getSourceAgencyScope: () =>
          Effect.succeed({
            routeIds: new Set(["R"]),
            stopIds: new Set(["P"]),
            stopsByCode: new Map([
              ["CODE", ["P"]],
              ["AMB", ["A", "B"]],
            ]),
          }),
        getScheduledStopTimes: (requests) => {
          expect(requests).toEqual([
            expect.objectContaining({
              tripId: "T",
              routeId: "R",
              stopId: "P",
              startDate: "20261025",
              stopSequence: 1,
            }),
          ]);
          return Effect.succeed(
            new Map(
              requests.map((request) => [
                scheduledStopKey(request),
                { stopId: "P", departureTime: expected },
              ]),
            ),
          );
        },
      }),
    );
    const general = decodeGtfsRealtimeSync(bytes, {
      ...options,
      stopIds: new Set(["P"]),
    }).tripUpdates;
    const station = decodeStationTripUpdates(bytes, new Set(["P"]), undefined, options);
    expect(general).toHaveLength(1);
    expect(station).toHaveLength(1);
    expect(general[0]).toMatchObject({
      stopId: "P",
      predictedTime: expected + delay * 1000,
      delaySeconds: delay,
      isRealtime: true,
    });
    expect(station[0]).toMatchObject({
      stopId: "P",
      predictedTime: expected + delay * 1000,
      delaySeconds: delay,
      isRealtime: true,
    });
    expect(decodeStationTripUpdates(bytes, new Set(["P"]))).toEqual([]);
  },
);
it("never predicts from an empty stop-time event or from a trip start time", async () => {
  const descriptor = concatBuffers(
    encodeString(1, "T"),
    encodeString(5, "R"),
    encodeString(2, "12:00:00"),
  );
  const stop = concatBuffers(
    encodeVarintField(1, 1),
    encodeMessage(3, new Uint8Array()),
    encodeString(4, "P"),
  );
  const bytes = encodeFeed(1800000000, [
    encodeMessage(
      2,
      encodeMessage(3, concatBuffers(encodeMessage(1, descriptor), encodeMessage(2, stop))),
    ),
  ]);
  const options = await Effect.runPromise(
    prepareScheduledPredictions(bytes, {
      predictionTimeSource: "static-with-delay",
      getScheduledStopTimes: () => {
        throw new Error("must not request a schedule without live delay");
      },
    }),
  );
  expect(decodeGtfsRealtimeSync(bytes, options).tripUpdates).toEqual([]);
  expect(decodeStationTripUpdates(bytes, undefined, undefined, options)).toEqual([]);
});

import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { publishSchedules } from "../../scripts/lib/schedule-publication";
it("publishes deterministic schedules and retires obsolete assets without removing another agency", async () => {
  const root = mkdtempSync(join(tmpdir(), "schedule-publication-"));
  try {
    const catalogFile = join(root, "catalog.json"),
      publicDir = join(root, "public");
    const eligible = new Set(["north", "south"]);
    const publish = (agencyId: string) =>
      publishSchedules({
        agencyId,
        sourceHash: "same-board",
        archives: [gtfsZip(files)],
        catalogFile,
        publicDir,
        eligible: (id) => eligible.has(id),
      });
    await publish("north");
    await publish("south");
    const before = readFileSync(catalogFile, "utf8");
    await publish("north");
    expect(readFileSync(catalogFile, "utf8")).toBe(before);
    eligible.delete("north");
    await publish("south");
    const catalog = JSON.parse(readFileSync(catalogFile, "utf8"));
    expect(Object.keys(catalog.agencies)).toEqual(["south"]);
    expect(readdirSync(join(publicDir, "generated/gtfs-schedules/north"))).toEqual([]);
    expect(readdirSync(join(publicDir, "generated/gtfs-schedules/south"))).toHaveLength(1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(["constructor", "__proto__"])(
  "keeps the literal trip identity %s in the published schedule model",
  async (tripId) => {
    const archive = gtfsZip({
      ...files,
      "trips.txt": files["trips.txt"].replace(",T\n", "," + tripId + "\n"),
      "stop_times.txt": files["stop_times.txt"].replace("T,P,", tripId + ",P,"),
    });
    const data = (await compileGtfsSchedules([archive])).get("R")!;
    expect(Object.keys(data.trips)).toEqual([tripId]);
    expect(data.trips[tripId][0].calls[0]).toEqual([1, "P", 90000, 90060, true]);
  },
);
it("resolves a public stop code within its feed namespace and gives direct IDs precedence", async () => {
  const options = await Effect.runPromise(
    prepareScheduledPredictions(new Uint8Array(), {
      idNamespace: "north",
      stopIdAliases: "static-code",
      getSourceAgencyScope: () =>
        Effect.succeed({
          routeIds: new Set(),
          stopIds: new Set(["north:P", "south:Q", "north:DIRECT"]),
          stopsByCode: new Map([
            ["CODE", ["north:P", "south:Q"]],
            ["DIRECT", ["north:P"]],
          ]),
        }),
    }),
  );
  expect(options.stopAliases).toEqual(new Map([["north:CODE", "north:P"]]));
});

it.each([0, 1])(
  "resolves frequency instances only with a published start, respecting exact_times=%s",
  async (exact) => {
    const archive = gtfsZip({
      ...files,
      "stop_times.txt": files["stop_times.txt"].replace("25:00:00,25:01:00", "08:00:00,08:00:00"),
      "frequencies.txt": `trip_id,start_time,end_time,headway_secs,exact_times\nT,08:00:00,10:00:00,600,${exact}\n`,
    });
    const route = (await compileGtfsSchedules([archive])).get("R")!;
    const lookup = await lookupFor(route, "2026-10-25T12:00:00Z");
    const request = {
      tripId: "T",
      routeId: "R",
      stopId: "P",
      stopSequence: 1,
      startDate: "20261025",
      startTime: "08:07:00",
    };
    const result = await Effect.runPromise(lookup([request, { ...request, startTime: undefined }]));
    expect(result.get(scheduledStopKey(request))).toEqual(
      exact === 0
        ? {
            stopId: "P",
            arrivalTime: Date.parse("2026-10-25T12:07:00Z"),
            departureTime: Date.parse("2026-10-25T12:07:00Z"),
          }
        : undefined,
    );
    expect(result.has(scheduledStopKey({ ...request, startTime: undefined }))).toBe(false);
  },
);

it("joins an omitted realtime route before resolving a delayed call through both departure paths", async () => {
  const bytes = encodeFeed(1800000000, [
    encodeMessage(
      2,
      concatBuffers(
        encodeString(1, "E"),
        encodeMessage(
          3,
          concatBuffers(
            encodeMessage(1, encodeString(1, "T")),
            encodeMessage(
              2,
              concatBuffers(
                encodeVarintField(1, 2),
                encodeString(4, "P"),
                encodeMessage(3, encodeSignedVarintField(1, 30)),
              ),
            ),
          ),
        ),
      ),
    ),
  ]);
  const tripRoutes = new Map([["T", { routeId: "R", directionId: 0 }]]);
  const options = await Effect.runPromise(
    prepareScheduledPredictions(bytes, {
      predictionTimeSource: "static-with-delay",
      tripRoutes,
      getScheduledStopTimes: (requests) =>
        Effect.succeed(
          new Map(
            requests.map((request) => [
              scheduledStopKey(request),
              { stopId: "P", departureTime: 1800000000000 },
            ]),
          ),
        ),
    }),
  );
  expect(decodeGtfsRealtimeSync(bytes, { ...options, tripRoutes }).tripUpdates).toEqual([
    expect.objectContaining({ routeId: "R", stopId: "P", predictedTime: 1800000030000 }),
  ]);
  expect(decodeStationTripUpdates(bytes, new Set(["P"]), tripRoutes, options)).toEqual([
    expect.objectContaining({ routeId: "R", stopId: "P", predictedTime: 1800000030000 }),
  ]);
});

it("rejects a guarded header-only trip feed before stop filters can imply a live empty board", async () => {
  const bytes = encodeFeed(1794310000, []);
  await expect(
    Effect.runPromise(
      prepareScheduledPredictions(bytes, { emptyTripUpdates: "error", stopIds: new Set(["P"]) }),
    ),
  ).rejects.toThrow("upstream feed is empty");
  expect(await Effect.runPromise(prepareScheduledPredictions(bytes, {}))).toMatchObject({});
});
