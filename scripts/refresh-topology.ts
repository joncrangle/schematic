#!/usr/bin/env bun
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { TRANSIT_BINDING_NAME } from "~/infrastructure/storage/RuntimeBindings";
import { logger } from "~/infrastructure/logging/logger";
import { isPlaceholderDatabaseId } from "./check-deploy-readiness";
import {
  refreshRemoteScheduledTopologies,
  type RemoteTopologyRefreshOptions,
} from "./lib/remote-topology-refresh";

function parseOptions(args: readonly string[], now: number) {
  let configPath: string | undefined;
  let scheduledTime = now;
  let hasTime = false;
  for (const arg of args) {
    if (arg.startsWith("--config=") && configPath === undefined) configPath = arg.slice(9);
    else if (arg.startsWith("--scheduled-time=") && !hasTime) {
      hasTime = true;
      const value = arg.slice(17);
      scheduledTime = Date.parse(value);
      if (
        !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) ||
        !Number.isFinite(scheduledTime) ||
        new Date(scheduledTime).toISOString() !==
          (value.includes(".") ? value : value.replace("Z", ".000Z"))
      )
        throw new Error("--scheduled-time must be a valid UTC ISO timestamp");
    } else
      throw new Error(
        "Usage: bun scripts/refresh-topology.ts --config=<path> [--scheduled-time=<UTC ISO timestamp>]",
      );
  }
  if (!configPath?.trim()) throw new Error("--config is required for remote topology refresh");
  if (!Number.isFinite(scheduledTime) || !Number.isFinite(new Date(scheduledTime).getTime()))
    throw new Error("Invalid topology clock");
  return { configPath: resolve(configPath), scheduledTime };
}

function validateConfig(source: string): void {
  let config: {
    d1_databases?: Array<{ binding?: unknown; database_name?: unknown; database_id?: unknown }>;
  } | null;
  try {
    config = JSON.parse(source);
  } catch {
    throw new Error("Topology Wrangler config must be valid JSON");
  }
  const entries = Array.isArray(config?.d1_databases)
    ? config.d1_databases.filter((entry) => entry?.binding === TRANSIT_BINDING_NAME)
    : [];
  const [entry] = entries;
  if (
    entries.length !== 1 ||
    typeof entry.database_name !== "string" ||
    !/^[a-zA-Z0-9_-]+$/.test(entry.database_name) ||
    typeof entry.database_id !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(entry.database_id) ||
    isPlaceholderDatabaseId(entry.database_id)
  )
    throw new Error(
      "Topology config requires one DB_TRANSIT binding with an existing database_name and non-placeholder UUID database_id",
    );
}

/** Importing the CLI performs no I/O. All validation precedes the first remote command. */
export async function runTopologyRefreshCli(
  args: readonly string[],
  dependencies: Omit<RemoteTopologyRefreshOptions, "configPath" | "scheduledTime"> & {
    readonly readConfig?: (path: string) => Promise<string>;
  } = {},
): Promise<number> {
  const now = (dependencies.now ?? Date.now)();
  const log = dependencies.log ?? logger;
  let options: ReturnType<typeof parseOptions>;
  try {
    options = parseOptions(args, now);
    let source: string;
    try {
      source = await (dependencies.readConfig ?? ((path) => readFile(path, "utf8")))(
        options.configPath,
      );
    } catch {
      throw new Error("Cannot read topology Wrangler config");
    }
    validateConfig(source);
  } catch (error) {
    log.error(error instanceof Error ? error.message : "Invalid topology refresh input");
    return 1;
  }
  try {
    const result = await refreshRemoteScheduledTopologies({ ...dependencies, ...options });
    log.info("Remote topology cycle completed", result);
    return result.failedAgencyIds.length ? 1 : 0;
  } catch {
    // Never print raw Wrangler output, credentials, or the secret config contents.
    log.error("Remote topology cycle failed before agency completion");
    return 1;
  }
}

if (import.meta.main) process.exitCode = await runTopologyRefreshCli(process.argv.slice(2));
