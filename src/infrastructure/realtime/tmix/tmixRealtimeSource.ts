import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Cause from "effect/Cause";
import type { RealtimeFeedConfig } from "~/agencies/types";
import type { StaticSnapshot } from "~/domain/surface/topologySource";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import type { RealtimeFetchOptions } from "~/domain/surface/realtimeSource";
import { fetchDecodedFeeds } from "../fetchDecodedFeeds";
import { logger } from "~/infrastructure/logging/logger";
import { routeIdsMatch } from "~/domain/surface/routeIds";
import {
  parseTmixStopResponse,
  parseTmixVehiclePosition,
  tmixCallsToArrivals,
  tmixPositionsToVehicles,
  type TmixCall,
  type TmixCallProjection,
  type TmixStopResponse,
  type TmixVehiclePosition,
} from "./tmixCallsDecoder";
import { tmixStopPollKey } from "./tmixStopPollCache";
import {
  isTmixOperatorInScope,
  tmixStopCallsRequest,
  tmixVehiclePositionRequest,
  type TmixAnyRideFeed,
} from "./tmixTransport";

/**
 * Tmix AnyRide realtime ingestion: per-stop departure calls, then a bounded
 * per-vehicle position fan-out.
 *
 * ## Why the fan-out exists
 *
 * AnyRide's bulk `GetVehiclePositions` is administratively disabled on this
 * tenant: it answers HTTP 200 with a literal `[]` under every parameter shape,
 * and `GetConfigOptions` reports `"showVehicleLocations": false`. The only
 * populated position source is `GetVehiclePosition?callId=…` — one request per
 * vehicle, with the call ids coming from `GetCalls`. A correct adapter is
 * therefore unavoidably a fan-out, which makes the caps below a correctness
 * requirement rather than a tuning knob.
 *
 * ## Why the budget is where it is
 *
 * `fetchDecodedFeeds` runs its feed list at `concurrency: "unbounded"` and its
 * default retry policy never retries 429. Handing it an unbounded vehicle list
 * would fire one simultaneous request per bus against a vendor that publishes
 * no rate limit. Each query is therefore issued as its own single-feed
 * `fetchDecodedFeeds` call, and the caps below are the only things governing
 * pressure.
 *
 * **The bound that matters is the total subrequest count, not either phase
 * alone.** Both phases issue `1 request × feed count × items queried`, so a
 * per-phase cap is not a per-invocation cap. {@link TMIX_MAX_SUBREQUESTS} is
 * the real ceiling, and {@link tmixWorkPlan} divides it between the two phases
 * and across declared feeds before anything is fetched:
 *
 * | feeds | queried stops | stop requests | queried vehicles | vehicle requests | total subrequests |
 * | ----- | ------------- | ------------- | ---------------- | ---------------- | ----------------- |
 * | 1     | 20            | 20 (20×1)     | 20               | 20 (20×1)        | 40                |
 * | 2     | 10            | 20 (10×2)     | 10               | 20 (10×2)        | 40                |
 *
 * 40 sits under the Workers Free limit of 50 subrequests per invocation with
 * headroom for the rest of the request, and the proximity panel — the heaviest
 * caller, asking about up to 3 stops per route across every route in range —
 * cannot exceed it. Truncation is logged with the count dropped, never silent.
 *
 * The remaining constants shape *when* the requests go out, not how many:
 * {@link TMIX_STOP_CALL_CONCURRENCY} and {@link TMIX_VEHICLE_POSITION_CONCURRENCY}
 * are the two phases' `Effect.all` concurrency, mirroring the existing
 * `NEXTBUS_QUERY_CONCURRENCY` precedent in `nextBusRealtimeSource.ts`.
 *
 * ## Degradation is honest
 *
 * Tmix has one dependency: the calls phase. Vehicles are located by call id,
 * so a vehicle refresh is *always* downstream of a `GetCalls` sweep, whether
 * or not the caller wanted arrivals. Reachability is therefore judged once, on
 * that sweep, and it gates both products:
 *
 * - the sweep reached nobody, and the caller wanted either product → fail. A
 *   `Success` with empty vehicles here would render as "no buses running" with
 *   no feed-down signal at all.
 * - the sweep reached the vendor and returned no calls → a correct empty board.
 *   `calls: []` outside service hours is a real answer, not a failure.
 * - the sweep worked but every position lookup failed → fail, for the same
 *   reason: a `null` body (the vendor answering "no such call") is available
 *   empty, an unreachable endpoint is not.
 */

