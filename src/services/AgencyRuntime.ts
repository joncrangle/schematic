import type {
  TripTerminalLookup,
  TripDirectionLookup,
  TripRouteLookup,
} from "~/domain/surface/boarding";
import * as Data from "effect/Data";

import type { AgencyProvider, AgencySnapshot } from "~/agencies";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import type { StationsSource } from "~/domain/surface/stationsSource";
import type { TopologySource } from "~/domain/surface/topologySource";
import { normalizeLocale, resolveContentLocale, type UiLocale } from "~/domain/locale";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";

/** A capability was requested from a provider runtime but is not available. */
export class AgencyCapabilityError extends Data.TaggedError("AgencyCapabilityError")<{
  readonly agencyId: string;
  readonly capability: "snapshot" | "topology" | "realtime" | "stations";
  readonly message: string;
}> {}

export interface AgencyRuntimeContext {
  readonly getScheduledStopTimes?: import("~/domain/surface/scheduledStopTimes").ScheduledStopLookup;
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly identityGeneration?: string;
  readonly getTripTerminals?: TripTerminalLookup;
  readonly getDirectionsForTrips?: TripDirectionLookup;
  readonly alertConditionalCache?: Cache;
  readonly alertHostLimiter?: import("~/infrastructure/http/hostConcurrency").HostConcurrencyLimiter;
  readonly requestCache?: RequestScopedEffectCache;
  readonly alertSourceTypes?: readonly import("~/agencies/types").AlertSource["type"][];
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly locale?: UiLocale;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly d1?: unknown;
}

export interface AgencyRuntime {
  readonly provider: AgencyProvider;
  readonly manifest: AgencyProvider["manifest"];
  readonly hasSnapshot: boolean;
  readonly hasTopology: boolean;
  readonly hasRealtime: boolean;
  readonly hasStations: boolean;
  readonly getSnapshot: (
    locale?: UiLocale,
    requestCache?: RequestScopedEffectCache,
  ) => Promise<AgencySnapshot>;
  readonly getTopologySource: () => TopologySource;
  readonly getRealtimeSource: () => RealtimeSource;
  readonly getStationsSource: () => StationsSource;
}

export type AgencyCapability = AgencyCapabilityError["capability"];

export function hasAgencyCapability(
  provider: AgencyProvider,
  capability: AgencyCapability,
): boolean {
  switch (capability) {
    case "snapshot":
      return typeof provider.snapshot?.get === "function";
    case "topology":
      return typeof provider.createTopologySource === "function";
    case "realtime":
      return typeof provider.createRealtimeSource === "function";
    case "stations":
      return typeof provider.createStationsSource === "function";
  }
}

function missingCapability(
  provider: AgencyProvider,
  capability: AgencyCapabilityError["capability"],
  reason: string,
): AgencyCapabilityError {
  return new AgencyCapabilityError({
    agencyId: provider.manifest.id,
    capability,
    message: `Agency "${provider.manifest.id}" ${reason}`,
  });
}

/**
 * Composes one agency's capabilities and runtime dependencies.
 *
 * Construction is intentionally per-call and lazy: no provider source is
 * created until its capability is requested, and successful source instances
 * are reused only within this runtime's lifetime.
 */
export function createAgencyRuntime(
  provider: AgencyProvider,
  context: AgencyRuntimeContext,
): AgencyRuntime {
  let topology: TopologySource | undefined;
  let realtime: RealtimeSource | undefined;
  let stations: StationsSource | undefined;

  const getSnapshot = (
    requestedLocale?: UiLocale,
    requestCache?: RequestScopedEffectCache,
  ): Promise<AgencySnapshot> => {
    if (!hasAgencyCapability(provider, "snapshot")) {
      return Promise.reject(
        missingCapability(provider, "snapshot", "does not provide a snapshot capability"),
      );
    }
    const fallbackLocale = resolveContentLocale(context.locale, provider.manifest.locale);
    const locale = normalizeLocale(requestedLocale, fallbackLocale);
    return provider.snapshot!.get({
      getRoutesForTrips: context.getRoutesForTrips,
      getSourceAgencyScope: context.getSourceAgencyScope,
      identityGeneration: context.identityGeneration,
      fetch: context.fetch,
      now: context.now,
      locale,
      getSecret: context.getSecret,
      devProxyOrigin: context.devProxyOrigin,
      alertSourceTypes: context.alertSourceTypes,
      alertConditionalCache: context.alertConditionalCache,
      alertHostLimiter: context.alertHostLimiter,
      requestCache: requestCache ?? context.requestCache,
    });
  };

  const getTopologySource = (): TopologySource => {
    if (topology) return topology;
    if (!hasAgencyCapability(provider, "topology")) {
      throw missingCapability(provider, "topology", "does not provide a topology capability");
    }
    if (context.d1 === undefined) {
      throw missingCapability(provider, "topology", "has no injected D1 binding");
    }
    topology = provider.createTopologySource!({
      d1: context.d1,
      fetch: context.fetch,
      now: context.now,
      getSecret: context.getSecret,
      devProxyOrigin: context.devProxyOrigin,
    });
    return topology;
  };

  const getRealtimeSource = (): RealtimeSource => {
    if (realtime) return realtime;
    if (!hasAgencyCapability(provider, "realtime")) {
      throw missingCapability(provider, "realtime", "does not provide a realtime capability");
    }
    realtime = provider.createRealtimeSource!({
      getScheduledStopTimes: context.getScheduledStopTimes,
      getSourceAgencyScope: context.getSourceAgencyScope,
      getRoutesForTrips: context.getRoutesForTrips,
      fetch: context.fetch,
      now: context.now,
      getSecret: context.getSecret,
      devProxyOrigin: context.devProxyOrigin,
    });
    return realtime;
  };

  const getStationsSource = (): StationsSource => {
    if (stations) return stations;
    if (!hasAgencyCapability(provider, "stations")) {
      throw missingCapability(provider, "stations", "does not provide a stations capability");
    }
    stations = provider.createStationsSource!({
      getScheduledStopTimes: context.getScheduledStopTimes,
      getSourceAgencyScope: context.getSourceAgencyScope,
      getRoutesForTrips: context.getRoutesForTrips,
      getTripTerminals: context.getTripTerminals,
      getDirectionsForTrips: context.getDirectionsForTrips,
      locale: resolveContentLocale(context.locale, provider.manifest.locale),
      fetch: context.fetch,
      now: context.now,
      getSecret: context.getSecret,
      devProxyOrigin: context.devProxyOrigin,
    });
    return stations;
  };

  return {
    provider,
    manifest: provider.manifest,
    hasSnapshot: hasAgencyCapability(provider, "snapshot"),
    hasTopology: hasAgencyCapability(provider, "topology"),
    hasRealtime: hasAgencyCapability(provider, "realtime"),
    hasStations: hasAgencyCapability(provider, "stations"),
    getSnapshot,
    getTopologySource,
    getRealtimeSource,
    getStationsSource,
  };
}
