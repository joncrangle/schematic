import { createFeedPollingFetch } from "~/infrastructure/realtime/feedPolling";
import {
  parseAgencyManifestConfig,
  normalizeStationServices,
  SchematicSchema,
  type AgencyProvider,
  type StationsSourceContext,
  type TopologySourceContext,
} from "./types";
import * as Schema from "effect/Schema";
import * as Effect from "effect/Effect";
import { manifestFallbackBounds } from "~/domain/location/EffectiveAgency";
import type { RealtimeSource } from "~/domain/surface/realtimeSource";
import type { StationsSource } from "~/domain/surface/stationsSource";
import type { TopologySource } from "~/domain/surface/topologySource";
import type { NearbyStationArrival } from "~/domain/surface/types";
import { inferRouteType } from "~/domain/surface/types";
import { deriveGtfsProjectionConfig } from "~/infrastructure/gtfs/config";
import { networkDocumentFeed } from "~/domain/realtimeFeedRouting";

export interface CreateAgencyProviderConfig {
  readonly manifest: unknown;
  readonly schematic?: unknown;
}

/**
 * Adapter modules are shared by the browser and server registry, but only
 * server-side ports need them. Keep feeds, D1, and alert parsing out of the
 * hydration-critical client graph until a port is actually exercised.
 */
function lazyEffect<T, E>(load: () => Promise<Effect.Effect<T, E>>): Effect.Effect<T, E> {
  return Effect.flatMap(Effect.promise(load), (effect) => effect) as Effect.Effect<T, E>;
}

export function createLazySource<T>(load: () => Promise<T>): () => Promise<T> {
  let sourcePromise: Promise<T> | undefined;
  return () => {
    if (!sourcePromise) {
      sourcePromise = load().catch((error: unknown) => {
        sourcePromise = undefined;
        throw error;
      });
    }
    return sourcePromise;
  };
}

/**
 * Instantiates an agency from its declarative files.
 *
 * This is intentionally the only place where manifest transport settings are
 * turned into provider functions. Registry entries therefore remain explicit
 * imports while an agency author only supplies JSON data.
 */
