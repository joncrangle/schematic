import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { RealtimeFeedConfig } from "~/agencies/types";
import {
  RealtimeError,
  type RealtimeFetchOptions,
  type RealtimeSource,
} from "~/domain/surface/realtimeSource";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { readVendorDocument, type VendorOptions } from "../vendorDocument";
import { TransportFailure } from "../fetchDecodedFeeds";

type Feed = Extract<RealtimeFeedConfig, { kind: "samsara_boards" }>;
const jobSchema = Schema.Struct({
  id: Schema.Number,
  destinationName: Schema.String,
  jobState: Schema.Number,
  scheduledArrivalTime: Schema.Number,
  arrivedAt: Schema.Number,
  completedAt: Schema.Number,
  eta: Schema.NullOr(Schema.Struct({ etaMs: Schema.Number, etaRefreshedAtMs: Schema.Number })),
});
export function decodeSamsaraJob(
  body: unknown,
  identity: { readonly stopId: string; readonly routeId: string; readonly headsign: string },
  now: number,
): ArrivalPrediction | undefined {
  const job = Schema.decodeUnknownSync(jobSchema)(body);
  if (
    !job.eta ||
    job.arrivedAt ||
    job.completedAt ||
    ![1, 2].includes(job.jobState) ||
    job.eta.etaMs < now ||
    now - job.eta.etaRefreshedAtMs > 1200000 ||
    job.eta.etaRefreshedAtMs > now + 60000
  )
    return undefined;
  return {
    ...identity,
    tripId: String(job.id),
    directionId: 0,
    stopSequence: 0,
    predictedTime: job.eta.etaMs,
    delaySeconds:
      job.scheduledArrivalTime > 0 ? (job.eta.etaMs - job.scheduledArrivalTime) / 1000 : 0,
    scheduleRelationship: "SCHEDULED",
    isRealtime: true,
  };
}
const boardSchema = Schema.Struct({
  etas: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      attributes: Schema.Struct({
        samaraRouteName: Schema.String,
        stopName: Schema.String,
        stopPosition: Schema.String,
        state: Schema.String,
        actualRouteStartTime: Schema.optional(Schema.NullOr(Schema.String)),
        scheduledRouteEndTime: Schema.optional(Schema.String),
        liveSharingUrl: Schema.optional(Schema.NullOr(Schema.String)),
        vehicleName: Schema.optional(Schema.NullOr(Schema.String)),
        vehicleLocation: Schema.optional(
          Schema.NullOr(
            Schema.Struct({
              latitude: Schema.Number,
              longitude: Schema.Number,
              timestamp: Schema.String,
            }),
          ),
        ),
      }),
    }),
  ),
});
const routeJobSchema = Schema.Struct({
  id: Schema.Number,
  destinationLat: Schema.Number,
  destinationLng: Schema.Number,
  jobState: Schema.Number,
  scheduledArrivalTime: Schema.Number,
  arrivedAt: Schema.Number,
  eta: Schema.NullOr(Schema.Struct({ etaMs: Schema.Number, etaRefreshedAtMs: Schema.Number })),
});
const trackerSchema = Schema.Struct({
  data: Schema.Struct({
    dispatchJobFleetViewerToken: Schema.Struct({
      job: jobSchema,
      dispatchRoute: Schema.Struct({
        dispatchJobsV2: Schema.Array(Schema.Struct({ job: Schema.Unknown })),
      }),
      routeIsComplete: Schema.Boolean,
    }),
  }),
});
const fields =
  "id destinationName jobState scheduledArrivalTime arrivedAt completedAt eta { etaMs etaRefreshedAtMs }";
const query = `query FleetViewerByJob($token: string!, $orgId: int64!) { dispatchJobFleetViewerToken(token: $token, orgId: $orgId) { job { ${fields} } dispatchRoute { dispatchJobsV2 { job { id destinationLat destinationLng jobState scheduledArrivalTime arrivedAt eta { etaMs etaRefreshedAtMs } } } } routeIsComplete } }`;
const csrfSchema = Schema.Struct({ csrf_token: Schema.String });

