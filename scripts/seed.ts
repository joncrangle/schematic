#!/usr/bin/env bun
import { buildZenbusIndex, buildZenbusStopCodeMap } from "../src/infrastructure/gtfs/zenbusArchive";
import { publishSchedules } from "./lib/schedule-publication";
import { generateAgencyAlertIdentities } from "./generate-alert-identities";
import { readSeedFeedHash } from "./lib/gtfs-seeder-core";
/**
 * Unified multi-agency GTFS seeder CLI with mini-TUI.
 *
 * Coordinates static GTFS data ingestion across every registered transit
 * agency and database targets (SQLite, local miniflare D1, or remote Cloudflare D1).
 *
 * Usage:
 *   bun scripts/seed.ts                           # Interactive Mini-TUI wizard
 *   bun scripts/seed.ts --agency=ttc --db=both     # Non-interactive CLI
 *   bun scripts/seed.ts --agency=all --db=sqlite   # Ingest all agencies into SQLite
 *   bun scripts/seed.ts --agency=go --zip=foo.zip  # Custom feed archive override
 */

import { stationMembershipSequences } from "../src/domain/map/stationSequence";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import * as Schema from "effect/Schema";
import {
  getAllAgencySeedConfigs,
  getAgencySeedConfig,
  matchesAgencyScope,
  type AgencySeedConfig,
  FeedFetchError,
  fetchAllAgencyArchives,
  seedAgencyD1,
  seedAgencyRemoteD1,
  seedAgencySqlite,
  readSeededTables,
  resolveAgencySqlitePath,
} from "./lib/gtfs-seeder-core";
import {
  buildSubwayStationIndex,
  findMissingPopularRoutes,
  findStationsWithoutPlatforms,
  mergeStationIndex,
  type AliasCandidate,
  type GtfsStopRow,
  type SubwayStationsArtifact,
  type UnmatchedPlatform,
} from "./lib/subway-stations";
import {
  compileInterchanges,
  decodeInterchangeOverrides,
  stationsFromSeededTables,
  type InterchangeStation,
} from "./lib/interchange-detection";
import {
  InterchangeDatasetSchema,
  type InterchangeDataset,
  type InterchangeOverrides,
} from "../src/domain/map/Interchange";
import {
  SchematicSchema,
  type Schematic,
  type SchematicStationIndexEntry,
} from "../src/agencies/types";
import { projectInterchangeBadgeAgencies } from "~/core/map/interchange-agencies";
import type {
  InterchangePlacementOptions,
  InterchangeLayoutReport,
} from "./lib/interchange-placement";
import { allProviders } from "~/agencies/registry";
import { buildTmixStopAreaIndex } from "~/infrastructure/gtfs/tmixStopAreaIndex";
import { buildTsimobileGtfsIndex } from "~/infrastructure/gtfs/tsimobileIndex";
import { buildTrainMapGtfsIndex } from "~/infrastructure/gtfs/trainMapIndex";
import { stationTimetableDirections } from "~/infrastructure/gtfs/stationTimetableArchive";
import {
  buildFerrySailingLegIndex,
  terminalDisplayName,
} from "~/infrastructure/gtfs/ferrySailingLegIndex";
import { projectGtfsTopology, type GtfsTopology } from "~/infrastructure/gtfs/staticTopology";
import {
  EmptyGtfsEntryError,
  processArchiveCsv,
  readGtfsArchive,
} from "~/infrastructure/gtfs/archive";
import {
  promptMultiSelect,
  promptSingleSelect,
  PromptCancelledError,
  type SelectOption,
} from "./lib/mini-tui";

export type DbTarget = "sqlite" | "d1" | "both" | "remote";

export interface ParsedSeedArgs {
  agencies: string[];
  dbTarget?: DbTarget;
  zipArg?: string;
  scope?: string;
  interchangesOnly?: boolean;
  databaseOnly?: boolean;
  isHelp?: boolean;
}

export function parseCliArgs(args: readonly string[]): ParsedSeedArgs {
  const result: ParsedSeedArgs = { agencies: [] };

  for (const arg of args) {
    if (arg === "-h" || arg === "--help") {
      result.isHelp = true;
      continue;
    }

    if (arg === "--database-only") {
      result.databaseOnly = true;
      continue;
    }

    if (arg === "--interchange-only" || arg === "--interchanges-only") {
      result.interchangesOnly = true;
      continue;
    }

    const agencyMatch = /^--agency=(.+)$/.exec(arg);
    if (agencyMatch) {
      const val = agencyMatch[1].trim().toLowerCase();
      if (val === "all") {
        result.agencies = getAllAgencySeedConfigs().map((c) => c.id);
      } else {
        const list = val
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        result.agencies.push(...list);
      }
      continue;
    }

    const dbMatch = /^--db=(.*)$/.exec(arg);
    if (dbMatch) {
      const val = dbMatch[1].trim().toLowerCase() as DbTarget;
      if (["sqlite", "d1", "both", "remote"].includes(val)) {
        result.dbTarget = val;
      } else {
        throw new Error(
          `Invalid --db value "${dbMatch[1]}". Expected sqlite, d1, both, or remote.`,
        );
      }
      continue;
    }

    const scopeMatch = /^--scope=(.+)$/.exec(arg);
    if (scopeMatch) {
      result.scope = scopeMatch[1].trim().toLowerCase();
      continue;
    }

    const zipMatch = /^--zip=(.+)$/.exec(arg);
    if (zipMatch) {
      result.zipArg = zipMatch[1];
    }
  }

  // Deduplicate agencies
  result.agencies = Array.from(new Set(result.agencies));
  if (result.scope) {
    const scopeConfigs = getAllAgencySeedConfigs().filter((config) =>
      matchesAgencyScope(config, result.scope!),
    );
    const scopedIds = new Set(scopeConfigs.map((config) => config.id));
    result.agencies =
      result.agencies.length > 0
        ? result.agencies.filter((agency) => {
            const config = getAgencySeedConfig(agency);
            return config ? scopedIds.has(config.id) : false;
          })
        : scopeConfigs.map((config) => config.id);
  }
  if (result.zipArg && result.agencies.length > 1)
    throw new Error("--zip can only be used with one agency.");
  if (result.databaseOnly && result.interchangesOnly)
    throw new Error("--database-only cannot regenerate interchange artifacts.");
  return result;
}

