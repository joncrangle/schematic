vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { loadDatabaseSync } from "../helpers/sqlite-fixture";
import {
  captureServerEnvChannels,
  clearServerEnvChannels,
  setGlobalEnvChannel,
} from "../helpers/env-channels";
import {
  createNodeSqliteBinding,
  type D1DatabaseBinding,
} from "~/infrastructure/storage/RuntimeBindings";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  allProviders,
  dangerouslyRegisterProvider,
  dangerouslyResetProviders,
} from "~/agencies/registry";
import { agencyTaskRunner } from "~/services/AgencyTaskRunner";
import {
  FAST_ALERT_SOURCE_TYPES,
  runEvaluationCycle,
  resetSchedulerForTests,
} from "~/services/notifications/ProductionScheduler";
const { notificationDb } = vi.hoisted(() => ({
  notificationDb: { current: undefined as D1DatabaseBinding | undefined },
}));
vi.mock("~/infrastructure/storage/SubscriptionRepository", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/infrastructure/storage/SubscriptionRepository")>();
  return {
    ...actual,
    createLiveNotificationsRepositoryLayer: (
      options: Parameters<typeof actual.createLiveNotificationsRepositoryLayer>[0],
    ) => {
      if (!notificationDb.current) throw new Error("Missing integration database");
      return Layer.succeed(
        actual.SubscriptionRepository,
        actual.makeD1SubscriptionRepositoryService(notificationDb.current, {
          fallbackTimezone: "UTC",
          queryBudget: options?.queryBudget,
        }),
      );
    },
  };
});
vi.mock("~/infrastructure/logging/logger", () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), getLevel: () => "none" },
}));
const DatabaseSync = await loadDatabaseSync();
const vapidVarNames = ["VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"] as const;
const restoreEnvChannels = captureServerEnvChannels(vapidVarNames);
afterEach(async () => {
  restoreEnvChannels();
  await resetSchedulerForTests();
  dangerouslyResetProviders();
  notificationDb.current = undefined;
  vi.restoreAllMocks();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
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

describe.skipIf(!DatabaseSync)("Workers recipient fairness against SQLite", () => {
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

  it("serves all 45 recipients across D1 budget-limited Workers ticks", async () => {
    workerSetup();
    dangerouslyRegisterProvider(
      makeTestProvider({
        id: "fairness-target",
        alerts: [
          {
            type: "json",
            parser: "generic-alert-feed",
            url: "https://example.test/fairness-target",
          },
        ],
      }),
    );
    const runtimeModule = await import("~/services/AgencyRuntime");
    const createRuntime = runtimeModule.createAgencyRuntime;
    vi.spyOn(runtimeModule, "createAgencyRuntime").mockImplementation((provider, options) => ({
      ...createRuntime(provider, options),
      hasSnapshot: true,
      getSnapshot: async () => ({
        agencyId: provider.manifest.id,
        generatedAt: 0,
        freshness: "live",
        alerts: [
          {
            id: "budget-incident-one",
            title: "Line A service suspended",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            scope: "line",
            affectedLineIds: ["1"],
            startsAt: 0,
            updatedAt: 0,
          },
          {
            id: "budget-incident-two",
            title: "Line A service disruption",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            scope: "line",
            affectedLineIds: ["1"],
            startsAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    }));
    const schedule = {
      id: "all-day",
      label: "All day",
      enabled: true,
      days: [0, 1, 2, 3, 4, 5, 6],
      start: "00:00",
      end: "23:59",
    } as const;
    const subscribers = Array.from({ length: 45 }, (_, index) => ({
      ...scheduledSubscriber(["fairness-target"]),
      id: `fairness-recipient-${index}`,
      endpoint: `https://example.test/fairness-recipient-${index}`,
      timezone: "UTC",
      commuteSchedules: [schedule],
    }));
    const { SubscriptionRepository, makeD1SubscriptionRepositoryService } =
      await import("~/infrastructure/storage/SubscriptionRepository");
    const { AlertEvaluatorService, createLiveAlertEvaluatorService } =
      await import("~/services/notifications/AlertEvaluatorService");
    const { createMockVapidClient } = await import("~/infrastructure/notifications/VapidClient");
    const db = await createNodeSqliteBinding(":memory:", DatabaseSync!);
    const repository = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
    for (const subscription of subscribers)
      await Effect.runPromise(repository.upsertSubscription(subscription));
    notificationDb.current = db;
    const attempted = new Map<string, Set<string>>();
    const evaluatorLayer = createLiveAlertEvaluatorService().pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(SubscriptionRepository, repository),
          createMockVapidClient(async (subscription, payload) => {
            const alerts = attempted.get(subscription.id) ?? new Set<string>();
            alerts.add(payload.data?.alertId ?? "");
            attempted.set(subscription.id, alerts);
            return { success: true, statusCode: 201, expired: false };
          }),
        ),
      ),
    );
    const evaluator = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AlertEvaluatorService;
      }).pipe(Effect.provide(evaluatorLayer)),
    );
    let processedThisTick = 0;
    vi.spyOn(agencyTaskRunner, "getEvaluationStackEffect").mockReturnValue(
      Effect.succeed({ evaluator }),
    );
    vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockImplementation(
      (_provider, snapshot, options) =>
        Effect.runPromise(
          evaluator.evaluateAndDispatch(snapshot, Date.now(), {
            ...options,
            onRecipientProcessed: (agencyId, subscriptionId) => {
              processedThisTick += 1;
              options?.onRecipientProcessed?.(agencyId, subscriptionId);
            },
          }),
        ),
    );
    const base = Date.parse("2026-10-14T12:00:00Z");
    let tick = 0;
    vi.spyOn(Date, "now").mockImplementation(() => base + tick * 60_000);

    // Two incidents now cost six claim/outcome queries per recipient.
    for (
      ;
      tick < 10 &&
      (attempted.size < subscribers.length ||
        [...attempted.values()].some((alerts) => alerts.size < 2));
      tick += 1
    ) {
      const cursorBefore = await Effect.runPromise(
        repository.getRecipientRotationCursor("evaluate-alerts"),
      );
      processedThisTick = 0;
      await runEvaluationCycle({
        presenceTypes: FAST_ALERT_SOURCE_TYPES,
        onAggregate: "swallow+debug",
      });
      const cursorAfter = await Effect.runPromise(
        repository.getRecipientRotationCursor("evaluate-alerts"),
      );
      expect(cursorAfter).toBe(cursorBefore + Math.max(1, processedThisTick));
      expect(tick === 0 ? attempted.size < subscribers.length : true).toBe(true);
    }

    expect(attempted.size).toBe(45);
    for (const alerts of attempted.values())
      expect(alerts).toEqual(new Set(["budget-incident-one", "budget-incident-two"]));
    const deliveries = await db
      .prepare("SELECT subscription_id, alert_id FROM alert_deliveries WHERE agency_id = ?")
      .bind("fairness-target")
      .all<{ subscription_id: string; alert_id: string }>();
    expect(deliveries.results).toHaveLength(90);
  });

  it.each([
    { mixedLocales: false, delayedProvider: false },
    { mixedLocales: true, delayedProvider: false },
    { mixedLocales: true, delayedProvider: true },
  ])(
    "visits every recipient despite sustained rejections and target changes with mixed locales $mixedLocales and delayed provider $delayedProvider",
    async ({ mixedLocales, delayedProvider }) => {
      workerSetup();
      const providers = [...allProviders()];
      const ids = providers.map((provider) => provider.manifest.id);
      const runtimeModule = await import("~/services/AgencyRuntime");
      const createRuntime = runtimeModule.createAgencyRuntime;
      vi.spyOn(runtimeModule, "createAgencyRuntime").mockImplementation((provider, options) => ({
        ...createRuntime(provider, options),
        hasSnapshot: true,
        getSnapshot: async () => {
          if (delayedProvider && provider.manifest.id === ids[0])
            await new Promise<void>((resolve) => setTimeout(resolve, 0));
          return {
            agencyId: provider.manifest.id,
            generatedAt: 0,
            freshness: "live",
            alerts: [
              {
                id: "ongoing",
                title: "Line 1 suspended",
                kind: "suspension",
                severity: "severe",
                lifecycle: "active",
                scope: "line",
                affectedLineIds: ["1"],
                startsAt: 0,
                updatedAt: 0,
              },
            ],
          };
        },
      }));
      const { SubscriptionRepository, createMemorySubscriptionRepository } =
        await import("~/infrastructure/storage/SubscriptionRepository");
      const { makeD1SubscriptionRepositoryService } =
        await import("~/infrastructure/storage/SubscriptionRepository");
      const { AlertEvaluatorService, createLiveAlertEvaluatorService } =
        await import("~/services/notifications/AlertEvaluatorService");
      const { createMockVapidClient } = await import("~/infrastructure/notifications/VapidClient");
      const repository = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* SubscriptionRepository;
        }).pipe(Effect.provide(createMemorySubscriptionRepository())),
      );
      const attempted = new Map<string, Set<string>>();
      const transport = createMockVapidClient(async (sub, payload, options) => {
        const agencyId = payload.data!.agencyId!;
        const seen = attempted.get(agencyId) ?? new Set<string>();
        seen.add(sub.id);
        attempted.set(agencyId, seen);
        // One attempt consumes the invocation's whole transport capacity before
        // other concurrent agencies can start an attempt. Every service rejects.
        await Promise.all(Array.from({ length: 49 }, () => options!.fetch!(sub.endpoint)));
        return { success: false, expired: false, statusCode: 503 };
      });
      const evaluator = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* AlertEvaluatorService;
        }).pipe(
          Effect.provide(
            createLiveAlertEvaluatorService().pipe(
              Layer.provide(
                Layer.merge(Layer.succeed(SubscriptionRepository, repository), transport),
              ),
            ),
          ),
        ),
      );
      vi.spyOn(agencyTaskRunner, "evaluateSnapshot").mockImplementation(
        (_provider, snapshot, options) =>
          Effect.runPromise(
            evaluator.evaluateAndDispatch(snapshot, undefined, {
              ...options,
              repository,
            }),
          ),
      );
      const subscribers = (agencyIds: readonly string[], count: number) =>
        Array.from({ length: count }, (_, index) => ({
          ...scheduledSubscriber(agencyIds),
          id: `recipient-${index}`,
          locale: mixedLocales && index % 2 === 0 ? ("fr-CA" as const) : ("en-CA" as const),
          endpoint: `https://example.test/recipient-${index}`,
          timezone: "UTC",
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
        }));
      let subscriptions = subscribers(ids, providers.length);
      const cursorDb = await createNodeSqliteBinding(":memory:", DatabaseSync!);
      const cursorRepository = makeD1SubscriptionRepositoryService(cursorDb, {
        fallbackTimezone: "UTC",
      });
      await Effect.runPromise(cursorRepository.getActiveSubscriptions());
      const syncSubscriptions = async (records: readonly PushSubscriptionRecord[]) => {
        await cursorDb.exec("DELETE FROM push_subscriptions");
        for (const record of records)
          await Effect.runPromise(cursorRepository.upsertSubscription(record));
      };
      await syncSubscriptions(subscriptions);
      notificationDb.current = cursorDb;
      let tick = 0;
      const base = 60_000 * providers.length * Math.floor(Date.now() / (60_000 * providers.length));
      vi.spyOn(Date, "now").mockImplementation(() => base + tick * 60_000);
      for (; tick < providers.length ** 2; tick++) {
        await runEvaluationCycle();
        expect(
          await Effect.runPromise(cursorRepository.getRecipientRotationCursor("evaluate-alerts")),
        ).toBe(tick + 1);
      }
      for (const id of ids) expect(attempted.get(id)?.size).toBe(providers.length);
      attempted.clear();
      subscriptions = subscribers(ids.slice(1), providers.length + 1);
      await syncSubscriptions(subscriptions);
      const end = tick + providers.length * (providers.length + 1);
      for (; tick < end; tick++) await runEvaluationCycle();
      expect(
        await Effect.runPromise(cursorRepository.getRecipientRotationCursor("evaluate-alerts")),
      ).toBe(end);
      expect(attempted.has(ids[0]!)).toBe(false);
      for (const id of ids.slice(1)) expect(attempted.get(id)?.size).toBe(providers.length + 1);
    },
  );
  it("scopes batched delivery history to the selected agency and recipients", async () => {
    const { makeD1SubscriptionRepositoryService } =
      await import("~/infrastructure/storage/SubscriptionRepository");
    const db = await createNodeSqliteBinding(":memory:", DatabaseSync!);
    const repo = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
    for (const id of ["selected", "other"])
      await Effect.runPromise(
        repo.upsertSubscription({
          ...scheduledSubscriber(["agency-a", "agency-b"]),
          id,
          endpoint: `https://example.test/${id}`,
        }),
      );
    for (const [id, agencyId, subscriptionId] of [
      ["kept", "agency-a", "selected"],
      ["other-agency", "agency-b", "selected"],
      ["other-recipient", "agency-a", "other"],
    ]) {
      await Effect.runPromise(
        repo.recordDelivery({
          id,
          agencyId,
          subscriptionId,
          alertId: id,
          incidentKey: id,
          status: "active_sent",
          deliveredAt: Date.now(),
        }),
      );
    }
    const rows = await Effect.runPromise(
      repo.getDeliveriesForSubscriptions("agency-a", ["selected"]),
    );
    expect(rows.map((row) => row.id)).toEqual(["kept"]);
  });

  it("advances an observed recipient cursor only once across concurrent updates", async () => {
    const { makeD1SubscriptionRepositoryService } =
      await import("~/infrastructure/storage/SubscriptionRepository");
    const db = await createNodeSqliteBinding(":memory:", DatabaseSync!);
    const repo = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
    expect(await Effect.runPromise(repo.getRecipientRotationCursor("evaluate-alerts"))).toBe(0);
    const reserve = repo.reserveRecipientRotationCursorAdvance;
    if (!reserve) throw new Error("Expected the SQL repository to reserve cursor updates");
    const first = await Effect.runPromise(reserve());
    const second = await Effect.runPromise(reserve());
    try {
      await Promise.all([
        Effect.runPromise(first.advance("evaluate-alerts", 0, 2)),
        Effect.runPromise(second.advance("evaluate-alerts", 0, 3)),
      ]);
      expect([2, 3]).toContain(
        await Effect.runPromise(repo.getRecipientRotationCursor("evaluate-alerts")),
      );
    } finally {
      first.release();
      second.release();
    }
  });
});