const sessions = new WeakMap<
  typeof fetch,
  Map<string, { until: number; headers: Record<string, string> }>
>();
async function trackerSession(options: VendorOptions, origin: string) {
  const cache =
    sessions.get(options.fetch) ??
    new Map<string, { until: number; headers: Record<string, string> }>();
  sessions.set(options.fetch, cache);
  const now = (options.now ?? Date.now)();
  const cached = cache.get(origin);
  if (cached && cached.until > now) return cached.headers;
  const response = await options.fetch(`${origin}/r/auth/csrf`, {
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) throw new Error("Samsara anonymous session unavailable");
  const csrf = Schema.decodeUnknownSync(csrfSchema)(await response.json());
  const cookies = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
  if (!cookies) throw new Error("Samsara anonymous session cookie missing");
  const headers = {
    Cookie: cookies,
    "X-Csrf-Token": csrf.csrf_token,
    Origin: origin,
    Accept: "application/json; version=2",
  };
  cache.set(origin, { until: now + 300000, headers });
  return headers;
}

/** Cover the requested routes with shared hub boards instead of sweeping every stop. */
function hubBoards(feed: Feed, routes: ReadonlySet<string>) {
  const uncovered = new Set(routes),
    selected: [string, Feed["stations"][string]][] = [];
  const candidates = Object.entries(feed.stations);
  while (uncovered.size) {
    candidates.sort(
      (a, b) =>
        b[1].routeIds.filter((r) => uncovered.has(r)).length -
          a[1].routeIds.filter((r) => uncovered.has(r)).length || a[0].localeCompare(b[0]),
    );
    const best = candidates.shift();
    if (!best || !best[1].routeIds.some((r) => uncovered.has(r))) break;
    selected.push(best);
    best[1].routeIds.forEach((r) => uncovered.delete(r));
  }
  return selected;
}
export async function fetchSamsaraBoards(
  feed: Feed,
  options: VendorOptions & RealtimeFetchOptions,
) {
  const requested = Object.entries(feed.stations).filter(
    ([id, s]) =>
      (!options.stopIds?.size || options.stopIds.has(id)) &&
      s.routeIds.some(
        (r) =>
          (!options.routeIds?.size || options.routeIds.has(r)) &&
          (!options.stopIdsByRoute?.get(r)?.size || options.stopIdsByRoute.get(r)!.has(id)),
      ),
  );
  const routes = new Set(
    requested
      .flatMap(([, s]) => s.routeIds)
      .filter((r) => !options.routeIds?.size || options.routeIds.has(r)),
  );
  const boards =
    options.stopIds?.size && !options.vehiclesOnly ? requested : hubBoards(feed, routes);
  const wantedIds = new Set(requested.map(([id]) => id));
  const names = new Map<string, string>();
  for (const [id, station] of requested) {
    if (names.has(station.name)) throw new Error("Ambiguous station name");
    names.set(station.name, id);
  }
  const arrivals = new Map<string, ArrivalPrediction>();
  const vehicles = new Map<string, LiveVehiclePosition>();
  const vehicleStarts = new Map<string, number>();
  const visited = new Set<string>();
  let remaining = Math.max(0, Math.floor(options.maxSubrequests ?? 40)),
    failed = 0,
    processed = 0,
    completeReads = 0;
  const spend = () => {
    if (remaining-- <= 0) throw new Error("Samsara request budget exhausted");
  };
  const now = (options.now ?? Date.now)();
  const addVehicle = (row: Schema.Schema.Type<typeof boardSchema>["etas"][number]) => {
    const data = row.attributes,
      fix = data.vehicleLocation;
    const timestamp = Date.parse(fix?.timestamp ?? ""),
      started = Date.parse(data.actualRouteStartTime ?? "");
    if (
      !fix ||
      !data.vehicleName ||
      !Number.isFinite(started) ||
      started > now ||
      !Number.isFinite(timestamp) ||
      now - timestamp > 180000 ||
      timestamp > now + 60000 ||
      Math.abs(fix.latitude) > 90 ||
      Math.abs(fix.longitude) > 180
    )
      return;
    const previous = vehicles.get(data.vehicleName);
    if (
      !previous ||
      (vehicleStarts.get(data.vehicleName) ?? 0) < started ||
      (vehicleStarts.get(data.vehicleName) === started && previous.timestamp < timestamp)
    ) {
      vehicleStarts.set(data.vehicleName, started);
      vehicles.set(data.vehicleName, {
        vehicleId: data.vehicleName,
        tripId: row.id,
        routeId: data.samaraRouteName,
        directionId: 0,
        latitude: fix.latitude,
        longitude: fix.longitude,
        timestamp,
      });
    }
  };
  for (const [, station] of boards) {
    if (remaining < 1) break;
    processed++;
    try {
      spend();
      const url = new URL(feed.url);
      url.searchParams.set("stationName", station.name);
      const board = Schema.decodeUnknownSync(boardSchema)(
        await readVendorDocument(options, url.href, {
          interval: feed.pollIntervalSeconds ?? 60,
          requestsPerMinute: feed.requestsPerMinute ?? 30,
        }),
      );
      if (!board.etas.length) completeReads++;
      for (const row of board.etas) {
        try {
          const data = row.attributes,
            routeId = data.samaraRouteName;
          if (data.stopName !== station.name || !station.routeIds.includes(routeId))
            throw new Error("Samsara station or route identity mismatch");
          if (!routes.has(routeId)) {
            completeReads++;
            continue;
          }
          if (options.vehiclesOnly) {
            completeReads++;
            // Fleet reads use a small fixed hub cover, never the per-stop ETA path.
            if (Date.parse(data.scheduledRouteEndTime ?? "") >= now) addVehicle(row);
            continue;
          }
          if (!data.liveSharingUrl) {
            completeReads++;
            continue;
          }
          const link = new URL(data.liveSharingUrl);
          const match = /^\/o\/(\d+)\/fleet\/viewer\/job\/([A-Za-z0-9_-]+)$/.exec(link.pathname);
          if (link.origin !== feed.trackerOrigin || !match || match[1] !== feed.orgId)
            throw new Error("Unexpected public tracker identity");
          if (visited.has(match[2])) continue;
          visited.add(match[2]);
          let tracker: Schema.Schema.Type<typeof trackerSchema> | undefined;
          for (let attempt = 0; attempt < 2; attempt++) {
            try {
              const cached = sessions.get(options.fetch)?.get(feed.trackerOrigin);
              if (!cached || cached.until <= now) spend();
              const session = await trackerSession(options, feed.trackerOrigin);
              spend();
              tracker = Schema.decodeUnknownSync(trackerSchema)(
                await readVendorDocument(options, `${feed.trackerOrigin}/r/graphql`, {
                  interval: feed.pollIntervalSeconds ?? 60,
                  requestsPerMinute: feed.requestsPerMinute ?? 30,
                  headers: session,
                  body: { query, variables: { token: match[2], orgId: Number(feed.orgId) } },
                  observeResponse: (response) => {
                    const cookies = new Map(
                      session.Cookie.split("; ").map((v) => {
                        const i = v.indexOf("=");
                        return [v.slice(0, i), v.slice(i + 1)];
                      }),
                    );
                    for (const value of response.headers.getSetCookie()) {
                      const pair = value.split(";")[0],
                        i = pair.indexOf("=");
                      cookies.set(pair.slice(0, i), pair.slice(i + 1));
                    }
                    session.Cookie = [...cookies].map(([k, v]) => `${k}=${v}`).join("; ");
                  },
                }),
              );
              break;
            } catch (cause) {
              if (
                attempt ||
                !(cause instanceof TransportFailure) ||
                ![401, 403].includes(cause.status ?? 0)
              )
                throw cause;
              sessions.get(options.fetch)?.delete(feed.trackerOrigin);
            }
          }
          if (!tracker) throw new Error("Public tracker unavailable");
          const result = tracker.data.dispatchJobFleetViewerToken;
          if (String(result.job.id) !== row.id || result.job.destinationName !== station.name)
            throw new Error("Samsara tracker job identity mismatch");
          completeReads++;
          if (result.routeIsComplete) continue;
          addVehicle(row);
          const jobs = result.dispatchRoute.dispatchJobsV2.map((r) => r.job);
          for (const [index, rawJob] of jobs.entries()) {
            let job: Schema.Schema.Type<typeof routeJobSchema>;
            try {
              job = Schema.decodeUnknownSync(routeJobSchema)(rawJob);
            } catch {
              failed++;
              continue;
            }
            const candidates = Object.entries(feed.stations)
              .filter(([, station]) => station.routeIds.includes(routeId))
              .map(([id, station]) => ({
                id,
                distance: Math.hypot(
                  (station.lat - job.destinationLat) * 111000,
                  (station.lon - job.destinationLng) *
                    111000 *
                    Math.cos((job.destinationLat * Math.PI) / 180),
                ),
              }))
              .filter((candidate) => candidate.distance < 150)
              .sort((a, b) => a.distance - b.distance);
            const closest = candidates[0];
            const unambiguous =
              closest && (!candidates[1] || candidates[1].distance - closest.distance >= 25);
            const stopId =
              job.id === result.job.id
                ? names.get(result.job.destinationName)
                : unambiguous
                  ? closest.id
                  : undefined;
            if (closest && !unambiguous && job.id !== result.job.id) failed++;
            if (
              !stopId ||
              !wantedIds.has(stopId) ||
              !feed.stations[stopId].routeIds.includes(routeId) ||
              (options.stopIdsByRoute?.get(routeId)?.size &&
                !options.stopIdsByRoute.get(routeId)!.has(stopId))
            )
              continue;
            if (
              job.eta &&
              !job.arrivedAt &&
              (now - job.eta.etaRefreshedAtMs > 1200000 || job.eta.etaRefreshedAtMs > now + 60000)
            ) {
              failed++;
              continue;
            }
            // The route's final job is an arrival-only terminal.
            if (index === jobs.length - 1) continue;
            const arrival = decodeSamsaraJob(
              { ...job, destinationName: feed.stations[stopId].name, completedAt: 0 },
              { stopId, routeId, headsign: routeId.split(" - ").at(-1)! },
              now,
            );
            if (arrival) arrivals.set(`${routeId}:${job.id}`, arrival);
          }
        } catch {
          failed++;
        }
      }
    } catch {
      failed++;
    }
  }
  if (processed && failed && !completeReads && !arrivals.size && !vehicles.size)
    throw new Error("Samsara live boards unavailable");
  return {
    arrivals: [...arrivals.values()],
    vehicles: [...vehicles.values()],
    partial: failed > 0 || processed < boards.length,
  };
}
export function createSamsaraRealtimeSource(
  options: VendorOptions & { readonly agencyId: string; readonly feed: Feed },
): RealtimeSource {
  return {
    fetchRealtime: (_topology, filter) =>
      Effect.tryPromise({
        try: async () => ({
          agencyId: options.agencyId,
          updatedAt: (options.now ?? Date.now)(),
          ...(await fetchSamsaraBoards(options.feed, { ...options, ...filter })),
        }),
        catch: (cause) =>
          new RealtimeError({
            agencyId: options.agencyId,
            message: "Samsara realtime unavailable",
            cause,
          }),
      }),
  };
}