/** Concurrent `GetCalls` POSTs. */
export const TMIX_STOP_CALL_CONCURRENCY = 6;
/** Concurrent `GetVehiclePosition` GETs; the fleet-scaling phase. */
export const TMIX_VEHICLE_POSITION_CONCURRENCY = 4;
/**
 * Total subrequests per refresh across BOTH phases and ALL declared feeds.
 *
 * Both phases cost one request per feed per item, so this is the only number
 * that actually bounds an invocation. 40 leaves headroom under the Workers
 * Free limit of 50 for everything else the request does.
 */
export const TMIX_MAX_SUBREQUESTS = 40;

export const TMIX_REQUEST_TIMEOUT_MS = 8_000;

export interface TmixRealtimeSnapshot {
  readonly arrivals: readonly ArrivalPrediction[];
  readonly vehicles: readonly LiveVehiclePosition[];
  readonly partial?: boolean;
  readonly arrivalsAvailable: boolean;
  readonly vehiclesAvailable: boolean;
}

export interface TmixRealtimeOptions {
  readonly agencyId: string;
  readonly feeds: readonly RealtimeFeedConfig[];
  readonly fetch: typeof fetch;
  readonly devProxyOrigin?: string;
  readonly getSecret?: (name: string) => string | undefined;
  readonly topology: StaticSnapshot;
  readonly fetchOptions?: RealtimeFetchOptions;
  readonly includeArrivals: boolean;
  readonly includeVehicles: boolean;
  readonly allowedLineIds?: ReadonlySet<string>;
  /**
   * Seam-supplied direction for a departure call. Tmix publishes no direction
   * field, so this is the only source of `directionId` on the arrivals side.
   * Every arrival this module produces is marked `directionInferred` regardless
   * of what is returned here, because the wire never stated one.
   */
  readonly project: (call: TmixCall, stopId: string) => TmixCallProjection;
  readonly projectVehicle: (call: TmixCall, position: TmixVehiclePosition) => 0 | 1;
}

type TmixRequestResult<T> = {
  readonly usable: readonly T[];
  readonly firstError?: Error;
};

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/**
 * The reason a fan-out phase produced nothing usable.
 *
 * A phase fails in one of two ways and the caller-facing error must not
 * flatten them: the effect itself failed, or the kernel returned an empty
 * `usable` list with the real cause in `firstError` (which is where an
 * HTTP status ends up — `fetchDecodedFeeds` never fails its own effect). The
 * underlying message is what makes "HTTP 503" visible in a log instead of a
 * generic "unavailable", so it is preferred and only falls back when absent.
 */
function callPhaseError(
  exits: readonly Exit.Exit<{ readonly result: { readonly firstError?: Error } }, unknown>[],
  agencyId: string,
  label: string,
): Error {
  for (const exit of exits) {
    if (Exit.isSuccess(exit) && exit.value.result.firstError) return exit.value.result.firstError;
  }
  for (const exit of exits) {
    if (Exit.isFailure(exit)) return asError(Cause.squash(exit.cause));
  }
  return new Error(`Tmix AnyRide ${label} unavailable for ${agencyId}`);
}

