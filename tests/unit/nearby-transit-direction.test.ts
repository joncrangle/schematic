import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Option } from "effect";
import {
  NearbyTransit,
  NearbyTransitLive,
  NearbySnapshotSource,
  NearbyRealtimeState,
  SurfaceAgencyDefaults,
} from "~/services/surface/NearbyTransit";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { collapsedDirectionLabel } from "~/components/nearby/RouteArrivalCard";
import type {
  ArrivalPrediction,
  RouteDetails,
  SurfaceRoute,
  SurfaceStop,
} from "~/domain/surface/types";
import type { AgencySnapshot } from "~/agencies/types";

/**
 * Inferred-direction collapse seam (NearbyTransit fuse, core-generic).
 *
 * When every prediction for a route is `directionInferred`, the compass words
 * are the adapter's claim, not the operator's: the fuse must merge into a
 * single bucket (no duplicated opposite rows) and surface the operator's own
 * headsign/destination. Honest collapsed labels (production
 * `collapsedDirectionLabel`, same rule as `currentHeadsign`, gated ONLY on
 * directionInferred): inferred destination -> `→ X` ONLY (drop the guessed
 * compass, show to-station — a rider must never see a factually incorrect
 * NORTHBOUND prefix); known destination -> `Eastbound → X`; headsign-only
 * -> `→ Y` (regardless of inferred, headsign is operator text); neither on
 * an inferred direction -> `""` (stop + times only, never a false compass
 * claim); neither on a real/legacy direction -> bare label, never " to "
 * with empty destination, never invented headsign. Any real direction_id
 * keeps the two-direction behavior exactly. No network, no silent skips —
 * every test invokes production code.
 */

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const makeStop = (id: string, lat: number, routes: readonly string[]): SurfaceStop => ({
  id,
  code: `${id}-code`,
  name: `Stop ${id}`,
  lat,
  lon: -79.3857,
  wheelchair: 1,
  routes,
});

const route7: SurfaceRoute = {
  id: "7",
  shortName: "7",
  longName: "King",
  routeType: "bus",
  color: "#006BB7",
  textColor: "#FFFFFF",
};

const makeDetails = (
  directionId: number,
  stops: readonly SurfaceStop[],
  headsign: string,
): RouteDetails => ({
  route: route7,
  shape: {
    id: `7_${directionId}_live`,
    routeId: "7",
    directionId,
    headsign,
    polyline: "",
    minLat: 43.6,
    maxLat: 43.8,
    minLon: -79.5,
    maxLon: -79.3,
    pointCount: stops.length,
  },
  stops,
});

const makePrediction = (
  stopId: string,
  directionId: number,
  predictedTime: number,
  extra?: Partial<ArrivalPrediction>,
): ArrivalPrediction => ({
  tripId: `trip_${stopId}_${directionId}_${predictedTime}`,
  routeId: "7",
  directionId,
  vehicleId: "v1",
  stopSequence: 12,
  stopId,
  predictedTime,
  delaySeconds: 0,
  scheduleRelationship: "SCHEDULED",
  isRealtime: true,
  ...extra,
});

const emptySnapshot: AgencySnapshot = {
  agencyId: "ttc",
  generatedAt: 0,
  freshness: "live",
  alerts: [],
};

/**
 * A route whose direction the wire never states, and one that states it. The
 * distinction is per route, not per agency: no manifest field decides whether a
 * compass word may be shown, because no compass word is ever derived from a
 * direction index in the first place.
 */
const SILENT_WIRE_AGENCY = "grt";
const DIRECTIONED_AGENCY = "ttc";

async function runNearby(
  stop: SurfaceStop,
  details: ReadonlyMap<string, Option.Option<RouteDetails>>,
  preds: readonly ArrivalPrediction[],
  agencyId: string = SILENT_WIRE_AGENCY,
  tripDirections: ReadonlyMap<string, number> = new Map(),
) {
  return runNearbyMulti(
    [{ stop, distanceMeters: 100, walkingMinutes: 2 }],
    details,
    new Map([[stop.id, preds]]),
    agencyId,
    tripDirections,
  );
}

