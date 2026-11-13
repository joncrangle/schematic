import "server-only";
import {
  resolveRuntimeBinding,
  TRANSIT_BINDING_NAME,
} from "~/infrastructure/storage/RuntimeBindings";
import { lazyAgencySurfaceStore } from "~/services/surface/agencyStore";
import { makeD1SurfaceDataStoreService } from "~/infrastructure/storage/d1SurfaceDataStore";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { NearbyStationArrival } from "~/domain/surface/types";
import type { NearbyRpcInput } from "~/services/nearby/rpcInput";
import type { StationsSource as StationsSourceApi } from "~/domain/surface/stationsSource";
import { StationsError } from "~/domain/surface/stationsSource";
import { getActiveAgency, getAgencyById } from "~/agencies";
import { resolveContentLocale, type UiLocale } from "~/domain/locale";
import { memoizedLayerContext } from "~/services/memoizedLayerContext";
import { runRpc } from "~/services/runRpc";
import { getFeedSecret } from "~/infrastructure/env/ServerEnv";
import { getDevRequestOrigin } from "~/services/devRequestOrigin";
import { createServerAgencyRuntime } from "~/services/AgencyRuntimeServer";
import { getAlertIdentityLookups } from "~/services/AlertIdentityServer";
import { selectStationTripLookups } from "~/services/stationTripLookups";
import type { ParsedSavedStationsInput } from "./StationsClient";
import type { StationDeparturesQuery } from "~/domain/surface/stationsSource";
import {
  fetchFeedStationDepartures,
  type FeedStationDeparturesInput,
} from "./FeedStationDepartures";

// ---------------------------------------------------------------------------
// Server-only stations RPC implementations.
//
// Core stations RPC layer: the agency-scoped generalization of the
// retired TTC SubwayClient. Per-agency singleton contexts come from
// the shared keyed memoizer. This module is server-only (feed secrets via
// ServerEnv); the shared StationsClient module keeps only validators, types,
// and the wrapper stubs whose bodies call in here.
//
// Delegates never catch on behalf of the client. A downstream StationsError
// rejects so TanStack Query surfaces real errors.
// The context getter is injectable purely for unit tests (keyed by the
// request's agencyId); production callers use the default per-agency caches.
// ---------------------------------------------------------------------------

/**
 * Effect service wrapper over a provider's plain {@link StationsSourceApi}
 * port, so handler delegates ride the shared runRpc ceremony.
 */
export class StationsSource extends Context.Service<StationsSource, StationsSourceApi>()(
  "StationsSource",
) {}

// Keep the platform fetch receiver intact. Cloudflare's fetch implementation
// can reject a detached invocation, while the feed kernel calls its injected
// fetch function as a plain callable.
const workerFetch = ((...args: Parameters<typeof fetch>) =>
  globalThis.fetch(...args)) as typeof fetch;

/**
 * Resolves the agency's stations adapter into a layer. Unknown ids degrade to
 * the default active provider (mirrors resolveAgencySelection's pin rule);
 * a known provider without the port yields an honestly-failing service —
 * never a silent empty panel.
 */
export function buildStationsSourceLayer(
  agencyId: string,
  locale?: UiLocale,
): Layer.Layer<StationsSource> {
  const provider = getAgencyById(agencyId) ?? getActiveAgency();
  const id = provider.manifest.id;
  const getStore = lazyAgencySurfaceStore(id, provider.schematic?.stationIndex);
  const runtime = createServerAgencyRuntime(provider, {
    ...selectStationTripLookups(id, getAlertIdentityLookups(id), getStore),
    fetch: workerFetch,
    locale: resolveContentLocale(locale, provider.manifest.locale),
  });

  return Layer.succeed(
    StationsSource,
    runtime.hasStations ? runtime.getStationsSource() : missingStationsSource(id),
  );
}

/** Per-agency and per-locale singleton {@link StationsSource} context. */
const stationsContextGetters = new Map<
  string,
  (agencyId: string) => Promise<Context.Context<StationsSource>>