export function fetchStopCalls(
  feed: TmixAnyRideFeed,
  stopId: string,
  options: {
    readonly fetch: typeof fetch;
    readonly devProxyOrigin?: string;
    readonly getSecret?: (name: string) => string | undefined;
    readonly requestCache?: RealtimeFetchOptions["requestCache"];
  },
): Effect.Effect<TmixRequestResult<TmixStopResponse>, never> {
  // The same stop is wanted by the board, the map and the message alerts. A
  // poll made moments ago answers all of them without spending more of the
  // shared subrequest budget.
  const stopAreaId = feed.stopAreaMap ? feed.stopAreaMap[stopId] : stopId;
  if (!stopAreaId) {
    return Effect.succeed({
      usable: [],
      firstError: new Error(`Missing AnyRide stop-area mapping: ${stopId}`),
    });
  }
  const pollKey = tmixStopPollKey(feed, stopAreaId);
  const load = () =>
    fetchDecodedFeeds(
      [
        tmixStopCallsRequest(feed, stopAreaId, {
          decode: (bytes: Uint8Array) =>
            Effect.try({
              try: () => parseTmixStopResponse(bytes),
              catch: (cause) => cause,
            }),
          mapError: asError,
        }),
      ],
      {
        fetch: options.fetch,
        devProxyOrigin: options.devProxyOrigin,
        getSecret: options.getSecret,
        // Single attempt. Tmix is the vendor's own host rather than a shared
        // Metrolinx key, so a 429 is this adapter's own pressure; combined with
        // the fan-out caps, a gap in coverage beats hammering an endpoint that
        // publishes no rate limit.
        attempts: 1,
        timeoutMs: TMIX_REQUEST_TIMEOUT_MS,
      },
    );
  return options.requestCache
    ? options.requestCache.get(pollKey, load, (result) => {
        const response = result.usable[0];
        return response !== undefined && response.noContent !== true && response.alertEnvelopeValid;
      })
    : load();
}

export interface TmixStationArrivalsOptions {
  readonly agencyId: string;
  readonly platformIds: readonly string[];
  readonly lineIds?: readonly string[];
  readonly feeds: readonly TmixAnyRideFeed[];
  readonly fetch: typeof fetch;
  readonly devProxyOrigin?: string;
  readonly getSecret?: (name: string) => string | undefined;
  readonly project?: (call: TmixCall, stopId: string) => TmixCallProjection;
}

export interface TmixStationArrivalsResult {
  readonly byStop: Map<string, ArrivalPrediction[]>;
  readonly partial: boolean;
}

/**
 * Departures for one station's platforms from Tmix `GetCalls`.
 * Shared between the realtime and station service seams to avoid logic duplication.
 */
export function fetchTmixStationArrivals(
  options: TmixStationArrivalsOptions,
): Effect.Effect<TmixStationArrivalsResult, Error> {
  const project = options.project ?? (() => ({ directionId: 0 }));
  const allowedLineIds = options.lineIds ? new Set(options.lineIds) : undefined;
  return Effect.gen(function* () {
    const maxPlatforms = Math.max(
      1,
      Math.floor(TMIX_MAX_SUBREQUESTS / Math.max(1, options.feeds.length)),
    );
    const platformsDropped = Math.max(0, options.platformIds.length - maxPlatforms);
    if (platformsDropped > 0) {
      logger.warn(
        `Tmix AnyRide station subrequest budget reached for ${options.agencyId}: ` +
          `dropped ${platformsDropped} of ${options.platformIds.length} platform queries ` +
          `(TMIX_MAX_SUBREQUESTS=${TMIX_MAX_SUBREQUESTS}, feeds=${options.feeds.length})`,
        {
          agencyId: options.agencyId,
          dropped: platformsDropped,
          requested: options.platformIds.length,
        },
      );
    }
    const platformIds = options.platformIds.slice(0, maxPlatforms);

    const exits = yield* Effect.all(
      platformIds.flatMap((stopId) =>
        options.feeds.map((feed) =>
          fetchStopCalls(feed, stopId, {
            fetch: options.fetch,
            devProxyOrigin: options.devProxyOrigin,
            getSecret: options.getSecret,
          }).pipe(
            Effect.map((result) => ({ feed, stopId, result })),
            Effect.exit,
          ),
        ),
      ),
      { concurrency: TMIX_STOP_CALL_CONCURRENCY },
    );

    const reachable = exits.filter(
      (exit) => Exit.isSuccess(exit) && exit.value.result.usable.length > 0,
    );
    if (reachable.length === 0) {
      return yield* Effect.fail(callPhaseError(exits, options.agencyId, "departure calls"));
    }

    const byStop = new Map<string, ArrivalPrediction[]>();
    const failedRequests = exits.length - reachable.length;
    const partial = platformsDropped > 0 || failedRequests > 0;
    if (partial) {
      logger.warn(`${options.agencyId} Tmix station departures are partial`, {
        agencyId: options.agencyId,
        failedRequests,
        droppedPlatforms: platformsDropped,
      });
    }
    for (const exit of reachable) {
      if (!Exit.isSuccess(exit)) continue;
      const { feed, stopId, result } = exit.value;
      const predictions = result.usable.flatMap((response) =>
        tmixCallsToArrivals(response.calls, {
          stopId,
          operatorPrefix: feed.operatorPrefix,
          allowedLineIds,
          project,
        }),
      );
      if (predictions.length === 0) continue;
      byStop.set(stopId, [...(byStop.get(stopId) ?? []), ...predictions]);
    }
    return { byStop, partial };
  });
}