async function runNearbyMulti(
  stopItems: readonly { stop: SurfaceStop; distanceMeters: number; walkingMinutes: number }[],
  details: ReadonlyMap<string, Option.Option<RouteDetails>>,
  predsByStop: ReadonlyMap<string, readonly ArrivalPrediction[]>,
  agencyId: string = SILENT_WIRE_AGENCY,
  tripDirections: ReadonlyMap<string, number> = new Map(),
) {
  const layers = Layer.mergeAll(
    Layer.succeed(
      SurfaceDataStore,
      SurfaceDataStore.of({
        getTripTerminals: () => Effect.succeed(new Map()),
        getDirectionsForTrips: () => Effect.succeed(tripDirections),
        getRouteDirectionIds: (routeId) =>
          Effect.succeed(
            [...details.keys()]
              .filter((key) => key.startsWith(`${routeId}:`))
              .map((key) => Number(key.slice(routeId.length + 1)))
              .filter((directionId) => Number.isInteger(directionId))
              .sort((a, b) => a - b),
          ),
        getRouteDetails: (routeId, directionId) =>
          Effect.succeed(details.get(`${routeId}:${directionId}`) ?? Option.none()),
        getRoute: (routeId) =>
          Effect.succeed(routeId === "7" ? Option.some(route7) : Option.none()),
        getAllRoutes: () => Effect.succeed([]),
        getStopsForRoutes: () => Effect.succeed([]),
        getStopsByIds: () => Effect.succeed([]),
        findNearbyStops: () => Effect.succeed([...stopItems]),
      }),
    ),
    Layer.succeed(
      NearbyRealtimeState,
      NearbyRealtimeState.of({
        getState: Effect.succeed({
          generatedAt: NOW,
          feedTimestamp: NOW,
          stopArrivals: new Map(),
          activeTripCount: 0,
          etags: {},
        }),
        isArrivalsStale: Effect.succeed(false),
        getRealtimeSnapshot: (agencyId: string) =>
          Effect.succeed({ agencyId, updatedAt: NOW, vehicles: [], arrivals: [] }),
        getStopArrivals: (input: { stopId: string }) =>
          Effect.succeed(predsByStop.get(input.stopId) ?? []),
        getRouteVehicles: () => Effect.succeed([]),
        refreshOnce: Effect.void,
      }),
    ),
    Layer.succeed(
      NearbySnapshotSource,
      NearbySnapshotSource.of({ getSnapshot: Effect.succeed(emptySnapshot) }),
    ),
    Layer.succeed(SurfaceAgencyDefaults, {
      agencyId,
      focus: { lat: 43.6532, lon: -79.3832 },
      fallbackBounds: { minLat: 43.58, maxLat: 43.86, minLon: -79.64, maxLon: -79.11 },
    }),
  );
  return Effect.runPromise(
    Effect.gen(function* () {
      const svc = yield* NearbyTransit;
      return yield* svc.getNearbyTransit({
        agencyId,
        lat: 43.6709,
        lon: -79.3857,
        radius: 500,
      });
    }).pipe(Effect.provide(Layer.provide(NearbyTransitLive, layers))),
  );
}

