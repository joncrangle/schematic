import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { parseWallClock } from "./wallClock";
import type { DecodedFeed, GenericAlert } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
function elements(node: Node, tag: string, found: Element[] = []): Element[] {
  if ("tagName" in node && node.tagName === tag) found.push(node);
  if ("childNodes" in node) for (const child of node.childNodes) elements(child, tag, found);
  return found;
}
const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();

function timestamp(text: string, field: string, timeZone: string): number {
  const match = new RegExp(
    `${field} Date:\\s*(\\d{1,2}) ([A-Za-z]{3}), (\\d{4})(?:\\s+Time:\\s*(\\d{1,2}):(\\d{2}) ([ap]m))?`,
    "iu",
  ).exec(text);
  if (!match) throw new Error(`Missing or unreadable ${field} date`);
  const [, day, month, year, hour, minute, meridiem] = match;
  if (hour === undefined && /^\s+Time:/iu.test(text.slice(match.index + match[0].length)))
    throw new Error("Unreadable disruption clock");
  const monthNumber = MONTHS.indexOf(month!.toLowerCase()) + 1;
  if (!monthNumber || (hour !== undefined && (Number(hour) < 1 || Number(hour) > 12)))
    throw new Error("Invalid disruption date");
  const clockHour =
    hour === undefined ? 0 : (Number(hour) % 12) + (meridiem!.toLowerCase() === "pm" ? 12 : 0);
  return parseWallClock(
    `${year}-${String(monthNumber).padStart(2, "0")}-${day!.padStart(2, "0")} ${String(clockHour).padStart(2, "0")}:${minute ?? "00"}:00`,
    timeZone,
  );
}

/** Reads labelled disruption rows; only the board's explicit empty sentence confirms recovery. */
export function decodeDisruptionDetailsTable(
  html: string,
  source: string,
  now: number,
  timeZone: string,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
): DecodedFeed {
  const tables = elements(parse(html), "table")
    .map((table) =>
      elements(table, "tr").map((row) =>
        row.childNodes
          .filter(
            (node): node is Element => "tagName" in node && ["td", "th"].includes(node.tagName),
          )
          .map(plain),
      ),
    )
    .filter(([header]) => header?.length === 1 && header[0] === "Disruption Details");
  if (tables.length !== 1 || tables[0]!.length < 2)
    throw new Error("Missing disruption details board");
  const rows = tables[0]!.slice(1);
  const clear = "There are no active transit disruptions.";
  const alerts: GenericAlert[] = [];
  for (const cells of rows) {
    const text = cells[0];
    if (cells.length !== 1 || !text) throw new Error("Incomplete disruption row");
    if (text === clear) {
      if (rows.length !== 1) throw new Error("Conflicting disruption board");
      continue;
    }
    const startsAt = timestamp(text, "Start", timeZone);
    const endsAt = /Unknown end time/iu.test(text) ? undefined : timestamp(text, "End", timeZone);
    if (endsAt !== undefined && endsAt < startsAt) throw new Error("Reversed disruption period");
    const route = /^(Routes?\s+[^.]*?)(?=\s+(?:Bus|Cancellation|Detour|Stop|Service)\b)/iu.exec(
      text,
    )?.[1];
    const routeIds = Object.entries(routeNames)
      .filter(([, aliases]) =>
        aliases.some((alias) => alias.toLowerCase() === route?.toLowerCase()),
      )
      .map(([id]) => id)
      .sort();
    const stops = /Stops affected are\s+([\d\s,and]+)[.;]/iu.exec(text)?.[1];
    const stationIds = [...new Set(stops?.match(/\d+/gu) ?? [])].sort();
    alerts.push({
      id: `${source}#${text}`,
      title: text,
      startsAt,
      ...(endsAt === undefined ? {} : { endsAt }),
      routeIds,
      ...(stationIds.length
        ? { affectedStations: stationIds, targets: stationIds.map((stopId) => ({ stopId })) }
        : {}),
      updatedAt: now,
    });
  }
  return {
    header: { version: "disruption-details-table", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}
