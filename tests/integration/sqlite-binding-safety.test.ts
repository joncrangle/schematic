import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  createBunSqliteBinding,
  createSyncSqliteBinding,
  type SqliteDatabaseLike,
} from "~/infrastructure/storage/RuntimeBindings";
import { ENSURE_SUBSCRIPTION_SCHEMA_SQL } from "~/infrastructure/storage/subscriptionSchema";
import { makeTempDbPath } from "../helpers/sqlite-fixture";

const bunRuntimeAvailable = Reflect.has(globalThis, "Bun");

if (!bunRuntimeAvailable) {
  it("runs the SQLite binding safety suite under Bun", async () => {
    await promisify(execFile)(
      "bun",
      [
        "--bun",
        "node_modules/vitest/vitest.mjs",
        "run",
        "--config",
        "vitest.integration.config.ts",
        "tests/integration/sqlite-binding-safety.test.ts",
      ],
      { timeout: 30_000 },
    );
  }, 35_000);
} else
  describe("Bun SQLite binding", () => {
    it("enforces ON DELETE CASCADE for alert deliveries", async () => {
      const db = await createBunSqliteBinding(makeTempDbPath());
      await db.exec(ENSURE_SUBSCRIPTION_SCHEMA_SQL);
      await db
        .prepare(
          "INSERT INTO push_subscriptions (id, endpoint, p256dh, auth, commute_schedules_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind("subscription-1", "https://push.invalid/subscription-1", "p256dh", "auth", "[]", 1, 1)
        .run();
      await db
        .prepare(
          "INSERT INTO alert_deliveries (id, agency_id, alert_id, incident_key, subscription_id, status, delivered_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .bind(
          "delivery-1",
          "fictional-agency",
          "alert-1",
          "incident-1",
          "subscription-1",
          "active_sent",
          1,
        )
        .run();

      await db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind("subscription-1").run();

      const deliveries = await db.prepare("SELECT id FROM alert_deliveries").all<{ id: string }>();
      expect(deliveries.results).toEqual([]);
    });

    it("serializes concurrent batches on the shared connection", async () => {
      const db = await createBunSqliteBinding(makeTempDbPath());
      await db.exec("CREATE TABLE batch_rows (id TEXT PRIMARY KEY)");

      await Promise.all([
        db.batch([
          db.prepare("INSERT INTO batch_rows (id) VALUES (?)").bind("first-a"),
          db.prepare("INSERT INTO batch_rows (id) VALUES (?)").bind("first-b"),
        ]),
        db.batch([
          db.prepare("INSERT INTO batch_rows (id) VALUES (?)").bind("second-a"),
          db.prepare("INSERT INTO batch_rows (id) VALUES (?)").bind("second-b"),
        ]),
      ]);

      const rows = await db.prepare("SELECT id FROM batch_rows ORDER BY id").all<{ id: string }>();
      expect(rows.results.map((row) => row.id)).toEqual([
        "first-a",
        "first-b",
        "second-a",
        "second-b",
      ]);
    });

    it("keeps an unrelated statement outside a failed batch transaction", async () => {
      const db = await createBunSqliteBinding(makeTempDbPath());
      await db.exec("CREATE TABLE isolated_rows (id TEXT PRIMARY KEY)");

      const failedBatch = db.batch([
        db.prepare("INSERT INTO isolated_rows (id) VALUES (?)").bind("rolled-back"),
        db.prepare("INSERT INTO missing_table (id) VALUES (?)").bind("fail-batch"),
      ]);
      const unrelatedStatement = db
        .prepare("INSERT INTO isolated_rows (id) VALUES (?)")
        .bind("outside-batch")
        .run();
      const [batchResult, unrelatedResult] = await Promise.allSettled([
        failedBatch,
        unrelatedStatement,
      ]);

      expect(batchResult.status).toBe("rejected");
      expect(unrelatedResult.status).toBe("fulfilled");
      const rows = await db
        .prepare("SELECT id FROM isolated_rows ORDER BY id")
        .all<{ id: string }>();
      expect(rows.results.map((row) => row.id)).toEqual(["outside-batch"]);
    });

    it("captures queued bindings before the statement is rebound", async () => {
      const db = await createBunSqliteBinding(makeTempDbPath());
      await db.exec("CREATE TABLE captured_rows (id TEXT PRIMARY KEY)");
      const statement = db.prepare("INSERT INTO captured_rows VALUES (?)").bind("captured");
      const batch = db.batch([statement]);
      statement.bind("later");
      await batch;
      expect((await db.prepare("SELECT id FROM captured_rows").all()).results).toEqual([
        { id: "captured" },
      ]);
    });

    it("rejects foreign statements before applying any writes", async () => {
      const db = await createBunSqliteBinding(makeTempDbPath());
      const other = await createBunSqliteBinding(makeTempDbPath());
      await db.exec("CREATE TABLE owned_rows (id TEXT PRIMARY KEY)");
      await expect(
        db.batch([
          db.prepare("INSERT INTO owned_rows VALUES (?)").bind("must-not-write"),
          other.prepare("SELECT 1"),
        ]),
      ).rejects.toThrow(/same binding/);
      expect((await db.prepare("SELECT id FROM owned_rows").all()).results).toEqual([]);
    });

    it("preserves a batch statement error when rollback also throws", async () => {
      const bunSqliteSpecifier = "bun:" + "sqlite";
      const { Database } = await import(/* @vite-ignore */ bunSqliteSpecifier);
      const rawDatabase = new Database(makeTempDbPath());
      const raw: SqliteDatabaseLike = {
        exec: (query) => {
          if (query === "ROLLBACK") {
            rawDatabase.exec(query);
            throw new Error("rollback failed after execution");
          }
          return rawDatabase.exec(query);
        },
        prepare: (query) => rawDatabase.prepare(query),
      };
      const db = createSyncSqliteBinding(raw);
      await db.exec("CREATE TABLE rollback_rows (id TEXT PRIMARY KEY)");

      await expect(
        db.batch([db.prepare("INSERT INTO missing_table (id) VALUES (?)").bind("trigger-failure")]),
      ).rejects.toThrow(/no such table: missing_table/);
      await expect(
        db
          .prepare("INSERT INTO rollback_rows (id) VALUES (?)")
          .bind("outside-unknown-transaction")
          .run(),
      ).rejects.toThrow(/binding is unavailable/i);
      expect(rawDatabase.prepare("SELECT id FROM rollback_rows").all()).toEqual([]);
    });
  });
