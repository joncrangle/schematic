import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer, Option } from "effect";
import {
  NearbyTransit,
  NearbyTransitLive,
  NearbySnapshotSource,
  SurfaceAgencyDefaults,
  createRealtimeCacheLayer,
  MAX_RESOLVED_REALTIME_SNAPSHOTS,
  REALTIME_SNAPSHOT_DEDUP_WINDOW_MS,
  type ProximateStopItem,
} from "~/services/surface/NearbyTransit";
import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { createGenericGtfsRealtimeSource } from "~/infrastructure/realtime/genericGtfsRealtimeSource";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";
import { NearbyRealtimeState } from "~/services/surface/NearbyTransit";
import type {
  ArrivalPrediction,
  LiveVehiclePosition,
  RouteDetails,
  SurfaceRoute,
  SurfaceStop,
} from "~/domain/surface/types";
import {
  RealtimeError,
  type RealtimeSnapshot,
  type RealtimeFetchOptions,
  type RealtimeSource,
} from "~/domain/surface/realtimeSource";
import type { AgencySnapshot } from "~/agencies/types";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import type { UiLocale } from "~/domain/locale";
import { makeAgencyAlert } from "../helpers/fixtures";

/**
 * NearbyTransit deep module seam — pinned coverage for selection→fetch→fuse→stale.
 * Ports the former arrival-assembly contract (grouping, 60s windowing,
 * shouldReplace anchoring, ETA fallback, arrivalsStale three sources) plus
 * service-level proximity, saved-transit, and tracking paths onto the single
 * NearbyTransit interface (C1). No silent skips — every test invokes production
 * code.
 */

const NOW = 1_800_000_000_000;

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

const makeStop = (
  id: string,
  lat: number,
  routes: readonly string[],
  name?: string,
): SurfaceStop => ({
  id,
  code: `${id}-code`,
  name: name ?? `Stop ${id}`,
  lat,
  lon: -79.3857,
  wheelchair: 1,
  routes,
});

const route97: SurfaceRoute = {
  id: "97",
  shortName: "97",
  longName: "Yonge",
  routeType: "bus",
  color: "#DA251D",
  textColor: "#FFFFFF",
};

const route10: SurfaceRoute = {
  ...route97,
  id: "10",
  shortName: "10",
  longName: "Main Street",
};

const makeShapeStops = (...ids: string[]) =>
  ids.map((id) => makeStop(id, 43.67 + ids.indexOf(id) * 0.001, ["97"]));

const makeDetails = (
  directionId: number,
  stops: readonly SurfaceStop[],
  route: SurfaceRoute = route97,
): RouteDetails => ({
  route,
  shape: {
    id: `${route.id}_${directionId}_live`,
    routeId: route.id,
    directionId,
    headsign: directionId === 0 ? "North - 97 Yonge to Steeles Ave" : "South - 97 Yonge to South",
    polyline: "",
    minLat: 43.6,
    maxLat: 43.8,
    minLon: -79.5,
    maxLon: -79.3,
    pointCount: stops.length,
  },
  stops,
});

// A branching line: one direction, several termini. The fixture is labelled for
// what it is rather than after any operator, because the property under test is
// structural and belongs to no agency in particular.
const branchRoute: SurfaceRoute = {
  id: "BR",
  shortName: "BR",
  longName: "Branch Line",
  routeType: "bus",
  color: "#008C45",
  textColor: "#FFFFFF",
};

const makePrediction = (
  stopId: string,
  directionId: number,
  predictedTime: number,
  tripId?: string,
  headsign?: string,
  routeId = "97",
  stopSequence = 12,
): ArrivalPrediction => ({
  tripId: tripId ?? `trip_${stopId}_${directionId}_${predictedTime}`,
  routeId,
  directionId,
  vehicleId: "v1",
  stopSequence,
  stopId,
  predictedTime,
  delaySeconds: 0,
  scheduleRelationship: "SCHEDULED",
  isRealtime: true,
  ...(headsign === undefined ? {} : { headsign }),
});

interface StubOverrides {
  agencyId?: string;
  routes?: Map<string, SurfaceRoute>;
  tripDirections?: ReadonlyMap<string, number>;
  tripTerminals?: ReadonlyMap<string, import("~/domain/surface/boarding").TripTerminal>;
  /** Arrivals are narrowed to the request stop allowlist. */
  feedArrivals?: readonly ArrivalPrediction[];
  details?: Map<string, Option.Option<RouteDetails>>;
  arrivals?: Map<string, readonly ArrivalPrediction[]>;
  vehicles?: Map<string, readonly LiveVehiclePosition[]>;
  vehiclesError?: unknown;
  arrivalsStale?: boolean;
  arrivalsError?: unknown;
  snapshotFails?: boolean;
  snapshot?: AgencySnapshot;
  snapshotGetter?: (
    locale?: UiLocale,
    requestCache?: RequestScopedEffectCache,
  ) => Effect.Effect<AgencySnapshot, unknown>;
  nearbyStops?: readonly ProximateStopItem[];
  stopsForRoutes?: readonly SurfaceStop[];
  routeMetadataError?: unknown;
  realtimeSource?: RealtimeSource;
  topology?: StaticSnapshot;
  realtimeMaxSubrequestsWhenAlertsFetch?: number;
}

const emptySnapshot: AgencySnapshot = {
  agencyId: "ttc",
  generatedAt: 0,
  freshness: "live",
  alerts: [],
};

const realtimeSnapshot = (
  agencyId: string,
  arrivals: readonly ArrivalPrediction[] = [],
): RealtimeSnapshot => ({
  agencyId,
  updatedAt: NOW,
  vehicles: [],
  arrivals,
});

const emptyRealtimeSnapshot = (agencyId = "ttc"): RealtimeSnapshot => realtimeSnapshot(agencyId);

const ttcDefaultsValue = {
  agencyId: "ttc",
  locale: "en-CA" as const,
  focus: { lat: 43.6532, lon: -79.3832 },
  fallbackBounds: { minLat: 43.58, maxLat: 43.86, minLon: -79.64, maxLon: -79.11 },
};
const ttcDefaults = Layer.succeed(SurfaceAgencyDefaults, ttcDefaultsValue);

function makeLayers(overrides: StubOverrides = {}) {
  const agencyId = overrides.agencyId ?? "ttc";
  const storeLayer = Layer.succeed(
    SurfaceDataStore,
    SurfaceDataStore.of({
      getTripTerminals: () => Effect.succeed(overrides.tripTerminals ?? new Map()),
      getDirectionsForTrips: () => Effect.succeed(overrides.tripDirections ?? new Map()),
      getRouteDirectionIds: (routeId) =>
        Effect.succeed(
          [...(overrides.details?.keys() ?? [])]
            .filter((key) => key.startsWith(`${routeId}:`))
            .map((key) => Number(key.slice(routeId.length + 1)))
            .filter((directionId) => Number.isInteger(directionId))
            .sort((a, b) => a - b),
        ),
      getRouteDetails: (routeId, directionId) =>
        overrides.routeMetadataError !== undefined
          ? Effect.fail(overrides.routeMetadataError)
          : Effect.succeed(overrides.details?.get(`${routeId}:${directionId}`) ?? Option.none()),
      getRoute: (routeId) =>
        overrides.routeMetadataError !== undefined
          ? Effect.fail(overrides.routeMetadataError)
          : Effect.succeed(
              overrides.routes?.has(routeId)
                ? Option.some(overrides.routes.get(routeId)!)
                : Option.none(),
            ),
      getAllRoutes: () => Effect.succeed([]),
      getStopsForRoutes: () => Effect.succeed(overrides.stopsForRoutes ?? []),
      getStopsByIds: () => Effect.succeed([]),
      findNearbyStops: () => Effect.succeed(overrides.nearbyStops ?? []),
    }),
  );

  const repoLayer = overrides.realtimeSource
    ? createRealtimeCacheLayer(
        {},
        {
          realtimeByAgencyId: new Map([[agencyId, overrides.realtimeSource]]),
          ...(overrides.topology
            ? { topologyByAgencyId: new Map([[agencyId, overrides.topology]]) }
            : {}),
        },
      )
    : Layer.succeed(
        NearbyRealtimeState,
        NearbyRealtimeState.of({
          getState: Effect.succeed({
            generatedAt: NOW,
            feedTimestamp: NOW,
            stopArrivals: new Map(),
            activeTripCount: 0,
            etags: {},
          }),
          isArrivalsStale: Effect.succeed(overrides.arrivalsStale ?? false),
          getRealtimeSnapshot: (agencyId: string, options?: RealtimeFetchOptions) =>
            Effect.succeed(
              realtimeSnapshot(
                agencyId,
                (overrides.feedArrivals ?? []).filter(
                  (prediction) => !options?.stopIds || options.stopIds.has(prediction.stopId ?? ""),
                ),
              ),
            ),
          getStopArrivals: (input: { stopId: string }) =>
            overrides.arrivalsError !== undefined
              ? Effect.fail(overrides.arrivalsError)
              : // Filter by stop id the way the repository does. A stub that
                // ignores it hands the code data the real seam never sees, which
                // is how an unsatisfiable comparison passed review.
                Effect.succeed(
                  (overrides.arrivals?.get(input.stopId) ?? []).filter(
                    (prediction) => prediction.stopId === input.stopId,
                  ),
                ),
          getRouteVehicles: (input: { routeId: string }) =>
            overrides.vehiclesError !== undefined
              ? Effect.fail(overrides.vehiclesError)
              : Effect.succeed(overrides.vehicles?.get(`${input.routeId}`) ?? []),
          refreshOnce: Effect.void,
        }),
      );

  const snapshotLayer = Layer.succeed(
    NearbySnapshotSource,
    NearbySnapshotSource.of({
      getSnapshot: (locale, requestCache) =>
        overrides.snapshotGetter?.(locale, requestCache) ??
        (overrides.snapshotFails
          ? (Effect.fail(new Error("snapshot outage")) as unknown as Effect.Effect<AgencySnapshot>)
          : Effect.succeed(overrides.snapshot ?? emptySnapshot)),
    }),
  );

  const defaultsLayer = Layer.succeed(SurfaceAgencyDefaults, {
    ...ttcDefaultsValue,
    agencyId,
    ...(overrides.realtimeMaxSubrequestsWhenAlertsFetch === undefined
      ? {}
      : { realtimeMaxSubrequestsWhenAlertsFetch: overrides.realtimeMaxSubrequestsWhenAlertsFetch }),
  });

  return Layer.mergeAll(storeLayer, repoLayer, snapshotLayer, defaultsLayer);
}