>();
export function getStationsSourceContext(
  agencyId: string,
  requestedLocale?: UiLocale,
): Promise<Context.Context<StationsSource>> {
  const provider = getAgencyById(agencyId) ?? getActiveAgency();
  const locale = resolveContentLocale(requestedLocale, provider.manifest.locale);
  // Unknown ids degrade to the active provider, so key by the resolved id:
  // arbitrary request ids must not each retain a separate runtime.
  const key = `${provider.manifest.id}\u0000${locale}`;
  let getContext = stationsContextGetters.get(key);
  if (!getContext) {
    getContext = memoizedLayerContext((id) => buildStationsSourceLayer(id, locale));
    stationsContextGetters.set(key, getContext);
  }
  return getContext(provider.manifest.id);
}

/**
 * Failing port stub for known providers without createStationsSource:
 * an honest rejection, never a silent empty panel.
 */
function missingStationsSource(id: string): StationsSourceApi {
  const error: StationsError = new StationsError({
    agencyId: id,
    message: `Agency "${id}" does not provide a stations source`,
  });
  return {
    fetchNearby: () => Effect.fail(error),
    fetchSaved: () => Effect.fail(error),
    fetchByIds: () => Effect.fail(error),
  };
}

export async function handleFetchNearbyStations(
  data: NearbyRpcInput,
  getContext: (
    agencyId: string,
    locale?: UiLocale,
  ) => Promise<Context.Context<StationsSource>> = getStationsSourceContext,
): Promise<readonly NearbyStationArrival[]> {
  return runRpc(
    { label: "fetchNearbyStations", getContext: () => getContext(data.agencyId, data.locale) },
    () =>
      Effect.gen(function* () {
        const source = yield* StationsSource;
        return yield* source.fetchNearby({
          lat: data.lat,
          lon: data.lon,
          radiusMeters: data.radius,
        });
      }),
  );
}

/**
 * Handler delegate beneath fetchSavedStations. Empty favourites short-circuit
 * before any agency context is touched (legitimate empty, not an error).
 */
export async function handleFetchSavedStations(
  data: ParsedSavedStationsInput,
  getContext: (
    agencyId: string,
    locale?: UiLocale,
  ) => Promise<Context.Context<StationsSource>> = getStationsSourceContext,
): Promise<readonly NearbyStationArrival[]> {
  if (data.stationNames.length === 0) return [] as NearbyStationArrival[];

  return runRpc(
    { label: "fetchSavedStations", getContext: () => getContext(data.agencyId, data.locale) },
    () =>
      Effect.gen(function* () {
        const source = yield* StationsSource;
        return yield* source.fetchSaved({
          stationNames: data.stationNames,
          lat: data.lat,
          lon: data.lon,
        });
      }),
  );
}

/** Handler delegate beneath GET /api/departures/:agencyId/:stationId. */
export async function handleFetchStationDepartures(
  data: StationDeparturesQuery & { readonly agencyId: string; readonly locale?: UiLocale },
  getContext: (
    agencyId: string,
    locale?: UiLocale,
  ) => Promise<Context.Context<StationsSource>> = getStationsSourceContext,
): Promise<readonly NearbyStationArrival[]> {
  return runRpc(
    { label: "fetchStationDepartures", getContext: () => getContext(data.agencyId, data.locale) },
    () =>
      Effect.gen(function* () {
        const source = yield* StationsSource;
        return yield* source.fetchByIds({
          stationIds: [...data.stationIds],
          lat: data.lat,
          lon: data.lon,
        });
      }),
  );
}

/** Departure-only interchange stops use the agency-scoped seeded topology. */
export async function handleFetchFeedStationDepartures(
  input: FeedStationDeparturesInput,
): Promise<readonly NearbyStationArrival[]> {
  const provider = getAgencyById(input.agencyId);
  if (!provider) throw new Error(`Unknown agency "${input.agencyId}"`);
  const db = await resolveRuntimeBinding(TRANSIT_BINDING_NAME);
  return Effect.runPromise(
    fetchFeedStationDepartures(input, {
      provider,
      store: makeD1SurfaceDataStoreService(db, {
        agencyId: input.agencyId,
        routeInterpretation: provider.manifest.routeInterpretation,
      }),
      identities: getAlertIdentityLookups(input.agencyId),
      fetch: workerFetch,
      now: () => Date.now(),
      getSecret: getFeedSecret,
      devProxyOrigin: getDevRequestOrigin(),
    }),
  );
}
