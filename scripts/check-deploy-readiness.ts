#!/usr/bin/env bun
/**
 * Pre-deploy readiness check for Cloudflare Workers deployment.
 *
 * Usage:
 *   bun run deploy:check
 *
 * Fails loudly when any `d1_databases` entry in `wrangler.jsonc` still carries
 * a placeholder `database_id` (see the comment above `d1_databases`: each
 * deployer provisions their own databases and pastes in the real IDs).
 * Runs before `bun run deploy` so a fresh clone can never deploy against
 * made-up IDs. Network-free: reads only the local config file.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export interface WranglerD1DatabaseEntry {
  readonly binding?: unknown;
  readonly database_name?: unknown;
  readonly database_id?: unknown;
}

/** True for empty/missing IDs and single-repeated-digit UUIDs (000…/111…/…). */
export function isPlaceholderDatabaseId(databaseId: unknown): boolean {
  if (typeof databaseId !== "string" || databaseId.trim() === "") return true;
  const hex = databaseId.replace(/-/g, "").toLowerCase();
  if (!/^[0-9a-f]+$/.test(hex)) return true;
  return hex.split("").every((digit) => digit === hex[0]);
}

/** Binding names whose entry is missing a field or still holds a placeholder ID. */
export function findUnprovisionedDatabases(
  entries: readonly WranglerD1DatabaseEntry[] | undefined,
): string[] {
  if (!Array.isArray(entries)) return ["d1_databases"];
  return entries
    .filter(
      (entry) =>
        typeof entry?.binding !== "string" ||
        entry.binding === "" ||
        typeof entry?.database_name !== "string" ||
        entry.database_name === "" ||
        isPlaceholderDatabaseId(entry?.database_id),
    )
    .map((entry) =>
      typeof entry?.binding === "string" && entry.binding !== ""
        ? entry.binding
        : "(unnamed binding)",
    );
}

/** Minimal JSONC parse: strips `//` line comments and trailing commas, then JSON-parses. */
export function parseWranglerConfig(source: string): {
  d1_databases?: WranglerD1DatabaseEntry[];
} {
  const withoutComments = source
    .split("\n")
    .map((line) => {
      let inString = false;
      for (let i = 0; i < line.length; i++) {
        const char = line[i];
        if (char === '"' && line[i - 1] !== "\\") inString = !inString;
        if (!inString && char === "/" && line[i + 1] === "/") return line.slice(0, i);
      }
      return line;
    })
    .join("\n")
    .replace(/,\s*([}\]])/g, "$1");
  return JSON.parse(withoutComments) as { d1_databases?: WranglerD1DatabaseEntry[] };
}

export function runDeployCheck(configPath?: string): number {
  const resolved =
    configPath ?? join(dirname(fileURLToPath(import.meta.url)), "..", "wrangler.jsonc");
  let source: string;
  try {
    source = readFileSync(resolved, "utf8");
  } catch {
    console.error(
      `deploy:check: cannot read ${resolved}.\n` +
        `If you have just cloned the repository, copy wrangler.sample.jsonc to wrangler.jsonc and populate your D1 database IDs: cp wrangler.sample.jsonc wrangler.jsonc`,
    );
    return 1;
  }
  const unprovisioned = findUnprovisionedDatabases(parseWranglerConfig(source).d1_databases);
  if (unprovisioned.length > 0) {
    console.error(
      `deploy:check: placeholder D1 database_id in wrangler.jsonc: ${unprovisioned.join(", ")}\n` +
        `Create each database (bunx wrangler d1 create <name>) and paste its database_id — see the deployment guide §2.2.\n` +
        `Self-hosting only? Skip \`bun run deploy\` entirely and build the container instead (guide §3).`,
    );
    return 1;
  }
  console.log("deploy:check: every D1 binding has a provisioned database_id.");
  return 0;
}

if (import.meta.main) {
  process.exitCode = runDeployCheck(process.argv[2]);
}
