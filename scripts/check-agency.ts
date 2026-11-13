#!/usr/bin/env bun
/**
 * Focused, network-free validation for registered Agency Modules.
 *
 * Usage:
 *   bun run agency:check                 # check every registered agency
 *   bun run agency:check -- ttc          # check one agency
 *   bun run agency:check -- --agency go  # equivalent flag form
 */
import { buildMapModel } from "~/core/map";
import { allProviders as browserProviders } from "~/agencies/browserRegistry";
import { agencyCatalog } from "~/agencies/agencyCatalog";
import { allProviders as serverProviders } from "~/agencies/registry";
import type { AgencyProvider, BrowserAgency, FeedAuth } from "~/agencies/types";
import { validateProvider } from "~/agencies/validateProvider";
import { TRANSIT_BINDING_NAME } from "~/infrastructure/storage/RuntimeBindings";
import { isFeedSecretName } from "~/infrastructure/env/feedSecretName";
import {
  CYCLE_SUBREQUEST_BUDGET,
  coldPollingSubrequestsForCycle,
} from "~/services/notifications/cycleBudget";

const USAGE = `Usage: bun run agency:check [agency-id ...]

Checks registered Agency Modules without contacting feeds, databases, or Cloudflare.

Options:
  <agency-id ...>       Check one or more registered agencies
  --agency <id>[,...]   Equivalent flag form
  --all                 Check every registered agency (the default)
  -h, --help            Show this help

Each report prints the D1 binding and self-hosted DATA_DIR path, which are
fixed constants shared by every agency rather than values derived from the
agency's manifest.`;

export interface ParsedAgencyCheckArgs {
  readonly agencyIds: readonly string[];
  readonly isHelp: boolean;
}

export interface AgencyCheckIssue {
  readonly check: string;
  readonly detail: string;
}

export interface AgencyCheckReport {
  readonly agencyId: string;
  readonly bindingName: string;
  /** Shared SQLite file used by the self-hosted runtime. */
  readonly sqlitePath: string;
  readonly issues: readonly AgencyCheckIssue[];
}

export interface AgencyCheckResult {
  readonly registryIssues: readonly AgencyCheckIssue[];
  readonly unknownAgencyIds: readonly string[];
  readonly reports: readonly AgencyCheckReport[];
}

export function parseAgencyCheckArgs(args: readonly string[]): ParsedAgencyCheckArgs {
  const agencyIds: string[] = [];
  let checkAll = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "-h" || arg === "--help") {
      return { agencyIds: [], isHelp: true };
    }
    if (arg === "--all") {
      checkAll = true;
      continue;
    }

    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex === -1 ? arg : arg.slice(0, equalsIndex);
    if (flag === "--agency") {
      const value = equalsIndex === -1 ? args[++index] : arg.slice(equalsIndex + 1);
      if (!value) throw new Error("Missing value for --agency");
      agencyIds.push(...value.split(","));
      continue;
    }

    if (arg.startsWith("-")) {
      throw new Error(`Unknown option "${arg}". Use --help for usage.`);
    }
    agencyIds.push(arg);
  }

  const normalizedIds = [
    ...new Set(agencyIds.map((id) => id.trim().toLowerCase()).filter(Boolean)),
  ];
  if (checkAll && normalizedIds.length > 0) {
    throw new Error("Use either --all or explicit agency ids, not both.");
  }

  return { agencyIds: checkAll ? [] : normalizedIds, isHelp: false };
}

export function checkAgencyProvider(provider: AgencyProvider): AgencyCheckReport {
  const agencyId = provider.manifest.id;
  const issues: AgencyCheckIssue[] = [];
  const record = (check: string, detail: string) => issues.push({ check, detail });

  try {
    validateProvider(provider);
  } catch (error) {
    record("contract-validation", String(error));
  }

  if (typeof provider.snapshot?.get !== "function") {
    record("snapshot-port", "alert-centric snapshot.get is not implemented");
  }

  const checkAuthSecret = (auth: FeedAuth | undefined, path: string) => {
    const secretName = auth && "secretName" in auth ? auth.secretName : undefined;
    if (secretName !== undefined && !isFeedSecretName(secretName)) {
      record("feed-secret-name", `${path} must use FEED_ or a registered legacy feed secret name`);
    }
  };
  for (const [index, feed] of (provider.realtime?.feeds ?? []).entries()) {
    checkAuthSecret(feed.auth, `realtime.feeds[${index}].auth.secretName`);
  }
  for (const [index, source] of (provider.alerts ?? []).entries()) {
    if (source.baseUrlSecretName && !isFeedSecretName(source.baseUrlSecretName)) {
      record(
        "feed-secret-name",
        `alerts[${index}].baseUrlSecretName must use FEED_ or a registered legacy feed secret name`,
      );
    }
    checkAuthSecret(source.auth, `alerts[${index}].auth.secretName`);
  }

  if (provider.schematic) {
    try {
      const topology = buildMapModel(provider.schematic);
      const declaredLineIds = new Set(provider.schematic.lines.map((line) => line.id));

      for (const station of provider.schematic.stations) {
        for (const lineId of station.lines) {
          if (!declaredLineIds.has(lineId)) {
            record(
              "schematic-compiles",
              `station "${station.name}" references undeclared line "${lineId}"`,
            );
          }
        }
      }

      if (topology.lineList.length !== provider.schematic.lines.length) {
        record("schematic-compiles", "compiled line list diverged from declaration");
      }
    } catch (error) {
      record("schematic-compiles", String(error));
    }
  }

  if (provider.manifest.stationService && typeof provider.createStationsSource !== "function") {
    record("stations-source-port", "stationService agency declares no createStationsSource");
  }

  if (typeof provider.createTopologySource === "function") {
    const feeds = provider.staticTopology?.feeds ?? [];
    if (feeds.length === 0) {
      record(
        "topology-seeding-port",
        "provider with createTopologySource declares no staticTopology.feeds",
      );
    }
    for (const [index, feed] of feeds.entries()) {
      if (!feed.url || !feed.url.startsWith("http")) {
        record("topology-seeding-port", `feed[${index}] has missing or invalid URL "${feed.url}"`);
      }
    }
  }

  return {
    agencyId,
    bindingName: TRANSIT_BINDING_NAME,
    sqlitePath: "transit.db",
    issues,
  };
}

