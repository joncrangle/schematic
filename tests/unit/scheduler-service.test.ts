vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { createFakeConditionalCache } from "../helpers/fake-conditional-cache";
import { makeTestProvider } from "../helpers/agency-fixtures";
/**
 * @vitest-environment node
 *
 * Server-side scheduler test: startSelfHostedScheduler bails when `window`
 * exists, so this suite pins the node environment instead of the
 * happy-dom default.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import { Layer } from "effect";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";
import {
  captureServerEnvChannels,
  clearServerEnvChannels,
  setGlobalEnvChannel,
} from "../helpers/env-channels";

const { loggerMocks } = vi.hoisted(() => ({
  loggerMocks: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    getLevel: vi.fn(() => "none"),
  },
}));

const { notificationReads, notificationDb } = vi.hoisted(() => ({
  notificationDb: { current: undefined as D1DatabaseBinding | undefined },
  notificationReads: {
    subscriptions: vi.fn<() => Promise<readonly PushSubscriptionRecord[]>>(),
    outstandingTargets:
      vi.fn<() => Promise<readonly { agencyId: string; subscriptionId: string }[]>>(),
  },
}));

vi.mock("~/infrastructure/storage/SubscriptionRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/storage/SubscriptionRepository")>();
  return {
    ...actual,
    createLiveNotificationsRepositoryLayer: (
      options: Parameters<typeof actual.createLiveNotificationsRepositoryLayer>[0],
    ) =>
      notificationDb.current !== undefined
        ? Layer.succeed(
            actual.SubscriptionRepository,
            actual.makeD1SubscriptionRepositoryService(notificationDb.current, {
              fallbackTimezone: "UTC",
              queryBudget: options?.queryBudget,
            }),
          )
        : Layer.effect(
            actual.SubscriptionRepository,
            Effect.gen(function* () {
              const memory = yield* actual.SubscriptionRepository;
              return {
                ...memory,
                getActiveSubscriptions: () =>
                  Effect.tryPromise({
                    try: () => notificationReads.subscriptions(),
                    catch: (cause) =>
                      new actual.SubscriptionStorageError({
                        message: "repository unavailable",
                        cause,
                      }),
                  }),
                getOutstandingDeliveryTargets: () =>
                  Effect.tryPromise({
                    try: () => notificationReads.outstandingTargets(),
                    catch: (cause) =>
                      new actual.SubscriptionStorageError({
                        message: "repository unavailable",
                        cause,
                      }),
                  }),
              };
            }).pipe(Effect.provide(actual.createMemorySubscriptionRepository())),
          ),
  };
});

vi.mock("~/infrastructure/logging/logger", () => ({ logger: loggerMocks }));

import {
  allProviders,
  dangerouslyRegisterProvider,
  dangerouslyResetProviders,
} from "~/agencies/registry";
import type { AgencyProvider, AgencySnapshot } from "~/agencies/types";
import { agencyTaskRunner } from "~/services/AgencyTaskRunner";
import type { EvaluationSummary } from "~/services/notifications/AlertEvaluatorService";
import { buildSpoofSnapshot } from "~/services/notifications/DevAlertSpoof";
import {
  ALERT_EVALUATION_CRON,
  SLOW_ALERT_EVALUATION_CRON,
  FAST_ALERT_SOURCE_TYPES,
  SLOW_ALERT_SOURCE_TYPES,
  detectHostingTarget,
  handleScheduledEvent,
  initSchedulers,
  resolveCronJob,
  startScheduler,
  startSelfHostedScheduler,
  stopSelfHostedScheduler,
  resetSchedulerForTests,
  runEvaluationCycle,
  type ScheduledEventContext,
} from "~/services/notifications/ProductionScheduler";

const vapidVarNames = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const restoreEnvChannels = captureServerEnvChannels(vapidVarNames);

function scheduledSubscriber(agencyIds: readonly string[]): PushSubscriptionRecord {
  return {
    id: "scheduled-subscriber",
    endpoint: "https://example.test/push",
    auth: "fictional-auth",
    p256dh: "fictional-key",
    favouriteLines: agencyIds.map((agencyId) => ({ agencyId, lineId: "1" })),
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [],
    timezone: "America/Toronto",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

beforeEach(() => {
  notificationDb.current = undefined;
  notificationReads.subscriptions.mockImplementation(async () => [
    scheduledSubscriber(allProviders().map((provider) => provider.manifest.id)),
  ]);
  notificationReads.outstandingTargets.mockResolvedValue([]);
});

afterEach(async () => {
  restoreEnvChannels();
  await resetSchedulerForTests();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

function stubEligibleLocaleSubscriptions(): void {
  const summary: EvaluationSummary = {
    activeAlertsEvaluated: 0,
    subscriptionsChecked: 1,
    activePushesSent: 0,
    clearedPushesSent: 0,
    expiredSubscriptionsPruned: 0,
    rejectedSubscriptionsPruned: 0,
  };
  vi.spyOn(agencyTaskRunner, "getEvaluationStackEffect").mockImplementation((provider) => {
    const eligibleSubscriptions = [
      {
        locale: "en-CA" as const,
        favouriteLines: [{ agencyId: provider.manifest.id, lineId: "A" }],
      },
    ];
    return Effect.succeed({
      evaluator: {
        getRequiredLocales: (agencyId: string) =>
          Effect.succeed(
            eligibleSubscriptions
              .filter((subscription) =>
                subscription.favouriteLines.some((favorite) => favorite.agencyId === agencyId),
              )
              .map((subscription) => subscription.locale),
          ),
        evaluateAndDispatch: () => Effect.succeed(summary),
      },
    });
  });
  vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockResolvedValue(summary);
}

/**
 * One evaluation cycle must not be gated by the slowest agency. ADR-0007
 * makes adding an agency a near-zero-cost change, which only holds if cycle
 * wall-clock is the max across agencies rather than the sum: a serialized
 * cycle lets one agency's full retry ladder block every other agency.
 */