function printHelp() {
  const seedable = getAllAgencySeedConfigs()
    .map((c) => c.id)
    .join("|");
  console.log(`
${"\x1B[1m"}Schematic — Unified GTFS Seeder CLI${"\x1B[0m"}

${"\x1B[1m"}Usage:${"\x1B[0m"}
  bun scripts/seed.ts [options]

${"\x1B[1m"}Options:${"\x1B[0m"}
  --agency=<${seedable || "id"}|all>   Target agency or comma-separated list (default: prompt if TTY)
  --scope=<path|regional|national|international>  Limit discovery to an agency scope
  --db=<sqlite|d1|both|remote>   Database target (default: both; database-only: sqlite)
  --database-only         Initialize SQLite without rewriting source or generated assets
  --zip=<path|url>        Override GTFS zip file/URL (for single agency run)
  --interchange-only      Regenerate static interchanges from existing SQLite databases without prompting
  -h, --help              Show this help message

${"\x1B[1m"}Interactive Mode:${"\x1B[0m"}
  Running \`bun scripts/seed.ts\` without flags launches the interactive Mini-TUI.
`);
}

/** Ingests one agency into every requested target. Returns its SQLite path, if any. */
export type AgencySeeder = (
  config: AgencySeedConfig,
  zipBuffers: readonly Buffer[],
) => Promise<string | undefined>;

export interface SeedRunResult {
  readonly requestedAgencyIds: readonly string[];
  readonly seededAgencyIds: readonly string[];
  /** Requested agencies skipped for an unknown id or an unavailable/incomplete feed set. */
  readonly skippedAgencyIds: readonly string[];
  /** Unavailable feeds that caused their agency to be skipped. */
  readonly skippedFeeds: readonly FeedFetchError[];
}

/** Keeps the run banner readable when the scope covers dozens of agencies. */
function formatAgencyScope(agencies: readonly string[]): string {
  if (agencies.length === 0) return "none";
  if (agencies.length <= 8) return agencies.join(", ");
  return `${agencies.length} agencies`;
}

export async function runSeeder(options: {
  agencies: string[];
  dbTarget: DbTarget;
  databaseOnly?: boolean;
  zipArg?: string;
  /** Injected in tests; defaults to the real downloader. */
  fetchArchives?: typeof fetchAllAgencyArchives;
  /** Injected in tests; defaults to the real SQLite/D1 ingestion. */
  seedAgency?: AgencySeeder;
  /** Injected in tests; defaults to regenerating the shared interchange artifact. */
  compileInterchangesStep?: typeof compileStaticInterchanges;
}): Promise<SeedRunResult> {
  const startTime = Date.now();
  const {
    agencies,
    dbTarget,
    databaseOnly,
    zipArg,
    fetchArchives,
    seedAgency,
    compileInterchangesStep,
  } = options;
  if (zipArg && agencies.length > 1) throw new Error("--zip can only be used with one agency.");
  if (databaseOnly && dbTarget !== "sqlite")
    throw new Error("Database-only initialization requires --db=sqlite.");
  const fetchAll = fetchArchives ?? fetchAllAgencyArchives;
  const seed =
    seedAgency ??
    ((config, zipBuffers) =>
      databaseOnly
        ? seedAgencySqlite(config, zipBuffers)
        : seedAgencyTargets(config, zipBuffers, dbTarget));
  const seededDbPaths = new Map<string, string>();
  const seededAgencyIds: string[] = [];
  const skippedAgencyIds: string[] = [];
  const skippedFeeds: FeedFetchError[] = [];

  console.log(
    `\n\x1B[1m\x1B[36m🚀 Starting GTFS Seeding Pipeline\x1B[0m [Agencies: ${formatAgencyScope(agencies)} | Target: ${dbTarget}]\n`,
  );

  for (const agencyId of agencies) {
    const config: AgencySeedConfig | undefined = getAgencySeedConfig(agencyId);
    if (!config) {
      console.warn(
        `[seed] Unknown agency id "${agencyId}" or no static feeds declared in manifest — skipping.`,
      );
      skippedAgencyIds.push(agencyId);
      continue;
    }

    console.log(`\n\x1B[1m=== Processing ${config.name} (${config.id.toUpperCase()}) ===\x1B[0m`);

    // 1. Fetch or cache archives. An unavailable feed skips its agency, not the full run.
    let zipBuffers: readonly Buffer[];
    let feedFailures: readonly FeedFetchError[] = [];
    try {
      const archives = await fetchAll(config, agencies.length === 1 ? zipArg : undefined);
      zipBuffers = archives.buffers;
      feedFailures = archives.failures;
      skippedFeeds.push(...archives.failures);
    } catch (err) {
      if (!(err instanceof FeedFetchError)) throw err;
      feedFailures = [err];
      skippedFeeds.push(err);
      zipBuffers = [];
    }

    if (feedFailures.length > 0 || zipBuffers.length !== config.feeds.length) {
      console.warn(
        `[seed:${config.id}] Incomplete GTFS input (${zipBuffers.length}/${config.feeds.length} archives) — skipping this agency; its topology and station-index artifacts are left untouched.`,
      );
      skippedAgencyIds.push(config.id);
      continue;
    }

    // 2. Ingest into the requested databases
    let sqlitePath: string | undefined;
    try {
      sqlitePath = await seed(config, zipBuffers);
    } catch (error) {
      if (!(error instanceof EmptyGtfsEntryError)) throw error;
      console.warn(
        `[seed:${config.id}] ${error.message} — skipping this agency; its topology and station-index artifacts are left untouched.`,
      );
      skippedAgencyIds.push(config.id);
      continue;
    }
    if (sqlitePath) seededDbPaths.set(config.id, sqlitePath);
    seededAgencyIds.push(config.id);
  }

  // The requested scope, not the agencies that seeded. A feed outage is not a
  // subset run: `compileStaticInterchanges` falls back to each skipped agency's
  // previously seeded database on disk, so the artifact still compiles from real
  // data instead of freezing because one operator had a bad afternoon.
  if (!databaseOnly)
    (compileInterchangesStep ?? compileStaticInterchanges)(seededDbPaths, agencies, seededAgencyIds);

  const result: SeedRunResult = {
    requestedAgencyIds: [...agencies],
    seededAgencyIds,
    skippedAgencyIds,
    skippedFeeds,
  };
  const durationSec = ((Date.now() - startTime) / 1000).toFixed(1);
  const warnings: string[] = [];
  if (skippedFeeds.length > 0) {
    warnings.push(
      `[seed] ${skippedFeeds.length} GTFS feed(s) unavailable: ${skippedFeeds
        .map((failure) => `${failure.agencyId}/${failure.feed.cacheFileName} (${failure.reason})`)
        .join(", ")}`,
    );
  }
  if (skippedAgencyIds.length > 0) {
    warnings.push(
      `[seed] Skipped ${skippedAgencyIds.length} agency(ies) with nothing to seed: ${skippedAgencyIds.join(", ")}`,
    );
  }
  if (warnings.length === 0) {
    console.log(`\n\x1B[32m✔ GTFS Seeding Completed Successfully in ${durationSec}s\x1B[0m\n`);
  } else {
    console.warn(
      `\n\x1B[33m⚠ GTFS Seeding completed with skips in ${durationSec}s: ${seededAgencyIds.length}/${agencies.length} agencies seeded\x1B[0m`,
    );
    for (const warning of warnings) console.warn(warning);
    console.warn("");
  }
  return result;
}

