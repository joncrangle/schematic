import { createSamsaraRealtimeSource } from "./samsara/samsaraBoards";
import { createCitywayRealtimeSource } from "./cityway/citywaySource";
import { createPassioRealtimeSource } from "./passio/passioSource";
import { createHubupRealtimeSource } from "./hubup/hubupSource";
import { createZenbusRealtimeSource } from "./zenbus/zenbusSource";
import { createTripSparkRealtimeSource } from "./tripspark/tripsparkSource";
import { createBusTimeRealtimeSource } from "./bustime/bustimeSource";
import { createMappedDeparturesSource } from "./mappedStationDepartures";
import { createTranslocRealtimeSource } from "./transloc/translocSource";
import { createFleetIntegrationsSource } from "./fleetIntegrations/fleetIntegrationsSource";
import { createSwiftlyRealtimeSource } from "./swiftly/swiftlySource";
import { feedMatchesScope } from "./feedScope";
import { prepareScheduledPredictions } from "./scheduledPredictions";
import { selectSeededTrips } from "./seededTripScope";
import type { TripRouteLookup } from "~/domain/surface/boarding";
import { resolveTripRoutes } from "./gtfsTripDescriptor";
import * as Effect from "effect/Effect";
import { decodeGtfsRealtimeFeed } from "./gtfsRealtimeDecoder";
import { cancelledTripsSources, dropCancelledTrips, fetchCancelledTripIds } from "./cancelledTrips";
import { redactFeedUrl } from "./feedAuth";
import { fetchDecodedFeeds, TransportFailure } from "./fetchDecodedFeeds";
import {
  RealtimeError,
  type RealtimeFetchOptions,
  type RealtimeSnapshot,
  type RealtimeSource,
} from "~/domain/surface/realtimeSource";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { RouteInterpretationConfig } from "~/agencies";
import { canonicalRouteId, routeIdsMatch, translateRawRouteId } from "~/domain/surface/routeIds";
import { fetchNextBusRealtime } from "./nextBusRealtimeSource";
import { fetchTmixRealtime, inferTmixCallDirection } from "./tmix/tmixRealtimeSource";
import { inferDirectionFromBearing } from "~/domain/surface/types";
import { createTsimobileRealtimeSource } from "./tsimobile/tsimobileSource";
import { createTrainMapRealtimeSource } from "./trainMap/trainMapSource";
import { createStationTimetablesRealtimeSource } from "./stationTimetables/stationTimetablesSource";
import { createFerrySailingRealtimeSource } from "./ferrySailings/ferrySailingSource";
import { resolveNetworkDocumentFeed } from "~/domain/realtimeFeedRouting";
import { logger } from "~/infrastructure/logging/logger";

export interface GenericGtfsRealtimeSourceOptions {
  readonly vehicleOnlyRouteIds?: ReadonlySet<string>;
  readonly getScheduledStopTimes?: import("~/domain/surface/scheduledStopTimes").ScheduledStopLookup;
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly restrictToSeededTrips?: boolean;
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly agencyId: string;
  readonly feeds: readonly RealtimeFeedConfig[];
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
  readonly routeInterpretation?: RouteInterpretationConfig;
  /**
   * Manifest-driven raw-to-canonical route translation (same semantics as
   * `alertInterpretation.routeLineMap`): raw GTFS-RT branch IDs map to stable
   * agency-local canonical route IDs. Providers without a mapping keep
   * exact/default matching.
   */
  readonly routeLineMap?: Readonly<Record<string, string>>;
}

type GenericGtfsFeed = Extract<RealtimeFeedConfig, { kind: "vehicle_positions" | "trip_updates" }>;

function findFeeds<K extends RealtimeFeedConfig["kind"]>(
  feeds: readonly RealtimeFeedConfig[],
  kind: K,
): Extract<RealtimeFeedConfig, { kind: K }>[] {
  return feeds.filter(
    (feed): feed is Extract<RealtimeFeedConfig, { kind: K }> => feed.kind === kind,
  );
}

/**
 * Expands a canonical route allowlist to include raw IDs that map to it, so
 * the wire decoder's pre-materialization filter keeps mapped entities.
 * Comparison reuses `routeIdsMatch` to stay consistent with decode filtering.
 */
