import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { publishedAdvisoryTimestamp } from "./ghdNewsServiceAdvisoriesParser";
import type { DecodedFeed } from "./gtfsRealtimeDecoder";

/** TransitMaster notices embedded in Drupal retain their explicit service clocks. */
export function transitNoticeBoard(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>>,
  timeZone: string,
): DecodedFeed | undefined {
  type Element = DefaultTreeAdapterTypes.Element;
  const elements: Element[] = [];
  function walk(node: DefaultTreeAdapterTypes.Node) {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(walk);
  }
  walk(parse(html));
  const hasClass = (node: Element, name: string) =>
    node.attrs.some((a) => a.name === "class" && a.value.split(/\s/u).includes(name));
  const rows = elements.filter((n) => hasClass(n, "paragraph--type--transit-service-notice"));
  if (!rows.length) return undefined;
  function timestamp(text: string) {
    const clock = /(\d{1,2}):(\d{2})\s*$/u.exec(text);
    const year = /\b(\d{4})\b/u.exec(text)?.[1];
    if (!clock || !year || Number(clock[1]) > 23 || Number(clock[2]) > 59)
      throw new Error("Invalid transit notice service time");
    const hour = Number(clock[1]);
    return publishedAdvisoryTimestamp(
      text.slice(0, clock.index),
      `${hour % 12 || 12}:${clock[2]} ${hour < 12 ? "am" : "pm"}`,
      Number(year),
      timeZone,
    );
  }
  return {
    header: { version: "transit-notice-board", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: rows.map((row) => {
      const descendants: Element[] = [];
      const collect = (node: DefaultTreeAdapterTypes.Node) => {
        if ("tagName" in node) descendants.push(node);
        if ("childNodes" in node) node.childNodes.forEach(collect);
      };
      collect(row);
      const field = (name: string) => {
        const container = descendants.find((n) => hasClass(n, `field--name-field-tm-rss-${name}`));
        if (!container) throw new Error("Incomplete transit notice");
        const item = container.childNodes.find(
          (n): n is Element => "tagName" in n && hasClass(n, "field__item"),
        );
        if (!item) throw new Error("Incomplete transit notice field");
        return stripHtml(serializeOuter(item));
      };
      const title = field("title"),
        description = field("description");
      const published = descendants
        .find((n) => n.tagName === "time")
        ?.attrs.find((a) => a.name === "datetime")?.value;
      if (!title || !description || !published || !Number.isFinite(Date.parse(published)))
        throw new Error("Incomplete transit notice content");
      const cancelled =
        /\btrip departing at\b/iu.test(title) && /\bis cancelled\b/iu.test(description);
      const effective = /(?:^|\n)Date Effective:\s*([^\n]+)/iu.exec(description)?.[1];
      const departure = cancelled ? /departing at (.*?) from /iu.exec(description)?.[1] : undefined;
      const arrival = cancelled
        ? /arriving at (.*?\d{1,2}:\d{2})\b/iu.exec(description)?.[1]
        : undefined;
      if (cancelled && (!departure || !arrival))
        throw new Error("Cancelled trip requires its service window");
      const startsAt = departure
        ? timestamp(departure)
        : effective && !/^Immediate$/iu.test(effective)
          ? timestamp(effective)
          : Date.parse(published);
      const endsAt = arrival ? timestamp(arrival) : undefined;
      if (endsAt !== undefined && endsAt < startsAt)
        throw new Error("Invalid cancelled trip service window");
      const caption =
        description.split("\n").find((s) => /^Routes?:/iu.test(s)) ??
        (cancelled
          ? (/^Route \S+(?: (?:Inbound|Outbound|Northbound|Southbound|Eastbound|Westbound))?/iu.exec(
              title,
            )?.[0] ?? title)
          : title);
      const routeIds = Object.entries(routeNames)
        .filter(([, aliases]) =>
          aliases.some((a) =>
            new RegExp(
              `(?:^|[^A-Za-z0-9])${a.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?=$|[^A-Za-z0-9])`,
              "iu",
            ).test(caption),
          ),
        )
        .map(([id]) => id)
        .sort();
      if (!routeIds.length) {
        const raw = /^Routes?:\s*([A-Za-z0-9]+)/iu.exec(caption)?.[1];
        if (raw) routeIds.push(raw);
      }
      const directionText =
        /\b(Inbound|Outbound|Northbound|Southbound|Eastbound|Westbound)\b/iu.exec(caption)?.[1];
      const stopScoped = /\bStop Closure\b/iu.test(title);
      const stop = /\bStop Closure\b/iu.test(title)
        ? (/\((\d+)\)/u.exec(title)?.[1] ?? /@\s*(\d+)/u.exec(title)?.[1])
        : undefined;
      return {
        id: `${source}#${title}`,
        title,
        description,
        routeIds,
        startsAt,
        ...(endsAt === undefined ? {} : { endsAt }),
        updatedAt: now,
        ...(cancelled
          ? { tripScoped: true as const, effect: "NO_SERVICE" }
          : /^Detour Notice/iu.test(description)
            ? { effect: "DETOUR" }
            : {}),
        ...(stopScoped ? { stopScoped: true as const } : {}),
        ...(stop
          ? {
              affectedStations: [stop],
              targets: (routeIds.length ? routeIds : [undefined]).map((routeId) => ({
                routeId,
                stopId: stop,
                ...(directionText ? { directionText } : {}),
              })),
            }
          : directionText
            ? { targets: routeIds.map((routeId) => ({ routeId, directionText })) }
            : {}),
      };
    }),
  };
}
