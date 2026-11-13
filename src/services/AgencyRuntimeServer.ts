import "server-only";
import { getScheduledStopTimes } from "./ScheduleServer";
import type { AgencyProvider } from "~/agencies/types";
import { createAgencyRuntime, type AgencyRuntimeContext } from "./AgencyRuntime";
import { getFeedSecret } from "~/infrastructure/env/ServerEnv";
import { getDevRequestOrigin } from "./devRequestOrigin";
import { getAlertIdentityLookups } from "./AlertIdentityServer";

/** Owns server defaults for every capability, including snapshots requested by Nearby. */
export function createServerAgencyRuntime(
  provider: AgencyProvider,
  overrides: Partial<AgencyRuntimeContext> = {},
) {
  return createAgencyRuntime(provider, {
    fetch: (...args) => globalThis.fetch(...args),
    now: () => Date.now(),
    getSecret: getFeedSecret,
    devProxyOrigin: getDevRequestOrigin(),
    ...getAlertIdentityLookups(provider.manifest.id),
    getScheduledStopTimes: getScheduledStopTimes(
      provider.manifest.id,
      provider.manifest.timezone ?? "UTC",
      overrides.now ?? Date.now,
    ),
    ...overrides,
  });
}
