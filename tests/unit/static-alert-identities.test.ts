import { expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { compileAlertIdentityArtifacts } from "../../scripts/lib/alert-identity-artifacts";
import { createStaticAlertIdentityResolver } from "~/infrastructure/alerts/staticAlertIdentities";
import { alertTripBucket } from "~/infrastructure/alerts/alertIdentityArtifacts";

import { makeTestProvider } from "../helpers/agency-fixtures";
import { encodeFeed, encodeAlertEntity } from "../helpers/gtfs-rt-binary";

const topology = {
  routes: [{ id: "route-a", short_name: "A" }],
  stops: [
    { id: "stop-a", code: "123" },
    { id: "parent", code: null },
  ],
  route_shapes: [{ route_id: "route-a", direction_id: 1, headsign: "South" }],
  route_direction_trips: [
    { route_id: "route-a", direction_id: 1, trip_ids: JSON.stringify(["trip-a", "trip-b"]) },
  ],
};
function fixture() {
  const { reference, files } = compileAlertIdentityArtifacts("sample", topology, {
    scope: true,
    trips: true,
  });
  const read = vi.fn(
    async (path: string) =>
      new Response(files.get(path) ?? "missing", { status: files.has(path) ? 200 : 404 }),
  );
  const resolve = createStaticAlertIdentityResolver({
    catalog: {
      version: 1,
      agencies: { sample: { sourceHash: "source", generation: "a".repeat(64), ...reference } },
    },
    readAsset: read,
  });
  return { resolve, read, files };
}
it("resolves scoped stop codes, route names and directions from immutable artifacts without database access", async () => {
  const { resolve, read } = fixture();
  const first = await Effect.runPromise(resolve("sample").getSourceAgencyScope());
  const second = await Effect.runPromise(resolve("sample").getSourceAgencyScope());
  expect([...first.routeIds]).toEqual(["route-a"]);
  expect([...first.stopIds]).toEqual(["parent", "stop-a"]);
  expect(first.routesByShortName?.get("A")).toEqual(["route-a"]);
  expect(first.stopsByCode?.get("123")).toEqual(["stop-a"]);
  expect(first.directionsByRoute?.get("route-a|south")).toBe(1);
  expect(second).toBe(first);
  expect(read).toHaveBeenCalledTimes(1);
});
it("loads only necessary trip shards, keeps missing trips unknown, and reuses loaded shards", async () => {
  const { resolve, read } = fixture();
  const lookup = resolve("sample").getRoutesForTrips;
  expect([...(await Effect.runPromise(lookup([])))]).toEqual([]);
  expect(read).not.toHaveBeenCalled();
  const trips = await Effect.runPromise(lookup(["trip-a", "missing"]));
  expect(trips.get("trip-a")).toEqual({ routeId: "route-a", directionId: 1 });
  expect(trips.has("missing")).toBe(false);
  await Effect.runPromise(lookup(["trip-a"]));
  expect(read.mock.calls.map(([path]) => path)).toEqual([
    expect.stringContaining(`trips-${alertTripBucket("trip-a")}-`),
  ]);
});
it("retries failed artifact reads and rejects corrupted content instead of returning empty scope", async () => {
  const { resolve, read } = fixture();
  read.mockResolvedValueOnce(new Response("bad"));
  await expect(Effect.runPromise(resolve("sample").getSourceAgencyScope())).rejects.toThrow();
  expect(
    (await Effect.runPromise(resolve("sample").getSourceAgencyScope())).routeIds.has("route-a"),
  ).toBe(true);
  expect(read).toHaveBeenCalledTimes(2);
});
it("refuses missing artifact generations without inventing membership", async () => {
  const { resolve } = fixture();
  await expect(Effect.runPromise(resolve("missing").getSourceAgencyScope())).rejects.toThrow();
});
it("drops ambiguous static cardinal directions", () => {
  const { files } = compileAlertIdentityArtifacts(
    "sample",
    {
      ...topology,
      route_shapes: [
        ...topology.route_shapes,
        { route_id: "route-a", direction_id: 0, headsign: "South" },
      ],
    },
    { scope: true, trips: false },
  );
  expect(JSON.parse([...files.values()][0]!).directions).toEqual([]);
});

it("shares concurrent reads without turning a missing asset into a successful empty result", async () => {
  const { resolve, read } = fixture();
  const lookup = resolve("sample").getSourceAgencyScope;
  const scopes = await Promise.all([Effect.runPromise(lookup()), Effect.runPromise(lookup())]);
  expect(scopes[0]).toBe(scopes[1]);
  expect(read).toHaveBeenCalledTimes(1);
});
it("produces the same artifact identity after input rows are reordered", () => {
  const first = compileAlertIdentityArtifacts("sample", topology, { scope: true, trips: true });
  const second = compileAlertIdentityArtifacts(
    "sample",
    { ...topology, stops: [...topology.stops].reverse() },
    { scope: true, trips: true },
  );
  expect(second.reference).toEqual(first.reference);
  expect(second.files).toEqual(first.files);
});

it("uses the server ASSETS binding when the transit database is quota blocked", async () => {
  const { reference, files } = compileAlertIdentityArtifacts("sample", topology, {
    scope: true,
    trips: true,
  });
  const prepare = vi.fn(() => {
    throw new Error("D1 daily quota");
  });
  const fetch = vi.fn(
    async (request: Request) => new Response(files.get(new URL(request.url).pathname)),
  );
  vi.doMock("~/generated/alert-identities.json", () => ({
    default: {
      version: 1,
      agencies: { sample: { sourceHash: "source", generation: "b".repeat(64), ...reference } },
    },
  }));
  vi.stubGlobal("env", { ASSETS: { fetch }, DB_TRANSIT: { prepare } });
  try {
    const { createServerAgencyRuntime } = await import("~/services/AgencyRuntimeServer");
    const now = 1_800_000_000_000;
    const feed = encodeFeed(now / 1000, [
      encodeAlertEntity({ id: "trip-alert", selectors: [{ tripId: "trip-a" }], effect: 1 }),
    ]);
    const snapshot = await createServerAgencyRuntime(
      makeTestProvider({ staticTopology: { source: "seed", sourceAgencyIds: ["operator-a"] } }),
      {
        fetch: vi.fn(async () => new Response(new Uint8Array(feed))),
        now: () => now,
      },
    ).getSnapshot();
    expect(snapshot.freshness).toBe("live");
    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.affectedRouteIds).toEqual(["route-a"]);
    expect(prepare).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(2);
  } finally {
    vi.unstubAllGlobals();
    vi.doUnmock("~/generated/alert-identities.json");
  }
});