async function getNearby(nearbyStops: readonly ProximateStopItem[], overrides?: StubOverrides) {
  const program = Effect.gen(function* () {
    const svc = yield* NearbyTransit;
    return yield* svc.getNearbyTransit({
      agencyId: overrides?.agencyId ?? "ttc",
      lat: 43.6709,
      lon: -79.3857,
      radius: 500,
    });
  }).pipe(
    Effect.provide(Layer.provide(NearbyTransitLive, makeLayers({ ...overrides, nearbyStops }))),
  );
  return Effect.runPromise(program);
}

async function getSaved(
  input: { favouriteRoutes: readonly string[]; lat?: number; lon?: number },
  overrides?: StubOverrides,
) {
  const program = Effect.gen(function* () {
    const svc = yield* NearbyTransit;
    return yield* svc.getSavedTransit({ agencyId: "ttc", ...input });
  }).pipe(Effect.provide(Layer.provide(NearbyTransitLive, makeLayers(overrides))));
  return Effect.runPromise(program);
}

async function getTracking(
  routeId: string,
  directionId: number,
  overrides?: StubOverrides,
  locale?: UiLocale,
) {
  const program = Effect.gen(function* () {
    const svc = yield* NearbyTransit;
    return yield* svc.getRouteTracking({ agencyId: "ttc", routeId, directionId, locale });
  }).pipe(Effect.provide(Layer.provide(NearbyTransitLive, makeLayers(overrides))));
  return Effect.runPromise(program);
}

const item = (stop: SurfaceStop, distanceMeters: number): ProximateStopItem => ({
  stop,
  distanceMeters,
  walkingMinutes: Math.max(1, Math.ceil(distanceMeters / 80)),
});

