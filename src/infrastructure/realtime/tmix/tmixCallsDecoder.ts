import type { TmixDuplicateVehicleFixes } from "~/agencies/types";
import { collapseByKey, compareVehicleIds } from "~/domain/surface/collapseDuplicateFixes";
import type { ArrivalPrediction, LiveVehiclePosition } from "~/domain/surface/types";
import { routeIdsMatch } from "~/domain/surface/routeIds";
import { isTmixOperatorInScope } from "./tmixTransport";

/**
 * Tmix AnyRide wire → domain decoding.
 *
 * Two endpoints reach this module, verified against live wire captures
 * (see `docs/research/tmix-anyride-wire-format.md`):
 *
 * - `POST GetCalls` → {@link parseTmixCalls}. `calls` is an array of GROUPS,
 *   each `{id, calls: [...]}`, so a one-level decoder silently drops every
 *   record. Groups are flattened one level here, and a `calls` array that
 *   already holds bare calls (no nested array) is accepted unchanged.
 * - `GET GetVehiclePosition?callId=…` → {@link parseTmixVehiclePosition}.
 *
 * Two wire facts drive the design and are stated here so no future reader
 * re-derives them by probing:
 *
 * 1. `lineId` is the ONLY operator-scoped identifier. AnyRide numbers each
 *    operator's lines in its own block (e.g. 6000004-6000081 for prefix 60),
 *    while `routeId` is a system-wide route number (e.g. 1003183-1004673) and
 *    `line` is a bare human label ("8", "9A"). Feeding `routeId` or `line` to
 *    {@link isTmixOperatorInScope} against operator prefix "60" drops 100% of
 *    its calls. `stopPointId` is likewise an internal Tmix stop-area id
 *    and never the GTFS stop id.
 * 2. Tmix publishes NO direction field anywhere. `directionId` is therefore
 *    never read from the wire: each seam injects its own inference via
 *    {@link TmixArrivalContext.project} / {@link TmixVehicleContext.project},
 *    because the realtime and stations seams have different evidence
 *    (vehicle bearing vs. schematic topology) and different vocabulary.
 *    Every arrival this module produces is marked
 *    {@link ArrivalPrediction.directionInferred}, so the display layer can
 *    prefer the agency's real headsign over a compass word this adapter made
 *    up. Without that mark a Tmix departure reads as a confident "Northbound"
 *    for a bus actually bound somewhere the feed never said.
 */

/** One departure call, flattened out of its `GetCalls` group. */
export interface TmixCall {
  /** Tmix call id. Unique per departure instance and doubles as the vehicle id. */
  readonly id: string;
  /**
   * Ordinal of the call inside its own response, the value a message's
   * `affectedCalls` names. It is only meaningful next to that response.
   */
  readonly key: string | undefined;
  /** Public line label; the provider's route map joins it to the canonical GTFS ID. */
  readonly line: string;
  /** Operator-scoped line id, a NUMBER on the wire (e.g. 6000007 for line 8). */
  readonly lineId: number;
  /** Terminal the trip is heading to; empty on some lines. */
  readonly destination: string;
  /** Position within the journey, 0 when Tmix does not track it. */
  readonly sequenceNumber: number;
  /** Epoch ms of the operator's live estimate, absent when only a plan exists. */
  readonly forecastTime: number | undefined;
  /** Epoch ms of the scheduled departure. */
  readonly plannedTime: number | undefined;
}

/**
 * A service message from the `messages` array of a `GetCalls` response.
 *
 * The wire carries no stop, route, start, end or expiry: a message is only
 * observable at the stops polled, and it is live for as long as its id keeps
 * appearing. `affectedCalls` holds call {@link TmixCall.key}s from the same
 * response and is unreliable for direction.
 */
export interface TmixMessage {
  /** Operator message id (`TX…`); stable across stops within a cycle. */
  readonly id: string;
  /** Verbatim operator text. */
  readonly text: string;
  readonly priority: number | undefined;
  /** True only when the wire says so; the web app colours its icon by it. */
  readonly isDisturbance: boolean;
  readonly isInfo: boolean;
  readonly affectedCalls: readonly string[];
}

