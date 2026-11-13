import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { AgencyAlert, AgencySnapshot } from "~/agencies/types";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";

const now = Date.parse("2026-10-07T08:00:00-04:00");
const subscription: PushSubscriptionRecord = {
  id: "first-device",
  endpoint: "https://push.example/first",
  p256dh: "test",
  auth: "test",
  favouriteLines: [{ agencyId: "metro", lineId: "A" }],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
  commuteSchedules: [
    { id: "morning", label: "Morning", enabled: true, days: [3], start: "07:00", end: "09:00" },
  ],
  timezone: "America/Toronto",
  // Stored at real time so retention pruning never drops the fixture.
  createdAt: Date.now(),
  updatedAt: Date.now(),
};
const alert: AgencyAlert = {
  id: "incident",
  kind: "suspension",
  scope: "line",
  severity: "severe",
  lifecycle: "active",
  affectedLineIds: ["A"],
  title: "Line A suspended",
  startsAt: now,
  updatedAt: now,
};
const snapshot = (
  alerts: readonly AgencyAlert[],
  freshness: AgencySnapshot["freshness"] = "live",
): AgencySnapshot => ({ agencyId: "metro", alerts, freshness, generatedAt: now });

describe("notification dispatch isolation and incident transitions", () => {
  it.each(["active", "recovery"] as const)(
    "continues after a thrown %s push and retries the failed device",
    async (phase) => {
      const accepted: string[] = [];
      let failing = false;
      const dependencies = Layer.merge(
        createMemorySubscriptionRepository(),
        createMockVapidClient(async (sub) => {
          if (failing && sub.id === subscription.id) throw new Error("network unavailable");
          accepted.push(sub.id);
          return { success: true, statusCode: 201, expired: false };
        }),
      );
      const layer = Layer.merge(
        dependencies,
        createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(subscription);
          yield* repo.upsertSubscription({
            ...subscription,
            id: "second-device",
            endpoint: "https://push.example/second",
          });
          if (phase === "recovery") yield* evaluator.evaluateAndDispatch(snapshot([alert]), now);
          accepted.length = 0;
          failing = true;
          const input = snapshot(phase === "active" ? [alert] : []);
          const first = yield* evaluator.evaluateAndDispatch(input, now);
          expect(accepted).toEqual(["second-device"]);
          expect(first.activePushesSent + first.clearedPushesSent).toBe(1);
          failing = false;
          accepted.length = 0;
          yield* evaluator.evaluateAndDispatch(input, now + 120_000);
          expect(accepted).toEqual(["first-device"]);
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it.each(["stale", "unavailable"] as const)(
    "preserves the incident ledger without sending from %s snapshots",
    async (freshness) => {
      let sends = 0;
      const dependencies = Layer.merge(
        createMemorySubscriptionRepository(),
        createMockVapidClient(async () => {
          sends++;
          return { success: true, statusCode: 201, expired: false };
        }),
      );
      const layer = Layer.merge(
        dependencies,
        createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(subscription);
          yield* evaluator.evaluateAndDispatch(snapshot([alert]), now);
          sends = 0;
          yield* evaluator.evaluateAndDispatch(snapshot([], freshness), now + 60_000);
          yield* evaluator.evaluateAndDispatch(
            snapshot([{ ...alert, id: "other", title: "Another closure" }], freshness),
            now + 120_000,
          );
          expect(sends).toBe(0);
          expect((yield* repo.getDelivery("metro", alert.id, subscription.id))?.status).toBe(
            "active_sent",
          );
          expect(yield* repo.getDelivery("metro", "other", subscription.id)).toBeNull();
        }).pipe(Effect.provide(layer)),
      );
    },
  );

  it("notifies a recurring incident after observing its recovery outside the commute window", async () => {
    let sends = 0;
    const dependencies = Layer.merge(
      createMemorySubscriptionRepository(),
      createMockVapidClient(async () => {
        sends++;
        return { success: true, statusCode: 201, expired: false };
      }),
    );
    const layer = Layer.merge(
      dependencies,
      createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
    );
    await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* repo.upsertSubscription(subscription);
        yield* evaluator.evaluateAndDispatch(snapshot([alert]), now);
        yield* evaluator.evaluateAndDispatch(snapshot([]), Date.parse("2026-10-07T10:00:00-04:00"));
        expect(sends).toBe(1);
        yield* evaluator.evaluateAndDispatch(
          snapshot([alert]),
          Date.parse("2026-10-14T08:00:00-04:00"),
        );
        expect(sends).toBe(2);
      }).pipe(Effect.provide(layer)),
    );
  });
});

describe("headline rewrite recovery", () => {
  it.each(["thrown", "rejected", "closed-window"] as const)(
    "keeps the incident outstanding when the replacement is %s",
    async (failure) => {
      const titles: string[] = [];
      let fail = false;
      const dependencies = Layer.merge(
        createMemorySubscriptionRepository(),
        createMockVapidClient(async (_sub, payload) => {
          if (fail && !payload.title.startsWith("✅")) {
            if (failure === "thrown") throw new Error("network unavailable");
            return { success: false, statusCode: 503, expired: false };
          }
          titles.push(payload.title);
          return { success: true, statusCode: 201, expired: false };
        }),
      );
      const layer = Layer.merge(
        dependencies,
        createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies)),
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const evaluator = yield* AlertEvaluatorService;
          yield* repo.upsertSubscription(subscription);
          yield* evaluator.evaluateAndDispatch(snapshot([alert]), now);
          titles.length = 0;
          fail = true;
          const rewritten = { ...alert, title: "Line A suspended at East Terminal" };
          yield* evaluator.evaluateAndDispatch(
            snapshot([rewritten]),
            failure === "closed-window" ? Date.parse("2026-10-07T10:00:00-04:00") : now + 60_000,
          );
          expect(titles).toEqual([]);
          expect((yield* repo.getDelivery("metro", alert.id, subscription.id))?.status).toBe(
            "active_sent",
          );
          fail = false;
          const retryAt = now + (failure === "closed-window" ? 120_000 : 180_000);
          const retry = yield* evaluator.evaluateAndDispatch(snapshot([rewritten]), retryAt);
          expect(retry.activePushesSent).toBe(1);
          expect(retry.clearedPushesSent).toBe(0);
          const recovered = yield* evaluator.evaluateAndDispatch(snapshot([]), retryAt + 60_000);
          expect(recovered.clearedPushesSent).toBe(1);
        }).pipe(Effect.provide(layer)),
      );
    },
  );
});