function fetchOneVehiclePosition(
  feed: TmixAnyRideFeed,
  callId: string,
  options: Pick<TmixRealtimeOptions, "fetch" | "devProxyOrigin" | "getSecret">,
): Effect.Effect<TmixRequestResult<TmixVehiclePosition | undefined>, never> {
  return fetchDecodedFeeds(
    [
      tmixVehiclePositionRequest(feed, callId, {
        // `Effect.try`, not `Effect.sync`, for the same reason the calls
        // decoder uses it: a 200 whose body is not JSON (captive portal,
        // proxy error page) makes `JSON.parse` throw, and inside `Effect.sync`
        // that is a *defect* — which `fetchDecodedFeeds`' `Effect.match` does
        // not catch. One lost vehicle out of the budget would never surface.
        // As a typed failure it becomes `firstError` like any other.
        decode: (bytes: Uint8Array) =>
          Effect.try({
            try: () => parseTmixVehiclePosition(bytes),
            catch: (cause) => cause,
          }),
        mapError: asError,
      }),
    ],
    {
      fetch: options.fetch,
      devProxyOrigin: options.devProxyOrigin,
      getSecret: options.getSecret,
      attempts: 1,
      timeoutMs: TMIX_REQUEST_TIMEOUT_MS,
    },
  );
}

export interface TmixCallDirectionContext {
  readonly topology?: StaticSnapshot;
  readonly directionTermini?: Readonly<Record<string, string>>;
  readonly stopId?: string;
}

/**
 * Infers direction for a Tmix call based on static topology or station metadata.
 *
 * Tmix publishes no direction field on calls, so direction must be derived
 * from destination headsign matching or stop association where possible,
 * falling back to directionId 0 with directionInferred: true.
 */
export function inferTmixCallDirection(
  call: TmixCall,
  context?: TmixCallDirectionContext,
): TmixCallProjection {
  if (context?.topology) {
    const matchingRoutes = context.topology.routes.filter((r) =>
      routeIdsMatch(r.routeId, call.line),
    );
    if (call.destination) {
      const dest = call.destination.toLowerCase();
      const destMatch = matchingRoutes.find(
        (r) =>
          r.headsign?.toLowerCase() === dest ||
          (r.directionLabel && r.directionLabel.toLowerCase() === dest),
      );
      if (destMatch && (destMatch.directionId === 0 || destMatch.directionId === 1)) {
        return { directionId: destMatch.directionId as 0 | 1 };
      }
    }
    if (context.stopId) {
      const dir0 = matchingRoutes.find(
        (r) => r.directionId === 0 && r.stops?.some((s) => s.id === context.stopId),
      );
      const dir1 = matchingRoutes.find(
        (r) => r.directionId === 1 && r.stops?.some((s) => s.id === context.stopId),
      );
      if (dir0 && !dir1) return { directionId: 0 };
      if (dir1 && !dir0) return { directionId: 1 };
    }
  }

  if (context?.directionTermini && call.destination) {
    const dest = call.destination.toLowerCase();
    for (const [dirKey, term] of Object.entries(context.directionTermini)) {
      if (term.toLowerCase() === dest) {
        if (dirKey === "northbound" || dirKey === "eastbound") return { directionId: 0 };
        if (dirKey === "southbound" || dirKey === "westbound") return { directionId: 1 };
      }
    }
  }

  return { directionId: 0 };
}

/**
 * Stops the caller wants departure calls for, in a deterministic order.
 *
 * Route-scoped queries take precedence, fetching stops for the specified routes
 * (or their filtered subset in stopIdsByRoute). Caller-requested stops come
 * next. With none requested, the set is synthesized from the route table in
 * topology order.
 *
 * This returns the *wish list*; {@link tmixWorkPlan} is what bounds it.
 */