/** Writes a seed-generated feed index back into the manifest, touching the file only on change. */
function rewriteManifestFeed(
  path: string,
  kind: string,
  update: (feed: Record<string, unknown>) => Record<string, unknown>,
): void {
  const source = readFileSync(path, "utf8");
  const raw = JSON.parse(source);
  raw.realtime.feeds = raw.realtime.feeds.map((feed: Record<string, unknown>) =>
    feed.kind === kind ? update(feed) : feed,
  );
  const updated = JSON.stringify(raw, null, 2) + "\n";
  if (updated !== source) writeFileSync(path, updated);
}

/** Rebuilds one agency's station index, then writes the targets the run selected. */
async function seedAgencyTargets(
  config: AgencySeedConfig,
  zipBuffers: readonly Buffer[],
  dbTarget: DbTarget,
): Promise<string | undefined> {
  const provider = allProviders().find((candidate) => candidate.manifest.id === config.id);
  const topology = await projectGtfsTopology(zipBuffers, config);
  const manifestPath = resolve(process.cwd(), "src/agencies", config.scopePath, "manifest.json");
  const samsara = provider?.staticTopology.feeds?.find((feed) => feed.samsaraStations);
  if (samsara) {
    const { fetchSamsaraStations } = await import("../src/infrastructure/gtfs/samsaraStationsArchive");
    const { stations } = await fetchSamsaraStations(samsara.url, fetch, samsara.samsaraStations?.coordinateOverrides, samsara.samsaraStations?.routeAliases);
    rewriteManifestFeed(manifestPath, "samsara_boards", (feed) => ({ ...feed, stations }));
  }
  const cityway = provider?.realtime?.feeds.find((feed) => feed.kind === "cityway");
  if (cityway) {
    const { buildCitywayIndex } = await import("../src/infrastructure/gtfs/citywayIndex");
    const stopMap = await buildCitywayIndex(cityway, zipBuffers, fetch);
    rewriteManifestFeed(manifestPath, "cityway", (feed) => ({ ...feed, stopMap }));
  }
  const passio = provider?.staticTopology.feeds?.find((feed) => feed.passio);
  if (passio?.passio) {
    const { fetchPassioTopology } = await import("../src/infrastructure/gtfs/passioArchive");
    const { routeMap, stopRoutes } = await fetchPassioTopology(
      { ...passio, passio: passio.passio },
      fetch,
    );
    rewriteManifestFeed(manifestPath, "passio", (feed) => ({ ...feed, routeMap, stopRoutes }));
  }
  if (provider?.realtime?.feeds.some((feed) => feed.kind === "zenbus")) {
    const gtfsIndex = await buildZenbusIndex(zipBuffers);
    rewriteManifestFeed(manifestPath, "zenbus", (feed) => ({ ...feed, gtfsIndex }));
    const raw = JSON.parse(readFileSync(manifestPath, "utf8"));
    const stopCodeMap = await buildZenbusStopCodeMap(zipBuffers);
    raw.alerts = raw.alerts?.map((source: Record<string, unknown>) =>
      source.type === "zenbus-messages" ? { ...source, stopCodeMap } : source,
    );
    writeFileSync(manifestPath, JSON.stringify(raw, null, 2) + "\n");
  }
  if (provider?.realtime?.feeds.some((feed) => feed.kind === "tsimobile")) {
    const gtfsIndex = await buildTsimobileGtfsIndex(zipBuffers);
    rewriteManifestFeed(manifestPath, "tsimobile", (feed) => ({ ...feed, gtfsIndex }));
  }
  if (provider?.realtime?.feeds.some((feed) => feed.kind === "train_map")) {
    const gtfsIndex = await buildTrainMapGtfsIndex(zipBuffers, config.sourceAgencyIds);
    rewriteManifestFeed(manifestPath, "train_map", (feed) => ({ ...feed, gtfsIndex }));
  }
  if (provider?.realtime?.feeds.some((feed) => feed.kind === "station_timetables")) {
    const directions = Object.assign(
      {},
      ...(await Promise.all(zipBuffers.map((bytes) => stationTimetableDirections(bytes)))),
    );
    rewriteManifestFeed(manifestPath, "station_timetables", (feed) => ({ ...feed, directions }));
  }
  const ferryFeed = provider?.realtime?.feeds.find((feed) => feed.kind === "ferry_sailing_boards");
  if (ferryFeed?.kind === "ferry_sailing_boards") {
    const index = await buildFerrySailingLegIndex(zipBuffers, ferryFeed.terminals);
    rewriteManifestFeed(manifestPath, "ferry_sailing_boards", (feed) => ({ ...feed, ...index }));
  }
  if (provider?.realtime?.feeds.some((feed) => feed.kind === "tmix_anyride" && feed.stopAreaMap)) {
    const path = resolve(process.cwd(), "src/agencies", config.scopePath, "manifest.json");
    const raw = JSON.parse(readFileSync(path, "utf8"));
    for (const [index, feed] of provider.realtime.feeds.entries()) {
      if (feed.kind === "tmix_anyride" && feed.stopAreaMap)
        raw.realtime.feeds[index].stopAreaMap = await buildTmixStopAreaIndex(zipBuffers, feed);
    }
    const updated = JSON.stringify(raw, null, 2) + "\n";
    if (updated !== readFileSync(path, "utf8")) writeFileSync(path, updated);
  }
  await compileStaticStationIndex(config, zipBuffers, { topology });

  // SQLite is the source for both D1 paths, so every non-SQLite target implies it.
  let sqlitePath: string | undefined;
  if (dbTarget === "sqlite" || dbTarget === "both" || dbTarget === "d1" || dbTarget === "remote") {
    sqlitePath = await seedAgencySqlite(config, zipBuffers, undefined, topology);
    const sourceHash = readSeedFeedHash(sqlitePath, config.id);
    if (!sourceHash) throw new Error("Seeded GTFS hash missing");
    generateAgencyAlertIdentities(config.id, topology, sourceHash);
    if (
      provider?.realtime?.feeds.some(
        (feed) => feed.kind === "trip_updates" && feed.predictionTimeSource === "static-with-delay",
      )
    )
      await publishSchedules({
        agencyId: config.id,
        sourceHash,
        archives: zipBuffers,
        identities: config.feedIdentities,
        catalogFile: resolve("src/generated/gtfs-schedules.json"),
        publicDir: resolve("public"),
        eligible: (id) =>
          allProviders()
            .find((provider) => provider.manifest.id === id)
            ?.realtime?.feeds.some(
              (feed) =>
                feed.kind === "trip_updates" && feed.predictionTimeSource === "static-with-delay",
            ) ?? false,
      });
  }

  if (dbTarget === "d1" || dbTarget === "both") {
    await seedAgencyD1(config, sqlitePath);
  }
  if (dbTarget === "remote") {
    await seedAgencyRemoteD1(config, sqlitePath);
  }
  return sqlitePath;
}

