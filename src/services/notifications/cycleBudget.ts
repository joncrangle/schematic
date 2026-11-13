import type { AlertSource } from "~/agencies/types";
import type { HostingTarget } from "~/infrastructure/env/hostingTarget";
import { isAlertSourceActive } from "~/infrastructure/realtime/alertSourceActivity";
import { resolveMaxCrawlPages } from "~/infrastructure/realtime/ghdNewsServiceAdvisoriesParser";
import { TMIX_MAX_SUBREQUESTS } from "~/infrastructure/realtime/tmix/tmixRealtimeSource";

export type AlertSourceType = AlertSource["type"];

/** Fast-moving sources, re-evaluated every minute on the fast cadence. */
export const FAST_ALERT_SOURCE_TYPES: readonly AlertSourceType[] = [
  "gtfs-rt",
  "json",
  "anyride-messages",
  "zenbus-messages",
];

/**
 * Slow-moving boards, re-evaluated on the fifteen-minute cadence. Their
 * content changes on hours/days timescales, so minute polling spends
 * subrequests without new information.
 */
export const SLOW_ALERT_SOURCE_TYPES: readonly AlertSourceType[] = ["web", "rss"];

export type AlertCadence = "fast" | "slow";

/** Workers Free subrequest budget per invocation. */
export const CYCLE_SUBREQUEST_BUDGET = 50;

export interface AgencyAlertSourceInventory {
  readonly agencyId: string;
  readonly sources: readonly AlertSource[];
}

/**
 * Workers polling cost includes Cache API calls, which share the fetch quota.
 * A selected page performs one lookup, one fetch and one write. Unselected
 * sources may also fetch on a cold/expired local cache. This estimates cold
 * work before the shared invocation counter limits actual work to 49.
 * The agency is skipped when it has no source on this cadence.
 */
export function coldPollingSubrequestsForSources(
  activeSources: readonly AlertSource[],
  cadence: AlertCadence,
): number {
  const selected = cadence === "fast" ? FAST_ALERT_SOURCE_TYPES : SLOW_ALERT_SOURCE_TYPES;
  if (!activeSources.some((source) => selected.includes(source.type))) return 0;
  return activeSources.reduce((total, source) => {
    // An AnyRide message read polls every declared stop with one POST each; a
    // POST has no conditional-cache lookup or write around it.
    if (source.type === "anyride-messages" && source.relay === undefined) {
      return total + Math.min(source.stops?.length ?? 1, TMIX_MAX_SUBREQUESTS);
    }
    const pages =
      source.type === "web"
        ? resolveMaxCrawlPages("cloudflare", source.cloudflareMaxCrawlPages)
        : 1;
    return total + pages * 3;
  }, 0);
}

/**
 * Uncapped cold polling estimate using Workers page/attempt limits, summed
 * over agencies selected on the cadence. Redirects and dispatch are excluded. Sources gated out by
 * `runtimes` or an unprovisioned base URL are inactive and cost nothing;
 * pass a provisioning getSecret to estimate a provisioned registry.
 */
export function coldPollingSubrequestsForCycle(
  agencies: readonly AgencyAlertSourceInventory[],
  cadence: AlertCadence,
  target: HostingTarget,
  getSecret?: (name: string) => string | undefined,
): number {
  return agencies.reduce((total, agency) => {
    const active = agency.sources.filter((source) =>
      isAlertSourceActive(source, target, getSecret),
    );
    return total + coldPollingSubrequestsForSources(active, cadence);
  }, 0);
}
