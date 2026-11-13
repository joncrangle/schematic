import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { AgencySnapshot } from "~/agencies/types";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
  makeD1SubscriptionRepositoryService,
} from "~/infrastructure/storage/SubscriptionRepository";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";
import { createMemoryD1 } from "../helpers/memoryD1";

const baseTime = Date.parse("2026-10-16T12:00:00Z");

const subscription: PushSubscriptionRecord = {
  id: "sql-retry-device",
  endpoint: "https://push.example.test/sql-retry-device",
  p256dh: "fictional-p256dh",
  auth: "fictional-auth",
  favouriteLines: [{ agencyId: "fictional", lineId: "A" }],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
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
  timezone: "UTC",
  createdAt: baseTime,
  updatedAt: baseTime,
};

function snapshotAt(now: number): AgencySnapshot {
  return {
    agencyId: "fictional",
    generatedAt: now,
    freshness: "live",
    alerts: [
      {
        id: "incident",
        title: "Line A suspended",
        kind: "suspension",
        severity: "severe",
        lifecycle: "active",
        scope: "line",
        affectedLineIds: ["A"],
        startsAt: baseTime,
        updatedAt: now,
      },
    ],
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("SQL push rejection policy", () => {
  it.each(["sqlite", "memory"])(
    "checks %s backoff when another agency holds an older subscription snapshot",
    async (adapter) => {
      vi.useFakeTimers();
      vi.setSystemTime(baseTime);
      const repository =
        adapter === "sqlite"
          ? makeD1SubscriptionRepositoryService(await createMemoryD1(), { fallbackTimezone: "UTC" })
          : await Effect.runPromise(
              Effect.gen(function* () {
                return yield* SubscriptionRepository;
              }).pipe(Effect.provide(createMemorySubscriptionRepository())),
            );
      const sub = {
        ...subscription,
        favouriteLines: [...subscription.favouriteLines, { agencyId: "second", lineId: "A" }],
      };
      await Effect.runPromise(repository.upsertSubscription(sub));
      const send = vi.fn(async () => ({ success: false, expired: false, statusCode: 503 }));
      const evaluator = await Effect.runPromise(
        Effect.gen(function* () {
          return yield* AlertEvaluatorService;
        }).pipe(
          Effect.provide(
            createLiveAlertEvaluatorService().pipe(
              Layer.provide(
                Layer.merge(
                  Layer.succeed(SubscriptionRepository, repository),
                  createMockVapidClient(send),
                ),
              ),
            ),
          ),
        ),
      );
      const options = { repository, subscriptions: [sub] };
      await Effect.runPromise(
        evaluator.evaluateAndDispatch(snapshotAt(baseTime), baseTime, options),
      );
      const second = { ...snapshotAt(baseTime), agencyId: "second" };
      await Effect.runPromise(evaluator.evaluateAndDispatch(second, baseTime, options));
      expect(send).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(120_000);
      await Effect.runPromise(evaluator.evaluateAndDispatch(second, baseTime + 120_000, options));
      expect(send).toHaveBeenCalledTimes(2);
    },
  );

  it("persists backoff across repository instances and tombstones after five hard failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const db = await createMemoryD1();
    const firstRepository = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
    const send = vi.fn(async () => ({ success: false, expired: false, statusCode: 400 }));
    const dependencies = Layer.merge(
      Layer.succeed(SubscriptionRepository, firstRepository),
      createMockVapidClient(send),
    );
    const evaluatorLayer = createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies));
    const evaluator = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* AlertEvaluatorService;
      }).pipe(Effect.provide(evaluatorLayer)),
    );
    await Effect.runPromise(firstRepository.upsertSubscription(subscription));

    const offsets = [0, 2, 6, 14, 30];
    let repository = firstRepository;
    let rejectedSubscriptionsPruned = 0;
    let retryAtTwoMinutes: readonly unknown[] = [];
    for (const minutes of offsets) {
      const now = baseTime + minutes * 60_000;
      vi.setSystemTime(now);
      repository = makeD1SubscriptionRepositoryService(db, { fallbackTimezone: "UTC" });
      const subscriptions = await Effect.runPromise(repository.getActiveSubscriptions());
      if (minutes === 2) retryAtTwoMinutes = subscriptions;
      const summary = await Effect.runPromise(
        evaluator.evaluateAndDispatch(snapshotAt(now), now, {
          repository,
          subscriptions,
        }),
      );
      rejectedSubscriptionsPruned = summary.rejectedSubscriptionsPruned;
    }

    expect(send).toHaveBeenCalledTimes(5);
    expect(retryAtTwoMinutes).toMatchObject([
      {
        id: subscription.id,
        pushRetryCount: 1,
        pushHardFailureCount: 1,
        pushRetryAt: baseTime + 2 * 60_000,
      },
    ]);
    expect(rejectedSubscriptionsPruned).toBe(1);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toEqual([]);
    await Effect.runPromise(repository.upsertSubscription(subscription));
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toEqual([]);
  });
});
