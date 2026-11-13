import type { AnyRideProfile, RealtimeFeedConfig } from "~/agencies/types";
import type { DecodedFeedRequest } from "../fetchDecodedFeeds";

/**
 * Tmix AnyRide wire contract: the endpoints Core reads, their request bodies,
 * and the multi-tenant operator filter.
 *
 * AnyRide is a multi-tenant platform hosting several Ontario municipalities
 * on one instance, so a declared feed is only usable together with its
 * operator prefix (see {@link isTmixOperatorInScope}).
 *
 * ## The bulk position endpoint is not part of this contract
 *
 * AnyRide offers `GET GetVehiclePositions?data={}`, but it is
 * administratively disabled on this tenant: it answers HTTP 200 with a literal
 * `[]` under every parameter shape, and `GetConfigOptions?profile=AnyRide`
 * reports `"showVehicleLocations": false`. An always-empty feed is
 * indistinguishable downstream from a healthy one with no vehicles on the road,
 * so there is deliberately **no URL builder and no request descriptor for it
 * here** — wiring one would convert a loud feed failure into a silent
 * false-green "no buses running", which rule G7 forbids. The finding itself
 * lives in `docs/research/tmix-anyride-wire-format.md` §4, where an
 * unobserved vendor fact belongs.
 *
 * Live positions are read one call at a time from
 * {@link tmixVehiclePositionRequest}, driven by the call ids `GetCalls` returns.
 *
 * Wire decoding lives in `./tmixCallsDecoder`; this module stays transport-only
 * so request shaping and payload semantics are read in separate places.
 */

/**
 * Request headers a tenant's profile declares. The tenant's web app copies
 * `profileData` and `profileDisplay` from `GetConfigOptions` into these
 * headers. The data header changes which departures a stop returns and an
 * unknown value is HTTP 500; the display header alone changes nothing.
 */
export function tmixProfileHeaders(profile: AnyRideProfile | undefined): Record<string, string> {
  if (!profile) return {};
  return {
    "anyride-profile-data": profile.data,
    ...(profile.display === undefined ? {} : { "anyride-profile-display": profile.display }),
  };
}

const VEHICLE_POSITION_PATH = "/GetVehiclePosition";
const STOP_CALLS_PATH = "/GetCalls";

/** A manifest feed declared as `kind: "tmix_anyride"`. */
export type TmixAnyRideFeed = Extract<RealtimeFeedConfig, { kind: "tmix_anyride" }>;

/** Joins a declared base API URL with an AnyRide endpoint path. */
function tmixEndpoint(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

/** `POST {baseUrl}/GetCalls` — the per-stop-area departure query. */
export function tmixStopCallsUrl(baseUrl: string): string {
  return tmixEndpoint(baseUrl, STOP_CALLS_PATH);
}

/**
 * Ungrouped departure forecast query for one GTFS stop area id.
 *
 * `grouping: []` yields one group per call. The numeric selector was rejected
 * by the observed AnyRide profile with HTTP 500.
 */
export function tmixStopCallsBody(stopId: string): string {
  return JSON.stringify({
    query: { fromStopAreaQuery: stopId },
    configuration: { grouping: [] },
  });
}

/**
 * `GET {baseUrl}/GetVehiclePosition?callId=…` — one vehicle's live position.
 *
 * This is the only position path with records. The singular one is populated
 * and keyed by the call id that `GetCalls` hands out, which is what makes a
 * bounded per-call fan-out necessary rather than merely an optimization.
 */
export function tmixVehiclePositionUrl(baseUrl: string, callId: string): string {
  const url = new URL(tmixEndpoint(baseUrl, VEHICLE_POSITION_PATH));
  url.searchParams.set("callId", callId);
  return url.toString();
}

/**
 * Whether a record's operator id is in scope for the configured operator.
 *
 * AnyRide is multi-tenant, and a declared `operatorPrefix` is the scoping
 * mechanism: a record is in scope when its id begins with the configured
 * prefix.
 *
 * Two properties of that definition are worth stating plainly rather than
 * glossing:
 *
 * - It is fail-open by construction. A non-matching id is simply dropped, so
 *   the only mistake this can make is wrongly *including* a record — another
 *   municipality's vehicle appearing on this agency's map — never wrongly
 *   excluding one of our own.
 * - An id that merely *extends* the prefix (`601`, `608` against prefix `60`)
 *   counts as in scope. Whether that is a real collision depends on the id
 *   shapes other tenants actually publish, which is unverified until a
 *   populated capture shows a mixed-tenant payload. Until then, no per-tenant
 *   id is claimed to be dropped.
 *
 * ## Which id to pass (resolved by wire capture)
 *
 * The issue text frames the choice as "operator id vs. line id", as though the
 * wire carried both. It carries one operator-scoped field, `lineId`, on a
 * `GetCalls` call, and callers must pass exactly that:
 *
 * | field         | Tenant sample | carries the operator prefix? |
 * | ------------- | ------------- | ---------------------------- |
 * | `lineId`      | `6000007`     | **yes** — starts with `60`    |
 * | `routeId`     | `1004657`     | no — system-wide number      |
 * | `line`        | `"8"`         | no — bare human label        |
 * | `stopPointId` | `6000663`     | shares prefix format, but identifies a stop |
 *
 * `line` and `routeId` are tempting mistakes and both are silent: scoping
 * on them drops all calls for that operator prefix, which surfaces as an empty
 * board rather than an error. `stopPointId` shares the digit shape but identifies
 * a stop, so it is not a substitute either.
 */
export function isTmixOperatorInScope(id: string, operatorPrefix: string): boolean {
  return id.startsWith(operatorPrefix);
}

/** The decode pair a request descriptor needs; the decoder lives in `tmixCallsDecoder`. */
export type TmixDecoder<T, E> = Pick<DecodedFeedRequest<T, E>, "decode" | "mapError">;

/**
 * One vehicle's live position, keyed by the call id a `GetCalls` response
 * returned. This is the only position path that carries records on this
 * tenant; see the module doc for why the bulk endpoint is not used.
 */
export function tmixVehiclePositionRequest<T, E>(
  feed: TmixAnyRideFeed,
  callId: string,
  decoder: TmixDecoder<T, E>,
): DecodedFeedRequest<T, E> {
  return {
    url: tmixVehiclePositionUrl(feed.url, callId),
    auth: feed.auth,
    devProxyPrefix: feed.devProxyPrefix,
    format: feed.format,
    headers: tmixProfileHeaders(feed.profile),
    ...decoder,
  };
}

/** What a stop poll needs from its source: a declared feed or a message alert source. */
export type TmixStopCallsSource = Pick<TmixAnyRideFeed, "url" | "profile"> &
  Partial<Pick<TmixAnyRideFeed, "auth" | "devProxyPrefix" | "format">>;

/** Departure forecasts for one stop area. */
export function tmixStopCallsRequest<T, E>(
  feed: TmixStopCallsSource,
  stopId: string,
  decoder: TmixDecoder<T, E>,
): DecodedFeedRequest<T, E> {
  return {
    url: tmixStopCallsUrl(feed.url),
    method: "POST",
    body: tmixStopCallsBody(stopId),
    auth: feed.auth,
    devProxyPrefix: feed.devProxyPrefix,
    format: feed.format,
    headers: {
      "Content-Type": "application/json",
      ...tmixProfileHeaders(feed.profile),
    },
    ...decoder,
  };
}
