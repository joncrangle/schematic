import { beforeEach, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

// The D1 memo is module-global per agency, so each case runs as its own clone of a fixture agency.
const { CASE_AGENCY_COUNT, caseAgencyId } = vi.hoisted(() => ({
  CASE_AGENCY_COUNT: 8,
  caseAgencyId: (index: number) => `sample-case-${index}`,
}));
vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  const sample = testAgencyCatalog.find((agency) => agency.manifest.id === "sample")!;
  return {
    agencyCatalog: [
      ...testAgencyCatalog,
      ...Array.from({ length: CASE_AGENCY_COUNT }, (_, index) => ({
        ...sample,
        manifest: { ...sample.manifest, id: caseAgencyId(index) },
      })),
    ],
  };
});

const captured = vi.hoisted(() => ({
  contexts: [] as { getRoutesForTrips?: unknown }[],
  identities: {
    hasTripIdentities: true,
    getRoutesForTrips: undefined as unknown,
    getDirectionsForTrips: undefined as unknown,
  },
}));
vi.mock("~/services/AgencyRuntimeServer", () => ({
  createServerAgencyRuntime: (
    _provider: unknown,
    context: { getRoutesForTrips?: unknown } = {},
  ) => {
    captured.contexts.push(context);
    return {
      getRealtimeSource: () => ({}),
      getSnapshot: () => Promise.reject(new Error("unused")),
    };
  },
}));
vi.mock("~/services/AlertIdentityServer", () => ({
  getAlertIdentityLookups: () => captured.identities,
}));

import { SurfaceDataStore } from "~/infrastructure/storage/SurfaceDataStore";
import { makeLiveSurfaceTransitLayer } from "~/services/surface/SurfaceTransit";

const route = { routeId: "r", directionId: 0 };
const staticRoutes = vi.fn((ids: readonly string[]) =>
  ids.includes("fail")
    ? Effect.fail(new Error("unavailable"))
    : Effect.succeed(new Map(ids.filter((id) => id.startsWith("s")).map((id) => [id, route]))),
);
const storeRoutes = vi.fn((ids: readonly string[]) =>
  Effect.succeed(new Map(ids.map((id) => [id, route]))),
);

async function realtimeLookup(hasTripIdentities: boolean, withStoreLookup = true) {
  const agencyId = caseAgencyId(caseIndex);
  captured.contexts.length = 0;
  captured.identities = {
    hasTripIdentities,
    getRoutesForTrips: staticRoutes,
    getDirectionsForTrips: vi.fn(),
  };
  const store = SurfaceDataStore.of({
    ...(withStoreLookup ? { getRoutesForTrips: storeRoutes } : {}),
  } as never);
  await Effect.runPromise(
    Effect.scoped(
      Layer.build(
        makeLiveSurfaceTransitLayer(agencyId, {
          storeLayer: Layer.succeed(SurfaceDataStore, store),
        }),
      ),
    ),
  );
  return captured.contexts.find((context) => "getRoutesForTrips" in context)?.getRoutesForTrips as
    | ((ids: readonly string[]) => Effect.Effect<unknown>)
    | undefined;
}

let caseIndex = -1;
beforeEach(() => {
  caseIndex += 1;
  expect(caseIndex).toBeLessThan(CASE_AGENCY_COUNT);
  staticRoutes.mockClear();
  storeRoutes.mockClear();
});

it("resolves realtime trip routes from the deployed trip index without the database when it covers them", async () => {
  const lookup = await realtimeLookup(true);
  await Effect.runPromise(lookup!(["s1"]));
  expect(staticRoutes).toHaveBeenCalledWith(["s1"]);
  expect(storeRoutes).not.toHaveBeenCalled();
});

it("resolves only trips missing from the deployed trip index in the database", async () => {
  const lookup = await realtimeLookup(true);
  const result = (await Effect.runPromise(lookup!(["s1", "new"]))) as ReadonlyMap<string, unknown>;
  expect(storeRoutes).toHaveBeenCalledWith(["new"]);
  expect([...result.keys()]).toEqual(["s1", "new"]);
});

it("resolves every trip in the database when the deployed trip index is unavailable", async () => {
  const lookup = await realtimeLookup(true);
  await Effect.runPromise(lookup!(["fail", "s1"]));
  expect(storeRoutes).toHaveBeenCalledWith(["fail", "s1"]);
});

it("falls back to the database trip routes without a deployed trip index", async () => {
  const lookup = await realtimeLookup(false);
  await Effect.runPromise(lookup!(["t"]));
  expect(storeRoutes).toHaveBeenCalledWith(["t"]);
  expect(staticRoutes).not.toHaveBeenCalled();
});

it("supplies no trip lookup when neither the index nor the store can resolve trips", async () => {
  expect(await realtimeLookup(false, false)).toBeUndefined();
});