/** One decoded `GetCalls` response. */
export interface TmixStopResponse {
  readonly calls: readonly TmixCall[];
  readonly messages: readonly TmixMessage[];
  /** True only when the body has the AnyRide call/message envelope and every message is readable. */
  readonly alertEnvelopeValid: boolean;
  /**
   * True for the zero-byte answer the vendor gives an unknown stop. The stop
   * reported nothing, which is different from a stop that reported no messages.
   */
  readonly noContent?: true;
}

/** A single `GetVehiclePosition` record, already in epoch ms. */
export interface TmixVehiclePosition {
  readonly callId: string;
  readonly latitude: number;
  readonly longitude: number;
  /** Degrees clockwise from north. Absent on the wire for many vehicles. */
  readonly bearing: number | undefined;
  readonly timestamp: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function nonBlankString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * ISO 8601 with an explicit offset, straight to epoch ms.
 *
 * Departure timestamps carry explicit offsets (`-04:00`), and vehicle
 * positions carry `Z`. `Date.parse` resolves both to epoch **milliseconds**, so
 * any sub-second fractional digits are truncated to the ms the domain uses rather than
 * preserved. Anything the platform cannot parse becomes `undefined`, never
 * `NaN`.
 */
function parseTmixTimestamp(value: unknown): number | undefined {
  const text = nonBlankString(value);
  if (!text) return undefined;
  const epochMs = Date.parse(text);
  return Number.isFinite(epochMs) ? epochMs : undefined;
}

function parseTmixCall(value: unknown): TmixCall | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = nonBlankString(record.id);
  const line = nonBlankString(record.line);
  const lineId = finiteNumber(record.lineId);
  // Without `lineId` the record cannot be attributed to this operator, and
  // attributing it from `routeId` would be a guess that crosses tenants.
  if (!id || !line || lineId === undefined) return undefined;
  const departure = asRecord(record.departure);
  const quality = nonBlankString(departure?.quality)?.toLowerCase();
  const scheduled = quality !== undefined && quality !== "realtime";
  const forecastTime = parseTmixTimestamp(departure?.forecastTime);
  return {
    id,
    key: nonBlankString(record.key),
    line,
    lineId,
    destination: nonBlankString(record.destination) ?? "",
    sequenceNumber: finiteNumber(record.sequenceNumber) ?? 0,
    // Some scheduled calls repeat their timetable in forecastTime. An explicit
    // non-realtime quality takes precedence over the presence of that field.
    forecastTime: scheduled ? undefined : forecastTime,
    plannedTime:
      parseTmixTimestamp(departure?.plannedTime) ?? (scheduled ? forecastTime : undefined),
  };
}

function parseTmixMessage(value: unknown): TmixMessage | undefined {
  const record = asRecord(value);
  if (!record) return undefined;
  const id = nonBlankString(record.id);
  // Kept verbatim: only a message with no text at all is unreadable.
  const text = typeof record.text === "string" && record.text.trim() ? record.text : undefined;
  if (!id || text === undefined) return undefined;
  return {
    id,
    text,
    priority: finiteNumber(record.priority),
    isDisturbance: record.isDisturbance === true,
    isInfo: record.isInfo === true,
    affectedCalls: Array.isArray(record.affectedCalls)
      ? record.affectedCalls.flatMap((call) => {
          const key = typeof call === "number" ? String(call) : nonBlankString(call);
          return key === undefined ? [] : [key];
        })
      : [],
  };
}

/**
 * Decodes a `GetCalls` body into flat calls and its service messages.
 *
 * Zero bytes is a legitimate empty: an unknown stop area answers HTTP 204
 * with no body at all, and `response.ok` is true for 204, so the shared kernel
 * hands us an empty buffer rather than a JSON document. Treating that as a
 * parse error would turn "no such stop" into a panel-wide failure.
 */
