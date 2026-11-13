import { Effect } from "effect";
import { expect, it, vi } from "vitest";
import type { AgencyProvider } from "~/agencies";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import { refreshScheduledTopologies } from "~/services/surface/SurfaceTopologyRefresh";
import { assignTopologyWeekdays } from "~/services/surface/SurfaceTopologyScheduler";

function seededBinding(): D1DatabaseBinding {
  const statement = {
    bind: () => statement,
    all: async () => ({ success: true, results: [{ name: "routes" }] }),
    first: async () => ({ id: "r" }),
  };
  return { prepare: () => statement } as unknown as D1DatabaseBinding;
}

function provider(id: string, sync: () => Promise<void>, fresh = false): AgencyProvider {
  return {
    manifest: { id },
    staticTopology: { source: "seed" },
    createTopologySource: () => ({
      fetchTopology: () => Effect.die("no request reads in background refresh"),
      shouldRefreshTopology: () => Effect.succeed(!fresh),
      syncTopology: () => Effect.tryPromise({ try: sync, catch: (cause) => cause }),
    }),
  } as unknown as AgencyProvider;
}

it("sequences assigned agencies, isolates a failure and leaves other weekdays and NextBus alone", async () => {
  const ids = Array.from({ length: 15 }, (_, i) => `sample-${i}`);
  const schedule = assignTopologyWeekdays(ids),
    day = schedule.get(ids[0])!;
  const due = ids.filter((id) => schedule.get(id) === day);
  expect(due.length).toBeGreaterThanOrEqual(2);
  const calls: string[] = [];
  const providers = ids.map((id) =>
    provider(id, async () => {
      calls.push(id);
      if (id === due[0]) throw new Error("parse failed");
    }),
  );
  providers.push({
    ...provider("live", async () => {
      throw new Error("NextBus must remain untouched");
    }),
    staticTopology: { source: "nextbus" },
  });
  const resolveBinding = vi.fn(async () => seededBinding());
  const time = Date.parse("2026-09-27T04:00:00Z") + day * 86400_000;
  const result = await refreshScheduledTopologies(time, {
    providers: () => providers,
    resolveBinding,
  });
  expect(calls).toEqual(due);
  expect(result).toMatchObject({
    failedAgencyIds: [due[0]],
    refreshedAgencyIds: due.slice(1),
    skippedAgencyIds: [],
  });
  expect(resolveBinding).toHaveBeenCalledTimes(due.length);
});

it("reads the freshness port and does not sync a recently changed agency", async () => {
  const sync = vi.fn(async () => {}),
    p = provider("sample", sync, true);
  const time =
    Date.parse("2026-09-27T04:00:00Z") +
    assignTopologyWeekdays(["sample"]).get("sample")! * 86400_000;
  expect(
    await refreshScheduledTopologies(time, {
      providers: () => [p],
      resolveBinding: async () => seededBinding(),
    }),
  ).toMatchObject({ failedAgencyIds: [], refreshedAgencyIds: [], skippedAgencyIds: ["sample"] });
  expect(sync).not.toHaveBeenCalled();
});

it("a stopped generation cannot sync after pending binding resolution", async () => {
  let current = true;
  const sync = vi.fn(async () => {}),
    p = provider("sample", sync);
  const time =
    Date.parse("2026-09-27T04:00:00Z") +
    assignTopologyWeekdays(["sample"]).get("sample")! * 86400_000;
  await refreshScheduledTopologies(
    time,
    {
      providers: () => [p],
      resolveBinding: async () => {
        current = false;
        return {} as D1DatabaseBinding;
      },
    },
    () => current,
  );
  expect(sync).not.toHaveBeenCalled();
});
