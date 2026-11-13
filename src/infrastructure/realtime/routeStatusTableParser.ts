import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import type { DecodedFeed, GenericAlert } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** Any one-word qualifier clears, so a misspelt "No anticipated disruptions" still reads clear. */
const CLEAR_STATUS = [
  /^no (?:[a-z-]+ )?(?:disruptions?|detours|closures|service changes)$/u,
  /^all stops are (?:currently )?open$/u,
  /^(?:normal|regular) service$/u,
];
const ALL_ROUTES = /^all routes$/iu;

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function elements(node: Node, tagName: string, found: Element[] = []): Element[] {
  if (isElement(node) && node.tagName === tagName) found.push(node);
  if ("childNodes" in node) for (const child of node.childNodes) elements(child, tagName, found);
  return found;
}

function plainText(node: Node): string {
  return stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
}

function isClear(status: string): boolean {
  const normalized = status
    .toLowerCase()
    .replace(/[.!]+$/u, "")
    .trim();
  return CLEAR_STATUS.some((pattern) => pattern.test(normalized));
}

/** An unmapped notice row marks the read partial, so an unread route never looks clear. */
export function decodeRouteStatusTable(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
): DecodedFeed {
  const tables = elements(parse(html), "table")
    .map((table) =>
      elements(table, "tr").map((row) =>
        row.childNodes
          .filter((cell): cell is Element => isElement(cell) && ["td", "th"].includes(cell.tagName))
          .map(plainText),
      ),
    )
    .filter(
      ([header]) => header !== undefined && header.length >= 2 && /^routes?$/iu.test(header[0]!),
    );
  if (tables.length === 0) throw new Error("Missing route status table");
  const notices = new Map<string, GenericAlert>();
  let partial = false;
  for (const [header, ...rows] of tables) {
    for (const [label = "", status = ""] of rows) {
      if (!label && !status) continue;
      if (!label || !status) throw new Error("Incomplete route status row");
      if (isClear(status)) continue;
      const lower = label.toLowerCase();
      const systemwide = ALL_ROUTES.test(label);
      const routeIds = systemwide
        ? []
        : Object.entries(routeNames)
            .filter(([, aliases]) => aliases.some((alias) => alias.toLowerCase() === lower))
            .map(([routeId]) => routeId)
            .sort();
      if (!systemwide && routeIds.length === 0) {
        partial = true;
        continue;
      }
      const id = `${source}#${label}`;
      const prior = notices.get(id);
      notices.set(id, {
        id,
        title: prior?.title ?? (systemwide ? label : `${header![0]} ${label}`),
        description: prior ? `${prior.description}\n${status}` : status,
        startsAt: 0,
        routeIds,
        updatedAt: now,
      });
    }
  }
  return {
    header: { version: "route-status-table", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [...notices.values()],
    ...(partial ? { partial: true } : {}),
  };
}