describe("NearbyTransit grouping (ported from the former arrival-assembly service)", () => {
  it("drops a bus route's terminating direction while keeping the turnaround departure", async () => {
    const terminal = makeStop("terminal", 43.6709, ["97"]);
    const adjacent = makeStop("adjacent", 43.6719, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [adjacent, terminal]))],
      ["97:1", Option.some(makeDetails(1, [terminal, adjacent]))],
    ]);
    const terminatingArrival = makePrediction(terminal.id, 0, NOW + 60_000);
    const turnaroundDeparture = makePrediction(terminal.id, 1, NOW + 120_000);

    const results = await getNearby([item(terminal, 100)], {
      details,
      tripTerminals: new Map([
        [terminatingArrival.tripId, { stopId: terminal.id, stopSequence: 12 }],
        [turnaroundDeparture.tripId, { stopId: adjacent.id, stopSequence: 20 }],
      ]),
      arrivals: new Map([[terminal.id, [terminatingArrival, turnaroundDeparture]]]),
      vehicles: new Map([
        [
          "97",
          [
            {
              vehicleId: "bus-terminating",
              routeId: "97",
              directionId: 0,
              latitude: adjacent.lat,
              longitude: adjacent.lon,
              currentStopSequence: 1,
              timestamp: NOW,
            },
          ],
        ],
      ]),
    });

    expect(results[0]?.directions?.map((direction) => direction.directionId)).toEqual([1]);
    expect(results[0]?.directions?.[0]?.arrivals).toEqual([turnaroundDeparture.predictedTime]);
  });

  it("keeps a direction whose rider is at the end of some trips but not others", async () => {
    const outer = makeStop("outer", 43.463, ["BR"], "Outer Terminal");
    const midLine = makeStop("mid", 43.403, ["BR"], "Mid Line");
    const details = new Map([
      // Stored topology runs out to Mid Line, so it reads as this direction's end.
      ["BR:0", Option.some(makeDetails(0, [outer, midLine], branchRoute))],
      ["BR:1", Option.some(makeDetails(1, [midLine, outer], branchRoute))],
    ]);
    const throughTrip = makePrediction(
      midLine.id,
      0,
      NOW + 120_000,
      "through-1",
      undefined,
      "BR",
      0,
    );

    const results = await getNearby([item(midLine, 100)], {
      routes: new Map([["BR", branchRoute]]),
      details,
      arrivals: new Map([[midLine.id, [throughTrip]]]),
      feedArrivals: [throughTrip],
      tripTerminals: new Map([[throughTrip.tripId, { stopId: outer.id, stopSequence: 6 }]]),
    });

    expect(results.map((r) => r.routeId)).toEqual(["BR"]);
    expect(results[0]?.stopId).toBe(midLine.id);
    expect(results[0]?.directions?.map((d) => d.directionId)).toContain(0);
    expect(results[0]?.directions?.find((d) => d.directionId === 0)?.arrivals).toContain(
      throughTrip.predictedTime,
    );
  });

  it("filters terminating and through trips separately without headsigns or stop sequences", async () => {
    // Same station, two westbound trains: one goes on to the outer terminal,
    // one ends here. Terminality is a per-trip fact, so one row cannot stand in
    // for the other and both outcomes have to hold at once.
    const outer = makeStop("outer", 43.463, ["BR"], "Outer Terminal");
    const midLine = makeStop("mid", 43.403, ["BR"], "Mid Line");
    const details = new Map([
      ["BR:0", Option.some(makeDetails(0, [outer, midLine], branchRoute))],
      ["BR:1", Option.some(makeDetails(1, [midLine, outer], branchRoute))],
    ]);
    const throughTrip = makePrediction(
      midLine.id,
      0,
      NOW + 120_000,
      "through-1",
      undefined,
      "BR",
      0,
    );
    const terminatingTrip = makePrediction(
      midLine.id,
      0,
      NOW + 60_000,
      "terminating-1",
      undefined,
      "BR",
      0,
    );
    const eastbound = makePrediction(midLine.id, 1, NOW + 240_000, "inbound-1", undefined, "BR", 0);

    const results = await getNearby([item(midLine, 100)], {
      routes: new Map([["BR", branchRoute]]),
      details,
      arrivals: new Map([[midLine.id, [terminatingTrip, throughTrip, eastbound]]]),
      feedArrivals: [terminatingTrip, throughTrip, eastbound],
      tripTerminals: new Map([
        [throughTrip.tripId, { stopId: outer.id, stopSequence: 6 }],
        [terminatingTrip.tripId, { stopId: midLine.id, stopSequence: 2 }],
        [eastbound.tripId, { stopId: outer.id, stopSequence: 6 }],
      ]),
    });

    const outbound = results[0]?.directions?.find((d) => d.directionId === 0);
    // The through train is offered and the terminating one is not, in the same
    // direction of the same card. Neither stands in for the other.
    expect(outbound?.arrivals).toContain(throughTrip.predictedTime);
    expect(outbound?.arrivals).not.toContain(terminatingTrip.predictedTime);
    expect(results[0]?.directions?.find((d) => d.directionId === 1)?.arrivals).toContain(
      eastbound.predictedTime,
    );
  });

  it.each([
    { name: "short turn", terminalId: "mid", sequence: 12, expected: [] },
    { name: "earlier loop call", terminalId: "mid", sequence: 20, expected: [NOW + 120_000] },
    { name: "unknown trip", terminalId: undefined, sequence: 0, expected: [NOW + 120_000] },
  ])(
    "handles a $name at an intermediate canonical stop",
    async ({ terminalId, sequence, expected }) => {
      const start = makeStop("start", 43.67, ["97"]);
      const mid = makeStop("mid", 43.6709, ["97"]);
      const end = makeStop("end", 43.68, ["97"]);
      const prediction = makePrediction(mid.id, 0, NOW + 120_000, "trip", undefined, "97", 12);
      const [result] = await getNearby([item(mid, 100)], {
        details: new Map([["97:0", Option.some(makeDetails(0, [start, mid, end]))]]),
        arrivals: new Map([[mid.id, [prediction]]]),
        tripTerminals: terminalId
          ? new Map([[prediction.tripId, { stopId: terminalId, stopSequence: sequence }]])
          : new Map(),
      });
      expect(result.directions?.flatMap((direction) => direction.arrivals)).toEqual(expected);
    },
  );

  it("serves a stop the stored topology omits when the route calls there", async () => {
    // A branch terminus is in `stops` and in the route's membership index but in
    // no topology row, because one canonical trip per direction is all that is
    // stored. Validating the rider's own stop against that row removed the
    // station from the candidate list before any realtime query ran.
    const outer = makeStop("outer", 43.463, ["BR"], "Outer Terminal");
    const midLine = makeStop("mid", 43.403, ["BR"], "Mid Line");
    const results = await getNearby([item(outer, 100)], {
      routes: new Map([["BR", branchRoute]]),
      details: new Map([["BR:0", Option.some(makeDetails(0, [midLine], branchRoute))]]),
      arrivals: new Map([
        [
          outer.id,
          [makePrediction(outer.id, 0, NOW + 180_000, "branch-1", "BR - Outer Terminal", "BR", 4)],
        ],
      ]),
    });

    expect(results.map((r) => r.routeId)).toContain("BR");
    expect(results[0]?.stopId).toBe(outer.id);
  });

  it("uses the static trip direction for a live departure on an omitted branch", async () => {
    const branch = makeStop("branch", 43.6709, ["BR"]);
    const canonical = makeStop("canonical", 43.6709, ["BR"]);
    const prediction = {
      ...makePrediction(branch.id, 0, NOW + 60_000, "branch-trip", undefined, "BR"),
      directionInferred: true as const,
    };
    const [result] = await getNearby([item(branch, 100)], {
      routes: new Map([["BR", branchRoute]]),
      details: new Map([
        ["BR:0", Option.some(makeDetails(0, [canonical], branchRoute))],
        ["BR:1", Option.some(makeDetails(1, [canonical], branchRoute))],
      ]),
      arrivals: new Map([[branch.id, [prediction]]]),
      tripDirections: new Map([[prediction.tripId, 1]]),
      tripTerminals: new Map([[prediction.tripId, { stopId: "later", stopSequence: 20 }]]),
    });
    expect(
      result.directions?.map(({ directionId, arrivals }) => ({ directionId, arrivals })),
    ).toEqual([{ directionId: 1, arrivals: [prediction.predictedTime] }]);
  });

  it.each(["single", "unattributed", "mixed"] as const)(
    "keeps unknown inferred trips in a $0 feed",
    async (mode) => {
      const known = mode === "mixed";
      const stop = makeStop("mid", 43.6709, ["97"]);
      const prediction = {
        ...makePrediction(stop.id, 0, NOW + 60_000, "unknown"),
        directionInferred: true as const,
      };
      const secondPrediction = {
        ...prediction,
        tripId: "known",
        predictedTime: NOW + 120_000,
        directionId: known ? 0 : 1,
      };
      const [result] = await getNearby([item(stop, 100)], {
        details: new Map([["97:0", Option.some(makeDetails(0, [stop]))]]),
        arrivals: new Map([
          [stop.id, mode !== "single" ? [prediction, secondPrediction] : [prediction]],
        ]),
        tripDirections: known ? new Map([["known", 0]]) : new Map(),
        tripTerminals: known
          ? new Map([["known", { stopId: "later", stopSequence: 20 }]])
          : new Map(),
      });
      expect(result.directions?.flatMap(({ arrivals }) => arrivals)).toEqual(
        mode !== "single"
          ? [prediction.predictedTime, secondPrediction.predictedTime]
          : [prediction.predictedTime],
      );
    },
  );

  it("merges stops served by the same route into one result anchored at the closest stop", async () => {
    const near = makeStop("s-near", 43.6709, ["97"]);
    const far = makeStop("s-far", 43.672, ["97"]);
    const results = await getNearby([item(near, 100), item(far, 250)], {
      routes: new Map([["97", route97]]),
    });
    expect(results.length).toBe(1);
    expect(results[0].routeId).toBe("97");
    expect(results[0].stopId).toBe("s-near");
    expect(results[0].directions?.map((d) => d.directionId)).toEqual([0, 1]);
  });

  it("uses the canonical read path on repeated arrival assembly (write-free polling)", async () => {
    const stop = makeStop("s-near", 43.6709, ["97"]);
    const overrides = {
      routes: new Map([["97", route97]]),
      details: new Map([
        ["97:0", Option.some(makeDetails(0, [stop]))],
        ["97:1", Option.some(makeDetails(1, [stop]))],
      ]),
    };

    const first = await getNearby([item(stop, 100)], overrides);
    const second = await getNearby([item(stop, 100)], overrides);

    expect(first).toHaveLength(1);
    expect(first[0]?.routeId).toBe("97");
    // A second poll over the same topology resolves identically: arrival
    // assembly performs canonical reads only, never a topology write.
    expect(second).toEqual(first);
  });

  it("ignores a stale nearby route membership absent from route topology", async () => {
    const stale = makeStop("stale", 43.6709, ["97"]);
    const actual = makeStop("actual", 43.672, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [actual]))],
      ["97:1", Option.some(makeDetails(1, [actual]))],
    ]);

    const results = await getNearby([item(stale, 100), item(actual, 250)], { details });

    expect(results).toHaveLength(1);
    expect(results[0]?.stopId).toBe(actual.id);
  });

  /**
   * The stop-membership filter can admit a stop the stored topology omits, but
   * only on a prediction the render path would actually use. These pin that the
   * escape hatch is no wider than the rendering it feeds, because a last-good
   * entry re-served after a feed outage is flagged stale and can be arbitrarily
   * old. Without the window check a stale membership row re-admits the stop and
   * then wins the card anchor on its own predictions.
   */
  it("keeps ignoring a stale membership whose only prediction is outside the window", async () => {
    const stale = makeStop("stale", 43.6709, ["97"]);
    const actual = makeStop("actual", 43.672, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [actual]))],
      ["97:1", Option.some(makeDetails(1, [actual]))],
    ]);

    const results = await getNearby([item(stale, 100), item(actual, 250)], {
      details,
      arrivals: new Map([[stale.id, [makePrediction(stale.id, 0, NOW - 10 * 60_000)]]]),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stopId).toBe(actual.id);
  });

  it("keeps ignoring a stale membership whose only prediction is cancelled", async () => {
    const stale = makeStop("stale", 43.6709, ["97"]);
    const actual = makeStop("actual", 43.672, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [actual]))],
      ["97:1", Option.some(makeDetails(1, [actual]))],
    ]);
    const cancelled = {
      ...makePrediction(stale.id, 0, NOW + 120_000),
      scheduleRelationship: "SKIPPED" as const,
    };

    const results = await getNearby([item(stale, 100), item(actual, 250)], {
      details,
      arrivals: new Map([[stale.id, [cancelled]]]),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stopId).toBe(actual.id);
  });

  it("keeps ignoring a stale membership whose only prediction is for another route", async () => {
    const stale = makeStop("stale", 43.6709, ["97"]);
    const actual = makeStop("actual", 43.672, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [actual]))],
      ["97:1", Option.some(makeDetails(1, [actual]))],
    ]);

    const results = await getNearby([item(stale, 100), item(actual, 250)], {
      details,
      arrivals: new Map([
        [stale.id, [makePrediction(stale.id, 0, NOW + 120_000, "other-trip", undefined, "10")]],
      ]),
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.stopId).toBe(actual.id);
  });

  it("keeps a nearby stop when a feed alias moved along the same corridor", async () => {
    const liveAlias = {
      ...makeStop("live-alias", 10, ["10"]),
      name: "Main Street At First Avenue",
      lon: 20,
    };
    const cachedTopology = {
      ...makeStop("cached-topology", 10.001, ["10"]),
      name: "Main Street At Third Avenue",
      lon: 20,
    };
    const details = new Map([
      ["10:0", Option.some(makeDetails(0, [cachedTopology], route10))],
      ["10:1", Option.some(makeDetails(1, [cachedTopology], route10))],
    ]);

    const results = await getNearby([item(liveAlias, 100)], { details });

    expect(results).toHaveLength(1);
    expect(results[0]?.stopId).toBe(liveAlias.id);
  });

  it("preserves explicitly saved stops when their feed IDs differ from route topology", async () => {
    const savedStop = makeStop("saved-alias", 43.6709, ["97"]);
    const topologyStop = makeStop("topology-id", 43.6709, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [topologyStop]))],
      ["97:1", Option.some(makeDetails(1, [topologyStop]))],
    ]);

    const results = await getSaved(
      { favouriteRoutes: ["97"], lat: 43.6709, lon: -79.3857 },
      { details, stopsForRoutes: [savedStop] },
    );

    expect(results).toHaveLength(1);
    expect(results[0]?.stopId).toBe(savedStop.id);
  });

  it("keeps the route card when live vehicle fallback fails", async () => {
    const near = makeStop("s-near", 43.6709, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [near]))],
      ["97:1", Option.some(makeDetails(1, [near]))],
    ]);

    const results = await getNearby([item(near, 100)], {
      routes: new Map([["97", route97]]),
      details,
      vehiclesError: new Error("vehicle feed unavailable"),
    });

    expect(results).toHaveLength(1);
    expect(results[0].directions?.map((direction) => direction.arrivals)).toEqual([[], []]);
    expect(results[0].arrivalsStale).toBe(true);
  });

  it("uses route details as metadata when the route row is unavailable", async () => {
    const near = makeStop("s-near", 43.6709, ["97"]);
    const details = new Map([
      ["97:0", Option.some(makeDetails(0, [near]))],
      ["97:1", Option.some(makeDetails(1, [near]))],
    ]);
    const result = await getNearby([item(near, 100)], {
      details,
      routes: new Map(),
    });

    expect(result).toHaveLength(1);
    expect(result[0]?.routeShortName).toBe("97");
  });

  it("does not assemble subway routes into the surface nearby panel", async () => {
    const subway = { ...route97, id: "1", shortName: "1", routeType: "subway" as const };
    const stop = { ...makeStop("s-subway", 43.6709, ["1"]) };
    const result = await getNearby([item(stop, 100)], {
      routes: new Map([["1", subway]]),
    });

    expect(result).toEqual([]);
  });

  it("a direction carries only its anchored stop's predictions, not farther siblings'", async () => {
    const near = makeStop("s-near", 43.6709, ["97"]);
    const far = makeStop("s-far", 43.672, ["97"]);
    const results = await getNearby([item(near, 100), item(far, 250)], {
      arrivals: new Map([
        ["s-near", [makePrediction("s-near", 0, NOW + 300_000)]],
        ["s-far", [makePrediction("s-far", 0, NOW + 60_000)]],
      ]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals).toEqual([NOW + 300_000]);
    expect(dir0?.stopId).toBe("s-near");
  });

  it("returns an empty list when given no stop items (no nearby stops)", async () => {
    expect(await getNearby([])).toEqual([]);
  });

  it("sorts results by distance from the rider", async () => {
    const routeA = { ...route97, id: "97" };
    const routeB = { ...route97, id: "72", shortName: "72", longName: "Pape" };
    const stopA = makeStop("s-a", 43.671, ["97"]);
    const stopB = makeStop("s-b", 43.668, ["72"]);
    const results = await getNearby([item(stopA, 400), item(stopB, 120)], {
      routes: new Map([
        ["97", routeA],
        ["72", routeB],
      ]),
    });
    expect(results.map((r) => r.routeId)).toEqual(["72", "97"]);
  });
});

