import * as Effect from "effect/Effect";
import type { FeedAuth, SchematicStationIndexEntry } from "~/agencies/types";
import { RealtimeError, type RealtimeSource } from "~/domain/surface/realtimeSource";
import { StationsError, type StationsSource } from "~/domain/surface/stationsSource";
import type {
  ArrivalPrediction,
  LiveVehiclePosition,
  NearbyStationArrival,
} from "~/domain/surface/types";
import { calculateHaversineMeters } from "~/domain/map/MapGeometry";
import { calculateWalkingMinutes } from "~/domain/proximity";
import { fetchDecodedFeeds, TransportFailure } from "./fetchDecodedFeeds";
import { createSwrFeedCache } from "./swrFeedCache";

/** Every tracked train in one network-wide document, already joined to GTFS identities. */
export interface NetworkTrainSnapshot {
  readonly vehicles: readonly LiveVehiclePosition[];
  readonly arrivals: readonly ArrivalPrediction[];
}

export interface NetworkTrainFeed {
  readonly url: string;
  readonly auth?: FeedAuth;
  readonly devProxyPrefix?: string;
  readonly pollIntervalSeconds?: number;
}

export interface NetworkTrainProtocol {
  /** Omitted for a non-JSON wire body, because some servers refuse an `Accept` they cannot meet. */
  readonly wireFormat?: "json";
  /** Turns the wire body into the stored document, such as decrypting it. */
  readonly prepare?: (bytes: Uint8Array) => Promise<Uint8Array>;
  /** Several requests per refresh, stored as one JSON array; any failure fails the refresh. */
  readonly requestUrls?: (now: number) => readonly string[];
  /** Station card row label; trains default to their number. */
  readonly routeType?: "rail" | "bus";
  readonly label?: (arrival: ArrivalPrediction) => string;
  /** Decodes a stored document; throws when it cannot establish live predictions. */
  readonly decode: (bytes: Uint8Array, now: number) => NetworkTrainSnapshot;
}

interface SourceOptions {
  readonly agencyId: string;
  readonly feed: NetworkTrainFeed;
  readonly protocol: NetworkTrainProtocol;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}
interface DocumentState {
  readonly generatedAt: number;
  readonly bytes: Uint8Array;
}
const documents = new Map<string, ReturnType<typeof createSwrFeedCache<DocumentState>>>();

/** Shared by station and vehicle consumers; filters never become upstream requests. */
function documentSource(options: SourceOptions) {
  const { agencyId, feed, protocol } = options;
  const now = options.now ?? Date.now;
  const key = JSON.stringify([
    agencyId,
    feed.url,
    feed.auth,
    feed.devProxyPrefix,
    options.devProxyOrigin,
    feed.pollIntervalSeconds,
  ]);
  let cache = documents.get(key);
  if (!cache) {
    const ttlMs = (feed.pollIntervalSeconds ?? 300) * 1000;
    // Public documents can be shared across isolates at a Cloudflare edge.
    // Authenticated feeds stay private to this process.
    const edge = feed.auth
      ? undefined
      : (
          globalThis as typeof globalThis & {
            caches?: CacheStorage & { default?: Pick<Cache, "match" | "put"> };
          }
        ).caches?.default;
    const edgeUrl = new URL("https://schematic-edge-cache.invalid/network-trains");
    edgeUrl.searchParams.set("agency", agencyId);
    edgeUrl.searchParams.set("url", feed.url);
    const edgeKey = new Request(edgeUrl);
    cache = createSwrFeedCache<DocumentState>({
      label: `${agencyId} network trains`,
      ttlMs,
      initialState: { generatedAt: 0, bytes: new Uint8Array() },
      expiryPolicy: "join-refresh",
      onRefreshFailure: "throw",
      failureTtlMs: ttlMs,
      refresh: async () => {
        const cached = await edge?.match(edgeKey).catch(() => undefined);
        if (cached) {
          const generatedAt = Number(cached.headers.get("X-Schematic-Observed-At"));
          if (generatedAt > 0 && Date.now() - generatedAt < ttlMs && generatedAt <= Date.now()) {
            try {
              const bytes = new Uint8Array(await cached.arrayBuffer());
              protocol.decode(bytes, now());
              return { bytes, generatedAt };
            } catch {
              // An unusable edge entry is a cache miss; refetch and validate upstream.
            }
          }
        }
        const urls = protocol.requestUrls?.(now());
        for (let attempt = 0; attempt < 3; attempt += 1) {
          const result = await Effect.runPromise(
            fetchDecodedFeeds(
              (urls ?? [feed.url]).map((url) => ({
                url,
                auth: feed.auth,
                devProxyPrefix: feed.devProxyPrefix,
                format: protocol.wireFormat,
                decode: (wire: Uint8Array) =>
                  Effect.tryPromise(async () => {
                    const bytes = protocol.prepare ? await protocol.prepare(wire) : wire;
                    // Pieces of a multi-request document are validated once combined.
                    if (urls) JSON.parse(new TextDecoder().decode(bytes));
                    else protocol.decode(bytes, now());
                    return bytes;
                  }),
                mapError: (cause: unknown) => cause,
              })),
              {
                fetch: options.fetch,
                getSecret: options.getSecret,
                devProxyOrigin: options.devProxyOrigin,
                // Multi-board documents retry on the next refresh, keeping one refresh
                // within the Workers subrequest budget (two requests per hub).
                attempts: urls ? 1 : 3,
                timeoutMs: 8_000,
              },
            ),
          );
          const complete = urls
            ? result.firstError === undefined && result.usable.length === urls.length
            : result.usable.length > 0;
          if (complete) {
            const bytes = urls
              ? new TextEncoder().encode(
                  `[${result.usable.map((piece) => new TextDecoder().decode(piece)).join(",")}]`,
                )
              : result.usable[0]!;
            if (urls) protocol.decode(bytes, now());
            const state = { bytes, generatedAt: Date.now() };
            await edge
              ?.put(
                edgeKey,
                new Response(state.bytes.slice().buffer, {
                  headers: {
                    "Content-Type": "application/octet-stream",
                    "Cache-Control": `public, max-age=${ttlMs / 1000}`,
                    "X-Schematic-Observed-At": String(state.generatedAt),
                  },
                }),
              )
              .catch(() => undefined);
            return state;
          }
          // A torn document is a transient decode failure. Transport already
          // owns its retry policy, including never retrying rate limits.
          if (result.firstError instanceof TransportFailure || attempt === 2)
            throw result.firstError;
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("No usable network document");
      },
    });
    documents.set(key, cache);
  }
  return {
    get: () => cache.get().then(({ bytes }) => protocol.decode(bytes, now())),
    peek: (): NetworkTrainSnapshot => {
      const bytes = cache.peek().bytes;
      return bytes.length > 0 ? protocol.decode(bytes, now()) : { vehicles: [], arrivals: [] };
    },
  };
}

export function createNetworkTrainsRealtimeSource(options: SourceOptions): RealtimeSource {
  const source = documentSource(options);
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => {
          const snapshot = await source.get();
          const matchesRoute = (id: string) => !filter?.routeIds?.size || filter.routeIds.has(id);
          return {
            agencyId: options.agencyId,
            updatedAt: (options.now ?? Date.now)(),
            vehicles: snapshot.vehicles.filter((vehicle) => matchesRoute(vehicle.routeId)),
            arrivals: snapshot.arrivals.filter((arrival) => {
              const stops = filter?.stopIdsByRoute?.get(arrival.routeId) ?? filter?.stopIds;
              return (
                matchesRoute(arrival.routeId) &&
                (!stops?.size || (arrival.stopId !== undefined && stops.has(arrival.stopId)))
              );
            }),
          };
        },
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Network train feed unavailable",
            cause,
          }),
      }),
  };
}

