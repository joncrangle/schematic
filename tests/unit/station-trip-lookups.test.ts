import { afterEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { selectStationTripLookups } from "~/services/stationTripLookups";
import { logger } from "~/infrastructure/logging/logger";

// The D1 memo is per isolate, so each case gets its own agency to start cold.
let agencySeq = 0;
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const trip = (routeId: string, directionId = 0) => ({ routeId, directionId });
type Trips = Record<string, { routeId: string; directionId: number }>;

function fakes(
  hasTripIdentities: boolean,
  indexed: Trips | "unavailable",
  database: Trips = {},
  terminals: Record<string, string> = {},
) {
  const staticRoutes = vi.fn((ids: readonly string[]) =>
    indexed === "unavailable"
      ? Effect.fail(new Error("unavailable"))
      : Effect.succeed(new Map(ids.flatMap((id) => (indexed[id] ? [[id, indexed[id]!]] : [])))),
  );
  const store = {
    getRoutesForTrips: vi.fn((ids: readonly string[]) =>
      Effect.succeed(new Map(ids.flatMap((id) => (database[id] ? [[id, database[id]!]] : [])))),
    ),
    getDirectionsForTrips: vi.fn((routeId: string, ids: readonly string[]) =>
      Effect.succeed(
        new Map(
          ids.flatMap((id) =>
            database[id]?.routeId === routeId ? [[id, database[id]!.directionId]] : [],
          ),
        ),
      ),
    ),
    getTripTerminals: vi.fn((_routeId: string, ids: readonly string[]) =>
      Effect.succeed(
        new Map(
          ids.flatMap((id) =>
            terminals[id] ? [[id, { stopId: terminals[id]!, stopSequence: 9 }]] : [],
          ),
        ),
      ),
    ),
  };
  const lookups = selectStationTripLookups(
    `agency-${++agencySeq}`,
    { hasTripIdentities, getRoutesForTrips: staticRoutes },
    Effect.succeed(store),
  );
  return { lookups, staticRoutes, store };
}

describe("trip routes", () => {
  it("skips the database when the index covers every trip", async () => {
    const { lookups, store } = fakes(true, { a: trip("r"), b: trip("r", 1) });
    const result = await Effect.runPromise(lookups.getRoutesForTrips(["a", "b"]));
    expect(Object.fromEntries(result)).toEqual({ a: trip("r"), b: trip("r", 1) });
    expect(store.getRoutesForTrips).not.toHaveBeenCalled();
  });

  it("resolves only the trips missing from the index in the database", async () => {
    const { lookups, store } = fakes(true, { a: trip("r") }, { b: trip("r", 1) });
    const result = await Effect.runPromise(lookups.getRoutesForTrips(["a", "b"]));
    expect(store.getRoutesForTrips).toHaveBeenCalledWith(["b"]);
    expect(Object.fromEntries(result)).toEqual({ a: trip("r"), b: trip("r", 1) });
  });

  it("resolves every trip in the database when the index is unavailable", async () => {
    const { lookups, store } = fakes(true, "unavailable", { a: trip("r") });
    const result = await Effect.runPromise(lookups.getRoutesForTrips(["a", "b"]));
    expect(store.getRoutesForTrips).toHaveBeenCalledWith(["a", "b"]);
    expect(Object.fromEntries(result)).toEqual({ a: trip("r") });
  });

  it("uses only the database without a deployed trip index", async () => {
    const { lookups, staticRoutes, store } = fakes(false, {}, { a: trip("r") });
    await Effect.runPromise(lookups.getRoutesForTrips(["a"]));
    expect(store.getRoutesForTrips).toHaveBeenCalledWith(["a"]);
    expect(staticRoutes).not.toHaveBeenCalled();
  });
});

describe("trip directions", () => {
  it("skips the database when the index covers every trip, even on other routes", async () => {
    const { lookups, store } = fakes(true, { a: trip("r", 1), b: trip("other") });
    const result = await Effect.runPromise(lookups.getDirectionsForTrips("r", ["a", "b"]));
    expect(Object.fromEntries(result)).toEqual({ a: 1 });
    expect(store.getDirectionsForTrips).not.toHaveBeenCalled();
  });

  it("resolves only the trips missing from the index in the database", async () => {
    const { lookups, store } = fakes(true, { a: trip("r", 1) }, { b: trip("r") });
    const result = await Effect.runPromise(lookups.getDirectionsForTrips("r", ["a", "b"]));
    expect(store.getDirectionsForTrips).toHaveBeenCalledWith("r", ["b"]);
    expect(Object.fromEntries(result)).toEqual({ a: 1, b: 0 });
  });

  it("resolves every trip in the database when the index is unavailable", async () => {
    const { lookups, store } = fakes(true, "unavailable", { a: trip("r", 1) });
    const result = await Effect.runPromise(lookups.getDirectionsForTrips("r", ["a", "b"]));
    expect(store.getDirectionsForTrips).toHaveBeenCalledWith("r", ["a", "b"]);
    expect(Object.fromEntries(result)).toEqual({ a: 1 });
  });

  it("uses only the database without a deployed trip index", async () => {
    const { lookups, staticRoutes, store } = fakes(false, {}, { a: trip("r") });
    await Effect.runPromise(lookups.getDirectionsForTrips("r", ["a"]));
    expect(store.getDirectionsForTrips).toHaveBeenCalledWith("r", ["a"]);
    expect(staticRoutes).not.toHaveBeenCalled();
  });
});

describe("trip terminals", () => {
  it("resolves terminals in the database and answers repeat polls from memory", async () => {
    const { lookups, store } = fakes(true, { a: trip("r") }, {}, { a: "end", b: "end" });
    const first = await Effect.runPromise(lookups.getTripTerminals("r", ["a"]));
    expect(first.get("a")?.stopId).toBe("end");
    await Effect.runPromise(lookups.getTripTerminals("r", ["a"]));
    expect(store.getTripTerminals).toHaveBeenCalledTimes(1);
  });

  it("queries only the trip ids it has not answered", async () => {
    const { lookups, store } = fakes(true, {}, {}, { a: "end", b: "end" });
    await Effect.runPromise(lookups.getTripTerminals("r", ["a"]));
    const result = await Effect.runPromise(lookups.getTripTerminals("r", ["a", "b"]));
    expect(store.getTripTerminals).toHaveBeenLastCalledWith("r", ["b"]);
    expect([...result.keys()]).toEqual(["a", "b"]);
  });

  it("remembers a trip the database does not know", async () => {
    const { lookups, store } = fakes(true, {});
    await Effect.runPromise(lookups.getTripTerminals("r", ["ghost"]));
    const result = await Effect.runPromise(lookups.getTripTerminals("r", ["ghost"]));
    expect(result.size).toBe(0);
    expect(store.getTripTerminals).toHaveBeenCalledTimes(1);
  });

  it("refetches after the memo expires", async () => {
    vi.useFakeTimers();
    const { lookups, store } = fakes(true, {}, {}, { a: "end" });
    await Effect.runPromise(lookups.getTripTerminals("r", ["a"]));
    vi.advanceTimersByTime(60 * 60 * 1000 + 1);
    await Effect.runPromise(lookups.getTripTerminals("r", ["a"]));
    expect(store.getTripTerminals).toHaveBeenCalledTimes(2);
  });
});

describe("database miss memo", () => {
  it("answers repeat route and direction misses from memory", async () => {
    const { lookups, store } = fakes(true, {}, { a: trip("r", 1) });
    for (let i = 0; i < 2; i++) {
      await Effect.runPromise(lookups.getRoutesForTrips(["a"]));
      await Effect.runPromise(lookups.getDirectionsForTrips("r", ["a"]));
    }
    expect(store.getRoutesForTrips).toHaveBeenCalledTimes(1);
    expect(store.getDirectionsForTrips).toHaveBeenCalledTimes(1);
  });

  it("rechecks a trip the database does not know after two minutes, but keeps a known one for the hour", async () => {
    vi.useFakeTimers();
    const { lookups, store } = fakes(true, {}, { known: trip("r") });
    await Effect.runPromise(lookups.getRoutesForTrips(["known", "ghost"]));
    vi.advanceTimersByTime(120 * 1000 + 1);
    await Effect.runPromise(lookups.getRoutesForTrips(["known", "ghost"]));
    expect(store.getRoutesForTrips).toHaveBeenCalledTimes(2);
    expect(store.getRoutesForTrips).toHaveBeenLastCalledWith(["ghost"]);
  });

  it("does not remember a failed database read", async () => {
    const { lookups, store } = fakes(true, {}, { a: trip("r") });
    store.getRoutesForTrips.mockReturnValueOnce(Effect.fail(new Error("d1 down")) as never);
    await expect(Effect.runPromise(lookups.getRoutesForTrips(["a"]))).rejects.toThrow();
    const result = await Effect.runPromise(lookups.getRoutesForTrips(["a"]));
    expect(result.get("a")).toEqual(trip("r"));
  });
});

describe("index failure logging", () => {
  it("warns with the agency when the index fails and falls back to D1", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const { lookups } = fakes(true, "unavailable", { a: trip("r") });
    await Effect.runPromise(lookups.getRoutesForTrips(["a"]));
    await Effect.runPromise(lookups.getRoutesForTrips(["b"]));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[1]).toMatchObject({ agencyId: expect.stringMatching(/^agency-/) });
  });
});
