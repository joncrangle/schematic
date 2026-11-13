import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import {
  SubscriptionRepository,
  createMemorySubscriptionRepository,
  createD1SubscriptionRepository,
  makeD1SubscriptionRepositoryService,
} from "~/infrastructure/storage/SubscriptionRepository";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import type { AlertDeliveryRecord } from "~/domain/notifications/types";
import type { PushSubscriptionRecord } from "~/domain/notifications/types";
import { loadDatabaseSync } from "../helpers/sqlite-fixture";

const DatabaseSync = await loadDatabaseSync();

function makeRecord(): PushSubscriptionRecord {
  return {
    id: "sub-lazy-schema",
    endpoint: "https://push.example.com/sub/1",
    p256dh: "p256dh-key",
    auth: "auth-key",
    favouriteLines: [{ agencyId: "sample", lineId: "1" }],
    favouriteStations: [],
    favouriteSurfaceRoutes: [],
    commuteSchedules: [],
    timezone: "America/Toronto",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
}

describe.skipIf(!DatabaseSync)("subscription age pruning", () => {
  it("keeps active and recent terminal history, prunes expired terminal rows, and removes only expired claims", async () => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const day = 24 * 60 * 60 * 1000;
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const db = await createNodeSqliteBinding(":memory:", DatabaseSync!);
      const repository = makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone: "UTC",
      });
      await Effect.runPromise(
        repository.upsertSubscription({
          ...makeRecord(),
          id: "retention-subscription",
          endpoint: "https://push.example.com/sub/retention",
          createdAt: now,
          updatedAt: now,
        }),
      );

      const makeDelivery = (
        id: string,
        status: AlertDeliveryRecord["status"],
        deliveredAt: number,
      ): AlertDeliveryRecord => ({
        id,
        agencyId: "sample",
        alertId: id,
        incidentKey: `incident-${id}`,
        subscriptionId: "retention-subscription",
        status,
        deliveredAt,
        locale: "en-CA",
      });
      const deliveries = [
        { record: makeDelivery("active-old", "active_sent", now - 400 * day) },
        {
          record: makeDelivery("silent-recent", "cleared_silent", now - 400 * day),
          terminalAt: now - 29 * day,
        },
        {
          record: makeDelivery("silent-expired", "cleared_silent", now - 400 * day),
          terminalAt: now - 31 * day,
        },
        {
          record: makeDelivery("legacy-silent", "cleared_silent", now - 31 * day),
          terminalAt: now - 29 * day,
        },
        { record: makeDelivery("sent-expired", "cleared_sent", now - 31 * day) },
      ];
      for (const { record, terminalAt } of deliveries) {
        await Effect.runPromise(repository.recordDelivery(record, terminalAt));
      }
      await db
        .prepare("UPDATE alert_deliveries SET terminal_at = 0 WHERE alert_id = ?")
        .bind("legacy-silent")
        .run();

      const insertClaim = async (incidentKey: string, expiresAt: number) =>
        db
          .prepare(`
            INSERT INTO alert_delivery_claims (
              agency_id, subscription_id, incident_key, locale_scope, alert_id,
              phase, owner_token, claimed_at, expires_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `)
          .bind(
            "sample",
            "retention-subscription",
            incidentKey,
            "en-CA",
            incidentKey,
            "active",
            `owner-${incidentKey}`,
            now - 60_000,
            expiresAt,
          )
          .run();
      await insertClaim("expired-claim", now - 1);
      await insertClaim("live-claim", now + 60_000);

      expect(await Effect.runPromise(repository.getActiveSubscriptions())).toHaveLength(1);
      const retainedHistory = await Effect.runPromise(
        repository.getDeliveriesForSubscription("sample", "retention-subscription"),
      );
      expect(retainedHistory.map((delivery) => delivery.alertId).sort()).toEqual([
        "active-old",
        "silent-recent",
      ]);
      expect(
        (
          await Effect.runPromise(
            repository.getDeliveriesForSubscriptions("sample", ["retention-subscription"]),
          )
        ).map((delivery) => delivery.alertId),
      ).toEqual(["active-old"]);
      expect(
        (
          await db
            .prepare("SELECT incident_key FROM alert_delivery_claims ORDER BY incident_key")
            .all<{ incident_key: string }>()
        ).results?.map((claim) => claim.incident_key),
      ).toEqual(["live-claim"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["memory", "d1"] as const)(
    "removes idle subscriptions and old tombstones from the %s repository",
    async (adapter) => {
      const now = Date.parse("2026-10-15T12:00:00Z");
      const old = now - 366 * 24 * 60 * 60 * 1000;
      vi.useFakeTimers();
      vi.setSystemTime(old);
      try {
        const layer =
          adapter === "memory"
            ? createMemorySubscriptionRepository()
            : createD1SubscriptionRepository(
                await createNodeSqliteBinding(":memory:", DatabaseSync!),
                {
                  fallbackTimezone: "America/Toronto",
                },
              );
        const repo = await Effect.runPromise(
          Effect.gen(function* () {
            return yield* SubscriptionRepository;
          }).pipe(Effect.provide(layer)),
        );
        const idle = {
          ...makeRecord(),
          id: "idle-subscription",
          endpoint: "https://push.example.com/sub/idle",
          createdAt: old,
          updatedAt: old,
          policyRevision: 1,
        };
        const removed = {
          ...makeRecord(),
          id: "removed-subscription",
          endpoint: "https://push.example.com/sub/removed",
          createdAt: old,
          updatedAt: old,
          policyRevision: 1,
        };
        await Effect.runPromise(repo.upsertSubscription(idle));
        await Effect.runPromise(repo.upsertSubscription(removed));
        await Effect.runPromise(repo.deleteSubscriptionByEndpoint(removed.endpoint, 1));

        vi.setSystemTime(now);
        await Effect.runPromise(
          repo.upsertSubscription({
            ...makeRecord(),
            id: "recent-subscription",
            endpoint: "https://push.example.com/sub/recent",
          }),
        );
        expect(
          (await Effect.runPromise(repo.getActiveSubscriptions())).map((sub) => sub.id),
        ).toEqual(["recent-subscription"]);

        await Effect.runPromise(
          repo.upsertSubscription({
            ...removed,
            id: "returned-subscription",
            createdAt: now,
            updatedAt: now,
          }),
        );
        expect(
          (await Effect.runPromise(repo.getActiveSubscriptions())).map((sub) => sub.id).sort(),
        ).toEqual(["recent-subscription", "returned-subscription"]);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("preserves a legacy tombstone for a year after adding its age column", async () => {
    const db = await createNodeSqliteBinding(":memory:", DatabaseSync!);
    const endpoint = "https://push.example.com/sub/legacy-tombstone";
    const endpointHash = Buffer.from(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(endpoint)),
    ).toString("hex");
    const now = Date.parse("2026-10-15T12:00:00Z");
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      await db.exec(
        "CREATE TABLE push_subscription_tombstones (endpoint_hash TEXT PRIMARY KEY, policy_revision INTEGER NOT NULL)",
      );
      await db
        .prepare(
          "INSERT INTO push_subscription_tombstones (endpoint_hash, policy_revision) VALUES (?, ?)",
        )
        .bind(endpointHash, 1)
        .run();
      const repository = makeD1SubscriptionRepositoryService(db, {
        fallbackTimezone: "America/Toronto",
      });
      await Effect.runPromise(repository.getActiveSubscriptions());
      await Effect.runPromise(
        repository.upsertSubscription({ ...makeRecord(), endpoint, policyRevision: 1 }),
      );
      expect(await Effect.runPromise(repository.getActiveSubscriptions())).toEqual([]);

      vi.setSystemTime(now + 366 * 24 * 60 * 60 * 1000);
      await Effect.runPromise(repository.getActiveSubscriptions());
      await Effect.runPromise(
        repository.upsertSubscription({
          ...makeRecord(),
          endpoint,
          policyRevision: 1,
          createdAt: Date.now(),
          updatedAt: Date.now(),
        }),
      );
      expect(
        (await Effect.runPromise(repository.getActiveSubscriptions())).map((sub) => sub.endpoint),
      ).toEqual([endpoint]);
    } finally {
      vi.useRealTimers();
    }
  });
});