export function createNetworkTrainsStationsSource(
  options: SourceOptions & {
    readonly stations: readonly SchematicStationIndexEntry[];
    readonly routeLineMap?: Readonly<Record<string, string>>;
  },
): StationsSource {
  const source = documentSource(options);
  const cards = (stations: readonly SchematicStationIndexEntry[], lat?: number, lon?: number) =>
    Effect.tryPromise({
      try: async (): Promise<readonly NearbyStationArrival[]> => {
        if (stations.length === 0) return [];
        let snapshot;
        let stale = false;
        try {
          snapshot = await source.get();
        } catch {
          snapshot = source.peek();
          stale = true;
        }
        return stations
          .map((station) => {
            const distanceMeters =
              lat === undefined || lon === undefined
                ? 0
                : calculateHaversineMeters(lat, lon, station.lat, station.lon);
            const predictions = snapshot.arrivals
              .filter(
                (arrival) =>
                  arrival.stopId !== undefined && station.platformIds.includes(arrival.stopId),
              )
              .sort((a, b) => a.predictedTime - b.predictedTime);
            return {
              id: station.schematicId ?? station.id,
              stationName: station.name,
              lineIds: station.lines,
              trackingRouteId: predictions.find(
                (arrival) =>
                  station.lines[0] !== undefined &&
                  options.routeLineMap?.[arrival.routeId] === station.lines[0],
              )?.routeId,
              agencyId: options.agencyId,
              routeType: options.protocol.routeType ?? "rail",
              lat: station.lat,
              lon: station.lon,
              distanceMeters,
              walkingMinutes: calculateWalkingMinutes(distanceMeters),
              arrivals: predictions.map((arrival) => ({
                directionId: arrival.directionId === 1 ? 1 : 0,
                label:
                  options.protocol.label?.(arrival) ??
                  `Train ${arrival.tripId.split(":")[0]} → ${arrival.headsign}`,
                // An undrawn route has no line to badge; its row still names the train.
                lineId:
                  options.routeLineMap?.[arrival.routeId] ??
                  (station.lines.includes(arrival.routeId) ? arrival.routeId : undefined),
                times: [arrival.predictedTime],
              })),
              arrivalsStale:
                stale || predictions.some((prediction) => prediction.freshness === "stale")
                  ? true
                  : undefined,
              livePredictionsOnly: true,
            } satisfies NearbyStationArrival;
          })
          .sort((a, b) => a.distanceMeters - b.distanceMeters);
      },
      catch: (cause) =>
        new StationsError({
          agencyId: options.agencyId,
          message: "Network station departures unavailable",
          cause,
        }),
    });
  return {
    fetchNearby: (query) =>
      cards(
        options.stations.filter(
          (station) =>
            calculateHaversineMeters(query.lat, query.lon, station.lat, station.lon) <=
            query.radiusMeters,
        ),
        query.lat,
        query.lon,
      ),
    fetchSaved: (query) =>
      cards(
        options.stations.filter((station) => query.stationNames.includes(station.name)),
        query.lat,
        query.lon,
      ),
    fetchByIds: (query) =>
      cards(
        options.stations.filter((station) =>
          query.stationIds.includes(station.schematicId ?? station.id),
        ),
        query.lat,
        query.lon,
      ),
  };
}