export function tmixCallStopsFor(
  topology: StaticSnapshot,
  fetchOptions: RealtimeFetchOptions | undefined,
): readonly string[] {
  const requestedStops = fetchOptions?.stopIds;
  const requestedRoutes = fetchOptions?.routeIds;
  const stopIdsByRoute = fetchOptions?.stopIdsByRoute;

  if (requestedRoutes && requestedRoutes.size > 0) {
    const routeStops = new Set<string>();
    for (const routeId of requestedRoutes) {
      const scopedStops = stopIdsByRoute?.get(routeId);
      if (scopedStops && scopedStops.size > 0) {
        for (const id of scopedStops) {
          if (!requestedStops || requestedStops.has(id)) routeStops.add(id);
        }
      } else {
        for (const route of topology.routes) {
          if (routeIdsMatch(route.routeId, routeId)) {
            for (const s of route.stops) {
              if (!requestedStops || requestedStops.has(s.id)) routeStops.add(s.id);
            }
          }
        }
      }
    }
    if (routeStops.size > 0) {
      return [...routeStops];
    }
  }

  if (requestedStops && requestedStops.size > 0) {
    const known = new Set<string>();
    for (const route of topology.routes) {
      for (const stop of route.stops) {
        if (requestedStops.has(stop.id)) known.add(stop.id);
      }
    }
    return [...new Set([...known, ...requestedStops])];
  }
  return [...new Set(topology.routes.flatMap((route) => route.stops.map((stop) => stop.id)))];
}

/** What one refresh will actually fetch, and what that cost. */
export interface TmixWorkPlan {
  /** Stops to query, already truncated to the subrequest allowance. */
  readonly stops: readonly string[];
  /** Allowance for vehicle positions after the stop phase is paid for. */
  readonly vehicleAllowance: number;
  /** Stops dropped to stay inside {@link TMIX_MAX_SUBREQUESTS}. */
  readonly stopsDropped: number;
}

/**
 * Divides the subrequest budget between the two phases and across feeds.
 *
 * Splitting the budget evenly is the conservative choice: the stop phase
 * feeds the departure board (what a rider at a stop reads) and the vehicle
 * phase feeds the map, and there is no basis in the wire for saying one
 * matters more. Halving per feed keeps a two-feed agency — which pays twice per
 * item — inside the same total as a one-feed agency.
 *
 * Stops are truncated before vehicles because a stop query is what discovers
 * call ids at all: without one, the vehicle phase has no work to do regardless
 * of the allowance it was given.
 */
export function tmixWorkPlan(
  requestedStops: readonly string[],
  feedCount: number,
  maxSubrequests: number = TMIX_MAX_SUBREQUESTS,
): TmixWorkPlan {
  const budget = Math.min(TMIX_MAX_SUBREQUESTS, Math.max(0, Math.floor(maxSubrequests)));
  if (feedCount <= 0 || budget < feedCount) {
    return { stops: [], vehicleAllowance: 0, stopsDropped: requestedStops.length };
  }
  const perFeed = Math.floor(budget / feedCount);
  const stopAllowance = Math.min(requestedStops.length, Math.max(1, Math.floor(perFeed / 2)));
  return {
    stops: requestedStops.slice(0, stopAllowance),
    vehicleAllowance: Math.max(0, perFeed - stopAllowance),
    stopsDropped: requestedStops.length - stopAllowance,
  };
}

