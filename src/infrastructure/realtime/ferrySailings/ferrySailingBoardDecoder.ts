import * as Schema from "effect/Schema";
import type { FerrySailingLegIndex } from "~/agencies/types";
import { parseWallClock } from "../wallClock";

const NullableString = Schema.optional(Schema.Union([Schema.String, Schema.Null]));
const SailingSchema = Schema.Struct({
  dept: Schema.String,
  dest: Schema.String,
  scheduledDeparture: Schema.String,
  actualDepartureTs: NullableString,
  status: NullableString,
  departureStatus: NullableString,
  delayComments: NullableString,
});
const BoardSchema = Schema.Struct({
  arrivalDepartures: Schema.Record(Schema.String, Schema.Array(SailingSchema)),
  cams: Schema.optional(Schema.Union([Schema.Record(Schema.String, Schema.Unknown), Schema.Null])),
});

/** One not-yet-departed sailing from a terminal board. */
export interface FerrySailing {
  readonly sailingId: string;
  readonly stopId: string;
  readonly routeId: string;
  readonly directionId: 0 | 1;
  readonly headsign: string;
  /** Scheduled departure; the board publishes no prediction before a sailing leaves. */
  readonly scheduledTime: number;
  /** Operator rider text such as a delay reason, omitted when it says nothing new. */
  readonly status?: string;
}

export interface FerrySailingBoardOptions {
  readonly terminal: string;
  readonly board: string;
  /** The board's GTFS route; the operator names the route, the static feed may lag. */
  readonly routeId: string;
  readonly terminals: Readonly<Record<string, string>>;
  readonly legs: FerrySailingLegIndex;
  readonly terminalNames: Readonly<Record<string, string>>;
  readonly timeZone: string;
}

const ROUTINE_STATUS = /^(on time|in port|scheduled)\.?$/i;

/** Decodes one terminal board; a board the operator no longer recognizes fails instead of reading empty. */
export function decodeFerrySailingBoard(
  bytes: Uint8Array,
  options: FerrySailingBoardOptions,
): readonly FerrySailing[] {
  const document = Schema.decodeUnknownSync(BoardSchema)(
    JSON.parse(new TextDecoder().decode(bytes)),
  );
  const sailings = document.arrivalDepartures[options.board];
  if (!sailings?.length && !document.cams?.[options.board])
    throw new Error(`Sailing board ${options.terminal}/${options.board} is not recognized`);
  const decoded: FerrySailing[] = [];
  for (const sailing of sailings ?? []) {
    const stopId = options.terminals[sailing.dept];
    if (!stopId) throw new Error(`Sailing terminal ${sailing.dept} is not declared`);
    const headsign = options.terminalNames[sailing.dest];
    if (!headsign) throw new Error(`Sailing terminal ${sailing.dest} is not declared`);
    // A pair the static feed lacks keeps the board's route; its direction is unstated.
    const leg = options.legs[`${sailing.dept}>${sailing.dest}`];
    const scheduledTime = parseWallClock(sailing.scheduledDeparture, options.timeZone);
    if (sailing.actualDepartureTs) continue;
    const status = (sailing.departureStatus ?? sailing.delayComments ?? "").trim();
    if (/cancel/i.test(status)) continue;
    decoded.push({
      sailingId: `${sailing.dept}>${sailing.dest}@${sailing.scheduledDeparture}`,
      stopId,
      routeId: options.routeId,
      directionId: leg?.routeId === options.routeId ? leg.directionId : 0,
      headsign,
      scheduledTime,
      ...(status && !ROUTINE_STATUS.test(status) ? { status } : {}),
    });
  }
  return decoded;
}