describe("NearbyTransit inferred-direction collapse", () => {
  it("merges all-inferred predictions into one bucket carrying the RT headsign", async () => {
    const stop = makeStop("s1", 43.6709, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], ""))],
      ["7:1", Option.some(makeDetails(1, [stop], ""))],
    ]);
    const preds = [
      makePrediction("s1", 0, NOW + 60_000, {
        directionInferred: true,
        headsign: "Fairway Station",
      }),
      makePrediction("s1", 0, NOW + 120_000, {
        directionInferred: true,
        headsign: "Fairway Station",
      }),
    ];

    const results = await runNearby(stop, details, preds);

    expect(results).toHaveLength(1);
    // One bucket, not two identical opposite rows.
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0]);
    expect(results[0]?.directions?.[0]?.arrivals).toEqual([NOW + 60_000, NOW + 120_000]);
    // Operator headsign outranks the inferred compass word.
    expect(results[0]?.directions?.[0]?.headsign).toBe("Fairway Station");
    // No geometry in the fixture, so there is nothing to read a direction from.
    expect(results[0]?.directions?.[0]?.label).toBe("");
    expect(results[0]?.headsign).toBe("Fairway Station");
    // Honest headsign-only row: arrow + operator text, no bare compass claim.
    expect(results[0]?.directions?.[0]?.destination).toBe("");
    const soleDirection = results[0]?.directions?.[0];
    if (!soleDirection) throw new Error("expected the single direction to render");
    expect(collapsedDirectionLabel(soleDirection)).toBe("→ Fairway Station");
  });

  it("shows to-station ONLY when all predictions are inferred (no guessed compass prefix)", async () => {
    const stop = makeStop("s1", 43.6709, ["7"]);
    // GRT-shaped: the static headsign names a terminal and a route, never a
    // direction, so the compass word on screen is the canonical axis fallback
    // this app picked — not something the operator said.
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], "7 King to Fairway Station"))],
      ["7:1", Option.some(makeDetails(1, [stop], "7 King to Conestoga Station"))],
    ]);
    const preds = [
      makePrediction("s1", 0, NOW + 60_000, { directionInferred: true }),
      makePrediction("s1", 0, NOW + 120_000, { directionInferred: true }),
    ];

    const results = await runNearby(stop, details, preds);

    expect(results).toHaveLength(1);
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0]);
    // The headsign names a terminal and no bearing, so no compass word is
    // derived from the direction index at all. There is nothing to suppress:
    // the label was never a guess in the first place.
    expect(results[0]?.directions?.[0]?.label).toBe("");
    expect(results[0]?.directions?.[0]?.destination).toBe("Fairway Station");
    // Inferred direction: drop the guessed compass, show to-station ONLY.
    // A rider must never see a factually incorrect NORTHBOUND prefix.
    const soleDirection = results[0]?.directions?.[0];
    if (!soleDirection) throw new Error("expected the single direction to render");
    expect(collapsedDirectionLabel(soleDirection)).toBe("→ Fairway Station");
    expect(collapsedDirectionLabel(soleDirection)).not.toContain("Northbound");
  });

  it("suppresses the bare compass word when inferred predictions carry no headsign or destination", async () => {
    const stop = makeStop("s1", 43.6709, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], ""))],
      ["7:1", Option.some(makeDetails(1, [stop], ""))],
    ]);
    const preds = [makePrediction("s1", 0, NOW + 60_000, { directionInferred: true })];

    const results = await runNearby(stop, details, preds);

    // No text is invented and no compass claim is rendered: one row with an
    // empty label but the arrivals intact (stop + times only).
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0]);
    // No headsign and no geometry, so there is nothing to read a direction from.
    expect(results[0]?.directions?.[0]?.label).toBe("");
    expect(results[0]?.directions?.[0]?.destination).toBe("");
    expect(results[0]?.directions?.[0]?.directionInferred).toBe(true);
    expect(results[0]?.directions?.[0]?.arrivals).toEqual([NOW + 60_000]);
    // Truly empty stays empty: the feed stated no headsign, no destination and
    // the fixture has no geometry, so nothing is coerced into a compass word.
    const bare = results[0]?.directions?.[0];
    if (!bare) throw new Error("expected the single direction to render");
    expect(bare.headsign).toBe("");
    expect(bare.label).toBe("");
    const bareLabel = collapsedDirectionLabel(bare);
    expect(bareLabel).toBe("");
    expect(bareLabel).not.toContain(" to ");
    // No terminal was stated either, so there is nothing for the arrow to name.
    expect(bareLabel).not.toContain("→");
    expect(bareLabel).not.toContain("Northbound");
  });

  it("surfaces a route-wide RT headsign from another stop on the anchored bucket", async () => {
    // (a) RT stop_headsign present at stop B must surface on the bucket
    // anchored at closer stop A: the fuse scans allRoutePreds in time order,
    // not just the anchored stop's matchingPreds.
    const stopA = makeStop("sA", 43.6709, ["7"]);
    const stopB = makeStop("sB", 43.672, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stopA, stopB], ""))],
      ["7:1", Option.some(makeDetails(1, [stopA, stopB], ""))],
    ]);
    const predsByStop = new Map([
      ["sA", [makePrediction("sA", 0, NOW + 120_000, { directionInferred: true })]],
      [
        "sB",
        [
          makePrediction("sB", 0, NOW + 60_000, {
            directionInferred: true,
            headsign: "Fairway Station",
          }),
        ],
      ],
    ]);

    const results = await runNearbyMulti(
      [
        { stop: stopA, distanceMeters: 100, walkingMinutes: 2 },
        { stop: stopB, distanceMeters: 250, walkingMinutes: 4 },
      ],
      details,
      predsByStop,
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0]);
    // Bucket stays anchored at the closer stop with its own times...
    expect(results[0]?.directions?.[0]?.stopId).toBe("sA");
    expect(results[0]?.directions?.[0]?.arrivals).toEqual([NOW + 120_000]);
    // ...but carries the route-wide operator headsign from stop B.
    expect(results[0]?.directions?.[0]?.headsign).toBe("Fairway Station");
    expect(results[0]?.headsign).toBe("Fairway Station");
    const soleDirection = results[0]?.directions?.[0];
    if (!soleDirection) throw new Error("expected the single direction to render");
    expect(collapsedDirectionLabel(soleDirection)).toBe("→ Fairway Station");
  });

  it("surfaces the static raw headsign when RT carries none", async () => {
    // (b) With no RT headsign, the static raw headsign outranks the compass
    // word instead of being hidden behind it.
    const stop = makeStop("s1", 43.6709, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], "Fairway Station"))],
      ["7:1", Option.some(makeDetails(1, [stop], ""))],
    ]);
    const preds = [makePrediction("s1", 0, NOW + 60_000, { directionInferred: true })];

    const results = await runNearby(stop, details, preds);

    expect(results).toHaveLength(1);
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0]);
    expect(results[0]?.directions?.[0]?.headsign).toBe("Fairway Station");
    expect(results[0]?.headsign).toBe("Fairway Station");
    const soleDirection = results[0]?.directions?.[0];
    if (!soleDirection) throw new Error("expected the single direction to render");
    expect(collapsedDirectionLabel(soleDirection)).toBe("→ Fairway Station");
  });

  it("keeps the operator's compass word when the static headsign states the direction", async () => {
    // The flag must mean "this compass word is ours", not "the realtime feed
    // was silent". TTC-style static headsigns name the direction themselves
    // ("North, 97 Yonge to Steeles Ave"); that word is the operator's
    // statement and keeps rendering even when no direction_id is on the wire.
    const stop = makeStop("s1", 43.6709, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [stop], "North, 97 Yonge to Steeles Ave"))],
      ["97:1", Option.some(makeDetails(1, [stop], "South, 97 Yonge to Finch"))],
    ]);
    const preds = [makePrediction("s1", 0, NOW + 60_000, { directionInferred: true })];

    const results = await runNearby(stop, details, preds);

    const direction = results[0]?.directions?.[0];
    expect(direction?.directionInferred).toBeUndefined();
    expect(collapsedDirectionLabel(direction!)).toBe("Northbound → Steeles Ave");
  });

  it("shows the operator's terminal for an agency that did not opt in", async () => {
    // No compass word is ever derived from the direction index, so the opt-in
    // is no longer what decides whether a wrong bearing reaches the rider. The
    // agency that did not opt in keeps its two directions, and each row shows
    // the terminal its operator stated.
    const stop = makeStop("s1", 43.6709, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], "7 King to Fairway Station"))],
      ["7:1", Option.some(makeDetails(1, [stop], "7 King to Conestoga Station"))],
    ]);
    // The join resolves the trips, so both declared groups keep their own rows
    // and each shows the terminal its operator stated for that group.
    const tripDirections = new Map([
      [`trip_s1_0_${NOW + 60_000}`, 0],
      [`trip_s1_1_${NOW + 120_000}`, 1],
    ]);
    const preds = [
      makePrediction("s1", 0, NOW + 60_000, { directionInferred: true }),
      makePrediction("s1", 1, NOW + 120_000, { directionInferred: true }),
    ];

    const results = await runNearby(stop, details, preds, DIRECTIONED_AGENCY, tripDirections);

    const directions = results[0]?.directions ?? [];
    expect(directions.map((direction) => direction.directionId).sort()).toEqual([0, 1]);
    for (const direction of directions) {
      // The wire named no direction even though the join resolved it, so the
      // row is still marked inferred.
      expect(direction.directionInferred).toBe(true);
      expect(direction.label).toBe("");
      expect(collapsedDirectionLabel(direction)).toBe(`→ ${direction.destination}`);
      expect(collapsedDirectionLabel(direction)).not.toMatch(/bound/);
    }
    expect(collapsedDirectionLabel(directions[0]!)).toBe("→ Fairway Station");
  });

  it("emits no direction the static feed never declared", async () => {
    // Seeding both directions unconditionally fabricated an opposite row with
    // no headsign and no destination, and the inferred fan-out handed it the
    // same departures. A route declaring one direction yields one row.
    const stop = makeStop("s1", 44.2307, ["1"]);
    const details = new Map([["1:0", Option.some(makeDetails(0, [stop], "Montreal Street"))]]);
    const preds = [makePrediction("s1", 0, NOW + 60_000, { directionInferred: true })];

    const results = await runNearby(stop, details, preds, DIRECTIONED_AGENCY);

    expect(results).toHaveLength(1);
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0]);
    // The one real direction shows the terminal its operator stated.
    const onlyDirection = results[0]?.directions?.[0];
    if (!onlyDirection) throw new Error("expected the declared direction to render");
    expect(collapsedDirectionLabel(onlyDirection)).toBe("→ Montreal Street");
  });

  it("emits no row for a declared direction that does not serve the anchored stop", async () => {
    // Grouping is by the operator's stated way of travel, so a folded route id
    // can carry branches that do not all call at one stop. Deciding per group
    // rather than per route means the ones that do not serve Aldershot get no
    // row, so a rider is not shown trains to terminals where they cannot board.
    // The two directions below are what a GO-style rail feed declares; the
    // per-group stop-serves filter is what excludes a direction whose sequence
    // misses this stop, exercised here with a direction that omits it.
    const aldershot = makeStop("aldershot", 43.3356, ["LW"]);
    const elsewhere = makeStop("hamilton", 43.2557, ["LW"]);
    const details = new Map([
      ["LW:0", Option.some(makeDetails(0, [aldershot, elsewhere], "LW - Aldershot GO"))],
      ["LW:1", Option.some(makeDetails(1, [elsewhere], "LW - Niagara Falls GO"))],
    ]);
    const preds = [makePrediction("aldershot", 0, NOW + 60_000, { directionInferred: true })];
    const tripDirections = new Map([[preds[0]!.tripId, 0]]);

    const results = await runNearbyMulti(
      [{ stop: aldershot, distanceMeters: 100, walkingMinutes: 2 }],
      details,
      new Map([[aldershot.id, preds]]),
      SILENT_WIRE_AGENCY,
      tripDirections,
    );

    const directions = results[0]?.directions ?? [];
    // Direction 1 does not stop at Aldershot, so it is absent rather than
    // rendered with a warning. A rider cannot board it from this stop.
    expect(directions.map((direction) => direction.directionId)).toEqual([0]);
    expect(collapsedDirectionLabel(directions[0]!)).not.toContain("Niagara");
  });

  it("keeps every group when the anchored stop is served by all of them", async () => {
    // The filter must not drop a group that does serve the stop, including the
    // short-turn and branch variants that motivated headsign grouping.
    const stop = makeStop("s1", 43.4987, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], "Conestoga Station"))],
      ["7:1", Option.some(makeDetails(1, [stop], "Fairway Station"))],
      ["7:2", Option.some(makeDetails(2, [stop], "Frederick Station"))],
    ]);
    const preds = [
      makePrediction("s1", 0, NOW + 60_000, { directionInferred: true }),
      makePrediction("s1", 1, NOW + 120_000, { directionInferred: true }),
      makePrediction("s1", 2, NOW + 180_000, { directionInferred: true }),
    ];
    const tripDirections = new Map(preds.map((p, i) => [p.tripId, i]));

    const results = await runNearbyMulti(
      [{ stop, distanceMeters: 100, walkingMinutes: 2 }],
      details,
      new Map([[stop.id, preds]]),
      SILENT_WIRE_AGENCY,
      tripDirections,
    );

    expect((results[0]?.directions ?? []).map((direction) => direction.directionId)).toEqual([
      0, 1, 2,
    ]);
  });

  it("emits one row per declared direction when a route has more than two", async () => {
    // Grouping by headsign means a route can declare three directions, as GRT
    // route 7 does (Conestoga, Fairway, and the Frederick short turn). Each is
    // a service a rider can board, so all three get a row.
    const stop = makeStop("s1", 43.4987, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], "Conestoga Station"))],
      ["7:1", Option.some(makeDetails(1, [stop], "Fairway Station"))],
      ["7:2", Option.some(makeDetails(2, [stop], "Frederick Station"))],
    ]);
    const preds = [
      makePrediction("s1", 0, NOW + 60_000, { directionInferred: true }),
      makePrediction("s1", 1, NOW + 120_000, { directionInferred: true }),
      makePrediction("s1", 2, NOW + 180_000, { directionInferred: true }),
    ];
    // The wire named no direction, so the trip_id join is what attributes each
    // departure to a group. Real feeds join exactly like this.
    const tripDirections = new Map(preds.map((p, i) => [p.tripId, i]));

    const results = await runNearby(stop, details, preds, SILENT_WIRE_AGENCY, tripDirections);

    const directions = results[0]?.directions ?? [];
    expect(directions.map((direction) => direction.directionId)).toEqual([0, 1, 2]);
    expect(directions.map((direction) => direction.destination)).toEqual([
      "Conestoga Station",
      "Fairway Station",
      "Frederick Station",
    ]);
    // Each row carries only its own trip's departure, not a copy of all three.
    expect(directions.map((direction) => direction.arrivals)).toEqual([
      [NOW + 60_000],
      [NOW + 120_000],
      [NOW + 180_000],
    ]);
  });

  it("keeps the bare label for legacy payloads without the inferred flag", () => {
    // Real direction_ids and pre-flag payloads never blank: only
    // directionInferred === true with no destination/headsign suppresses.
    const legacy = {
      directionId: 0,
      headsign: "Northbound",
      label: "Northbound",
      destination: "",
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(legacy)).toBe("Northbound");
  });

  it("preserves both directions when predictions carry real direction ids", async () => {
    const stop = makeStop("s1", 43.6709, ["7"]);
    const details = new Map([
      ["7:0", Option.some(makeDetails(0, [stop], "North - 7 King to Conestoga Station"))],
      ["7:1", Option.some(makeDetails(1, [stop], "South - 7 King to Fairway Station"))],
    ]);
    const preds = [makePrediction("s1", 0, NOW + 60_000), makePrediction("s1", 1, NOW + 90_000)];

    const results = await runNearby(stop, details, preds);

    expect(results).toHaveLength(1);
    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([0, 1]);
    // Real direction_ids never carry the inferred flag.
    expect(results[0]?.directions?.every((direction) => direction.directionInferred !== true)).toBe(
      true,
    );
    expect(results[0]?.directions?.find((d) => d.directionId === 0)?.arrivals).toEqual([
      NOW + 60_000,
    ]);
    expect(results[0]?.directions?.find((d) => d.directionId === 1)?.arrivals).toEqual([
      NOW + 90_000,
    ]);
    // Real bidirectional routes keep two honest rows.
    const northbound = results[0]?.directions?.find((d) => d.directionId === 0);
    const southbound = results[0]?.directions?.find((d) => d.directionId === 1);
    if (!northbound || !southbound) throw new Error("expected both directions to render");
    expect(collapsedDirectionLabel(northbound)).toBe("Northbound → Conestoga Station");
    expect(collapsedDirectionLabel(southbound)).toBe("Southbound → Fairway Station");
  });

  it("labels known (non-inferred) destinations with compass context", () => {
    // Rule (a): destination present and NOT inferred -> `{label} → {destination}`.
    const known = {
      directionId: 0,
      headsign: "Conestoga",
      label: "Northbound",
      destination: "Conestoga",
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(known)).toBe("Northbound → Conestoga");
  });

  it("renders a shape-derived bearing on an inferred destination", () => {
    // `directionInferred` describes the realtime wire, not the label. This label
    // came from the route's own polyline, which runs first point to last point
    // in the direction the vehicle travels, so it is the operator's geometry and
    // it renders. Withholding it is what made a rail route read "→ Aldershot GO"
    // when Core had derived "Westbound" from the operator's own shape.
    const inferred = {
      directionId: 0,
      headsign: "LW - Aldershot GO",
      label: "Westbound",
      destination: "Aldershot GO",
      directionInferred: true,
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(inferred)).toBe("Westbound → Aldershot GO");
  });

  it("states no direction when an inferred route has neither bearing nor geometry", () => {
    // The original GRT bug was a direction_id of 0 rendering "Northbound",
    // because 0 was mapped to the canonical pair. An index carries no bearing,
    // so with no headsign bearing and no polyline there is nothing to render and
    // the label is empty. The arrow still introduces the terminal.
    const inferred = {
      directionId: 0,
      headsign: "Fairway Station",
      label: "",
      destination: "Fairway Station",
      directionInferred: true,
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(inferred)).toBe("→ Fairway Station");
    expect(collapsedDirectionLabel(inferred)).not.toContain("Northbound");
  });

  it("prefers operator headsign text with an arrow regardless of inferred", () => {
    // Rule (c): headsign present and != label -> `→ {headsign}` even when inferred.
    const inferredHeadsign = {
      directionId: 0,
      headsign: "Fairway Station",
      label: "Northbound",
      destination: "",
      directionInferred: true,
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(inferredHeadsign)).toBe("→ Fairway Station");
  });

  it("renders the bare label when there is no destination to arrow", () => {
    // Nothing to withhold: an empty destination means the label is the whole
    // heading, and a label carrying a bearing is the operator's own statement
    // whether it came from the headsign or from the shape.
    const noDestination = {
      directionId: 0,
      headsign: "Northbound",
      label: "Northbound",
      destination: "",
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(noDestination)).toBe("Northbound");
  });

  it("renders nothing when the feed stated neither a bearing nor a terminal", () => {
    // The honest empty case, and the one the old inferred rule was reaching for:
    // no label and no headsign means there is no claim at all, so the row shows
    // stop and times only.
    const nothingStated = {
      directionId: 0,
      headsign: "",
      label: "",
      destination: "",
      stopId: "s1",
      stopName: "Stop s1",
      stopLat: 43.6709,
      stopLon: -79.3857,
      distanceMeters: 100,
      walkingMinutes: 2,
      arrivals: [NOW + 60_000],
    } as const;
    expect(collapsedDirectionLabel(nothingStated)).toBe("");
  });
});
