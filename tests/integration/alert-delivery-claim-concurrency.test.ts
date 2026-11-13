import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import type { AgencyAlert, AgencySnapshot } from "~/agencies/types";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
  makeD1SubscriptionRepositoryService,
  type SubscriptionRepositoryService,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";
import {
  createInvocationBudget,
  InvocationBudgetExceeded,
} from "~/infrastructure/http/InvocationIo";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";

const DatabaseSync = await loadDatabaseSync();
const now = Date.parse("2026-10-16T12:00:00Z");

const subscription: PushSubscriptionRecord = {
  id: "sub-race",
  endpoint: "https://push.example.test/sub-race",
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
  locale: "en-CA",
  // Stored at real time so retention pruning never drops the fixture.
  createdAt: Date.now(),
  updatedAt: Date.now(),
};

const activeAlert: AgencyAlert = {
  id: "feed-alert",
  title: "Line A suspended",
  description: "A signal problem",
  kind: "suspension",
  severity: "severe",
  lifecycle: "active",
  scope: "line",
  affectedLineIds: ["A"],
  startsAt: now,
  updatedAt: now,
};

const liveSnapshot: AgencySnapshot = {
  agencyId: "fictional",
  generatedAt: now,
  freshness: "live",
  alerts: [activeAlert],
};

const churnedSnapshot: AgencySnapshot = {
  ...liveSnapshot,
  alerts: [{ ...activeAlert, id: "feed-alert-after-id-churn" }],
};

function pauseBothHistoryReads(repository: SubscriptionRepositoryService) {
  let historyReads = 0;
  let releaseReads!: () => void;
  let bothReadsReady!: () => void;
  const readBarrier = new Promise<void>((resolve) => {
    releaseReads = resolve;
  });
  const bothReads = new Promise<void>((resolve) => {
    bothReadsReady = resolve;
  });

  const racingRepository: SubscriptionRepositoryService = {
    ...repository,
    getDeliveriesForSubscriptions: (agencyId, subscriptionIds) =>
      Effect.flatMap(repository.getDeliveriesForSubscriptions(agencyId, subscriptionIds), (rows) =>
        Effect.promise(async () => {
          historyReads += 1;
          if (historyReads === 2) {
            bothReadsReady();
            releaseReads();
          }
          await readBarrier;
          return rows;
        }),
      ),
  };

  return { repository: racingRepository, bothReads };
}