export function parseTmixStopResponse(
  bytes: Uint8Array,
  options: { readonly strictAlertEnvelope?: boolean } = {},
): TmixStopResponse {
  if (bytes.byteLength === 0) {
    return { calls: [], messages: [], alertEnvelopeValid: false, noContent: true };
  }
  const payload = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
  const body = asRecord(payload);
  const hasAlertEnvelope = !!body && Array.isArray(body.calls) && Array.isArray(body.messages);
  if (options.strictAlertEnvelope && !hasAlertEnvelope) {
    throw new Error("AnyRide alert poll did not contain calls and messages arrays");
  }
  const calls: TmixCall[] = [];
  const groups = body?.calls;
  if (Array.isArray(groups)) {
    for (const group of groups) {
      // Wire shape: entries can be grouped `{id, calls: [...]}` or bare call objects.
      // If nested calls are present, extract them; otherwise treat the group entry itself as a call.
      const inner = Array.isArray(asRecord(group)?.calls)
        ? (group as { calls: unknown[] }).calls
        : [group];
      for (const entry of inner) {
        const call = parseTmixCall(entry);
        if (call) calls.push(call);
      }
    }
  }
  const messages: TmixMessage[] = [];
  let allMessagesReadable = true;
  if (Array.isArray(body?.messages)) {
    for (const message of body.messages) {
      const parsed = parseTmixMessage(message);
      if (!parsed) {
        allMessagesReadable = false;
        if (options.strictAlertEnvelope) {
          throw new Error("AnyRide alert poll contained an unreadable message entry");
        }
      } else {
        messages.push(parsed);
      }
    }
  }
  return { calls, messages, alertEnvelopeValid: hasAlertEnvelope && allMessagesReadable };
}

/** Decodes a `GetCalls` body into flat calls; see {@link parseTmixStopResponse}. */
export function parseTmixCalls(bytes: Uint8Array): readonly TmixCall[] {
  return parseTmixStopResponse(bytes).calls;
}

/**
 * Decodes a singular `GetVehiclePosition` body.
 *
 * Returns `undefined` for the two non-record answers the vendor gives: a
 * literal `null` body for a callId it does not know (HTTP 200), and an
 * unusable record. Neither is a feed failure — a call that has already
 * completed is simply no longer locatable.
 */
export function parseTmixVehiclePosition(bytes: Uint8Array): TmixVehiclePosition | undefined {
  if (bytes.byteLength === 0) return undefined;
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const record = asRecord(parsed);
  if (!record) return undefined;
  const location = asRecord(record.location);
  const latitude = finiteNumber(location?.lat);
  const longitude = finiteNumber(location?.lon);
  const timestamp = parseTmixTimestamp(record.timestamp);
  const callId = nonBlankString(record.id);
  if (!callId || latitude === undefined || longitude === undefined || timestamp === undefined) {
    return undefined;
  }
  return {
    callId,
    latitude,
    longitude,
    // `heading` is intermittently absent even on a moving vehicle. An absent
    // bearing stays absent: coercing it to 0 would claim "due north".
    bearing: finiteNumber(record.heading),
    timestamp,
  };
}

/** Seam-supplied direction for one call; Tmix never states a direction. */
export interface TmixCallProjection {
  readonly directionId: 0 | 1;
}

export interface TmixArrivalContext {
  /** GTFS stop id the query answered; predictions are keyed to it, not to Tmix's internal id. */
  readonly stopId: string;
  readonly operatorPrefix: string;
  readonly allowedLineIds?: ReadonlySet<string>;
  readonly allowedRouteIds?: ReadonlySet<string>;
  readonly project: (call: TmixCall, stopId: string) => TmixCallProjection;
}

/**
 * Projects flattened calls into the shared {@link ArrivalPrediction} shape.
 *
 * The trip id IS the call id: a call is one departure instance of one
 * vehicle, which is the same granularity `tripId` and `vehicleId` both mean
 * on every other feed. A call with neither a forecast nor a planned time is
 * dropped rather than rendered at the epoch.
 */