describe("NearbyTransit freshness windowing", () => {
  const stop = makeStop("s-near", 43.6709, ["97"]);
  const nearItem = item(stop, 100);

  it("drops predictions older than the now−60s window", async () => {
    const stale = makePrediction("s-near", 0, NOW - 61_000);
    const fresh = makePrediction("s-near", 0, NOW - 59_000);
    const results = await getNearby([nearItem], {
      arrivals: new Map([["s-near", [stale, fresh]]]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals).toEqual([fresh.predictedTime]);
  });

  it("keeps a prediction exactly on the window boundary (now−60s)", async () => {
    const boundary = makePrediction("s-near", 0, NOW - 60_000);
    const results = await getNearby([nearItem], {
      arrivals: new Map([["s-near", [boundary]]]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals).toEqual([boundary.predictedTime]);
  });

  it("ignores predictions belonging to a different route", async () => {
    const otherRoute = { ...makePrediction("s-near", 0, NOW + 60_000), routeId: "72" };
    const results = await getNearby([nearItem], {
      arrivals: new Map([["s-near", [otherRoute]]]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals).toEqual([]);
  });

  it("caps arrivals at three per direction", async () => {
    const preds = [1, 2, 3, 4].map((m) => makePrediction("s-near", 0, NOW + m * 60_000));
    const results = await getNearby([nearItem], {
      arrivals: new Map([["s-near", preds]]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals.length).toBe(3);
  });
});

describe("NearbyTransit shouldReplace anchoring", () => {
  it("a closer stop with predictions displaces a farther stop's entry", async () => {
    const far = makeStop("s-far", 43.672, ["97"]);
    const near = makeStop("s-near", 43.6709, ["97"]);
    const results = await getNearby([item(far, 250), item(near, 100)], {
      arrivals: new Map([
        ["s-near", [makePrediction("s-near", 0, NOW + 120_000)]],
        ["s-far", [makePrediction("s-far", 0, NOW + 30_000)]],
      ]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.stopId).toBe("s-near");
  });

  it("a farther stop cannot displace an anchored entry that already has predictions", async () => {
    const far = makeStop("s-far", 43.672, ["97"]);
    const near = makeStop("s-near", 43.6709, ["97"]);
    const results = await getNearby([item(near, 100), item(far, 250)], {
      arrivals: new Map([
        ["s-near", [makePrediction("s-near", 0, NOW + 120_000)]],
        ["s-far", [makePrediction("s-far", 0, NOW + 10_000)]],
      ]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.stopId).toBe("s-near");
    expect(dir0?.arrivals).toEqual([NOW + 120_000]);
  });

  it("a farther stop WITH predictions replaces a closer stop's empty entry", async () => {
    const far = makeStop("s-far", 43.672, ["97"]);
    const near = makeStop("s-near", 43.6709, ["97"]);
    const results = await getNearby([item(near, 100), item(far, 250)], {
      arrivals: new Map([["s-far", [makePrediction("s-far", 0, NOW + 10_000)]]]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.stopId).toBe("s-far");
    expect(dir0?.arrivals).toEqual([NOW + 10_000]);
  });
});

describe("NearbyTransit approaching-vehicle fallback (sole server call site)", () => {
  it("derives ETAs from approaching corridor vehicles when predictions are empty", async () => {
    // Keep the rider mid-route so this fallback test does not exercise terminal filtering.
    const shapeStops = makeShapeStops("c0", "c1", "c2", "c3");
    const rider = shapeStops[2];
    const results = await getNearby([item(rider, 100)], {
      details: new Map([
        ["97:0", Option.some(makeDetails(0, shapeStops))],
        ["97:1", Option.some(makeDetails(1, [...shapeStops].reverse()))],
      ]),
      vehicles: new Map([
        [
          "97",
          [
            {
              vehicleId: "bus-7",
              routeId: "97",
              directionId: 0,
              latitude: shapeStops[0].lat,
              longitude: shapeStops[0].lon,
              currentStopSequence: 1,
              timestamp: NOW,
            },
          ],
        ],
      ]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals).toEqual([NOW + 240_000]);
  });

  it("keeps empty arrivals when no live route config exists for the direction", async () => {
    const rider = makeStop("s-near", 43.6709, ["97"]);
    const results = await getNearby([item(rider, 100)], {
      vehicles: new Map([
        [
          "97",
          [
            {
              vehicleId: "bus-7",
              routeId: "97",
              directionId: 0,
              latitude: 43.67,
              longitude: -79.3857,
              timestamp: NOW,
            },
          ],
        ],
      ]),
    });
    const dir0 = results[0].directions?.find((d) => d.directionId === 0);
    expect(dir0?.arrivals).toEqual([]);
  });

  it("retains the route entity with empty arrivals when nothing is derivable", async () => {
    const rider = makeStop("s-near", 43.6709, ["97"]);
    const results = await getNearby([item(rider, 100)]);
    expect(results.length).toBe(1);
    expect(results[0].routeId).toBe("97");
    expect(results[0].arrivals).toEqual([]);
    expect(results[0].routeShortName).toBe("97");
  });
});

describe("NearbyTransit feed-degradation threading (single arrivalsStale fold)", () => {
  const near = makeStop("s-near", 43.6709, ["97"]);

  it("stamps arrivalsStale onto cards while the protobuf feed is degraded", async () => {
    const results = await getNearby([item(near, 100)], {
      routes: new Map([["97", route97]]),
      arrivalsStale: true,
    });
    expect(results.length).toBe(1);
    expect(results[0].arrivalsStale).toBe(true);
  });

  it("leaves arrivalsStale unset when the feed is healthy", async () => {
    const results = await getNearby([item(near, 100)], {
      routes: new Map([["97", route97]]),
    });
    expect(results[0].arrivalsStale).toBeUndefined();
  });

  it("marks cards stale when a live realtime snapshot reports a partial feed set", async () => {
    const sampleId = "fictional-transit";
    const partialSource: RealtimeSource = {
      fetchRealtime: () =>
        Effect.succeed({
          agencyId: sampleId,
          updatedAt: NOW,
          vehicles: [],
          arrivals: [],
          partial: true,
        }),
    };
    const results = await getNearby([item(near, 100)], {
      agencyId: sampleId,
      routes: new Map([["97", route97]]),
      realtimeSource: partialSource,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.arrivalsStale).toBe(true);
  });

  it("stamps arrivalsStale when the repository re-serves predictions flagged freshness:stale", async () => {
    const staleLastGood = {
      ...makePrediction("s-near", 0, NOW + 120_000),
      freshness: "stale" as const,
    };
    const results = await getNearby([item(near, 100)], {
      routes: new Map([["97", route97]]),
      arrivals: new Map([["s-near", [staleLastGood]]]),
    });
    expect(results.length).toBe(1);
    expect(results[0].arrivals).toEqual([NOW + 120_000]);
    expect(results[0].arrivalsStale).toBe(true);
  });

  it("stamps arrivalsStale and retains topology when snapshot service fails", async () => {
    const results = await getNearby([item(near, 100)], {
      routes: new Map([["97", route97]]),
      snapshotFails: true,
    });
    expect(results.length).toBe(1);
    expect(results[0].routeId).toBe("97");
    expect(results[0].arrivalsStale).toBe(true);
    expect(results[0].alerts).toEqual([]);
  });
});

describe("NearbyTransit failure handling", () => {
  it("retains the route card and marks it stale when a realtime stop lookup fails", async () => {
    const stop = makeStop("s-near", 43.6709, ["97"]);

    const results = await getNearby([item(stop, 100)], {
      routes: new Map([["97", route97]]),
      arrivalsError: new Error("realtime outage"),
    });

    expect(results).toHaveLength(1);
    expect(results[0].routeId).toBe("97");
    expect(results[0].arrivals).toEqual([]);
    expect(results[0].arrivalsStale).toBe(true);
  });

  it("shares one failed realtime snapshot across all stop and vehicle lookups", async () => {
    let fetchCalls = 0;
    const source: RealtimeSource = {
      fetchRealtime: () => {
        fetchCalls += 1;
        return Effect.fail(new RealtimeError({ agencyId: "ttc", message: "realtime outage" }));
      },
    };
    const stops = [
      item(makeStop("s-97", 43.6709, ["97"]), 100),
      item(makeStop("s-10", 43.671, ["10"]), 120),
    ];

    const results = await getNearby(stops, { realtimeSource: source });

    expect(results).toHaveLength(2);
    expect(fetchCalls).toBe(1);
    expect(results.every((result) => result.arrivalsStale === true)).toBe(true);
  });
});

describe("NearbyRealtimeState realtime snapshot reuse", () => {
  it("keeps its resolved snapshot cache bounded and evicts least recently used keys", async () => {
    const snapshot: RealtimeSnapshot = {
      agencyId: "ttc",
      updatedAt: NOW,
      vehicles: [],
      arrivals: [],
    };
    const fetchRealtime = vi.fn(() => Effect.succeed(snapshot));
    const layer = createRealtimeCacheLayer(
      {},
      { realtimeByAgencyId: new Map([["ttc", { fetchRealtime }]]) },
    );
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* NearbyRealtimeState;
      }).pipe(Effect.provide(layer)),
    );

    for (let index = 0; index < MAX_RESOLVED_REALTIME_SNAPSHOTS + 32; index++) {
      await Effect.runPromise(
        repository.getRealtimeSnapshot("ttc", { routeIds: new Set([`R${index}`]) }),
      );
    }
    await Effect.runPromise(
      repository.getRealtimeSnapshot("ttc", {
        routeIds: new Set([`R${MAX_RESOLVED_REALTIME_SNAPSHOTS + 31}`]),
      }),
    );
    await Effect.runPromise(repository.getRealtimeSnapshot("ttc", { routeIds: new Set(["R32"]) }));
    expect(fetchRealtime).toHaveBeenCalledTimes(MAX_RESOLVED_REALTIME_SNAPSHOTS + 32);

    await Effect.runPromise(
      repository.getRealtimeSnapshot("ttc", {
        routeIds: new Set([`R${MAX_RESOLVED_REALTIME_SNAPSHOTS + 32}`]),
      }),
    );
    await Effect.runPromise(repository.getRealtimeSnapshot("ttc", { routeIds: new Set(["R32"]) }));
    expect(fetchRealtime).toHaveBeenCalledTimes(MAX_RESOLVED_REALTIME_SNAPSHOTS + 33);

    await Effect.runPromise(repository.getRealtimeSnapshot("ttc", { routeIds: new Set(["R33"]) }));
    expect(fetchRealtime).toHaveBeenCalledTimes(MAX_RESOLVED_REALTIME_SNAPSHOTS + 34);
  });

  it("reuses one resolved feed read across stop and vehicle lookups", async () => {
    const snapshot: RealtimeSnapshot = {
      agencyId: "ttc",
      updatedAt: NOW,
      vehicles: [],
      arrivals: [makePrediction("stop-a", 0, NOW + 60_000)],
    };
    const fetchRealtime = vi.fn(() => Effect.succeed(snapshot));
    const source = { fetchRealtime };
    const layer = createRealtimeCacheLayer(
      {},
      {
        realtimeByAgencyId: new Map([["ttc", source]]),
      },
    );

    const results = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* NearbyRealtimeState;
        return yield* Effect.all(
          [
            repository.getStopArrivals({ agencyId: "ttc", stopId: "stop-a", routeId: "97" }),
            repository.getStopArrivals({ agencyId: "ttc", stopId: "stop-b", routeId: "97" }),
            repository.getRouteVehicles({ agencyId: "ttc", routeId: "97" }),
          ],
          { concurrency: "unbounded" },
        );
      }).pipe(Effect.provide(layer)),
    );

    expect(fetchRealtime).toHaveBeenCalledTimes(1);
    expect(results[0]).toHaveLength(1);
    expect(results[1]).toEqual([]);
    expect(results[2]).toEqual([]);
  });

  it("does not cache partial realtime data over the last complete snapshot", async () => {
    const completePrediction = makePrediction("stop-a", 0, NOW + 60_000);
    const partialPrediction = makePrediction("stop-a", 0, NOW + 120_000);
    let fetchCount = 0;
    const fetchRealtime = vi.fn(() => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return Effect.succeed({
          agencyId: "ttc",
          updatedAt: NOW,
          vehicles: [],
          arrivals: [completePrediction],
        });
      }
      if (fetchCount === 2) {
        return Effect.succeed({
          agencyId: "ttc",
          updatedAt: NOW + REALTIME_SNAPSHOT_DEDUP_WINDOW_MS + 1,
          vehicles: [],
          arrivals: [partialPrediction],
          partial: true,
        });
      }
      return Effect.fail(new RealtimeError({ agencyId: "ttc", message: "realtime outage" }));
    });
    const layer = createRealtimeCacheLayer(
      {},
      { realtimeByAgencyId: new Map([["ttc", { fetchRealtime }]]) },
    );
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* NearbyRealtimeState;
      }).pipe(Effect.provide(layer)),
    );
    const query = { agencyId: "ttc", stopId: "stop-a", routeId: "97" };

    await Effect.runPromise(repository.getStopArrivals(query));
    vi.advanceTimersByTime(REALTIME_SNAPSHOT_DEDUP_WINDOW_MS + 1);
    const partial = await Effect.runPromise(repository.getStopArrivals(query));
    expect(partial[0]?.predictedTime).toBe(partialPrediction.predictedTime);
    expect(await Effect.runPromise(repository.isArrivalsStale)).toBe(true);

    vi.advanceTimersByTime(REALTIME_SNAPSHOT_DEDUP_WINDOW_MS + 1);
    const afterOutage = await Effect.runPromise(repository.getStopArrivals(query));
    expect(afterOutage[0]).toMatchObject({
      tripId: completePrediction.tripId,
      predictedTime: completePrediction.predictedTime,
      freshness: "stale",
    });
    expect(fetchRealtime).toHaveBeenCalledTimes(3);
  });

  it("does not share an in-flight feed Fiber across concurrent callers", async () => {
    const snapshot: RealtimeSnapshot = {
      agencyId: "ttc",
      updatedAt: NOW,
      vehicles: [],
      arrivals: [makePrediction("stop-a", 0, NOW + 60_000)],
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchRealtime = vi.fn(() =>
      Effect.as(
        Effect.promise(() => gate),
        snapshot,
      ),
    );
    const layer = createRealtimeCacheLayer(
      {},
      {
        realtimeByAgencyId: new Map([["ttc", { fetchRealtime }]]),
      },
    );

    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* NearbyRealtimeState;
      }).pipe(Effect.provide(layer)),
    );
    const pending = Promise.all([
      Effect.runPromise(
        repository.getStopArrivals({ agencyId: "ttc", stopId: "stop-a", routeId: "97" }),
      ),
      Effect.runPromise(
        repository.getStopArrivals({ agencyId: "ttc", stopId: "stop-b", routeId: "97" }),
      ),
      Effect.runPromise(repository.getRouteVehicles({ agencyId: "ttc", routeId: "97" })),
    ]);

    await vi.waitFor(() => expect(fetchRealtime).toHaveBeenCalledTimes(3));
    release();
    await pending;

    expect(fetchRealtime).toHaveBeenCalledTimes(3);
  });

  it("reuses a decoded snapshot through the overlap window", async () => {
    const snapshot: RealtimeSnapshot = {
      agencyId: "ttc",
      updatedAt: NOW,
      vehicles: [],
      arrivals: [makePrediction("stop-a", 0, NOW + 60_000)],
    };
    const fetchRealtime = vi.fn(() => Effect.succeed(snapshot));
    const layer = createRealtimeCacheLayer(
      {},
      {
        realtimeByAgencyId: new Map([["ttc", { fetchRealtime }]]),
      },
    );
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* NearbyRealtimeState;
      }).pipe(Effect.provide(layer)),
    );
    const query = { agencyId: "ttc", stopId: "stop-a", routeId: "97" };

    await Effect.runPromise(repository.getStopArrivals(query));
    await Effect.runPromise(repository.getStopArrivals(query));
    expect(fetchRealtime).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(REALTIME_SNAPSHOT_DEDUP_WINDOW_MS + 1);
    await Effect.runPromise(repository.getStopArrivals(query));
    expect(fetchRealtime).toHaveBeenCalledTimes(2);
  });
});

describe("NearbyTransit selection→fetch→fuse→stale integration (bbox fuse)", () => {
  it("keeps alert snapshots separate by requested locale", async () => {
    const locales: UiLocale[] = [];
    const nearbyStops = [item(makeStop("s1", 43.67091, ["97"]), 10)];
    const layer = Layer.provide(
      NearbyTransitLive,
      makeLayers({
        nearbyStops,
        snapshotGetter: (locale) =>
          Effect.sync(() => {
            if (locale) locales.push(locale);
            return emptySnapshot;
          }),
      }),
    );
    const program = Effect.gen(function* () {
      const svc = yield* NearbyTransit;
      const request = { agencyId: "ttc", lat: 43.6709, lon: -79.3857, radius: 500 };
      yield* svc.getNearbyTransit({ ...request, locale: "fr-CA" });
      yield* svc.getNearbyTransit({ ...request, locale: "en-CA" });
      yield* svc.getNearbyTransit({ ...request, locale: "fr-CA" });
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);

    expect(locales).toEqual(["fr-CA", "en-CA"]);
  });

  it("reuses the alert snapshot across nearby requests within the cache window", async () => {
    let snapshotCalls = 0;
    const nearbyStops = [item(makeStop("s1", 43.67091, ["97"]), 10)];
    const layer = Layer.provide(
      NearbyTransitLive,
      makeLayers({
        nearbyStops,
        snapshotGetter: () =>
          Effect.sync(() => {
            snapshotCalls += 1;
            return emptySnapshot;
          }),
      }),
    );
    const program = Effect.gen(function* () {
      const svc = yield* NearbyTransit;
      yield* svc.getNearbyTransit({ agencyId: "ttc", lat: 43.6709, lon: -79.3857, radius: 500 });
      yield* svc.getNearbyTransit({ agencyId: "ttc", lat: 43.6709, lon: -79.3857, radius: 500 });
    }).pipe(Effect.provide(layer));

    await Effect.runPromise(program);

    expect(snapshotCalls).toBe(1);
  });

  it("bbox selection feeds exactly the fuse input and preserves walkingMinutes ordering", async () => {
    const s1 = makeStop("s1", 43.67091, ["97"]);
    const s2 = makeStop("s2", 43.67092, ["97"]);
    // findNearbyStops returns pre-sorted by distance; NearbyTransit must keep that order for anchoring
    const nearby = [item(s1, 10), item(s2, 20)];
    const results = await getNearby(nearby, {
      arrivals: new Map([["s1", [makePrediction("s1", 0, NOW + 60_000)]]]),
    });
    expect(results[0].stopId).toBe("s1");
    expect(results[0].distanceMeters).toBe(10);
  });

  it("saved-transit distance ranking uses agency focus when rider fix is absent", async () => {
    const stops: SurfaceStop[] = [
      { id: "a", code: "a", name: "A", lat: 43.6532, lon: -79.3832, wheelchair: 1, routes: ["97"] },
      { id: "b", code: "b", name: "B", lat: 44.0, lon: -79.0, wheelchair: 1, routes: ["97"] },
    ];
    const results = await getSaved({ favouriteRoutes: ["97"] }, { stopsForRoutes: stops });
    // Agency focus is 43.6532,-79.3832 so stop A should anchor even without fix
    expect(results[0].stopId).toBe("a");
  });

  it("rejects when the storage data store fails — DB failure propagates", async () => {
    const failingStoreLayer = Layer.succeed(
      SurfaceDataStore,
      SurfaceDataStore.of({
        findNearbyStops: () => Effect.fail(new Error("db down")),
        getTripTerminals: () => Effect.succeed(new Map()),
        getDirectionsForTrips: () => Effect.succeed(new Map<string, number>()),
        getRouteDirectionIds: () => Effect.fail(new Error("db down")),
        getRouteDetails: () => Effect.fail(new Error("db down")),
        getRoute: () => Effect.fail(new Error("db down")),
        getAllRoutes: () => Effect.fail(new Error("db down")),
        getStopsForRoutes: () => Effect.fail(new Error("db down")),
        getStopsByIds: () => Effect.fail(new Error("db down")),
      }),
    );
    const program = Effect.gen(function* () {
      const svc = yield* NearbyTransit;
      return yield* svc.getNearbyTransit({ agencyId: "ttc", lat: 43.67, lon: -79.38, radius: 500 });
    }).pipe(
      Effect.provide(
        Layer.provide(
          NearbyTransitLive,
          Layer.mergeAll(
            failingStoreLayer,
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
                  Effect.succeed(emptyRealtimeSnapshot(agencyId)),
                getStopArrivals: () => Effect.succeed([]),
                getRouteVehicles: () => Effect.succeed([]),
                refreshOnce: Effect.void,
              }),
            ),
            Layer.succeed(
              NearbySnapshotSource,
              NearbySnapshotSource.of({ getSnapshot: Effect.succeed(emptySnapshot) }),
            ),
            ttcDefaults,
          ),
        ),
      ),
    );
    await expect(Effect.runPromise(program)).rejects.toThrow("db down");
  });
});