function concurrentAssets() {
  const files = new Map<string, string>();
  const agencies: Record<string, unknown> = {};
  for (let i = 0; i < 5; i++) {
    const id = `sample-${i}`;
    const artifact = compileAlertIdentityArtifacts(id, topology, { scope: true, trips: false });
    agencies[id] = { sourceHash: "source", generation: "a".repeat(64), ...artifact.reference };
    for (const [path, text] of artifact.files) files.set(path, text);
  }
  return { files, catalog: { version: 1, agencies } };
}

it("limits asset reads across simultaneous agency lookups", async () => {
  const { files, catalog } = concurrentAssets();
  const finish: (() => void)[] = [];
  const read = vi.fn(
    (path: string) =>
      new Promise<Response>((resolve) => {
        finish.push(() => resolve(new Response(files.get(path))));
      }),
  );
  const resolve = createStaticAlertIdentityResolver({
    catalog,
    readAsset: read,
  });
  const results = Object.keys(catalog.agencies).map((id) =>
    Effect.runPromise(resolve(id).getSourceAgencyScope()),
  );
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
  finish[0]!();
  await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(5));
  finish.forEach((done) => done());
  expect((await Promise.all(results)).every((scope) => scope.routeIds.has("route-a"))).toBe(true);
});

it("cancels timed-out body streams before allowing another batch of reads", async () => {
  vi.useFakeTimers();
  try {
    const { catalog } = concurrentAssets();
    let active = 0,
      maxActive = 0;
    const stopped: (() => void)[] = [];
    const read = vi.fn(
      async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start() {
              active++;
              maxActive = Math.max(maxActive, active);
            },
            pull: () => new Promise<void>(() => {}),
            cancel() {
              return new Promise<void>((resolve) =>
                stopped.push(() => {
                  active--;
                  resolve();
                }),
              );
            },
          }),
        ),
    );
    const resolve = createStaticAlertIdentityResolver({ catalog, readAsset: read });
    const run = () =>
      Promise.allSettled(
        Object.keys(catalog.agencies).map((id) =>
          Effect.runPromise(resolve(id).getSourceAgencyScope()),
        ),
      );
    const first = run();
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(4));
    await vi.advanceTimersByTimeAsync(5000);
    expect((await first).every((result) => result.status === "rejected")).toBe(true);
    expect(active).toBe(4);
    const before = read.mock.calls.length;
    const second = run();
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(before);
    stopped.splice(0).forEach((finish) => finish());
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(before + 4));
    await vi.advanceTimersByTimeAsync(5000);
    await second;
    expect(active).toBe(4);
    stopped.splice(0).forEach((finish) => finish());
    await vi.advanceTimersByTimeAsync(0);
    expect(active).toBe(0);
    expect(maxActive).toBe(4);
  } finally {
    vi.useRealTimers();
  }
});
it("serves per-route trip directions from the same trip shards and reports trip coverage", async () => {
  const { resolve, read } = fixture();
  const lookups = resolve("sample");
  expect(lookups.hasTripIdentities).toBe(true);
  const directions = await Effect.runPromise(
    lookups.getDirectionsForTrips("route-a", ["trip-a", "trip-b", "missing"]),
  );
  expect([...directions]).toEqual([
    ["trip-a", 1],
    ["trip-b", 1],
  ]);
  expect(
    (await Effect.runPromise(lookups.getDirectionsForTrips("other-route", ["trip-a"]))).size,
  ).toBe(0);
  expect(read.mock.calls.length).toBeLessThanOrEqual(2);
});
it("reports no trip coverage for agencies generated without trip shards", () => {
  const { reference } = compileAlertIdentityArtifacts("sample", topology, {
    scope: true,
    trips: false,
  });
  const resolve = createStaticAlertIdentityResolver({
    catalog: {
      version: 1,
      agencies: { sample: { sourceHash: "source", generation: "a".repeat(64), ...reference } },
    },
    readAsset: vi.fn(),
  });
  expect(resolve("sample").hasTripIdentities).toBe(false);
  expect(resolve("unknown").hasTripIdentities).toBe(false);
});