export function createAgencyProvider(config: CreateAgencyProviderConfig): AgencyProvider {
  const { manifest, staticTopology, realtime, alerts } = parseAgencyManifestConfig(config.manifest);
  const schematic =
    config.schematic === undefined
      ? undefined
      : Schema.decodeUnknownSync(SchematicSchema)(config.schematic);
  const realtimeFeeds = realtime?.feeds ?? [];
  const pollingFeeds = [
    ...realtimeFeeds.filter(
      (feed) =>
        feed.kind !== "samsara_boards" &&
        feed.kind !== "cityway" &&
        feed.kind !== "passio" &&
        feed.kind !== "hubup" &&
        feed.kind !== "transloc" &&
        feed.kind !== "bustime" &&
        feed.kind !== "tripspark" &&
        feed.kind !== "zenbus" &&
        feed.kind !== "tsimobile" &&
        feed.kind !== "train_map" &&
        feed.kind !== "station_timetables" &&
        feed.kind !== "swiftly" &&
        feed.kind !== "fleet_integrations",
    ),
    ...(alerts ?? []),
  ];
  const pollingFetch = (
    ctx: { readonly now?: () => number; readonly devProxyOrigin?: string },
    fetch: typeof globalThis.fetch,
    edgeCache?: Cache | null,
  ) =>
    createFeedPollingFetch(pollingFeeds, {
      fetch,
      now: ctx.now,
      devProxyOrigin: ctx.devProxyOrigin,
      edgeCache,
    });
  const stationServices = normalizeStationServices(manifest.stationService);
  // A closed circuit has no schematic terminus. Keep its station order for
  // the map, but do not use the first/last drawn station as boarding evidence.
  const circuitLineIds = new Set(
    schematic?.lines
      .filter(({ points }) => {
        const first = points[0];
        const last = points.at(-1);
        return points.length > 2 && first.x === last?.x && first.y === last.y;
      })
      .map((line) => line.id),
  );
  const terminusSequences = schematic?.sequences
    ? Object.fromEntries(
        Object.entries(schematic.sequences).filter(([lineId]) => !circuitLineIds.has(lineId)),
      )
    : undefined;
  const networkFeed = realtimeFeeds.map(networkDocumentFeed).find((feed) => feed !== undefined);
  if (
    networkFeed &&
    realtimeFeeds.filter((feed) => feed.kind !== "fleet_integrations").length !== 1
  ) {
    throw new Error(`Agency "${manifest.id}": a network document must be the sole realtime feed`);
  }

  return {
    manifest,
    staticTopology,
    realtime: { feeds: realtimeFeeds },
    alerts,
    schematic,
    snapshot: {
      get: async (ctx) => {
        const { fetchAgencyAlerts } = await import("~/infrastructure/realtime/fetchAgencyAlerts");
        return Effect.runPromise(
          fetchAgencyAlerts({
            agencyId: manifest.id,
            sources: alerts ?? [],
            fetch: pollingFetch(ctx, ctx.fetch, ctx.alertConditionalCache ?? null),
            now: ctx.now,
            locale: ctx.locale ?? manifest.locale,
            timeZone: manifest.timezone,
            manifest,
            stationIndex: schematic?.stationIndex,
            schematic,
            getSecret: ctx.getSecret,
            devProxyOrigin: ctx.devProxyOrigin,
            getRoutesForTrips: ctx.getRoutesForTrips,
            getSourceAgencyScope: ctx.getSourceAgencyScope,
            identityGeneration: ctx.identityGeneration,
            sourceAgencyIds: staticTopology.sourceAgencyIds,
            sourceTypes: ctx.alertSourceTypes,
            conditionalCache: ctx.alertConditionalCache,
            hostLimiter: ctx.alertHostLimiter,
            requestCache: ctx.requestCache,
          }),
        );
      },
    },
    ...(staticTopology.feeds && staticTopology.feeds.length > 0
      ? {
          createTopologySource: (ctx: TopologySourceContext): TopologySource => {
            const getSource = createLazySource(() =>
              import("~/infrastructure/storage/surfaceStore/topology").then(
                ({ createD1TopologySource }) =>
                  createD1TopologySource({
                    d1: ctx.d1 as Parameters<typeof createD1TopologySource>[0]["d1"],
                    agencyId: manifest.id,
                    fetch: ctx.fetch,
                    now: ctx.now,
                    source: staticTopology.source ?? "nextbus",
                    nextbusSlug: staticTopology.agencySlug,
                    routeInterpretation: manifest.routeInterpretation,
                    defaultRouteColor: staticTopology.defaultColor,
                    fallbackBounds: manifestFallbackBounds(manifest),
                    stationIndex: schematic?.stationIndex,
                    seedConfig: {
                      ...deriveGtfsProjectionConfig(manifest, staticTopology),
                      feeds: staticTopology.feeds ?? [],
                    },
                  }),
              ),
            );

            return {
              fetchTopology: () =>
                lazyEffect(() => getSource().then((source) => source.fetchTopology())),
              shouldRefreshTopology: () =>
                lazyEffect(() => getSource().then((source) => source.shouldRefreshTopology())),
              syncTopology: () =>
                lazyEffect(() => getSource().then((source) => source.syncTopology())),
            };
          },
        }
      : {}),
    createRealtimeSource: (ctx): RealtimeSource => {
      const getSource = createLazySource(() =>
        import("~/infrastructure/realtime/genericGtfsRealtimeSource").then(
          ({ createGenericGtfsRealtimeSource }) =>
            createGenericGtfsRealtimeSource({
              agencyId: manifest.id,
              vehicleOnlyRouteIds: new Set(
                staticTopology.vehicleOnlyRoutes?.map((route) => route.id),
              ),
              restrictToSeededTrips: staticTopology.sourceAgencyIds !== undefined,
              getRoutesForTrips: ctx.getRoutesForTrips,
              getScheduledStopTimes: ctx.getScheduledStopTimes,
              getSourceAgencyScope: ctx.getSourceAgencyScope,
              feeds: realtimeFeeds,
              fetch: pollingFetch(ctx, ctx.fetch),
              now: ctx.now,
              getSecret: ctx.getSecret,
              devProxyOrigin: ctx.devProxyOrigin,
              routeInterpretation: manifest.routeInterpretation,
              routeLineMap: manifest.alertInterpretation?.routeLineMap,
            }),
        ),
      );

      return {
        fetchRealtime: (topology, options) =>
          lazyEffect(() => getSource().then((source) => source.fetchRealtime(topology, options))),
      };
    },
    ...(stationServices.length > 0
      ? {
          createStationsSource: (ctx: StationsSourceContext): StationsSource => {
            const getSources = createLazySource(() =>
              import("~/infrastructure/realtime/genericStationsSource").then(
                ({ createGenericStationsSource }) =>
                  stationServices.map((service) =>
                    createGenericStationsSource({
                      agencyId: manifest.id,
                      restrictToSeededTrips: staticTopology.sourceAgencyIds !== undefined,
                      getRoutesForTrips: ctx.getRoutesForTrips,
                      getScheduledStopTimes: ctx.getScheduledStopTimes,
                      getSourceAgencyScope: ctx.getSourceAgencyScope,
                      getTripTerminals: ctx.getTripTerminals,
                      getDirectionsForTrips: ctx.getDirectionsForTrips,
                      staticRouteIdField: staticTopology.routeIdField,
                      stations: schematic?.stationIndex ?? [],
                      feeds: realtimeFeeds,
                      fetch: pollingFetch(ctx, ctx.fetch ?? globalThis.fetch),
                      now: ctx.now,
                      directionLiterals: manifest.directionLiterals,
                      routeType: service.routeType,
                      splitByLine: service.splitByLine,
                      lineMetadata: schematic?.lines,
                      lineSequences: terminusSequences,
                      getSecret: ctx.getSecret,
                      devProxyOrigin: ctx.devProxyOrigin,
                      routeInterpretation: manifest.routeInterpretation,
                      routeLineMap: manifest.alertInterpretation?.routeLineMap,
                      // Multi-mode agencies partition departures by mode so a
                      // rail panel never renders bus departures with rail
                      // labels (and vice versa). Single-service agencies keep
                      // the unfiltered behaviour they already had.
                      predictionFilter:
                        stationServices.length > 1
                          ? (routeId: string) =>
                              inferRouteType(routeId, manifest.routeInterpretation) ===
                              service.routeType
                          : undefined,
                    }),
                  ),
              ),
            );

            /**
             * Merges per-mode station cards by card id. Modes serve disjoint
             * departures, so groups concatenate and each keeps its own line id,
             * which is what lets the card mark the combined rows as a transfer.
             *
             * A card's route type and line name describe the card, not a row of
             * it, so a card that ends up holding two modes states neither. It
             * previously kept whichever contributor sorted first, which made a
             * bus departure render under a rail card's title: `StationArrivalCard`
             * reads `routeType === "rail"` to decide between "ION at Conestoga
             * Station" and the bare station name, so one mode's identity was
             * presented over the other mode's departures. Real agencies have
             * these stations, GRT's Conestoga and Fairway among them, where ION
             * and a bus route both call.
             *
             * Leaving both unset is the honest answer rather than picking a
             * loser. The card then reads as the station it is, and the per-group
             * line ids still distinguish the modes on the rows themselves.
             */
            const mergeCards = (
              results: readonly (readonly NearbyStationArrival[])[],
            ): readonly NearbyStationArrival[] => {
              const merged = new Map<string, NearbyStationArrival>();
              for (const cards of results) {
                for (const card of cards) {
                  const previous = merged.get(card.id);
                  if (!previous) {
                    merged.set(card.id, card);
                    continue;
                  }
                  const arrivals = [...previous.arrivals, ...card.arrivals].sort(
                    (a, b) => (a.times[0] ?? 0) - (b.times[0] ?? 0),
                  );
                  // Identity follows the modes that actually produced
                  // departures, not the modes that produced a card. Every
                  // declared service returns a card for every station it serves
                  // whether or not it has anything to say, so counting a silent
                  // contributor would strip the identity off a single-mode card
                  // that merely shares a station with another mode.
                  const bothProduced = previous.arrivals.length > 0 && card.arrivals.length > 0;
                  const mixed =
                    bothProduced &&
                    (previous.routeType ?? undefined) !== (card.routeType ?? undefined);
                  const contributor =
                    card.arrivals.length > 0 && previous.arrivals.length === 0 ? card : previous;
                  merged.set(card.id, {
                    ...previous,
                    lineIds: [...new Set([...previous.lineIds, ...card.lineIds])],
                    lineName: mixed ? undefined : (contributor.lineName ?? previous.lineName),
                    routeType: mixed ? undefined : (contributor.routeType ?? previous.routeType),
                    arrivals,
                    arrivalsStale:
                      previous.arrivalsStale === true || card.arrivalsStale === true
                        ? true
                        : undefined,
                  });
                }
              }
              return [...merged.values()];
            };

            return {
              fetchNearby: (query) =>
                lazyEffect(() =>
                  getSources().then((sources) =>
                    Effect.all(
                      sources
                        .filter((_, index) =>
                          ["rail", "subway"].includes(stationServices[index]!.routeType),
                        )
                        .map((source) => source.fetchNearby(query)),
                    ).pipe(Effect.map(mergeCards)),
                  ),
                ),
              fetchSaved: (query) =>
                lazyEffect(() =>
                  getSources().then((sources) =>
                    Effect.all(
                      sources
                        .filter((_, index) =>
                          ["rail", "subway"].includes(stationServices[index]!.routeType),
                        )
                        .map((source) => source.fetchSaved(query)),
                    ).pipe(Effect.map(mergeCards)),
                  ),
                ),
              fetchByIds: (query) =>
                lazyEffect(() =>
                  getSources().then((sources) =>
                    Effect.all(sources.map((source) => source.fetchByIds(query))).pipe(
                      Effect.map(mergeCards),
                    ),
                  ),
                ),
            };
          },
        }
      : {}),
  };
}