function sameIds(expected: readonly string[], actual: readonly string[]): boolean {
  return expected.length === actual.length && expected.every((id, index) => actual[index] === id);
}

function checkRegistryProjections(
  catalog: readonly { readonly manifest: { readonly id: string } }[],
  server: readonly AgencyProvider[],
  browser: readonly BrowserAgency[],
): readonly AgencyCheckIssue[] {
  const issues: AgencyCheckIssue[] = [];
  const record = (check: string, detail: string) => issues.push({ check, detail });
  const catalogIds = catalog.map(({ manifest }) => manifest.id);
  const serverIds = server.map(({ manifest }) => manifest.id);
  const browserIds = browser.map(({ manifest }) => manifest.id);

  if (new Set(catalogIds).size !== catalogIds.length) {
    record("unique-agency-id", "agencyCatalog contains duplicate agency ids");
  }
  if (!sameIds(catalogIds, serverIds)) {
    record("server-projection", "server registry ids or ordering differ from agencyCatalog");
  }
  if (!sameIds(catalogIds, browserIds)) {
    record("browser-projection", "browser registry ids or ordering differ from agencyCatalog");
  }
  return issues;
}

/** A single agency must fit a cold poll; invocation-wide work is paced at runtime. */
function checkCycleSubrequestBudget(
  providers: readonly AgencyProvider[],
): readonly AgencyCheckIssue[] {
  const issues: AgencyCheckIssue[] = [];
  for (const provider of providers) {
    for (const cadence of ["fast", "slow"] as const) {
      const coldPoll = coldPollingSubrequestsForCycle(
        [{ agencyId: provider.manifest.id, sources: provider.alerts ?? [] }],
        cadence,
        "cloudflare",
        () => "provisioned",
      );
      if (coldPoll >= CYCLE_SUBREQUEST_BUDGET)
        issues.push({
          check: "cycle-subrequest-budget",
          detail: `${provider.manifest.id} ${cadence} cold poll needs ${coldPoll} subrequests before dispatch`,
        });
    }
  }
  return issues;
}

export function checkRegisteredAgencies(
  requestedAgencyIds: readonly string[] = [],
  providers: readonly AgencyProvider[] = serverProviders(),
  browser: readonly BrowserAgency[] = browserProviders(),
  catalog: readonly { readonly manifest: { readonly id: string } }[] = agencyCatalog,
): AgencyCheckResult {
  const allIds = providers.map(({ manifest }) => manifest.id);
  const requested = requestedAgencyIds.length > 0 ? requestedAgencyIds : allIds;
  const unknownAgencyIds = requested.filter((id) => !allIds.includes(id));
  const reports = requested.flatMap((id) => {
    const provider = providers.find(({ manifest }) => manifest.id === id);
    return provider ? [checkAgencyProvider(provider)] : [];
  });

  return {
    registryIssues: [
      ...checkRegistryProjections(catalog, providers, browser),
      ...checkCycleSubrequestBudget(providers),
    ],
    unknownAgencyIds,
    reports,
  };
}

function printResult(result: AgencyCheckResult): void {
  for (const issue of result.registryIssues) {
    console.error(`✘ registry/${issue.check}: ${issue.detail}`);
  }
  for (const agencyId of result.unknownAgencyIds) {
    console.error(`✘ ${agencyId}: agency is not registered`);
  }

  for (const report of result.reports) {
    if (report.issues.length === 0) {
      console.log(
        `✔ ${report.agencyId}: valid (D1 ${report.bindingName}; DATA_DIR/${report.sqlitePath})`,
      );
      continue;
    }
    for (const issue of report.issues) {
      console.error(`✘ ${report.agencyId}/${issue.check}: ${issue.detail}`);
    }
  }
}

export function runAgencyCheck(args: readonly string[]): number {
  let parsed: ParsedAgencyCheckArgs;
  try {
    parsed = parseAgencyCheckArgs(args);
  } catch (error) {
    console.error(`[agency:check] ${error instanceof Error ? error.message : String(error)}\n`);
    console.error(USAGE);
    return 1;
  }

  if (parsed.isHelp) {
    console.log(USAGE);
    return 0;
  }

  const result = checkRegisteredAgencies(parsed.agencyIds);
  printResult(result);
  return result.registryIssues.length === 0 &&
    result.unknownAgencyIds.length === 0 &&
    result.reports.every((report) => report.issues.length === 0)
    ? 0
    : 1;
}

if (import.meta.main) {
  process.exitCode = runAgencyCheck(process.argv.slice(2));
}