function expandRouteFilter(
  requested: ReadonlySet<string> | undefined,
  routeLineMap: Readonly<Record<string, string>> | undefined,
): ReadonlySet<string> | undefined {
  if (!requested || requested.size === 0 || !routeLineMap) return requested;
  const expanded = new Set(requested);
  for (const [raw, canonical] of Object.entries(routeLineMap)) {
    for (const wanted of requested) {
      if (routeIdsMatch(canonical, wanted)) {
        expanded.add(raw);
        break;
      }
    }
  }
  return expanded;
}

function normalizeRealtimeRouteId(
  routeId: string,
  routes: StaticSnapshot["routes"],
  routeLineMap: Readonly<Record<string, string>> | undefined,
): string {
  const translated = translateRawRouteId(routeId, routeLineMap);
  return canonicalRouteId(translated, routes) ?? translated;
}

export function createGenericGtfsRealtimeSource(
  opts: GenericGtfsRealtimeSourceOptions,
): RealtimeSource {
  const fleets = opts.feeds.filter((feed) => feed.kind === "fleet_integrations");
  if (fleets.length) {
    const baseFeeds = opts.feeds.filter((feed) => feed.kind !== "fleet_integrations");
    const base = baseFeeds.length
      ? createGenericGtfsRealtimeSource({ ...opts, feeds: baseFeeds })
      : undefined;
    const fleetSources = fleets.map((feed) => ({
      feed,
      source: createFleetIntegrationsSource({ ...opts, feed }),
    }));
    return {
      fetchRealtime: (topology, filter) =>
        Effect.gen(function* () {
          const requested = topology.routes.filter(
            (route) => !filter?.routeIds?.size || filter.routeIds.has(route.routeId),
          );
          const activeFleets = fleetSources.filter(({ feed }) =>
            requested.some((route) => feed.routeIds.includes(route.routeId)),
          );
          const baseRoutes = requested.filter(
            (route) => !opts.vehicleOnlyRouteIds?.has(route.routeId),
          );
          const budget = Math.max(0, Math.floor(filter?.maxSubrequests ?? 40));
          const selectedFleets = activeFleets.slice(0, budget);
          const calls = selectedFleets.map(({ source }) =>
            source.fetchRealtime(topology, { ...filter, maxSubrequests: 1 }),
          );
          if (base && baseRoutes.length && budget > selectedFleets.length)
            calls.push(
              base.fetchRealtime(
                { ...topology, routes: baseRoutes },
                {
                  ...filter,
                  routeIds: new Set(baseRoutes.map((route) => route.routeId)),
                  maxSubrequests: budget - selectedFleets.length,
                },
              ),
            );
          if (!calls.length)
            return {
              agencyId: opts.agencyId,
              updatedAt: (opts.now ?? Date.now)(),
              vehicles: [],
              arrivals: [],
              partial: requested.length > 0,
            };
          const exits = yield* Effect.all(
            calls.map((call) => Effect.exit(call)),
            { concurrency: "unbounded" },
          );
          const successful = exits.flatMap((exit) => (exit._tag === "Success" ? [exit.value] : []));
          if (!successful.length)
            return yield* Effect.fail(
              new RealtimeError({
                agencyId: opts.agencyId,
                message: "All realtime sources unavailable",
              }),
            );
          return {
            agencyId: opts.agencyId,
            updatedAt: Math.min(...successful.map((result) => result.updatedAt)),
            vehicles: successful.flatMap((result) => result.vehicles),
            arrivals: successful.flatMap((result) => result.arrivals),
            partial:
              exits.some((exit) => exit._tag === "Failure") ||
              successful.some((result) => result.partial) ||
              selectedFleets.length < activeFleets.length ||
              (baseRoutes.length > 0 && base !== undefined && budget <= selectedFleets.length),
          };
        }),
    };
  }
  const networkFeed = resolveNetworkDocumentFeed(opts.feeds);
  if (networkFeed?.kind === "samsara_boards")
    return createSamsaraRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "cityway")
    return createCitywayRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "passio")
    return createPassioRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "hubup")
    return createHubupRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "tripspark")
    return createTripSparkRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "bustime")
    return createBusTimeRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "transloc")
    return createTranslocRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "zenbus")
    return createZenbusRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "tsimobile")
    return createTsimobileRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "train_map")
    return createTrainMapRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "station_timetables")
    return createStationTimetablesRealtimeSource({ ...opts, feed: networkFeed });
  if (networkFeed?.kind === "ferry_sailing_boards")
    return createFerrySailingRealtimeSource({ ...opts, feed: networkFeed });
  const swiftly = opts.feeds.find((feed) => feed.kind === "swiftly");
  if (swiftly) return createSwiftlyRealtimeSource({ ...opts, feed: swiftly });
  const mappedFeeds = opts.feeds.filter(
    (feed): feed is Extract<RealtimeFeedConfig, { kind: "station_departures" }> =>
      feed.kind === "station_departures" &&
      feed.responseMapping !== undefined &&
      feed.method !== "POST",
  );
  if (mappedFeeds.length && mappedFeeds.length === opts.feeds.length)
    return createMappedDeparturesSource(opts, mappedFeeds);
  const agencyId = opts.agencyId;
  const now = opts.now ?? (() => Date.now());

  const vehicleFeeds = findFeeds(opts.feeds, "vehicle_positions");
  const tripFeeds = findFeeds(opts.feeds, "trip_updates");
  const nextBusFeeds = findFeeds(opts.feeds, "nextbus");
  const tmixFeeds = findFeeds(opts.feeds, "tmix_anyride");

  const mapError =
    (feed: RealtimeFeedConfig, label: string) =>
    (cause: unknown): RealtimeError => {
      if (cause instanceof TransportFailure && (cause.status === 401 || cause.status === 403)) {
        console.warn(
          `[${agencyId.toUpperCase()} Realtime] GTFS-RT feed rejected with HTTP ${cause.status} for ${redactFeedUrl(feed.url)}.\n` +
            `Reason: this feed requires credentials that were not accepted. Check the agency manifest auth settings and configured secret.`,
        );
      }
      const message =
        cause instanceof TransportFailure
          ? cause.message
          : cause instanceof Error
            ? `GTFS-RT ${label} decode failed: ${cause.message}`
            : String(cause);
      return new RealtimeError({ agencyId, message, cause });
    };

  const decodeFeed = (feed: GenericGtfsFeed, label: string, options?: RealtimeFetchOptions) => ({
    url: feed.url,
    auth: feed.auth,
    devProxyPrefix: feed.devProxyPrefix,
    format: feed.format,
    accept: feed.accept,
    decode: (bytes: Uint8Array) =>
      resolveTripRoutes(
        bytes,
        opts.getRoutesForTrips,
        opts.restrictToSeededTrips ? "static" : feed.tripDirectionSource,
        feed.idNamespace,
      ).pipe(
        Effect.flatMap((tripRoutes) =>
          prepareScheduledPredictions(bytes, {
            ...feed,
            tripRoutes,
            getScheduledStopTimes: opts.getScheduledStopTimes,
            getSourceAgencyScope: opts.getSourceAgencyScope,
            stopIds: options?.stopIds,
            routeIds: expandRouteFilter(options?.routeIds, opts.routeLineMap),
          }).pipe(
            Effect.flatMap((predictionOptions) =>
              decodeGtfsRealtimeFeed(bytes, {
                ...predictionOptions,
                tripRoutes,
                idNamespace: feed.idNamespace,
                routeInterpretation: opts.routeInterpretation,
                unreliableVehicleFields: feed.unreliableVehicleFields,
                duplicateVehicleFixes: feed.duplicateVehicleFixes,
                routeIds: expandRouteFilter(options?.routeIds, opts.routeLineMap),
                stopIds: options?.stopIds,
              }).pipe(
                Effect.flatMap((decoded) =>
                  Effect.try(() =>
                    opts.restrictToSeededTrips
                      ? {
                          ...decoded,
                          vehiclePositions: selectSeededTrips(decoded.vehiclePositions, tripRoutes),
                          tripUpdates: selectSeededTrips(decoded.tripUpdates, tripRoutes),
                        }
                      : decoded,
                  ),
                ),
              ),
            ),
          ),
        ),
        Effect.tap((decoded) =>
          Effect.sync(() => {
            if (decoded.droppedEntities !== undefined) {
              logger.warn(`${agencyId} ${label} feed skipped malformed entities`, {
                source: redactFeedUrl(feed.url),
                droppedEntities: decoded.droppedEntities,
              });
            }
          }),
        ),
      ),
    mapError: mapError(feed, label),
  });

  const kernelOptions = {
    fetch: opts.fetch,
    getSecret: opts.getSecret,
    devProxyOrigin: opts.devProxyOrigin,
  };

  return {
    fetchRealtime: (topology: StaticSnapshot, options) =>
      Effect.gen(function* () {
        if (
          (vehicleFeeds.length === 0 || tripFeeds.length === 0) &&
          nextBusFeeds.length === 0 &&
          tmixFeeds.length === 0
        ) {
          return yield* Effect.fail(
            new RealtimeError({
              agencyId,
              message: `Missing GTFS-RT feed configs for ${agencyId}`,
            }),
          );
        }

        const [
          { usable: vehicleFeedsDecoded, firstError: vehicleError },
          { usable: tripFeedsDecoded, firstError: tripError },
          cancelledTripIds,
        ] = yield* Effect.all(
          [
            fetchDecodedFeeds(
              vehicleFeeds
                .filter((feed) =>
                  feedMatchesScope(feed, {
                    ...options,
                    routeIds: expandRouteFilter(options?.routeIds, opts.routeLineMap),
                  }),
                )
                .map((feed) => decodeFeed(feed, "vehicle", options)),
              kernelOptions,
            ),
            fetchDecodedFeeds(
              tripFeeds
                .filter(
                  (feed) =>
                    !options?.vehiclesOnly &&
                    feedMatchesScope(feed, {
                      ...options,
                      routeIds: expandRouteFilter(options?.routeIds, opts.routeLineMap),
                    }),
                )
                .map((feed) => decodeFeed(feed, "trip", options)),
              kernelOptions,
            ),
            // Read alongside the trip feed, so cancellations add no round trip.
            fetchCancelledTripIds(
              options?.vehiclesOnly ? [] : cancelledTripsSources(tripFeeds),
              kernelOptions,
              now,
            ),
          ],
          { concurrency: 3 },
        );

        const needsVehicles =
          options === undefined || options.stopIds === undefined || options.stopIds.size === 0;
        const needsArrivals = options === undefined || (options.stopIds?.size ?? 0) > 0;
        const needsNextBusVehicles = needsVehicles && vehicleFeedsDecoded.length === 0;
        const needsNextBusArrivals = needsArrivals && tripFeedsDecoded.length === 0;

        // Tmix supplies both products from one per-stop query, so it is only
        // consulted for whatever the GTFS-RT feeds did not already satisfy.
        const needsTmixVehicles = needsVehicles && vehicleFeedsDecoded.length === 0;
        const needsTmixArrivals = needsArrivals && tripFeedsDecoded.length === 0;
        const needsTmix = tmixFeeds.length > 0 && (needsTmixVehicles || needsTmixArrivals);

        const nextBusExit =
          nextBusFeeds.length > 0 && (needsNextBusVehicles || needsNextBusArrivals)
            ? yield* Effect.exit(
                fetchNextBusRealtime({
                  agencyId,
                  feeds: nextBusFeeds,
                  fetch: opts.fetch,
                  now,
                  getSecret: opts.getSecret,
                  devProxyOrigin: opts.devProxyOrigin,
                  routeInterpretation: opts.routeInterpretation,
                  topology,
                  fetchOptions: options,
                  includeArrivals: needsNextBusArrivals,
                  includeVehicles: needsNextBusVehicles,
                }),
              )
            : undefined;

        const tmixExit = needsTmix
          ? yield* Effect.exit(
              fetchTmixRealtime({
                agencyId,
                feeds: tmixFeeds,
                fetch: opts.fetch,
                devProxyOrigin: opts.devProxyOrigin,
                getSecret: opts.getSecret,
                topology,
                fetchOptions: {
                  ...options,
                  routeIds: expandRouteFilter(options?.routeIds, opts.routeLineMap),
                },
                includeArrivals: needsTmixArrivals,
                includeVehicles: needsTmixVehicles,
                project: (call, stopId) =>
                  inferTmixCallDirection(
                    {
                      ...call,
                      line: normalizeRealtimeRouteId(call.line, topology.routes, opts.routeLineMap),
                    },
                    { topology, stopId },
                  ),
                projectVehicle: (call, position) =>
                  inferDirectionFromBearing(
                    normalizeRealtimeRouteId(call.line, topology.routes, opts.routeLineMap),
                    position.bearing,
                    opts.routeInterpretation,
                  ),
              }),
            )
          : undefined;

        const nextBusSnapshot = nextBusExit?._tag === "Success" ? nextBusExit.value : undefined;
        const nextBusFailure =
          nextBusExit?._tag === "Failure"
            ? new RealtimeError({
                agencyId,
                message: `NextBus realtime failed: ${String(nextBusExit.cause)}`,
                cause: nextBusExit.cause,
              })
            : undefined;
        const tmixSnapshot = tmixExit?._tag === "Success" ? tmixExit.value : undefined;
        const tmixFailure =
          tmixExit?._tag === "Failure"
            ? new RealtimeError({
                agencyId,
                message: `Tmix AnyRide realtime failed: ${String(tmixExit.cause)}`,
                cause: tmixExit.cause,
              })
            : undefined;
        const vehiclePositions = [
          ...vehicleFeedsDecoded.flatMap((feed) => feed.vehiclePositions),
          ...(nextBusSnapshot?.vehicles ?? []),
          ...(tmixSnapshot?.vehicles ?? []),
        ];
        const tripUpdates = [
          ...dropCancelledTrips(
            tripFeedsDecoded.flatMap((feed) => feed.tripUpdates),
            cancelledTripIds,
          ),
          ...(nextBusSnapshot?.arrivals ?? []),
          ...(tmixSnapshot?.arrivals ?? []),
        ];

        const vehiclesAvailable =
          vehicleFeedsDecoded.length > 0 ||
          nextBusSnapshot?.vehiclesAvailable === true ||
          tmixSnapshot?.vehiclesAvailable === true;
        const arrivalsAvailable =
          tripFeedsDecoded.length > 0 ||
          nextBusSnapshot?.arrivalsAvailable === true ||
          tmixSnapshot?.arrivalsAvailable === true;

        if (needsVehicles && !vehiclesAvailable) {
          return yield* Effect.fail(
            vehicleError ??
              nextBusFailure ??
              tmixFailure ??
              new RealtimeError({
                agencyId,
                message: `No usable vehicle_positions feed for ${agencyId}`,
              }),
          );
        }
        if (needsArrivals && !arrivalsAvailable) {
          return yield* Effect.fail(
            tripError ??
              nextBusFailure ??
              tmixFailure ??
              new RealtimeError({
                agencyId,
                message: `No usable trip_updates feed for ${agencyId}`,
              }),
          );
        }

        const snapshot: RealtimeSnapshot = {
          agencyId,
          updatedAt: now(),
          ...((needsVehicles && vehicleError !== undefined) ||
          (needsArrivals && tripError !== undefined) ||
          nextBusExit?._tag === "Failure" ||
          tmixExit?._tag === "Failure" ||
          tmixSnapshot?.partial === true
            ? { partial: true as const }
            : {}),
          vehicles: vehiclePositions.map((vehicle) => ({
            ...vehicle,
            routeId: normalizeRealtimeRouteId(vehicle.routeId, topology.routes, opts.routeLineMap),
          })),
          arrivals: tripUpdates.map((arrival) => ({
            ...arrival,
            routeId: normalizeRealtimeRouteId(arrival.routeId, topology.routes, opts.routeLineMap),
          })),
        };
        if (snapshot.partial) {
          logger.warn(`${agencyId} realtime snapshot is partial`, {
            agencyId,
            vehicleFeedsFailed: needsVehicles && vehicleError !== undefined,
            tripFeedsFailed: needsArrivals && tripError !== undefined,
            nextBusFailed: nextBusExit?._tag === "Failure",
            tmixFailed: tmixExit?._tag === "Failure",
            tmixPartial: tmixSnapshot?.partial === true,
          });
        }
        return snapshot;
      }),
  };
}