export function hasCompleteSeedScope(
  selectedAgencyIds: readonly string[],
  requiredAgencyIds: readonly string[],
): boolean {
  const selected = new Set(selectedAgencyIds);
  return requiredAgencyIds.every((agencyId) => selected.has(agencyId));
}

export function interchangeAgencyIds(
  dataset: InterchangeDataset,
  overrides: InterchangeOverrides,
): readonly string[] {
  const agencyIds = new Set([
    ...dataset.flatMap((hub) => hub.endpoints.map((endpoint) => endpoint.agencyId)),
    ...(overrides.boardingIdentityAgencyIds ?? []),
    ...overrides.hubs.flatMap((hub) => hub.endpoints?.map((endpoint) => endpoint.agencyId) ?? []),
    ...overrides.exclusions.flatMap((exclusion) => [
      exclusion.left.agencyId,
      exclusion.right.agencyId,
    ]),
  ]);
  const configuredAgencyIds = getAllAgencySeedConfigs()
    .map((config) => config.id)
    .sort((first, second) => second.length - first.length);
  for (const override of overrides.hubs) {
    let remaining = override.id ?? "";
    while (remaining) {
      const agencyId = configuredAgencyIds.find(
        (candidate) => remaining === candidate || remaining.startsWith(`${candidate}-`),
      );
      if (!agencyId) break;
      agencyIds.add(agencyId);
      remaining = remaining.slice(agencyId.length).replace(/^-/, "");
    }
  }
  return [...agencyIds].sort();
}

export function compileInterchangeArtifact(
  stations: readonly InterchangeStation[],
  overrides: InterchangeOverrides,
  schematics: ReadonlyMap<string, Schematic>,
  placement: InterchangePlacementOptions = {},
): InterchangeDataset {
  return Schema.decodeUnknownSync(InterchangeDatasetSchema)(
    compileInterchanges(stations, overrides, schematics, placement),
  );
}