export function tmixCallsToArrivals(
  calls: readonly TmixCall[],
  context: TmixArrivalContext,
): readonly ArrivalPrediction[] {
  const arrivals: ArrivalPrediction[] = [];
  for (const call of calls) {
    if (!isTmixOperatorInScope(String(call.lineId), context.operatorPrefix)) continue;
    if (context.allowedLineIds && !context.allowedLineIds.has(call.line)) continue;
    if (
      context.allowedRouteIds &&
      ![...context.allowedRouteIds].some((routeId) => routeIdsMatch(call.line, routeId))
    ) {
      continue;
    }
    const predictedTime = call.forecastTime ?? call.plannedTime;
    if (predictedTime === undefined) continue;
    const { directionId } = context.project(call, context.stopId);
    const delaySeconds =
      call.forecastTime !== undefined && call.plannedTime !== undefined
        ? Math.round((call.forecastTime - call.plannedTime) / 1000)
        : 0;
    arrivals.push({
      tripId: call.id,
      routeId: call.line,
      directionId,
      vehicleId: call.id,
      stopSequence: call.sequenceNumber,
      stopId: context.stopId,
      predictedTime,
      delaySeconds,
      scheduleRelationship: "SCHEDULED",
      // A call carrying only a planned time is a schedule, not a live
      // estimate; claiming otherwise would render a static board as live.
      isRealtime: call.forecastTime !== undefined,
      ...(call.destination ? { headsign: call.destination } : {}),
      // Always true for this feed, and the whole point of stating it: the
      // operator published no direction, so `directionId` is our inference and
      // the display layer must prefer the real `headsign` over the compass
      // word that `directionId` would otherwise be rendered as.
      directionInferred: true,
      rawEntityId: `tmix:${context.stopId}|${directionId}`,
    });
  }
  return arrivals;
}

export interface TmixVehicleContext {
  readonly project: (call: TmixCall, position: TmixVehiclePosition) => 0 | 1;
  /** Reduce one physical bus reported through several calls to one fix. */
  readonly duplicateVehicleFixes?: TmixDuplicateVehicleFixes;
}

interface ResolvedTmixPosition {
  readonly call: TmixCall;
  readonly position: TmixVehiclePosition;
}

function departureOf(call: TmixCall): number {
  return call.forecastTime ?? call.plannedTime ?? Number.MAX_SAFE_INTEGER;
}

/** Two calls that name the same bus return a byte-identical fix. */
function fixSignature({ position }: ResolvedTmixPosition): string {
  return `${position.latitude}|${position.longitude}|${position.timestamp}`;
}

/** The earliest-departing call is the bus's current trip; ties go to the lowest call id. */
function isEarlierDeparting(candidate: ResolvedTmixPosition, kept: ResolvedTmixPosition): boolean {
  const difference = departureOf(candidate.call) - departureOf(kept.call);
  if (difference !== 0) return difference < 0;
  return compareVehicleIds(candidate.call.id, kept.call.id) < 0;
}

/**
 * Collapses calls whose fixes are identical in latitude, longitude and
 * timestamp. AnyRide names a bus through every call it is scheduled to serve,
 * so the vehicle already on its trip is also reported under its next trip,
 * which has not started and would render as a phantom bus. The earliest
 * departing call is kept, and surviving buses keep their first-seen order.
 * Only exactly equal coordinates and timestamps count: two nearby buses are
 * never merged.
 */
export function collapseTmixDuplicateFixes(
  resolved: readonly ResolvedTmixPosition[],
): ResolvedTmixPosition[] {
  return collapseByKey(resolved, fixSignature, isEarlierDeparting);
}

/**
 * Pairs resolved positions with the calls that named them.
 *
 * The position payload carries no route, line, or speed, so those have to come
 * from the originating call. A call that did not resolve is simply absent from
 * the map.
 */
export function tmixPositionsToVehicles(
  resolved: readonly ResolvedTmixPosition[],
  context: TmixVehicleContext,
): readonly LiveVehiclePosition[] {
  const located =
    context.duplicateVehicleFixes === "collapse-by-fix"
      ? collapseTmixDuplicateFixes(resolved)
      : resolved;
  return located.map(({ call, position }) => ({
    vehicleId: call.id,
    tripId: call.id,
    routeId: call.line,
    directionId: context.project(call, position),
    latitude: position.latitude,
    longitude: position.longitude,
    ...(position.bearing === undefined ? {} : { bearing: position.bearing }),
    timestamp: position.timestamp,
  }));
}
