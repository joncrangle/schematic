import { describe, expect, it } from "vitest";
import { Effect, Layer } from "effect";
import {
  AlertEvaluatorService,
  createLiveAlertEvaluatorService,
} from "~/services/notifications/AlertEvaluatorService";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { createMockVapidClient } from "~/infrastructure/notifications/VapidClient";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";
import type { AgencyAlert, AgencySnapshot } from "~/agencies/types";
import type {
  AlertDeliveryRecord,
  PushPayload,
  PushSubscriptionRecord,
} from "~/domain/notifications/types";

/**
 * The SQL adapter upserts deliveries by upstream alert id while the
 * evaluator dedupes by content-hash incident key. These cases pin that
 * contract against real SQLite: a re-recorded row must carry the new key
 * (not the stale one), and id churn across fetches must still yield exactly
 * one push and one recovery per incident.
 */

const DatabaseSync = await loadDatabaseSync();

const ALWAYS_ACTIVE_SCHEDULE = [
  {
    id: "sched-incident-key",
    label: "Integration window",
    enabled: true,
    days: [0, 1, 2, 3, 4, 5, 6],
    start: "00:00",
    end: "23:59",
  },
];

const fixedNow = new Date("2026-08-19T12:00:00Z").getTime();

function makeSub(): PushSubscriptionRecord {
  return {
    id: "sub-incident-key",
    endpoint: "https://push.example.com/incident-key",
    p256dh: "key_p256dh",
    auth: "key_auth",
    favouriteLines: [{ agencyId: "ttc", lineId: "1" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: ALWAYS_ACTIVE_SCHEDULE,
    timezone: "America/Toronto",
    // Stored at real time so retention pruning never drops the fixture.
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

function makeAlert(id: string, title: string): AgencyAlert {
  return {
    id,
    kind: "suspension",
    affectedLineIds: ["1"],
    scope: "line",
    title,
    description: "Signal failure",
    severity: "severe",
    lifecycle: "active",
    startsAt: fixedNow,
    updatedAt: fixedNow,
  };
}

function makeSnapshot(alerts: AgencyAlert[]): AgencySnapshot {
  return { agencyId: "ttc", generatedAt: fixedNow, freshness: "live", alerts };
}

describe.skipIf(!DatabaseSync)("alert delivery incident-key persistence", () => {
  it("overwrites incident_key when the same upstream id is re-recorded", async () => {
    const binding = await createNodeSqliteBinding(makeTempDbPath("ttc-upsert-"), DatabaseSync!);
    const layer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "America/Toronto",
    });
    const first: AlertDeliveryRecord = {
      id: "del-1",
      agencyId: "ttc",
      alertId: "feed-a",
      incidentKey: "v1-aaa",
      subscriptionId: "sub-1",
      lineId: "1",
      status: "active_sent",
      deliveredAt: 1000,
    };

    const stored = await Effect.runPromise(
      Effect.gen(function* () {
        const repo = yield* SubscriptionRepository;
        // Deliveries reference the subscription row (enforced foreign key).
        yield* repo.upsertSubscription({ ...makeSub(), id: "sub-1" });
        yield* repo.recordDelivery(first);
        yield* repo.recordDelivery({
          ...first,
          id: "del-2",
          incidentKey: "v1-bbb",
          deliveredAt: 2000,
        });
        return yield* repo.getDelivery("ttc", "feed-a", "sub-1");
      }).pipe(Effect.provide(layer)),
    );

    expect(stored?.incidentKey).toBe("v1-bbb");
    expect(stored?.deliveredAt).toBe(2000);
  });

  it("pushes and recovers once per incident across upstream id churn", async () => {
    const sentPushes: PushPayload[] = [];
    const binding = await createNodeSqliteBinding(makeTempDbPath("ttc-churn-"), DatabaseSync!);
    const repoLayer = createD1SubscriptionRepository(binding, {
      fallbackTimezone: "America/Toronto",
    });
    const mockVapidLayer = createMockVapidClient(async (_sub, payload) => {
      sentPushes.push(payload);
      return { success: true, statusCode: 201, expired: false };
    });
    const evaluatorLayer = createLiveAlertEvaluatorService();
    const layer = Layer.merge(evaluatorLayer, Layer.merge(repoLayer, mockVapidLayer)).pipe(
      Layer.provide(Layer.merge(repoLayer, mockVapidLayer)),
    );
    const title = "Line 1: St Clair to Finch suspended";

    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const subRepo = yield* SubscriptionRepository;
        const evaluator = yield* AlertEvaluatorService;
        yield* subRepo.upsertSubscription(makeSub());

        const first = yield* evaluator.evaluateAndDispatch(
          makeSnapshot([makeAlert("feed-a", title)]),
          fixedNow,
        );
        expect(first.activePushesSent).toBe(1);

        // Same incident, new upstream id: no re-push, no recovery.
        const churned = yield* evaluator.evaluateAndDispatch(
          makeSnapshot([makeAlert("feed-b", title)]),
          fixedNow,
        );
        expect(churned.activePushesSent).toBe(0);
        expect(churned.clearedPushesSent).toBe(0);

        // Incident ends: exactly one all-clear for both churned rows.
        const cleared = yield* evaluator.evaluateAndDispatch(makeSnapshot([]), fixedNow);
        expect(cleared.clearedPushesSent).toBe(1);

        // Healed rows stay quiet on the next tick.
        const repeat = yield* evaluator.evaluateAndDispatch(makeSnapshot([]), fixedNow);
        expect(repeat.clearedPushesSent).toBe(0);

        return yield* subRepo.getDeliveriesForSubscription("ttc", "sub-incident-key");
      }).pipe(Effect.provide(layer)),
    );

    expect(sentPushes).toHaveLength(2);
    expect(sentPushes[1]?.title).toContain("Service Resumed");
    expect(result.every((d) => d.status === "cleared_sent")).toBe(true);
  });
});