describe("evaluation cycle agency concurrency", () => {
  afterEach(() => {
    dangerouslyResetProviders();
  });

  it("invokes a fast agency's snapshot port while a slow agency is still in flight", async () => {
    stubEligibleLocaleSubscriptions();
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({
      VAPID_PUBLIC_KEY: "pk-concurrency",
      VAPID_PRIVATE_KEY: "sk-concurrency",
    });
    // 404 is not a retryable status, so the real agencies' alert sources fail
    // without walking the retry ladder. Keeps the test hermetic and fast.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const events: string[] = [];
    const baseline = makeTestProvider();
    const withSnapshotPort = (id: string, port: () => Promise<AgencySnapshot>) =>
      ({
        ...baseline,
        manifest: { ...baseline.manifest, id },
        snapshot: { get: port },
      }) as AgencyProvider;

    // The slow agency unblocks itself, so a serialized cycle still terminates
    // and the test fails on the ordering assertion rather than hanging.
    dangerouslyRegisterProvider(
      withSnapshotPort("cycle-slow", async () => {
        events.push("slow:enter");
        await new Promise((resolve) => setTimeout(resolve, 200));
        events.push("slow:exit");
        throw new Error("slow agency unavailable");
      }),
    );
    dangerouslyRegisterProvider(
      withSnapshotPort("cycle-fast", async () => {
        events.push("fast:enter");
        return { agencyId: "cycle-fast", generatedAt: 0, freshness: "live", alerts: [] };
      }),
    );

    const cycle = runEvaluationCycle();
    expect(runEvaluationCycle()).toBe(cycle);
    await cycle.catch(() => undefined);

    // Both ports ran, so the cycle is not silently skipping agencies.
    expect(events).toContain("slow:enter");
    expect(events).toContain("fast:enter");
    // The ordering is the whole fact: under `concurrency: 1` the runner cannot
    // reach the fast agency until the slow one has already exited.
    expect(events.indexOf("fast:enter")).toBeLessThan(events.indexOf("slow:exit"));
  });

  it("never exceeds the six connections one Worker invocation may hold open", async () => {
    stubEligibleLocaleSubscriptions();
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({
      VAPID_PUBLIC_KEY: "pk-cap",
      VAPID_PRIVATE_KEY: "sk-cap",
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    // Eight synthetic agencies, each holding its slot for long enough that a
    // cap high enough to admit them all would show up as eight in flight. The
    // real registered agencies are in the same pool, so this counts the whole
    // fanout rather than only the synthetic part.
    const baseline = makeTestProvider();
    let inFlight = 0;
    let peak = 0;
    for (let index = 0; index < 8; index += 1) {
      dangerouslyRegisterProvider({
        ...baseline,
        manifest: { ...baseline.manifest, id: `cap-${index}` },
        snapshot: {
          get: async () => {
            inFlight += 1;
            peak = Math.max(peak, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 30));
            inFlight -= 1;
            return { agencyId: `cap-${index}`, generatedAt: 0, freshness: "live", alerts: [] };
          },
        },
      } as AgencyProvider);
    }

    await runEvaluationCycle().catch(() => undefined);

    // Cloudflare allows six simultaneously open connections per invocation, and
    // one evaluation task is one agency's snapshot fetch. Exceeding the cap
    // fails the feeds it is meant to protect, so the bound is not advisory.
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(6);
  });
});

describe("ProductionScheduler locale failures", () => {
  afterEach(() => dangerouslyResetProviders());

  it("reports only locales whose snapshot evaluation fails", async () => {
    stubEligibleLocaleSubscriptions();
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-locales", VAPID_PRIVATE_KEY: "sk-locales" });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );

    const base = makeTestProvider();
    const provider = {
      ...base,
      manifest: { ...base.manifest, id: "locale-failure" },
      snapshot: {
        get: async (context) =>
          ({
            agencyId: "locale-failure",
            generatedAt: 0,
            freshness: "live" as const,
            alerts: [],
            locale: context.locale,
          }) as unknown as AgencySnapshot,
      },
    } satisfies AgencyProvider;
    dangerouslyRegisterProvider(provider);
    vi.spyOn(agencyTaskRunner, "getEvaluationStackEffect").mockReturnValue(
      Effect.succeed({
        evaluator: { getRequiredLocales: () => Effect.succeed(["en-CA", "fr-CA"]) },
      } as never),
    );
    const summary: EvaluationSummary = {
      activeAlertsEvaluated: 0,
      subscriptionsChecked: 0,
      activePushesSent: 0,
      clearedPushesSent: 0,
      expiredSubscriptionsPruned: 0,
      rejectedSubscriptionsPruned: 0,
    };
    vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockImplementation(
      async (_provider, _snapshot, options) => {
        if (options?.locale === "fr-CA") throw new Error("fixture locale failure");
        return summary;
      },
    );

    await runEvaluationCycle().catch(() => undefined);
    const localeFailureLog = loggerMocks.error.mock.calls.find(
      ([message, fields]) =>
        String(message).includes("agency job failed") &&
        (fields as { agencyId?: string } | undefined)?.agencyId === "locale-failure",
    );
    expect(localeFailureLog?.[1]).toMatchObject({ agencyId: "locale-failure" });
    expect(String((localeFailureLog?.[1] as { err: string }).err)).toContain("fr-CA");
    expect(String((localeFailureLog?.[1] as { err: string }).err)).toContain(
      "fixture locale failure",
    );
    expect(String((localeFailureLog?.[1] as { err: string }).err)).not.toContain("en-CA");
    expect(agencyTaskRunner.evaluateSnapshot).toHaveBeenCalledTimes(2);
    expect(agencyTaskRunner.evaluateSnapshot).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ locale: "en-CA" }),
      expect.objectContaining({ locale: "en-CA" }),
    );
    expect(agencyTaskRunner.evaluateSnapshot).toHaveBeenCalledWith(
      provider,
      expect.objectContaining({ locale: "fr-CA" }),
      expect.objectContaining({ locale: "fr-CA" }),
    );
  });
});

