import { afterEach, describe, expect, it, vi } from "vitest";
import { Effect, Layer } from "effect";
import type { AgencySnapshot } from "~/agencies/types";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  createMockVapidClient,
  type SendPushResult,
} from "~/infrastructure/notifications/VapidClient";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";

const baseTime = Date.parse("2026-10-16T12:00:00Z");

const subscription: PushSubscriptionRecord = {
  id: "retry-device",
  endpoint: "https://push.example.test/retry-device",
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

const snapshot: AgencySnapshot = {
  agencyId: "fictional",
  generatedAt: baseTime,
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
      updatedAt: baseTime,
    },
  ],
};

async function makeServices(send: () => Promise<SendPushResult>) {
  const repositoryLayer = createMemorySubscriptionRepository();
  const dependencies = Layer.merge(repositoryLayer, createMockVapidClient(send));
  const layer = createLiveAlertEvaluatorService().pipe(Layer.provide(dependencies));
  const services = await Effect.runPromise(
    Effect.gen(function* () {
      return {
        repository: yield* SubscriptionRepository,
        evaluator: yield* AlertEvaluatorService,
      };
    }).pipe(Effect.provide(Layer.merge(dependencies, layer))),
  );
  await Effect.runPromise(services.repository.upsertSubscription(subscription));
  return services;
}

afterEach(() => {
  vi.useRealTimers();
});

describe("push rejection retry policy", () => {
  it.each([400, 403])(
    "backs off repeated hard %s rejections across scheduler ticks",
    async (status) => {
      vi.useFakeTimers();
      vi.setSystemTime(baseTime);
      const send = vi.fn(async () => ({ success: false, expired: false, statusCode: status }));
      const { evaluator, repository } = await makeServices(send);

      await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime));
      vi.setSystemTime(baseTime + 60_000);
      await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + 60_000));

      expect(send).toHaveBeenCalledTimes(1);
      expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
        { pushRetryCount: 1, pushHardFailureCount: 1, pushRetryAt: baseTime + 120_000 },
      ]);
    },
  );

  it("prunes after five hard failures spaced by exponential backoff", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const send = vi.fn(async () => ({ success: false, expired: false, statusCode: 400 }));
    const { evaluator, repository } = await makeServices(send);
    let rejectedSubscriptionsPruned = 0;

    for (const minutes of [0, 2, 6, 14, 30]) {
      vi.setSystemTime(baseTime + minutes * 60_000);
      const summary = await Effect.runPromise(
        evaluator.evaluateAndDispatch(snapshot, baseTime + minutes * 60_000),
      );
      rejectedSubscriptionsPruned = summary.rejectedSubscriptionsPruned;
    }

    expect(send).toHaveBeenCalledTimes(5);
    expect(rejectedSubscriptionsPruned).toBe(1);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toEqual([]);
    await Effect.runPromise(repository.upsertSubscription(subscription));
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toEqual([]);
  });

  it("backs off 5xx and honors 429 Retry-After without counting them toward pruning", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const send = vi
      .fn<() => Promise<SendPushResult>>()
      .mockResolvedValueOnce({
        success: false,
        expired: false,
        statusCode: 503,
      })
      .mockResolvedValueOnce({
        success: false,
        expired: false,
        statusCode: 429,
        retryAfterAt: baseTime + 10 * 60_000,
      })
      .mockResolvedValue({ success: true, expired: false, statusCode: 201 });
    const { evaluator, repository } = await makeServices(send);

    await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime));
    vi.setSystemTime(baseTime + 60_000);
    await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + 60_000));
    expect(send).toHaveBeenCalledTimes(1);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 1, pushHardFailureCount: 0, pushRetryAt: baseTime + 120_000 },
    ]);

    vi.setSystemTime(baseTime + 120_000);
    await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + 120_000));
    expect(send).toHaveBeenCalledTimes(2);
    vi.setSystemTime(baseTime + 9 * 60_000);
    await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + 9 * 60_000));
    expect(send).toHaveBeenCalledTimes(2);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 2, pushHardFailureCount: 0, pushRetryAt: baseTime + 10 * 60_000 },
    ]);

    vi.setSystemTime(baseTime + 10 * 60_000);
    await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + 10 * 60_000));
    expect(send).toHaveBeenCalledTimes(3);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 0, pushHardFailureCount: 0, pushRetryAt: 0 },
    ]);
  });

  it("resets the hard-failure streak after a transient rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const send = vi
      .fn<() => Promise<SendPushResult>>()
      .mockResolvedValueOnce({ success: false, expired: false, statusCode: 400 })
      .mockResolvedValueOnce({ success: false, expired: false, statusCode: 503 })
      .mockResolvedValue({ success: false, expired: false, statusCode: 400 });
    const { evaluator, repository } = await makeServices(send);

    for (const minutes of [0, 2, 6]) {
      vi.setSystemTime(baseTime + minutes * 60_000);
      await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + minutes * 60_000));
    }

    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 3, pushHardFailureCount: 1, pushRetryAt: baseTime + 14 * 60_000 },
    ]);
  });

  it("caps exponential retry waits at one hour", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const send = vi.fn(async () => ({ success: false, expired: false, statusCode: 503 }));
    const { evaluator, repository } = await makeServices(send);

    for (const minutes of [0, 2, 6, 14, 30, 62, 122]) {
      vi.setSystemTime(baseTime + minutes * 60_000);
      await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + minutes * 60_000));
    }

    expect(send).toHaveBeenCalledTimes(7);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 7, pushHardFailureCount: 0, pushRetryAt: baseTime + 182 * 60_000 },
    ]);
  });

  it("backs off explicit VAPID credential errors without pruning the endpoint", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const send = vi.fn(async () => ({
      success: false,
      expired: false,
      statusCode: 403,
      credentialFailure: true,
    }));
    const { evaluator, repository } = await makeServices(send);

    for (const minutes of [0, 2, 6, 14, 30]) {
      vi.setSystemTime(baseTime + minutes * 60_000);
      await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + minutes * 60_000));
    }

    expect(send).toHaveBeenCalledTimes(5);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 5, pushHardFailureCount: 0 },
    ]);
  });

  it("does not prune subscriptions on a bare 401 authorization rejection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(baseTime);
    const send = vi.fn(async () => ({ success: false, expired: false, statusCode: 401 }));
    const { evaluator, repository } = await makeServices(send);

    for (const minutes of [0, 2, 6, 14, 30, 62]) {
      vi.setSystemTime(baseTime + minutes * 60_000);
      await Effect.runPromise(evaluator.evaluateAndDispatch(snapshot, baseTime + minutes * 60_000));
    }

    expect(send).toHaveBeenCalledTimes(6);
    expect(await Effect.runPromise(repository.getActiveSubscriptions())).toMatchObject([
      { pushRetryCount: 6, pushHardFailureCount: 0 },
    ]);
  });
});
