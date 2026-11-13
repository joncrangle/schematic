import * as Effect from "effect/Effect";
import { allProviders, type AgencyProvider } from "~/agencies";
import {
  resolveRuntimeBinding,
  TRANSIT_BINDING_NAME,
  type D1DatabaseBinding,
} from "~/infrastructure/storage/RuntimeBindings";
import { logger } from "~/infrastructure/logging/logger";
import { createServerAgencyRuntime } from "~/services/AgencyRuntimeServer";
import { assignTopologyWeekdays } from "~/domain/surface/topologySchedule";
import { createD1SeedSyncStore } from "~/infrastructure/storage/surfaceStore/seedSync";

export type TopologyRefreshOutcome =
  | "skipped"
  | "needs-seed"
  | "updated"
  | "unchanged"
  | "refreshed";
export type TopologyRefreshLog = Pick<typeof logger, "info" | "warn" | "error">;
export interface TopologyRefreshResult {
  failedAgencyIds: string[];
  refreshedAgencyIds: string[];
  skippedAgencyIds: string[];
  needsSeedAgencyIds: string[];
  updatedAgencyIds: string[];
  unchangedAgencyIds: string[];
}

/** Assign the complete seed registry before any destination-dependent eligibility checks. */
export async function runScheduledTopologyRefresh(input: {
  readonly scheduledTime: number;
  readonly providers: readonly AgencyProvider[];
  readonly refreshAgency: (provider: AgencyProvider) => Promise<TopologyRefreshOutcome | undefined>;
  readonly isCurrent?: () => boolean;
  readonly log?: TopologyRefreshLog;
}): Promise<TopologyRefreshResult> {
  if (
    !Number.isFinite(input.scheduledTime) ||
    !Number.isFinite(new Date(input.scheduledTime).getTime())
  )
    throw new Error("Invalid topology scheduled time");
  const providers = input.providers.filter(
    (provider) => provider.staticTopology.source === "seed" && provider.createTopologySource,
  );
  const schedule = assignTopologyWeekdays(providers.map((provider) => provider.manifest.id));
  const weekday = new Date(input.scheduledTime).getUTCDay();
  const log = input.log ?? logger;
  const result: TopologyRefreshResult = {
    failedAgencyIds: [],
    refreshedAgencyIds: [],
    skippedAgencyIds: [],
    needsSeedAgencyIds: [],
    updatedAgencyIds: [],
    unchangedAgencyIds: [],
  };
  for (const provider of providers) {
    if (input.isCurrent && !input.isCurrent()) break;
    const agencyId = provider.manifest.id;
    if (schedule.get(agencyId) !== weekday) continue;
    try {
      const outcome = await input.refreshAgency(provider);
      if (!outcome) break;
      if (outcome === "skipped") result.skippedAgencyIds.push(agencyId);
      else if (outcome === "needs-seed") {
        result.needsSeedAgencyIds.push(agencyId);
        log.warn("Surface topology needs-seed", {
          agencyId,
          command: `bun scripts/seed.ts --agency=${agencyId}`,
        });
      } else {
        result.refreshedAgencyIds.push(agencyId);
        if (outcome === "updated") result.updatedAgencyIds.push(agencyId);
        if (outcome === "unchanged") result.unchangedAgencyIds.push(agencyId);
      }
      log.info("SurfaceTopologyRefresh: agency completed", { agencyId, outcome });
    } catch (error) {
      result.failedAgencyIds.push(agencyId);
      // Vendor/transport messages may contain credentials. Never emit raw errors from this boundary.
      log.error(
        "SurfaceTopologyRefresh: agency refresh failed; retry at its next weekly opportunity",
        {
          agencyId,
          errorType: error instanceof Error ? error.name : "Error",
        },
      );
    }
  }
  return result;
}

export interface TopologyRefreshDependencies {
  readonly providers?: () => readonly AgencyProvider[];
  readonly resolveBinding?: () => Promise<D1DatabaseBinding>;
  readonly fetch?: typeof fetch;
}

/** Seed agencies only. NextBus crawling and alert evaluation retain their existing policies. */
export async function refreshScheduledTopologies(
  scheduledTime: number,
  dependencies: TopologyRefreshDependencies = {},
  isCurrent: () => boolean = () => true,
): Promise<TopologyRefreshResult> {
  return runScheduledTopologyRefresh({
    scheduledTime,
    providers: (dependencies.providers ?? allProviders)(),
    isCurrent,
    refreshAgency: async (provider) => {
      const agencyId = provider.manifest.id;
      const d1 = await (
        dependencies.resolveBinding ?? (() => resolveRuntimeBinding(TRANSIT_BINDING_NAME))
      )();
      if (!isCurrent()) return;
      if (!(await createD1SeedSyncStore(d1).hasTopology(agencyId))) return "needs-seed";
      if (!isCurrent()) return;
      const source = createServerAgencyRuntime(provider, {
        d1,
        fetch: dependencies.fetch ?? globalThis.fetch,
        now: () => scheduledTime,
      }).getTopologySource();
      if (!(await Effect.runPromise(source.shouldRefreshTopology()))) return "skipped";
      if (!isCurrent()) return;
      await Effect.runPromise(source.syncTopology());
      return "refreshed";
    },
  });
}