describe("runEvaluationCycle VAPID gate", () => {
  it("skips with a warn-level log and zero network activity when unconfigured everywhere", async () => {
    clearServerEnvChannels(vapidVarNames);
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    try {
      await runEvaluationCycle();

      expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
      expect(loggerMocks.warn.mock.calls[0]?.[0]).toContain("VAPID keys not configured");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("passes the gate on bindings-only keys (subscribe-but-never-dispatch closed)", async () => {
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-bindings", VAPID_PRIVATE_KEY: "sk-bindings" });
    const fetchGuard = vi.fn();
    vi.stubGlobal("fetch", fetchGuard);

    try {
      await runEvaluationCycle().then(
        () => {},
        () => {},
      );

      const skipMessages = [...loggerMocks.debug.mock.calls, ...loggerMocks.warn.mock.calls]
        .map((call) => call[0] as string)
        .filter((message) => message.includes("VAPID keys not configured"));
      expect(skipMessages).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("ProductionScheduler hosting detection & bootstrap", () => {
  it("detects Cloudflare Workers from the workerd user agent", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Cloudflare-Workers)" });
    expect(detectHostingTarget()).toBe("cloudflare");
  });

  it("treats a missing navigator (plain Node) as self-hosted", () => {
    vi.stubGlobal("navigator", undefined);
    expect(detectHostingTarget()).toBe("self-hosted");
  });

  it("treats a Node-flavored navigator as self-hosted", () => {
    vi.stubGlobal("navigator", { userAgent: "Node.js/22" });
    expect(detectHostingTarget()).toBe("self-hosted");
  });

  it("caches the hosting probe for the lifetime of the process", () => {
    vi.stubGlobal("navigator", { userAgent: "Node.js/22" });
    expect(detectHostingTarget()).toBe("self-hosted");

    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Cloudflare-Workers)" });
    expect(detectHostingTarget()).toBe("self-hosted");
  });

  it("no-ops on Cloudflare even when called repeatedly", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Cloudflare-Workers)" });
    expect(startScheduler()).toEqual({ hosting: "cloudflare", started: false });
    expect(startScheduler()).toEqual({ hosting: "cloudflare", started: false });
  });

  it("starts the interval scheduler once on self-hosted runtimes", () => {
    vi.stubGlobal("navigator", undefined);
    expect(startScheduler()).toEqual({ hosting: "self-hosted", started: true });
    expect(startScheduler().started).toBe(false);
  });

  it("does not arm an interval when its self-host entrypoint is called on Workers", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Cloudflare-Workers)" });
    startSelfHostedScheduler(100);

    expect(loggerMocks.info).not.toHaveBeenCalledWith(
      expect.stringContaining("starting self-hosted background alert scheduler"),
    );
  });

  it("keeps self-hosted startup idempotent and permits a new lifecycle after stop", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", undefined);

      startSelfHostedScheduler(100);
      startSelfHostedScheduler(100);
      expect(
        loggerMocks.info.mock.calls.filter(([message]) =>
          String(message).includes("starting self-hosted background alert scheduler"),
        ),
      ).toHaveLength(1);

      await stopSelfHostedScheduler();
      startSelfHostedScheduler(100);
      expect(
        loggerMocks.info.mock.calls.filter(([message]) =>
          String(message).includes("starting self-hosted background alert scheduler"),
        ),
      ).toHaveLength(2);
    } finally {
      // Fake timers must not leak: later suites rely on real timers for
      // overlap and latency assertions.
      vi.useRealTimers();
    }
  });

  it("runs the warmup and interval through the public cycle seam", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", undefined);
      clearServerEnvChannels(vapidVarNames);
      startSelfHostedScheduler(20_000);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(loggerMocks.warn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(loggerMocks.warn).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels warmup and invalidates an interval callback after stop", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", undefined);
      clearServerEnvChannels(vapidVarNames);
      startSelfHostedScheduler(1_000);
      await stopSelfHostedScheduler();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(loggerMocks.warn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let a stopped cycle interfere with a restarted scheduler cycle", async () => {
    vi.useFakeTimers();
    try {
      vi.stubGlobal("navigator", undefined);
      clearServerEnvChannels(vapidVarNames);
      setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-restart", VAPID_PRIVATE_KEY: "sk-restart" });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(null, { status: 404 })),
      );
      const baseline = makeTestProvider();
      let finishFirst!: () => void;
      let finishSecond!: () => void;
      let calls = 0;
      dangerouslyRegisterProvider({
        ...baseline,
        manifest: { ...baseline.manifest, id: "restart-inflight" },
        snapshot: {
          get: () => {
            calls += 1;
            return new Promise<AgencySnapshot>((resolve) => {
              if (calls === 1)
                finishFirst = () =>
                  resolve({
                    agencyId: "restart-inflight",
                    generatedAt: 1,
                    freshness: "live",
                    alerts: [],
                  });
              else
                finishSecond = () =>
                  resolve({
                    agencyId: "restart-inflight",
                    generatedAt: 2,
                    freshness: "live",
                    alerts: [],
                  });
            });
          },
        },
      } as AgencyProvider);
      stubEligibleLocaleSubscriptions();
      vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockResolvedValue({
        activeAlertsEvaluated: 0,
        subscriptionsChecked: 0,
        activePushesSent: 0,
        clearedPushesSent: 0,
        expiredSubscriptionsPruned: 0,
        rejectedSubscriptionsPruned: 0,
      });

      startSelfHostedScheduler(60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(1);
      const stopping = stopSelfHostedScheduler();
      await stopping;

      startSelfHostedScheduler(60_000);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(calls).toBe(2);
      const restartedCycle = runEvaluationCycle();
      finishFirst();
      await vi.advanceTimersByTimeAsync(0);
      expect(agencyTaskRunner.evaluateSnapshot).not.toHaveBeenCalled();
      expect(runEvaluationCycle()).toBe(restartedCycle);
      expect(calls).toBe(2);

      finishSecond();
      await restartedCycle;
      expect(agencyTaskRunner.evaluateSnapshot).toHaveBeenCalledOnce();
      expect(agencyTaskRunner.evaluateSnapshot).toHaveBeenCalledWith(
        expect.objectContaining({ manifest: expect.objectContaining({ id: "restart-inflight" }) }),
        expect.objectContaining({ generatedAt: 2 }),
        expect.anything(),
      );
      await stopSelfHostedScheduler();
      expect(calls).toBe(2);
    } finally {
      dangerouslyResetProviders();
      vi.useRealTimers();
    }
  });

  it("initializes the alert scheduler once through the public init hook", () => {
    vi.stubGlobal("navigator", undefined);

    initSchedulers();
    initSchedulers();
    expect(detectHostingTarget()).toBe("self-hosted");
  });
});