function compileStaticInterchanges(
  seededDbPaths: ReadonlyMap<string, string>,
  selectedAgencyIds: readonly string[],
  _seededAgencyIds: readonly string[],
): void {
  const configs = getAllAgencySeedConfigs();
  const regionForAgency = new Map(configs.map((config) => [config.id, dirname(config.scopePath)]));
  const regions = [...new Set(regionForAgency.values())].sort().map((path) => {
    const directory = resolve(process.cwd(), "src/agencies", path);
    const artifactPath = resolve(directory, "interchanges.jsonc");
    const overridesPath = resolve(directory, "interchanges.overrides.json");
    const previous = existsSync(artifactPath)
      ? Schema.decodeUnknownSync(InterchangeDatasetSchema)(
          JSON.parse(readFileSync(artifactPath, "utf8").replace(/^\s*\/\/.*$/gm, "")),
        )
      : [];
    const overrides = decodeInterchangeOverrides(
      existsSync(overridesPath)
        ? JSON.parse(readFileSync(overridesPath, "utf8"))
        : { hubs: [], exclusions: [] },
    );
    return { path, directory, artifactPath, previous, overrides };
  });
  console.log("[seed:interchanges] Compiling static interchanges from every seeded agency...");
  const tablesByAgency = new Map(
    configs.flatMap((config) => {
      const path = seededDbPaths.get(config.id) ?? resolveAgencySqlitePath(config);
      if (!existsSync(path)) return [];
      const tables = readSeededTables(path, config.id);
      return ["stops", "routes"].every((name) =>
        tables.some((table) => table.table === name && table.rows.length > 0),
      )
        ? [[config.id, tables] as const]
        : [];
    }),
  );
  const interchangeConfigs = configs.filter((config) => tablesByAgency.has(config.id));

  // Missing data blocks only artifacts which already depend on that agency.
  // National and international peers can be required by several regions.
  const completeRegions = regions.filter((region) => {
    const missing = interchangeAgencyIds(region.previous, region.overrides).filter(
      (id) => !tablesByAgency.has(id),
    );
    if (missing.length === 0) return true;
    console.warn(
      `[seed:interchanges] Skipping ${region.path}: missing seeded data for ${missing.join(", ")}. The previous artifact is left in place.`,
    );
    return false;
  });
  const canonicalStationsByAgency = new Map(
    allProviders().map((provider) => [
      provider.manifest.id,
      provider.schematic?.stations.map(({ id, name }) => {
        const indexed = provider.schematic?.stationIndex?.find(
          (station) => (station.schematicId ?? station.id) === id,
        );
        return {
          id,
          name,
          ...(indexed
            ? { lat: indexed.lat, lon: indexed.lon, platformIds: indexed.platformIds }
            : {}),
        };
      }) ?? [],
    ]),
  );
  const allRegionalStations = [...canonicalStationsByAgency.values()].flat();
  const canonicalAliasesByAgency = new Map(
    allProviders().map((provider) => [
      provider.manifest.id,
      provider.schematic?.stationAliases ?? {},
    ]),
  );
  const stations = interchangeConfigs.flatMap((config) => {
    return stationsFromSeededTables(
      config.id,
      tablesByAgency.get(config.id) ?? [],
      canonicalStationsByAgency.get(config.id),
      allRegionalStations,
      canonicalAliasesByAgency.get(config.id),
    );
  });
  const schematics = new Map(
    allProviders().flatMap((provider) =>
      provider.schematic ? [[provider.manifest.id, provider.schematic] as const] : [],
    ),
  );
  const overrides: InterchangeOverrides = {
    hubs: completeRegions.flatMap((region) => region.overrides.hubs),
    boardingIdentityAgencyIds: [
      ...new Set(regions.flatMap((region) => region.overrides.boardingIdentityAgencyIds ?? [])),
    ],
    // Keep cross-border exclusions when both sides have station data.
    exclusions: regions.flatMap((region) => region.overrides.exclusions).filter(
      ({ left, right }) => tablesByAgency.has(left.agencyId) && tablesByAgency.has(right.agencyId),
    ),
    isolated: regions.flatMap((region) => region.overrides.isolated ?? []).filter(
      (endpoint) => tablesByAgency.has(endpoint.agencyId),
    ),
  };
  let placementReport: InterchangeLayoutReport = {
    changes: [],
    conflicts: [],
    walkingFallbacks: [],
  };
  const previous = regions.flatMap((region) => region.previous);
  const compiled = compileInterchangeArtifact(stations, overrides, schematics, {
    agencies: projectInterchangeBadgeAgencies(allProviders()),
    previous,
    onReport: (report) => {
      placementReport = report;
    },
  });
  const byRegion = new Map<string, InterchangeDataset>();
  for (const hub of compiled) {
    const owner = regionForAgency.get(hub.endpoints[0]!.agencyId);
    if (!owner) throw new Error(`[seed:interchanges] Unknown first-endpoint agency in ${hub.id}`);
    byRegion.set(owner, [...(byRegion.get(owner) ?? []), hub]);
  }
  const selected = new Set(selectedAgencyIds);
  const touchesSelection = (hubs: InterchangeDataset) =>
    hubs.some((hub) => hub.endpoints.some((endpoint) => selected.has(endpoint.agencyId)));
  for (const region of completeRegions) {
    const hubs = byRegion.get(region.path) ?? [];
    // A targeted national seed also updates regional artifacts containing its
    // endpoints. An interchange-only run passes no selection and updates all.
    if (
      selected.size > 0 &&
      !configs.some(
        (config) => selected.has(config.id) && regionForAgency.get(config.id) === region.path,
      ) &&
      !touchesSelection(region.previous) &&
      !touchesSelection(hubs)
    )
      continue;
    if (hubs.length === 0 && !existsSync(region.artifactPath)) continue;
    mkdirSync(region.directory, { recursive: true });
    const banner = `// This file was automatically generated by scripts/seed.ts.
// You should NOT make any changes in this file as it will be overwritten.
// Additionally, you should also exclude this file from your linter and/or formatter to prevent it from being checked or modified.

${JSON.stringify(hubs, null, 2)}
`;
    const isNewArtifact = !existsSync(region.artifactPath);
    writeFileSync(region.artifactPath, banner);
    if (isNewArtifact)
      console.log(
        `[seed:interchanges] Register ${region.path}/interchanges.jsonc in src/agencies/interchangeCatalog.ts before building.`,
      );
    console.log(
      `[seed:interchanges] Compiled ${hubs.length} static hubs at ${region.artifactPath}`,
    );
  }
  for (const change of placementReport.changes)
    console.log(
      `[seed:interchanges] ${change.agencyId}:${change.hubId} ${JSON.stringify(change.previous ?? null)} -> ${JSON.stringify(change.next)} (${change.reason})`,
    );
  const reportPath = resolve(
    dirname(resolveAgencySqlitePath()),
    "interchange-placement-report.json",
  );
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, `${JSON.stringify(placementReport, null, 2)}\n`);
  console.log(
    `[seed:interchanges] Placement: ${placementReport.changes.length} changed rows; ${placementReport.conflicts.length} unresolved conflicts; ${placementReport.walkingFallbacks.length} walking fallbacks. Review ${reportPath}`,
  );
}

/**
 * Best-effort `bun format` normalization for the rewritten schematic file.
 * The stationIndex serializer always expands arrays, while the repo formatter
 * collapses short ones; without this pass every seed run would flip-flop
 * against `bun format`. Falls back to the raw serializer output when the
 * formatter binary is unavailable (e.g. pruned production installs).
 */
