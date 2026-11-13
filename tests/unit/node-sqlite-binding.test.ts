import { describe, expect, it } from "vitest";
import { createNodeSqliteBinding } from "~/infrastructure/storage/RuntimeBindings";
import { ENSURE_SUBSCRIPTION_SCHEMA_SQL } from "~/infrastructure/storage/subscriptionSchema";
import { loadDatabaseSync, makeTempDbPath } from "../helpers/sqlite-fixture";

const DatabaseSync = await loadDatabaseSync();
const sqliteAvailable = DatabaseSync !== null;

describe.skipIf(!sqliteAvailable)("createNodeSqliteBinding", () => {
  it("roundtrips exec / bind / run / all / first", async () => {
    const binding = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);

    await binding.exec("CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

    const insert = binding.prepare("INSERT INTO things (name) VALUES (?)");
    await insert.bind("alpha").run();
    await insert.bind("beta").run();

    const rows = await binding.prepare("SELECT id, name FROM things ORDER BY id").all<{
      id: number;
      name: string;
    }>();
    expect(rows.success).toBe(true);
    expect(rows.results).toEqual([
      { id: 1, name: "alpha" },
      { id: 2, name: "beta" },
    ]);

    const one = await binding.prepare("SELECT name FROM things WHERE id = ?").bind(2).first<{
      name: string;
    }>();
    expect(one).toEqual({ name: "beta" });

    const missing = await binding.prepare("SELECT name FROM things WHERE id = ?").bind(99).first<{
      name: string;
    }>();
    expect(missing).toBeNull();
  });
});

describe.skipIf(!sqliteAvailable)("createNodeSqliteBinding batch()", () => {
  it("applies every statement when the whole sequence succeeds", async () => {
    const binding = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await binding.exec("CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");

    await binding.batch([
      binding.prepare("INSERT INTO things (name) VALUES (?)").bind("alpha"),
      binding.prepare("INSERT INTO things (name) VALUES (?)").bind("beta"),
    ]);

    const rows = await binding
      .prepare("SELECT name FROM things ORDER BY id")
      .all<{ name: string }>();
    expect(rows.results.map((r) => r.name)).toEqual(["alpha", "beta"]);
  });

  it("rolls back the entire sequence when any statement fails", async () => {
    const binding = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await binding.exec("CREATE TABLE things (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT)");
    await binding.prepare("INSERT INTO things (name) VALUES (?)").bind("sentinel").run();

    await expect(
      binding.batch([
        binding.prepare("INSERT INTO things (name) VALUES (?)").bind("first"),
        binding.prepare("INSERT INTO missing_table (name) VALUES (?)").bind("boom"),
        binding.prepare("INSERT INTO things (name) VALUES (?)").bind("never"),
      ]),
    ).rejects.toThrow();

    const names = await binding
      .prepare("SELECT name FROM things ORDER BY id")
      .all<{ name: string }>();
    expect(names.results.map((r) => r.name)).toEqual(["sentinel"]);
  });
});

describe.skipIf(!sqliteAvailable)("ENSURE_SUBSCRIPTION_SCHEMA_SQL", () => {
  it("parses against a real SQLite engine (guards the one-statement-per-line D1 rule)", async () => {
    const binding = await createNodeSqliteBinding(makeTempDbPath(), DatabaseSync!);
    await binding.exec(ENSURE_SUBSCRIPTION_SCHEMA_SQL);

    // Idempotent re-run must also succeed (IF NOT EXISTS).
    await binding.exec(ENSURE_SUBSCRIPTION_SCHEMA_SQL);

    const tables = await binding
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all<{ name: string }>();
    const names = tables.results.map((r) => r.name);
    expect(names).toContain("push_subscriptions");
    expect(names).toContain("alert_deliveries");
  });
});
