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
function day(value: string, zone: string, after = false): number {
  const match = /^([A-Za-z]{3,9})\s+(\d{1,2}),\s*(\d{4})$/u.exec(value);
  if (!match) throw new Error("Unreadable closure date");
  const fullMonths = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const word = match[1].toLowerCase();
  const month = fullMonths.indexOf(word) >= 0 ? fullMonths.indexOf(word) : MONTHS.indexOf(word);
  const date = new Date(Date.UTC(Number(match[3]), month, Number(match[2])));
  if (month < 0 || date.getUTCMonth() !== month || date.getUTCDate() !== Number(match[2]))
    throw new Error("Invalid closure date");
  if (after) date.setUTCDate(date.getUTCDate() + 1);
  return parseWallClock(`${date.toISOString().slice(0, 10)} 00:00:00`, zone);
}
/** Keeps closures at their named stops; replacement stops are instructions, not affected targets. */
export function decodeStopClosureTable(
  html: string,
  source: string,
  now: number,
  timeZone: string,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
): DecodedFeed {
  const expected = ["Route", "Closed Stop", "Alternate Stop", "Start Date", "End Date"];
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
    .filter(
      ([header]) => header?.length === 5 && header.every((text, index) => text === expected[index]),
    );
  if (tables.length !== 1 || tables[0].length < 2) throw new Error("Missing stop closure table");
  const alerts: GenericAlert[] = [];
  for (const row of tables[0].slice(1)) {
    if (row.length !== 5 || row.some((cell) => !cell))
      throw new Error("Incomplete stop closure row");
    const [label, closed, alternate, start, end] = row;
    const code = /\bStop\s*#?\s*(\d+)\b/iu.exec(closed)?.[1];
    if (!code) throw new Error("Missing closed stop code");
    const labels = label.split(/\s*(?:,|\band\b)\s*/iu).map((text) => text.toLowerCase());
    const routeIds = Object.entries(routeNames)
      .filter(([, aliases]) => aliases.some((alias) => labels.includes(alias.toLowerCase())))
      .map(([id]) => id)
      .sort();
    const startsAt = day(start, timeZone),
      endsAt = /^(?:Until further notice|Permanent Closure)$/iu.test(end)
        ? undefined
        : day(end, timeZone, true);
    if (endsAt !== undefined && endsAt <= startsAt) throw new Error("Reversed closure dates");
    const stop = `Stop ${code}`;
    alerts.push({
      id: `${source}#${label}-${code}`,
      title: `${stop} closed`,
      description: `Closed stop: ${closed}\nAlternate stop: ${alternate}`,
      startsAt,
      ...(endsAt === undefined ? {} : { endsAt }),
      routeIds,
      affectedStations: [stop],
      targets: routeIds.length
        ? routeIds.map((routeId) => ({ routeId, stopId: stop, stopCode: code }))
        : [{ stopId: stop, stopCode: code }],
      stopScoped: true,
      effect: "NO_SERVICE",
      updatedAt: now,
    });
  }
  return {
    header: { version: "stop-closure-table", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}