export function normalizeSchematicFormatting(outputPath: string, agencyId: string): void {
  const bunRuntime = globalThis as typeof globalThis & {
    Bun?: {
      spawnSync: (
        args: readonly string[],
        options: { stdout: "ignore"; stderr: "ignore" },
      ) => { exitCode: number };
    };
  };
  if (!bunRuntime.Bun) {
    console.warn(
      `[seed:${agencyId}:station-index] formatter unavailable; schematic left unformatted (run \`bun format\`)`,
    );
    return;
  }
  const candidates = [
    join(
      process.cwd(),
      "node_modules",
      ".bin",
      process.platform === "win32" ? "oxfmt.cmd" : "oxfmt",
    ),
    "oxfmt",
  ];
  for (const command of candidates) {
    try {
      const result = bunRuntime.Bun.spawnSync([command, outputPath], {
        stdout: "ignore",
        stderr: "ignore",
      });
      if (result.exitCode === 0) return;
    } catch {
      continue;
    }
  }
  console.warn(
    `[seed:${agencyId}:station-index] formatter unavailable; schematic left unformatted (run \`bun format\`)`,
  );
}

/** Replaces one root-level JSON array while preserving the schematic's layout. */
export function replaceStationIndexInSchematic(
  source: string,
  stationIndex: readonly SchematicStationIndexEntry[],
): string {
  const serialized = JSON.stringify(stationIndex, null, 2)
    .split("\n")
    .map((line, index) => (index === 0 ? line : `  ${line}`))
    .join("\n");
  const propertyOffset = source.indexOf('"stationIndex"');
  if (propertyOffset === -1) {
    const objectEnd = source.lastIndexOf("\n}");
    if (objectEnd === -1) throw new Error("Schematic JSON has no root object terminator");
    return `${source.slice(0, objectEnd)},\n  "stationIndex": ${serialized}${source.slice(objectEnd)}`;
  }

  const arrayStart = source.indexOf("[", propertyOffset);
  if (arrayStart === -1) throw new Error("Schematic stationIndex property has no array value");
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = arrayStart; index < source.length; index++) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') {
      inString = true;
    } else if (character === "[") {
      depth++;
    } else if (character === "]") {
      depth--;
      if (depth === 0) {
        return source.slice(0, arrayStart) + serialized + source.slice(index + 1);
      }
    }
  }
  throw new Error("Schematic stationIndex property has an unterminated array");
}

export function compileStationIndexArtifact(
  schematic: unknown,
  rows: readonly GtfsStopRow[],
): SubwayStationsArtifact {
  const validatedSchematic = Schema.decodeUnknownSync(SchematicSchema)(schematic);
  if (!validatedSchematic.sequences) {
    return { stations: [], unmatchedPlatforms: [], aliasCandidates: [] };
  }
  const artifact = buildSubwayStationIndex(
    rows,
    stationMembershipSequences(validatedSchematic),
    undefined,
    validatedSchematic.stationAliases,
    new Map(validatedSchematic.stations.map((station) => [station.id, station.name])),
  );
  Schema.decodeUnknownSync(SchematicSchema)({
    ...validatedSchematic,
    stationIndex: artifact.stations,
  });
  return artifact;
}

export interface CompileStaticStationIndexOptions {
  /** Projection already used by SQLite seeding for this archive set. */
  readonly topology: GtfsTopology;
  /** Output override for isolated callers such as the unit tests. */
  readonly schematicPath?: string;
}

export interface StationIndexDriftReport {
  readonly sequences: Readonly<Record<string, readonly string[]>>;
  readonly stationIndex: readonly SchematicStationIndexEntry[];
  readonly aliasCandidates: readonly AliasCandidate[];
  readonly unmatchedPlatforms: readonly UnmatchedPlatform[];
  readonly popularRoutes: readonly string[];
  readonly feedRouteIds: readonly string[];
  readonly routeLineMap: Readonly<Record<string, string>>;
}

/**
 * Feed-vs-manifest drift the seeder cannot fix on its own: curated stations
 * with no feed platforms, feed stops begging for an alias, child platforms
 * of unknown parents, and manifest-declared popular routes missing from the
 * feed. Pure formatting over the audit helpers so unit tests pin the wording
 * without touching the network.
 */
export function formatStationIndexDriftWarnings(
  agencyId: string,
  report: StationIndexDriftReport,
): readonly string[] {
  const warnings: string[] = [];
  const prefix = `[seed:${agencyId}:station-index]`;

  const stranded = findStationsWithoutPlatforms(report.sequences, report.stationIndex);
  if (stranded.length > 0) {
    warnings.push(
      `${prefix} Sequence stations with no feed platforms (departures unavailable): ${stranded.join(", ")}`,
    );
  }

  if (report.aliasCandidates.length > 0) {
    warnings.push(
      `${prefix} Top-level stops matching schematic stations without an alias: ${report.aliasCandidates
        .map((candidate) => `"${candidate.stopName}" → ${candidate.schematicId}`)
        .join(", ")}`,
    );
  }

  if (report.unmatchedPlatforms.length > 0) {
    const shown = report.unmatchedPlatforms.slice(0, 15);
    const remainder =
      report.unmatchedPlatforms.length > shown.length
        ? ` (+${report.unmatchedPlatforms.length - shown.length} more)`
        : "";
    warnings.push(
      `${prefix} Child platforms of unknown parent stations (not indexed): ${shown
        .map((platform) => `${platform.stopId} (${platform.name})`)
        .join(", ")}${remainder}`,
    );
  }

  const missingPopular = findMissingPopularRoutes(
    report.popularRoutes,
    report.feedRouteIds,
    report.routeLineMap,
  );
  if (missingPopular.length > 0) {
    warnings.push(
      `${prefix} Manifest popular routes missing from the feed: ${missingPopular.join(", ")}`,
    );
  }

  return warnings;
}

