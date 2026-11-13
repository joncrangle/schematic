import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import {
  SubscriptionRepository,
  createD1SubscriptionRepository,
} from "~/infrastructure/storage/SubscriptionRepository";
import { ENSURE_SUBSCRIPTION_SCHEMA_SQL } from "~/infrastructure/storage/subscriptionSchema";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";

const DatabaseSync = await loadDatabaseSync();
describe.skipIf(!DatabaseSync)("subscription locale migration against SQLite", () => {
  it("adds English locales to existing rows and reruns idempotently", async () => {
    const now = Date.now();
    const path = makeTempDbPath("push-locale-");
    const legacy = await createNodeSqliteBinding(path, DatabaseSync!);
    await legacy.exec(
      ENSURE_SUBSCRIPTION_SCHEMA_SQL.replaceAll(", locale TEXT NOT NULL DEFAULT 'en-CA'", ""),
    );
    await legacy.exec(
      [
        `INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, favourite_lines_json, favourite_stations_json, favourite_routes_json, commute_schedules_json, timezone, created_at, updated_at) VALUES ('legacy', 'https://push.example/legacy', 'test', 'test', '[{"agencyId":"metro","lineId":"A"}]', '[]', '[]', '[]', 'America/Toronto', ${now}, ${now})`,
        `INSERT INTO alert_deliveries (id, agency_id, alert_id, incident_key, subscription_id, status, delivered_at) VALUES ('delivery', 'metro', 'incident', 'incident-key', 'legacy', 'active_sent', 1)`,
      ].join(";\n"),
    );

    const readMigrated = async () => {
      const db = await createNodeSqliteBinding(path, DatabaseSync!);
      return Effect.runPromise(
        Effect.gen(function* () {
          const repo = yield* SubscriptionRepository;
          const subscriptions = yield* repo.getActiveSubscriptions();
          const deliveries = yield* repo.getDeliveriesForSubscription("metro", "legacy");
          return {
            subscriptionLocales: subscriptions.map((sub) => sub.locale),
            deliveryLocales: deliveries.map((delivery) => delivery.locale),
          };
        }).pipe(Effect.provide(createD1SubscriptionRepository(db, { fallbackTimezone: "UTC" }))),
      );
    };

    const expected = { subscriptionLocales: ["en-CA"], deliveryLocales: ["en-CA"] };
    expect(await readMigrated()).toEqual(expected);
    expect(await readMigrated()).toEqual(expected);
  });
});