describe("DevAlertSpoof snapshot construction", () => {
  it("keeps spoof construction out of the production scheduler public seam", async () => {
    const scheduler = await import("~/services/notifications/ProductionScheduler");
    expect("buildSpoofSnapshot" in scheduler).toBe(false);
    expect("runSpoofedAlertEvaluation" in scheduler).toBe(false);
  });

  it("applies every override: agency, line, stations, severity, kind, and copy", () => {
    const snapshot = buildSpoofSnapshot("regional", 1_000, {
      lineId: "R1",
      stations: ["Hub", "Unknown Station"],
      severity: "degraded",
      kind: "slow-service",
      title: "CLI spoof title",
      description: "CLI spoof body",
      routeIds: ["26"],
    });

    expect(snapshot.agencyId).toBe("regional");
    expect(snapshot.alerts).toHaveLength(1);
    const alert = snapshot.alerts[0];
    expect(alert.severity).toBe("degraded");
    expect(alert.kind).toBe("slow-service");
    expect(alert.affectedLineIds).toEqual(["R1"]);
    expect(alert.affectedStations).toEqual([
      { stationId: "hub", stationName: "Hub" },
      { stationName: "Unknown Station" },
    ]);
    expect(alert.affectedRouteIds).toEqual(["26"]);
    expect(alert.title).toBe("CLI spoof title");
    expect(alert.description).toBe("CLI spoof body");
  });

  it("mints a fresh alert id per call so delivery dedup never swallows repeat triggers", () => {
    const first = buildSpoofSnapshot("sample", 1_000).alerts[0].id;
    const second = buildSpoofSnapshot("sample", 2_000).alerts[0].id;
    expect(first).not.toBe(second);
  });
});

const SCHEDULED_TIME = 1779000000000;
const FORMER_WEEKLY_SURFACE_SYNC_CRON = "0 4 * * 1";

function scheduledContext(): {
  ctx: ScheduledEventContext;
  promises: Promise<unknown>[];
} {
  const promises: Promise<unknown>[] = [];
  return {
    promises,
    ctx: {
      waitUntil: (promise) => {
        promises.push(promise);
      },
    },
  };
}

describe("resolveCronJob pure cron→job matrix", () => {
  it.each([
    {
      name: "the former weekly sync literal is no longer a known job",
      cron: FORMER_WEEKLY_SURFACE_SYNC_CRON,
      expected: null,
    },
    {
      name: "evaluation cadence literal resolves to the evaluate-alerts job",
      cron: ALERT_EVALUATION_CRON,
      expected: "evaluate-alerts",
    },
    {
      name: "slow cadence literal resolves to the evaluate-slow-alerts job",
      cron: SLOW_ALERT_EVALUATION_CRON,
      expected: "evaluate-slow-alerts",
    },
    {
      name: "well-formed but unmapped cron expression resolves to null",
      cron: "30 5 * * 2",
      expected: null,
    },
    {
      name: "empty cron string resolves to null",
      cron: "",
      expected: null,
    },
  ])("$name", ({ cron, expected }) => {
    expect(resolveCronJob(cron)).toBe(expected);
  });
});

describe("handleScheduledEvent dispatch", () => {
  const runEvaluationCycleMock = vi.fn();

  function dispatch(
    event: { cron: string; scheduledTime: number },
    ctx: ScheduledEventContext,
  ): void {
    handleScheduledEvent(event, {}, ctx, {
      runEvaluationCycle: runEvaluationCycleMock,
    });
  }

  it("routes the fast cron to its source cadence", async () => {
    runEvaluationCycleMock.mockResolvedValue(undefined);
    const { ctx, promises } = scheduledContext();

    dispatch({ cron: ALERT_EVALUATION_CRON, scheduledTime: SCHEDULED_TIME }, ctx);

    expect(runEvaluationCycleMock).toHaveBeenCalledTimes(1);
    expect(runEvaluationCycleMock).toHaveBeenCalledWith({
      onAggregate: "swallow+debug",
      presenceTypes: FAST_ALERT_SOURCE_TYPES,
      cron: ALERT_EVALUATION_CRON,
    });
    await promises[0];
  });

  it("routes the slow cron to its source cadence", async () => {
    runEvaluationCycleMock.mockResolvedValue(undefined);
    const { ctx, promises } = scheduledContext();

    dispatch({ cron: SLOW_ALERT_EVALUATION_CRON, scheduledTime: SCHEDULED_TIME }, ctx);

    expect(runEvaluationCycleMock).toHaveBeenCalledTimes(1);
    expect(runEvaluationCycleMock).toHaveBeenCalledWith({
      onAggregate: "swallow+debug",
      presenceTypes: SLOW_ALERT_SOURCE_TYPES,
      cron: SLOW_ALERT_EVALUATION_CRON,
    });
    await promises[0];
  });

  it("warns with the former weekly cron and dispatches nothing", () => {
    const { ctx, promises } = scheduledContext();

    dispatch({ cron: FORMER_WEEKLY_SURFACE_SYNC_CRON, scheduledTime: SCHEDULED_TIME }, ctx);

    expect(loggerMocks.warn).toHaveBeenCalledTimes(1);
    expect(loggerMocks.warn.mock.calls[0]?.[1]).toEqual({
      cron: FORMER_WEEKLY_SURFACE_SYNC_CRON,
    });
    // No catch-all job may fire on unknown crons.
    expect(promises).toHaveLength(0);
    expect(runEvaluationCycleMock).not.toHaveBeenCalled();
  });

  it("propagates evaluation-cycle rejections out of waitUntil instead of settling them", async () => {
    runEvaluationCycleMock.mockRejectedValueOnce(new Error("evaluation cycle exploded"));
    const { ctx, promises } = scheduledContext();

    dispatch({ cron: ALERT_EVALUATION_CRON, scheduledTime: SCHEDULED_TIME }, ctx);

    // The rejection must reach Cloudflare's Cron Past Events — no
    // catch-and-settle inside the dispatcher.
    await expect(promises[0]).rejects.toThrow("evaluation cycle exploded");
  });
});