export async function compileStaticStationIndex(
  config: AgencySeedConfig,
  zipBuffers: readonly Buffer[],
  options: CompileStaticStationIndexOptions,
): Promise<void> {
  const provider = allProviders().find((candidate) => candidate.manifest.id === config.id);
  const schematic = provider?.schematic;
  if (!provider || !schematic?.sequences || !provider.manifest.stationService) return;

  const rows: GtfsStopRow[] = [];
  const feedRouteIds: string[] = [];
  for (const [index, buffer] of zipBuffers.entries()) {
    const archive = readGtfsArchive(buffer, config.feedIdentities?.[index]);
    await processArchiveCsv(
      archive,
      "stops.txt",
      ["stop_id", "stop_name", "stop_lat", "stop_lon"],
      (get) => {
        const locationType = get("location_type");
        rows.push({
          stopId: get("stop_id"),
          stopCode: get("stop_code") || undefined,
          stopName: get("stop_name"),
          stopLat: Number.parseFloat(get("stop_lat")),
          stopLon: Number.parseFloat(get("stop_lon")),
          locationType: locationType === "" ? 0 : Number.parseInt(locationType, 10),
          parentStation: get("parent_station") || null,
        });
      },
    );
    await processArchiveCsv(archive, "routes.txt", ["route_id"], (get) => {
      if (config.sourceAgencyIds && !config.sourceAgencyIds.includes(get("agency_id"))) return;
      if (config.excludedRouteIds?.includes(get("route_id"))) return;
      const routeId =
        config.routeIdField === "short_name"
          ? get("route_short_name") || get("route_id")
          : get("route_id");
      if (routeId) feedRouteIds.push(routeId);
    });
  }
  // A shared archive's station parents may also own platforms used only by partners.
  const selectedRows = config.sourceAgencyIds
    ? (() => {
        const included = new Set((options.topology.stops ?? []).map((stop) => String(stop.id)));
        const byId = new Map(rows.map((row) => [row.stopId, row]));
        for (const id of included) {
          const parent = byId.get(id)?.parentStation;
          if (parent) included.add(parent);
        }
        return rows.filter((row) => included.has(row.stopId));
      })()
    : rows;
  const artifact = compileStationIndexArtifact(schematic, selectedRows);
  // A network document can predict every rail station, including stations
  // omitted from the simplified drawing. Keep those in the geographic index
  // with feed identity only; they do not become schematic navigation targets.
  const networkFeed = provider.realtime?.feeds.find(
    (feed) =>
      feed.kind === "tsimobile" || feed.kind === "train_map" || feed.kind === "station_timetables",
  );
  const routesByStop = new Map(
    (options.topology.stops ?? []).map((stop) => [
      String(stop.id),
      JSON.parse(String(stop.routes_json)) as string[],
    ]),
  );
  const routesForStation = (station: SchematicStationIndexEntry) =>
    [...new Set(station.platformIds.flatMap((id) => routesByStop.get(id) ?? []))].sort();
  let generatedStations = artifact.stations.map((station) => ({
    ...station,
    departureRouteIds: routesForStation(station),
  }));
  if (networkFeed) {
    const drawnByPlatform = new Map(
      artifact.stations.flatMap((station) =>
        station.platformIds.map((id) => [id, station] as const),
      ),
    );
    const drawnLineIds = new Set(schematic.lines.map((line) => line.id));
    generatedStations = (options.topology.stops ?? []).map((stop) => {
      const drawn = drawnByPlatform.get(String(stop.id));
      const routes = JSON.parse(String(stop.routes_json)) as string[];
      return {
        id: String(stop.code ?? stop.id),
        ...(drawn?.schematicId ? { schematicId: drawn.schematicId } : {}),
        name: drawn?.name ?? String(stop.name),
        lat: Number(stop.lat),
        lon: Number(stop.lon),
        // Undrawn routes still depart here; only drawn lines can be station lines.
        lines: [
          ...new Set(
            routes.map((id) => provider.manifest.alertInterpretation?.routeLineMap?.[id] ?? id),
          ),
        ]
          .filter((id) => drawnLineIds.has(id))
          .sort(),
        platformIds: [String(stop.id)],
        departureRouteIds: routes,
      };
    });
  }
  const ferryFeed = provider.realtime?.feeds.find((feed) => feed.kind === "ferry_sailing_boards");
  if (ferryFeed?.kind === "ferry_sailing_boards") {
    // Boards are per terminal, so each declared terminal is one station with
    // its berths as platforms; undrawn terminals keep feed identity only.
    const drawnByPlatform = new Map(
      artifact.stations.flatMap((station) =>
        station.platformIds.map((id) => [id, station] as const),
      ),
    );
    const drawnLineIds = new Set(schematic.lines.map((line) => line.id));
    generatedStations = [...new Set(Object.values(ferryFeed.terminals))].map((parentId) => {
      const parent = rows.find((row) => row.stopId === parentId);
      if (!parent) throw new Error(`[seed:${config.id}] Terminal stop ${parentId} is not in GTFS`);
      const platformIds = [
        parentId,
        ...rows.filter((row) => row.parentStation === parentId).map((row) => row.stopId),
      ].sort();
      const drawn = platformIds.map((id) => drawnByPlatform.get(id)).find(Boolean);
      const routes = [...new Set(platformIds.flatMap((id) => routesByStop.get(id) ?? []))].sort();
      return {
        id: drawn?.id ?? parentId,
        ...(drawn?.schematicId ? { schematicId: drawn.schematicId } : {}),
        name: drawn?.name ?? terminalDisplayName(parent.stopName),
        lat: parent.stopLat,
        lon: parent.stopLon,
        // Undrawn routes still depart here; only drawn lines can be station lines.
        lines: [
          ...new Set(
            routes.map((id) => provider.manifest.alertInterpretation?.routeLineMap?.[id] ?? id),
          ),
        ]
          .filter((id) => drawnLineIds.has(id))
          .sort(),
        platformIds,
        departureRouteIds: routes,
      };
    });
  }
  if (artifact.stations.length === 0) {
    throw new Error(
      `[seed:${config.id}:station-index] GTFS archives produced no schematic station identities`,
    );
  }
  const outputPath =
    options.schematicPath ??
    resolve(process.cwd(), "src/agencies", config.scopePath, "schematic.json");
  const source = readFileSync(outputPath, "utf8");
  const decodeSchematic = Schema.decodeUnknownSync(SchematicSchema);
  const current = decodeSchematic(JSON.parse(source));
  const stationIndex = mergeStationIndex(
    current.stationIndex ?? [],
    generatedStations,
    stationMembershipSequences(schematic),
  );
  for (const warning of formatStationIndexDriftWarnings(config.id, {
    sequences: stationMembershipSequences(schematic),
    // Report against the merged index: that is what riders actually get.
    stationIndex,
    aliasCandidates: artifact.aliasCandidates,
    unmatchedPlatforms: artifact.unmatchedPlatforms,
    popularRoutes: (provider.manifest.popularSurfaceRoutes ?? []).filter(
      (id) => !provider.staticTopology.vehicleOnlyRoutes?.some((route) => route.id === id),
    ),
    feedRouteIds,
    routeLineMap: provider.manifest.alertInterpretation?.routeLineMap ?? {},
  })) {
    console.warn(warning);
  }
  decodeSchematic({ ...current, stationIndex });
  const updated = replaceStationIndexInSchematic(source, stationIndex);
  if (updated !== source) {
    writeFileSync(outputPath, updated);
    normalizeSchematicFormatting(outputPath, config.id);
  }
  console.log(
    `[seed:${config.id}:station-index] Compiled ${stationIndex.length} station identities from ${rows.length} GTFS stops`,
  );
}

