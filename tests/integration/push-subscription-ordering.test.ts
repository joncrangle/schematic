import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { ENSURE_SUBSCRIPTION_SCHEMA_SQL } from "~/infrastructure/storage/subscriptionSchema";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";

const DatabaseSync = await loadDatabaseSync();
describe.skipIf(!DatabaseSync)("push policy ordering against SQLite", () => {
  it.each(["fresh", "legacy"] as const)(
    "rejects late writes and deletes on a %s schema",
    async (schema) => {
      const db = await createNodeSqliteBinding(makeTempDbPath("push-order-"), DatabaseSync!);
      if (schema === "legacy")
        await db.exec(
          ENSURE_SUBSCRIPTION_SCHEMA_SQL.replace(
            ", policy_revision INTEGER NOT NULL DEFAULT 0",
            "",
          ),
        );
      const layer = createD1SubscriptionRepository(db, { fallbackTimezone: "America/Toronto" });
      const sub: PushSubscriptionRecord = {
        id: "device",
        endpoint: "https://push.example/device",
        p256dh: "test",
        auth: "test",
        favouriteLines: [{ agencyId: "metro", lineId: "A" }],
        favouriteStations: [],
        favouriteSurfaceRoutes: [],
        commuteSchedules: [],
        timezone: "America/Toronto",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        policyRevision: 1,
      };
      await Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          yield* repo.upsertSubscription(sub);
          yield* repo.recordDelivery({
            id: "delivery",
            agencyId: "metro",
            alertId: "incident",
            incidentKey: "incident-key",
            subscriptionId: sub.id,
            status: "active_sent",
            deliveredAt: 1,
          });
          yield* repo.upsertSubscription({
            ...sub,
            id: "new-id",
            policyRevision: 3,
            favouriteLines: [{ agencyId: "metro", lineId: "B" }],
          });
          yield* repo.upsertSubscription({ ...sub, policyRevision: 2 });
          yield* repo.upsertSubscription({ ...sub, policyRevision: undefined });
          yield* repo.deleteSubscriptionByEndpoint(sub.endpoint, 2);
          const stored = yield* repo.getActiveSubscriptions();
          expect(stored).toHaveLength(1);
          expect(stored[0]).toMatchObject({
            id: "device",
            policyRevision: 3,
            favouriteLines: [{ agencyId: "metro", lineId: "B" }],
          });
          expect((yield* repo.getDelivery("metro", "incident", sub.id))?.status).toBe(
            "active_sent",
          );
          yield* repo.deleteSubscriptionByEndpoint(sub.endpoint, 4);
          yield* repo.upsertSubscription({ ...sub, policyRevision: 2 });
          expect(yield* repo.getActiveSubscriptions()).toEqual([]);
        }).pipe(Effect.provide(layer)),
      );
    },
  );
});