/** Fetches a provider-declared Tmix AnyRide realtime source without naming an agency. */
export function fetchTmixRealtime(
  options: TmixRealtimeOptions,
): Effect.Effect<TmixRealtimeSnapshot, Error> {
  const feeds = options.feeds.filter(
    (feed): feed is TmixAnyRideFeed => feed.kind === "tmix_anyride",
  );
  const requestedStops = tmixCallStopsFor(options.topology, options.fetchOptions);
  const work = tmixWorkPlan(requestedStops, feeds.length, options.fetchOptions?.maxSubrequests);
  const stopQueries = work.stops;

  return Effect.gen(function* () {
    if (feeds.length === 0) {
      return yield* Effect.fail(new Error(`Missing Tmix AnyRide feed for ${options.agencyId}`));
    }
    if (requestedStops.length === 0) {
      return yield* Effect.fail(
        new Error(`Tmix AnyRide requires at least one stop to query for ${options.agencyId}`),
      );
    }
    // Truncation is the only clue a refresh was partial, and a partial
    // departure board misleads as badly as a partial map, so this is reported
    // before the phase runs rather than only when vehicles were also asked.
    if (work.stopsDropped > 0) {
      logger.warn(
        `Tmix AnyRide subrequest budget reached for ${options.agencyId}: ` +
          `dropped ${work.stopsDropped} of ${requestedStops.length} requested stops ` +
          `(TMIX_MAX_SUBREQUESTS=${TMIX_MAX_SUBREQUESTS}, feeds=${feeds.length})`,
        {
          agencyId: options.agencyId,
          dropped: work.stopsDropped,
          requested: requestedStops.length,
        },
      );
    }

    const callExits = yield* Effect.all(
      stopQueries.flatMap((stopId) =>
        feeds.map((feed) =>
          fetchStopCalls(feed, stopId, {
            fetch: options.fetch,
            devProxyOrigin: options.devProxyOrigin,
            getSecret: options.getSecret,
            requestCache: options.fetchOptions?.requestCache,
          }).pipe(
            // Carried through so a caller-facing error can name the stop that
            // failed rather than an opaque index in a fan-out.
            Effect.map((result) => ({ feed, stopId, result })),
            Effect.exit,
          ),
        ),
      ),
      { concurrency: TMIX_STOP_CALL_CONCURRENCY },
    );

    // `fetchDecodedFeeds` never fails: it reports an empty `usable` list plus a
    // `firstError`. So "reached the vendor" is a *non-empty usable list*, not a
    // successful exit — every exit here is a success by construction, and
    // reading it otherwise would treat a total HTTP failure as a live but
    // quiet feed.
    const callResults = callExits.flatMap((exit) => {
      if (!Exit.isSuccess(exit) || exit.value.result.usable.length === 0) return [];
      return [exit.value];
    });
    let partial = work.stopsDropped > 0 || callResults.length < callExits.length;

    // THE reachability gate, and it is deliberately unconditional on what the
    // caller asked for. Vehicles are located by call id, so the position phase
    // is downstream of this sweep even when `includeArrivals` is false (route
    // tracking names routes, not stops). Gating on `includeArrivals` here let a
    // total `GetCalls` outage satisfy a vehicles-only request with
    // `vehicles: []` and `vehiclesAvailable: true` — a map reading "no buses
    // running" with nothing wrong anywhere in the response.
    if (callResults.length === 0) {
      return yield* Effect.fail(callPhaseError(callExits, options.agencyId, "departure calls"));
    }

    // Every call is attributed to the GTFS stop that produced it, never to
    // Tmix's internal `stopPointId`, which is a different id space.
    const isRouteAllowed = (call: TmixCall, feed: TmixAnyRideFeed): boolean => {
      const allowedLineIds =
        options.allowedLineIds ?? (feed.lineIds?.length ? new Set(feed.lineIds) : undefined);
      if (allowedLineIds && ![...allowedLineIds].some((lineId) => call.line === lineId)) {
        return false;
      }
      const requestedRoutes = options.fetchOptions?.routeIds;
      return (
        !requestedRoutes ||
        [...requestedRoutes].some((routeId) => routeIdsMatch(call.line, routeId))
      );
    };

    const arrivals = callResults.flatMap(({ feed, stopId, result }) => {
      const allowedLineIds =
        options.allowedLineIds ?? (feed.lineIds?.length ? new Set(feed.lineIds) : undefined);
      return result.usable.flatMap((response) =>
        tmixCallsToArrivals(response.calls, {
          stopId,
          operatorPrefix: feed.operatorPrefix,
          allowedLineIds,
          allowedRouteIds: options.fetchOptions?.routeIds,
          project: options.project,
        }),
      );
    });

    let vehicles: readonly LiveVehiclePosition[] = [];
    let vehiclesAvailable = !options.includeVehicles;

    if (options.includeVehicles) {
      // Soonest departures first within each feed: a call id belongs to the
      // tenant/profile that returned it, even when another endpoint declares
      // the same operator prefix. Feed identity must travel with the call all
      // the way through position lookup and duplicate-fix handling.
      const locatedByFeed = new Map<TmixAnyRideFeed, Map<string, TmixCall>>(
        feeds.map((feed) => [feed, new Map()]),
      );
      for (const { feed, result } of callResults) {
        const callsById = locatedByFeed.get(feed);
        if (!callsById) continue;
        for (const response of result.usable) {
          for (const call of response.calls) {
            if (
              isTmixOperatorInScope(String(call.lineId), feed.operatorPrefix) &&
              isRouteAllowed(call, feed)
            ) {
              callsById.set(call.id, call);
            }
          }
        }
      }
      const locatedByDeparture = (calls: Iterable<TmixCall>) =>
        [...calls].sort(
          (a, b) =>
            (a.forecastTime ?? a.plannedTime ?? Number.MAX_SAFE_INTEGER) -
            (b.forecastTime ?? b.plannedTime ?? Number.MAX_SAFE_INTEGER),
        );
      const locatedCount = [...locatedByFeed.values()].reduce(
        (total, calls) => total + calls.size,
        0,
      );
      const budgeted = feeds.flatMap((feed) =>
        locatedByDeparture(locatedByFeed.get(feed)?.values() ?? [])
          .slice(0, work.vehicleAllowance)
          .map((call) => ({ feed, call })),
      );
      // A truncated refresh is a partial map, which looks identical to a quiet
      // network. Say so in the log rather than leaving a rider staring at an
      // incomplete fleet with no signal that anything was dropped.
      if (locatedCount > budgeted.length) {
        partial = true;
        logger.warn(
          `Tmix AnyRide vehicle budget reached for ${options.agencyId}: ` +
            `showing ${budgeted.length} of ${locatedCount} locatable vehicles ` +
            `(${work.vehicleAllowance} of ${TMIX_MAX_SUBREQUESTS} subrequests allocated)`,
          { agencyId: options.agencyId, shown: budgeted.length, located: locatedCount },
        );
      }

      const positionExits = yield* Effect.all(
        budgeted.map(({ feed, call }) =>
          fetchOneVehiclePosition(feed, call.id, options).pipe(
            Effect.map((result) => ({ feed, call, result })),
            Effect.exit,
          ),
        ),
        { concurrency: TMIX_VEHICLE_POSITION_CONCURRENCY },
      );

      const resolved = positionExits.flatMap((exit) => {
        if (!Exit.isSuccess(exit)) return [];
        return exit.value.result.usable.flatMap((position) =>
          position ? [{ feed: exit.value.feed, call: exit.value.call, position }] : [],
        );
      });
      vehicles = feeds.flatMap((feed) => {
        const feedPositions = resolved.filter((entry) => entry.feed === feed);
        return tmixPositionsToVehicles(feedPositions, {
          project: options.projectVehicle,
          duplicateVehicleFixes:
            feed.duplicateVehicleFixes === "collapse-by-fix" ? "collapse-by-fix" : undefined,
        });
      });

      // A position request that reached the vendor decodes to a value that may
      // legitimately be `undefined` (the `null` body for an unknown call), so
      // "reached it" is a non-empty `usable` list here, exactly as above. A
      // `null` body is the vendor answering "no such call" and keeps
      // availability true; nothing at all getting through means the phase broke,
      // and an empty map from a broken phase is the false green this guards.
      const reached = positionExits.filter(
        (exit) => Exit.isSuccess(exit) && exit.value.result.usable.length > 0,
      );
      if (reached.length < positionExits.length) partial = true;
      if (positionExits.length > 0 && reached.length === 0) {
        return yield* Effect.fail(
          callPhaseError(positionExits, options.agencyId, "vehicle positions"),
        );
      }
      vehiclesAvailable = true;
    }

    return {
      arrivals,
      vehicles,
      ...(partial ? { partial: true as const } : {}),
      // An empty `calls: []` is a correct empty board (outside service hours),
      // not a feed failure, so availability tracks whether the phase was
      // requested and reachable.
      arrivalsAvailable: options.includeArrivals && callResults.length > 0,
      vehiclesAvailable,
    };
  });
}
