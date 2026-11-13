import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { parseWallClock } from "./wallClock";
import type { DecodedFeed, GenericAlert } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const MONTHS = [
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
const MONTH = "([A-Za-z]{3,9})\\.?";
const SEGMENT = new RegExp(
  `^${MONTH}\\s+(\\d{1,2})(?:,\\s*(\\d{4}))?(?:\\s*[-–]\\s*(?:${MONTH}\\s+)?(\\d{1,2})(?:,\\s*(\\d{4}))?)?$`,
  "u",
);

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function descendants(node: Node, found: Element[] = []): Element[] {
  if ("childNodes" in node)
    for (const child of node.childNodes) {
      if (isElement(child)) found.push(child);
      descendants(child, found);
    }
  return found;
}

const hasClass = (node: Element, name: string) =>
  (node.attrs.find((attr) => attr.name === "class")?.value ?? "").split(/\s+/u).includes(name);
const attr = (node: Element, name: string) =>
  node.attrs.find((entry) => entry.name === name)?.value.trim() || undefined;
const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
const byClass = (node: Node, name: string) =>
  descendants(node).filter((element) => hasClass(element, name));

function month(name: string): number {
  const lower = name.toLowerCase();
  const index = MONTHS.findIndex((candidate) => candidate.startsWith(lower) && lower.length >= 3);
  if (index < 0) throw new Error(`Unknown month: ${name}`);
  return index + 1;
}

/** Local midnight of a calendar day; `dayAfter` turns a last day into an exclusive end. */
function midnight(
  year: number,
  monthNumber: number,
  day: number,
  timeZone: string,
  dayAfter = false,
) {
  const stated = new Date(Date.UTC(year, monthNumber - 1, day));
  if (stated.getUTCMonth() !== monthNumber - 1 || stated.getUTCDate() !== day)
    throw new Error(`Invalid advisory date: ${year}-${monthNumber}-${day}`);
  const date = new Date(Date.UTC(year, monthNumber - 1, day + (dayAfter ? 1 : 0)));
  const pad = (value: number) => String(value).padStart(2, "0");
  return parseWallClock(
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} 00:00:00`,
    timeZone,
  );
}

type Window = { readonly startsAt: number; readonly endsAt?: number };

/** Ranges include their last day; a missing year comes from the last segment's. */
export function advisoryWindows(caption: string, timeZone: string): readonly Window[] {
  const text = caption
    .replace(/\s+/gu, " ")
    .trim()
    .replace(/^Effective\s*/iu, "");
  if (!text || /^immediately\.?$/iu.test(text)) return [{ startsAt: 0 }];
  const segments = text.split(/\s+and\s+/iu).map((segment) => {
    const match = SEGMENT.exec(segment.trim());
    if (!match) throw new Error(`Unreadable advisory period: ${caption}`);
    return match;
  });
  const lastYear = (() => {
    const last = segments.at(-1)!;
    return Number(last[6] ?? last[3]) || undefined;
  })();
  return segments.map(([, startMonth, startDay, startYear, endMonth, endDay, endYear]) => {
    const firstMonth = month(startMonth!);
    const lastMonth = endMonth ? month(endMonth) : firstMonth;
    const closing = Number(endYear ?? (endDay ? undefined : startYear)) || lastYear;
    if (!closing) throw new Error(`Advisory period has no year: ${caption}`);
    const opening = Number(startYear) || (endDay && firstMonth > lastMonth ? closing - 1 : closing);
    const startsAt = midnight(opening, firstMonth, Number(startDay), timeZone);
    if (!endDay) return { startsAt };
    const endsAt = midnight(closing, lastMonth, Number(endDay), timeZone, true);
    if (endsAt <= startsAt) throw new Error(`Advisory period ends before it starts: ${caption}`);
    return { startsAt, endsAt };
  });
}

interface Advisory {
  readonly title: string;
  readonly href?: string;
  readonly caption?: string;
  readonly routeNames: readonly string[];
  readonly stationCode?: string;
}

/** An unmapped route or unreadable period marks the read partial so it never clears a route. */
export function decodeRouteStationAdvisories(
  html: string,
  source: string,
  now: number,
  timeZone: string,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
): DecodedFeed {
  const document = parse(html);
  const advisories: Advisory[] = [];
  const routeOptions = byClass(document, "na-service-alert__option");
  const stationItems = byClass(document, "na-service-alert__stations_ul_li");
  for (const option of routeOptions) {
    const tooltip = byClass(option, "tooltip__text_content").map(plain).filter(Boolean);
    const heading = descendants(option).find((node) => /^h[2-6]$/u.test(node.tagName));
    const names = tooltip.length ? tooltip : heading && plain(heading) ? [plain(heading)] : [];
    if (!names.length) throw new Error("Route advisory has no route");
    const blocks = byClass(option, "na-service-alert__option_block");
    if (!blocks.length) throw new Error("Route advisory has no notice");
    for (const block of blocks) {
      const link = byClass(block, "na-service-alert__option_title")[0];
      const date = byClass(block, "na-service-alert__option_date")[0];
      if (!link || !plain(link)) throw new Error("Route advisory has no title");
      advisories.push({
        title: plain(link),
        href: attr(link, "data-href") ?? attr(link, "href"),
        caption: date ? plain(date) : undefined,
        routeNames: names,
      });
    }
  }
  for (const item of stationItems) {
    const header = byClass(item, "na-service-alert__stations_ul_li_header")[0];
    const code = header ? /\(([A-Z0-9]{2,5})\)\s*$/u.exec(plain(header))?.[1] : undefined;
    if (!code) throw new Error("Station advisory has no station code");
    const notices = byClass(item, "na-service-alert__stations_ul_li_details_alert");
    if (!notices.length) throw new Error(`Station advisory ${code} has no notice`);
    for (const notice of notices) {
      const link = byClass(notice, "na-service-alert__stations_ul_li_details_alert_link")[0];
      const date = byClass(notice, "na-service-alert__stations_ul_li_details_alert_date")[0];
      if (!link || !plain(link)) throw new Error(`Station advisory ${code} has no title`);
      advisories.push({
        title: plain(link),
        href: attr(link, "data-href") ?? attr(link, "href"),
        caption: date ? plain(date) : undefined,
        routeNames: [],
        stationCode: code,
      });
    }
  }
  if (!advisories.length) throw new Error("No recognizable advisories; recovery is unconfirmed");

  let partial = false;
  const alerts: GenericAlert[] = [];
  for (const advisory of advisories) {
    const routeIds = new Set<string>();
    let unmapped = false;
    for (const name of advisory.routeNames) {
      const lower = name.toLowerCase();
      const ids = Object.entries(routeNames)
        .filter(([, aliases]) => aliases.some((alias) => alias.toLowerCase() === lower))
        .map(([id]) => id);
      if (!ids.length) unmapped = true;
      for (const id of ids) routeIds.add(id);
    }
    if (unmapped) {
      partial = true;
      continue;
    }
    let windows: readonly Window[];
    try {
      windows = advisoryWindows(advisory.caption ?? "", timeZone);
    } catch {
      partial = true;
      windows = [{ startsAt: 0 }];
    }
    const url = advisory.href ? new URL(advisory.href, source).href : undefined;
    const description = [advisory.caption, url && `[Advisory details](${url})`]
      .filter(Boolean)
      .join("\n");
    const id = url ?? `${source}#${advisory.stationCode ?? ""}${advisory.title}`;
    for (const window of windows)
      alerts.push({
        id: windows.length > 1 ? `${id}#${window.startsAt}` : id,
        title: advisory.title,
        description,
        startsAt: window.startsAt,
        ...(window.endsAt === undefined ? {} : { endsAt: window.endsAt }),
        routeIds: [...routeIds].sort(),
        ...(advisory.stationCode
          ? {
              affectedStations: [advisory.stationCode],
              targets: [{ stopId: advisory.stationCode }],
            }
          : {}),
        updatedAt: now,
      });
  }
  return {
    header: { version: "route-station-advisories", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
    ...(partial ? { partial: true } : {}),
  };
}