describe.skipIf(!DatabaseSync)("atomic delivery claims", () => {
  it("sends one active push across concurrent evaluations and upstream ID churn", async () => {
    const binding = await createNodeSqliteBinding(
      makeTempDbPath("ttc-delivery-claim-"),
      DatabaseSync!,
    );
    const repositoryLayer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "UTC",
    });
    let enteredTransport = 0;
    let firstTransportStarted!: () => void;
    let secondTransportStarted!: () => void;
    let releaseTransport!: () => void;
    const firstTransport = new Promise<void>((resolve) => {
      firstTransportStarted = resolve;
    });
    const secondTransport = new Promise<void>((resolve) => {
      secondTransportStarted = resolve;
    });
    const transportBarrier = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const pushLayer = createMockVapidClient(async () => {
      enteredTransport += 1;
      if (enteredTransport === 1) firstTransportStarted();
      if (enteredTransport === 2) secondTransportStarted();
      await transportBarrier;
      return { success: true, expired: false, statusCode: 201 };
    });
    const layer = Layer.merge(
      createLiveAlertEvaluatorService(),
      Layer.merge(repositoryLayer, pushLayer),
    ).pipe(Layer.provide(Layer.merge(repositoryLayer, pushLayer)));

    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* SubscriptionRepository;
        yield* repository.upsertSubscription(subscription);
        return { repository, evaluator: yield* AlertEvaluatorService };
      }).pipe(Effect.provide(layer)),
    );
    const { repository, bothReads } = pauseBothHistoryReads(setup.repository);
    const options = {
      subscriptions: [subscription],
      outstandingSubscriptionIds: [],
      repository,
    } as const;

    const first = Effect.runPromise(
      setup.evaluator.evaluateAndDispatch(liveSnapshot, now, options),
    );
    const second = Effect.runPromise(
      setup.evaluator.evaluateAndDispatch(churnedSnapshot, now, options),
    );

    try {
      await bothReads;
      await firstTransport;
      await Promise.race([second, secondTransport]);
      const transportsBeforeRelease = enteredTransport;
      releaseTransport();
      await Promise.all([first, second]);

      expect(transportsBeforeRelease).toBe(1);
      const deliveries = await Effect.runPromise(
        setup.repository.getDeliveriesForSubscription("fictional", subscription.id),
      );
      expect(deliveries).toHaveLength(1);
      expect(deliveries[0]).toMatchObject({
        agencyId: "fictional",
        incidentKey: expect.stringMatching(/^v1-/),
        status: "active_sent",
      });
    } finally {
      releaseTransport();
    }
  });

  it("keeps accepted active history while concurrent recovery claims are pending", async () => {
    const binding = await createNodeSqliteBinding(
      makeTempDbPath("ttc-recovery-claim-"),
      DatabaseSync!,
    );
    const repositoryLayer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "UTC",
    });
    let enteredTransport = 0;
    let firstTransportStarted!: () => void;
    let secondTransportStarted!: () => void;
    let releaseTransport!: () => void;
    const firstTransport = new Promise<void>((resolve) => {
      firstTransportStarted = resolve;
    });
    const secondTransport = new Promise<void>((resolve) => {
      secondTransportStarted = resolve;
    });
    const transportBarrier = new Promise<void>((resolve) => {
      releaseTransport = resolve;
    });
    const pushLayer = createMockVapidClient(async () => {
      enteredTransport += 1;
      if (enteredTransport === 1) firstTransportStarted();
      if (enteredTransport === 2) secondTransportStarted();
      await transportBarrier;
      return { success: true, expired: false, statusCode: 201 };
    });
    const layer = Layer.merge(
      createLiveAlertEvaluatorService(),
      Layer.merge(repositoryLayer, pushLayer),
    ).pipe(Layer.provide(Layer.merge(repositoryLayer, pushLayer)));
    const activeDelivery = {
      id: "accepted-active",
      agencyId: "fictional",
      alertId: activeAlert.id,
      incidentKey: "recovery-incident",
      subscriptionId: subscription.id,
      lineId: "A",
      status: "active_sent" as const,
      deliveredAt: now - 60_000,
      locale: "en-CA" as const,
    };

    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* SubscriptionRepository;
        yield* repository.upsertSubscription(subscription);
        yield* repository.recordDelivery(activeDelivery);
        return { repository, evaluator: yield* AlertEvaluatorService };
      }).pipe(Effect.provide(layer)),
    );
    const { repository, bothReads } = pauseBothHistoryReads(setup.repository);
    const options = {
      subscriptions: [subscription],
      outstandingSubscriptionIds: [subscription.id],
      repository,
    } as const;
    const endedSnapshot: AgencySnapshot = {
      ...liveSnapshot,
      alerts: [],
    };

    const first = Effect.runPromise(
      setup.evaluator.evaluateAndDispatch(endedSnapshot, now, options),
    );
    const second = Effect.runPromise(
      setup.evaluator.evaluateAndDispatch(endedSnapshot, now, options),
    );

    try {
      await bothReads;
      await firstTransport;
      await Promise.race([second, secondTransport]);
      expect(enteredTransport).toBe(1);
      expect(
        (
          await Effect.runPromise(
            setup.repository.getDelivery("fictional", activeAlert.id, subscription.id),
          )
        )?.status,
      ).toBe("active_sent");
      releaseTransport();
      await Promise.all([first, second]);
      expect(
        (
          await Effect.runPromise(
            setup.repository.getDelivery("fictional", activeAlert.id, subscription.id),
          )
        )?.status,
      ).toBe("cleared_sent");
    } finally {
      releaseTransport();
    }
  });

  it("fences stale owners from completing or releasing a replacement claim", async () => {
    const binding = await createNodeSqliteBinding(
      makeTempDbPath("ttc-stale-claim-"),
      DatabaseSync!,
    );
    const repositoryLayer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "UTC",
    });
    const claims = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* SubscriptionRepository;
        yield* repository.upsertSubscription(subscription);
        const first = {
          agencyId: "fictional",
          alertId: activeAlert.id,
          incidentKey: "fenced-incident",
          subscriptionId: subscription.id,
          localeScope: "en-CA",
          locale: "en-CA",
          phase: "active" as const,
          ownerToken: "first-owner",
          claimedAt: 1_000,
          expiresAt: 1_100,
        };
        const replacement = {
          ...first,
          ownerToken: "replacement-owner",
          claimedAt: 1_101,
          expiresAt: 1_201,
        };
        expect(yield* repository.claimDelivery(first)).toBe(true);
        expect(yield* repository.claimDelivery(replacement)).toBe(true);

        const delivery = {
          id: "stale-outcome",
          agencyId: first.agencyId,
          alertId: first.alertId,
          incidentKey: first.incidentKey,
          subscriptionId: first.subscriptionId,
          status: "active_sent" as const,
          deliveredAt: now,
          locale: "en-CA" as const,
        };
        expect(yield* repository.completeDeliveryClaim(first, delivery)).toBe(false);
        yield* repository.releaseDeliveryClaim(first);

        expect(
          yield* repository.claimDelivery({
            ...replacement,
            ownerToken: "third-owner",
            claimedAt: 1_150,
            expiresAt: 1_250,
          }),
        ).toBe(false);
        expect(yield* repository.completeDeliveryClaim(replacement, delivery)).toBe(true);
        return yield* repository.getDelivery("fictional", activeAlert.id, subscription.id);
      }).pipe(Effect.provide(repositoryLayer)),
    );

    expect(claims?.status).toBe("active_sent");
  });

  it("preserves locale-specific and declared cross-locale incident dedupe", async () => {
    const binding = await createNodeSqliteBinding(
      makeTempDbPath("ttc-locale-claim-"),
      DatabaseSync!,
    );
    const repositoryLayer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "UTC",
    });
    const outcomes = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* SubscriptionRepository;
        yield* repository.upsertSubscription(subscription);
        yield* repository.recordDelivery({
          id: "legacy-english",
          agencyId: "fictional",
          alertId: "legacy-alert",
          incidentKey: "v1-locale-incident",
          subscriptionId: subscription.id,
          status: "active_sent",
          deliveredAt: now,
          locale: "en-CA",
        });

        const frenchActiveClaim = {
          agencyId: "fictional",
          alertId: "legacy-alert-after-churn",
          incidentKey: "v1-locale-incident",
          subscriptionId: subscription.id,
          localeScope: "fr-CA",
          locale: "fr-CA",
          phase: "active" as const,
          ownerToken: "french-owner",
          claimedAt: 2_000,
          expiresAt: 32_000,
        };
        const frenchRecoveryClaim = {
          ...frenchActiveClaim,
          phase: "recovery" as const,
          ownerToken: "french-recovery-owner",
        };
        const englishRecoveryClaim = {
          ...frenchRecoveryClaim,
          alertId: "legacy-alert",
          localeScope: "en-CA",
          locale: "en-CA",
          ownerToken: "english-recovery-owner",
        };
        const frenchAllowed = yield* repository.claimDelivery(frenchActiveClaim);
        yield* repository.releaseDeliveryClaim(frenchActiveClaim);
        const frenchRecoveryAllowed = yield* repository.claimDelivery(frenchRecoveryClaim);
        const englishRecoveryAllowed = yield* repository.claimDelivery(englishRecoveryClaim);
        yield* repository.releaseDeliveryClaim(englishRecoveryClaim);

        yield* repository.recordDelivery({
          id: "declared-english",
          agencyId: "fictional",
          alertId: "declared-alert",
          incidentKey: "v2-declared-incident",
          subscriptionId: subscription.id,
          status: "active_sent",
          deliveredAt: now,
          locale: "en-CA",
        });
        const declaredFrenchClaim = yield* repository.claimDelivery({
          ...frenchActiveClaim,
          alertId: "declared-alert",
          incidentKey: "v2-declared-incident",
          localeScope: "*",
          ownerToken: "declared-french-owner",
        });

        return {
          frenchAllowed,
          frenchRecoveryAllowed,
          englishRecoveryAllowed,
          declaredFrenchClaim,
        };
      }).pipe(Effect.provide(repositoryLayer)),
    );

    expect(outcomes).toEqual({
      frenchAllowed: true,
      frenchRecoveryAllowed: false,
      englishRecoveryAllowed: true,
      declaredFrenchClaim: false,
    });
  });

  it("reserves claim and outcome queries and releases claims when transport is deferred", async () => {
    const binding = await createNodeSqliteBinding(
      makeTempDbPath("ttc-claim-budget-"),
      DatabaseSync!,
    );
    const baseRepositoryLayer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "UTC",
    });
    let sends = 0;
    const pushLayer = createMockVapidClient(async () => {
      sends += 1;
      return { success: true, expired: false, statusCode: 201 };
    });
    const evaluatorLayer = Layer.merge(
      createLiveAlertEvaluatorService(),
      Layer.merge(baseRepositoryLayer, pushLayer),
    ).pipe(Layer.provide(Layer.merge(baseRepositoryLayer, pushLayer)));
    const setup = await Effect.runPromise(
      Effect.gen(function* () {
        const repository = yield* SubscriptionRepository;
        yield* repository.upsertSubscription(subscription);
        return { repository, evaluator: yield* AlertEvaluatorService };
      }).pipe(Effect.provide(evaluatorLayer)),
    );
    const deferredBudget = createInvocationBudget(6);
    const deferredRepository = makeD1SubscriptionRepositoryService(binding, {
      fallbackTimezone: "UTC",
      queryBudget: deferredBudget,
    });
    const options = {
      subscriptions: [subscription],
      outstandingSubscriptionIds: [],
    } as const;

    const deferred = await Effect.runPromise(
      setup.evaluator.evaluateAndDispatch(liveSnapshot, now, {
        ...options,
        repository: deferredRepository,
        sendOptions: {
          beforeSend: () => {
            throw new InvocationBudgetExceeded({ message: "transport request capacity exhausted" });
          },
        },
      }),
    );

    expect(deferred.activePushesSent).toBe(0);
    expect(sends).toBe(0);
    expect(deferredBudget.remaining).toBe(3);
    expect(
      await Effect.runPromise(
        setup.repository.getDelivery("fictional", activeAlert.id, subscription.id),
      ),
    ).toBeNull();

    const acceptedBudget = createInvocationBudget(6);
    const acceptedRepository = makeD1SubscriptionRepositoryService(binding, {
      fallbackTimezone: "UTC",
      queryBudget: acceptedBudget,
    });
    const accepted = await Effect.runPromise(
      setup.evaluator.evaluateAndDispatch(liveSnapshot, now, {
        ...options,
        repository: acceptedRepository,
      }),
    );

    expect(accepted.activePushesSent).toBe(1);
    expect(sends).toBe(1);
    expect(acceptedBudget.remaining).toBe(1);
    expect(
      (
        await Effect.runPromise(
          setup.repository.getDelivery("fictional", activeAlert.id, subscription.id),
        )
      )?.status,
    ).toBe("active_sent");
  });
});