describe("evaluation cycle source cadence", () => {
  afterEach(() => {
    dangerouslyResetProviders();
  });

  function registerCadenceProviders(): void {
    dangerouslyRegisterProvider(
      makeTestProvider({
        id: "cadence-fast",
        alerts: [{ type: "gtfs-rt", url: "https://example.test/cadence-fast" }],
      }),
    );
    dangerouslyRegisterProvider(
      makeTestProvider({
        id: "cadence-slow",
        alerts: [
          {
            type: "web",
            url: "https://example.test/cadence-slow",
            parser: "ghd-news-service-advisories",
          },
        ],
      }),
    );
    dangerouslyRegisterProvider(
      makeTestProvider({
        id: "cadence-mixed",
        alerts: [
          { type: "gtfs-rt", url: "https://example.test/cadence-mixed-fast" },
          {
            type: "web",
            url: "https://example.test/cadence-mixed-slow",
            parser: "ghd-news-service-advisories",
          },
        ],
      }),
    );
  }

  function stubAllFeedsDown(): { fetchedUrls: () => string[] } {
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({
      VAPID_PUBLIC_KEY: "pk-cadence",
      VAPID_PRIVATE_KEY: "sk-cadence",
    });
    const fetchSpy = vi.fn(async (_url: string) => new Response(null, { status: 404 }));
    vi.stubGlobal("fetch", fetchSpy);
    return {
      fetchedUrls: () => fetchSpy.mock.calls.map(([url]) => String(url)),
    };
  }

  it("fetches complete mixed snapshots on a cold Workers fast cadence", async () => {
    registerCadenceProviders();
    notificationReads.subscriptions.mockResolvedValue([
      scheduledSubscriber(["cadence-fast", "cadence-slow", "cadence-mixed"]),
    ]);
    const { fetchedUrls } = stubAllFeedsDown();
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    await runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES }).catch(() => undefined);

    expect(fetchedUrls().some((url) => url.includes("cadence-fast"))).toBe(true);
    expect(fetchedUrls().some((url) => url.includes("cadence-mixed-fast"))).toBe(true);
    expect(fetchedUrls().some((url) => url.includes("cadence-mixed-slow"))).toBe(true);
    expect(
      fetchedUrls().some((url) => url.includes("cadence-slow") && !url.includes("mixed")),
    ).toBe(false);
  });

  it("fetches complete mixed snapshots on a cold Workers slow cadence", async () => {
    registerCadenceProviders();
    notificationReads.subscriptions.mockResolvedValue([
      scheduledSubscriber(["cadence-fast", "cadence-slow", "cadence-mixed"]),
    ]);
    const { fetchedUrls } = stubAllFeedsDown();
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    await runEvaluationCycle({ presenceTypes: SLOW_ALERT_SOURCE_TYPES }).catch(() => undefined);

    expect(
      fetchedUrls().some((url) => url.includes("cadence-slow") && !url.includes("mixed")),
    ).toBe(true);
    expect(fetchedUrls().some((url) => url.includes("cadence-mixed-fast"))).toBe(true);
    expect(fetchedUrls().some((url) => url.includes("cadence-mixed-slow"))).toBe(true);
    expect(fetchedUrls().some((url) => url.includes("cadence-fast"))).toBe(false);
  });

  it("judges cadence presence by runtime-active sources, not merely declared ones", async () => {
    // YRT declares a web board that is self-hosted-only: under the
    // Cloudflare probe it counts as fast-only, so the slow cycle skips it.
    dangerouslyRegisterProvider(
      makeTestProvider({
        id: "cadence-gated",
        alerts: [
          { type: "gtfs-rt", url: "https://example.test/cadence-gated-fast" },
          {
            type: "web",
            url: "https://example.test/cadence-gated-slow",
            parser: "ghd-news-service-advisories",
            runtimes: ["self-hosted"],
          },
        ],
      }),
    );
    notificationReads.subscriptions.mockResolvedValue([scheduledSubscriber(["cadence-gated"])]);
    const { fetchedUrls } = stubAllFeedsDown();
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Cloudflare-Workers)" });

    try {
      await runEvaluationCycle({ presenceTypes: SLOW_ALERT_SOURCE_TYPES }).catch(() => undefined);
      expect(fetchedUrls().some((url) => url.includes("cadence-gated"))).toBe(false);

      await runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES }).catch(() => undefined);
      expect(fetchedUrls().some((url) => url.includes("cadence-gated-fast"))).toBe(true);
      expect(fetchedUrls().some((url) => url.includes("cadence-gated-slow"))).toBe(false);
    } finally {
      vi.unstubAllGlobals();
      await resetSchedulerForTests();
    }
  });

  it("runs concurrent cadences independently instead of sharing one in-flight cycle", async () => {
    registerCadenceProviders();
    notificationReads.subscriptions.mockResolvedValue([
      scheduledSubscriber(["cadence-fast", "cadence-slow", "cadence-mixed"]),
    ]);
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({
      VAPID_PUBLIC_KEY: "pk-cadence",
      VAPID_PRIVATE_KEY: "sk-cadence",
    });
    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        await new Promise((resolve) => setTimeout(resolve, 30));
        return new Response(null, { status: 404 });
      }),
    );

    // Fired together so both cycles are in flight at once: with a shared
    // in-flight slot the second call would adopt the first cycle's promise
    // and its cadence would never fetch.
    await Promise.all([
      runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES }).catch(() => undefined),
      runEvaluationCycle({ presenceTypes: SLOW_ALERT_SOURCE_TYPES }).catch(() => undefined),
    ]);

    expect(fetchedUrls.some((url) => url.includes("cadence-fast"))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes("cadence-slow") && !url.includes("mixed"))).toBe(
      true,
    );
    expect(fetchedUrls.some((url) => url.includes("cadence-mixed-fast"))).toBe(true);
    expect(fetchedUrls.some((url) => url.includes("cadence-mixed-slow"))).toBe(true);
  });

  it("advances slow Workers rotation by one per 15-minute cadence", async () => {
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-rotation", VAPID_PRIVATE_KEY: "sk-rotation" });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });

    const firstTime = Date.UTC(2026, 9, 10, 12, 0, 0) + 10_000;
    const dateNow = vi.spyOn(Date, "now");
    dateNow.mockReturnValue(firstTime);
    const runJob = vi.spyOn(agencyTaskRunner, "runJob").mockResolvedValue({ failedIds: [] });

    try {
      for (let invocation = 0; invocation < 2; invocation += 1) {
        dateNow.mockReturnValue(firstTime + invocation * 900_000);
        await runEvaluationCycle({
          presenceTypes: SLOW_ALERT_SOURCE_TYPES,
          cron: SLOW_ALERT_EVALUATION_CRON,
        });
      }

      expect(runJob).toHaveBeenCalledTimes(2);
      const firstDescriptor = runJob.mock.calls[0]?.[0];
      const secondDescriptor = runJob.mock.calls[1]?.[0];
      expect(firstDescriptor?.cron).toBe(SLOW_ALERT_EVALUATION_CRON);
      expect(secondDescriptor?.providerOffset).toBe((firstDescriptor?.providerOffset ?? 0) + 1);
    } finally {
      dateNow.mockRestore();
      runJob.mockRestore();
      vi.unstubAllGlobals();
      await resetSchedulerForTests();
    }
  });

  it("bounds real scheduled polling across cache and HTTP operations", async () => {
    const fake = createFakeConditionalCache();
    for (let index = 0; index < 24; index += 1) {
      dangerouslyRegisterProvider(
        makeTestProvider({
          id: `budget-${index}`,
          alerts: [
            {
              type: "json",
              parser: "generic-alert-feed",
              url: `https://example.test/budget-${index}`,
            },
          ],
        }),
      );
    }
    notificationReads.subscriptions.mockResolvedValue([
      scheduledSubscriber(Array.from({ length: 24 }, (_, index) => `budget-${index}`)),
    ]);
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({ VAPID_PUBLIC_KEY: "pk-budget", VAPID_PRIVATE_KEY: "sk-budget" });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    vi.stubGlobal("caches", { default: fake.cache });
    const fetchImpl = vi.fn(async () => new Response("[]"));
    vi.stubGlobal("fetch", fetchImpl);
    const { ctx, promises } = scheduledContext();
    handleScheduledEvent({ cron: ALERT_EVALUATION_CRON, scheduledTime: SCHEDULED_TIME }, {}, ctx);
    await Promise.all(promises);
    expect(fetchImpl.mock.calls.length + fake.operations().length).toBe(49);
    expect(fetchImpl.mock.calls.length).toBeLessThan(24);
  });

  it("engages the Cloudflare crawl caps through the scheduled slow dispatch", async () => {
    // Routing -> caps end to end: the scheduled event (not a hand-built
    // selection) drives a real evaluation with the hosting probe pinned to
    // Cloudflare, and the capped crawl is what actually fetches.
    dangerouslyRegisterProvider(
      makeTestProvider({
        id: "cadence-capped",
        alerts: [
          {
            type: "web",
            url: "https://example.test/cadence-capped",
            parser: "ghd-news-service-advisories",
          },
        ],
      }),
    );
    notificationReads.subscriptions.mockResolvedValue([scheduledSubscriber(["cadence-capped"])]);
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({
      VAPID_PUBLIC_KEY: "pk-cadence",
      VAPID_PRIVATE_KEY: "sk-cadence",
    });
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Cloudflare-Workers)" });
    const card = (name: string, next?: number) => `
      <div class="blogItem"><div class="blogItem-contentContainer">
        <h2><a class="newsTitle" href="https://example.test/news/${name}.aspx">${name}</a></h2>
        <p><strong>Routes affected</strong>: ${name}</p>
      </div></div>${
        next === undefined
          ? ""
          : `<div class="pagination-container"><a href="/cadence-capped?page=${next}">${next}</a></div>`
      }`;
    const bodies: Record<string, string> = {};
    for (let page = 1; page <= 5; page += 1) {
      bodies[
        page === 1
          ? "https://example.test/cadence-capped"
          : `https://example.test/cadence-capped?page=${page}`
      ] = card(`Route ${page}`, page < 5 ? page + 1 : undefined);
    }
    const fetchedUrls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        fetchedUrls.push(url);
        const body = bodies[url];
        return body === undefined
          ? new Response(null, { status: 404 })
          : new Response(body, { status: 200 });
      }),
    );
    const promises: Promise<unknown>[] = [];
    const ctx: ScheduledEventContext = {
      waitUntil: (promise) => {
        promises.push(promise);
      },
    };

    try {
      handleScheduledEvent(
        { cron: SLOW_ALERT_EVALUATION_CRON, scheduledTime: SCHEDULED_TIME },
        {},
        ctx,
      );
      await Promise.all(promises.map((promise) => promise.catch(() => undefined)));

      // Five chained pages, but the Cloudflare ceiling stops the crawl at
      // three: routing reached the capped adapter, not an uncapped one.
      expect(
        fetchedUrls.filter((url) => url.startsWith("https://example.test/cadence-capped")),
      ).toEqual([
        "https://example.test/cadence-capped",
        "https://example.test/cadence-capped?page=2",
        "https://example.test/cadence-capped?page=3",
      ]);
    } finally {
      vi.unstubAllGlobals();
      await resetSchedulerForTests();
    }
  });
});

