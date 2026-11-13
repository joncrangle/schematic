import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
  type AlertDeliveryClaim,
  type AlertDeliveryClaimOutcome,
} from "~/infrastructure/storage/SubscriptionRepository";

const now = Date.parse("2026-10-16T12:00:00Z");

const subscription: PushSubscriptionRecord = {
  id: "memory-subscription",
  endpoint: "https://push.example.test/memory-subscription",
  p256dh: "fictional-p256dh",
  auth: "fictional-auth",
  favouriteLines: [],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
  commuteSchedules: [],
  timezone: "UTC",
  createdAt: now,
  updatedAt: now,
};

const claim = (ownerToken: string): AlertDeliveryClaim => ({
  agencyId: "fictional",
  alertId: "feed-alert",
  incidentKey: "v1-memory-incident",
  subscriptionId: subscription.id,
  localeScope: "en-CA",
  locale: "en-CA",
  phase: "active",
  ownerToken,
  claimedAt: now,
  expiresAt: now + 30_000,
});

const activeDelivery: AlertDeliveryClaimOutcome = {
  id: "memory-delivery",
  agencyId: "fictional",
  alertId: "feed-alert",
  incidentKey: "v1-memory-incident",
  subscriptionId: subscription.id,
  status: "active_sent",
  deliveredAt: now,
  locale: "en-CA",
};

describe("memory delivery claims", () => {
  it("atomically admits one concurrent owner and fences the loser", async () => {
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SubscriptionRepository;
      }).pipe(Effect.provide(createMemorySubscriptionRepository())),
    );
    await Effect.runPromise(repository.upsertSubscription(subscription));
    const first = claim("first-owner");
    const second = claim("second-owner");

    const results = await Promise.all([
      Effect.runPromise(repository.claimDelivery(first)),
      Effect.runPromise(repository.claimDelivery(second)),
    ]);

    expect(results).toEqual([true, false]);
    expect(await Effect.runPromise(repository.completeDeliveryClaim(first, activeDelivery))).toBe(
      true,
    );
    await Effect.runPromise(repository.releaseDeliveryClaim(second));
    expect(
      await Effect.runPromise(repository.getDelivery("fictional", "feed-alert", subscription.id)),
    ).toMatchObject({
      status: "active_sent",
    });
    expect(
      await Effect.runPromise(
        repository.claimDelivery({ ...first, ownerToken: "repeat-owner", claimedAt: now + 1 }),
      ),
    ).toBe(false);
  });

  it("lets a failed send release its claim for a later retry", async () => {
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SubscriptionRepository;
      }).pipe(Effect.provide(createMemorySubscriptionRepository())),
    );
    await Effect.runPromise(repository.upsertSubscription(subscription));
    const first = claim("failed-owner");
    expect(await Effect.runPromise(repository.claimDelivery(first))).toBe(true);
    await Effect.runPromise(repository.releaseDeliveryClaim(first));
    expect(
      await Effect.runPromise(
        repository.claimDelivery({ ...first, ownerToken: "retry-owner", claimedAt: now + 1 }),
      ),
    ).toBe(true);
  });

  it("returns only active rows for evaluator batches while keeping full history available", async () => {
    const repository = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* SubscriptionRepository;
      }).pipe(Effect.provide(createMemorySubscriptionRepository())),
    );
    await Effect.runPromise(repository.upsertSubscription(subscription));
    const clearedDelivery = {
      ...activeDelivery,
      id: "memory-cleared-delivery",
      alertId: "cleared-feed-alert",
      status: "cleared_silent" as const,
    };
    await Effect.runPromise(repository.recordDelivery(activeDelivery));
    await Effect.runPromise(repository.recordDelivery(clearedDelivery));

    expect(
      await Effect.runPromise(
        repository.getDeliveriesForSubscriptions("fictional", [subscription.id]),
      ),
    ).toEqual([activeDelivery]);
    expect(
      await Effect.runPromise(
        repository.getDeliveriesForSubscription("fictional", subscription.id),
      ),
    ).toHaveLength(2);
  });
});
