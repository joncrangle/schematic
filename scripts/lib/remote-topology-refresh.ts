import { allProviders, type AgencyProvider } from "~/agencies";
import { TRANSIT_BINDING_NAME } from "~/infrastructure/storage/RuntimeBindings";
import { SURFACE_SCHEMA_STATEMENTS } from "~/infrastructure/storage/surfaceStore/schema";
import {
  shouldRefreshSeedTopology,
  syncSeedTopology,
} from "~/infrastructure/storage/surfaceStore/seedSync";
import {
  runScheduledTopologyRefresh,
  type TopologyRefreshLog,
} from "~/services/surface/SurfaceTopologyRefresh";
import { logger } from "~/infrastructure/logging/logger";
import { readGtfsArchiveResponse } from "~/infrastructure/gtfs/archive";
import { deriveAgencySeedConfig } from "./gtfs-seeder-core";
import { createRemoteSeedSyncStore, type RemoteSeedCommandRunner } from "./remote-seed-store";

export interface RemoteTopologyRefreshOptions {
  readonly configPath: string;
  readonly scheduledTime?: number;
  readonly now?: () => number;
  readonly providers?: () => readonly AgencyProvider[];
  readonly fetch?: typeof fetch;
  readonly fetchArchive?: (url: string, signal: AbortSignal) => Promise<Uint8Array>;
  readonly commandRunner?: RemoteSeedCommandRunner;
  readonly log?: TopologyRefreshLog;
}

/** Bun runner refreshes existing remote topology directly; no SQLite or generated artifact path. */
export async function refreshRemoteScheduledTopologies(options: RemoteTopologyRefreshOptions) {
  if (!options.configPath.trim())
    throw new Error("Topology refresh requires an explicit Wrangler config");
  const scheduledTime = options.scheduledTime ?? (options.now ?? Date.now)();
  const log = options.log ?? logger;
  const fetchArchive =
    options.fetchArchive ??
    (async (url: string, signal: AbortSignal) => {
      const response = await (options.fetch ?? globalThis.fetch)(url, { signal, headers: { Accept: "application/zip" } });
      if (!response.ok) throw new Error(`GTFS download failed: HTTP ${response.status}`);
      return readGtfsArchiveResponse(response);
    });
  return runScheduledTopologyRefresh({
    scheduledTime,
    providers: (options.providers ?? allProviders)(),
    log,
    refreshAgency: async (provider) => {
      // Each agency owns its read cache, so a rejected schema query cannot poison later agencies.
      const store = createRemoteSeedSyncStore({
        bindingName: TRANSIT_BINDING_NAME,
        schema: SURFACE_SCHEMA_STATEMENTS,
        configPath: options.configPath,
        commandRunner: options.commandRunner,
      });
      const config = deriveAgencySeedConfig(provider);
      if (!(await shouldRefreshSeedTopology(store, config.id, scheduledTime))) return "skipped";
      const result = await syncSeedTopology({
        config,
        store,
        now: () => scheduledTime,
        archives: async () => {
          if (!config.feeds.length) throw new Error("Seed agency has no static GTFS feeds");
          const archives: Uint8Array[] = [];
          for (const feed of config.feeds)
            archives.push(await fetchArchive(feed.url, AbortSignal.timeout(60_000)));
          return archives;
        },
      });
      log.info("Remote seed topology refresh completed", {
        agencyId: config.id,
        outcome: result.outcome,
        writes: result.writes,
      });
      if (result.movedStops?.length)
        log.warn(
          "Stops moved; manually regenerate stationIndex and regional interchanges, review and commit generated artifacts",
          {
            agencyId: config.id,
            movedStops: result.movedStops,
            commands: [
              `bun scripts/seed.ts --agency=${config.id} --db=sqlite`,
              "bun scripts/seed.ts --interchange-only",
            ],
          },
        );
      return result.outcome;
    },
  });
}