export async function runSeedCli() {
  const parsed = parseCliArgs(process.argv.slice(2));

  if (parsed.isHelp) {
    printHelp();
    return;
  }

  if (parsed.interchangesOnly) {
    // Interchanges-only mode seeds nothing, so every agency is read from the
    // database already on disk.
    compileStaticInterchanges(new Map(), [], []);
    return;
  }

  let agencies = parsed.agencies;
  let dbTarget = parsed.dbTarget ?? (parsed.databaseOnly ? "sqlite" : undefined);
  if (parsed.databaseOnly && agencies.length === 0 && !process.stdin.isTTY)
    throw new Error("Select at least one agency using --agency or --scope for database-only initialization.");
  const seedable = getAllAgencySeedConfigs();

  // Interactive Mini-TUI prompts if flags weren't specified and running in a TTY
  if ((agencies.length === 0 || !dbTarget) && process.stdin.isTTY) {
    console.log(`\n\x1B[1m✨ Schematic — GTFS Seeder Wizard\x1B[0m\n`);

    if (agencies.length === 0) {
      const selected = await promptMultiSelect("Select transit agencies to seed:", [
        ...buildAgencySelectOptions(seedable),
      ]);
      if (selected.length === 0) {
        console.error(
          "\n❌ No agencies selected — nothing to seed. Run the wizard again and pick at least one agency.\n",
        );
        process.exitCode = 1;
        return;
      }
      agencies = selected;
    }

    if (!dbTarget) {
      dbTarget = await promptSingleSelect<DbTarget>("Select database target:", [
        { id: "both", label: "Both Local (SQLite *.db and Miniflare D1)" },
        { id: "sqlite", label: "SQLite only (*.db files for Node/Bun)" },
        { id: "d1", label: "Local D1 only (Cloudflare Miniflare proxy)" },
        { id: "remote", label: "Remote Cloudflare D1 (wrangler execute)" },
      ]);
    }
  }

  // Fallbacks for non-TTY non-flag invocations
  if (agencies.length === 0) {
    agencies = seedable.map((c) => c.id);
  }
  if (!dbTarget) {
    dbTarget = "both";
  }

  const result = await runSeeder({
    agencies,
    dbTarget,
    zipArg: parsed.zipArg,
    databaseOnly: parsed.databaseOnly,
  });

  // Source-generation runs permit partial success; seeding no agencies always fails.
  if (result.seededAgencyIds.length === 0 && result.requestedAgencyIds.length > 0) {
    console.error(
      `\n\x1B[31m❌ GTFS Seeding failed:\x1B[0m no requested agency could be seeded — every GTFS feed was unavailable.\n`,
    );
    process.exitCode = 1;
  }
  if (parsed.databaseOnly && result.skippedAgencyIds.length > 0) process.exitCode = 1;
}

function formatScopeLabel(scope: string): string {
  const parts = scope.split("/");
  if (scope === "intl") return "International / Cross-Border";
  if (parts.length === 2 && parts[1] === "nat") return `${parts[0].toUpperCase()} — National`;
  if (parts.length === 2) return `${parts[0].toUpperCase()} — ${parts[1].toUpperCase()}`;
  return scope.toUpperCase();
}

/**
 * Builds the agency picker options: one "all" row with no agency list, then
 * one header per region with its member agencies indented beneath it.
 */
export function buildAgencySelectOptions(
  seedable: readonly AgencySeedConfig[],
): SelectOption<string>[] {
  const groups = new Map<string, AgencySeedConfig[]>();
  for (const config of seedable) {
    const group = config.scopePath.split("/").slice(0, -1).join("/") || config.scope;
    const members = groups.get(group) ?? [];
    members.push(config);
    groups.set(group, members);
  }
  return [
    { id: "all", label: "All agencies", checked: true },
    ...[...groups.entries()].flatMap(([group, configs]): SelectOption<string>[] => [
      {
        id: `group:${group}`,
        label: formatScopeLabel(group),
        isHeader: true,
        group,
      },
      ...configs.map((config): SelectOption<string> => ({
        id: config.id,
        label: config.name,
        checked: true,
        group,
        indent: 1,
      })),
    ]),
  ];
}

if (import.meta.main) {
  runSeedCli().catch((err) => {
    if (err instanceof PromptCancelledError) {
      // Exit from the write callback: stdout to a Windows TTY is asynchronous,
      // so process.exit() here would discard the erase sequence and leave the
      // frame (and a hidden cursor) on screen.
      process.stdout.write(`\n\x1B[2mCancelled.\x1B[0m\n`, () => process.exit(130));
      return;
    }
    const detail = err instanceof Error ? (err.stack ?? err.message) : String(err);
    process.stderr.write(`\n\x1B[31m❌ GTFS Seeding failed:\x1B[0m ${detail}\n`, () =>
      process.exit(1),
    );
  });
}
