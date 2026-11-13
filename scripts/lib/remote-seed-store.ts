import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SEED_TABLES,
  type SeedRow,
  type SeedStatement,
  type SeedSyncStore,
  parseSeedSyncMeta,
} from "~/infrastructure/storage/surfaceStore/seedSync";

export type RemoteSeedCommandRunner = (args: readonly string[]) => Promise<string>;

const runWrangler: RemoteSeedCommandRunner = async (args) => {
  const runtime = globalThis as typeof globalThis & {
    Bun?: {
      spawn(
        args: string[],
        options: { stdout: "pipe"; stderr: "pipe" },
      ): { stdout: ReadableStream; stderr: ReadableStream; exited: Promise<number> };
    };
  };
  if (!runtime.Bun) throw new Error("Remote D1 seeding requires Bun");
  const proc = runtime.Bun.spawn([...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) throw new Error(formatWranglerFailure(exitCode, stdout, stderr));
  return stdout;
};

const WRANGLER_OUTPUT_TAIL = 4_000;

/** Wrangler reports D1 import failures on stdout, so keep both streams' tails. */
export function formatWranglerFailure(exitCode: number, stdout: string, stderr: string): string {
  const streams: readonly (readonly [string, string])[] = [
    ["stderr", stderr],
    ["stdout", stdout],
  ];
  const sections = streams.flatMap(([name, text]) => {
    const trimmed = text.trim();
    return trimmed ? [`${name}:\n${trimmed.slice(-WRANGLER_OUTPUT_TAIL)}`] : [];
  });
  return [`Wrangler exited with code ${exitCode}`, ...sections].join("\n");
}

export function escapeSqlValue(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "string")
    return value
      .split(/\r\n|\n|\r/)
      .map((part) => `'${part.replace(/'/g, "''")}'`)
      .join(" || char(10) || ");
  throw new TypeError(`escapeSqlValue: unsupported value type ${typeof value}`);
}

export function renderSeedStatement(statement: SeedStatement): string {
  let index = 0;
  const sql = statement.sql.replace(/\?/g, () => escapeSqlValue(statement.values[index++]));
  if (index !== statement.values.length) throw new Error("Seed SQL parameter count mismatch");
  return sql + ";";
}

/** Remote reads use JSON output; a nonempty delta uses one rollback-capable Wrangler SQL import. */
export function createRemoteSeedSyncStore(options: {
  readonly bindingName: string;
  readonly schema: readonly string[];
  readonly commandRunner?: RemoteSeedCommandRunner;
  readonly configPath?: string;
  /** Per-import ceiling, including declared indexes, rather than SQL statement count. */
  readonly maxEstimatedWrites?: number;
}): SeedSyncStore {
  const run = options.commandRunner ?? runWrangler;
  const base = [
    "bunx",
    "wrangler",
    "d1",
    "execute",
    options.bindingName,
    "--remote",
    "--yes",
    ...(options.configPath ? ["--config", options.configPath] : []),
  ];
  const query = async (sql: string): Promise<SeedRow[]> => {
    const output = JSON.parse(await run([...base, "--json", "--command", sql])) as Array<{
      success: boolean;
      results: SeedRow[];
      error?: string;
    }>;
    if (!Array.isArray(output) || output.some((result) => !result.success))
      throw new Error("Remote seed query failed");
    return output.flatMap((result) => result.results);
  };
  let tables: Promise<Set<string>> | undefined;
  const hasTable = async (name: string) => {
    tables ??= query("SELECT name FROM sqlite_master WHERE type = 'table'").then(
      (rows) => new Set(rows.map((row) => String(row.name))),
    );
    return (await tables).has(name);
  };
  return {
    hasTopology: async (id) =>
      (await hasTable("routes")) &&
      (await query(`SELECT id FROM routes WHERE agency_id = ${escapeSqlValue(id)} LIMIT 1`))
        .length > 0,
    readLastSync: async (id) => {
      if (!(await hasTable("topology_meta"))) return null;
      const [row] = await query(
        `SELECT last_sync FROM topology_meta WHERE agency_id = ${escapeSqlValue(id)}`,
      );
      return row ? Number(row.last_sync) : null;
    },
    readMeta: async (id) => {
      if (!(await hasTable("seed_topology_meta"))) return null;
      const [row] = await query(
        `SELECT feed_hash, table_hashes_json FROM seed_topology_meta WHERE agency_id = ${escapeSqlValue(id)}`,
      );
      return row ? parseSeedSyncMeta(row.feed_hash, row.table_hashes_json) : null;
    },
    readTable: async (table, id) => {
      if (!Object.hasOwn(SEED_TABLES, table)) throw new Error(`Unknown seed table ${table}`);
      return (await hasTable(table))
        ? query(`SELECT * FROM ${table} WHERE agency_id = ${escapeSqlValue(id)}`)
        : [];
    },
    commit: async (statements) => {
      if (!statements.length) return;
      const indexCounts = new Map<string, number>();
      for (const sql of options.schema) {
        const table = /^CREATE TABLE IF NOT EXISTS (\w+)/i.exec(sql)?.[1];
        if (table) indexCounts.set(table, /PRIMARY KEY/i.test(sql) ? 1 : 0);
      }
      for (const sql of options.schema) {
        const table = /^CREATE INDEX IF NOT EXISTS \w+ ON (\w+)/i.exec(sql)?.[1];
        if (table) indexCounts.set(table, (indexCounts.get(table) ?? 0) + 1);
      }
      const estimatedWrites = statements.reduce((total, statement) => {
        const table = /^(?:INSERT INTO|UPDATE|DELETE FROM) (\w+)/i.exec(statement.sql)?.[1];
        return total + 1 + (table ? (indexCounts.get(table) ?? 0) : 0);
      }, 0);
      const budget = options.maxEstimatedWrites ?? 100_000;
      if (estimatedWrites > budget) {
        throw new Error(
          `Remote seed estimated ${estimatedWrites} table/index writes exceeds import budget ${budget}. No writes submitted. This ceiling does not account for other daily usage.`,
        );
      }
      const indexDefinitions = options.schema.flatMap((sql) => {
        const match = /^CREATE INDEX IF NOT EXISTS (\w+) ON (\w+)/i.exec(sql);
        return match ? [{ name: match[1]!, table: match[2]! }] : [];
      });
      if (indexDefinitions.length) {
        const existingIndexes = new Set(
          (await query("SELECT name FROM sqlite_master WHERE type = 'index'")).map((row) =>
            String(row.name),
          ),
        );
        for (const index of indexDefinitions) {
          if (!existingIndexes.has(index.name) && (await hasTable(index.table))) {
            throw new Error(
              `Remote seed would build ${index.name} on existing ${index.table}. Budget this index migration separately; no writes submitted.`,
            );
          }
        }
      }
      const dir = mkdtempSync(join(tmpdir(), "seed-delta-"));
      const path = join(dir, "delta.sql");
      try {
        writeFileSync(
          path,
          [
            ...options.schema.map((sql) => sql.replace(/;$/, "") + ";"),
            ...statements.map(renderSeedStatement),
          ].join("\n") + "\n",
        );
        await run([...base, "--file", path]);
        tables = undefined;
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}
