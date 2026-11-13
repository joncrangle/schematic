import { createCloudflareInvocationIo } from "~/infrastructure/http/InvocationIo";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { AgencyProvider } from "~/agencies/types";
import { AgencyTaskRunner, type AgencyTaskStack } from "~/services/AgencyTaskRunner";

function provider(id: string, snapshot = true): AgencyProvider {
  return {
    manifest: { id } as AgencyProvider["manifest"],
    staticTopology: {},
    ...(snapshot
      ? {
          snapshot: {
            get: vi.fn(async () => ({
              agencyId: id,
              generatedAt: 0,
              freshness: "live" as const,
              alerts: [],
            })),
          },
        }
      : {}),
  } as AgencyProvider;
}

const summary = {
  activeAlertsEvaluated: 0,
  subscriptionsChecked: 0,
  activePushesSent: 0,
  clearedPushesSent: 0,
  expiredSubscriptionsPruned: 0,
  rejectedSubscriptionsPruned: 0,
};

function stack(): AgencyTaskStack {
  return {
    evaluator: {
      getRequiredLocales: (_agencyId: string) => Effect.succeed(["en-CA"] as const),
      evaluateAndDispatch: () => Effect.succeed(summary),
    },
  };
}

describe("AgencyTaskRunner public seams", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("shares concurrent layer builds and evicts a rejected build", async () => {
    const agency = provider("alpha");
    let attempts = 0;
    const buildStack = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary build failure");
      return stack();
    });
    const runner = new AgencyTaskRunner({
      providers: () => [agency],
      buildStack,
      getVapidConfig: () => ({
        publicKey: "public",
        privateKey: "private",
        subject: "mailto:test",
      }),
    });

    const first = runner.getEvaluationStack(agency);
    expect(runner.getEvaluationStack(agency)).toBe(first);
    await expect(first).rejects.toThrow("temporary build failure");

    await expect(runner.getEvaluationStack(agency)).resolves.toBeDefined();
    expect(buildStack).toHaveBeenCalledTimes(2);
  });

  it("rotates provider starts between bounded jobs without losing agencies", async () => {
    const agencies = [provider("alpha"), provider("beta"), provider("gamma")];
    const runner = new AgencyTaskRunner({ providers: () => agencies });
    const order: string[] = [];
    await runner.runJob({
      name: "bounded",
      cron: "* * * * *",
      onAggregate: "propagate",
      providerOffset: 1,
      run: (agency) =>
        Effect.sync(() => {
          order.push(agency.manifest.id);
        }),
    });
    expect(order).toEqual(["beta", "gamma", "alpha"]);
  });

  it("runs descriptor providers with concurrency one by default and aggregates failures", async () => {
    const providers = [provider("first"), provider("second"), provider("third")];
    let active = 0;
    let peak = 0;
    const runner = new AgencyTaskRunner({ providers: () => providers });

    const result = await runner.runJob({
      name: "test-job",
      cron: "test",
      onAggregate: "swallow+debug",
      run: (current) =>
        Effect.promise(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
          if (current.manifest.id === "second") throw new Error("second failed");
        }),
    });

    expect(peak).toBe(1);
    expect(result.failedIds).toEqual(["second"]);
  });

  it("names the descriptor in strict aggregate failures", async () => {
    const runner = new AgencyTaskRunner({ providers: () => [provider("second")] });

    await expect(
      runner.runJob({
        name: "sample-job",
        cron: "0 4 * * 1",
        onAggregate: "propagate",
        run: () => Effect.fail(new Error("sync failed")),
      }),
    ).rejects.toMatchObject({
      jobName: "sample-job",
      message: expect.stringContaining("sample-job"),
    });
  });

  it("allows explicit unbounded descriptor concurrency while preserving aggregate order", async () => {
    const providers = [provider("first"), provider("second")];
    let active = 0;
    let peak = 0;
    const runner = new AgencyTaskRunner({ providers: () => providers });

    const result = await runner.runJob({
      name: "parallel-job",
      cron: "test",
      onAggregate: "propagate",
      concurrency: "unbounded",
      run: () =>
        Effect.promise(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active -= 1;
        }),
    });

    expect(peak).toBe(2);
    expect(result.failedIds).toEqual([]);
  });

  it("invalidates every cached stack when the global VAPID identity changes", async () => {
    const alpha = provider("alpha");
    const beta = provider("beta");
    let builds = 0;
    let invalidate!: () => void;
    const runner = new AgencyTaskRunner({
      providers: () => [alpha, beta],
      getVapidConfig: () => ({
        publicKey: "public",
        privateKey: "private",
        subject: "mailto:test",
      }),
      buildStack: vi.fn(async (_provider, onUnauthorized) => {
        builds += 1;
        invalidate = onUnauthorized;
        return stack();
      }),
    });

    await runner.getEvaluationStack(alpha);
    await runner.getEvaluationStack(beta);
    invalidate();
    await runner.getEvaluationStack(alpha);

    expect(builds).toBe(3);
  });

  it("debounces repeated credential rejection invalidations across scheduler ticks", async () => {
    vi.useFakeTimers();
    const alpha = provider("alpha");
    const beta = provider("beta");
    const callbacks = new Map<string, () => void>();
    let builds = 0;
    const runner = new AgencyTaskRunner({
      providers: () => [alpha, beta],
      getVapidConfig: () => ({
        publicKey: "public",
        privateKey: "private",
        subject: "mailto:test",
      }),
      buildStack: vi.fn(async (agency, onUnauthorized) => {
        builds += 1;
        callbacks.set(agency.manifest.id, onUnauthorized);
        return stack();
      }),
    });

    await runner.getEvaluationStack(alpha);
    await runner.getEvaluationStack(beta);
    callbacks.get("alpha")!();
    await runner.getEvaluationStack(alpha);
    callbacks.get("beta")!();
    vi.setSystemTime(Date.now() + 4 * 60_000);
    callbacks.get("alpha")!();
    await runner.getEvaluationStack(alpha);

    expect(builds).toBe(3);

    vi.setSystemTime(Date.now() + 60_000);
    callbacks.get("alpha")!();
    await runner.getEvaluationStack(alpha);
    expect(builds).toBe(4);
  });
  it("threads fresh invocation transport options through an already cached evaluation stack", async () => {
    const agency = provider("alpha");
    const seen: unknown[] = [];
    const buildStack = vi.fn(async () => ({
      evaluator: {
        getRequiredLocales: () => Effect.succeed(["en-CA"] as const),
        evaluateAndDispatch: (_snapshot: unknown, _now?: number, options?: unknown) => {
          seen.push(options);
          return Effect.succeed(summary);
        },
      },
    }));
    const runner = new AgencyTaskRunner({
      providers: () => [agency],
      buildStack,
      getVapidConfig: () => ({
        publicKey: "public",
        privateKey: "private",
        subject: "mailto:test",
      }),
    });
    const upstream = vi.fn(async () => new Response(null, { status: 204 }));
    const first = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 1 });
    const next = createCloudflareInvocationIo({ fetch: upstream as typeof fetch, limit: 1 });
    const snapshot = { agencyId: "alpha", generatedAt: 0, freshness: "live" as const, alerts: [] };
    await runner.evaluateSnapshot(agency, snapshot, { sendOptions: first.sendOptions });
    await runner.evaluateSnapshot(agency, snapshot, { sendOptions: next.sendOptions });
    expect(seen).toEqual([{ sendOptions: first.sendOptions }, { sendOptions: next.sendOptions }]);
    expect(buildStack).toHaveBeenCalledTimes(1);
  });
});