describe("Workers notification work selection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    dangerouslyResetProviders();
  });

  function workerSetup() {
    clearServerEnvChannels(vapidVarNames);
    setGlobalEnvChannel({
      VAPID_PUBLIC_KEY: "fictional-public",
      VAPID_PRIVATE_KEY: "fictional-private",
    });
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    return vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 404 })),
    );
  }

  it("does not poll any feeds when no subscriptions exist", async () => {
    workerSetup();
    notificationReads.subscriptions.mockResolvedValue([]);
    const fetchImpl = vi.mocked(globalThis.fetch);
    await runEvaluationCycle({
      presenceTypes: FAST_ALERT_SOURCE_TYPES,
      onAggregate: "swallow+debug",
    });
    expect(notificationReads.subscriptions).toHaveBeenCalledTimes(1);
    expect(notificationReads.outstandingTargets).not.toHaveBeenCalled();
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("polls current favourites and outstanding agencies despite a closed commute window", async () => {
    workerSetup();
    const snapshots = new Map<string, ReturnType<typeof vi.fn>>();
    for (const id of ["work-current", "work-recovery", "work-unrelated"]) {
      const get = vi.fn(async (): Promise<AgencySnapshot> => ({
        agencyId: id,
        generatedAt: 0,
        freshness: "live",
        alerts: [],
      }));
      const provider = makeTestProvider({
        id,
        alerts: [
          {
            type: "json",
            parser: "generic-alert-feed",
            url: `https://example.test/${id}`,
          },
        ],
      });
      dangerouslyRegisterProvider({ ...provider, snapshot: { get } });
      snapshots.set(id, get);
    }
    const subscriptions = [scheduledSubscriber(["work-current"])];
    notificationReads.subscriptions.mockResolvedValue(subscriptions);
    notificationReads.outstandingTargets.mockResolvedValue([
      { agencyId: "work-recovery", subscriptionId: subscriptions[0]!.id },
    ]);
    const evaluate = vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockResolvedValue({
      activeAlertsEvaluated: 0,
      subscriptionsChecked: 1,
      activePushesSent: 0,
      clearedPushesSent: 0,
      expiredSubscriptionsPruned: 0,
      rejectedSubscriptionsPruned: 0,
    });
    await runEvaluationCycle({
      presenceTypes: FAST_ALERT_SOURCE_TYPES,
      onAggregate: "swallow+debug",
    });
    expect(snapshots.get("work-current")).toHaveBeenCalledTimes(1);
    expect(snapshots.get("work-recovery")).toHaveBeenCalledTimes(1);
    expect(snapshots.get("work-unrelated")).not.toHaveBeenCalled();
    expect(notificationReads.subscriptions).toHaveBeenCalledTimes(1);
    expect(notificationReads.outstandingTargets).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledTimes(2);
    const evaluated = Object.fromEntries(
      evaluate.mock.calls.map(([provider, , options]) => [
        provider.manifest.id,
        options?.subscriptions?.map((sub) => sub.id),
      ]),
    );
    expect(evaluated).toEqual({ "work-current": [], "work-recovery": [subscriptions[0]!.id] });
  });

  it("scopes one alert host limiter to each evaluation cycle", async () => {
    workerSetup();
    const limiters = new Map<string, unknown[]>();
    const ids = ["shared-host-north", "shared-host-south"];
    for (const id of ids) {
      const get = vi.fn(async (ctx: { alertHostLimiter?: unknown }): Promise<AgencySnapshot> => {
        limiters.set(id, [...(limiters.get(id) ?? []), ctx.alertHostLimiter]);
        return { agencyId: id, generatedAt: 0, freshness: "live", alerts: [] };
      });
      const provider = makeTestProvider({
        id,
        alerts: [{ type: "json", parser: "generic-alert-feed", url: `https://example.test/${id}` }],
      });
      dangerouslyRegisterProvider({ ...provider, snapshot: { get } });
    }
    notificationReads.subscriptions.mockResolvedValue([scheduledSubscriber(ids)]);
    notificationReads.outstandingTargets.mockResolvedValue([]);
    vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockResolvedValue({
      activeAlertsEvaluated: 0,
      subscriptionsChecked: 1,
      activePushesSent: 0,
      clearedPushesSent: 0,
      expiredSubscriptionsPruned: 0,
      rejectedSubscriptionsPruned: 0,
    });
    const cycle = () =>
      runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES, onAggregate: "swallow+debug" });

    await cycle();
    const [north] = limiters.get("shared-host-north")!;
    const [south] = limiters.get("shared-host-south")!;
    expect(north).toBeDefined();
    expect(south).toBe(north);

    await cycle();
    expect(limiters.get("shared-host-north")![1]).toBeDefined();
    expect(limiters.get("shared-host-north")![1]).not.toBe(north);
  });

  it.each(["subscriptions", "outstandingTargets"] as const)(
    "fails before polling if the %s repository read fails",
    async (read) => {
      workerSetup();
      notificationReads[read].mockRejectedValue(new Error("repository unavailable"));
      await expect(
        runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES }),
      ).rejects.toThrow();
      expect(globalThis.fetch).not.toHaveBeenCalled();
    },
  );

  it("evaluates only each agency's interested or recovering subscribers", async () => {
    workerSetup();
    for (const id of ["line-target", "station-target", "route-target", "old-target"]) {
      const provider = makeTestProvider({
        id,
        alerts: [{ type: "json", parser: "generic-alert-feed", url: `https://example.test/${id}` }],
      });
      dangerouslyRegisterProvider({
        ...provider,
        snapshot: {
          get: async () => ({ agencyId: id, generatedAt: 0, freshness: "live", alerts: [] }),
        },
      });
    }
    const activeCommute = [
      {
        id: "all-day",
        label: "All day",
        enabled: true,
        days: [0, 1, 2, 3, 4, 5, 6],
        start: "00:00",
        end: "23:59",
      },
    ];
    const line = { ...scheduledSubscriber(["line-target"]), commuteSchedules: activeCommute };
    const station = {
      ...scheduledSubscriber([]),
      id: "station-subscriber",
      commuteSchedules: activeCommute,
      favouriteStations: [
        { agencyId: "station-target", stationId: "station", stationName: "Station" },
      ],
    };
    const route = {
      ...scheduledSubscriber([]),
      id: "route-subscriber",
      commuteSchedules: activeCommute,
      favouriteSurfaceRoutes: [{ agencyId: "route-target", routeId: "route" }],
    };
    const unrelated = { ...scheduledSubscriber(["absent-agency"]), id: "unrelated-subscriber" };
    const recovering = { ...scheduledSubscriber([]), id: "recovering-subscriber" };
    notificationReads.subscriptions.mockResolvedValue([
      line,
      station,
      route,
      unrelated,
      recovering,
    ]);
    notificationReads.outstandingTargets.mockResolvedValue([
      { agencyId: "old-target", subscriptionId: recovering.id },
      { agencyId: "line-target", subscriptionId: line.id },
      { agencyId: "old-target", subscriptionId: "invalid-policy-subscriber" },
    ]);
    const evaluate = vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockResolvedValue({
      activeAlertsEvaluated: 0,
      subscriptionsChecked: 1,
      activePushesSent: 0,
      clearedPushesSent: 0,
      expiredSubscriptionsPruned: 0,
      rejectedSubscriptionsPruned: 0,
    });
    await runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES });
    const evaluated = Object.fromEntries(
      evaluate.mock.calls.map(([provider, , options]) => [
        provider.manifest.id,
        options?.subscriptions?.map((sub) => sub.id),
      ]),
    );
    expect(evaluated).toEqual({
      "line-target": [line.id],
      "station-target": [station.id],
      "route-target": [route.id],
      "old-target": [recovering.id],
    });
  });

  it("silently clears an outstanding incident outside commute after its favourite is removed", async () => {
    workerSetup();
    const { SubscriptionRepository, createMemorySubscriptionRepository } =
      await import("~/infrastructure/storage/SubscriptionRepository");
    const { AlertEvaluatorService, createLiveAlertEvaluatorService } =
      await import("~/services/notifications/AlertEvaluatorService");
    const { createMockVapidClient } = await import("~/infrastructure/notifications/VapidClient");
    const sub = scheduledSubscriber([]);
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SubscriptionRepository;
      }).pipe(Effect.provide(createMemorySubscriptionRepository())),
    );
    const delivery = {
      id: "previous-delivery",
      alertId: "ended-incident",
      incidentKey: "previous-key",
      agencyId: "removed-favourite",
      subscriptionId: sub.id,
      status: "active_sent" as const,
      deliveredAt: 123,
    };
    await Effect.runPromise(repository.recordDelivery(delivery));
    const provider = makeTestProvider({
      id: delivery.agencyId,
      alerts: [
        {
          type: "json",
          parser: "generic-alert-feed",
          url: "https://example.test/removed-favourite",
        },
      ],
    });
    dangerouslyRegisterProvider({
      ...provider,
      snapshot: {
        get: async () => ({
          agencyId: delivery.agencyId,
          generatedAt: 0,
          freshness: "live",
          alerts: [],
        }),
      },
    });
    const send = vi.fn(async () => ({ success: true, expired: false, statusCode: 201 }));
    const layer = createLiveAlertEvaluatorService().pipe(
      Layer.provide(
        Layer.merge(Layer.succeed(SubscriptionRepository, repository), createMockVapidClient(send)),
      ),
    );
    const evaluator = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AlertEvaluatorService;
      }).pipe(Effect.provide(layer)),
    );
    notificationReads.subscriptions.mockResolvedValue([sub]);
    notificationReads.outstandingTargets.mockResolvedValue([
      { agencyId: delivery.agencyId, subscriptionId: sub.id },
    ]);
    vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockImplementation(
      (_provider, snapshot, options) =>
        Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, 456, { ...options, repository })),
    );
    await runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES });
    expect(
      await Effect.runPromise(repository.getDelivery(delivery.agencyId, delivery.alertId, sub.id)),
    ).toEqual({ ...delivery, locale: "en-CA", status: "cleared_silent" });
    expect(send).not.toHaveBeenCalled();
  });

  it("shares a fresh bounded SQL repository across scheduled recipients each invocation", async () => {
    workerSetup();
    const { createMemoryD1 } = await import("../helpers/memoryD1");
    const { makeD1SubscriptionRepositoryService } =
      await import("~/infrastructure/storage/SubscriptionRepository");
    const db = await createMemoryD1();
    const repository = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
    const agencyId = "sql-budget-agency";
    const now = Date.now();
    for (let index = 0; index < 49; index++) {
      await Effect.runPromise(
        repository.upsertSubscription({
          ...scheduledSubscriber([agencyId]),
          id: `sub-${index}`,
          endpoint: `https://example.test/sub-${index}`,
          createdAt: now,
          updatedAt: now,
          commuteSchedules: [
            {
              id: "all-day",
              label: "All day",
              enabled: true,
              days: [0, 1, 2, 3, 4, 5, 6],
              start: "00:00",
              end: "23:59",
            },
          ],
        }),
      );
    }
    const provider = makeTestProvider({
      id: agencyId,
      alerts: [
        { type: "json", parser: "generic-alert-feed", url: "https://example.test/sql-budget" },
      ],
    });
    const get = vi.fn(async (): Promise<AgencySnapshot> => ({
      agencyId,
      generatedAt: 0,
      freshness: "live",
      alerts: [],
    }));
    dangerouslyRegisterProvider({ ...provider, snapshot: { get } });
    const all = vi.fn<(query: string) => void>();
    const prepare = db.prepare;
    db.prepare = (query) => {
      const statement = prepare(query);
      const runAll = statement.all;
      statement.all = <T>() => {
        all(query);
        return runAll<T>();
      };
      return statement;
    };
    notificationDb.current = db;
    for (let invocation = 0; invocation < 2; invocation++) {
      all.mockClear();
      await runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES });
      expect(all).toHaveBeenCalledTimes(3);
    }
    expect(get).toHaveBeenCalledTimes(2);
    await db.exec("DELETE FROM push_subscriptions");
    all.mockClear();
    await runEvaluationCycle({ presenceTypes: FAST_ALERT_SOURCE_TYPES });
    expect(all).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
