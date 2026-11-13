import { isTmixOperatorInScope } from "./tmixTransport";
import type { DecodedFeed, GenericAlert } from "../gtfsRealtimeDecoder";
import type { TmixStopResponse } from "./tmixCallsDecoder";

/**
 * AnyRide message alerts.
 *
 * AnyRide has no messages endpoint. A `GetCalls` response carries a
 * `messages` array next to its calls, so a message is only observable at the
 * stops polled, and nothing on the wire dates it: no stop, route, start, end or
 * expiry. These rules follow from that, and the alert-feed daemon implements the
 * same ones in `services/alert-feed-daemon/src/parsers/anyride_messages.rs`.
 * Both read `tests/fixtures/realtime/tmix/messages.contract.json`.
 *
 * - **Identity.** One alert per message `id`, however many stops return it.
 *   The first sighting keeps the text, priority and `isInfo`; `isDisturbance`
 *   is true if any sighting says so. Text is never edited.
 * - **Lifecycle.** An alert is active while its id keeps appearing, and ends
 *   when a successful poll of its stops stops returning it. The source has no
 *   event time, so `startsAt` stays unknown (`0`) and there is no `endsAt`.
 * - **Stop scope.** The GTFS stop id that was queried, never the internal
 *   `stopPointId`. Nothing is ever widened to all stops.
 * - **Route attribution.** Per sighting, the lines of the calls named by
 *   `affectedCalls` that are in the operator's scope; when none resolve, the
 *   routes the queried stop is declared to serve. `affectedCalls` is
 *   unreliable for direction, so it is never read for one.
 * - **Completeness.** A stop that failed, answered with no content, or was left
 *   unpolled by the budget makes the whole read incomplete. An incomplete read
 *   is never an all-clear: the feed is marked `partial`, which surfaces as a
 *   stale source.
 */

/** One representative stop and the routes the manifest declares it serves. */
export interface TmixMessageStop {
  readonly stopId: string;
  readonly routeIds: readonly string[];
}

/** One stop's decoded poll, in the order the stops are declared. */
interface TmixPolledStop {
  readonly stop: TmixMessageStop;
  readonly response: TmixStopResponse;
}

interface MessageSighting {
  id: string;
  text: string;
  priority: number | undefined;
  isDisturbance: boolean;
  isInfo: boolean;
  targets: { routeId: string; stopId: string }[];
}

/** Code-unit order, which is also byte order for the ASCII ids the wire uses. */
function compareText(first: string, second: string): number {
  return first < second ? -1 : first > second ? 1 : 0;
}

function sightingRoutes(
  stop: TmixMessageStop,
  response: TmixStopResponse,
  affectedCalls: readonly string[],
  operatorPrefix: string,
): readonly string[] {
  const named = new Set(affectedCalls);
  const fromCalls = response.calls.filter(
    (call) =>
      call.key !== undefined &&
      named.has(call.key) &&
      isTmixOperatorInScope(String(call.lineId), operatorPrefix),
  );
  const routes = fromCalls.length > 0 ? fromCalls.map((call) => call.line) : stop.routeIds;
  return [...new Set(routes)].sort(compareText);
}

/** Folds read stops into one alert per message id, in first-sighting order. */
function foldMessages(polls: readonly TmixPolledStop[], operatorPrefix: string): GenericAlert[] {
  const byId = new Map<string, MessageSighting>();
  for (const { stop, response } of polls) {
    for (const message of response.messages) {
      let alert = byId.get(message.id);
      if (!alert) {
        alert = {
          id: message.id,
          text: message.text,
          priority: message.priority,
          isDisturbance: false,
          isInfo: message.isInfo,
          targets: [],
        };
        byId.set(message.id, alert);
      }
      alert.isDisturbance = alert.isDisturbance || message.isDisturbance;
      for (const routeId of sightingRoutes(stop, response, message.affectedCalls, operatorPrefix)) {
        const seen = alert.targets.some(
          (target) => target.routeId === routeId && target.stopId === stop.stopId,
        );
        if (!seen) alert.targets.push({ routeId, stopId: stop.stopId });
      }
    }
  }
  return [...byId.values()].map((alert) => ({
    id: alert.id,
    // The wire publishes no headline, so the verbatim text is the headline.
    title: alert.text,
    startsAt: 0,
    updatedAt: 0,
    ...(alert.targets.length > 0
      ? {
          routeIds: [...new Set(alert.targets.map((target) => target.routeId))],
          targets: alert.targets,
        }
      : {}),
    sourceFields: {
      isDisturbance: alert.isDisturbance,
      isInfo: alert.isInfo,
      ...(alert.priority === undefined ? {} : { priority: alert.priority }),
    },
  }));
}

export interface TmixMessageFeedOptions {
  readonly operatorPrefix: string;
  readonly now: number;
}

/**
 * The decoded alert feed for one read of the declared stops, or `undefined`
 * when no stop could be read at all, which is a failed source and not an empty
 * one.
 *
 * `outcomes` is aligned with `declared`. An entry is a stop's decoded poll, or
 * `undefined` when the poll failed. An outcomes list shorter than `declared`
 * means the budget left the trailing stops unpolled. A zero-byte answer means
 * the vendor did not recognise the stop, so it observed nothing there and the
 * stop is not read. Pure: the adapter polls, and this decides what was read.
 */
export function buildTmixMessageFeed(
  declared: readonly TmixMessageStop[],
  outcomes: readonly (TmixStopResponse | undefined)[],
  options: TmixMessageFeedOptions,
): DecodedFeed | undefined {
  const read = declared.flatMap((stop, index): TmixPolledStop[] => {
    const response = outcomes[index];
    return response !== undefined && response.noContent !== true ? [{ stop, response }] : [];
  });
  if (read.length === 0) return undefined;
  const complete = read.length === declared.length;
  return {
    header: { version: "anyride-messages", timestamp: options.now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: foldMessages(read, options.operatorPrefix).map((alert) => ({
      ...alert,
      startsAt: 0,
      updatedAt: options.now,
    })),
    ...(complete ? {} : { partial: true }),
  };
}