describe("NearbyTransit route alert and fallback paths", () => {
  it("keeps route stop scopes on the reversed-direction and raw-stop fallback paths", async () => {
    const requested: (RealtimeFetchOptions | undefined)[] = [];
    const source: RealtimeSource = {
      fetchRealtime: (_topology, options) => {
        requested.push(options);
        return Effect.succeed(emptyRealtimeSnapshot("ttc"));
      },
    };
    const oppositeDirection = makeDetails(
      1,
      ["c", "b", "a"].map((id) => makeStop(id, 43.67, ["97"])),
    );
    await getTracking("97", 0, {
      realtimeSource: source,
      routes: new Map([["97", route97]]),
      details: new Map([["97:1", Option.some(oppositeDirection)]]),
    });
    await getTracking("97", 0, {
      realtimeSource: source,
      routes: new Map([["97", route97]]),
      stopsForRoutes: [makeStop("raw-1", 43.67, ["97"]), makeStop("raw-2", 43.68, ["97"])],
    });

    expect(requested).toHaveLength(2);
    expect([...(requested[0]?.stopIdsByRoute?.get("97") ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect([...(requested[1]?.stopIdsByRoute?.get("97") ?? [])].sort()).toEqual(["raw-1", "raw-2"]);
  });

  it("shares one forty-request ceiling between route tracking alerts and Tmix realtime", async () => {
    const baseUrl = "https://anyride.example.test/api";
    const profile = { data: "tenant", display: "fictional" };
    const alertStops = Array.from({ length: 12 }, (_value, index) => ({
      stopId: "A" + index,
      routeIds: ["97"],
    }));
    const routeStops = Array.from({ length: 40 }, (_value, index) =>
      makeStop("R" + index, 43.6 + index / 10_000, ["97"]),
    );
    const topology: StaticSnapshot = {
      agencyId: "ttc",
      generatedAt: NOW,
      routes: [
        {
          routeId: "97",
          shortName: "97",
          longName: "Yonge",
          routeType: "bus",
          color: "#DA251D",
          textColor: "#FFFFFF",
          polyline: "",
          directionId: 0,
          headsign: "Steeles",
          stops: routeStops.map(({ id, name, lat, lon }) => ({ id, name, lat, lon })),
        },
      ],
    };
    const fleet = Array.from({ length: 40 }, (_value, index) => ({
      id: "bus-" + index,
      lineId: 7000007,
      line: "97",
      departure: { forecastTime: "2027-01-15T12:00:00Z" },
    }));
    const requests: { readonly url: string; readonly stopId?: string }[] = [];
    const fetch: typeof globalThis.fetch = (async (url, init) => {
      const requestUrl = String(url);
      if (requestUrl.includes("/GetVehiclePosition?")) {
        requests.push({ url: requestUrl });
        const callId = new URL(requestUrl).searchParams.get("callId") ?? "";
        return new Response(
          JSON.stringify({
            id: callId,
            timestamp: "2027-01-15T12:00:00Z",
            location: { lat: 43.67, lon: -79.38 },
          }),
        );
      }
      const body = JSON.parse(String(init?.body)) as {
        query: { fromStopAreaQuery: string };
      };
      const stopId = body.query.fromStopAreaQuery;
      requests.push({ url: requestUrl, stopId });
      return new Response(
        JSON.stringify({
          calls: stopId.startsWith("A") ? [] : fleet,
          messages: [],
        }),
      );
    }) as typeof globalThis.fetch;
    const alertSource = {
      type: "anyride-messages" as const,
      url: baseUrl,
      operatorPrefix: "70",
      profile,
      stops: alertStops,
    };
    const result = await getTracking("97", 0, {
      routes: new Map([["97", route97]]),
      details: new Map([["97:0", Option.some(makeDetails(0, routeStops))]]),
      topology,
      realtimeMaxSubrequestsWhenAlertsFetch: 28,
      realtimeSource: createGenericGtfsRealtimeSource({
        agencyId: "ttc",
        feeds: [
          { kind: "tmix_anyride", url: baseUrl, format: "json", operatorPrefix: "70", profile },
        ],
        fetch,
      }),
      snapshotGetter: (_locale, requestCache) =>
        fetchAgencyAlerts({
          agencyId: "ttc",
          sources: [alertSource],
          fetch,
          now: () => NOW,
          timeZone: "America/Toronto",
          hostingTarget: "self-hosted",
          requestCache,
          manifest: { alertInterpretation: { lineIds: ["97"] } },
        }),
    });

    expect(Option.isSome(result)).toBe(true);
    expect(requests).toHaveLength(40);
    expect(requests.filter(({ stopId }) => stopId?.startsWith("A"))).toHaveLength(12);
    expect(requests.filter(({ stopId }) => stopId?.startsWith("R"))).toHaveLength(14);
    expect(requests.filter(({ url }) => url.includes("/GetVehiclePosition?"))).toHaveLength(14);
  });

  it("requests the rider locale for route-tracking alert snapshots", async () => {
    const requestedLocales: UiLocale[] = [];
    await getTracking(
      "900",
      0,
      {
        routes: new Map([["900", route97]]),
        snapshotGetter: (locale) =>
          Effect.sync(() => {
            if (locale) requestedLocales.push(locale);
            return emptySnapshot;
          }),
      },
      "fr-CA",
    );

    expect(requestedLocales).toEqual(["fr-CA"]);
  });

  it("merges nearby stops, live arrivals, and matching route alerts", async () => {
    const stop = makeStop("s-97", 43.6709, ["97"]);
    const results = await getNearby([item(stop, 100)], {
      routes: new Map([["97", route97]]),
      arrivals: new Map([["s-97", [makePrediction("s-97", 0, NOW + 180_000)]]]),
      snapshot: {
        ...emptySnapshot,
        alerts: [
          makeAgencyAlert({
            id: "alert_97_yonge_delays",
            title: "97 Yonge: Construction Delays",
          }),
        ],
      },
    });

    expect(results).toHaveLength(1);
    expect(results[0].routeId).toBe("97");
    expect(results[0].stopName).toBe("Stop s-97");
    expect(results[0].arrivals).toEqual([NOW + 180_000]);
    expect(results[0].alerts).toHaveLength(1);
  });

  it("populates alerts on the fallback tracking path when a route has no shapes", async () => {
    const route900: SurfaceRoute = {
      id: "900",
      shortName: "900",
      longName: "Airport Express",
      routeType: "bus",
      color: "#DA251D",
      textColor: "#FFFFFF",
    };
    const stop900 = makeStop("s-900", 43.65, ["900"]);
    const result = await getTracking("900", 0, {
      routes: new Map([["900", route900]]),
      stopsForRoutes: [stop900],
      snapshot: {
        ...emptySnapshot,
        alerts: [
          makeAgencyAlert({
            id: "alert_900_congestion",
            title: "900 Airport Express: Congestion delays",
          }),
        ],
      },
    });

    expect(Option.isSome(result)).toBe(true);
    const tracking = Option.getOrThrow(result);
    expect(tracking.shape.polyline).toBe("");
    expect(tracking.stops.map((stop) => stop.id)).toEqual(["s-900"]);
    expect(tracking.alerts).toHaveLength(1);
  });

  it("returns route stops on the fallback path regardless of distance from Toronto", async () => {
    const farStop: SurfaceStop = {
      ...makeStop("s-990", 44, ["990"]),
      lon: -80.6,
      name: "Far Away Terminal",
    };
    const route990: SurfaceRoute = {
      id: "990",
      shortName: "990",
      longName: "Nowhere Express",
      routeType: "bus",
      color: "#DA251D",
      textColor: "#FFFFFF",
    };
    const result = await getTracking("990", 0, {
      routes: new Map([["990", route990]]),
      stopsForRoutes: [farStop],
    });

    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrThrow(result).stops.map((stop) => stop.id)).toContain("s-990");
  });

  it.each([
    {
      name: "when no snapshot alert matches the route",
      snapshot: {
        ...emptySnapshot,
        alerts: [makeAgencyAlert({ title: "506 Carlton: Short turn at Dundas West" })],
      },
    },
    { name: "when the snapshot has no alerts", snapshot: emptySnapshot },
  ])("returns no alerts $name", async ({ snapshot }) => {
    const result = await getTracking("97", 0, {
      routes: new Map([["97", route97]]),
      snapshot,
    });

    expect(Option.isSome(result)).toBe(true);
    expect(Option.getOrThrow(result).alerts).toEqual([]);
  });

  it("resolves route tracking with empty alerts when the snapshot fails", async () => {
    const result = await getTracking("97", 0, {
      routes: new Map([["97", route97]]),
      snapshotFails: true,
    });

    expect(Option.isSome(result)).toBe(true);
    const tracking = Option.getOrThrow(result);
    expect(tracking.route.id).toBe("97");
    expect(tracking.alerts).toEqual([]);
  });
});

describe("NearbyTransit getRouteTracking direction-label delegation (single resolve site)", () => {
  const stubDetails = (directionId: number): RouteDetails => ({
    route: {
      id: "97",
      shortName: "97",
      longName: "Yonge",
      routeType: "bus",
      color: "#DA251D",
      textColor: "#FFFFFF",
    },
    shape: {
      id: `97_${directionId}_stub`,
      routeId: "97",
      directionId,
      headsign:
        directionId === 0 ? "North — 97 Yonge to Steeles Ave" : "South — 97 Yonge to Queens Quay",
      polyline: "",
      minLat: 43.64,
      maxLat: 43.795,
      minLon: -79.42,
      maxLon: -79.37,
      pointCount: 2,
    },
    stops: [],
  });

  it("names the route's stops to the realtime source, which a per-stop vendor needs to find vehicles", async () => {
    const requested: (RealtimeFetchOptions | undefined)[] = [];
    const source: RealtimeSource = {
      fetchRealtime: (_topology, options) => {
        requested.push(options);
        return Effect.succeed({ agencyId: "ttc", updatedAt: NOW, vehicles: [], arrivals: [] });
      },
    };
    const withStops = (directionId: number, ids: string[]): RouteDetails => ({
      ...stubDetails(directionId),
      stops: ids.map((id, sequence) => ({ ...makeStop(id, 43.67, ["97"]), sequence })),
    });

    await getTracking("97", 0, {
      realtimeSource: source,
      details: new Map([
        ["97:0", Option.some(withStops(0, ["a", "b"]))],
        ["97:1", Option.some(withStops(1, ["b", "c"]))],
      ]),
    });

    expect(requested).toHaveLength(1);
    expect([...(requested[0]?.stopIdsByRoute?.get("97") ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect(requested[0]?.stopIds).toBeUndefined();
  });

  it.each([{ ids: [0] }, { ids: [0, 2] }])(
    "exposes only feed-declared directions $ids with their headsigns",
    async ({ ids }) => {
      const result = await getTracking("97", 0, {
        details: new Map(
          ids.map((id) => [
            `97:${id}`,
            Option.some({
              ...stubDetails(id),
              shape: { ...stubDetails(id).shape, headsign: `Terminal ${id}` },
            }),
          ]),
        ),
      });
      const data = Option.getOrThrow(result);
      expect(data.availableDirectionIds).toEqual(ids);
      for (const id of ids) expect(data.directionLabels?.[id]?.destination).toBe(`Terminal ${id}`);
    },
  );

  it("surfaces directionLabels derived through buildDirectionLabels from stored headsigns", async () => {
    const result = await getTracking("97", 0, {
      details: new Map([
        ["97:0", Option.some(stubDetails(0))],
        ["97:1", Option.some(stubDetails(1))],
      ]),
    });
    expect(Option.isSome(result)).toBe(true);
    const tracking = Option.getOrThrow(result);
    expect(tracking.directionLabels?.[0]).toEqual({
      label: "Northbound",
      destination: "Steeles Ave",
    });
    expect(tracking.directionLabels?.[1]).toEqual({
      label: "Southbound",
      destination: "Queens Quay",
    });
  });

  it("returns static tracking data when the vehicle feed is unavailable", async () => {
    const result = await getTracking("97", 0, {
      details: new Map([["97:0", Option.some(stubDetails(0))]]),
      vehiclesError: new Error("GO API key unavailable"),
    });

    expect(Option.isSome(result)).toBe(true);
    const tracking = Option.getOrThrow(result);
    expect(tracking.stops).toEqual([]);
    expect(tracking.vehicles).toEqual([]);
  });

  it("returns Option.none for unknown route", async () => {
    const result = await getTracking("does-not-exist", 0);
    expect(Option.isNone(result)).toBe(true);
  });
});

describe("NearbyTransit agency-scoped isolation", () => {
  const makeAgencyIsolationLayer = (agencyId: string, predictedTime: number) => {
    const stop = makeStop("shared", 43.67, ["1"]);
    const route: SurfaceRoute = {
      id: "1",
      shortName: "1",
      longName: "One",
      routeType: "bus",
      color: "#000",
      textColor: "#fff",
    };
    const arrival = { ...makePrediction("shared", 0, predictedTime), routeId: "1" };

    const storeLayer = Layer.succeed(
      SurfaceDataStore,
      SurfaceDataStore.of({
        getRoute: (routeId) => Effect.succeed(routeId === "1" ? Option.some(route) : Option.none()),
        getTripTerminals: () => Effect.succeed(new Map()),
        getDirectionsForTrips: () => Effect.succeed(new Map<string, number>()),
        getRouteDirectionIds: () => Effect.succeed([0]),
        getRouteDetails: () => Effect.succeed(Option.none()),
        getAllRoutes: () => Effect.succeed([route]),
        getStopsForRoutes: () => Effect.succeed([stop]),
        getStopsByIds: () => Effect.succeed([]),
        findNearbyStops: () => Effect.succeed([item(stop, 50)]),
      }),
    );

    const repositoryLayer = Layer.succeed(
      NearbyRealtimeState,
      NearbyRealtimeState.of({
        getState: Effect.succeed({
          generatedAt: NOW,
          feedTimestamp: NOW,
          stopArrivals: new Map([["shared", [arrival]]]),
          activeTripCount: 1,
          etags: {},
        }),
        isArrivalsStale: Effect.succeed(false),
        getRealtimeSnapshot: (requestedAgencyId: string) =>
          Effect.succeed(emptyRealtimeSnapshot(requestedAgencyId)),
        getStopArrivals: (input: { agencyId: string; stopId: string }) =>
          input.agencyId === agencyId
            ? Effect.succeed(input.stopId === "shared" ? [arrival] : [])
            : Effect.fail(new Error(`wrong repository for ${input.agencyId}`)),
        getRouteVehicles: () => Effect.succeed([]),
        refreshOnce: Effect.void,
      }),
    );

    const snapshotLayer = Layer.succeed(
      NearbySnapshotSource,
      NearbySnapshotSource.of({
        getSnapshot: Effect.succeed({ ...emptySnapshot, agencyId }),
      }),
    );
    const defaultsLayer = Layer.succeed(SurfaceAgencyDefaults, {
      agencyId,
      focus: { lat: 43.67, lon: -79.3857 },
      fallbackBounds: { minLat: 43.5, maxLat: 44, minLon: -80, maxLon: -79 },
    });

    return Layer.provide(
      NearbyTransitLive,
      Layer.mergeAll(storeLayer, repositoryLayer, snapshotLayer, defaultsLayer),
    );
  };

  const getAgencyArrivals = (agencyId: string, predictedTime: number) => {
    const program = Effect.gen(function* () {
      const service = yield* NearbyTransit;
      return yield* service.getNearbyTransit({
        agencyId,
        lat: 43.67,
        lon: -79.3857,
        radius: 500,
      });
    }).pipe(Effect.provide(makeAgencyIsolationLayer(agencyId, predictedTime)));
    return Effect.runPromise(program);
  };

  it("keeps arrivals isolated when two agencies use separate request, layer, and repository paths", async () => {
    const ttcResults = await getAgencyArrivals("ttc", NOW + 60_000);
    const goResults = await getAgencyArrivals("go", NOW + 120_000);

    expect(ttcResults).toHaveLength(1);
    expect(ttcResults[0].agencyId).toBe("ttc");
    expect(ttcResults[0].arrivals).toEqual([NOW + 60_000]);
    expect(goResults).toHaveLength(1);
    expect(goResults[0].agencyId).toBe("go");
    expect(goResults[0].arrivals).toEqual([NOW + 120_000]);
  });
});
