import { decodeHeadingServiceNoticeBody } from "./headingServiceNoticesParser";
import { publishedAdvisoryTimestamp } from "./ghdNewsServiceAdvisoriesParser";
import { decodeMunicipalNews } from "./municipalNews";
import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { parseWallClock } from "./wallClock";
import { formatNoticeText } from "./htmlNoticeText";
import type { DecodedFeed } from "./gtfsRealtimeDecoder";
type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
function elements(node: Node): Element[] {
  return "childNodes" in node
    ? node.childNodes.flatMap((n) => ("tagName" in n ? [n, ...elements(n)] : elements(n)))
    : [];
}
const attr = (n: Element, key: string) => n.attrs.find((a) => a.name === key)?.value;
const hasClass = (n: Element, key: string) => attr(n, "class")?.split(/\s+/u).includes(key);
const plain = (n: Node) => stripHtml(serializeOuter(n)).replace(/\s+/gu, " ").trim();
function serviceTime(text: string, year: string, zone: string): number | undefined {
  if (/indéterminée?|nouvel ordre/iu.test(text)) return undefined;
  const m =
    /^(\d{1,2})\s+(janvier|février|mars|avril|mai|juin|juillet|août|septembre|octobre|novembre|décembre)(?:\s+(20\d{2}))?\s*,?\s*(?:(\d{1,2})\s*h\s*(\d{2})?)?$/iu.exec(
      text.trim().replace(/^(?:lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche)\s+/iu, ""),
    );
  if (!m) throw new Error("Unreadable linked advisory period");
  const months = [
    "janvier",
    "février",
    "mars",
    "avril",
    "mai",
    "juin",
    "juillet",
    "août",
    "septembre",
    "octobre",
    "novembre",
    "décembre",
  ];
  return parseWallClock(
    `${m[3] ?? year}-${String(months.indexOf(m[2].toLowerCase()) + 1).padStart(2, "0")}-${m[1].padStart(2, "0")} ${String(m[4] ?? 0).padStart(2, "0")}:${m[5] ?? "00"}:00`,
    zone,
  );
}
/** Linked cards declare scope; their detail page owns wording, closure targets and periods. */
export function decodeLinkedServiceNotices(
  html: string,
  source: string,
  now: number,
  timeZone: string,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
  stopNames: Readonly<Record<string, readonly string[]>> = {},
): { feed: DecodedFeed; pageUrls: string[] } | undefined {
  const municipal = decodeMunicipalNews(html, source, now, timeZone);
  if (municipal) return municipal;
  const all = elements(parse(html));
  const feed: DecodedFeed = {
    header: { version: "linked-service-notices", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [],
  };
  const featured = all.filter((n) => hasClass(n, "featured-update-card"));
  if (featured.length) {
    const pageUrls: string[] = [];
    for (const card of featured) {
      const children = elements(card);
      const title = children.find((n) => hasClass(n, "field--name-title"));
      const link = children.find((n) => n.tagName === "a");
      const caption = children.find((n) => hasClass(n, "text-caption"));
      if (!title || !plain(title) || !link || !caption)
        throw new Error("Incomplete featured service update");
      if (children.some((n) => plain(n) === "Complete") && /\bEnded:/u.test(plain(caption)))
        continue;
      if (!children.some((n) => /^(?:Active|In progress|Upcoming)$/iu.test(plain(n))))
        throw new Error("Unknown featured update status");
      const url = new URL(attr(link, "href") ?? "", source);
      if (!attr(link, "href") || url.origin !== new URL(source).origin)
        throw new Error("Invalid featured update link");
      pageUrls.push(url.href);
    }
    let bodyFeed = feed;
    try {
      bodyFeed = decodeHeadingServiceNoticeBody(html, source, now, routeNames, stopNames, timeZone);
    } catch (error) {
      if (
        !(error instanceof Error) ||
        error.message !== "No recognizable service notices; recovery is unconfirmed"
      )
        throw error;
    }
    return { feed: bodyFeed, pageUrls: [...new Set(pageUrls)] };
  }
  const update = all.find(
    (n) => hasClass(n, "node--type-update") && hasClass(n, "node--view-mode-full"),
  );
  if (update) {
    const children = elements(update);
    const title = children.find((n) => n.tagName === "h1");
    const body = children.find((n) => hasClass(n, "prose"));
    if (!title || !body || !plain(title) || !plain(body))
      throw new Error("Incomplete service update detail");
    const date = (label: string): number => {
      const field = children.find((n) => plain(n) === label);
      if (!field?.parentNode) throw new Error("Missing update period");
      const text = plain(field.parentNode).replace(label, "").trim();
      const m = /^(?:\w+,\s*)?(\w+ \d{1,2}), (20\d{2}) - (\d{1,2}:\d{2} [AP]M)$/u.exec(text);
      if (!m) throw new Error("Unreadable update period");
      return publishedAdvisoryTimestamp(m[1], m[3], Number(m[2]), timeZone);
    };
    const startsAt = date("Start Date"),
      endsAt = date("End Date");
    if (endsAt < startsAt) throw new Error("Reversed update period");
    const description = formatNoticeText(body, source).trim();
    const text = `${plain(title)} ${description}`;
    const routeIds = Object.entries(routeNames)
      .filter(([, names]) =>
        names.some((name) =>
          new RegExp(
            `(?:^|[^a-z0-9])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?=$|[^a-z0-9])`,
            "iu",
          ).test(text),
        ),
      )
      .map(([id]) => id);
    const affectedStations = Object.entries(stopNames)
      .filter(([, names]) => names.some((name) => text.includes(name)))
      .map(([id]) => id);
    const targets = affectedStations.flatMap((stopId) =>
      (routeIds.length ? routeIds : [undefined]).map((routeId) => ({
        stopId,
        ...(routeId ? { routeId } : {}),
      })),
    );
    return {
      feed: {
        ...feed,
        alerts: [
          {
            id: source,
            title: plain(title),
            description,
            startsAt,
            endsAt,
            routeIds,
            ...(affectedStations.length ? { stopScoped: true, affectedStations, targets } : {}),
            updatedAt: now,
          },
        ],
      },
      pageUrls: [],
    };
  }
  const cards = all.filter((n) => n.tagName === "a" && attr(n, "data-alerts-type") !== undefined);
  if (cards.length) {
    const pageUrls = cards.map((n) => {
      const href = attr(n, "href");
      const title = elements(n).find((c) => c.tagName === "h3");
      if (!href || !title || !plain(title) || attr(n, "data-alerts-line") === undefined)
        throw new Error("Incomplete linked advisory card");
      const url = new URL(href, source);
      if (url.origin !== new URL(source).origin) throw new Error("Foreign linked advisory page");
      return url.href;
    });
    return { feed, pageUrls: [...new Set(pageUrls)] };
  }
  const body = all.find((n) => hasClass(n, "body-blocks"));
  const routeList = all.find((n) => hasClass(n, "affected-lines"));
  const publication = all.find((n) => hasClass(n, "date-published"));
  const title = all.find((n) => n.tagName === "h1");
  if (!body || !title || !publication) return undefined;
  const description = formatNoticeText(body, source).replace(/\s+/gu, " ").trim();
  const text = plain(body),
    year = /\b20\d{2}\b/u.exec(plain(publication))?.[0];
  if (!description || !year) throw new Error("Incomplete linked advisory detail");
  const routeIds = [
    ...new Set(
      (routeList ? elements(routeList) : []).filter((n) => hasClass(n, "chip-large")).map(plain),
    ),
  ].sort();
  const closed =
    /Arrêts? non desservis?\s*:\s*(.*?)(?=Arrêts? recommandés?\s*:|Arrêts? temporaires?\s*:|Informations importantes\s*:|$)/iu.exec(
      text,
    )?.[1];
  const stopIds = [
    ...new Set(
      [...(closed ?? plain(title)).matchAll(/#\s*\d+(?:\s*[-–,]\s*#?\s*\d+)*/gu)].flatMap(
        (m) => m[0].match(/\d+/gu) ?? [],
      ),
    ),
  ];
  const stopScoped = closed !== undefined || /arrêts?.*non desservis?/iu.test(plain(title));
  const targets = stopIds.flatMap((stopId) =>
    (routeIds.length ? routeIds : [undefined]).map((routeId) => ({
      stopId,
      ...(routeId ? { routeId } : {}),
    })),
  );
  const start = /Début\s*:\s*(.*?)(?=\s+Fin\s*:|\s+Raison\s*:|\s+Arrêts|$)/iu.exec(text)?.[1];
  const end = /Fin\s*:\s*(.*?)(?=\s+Raison\s*:|\s+Arrêts|$)/iu.exec(text)?.[1];
  let startsAt = start ? (serviceTime(start, year, timeZone) ?? 0) : 0;
  let endsAt = end ? serviceTime(end, year, timeZone) : undefined;
  const dateSection = all.find((n) => hasClass(n, "date-section"));
  const range =
    dateSection &&
    /\bDu\s+(\d{1,2})\s+au\s+(\d{1,2})\s+(\p{L}+)\s+(20\d{2})\b/iu.exec(plain(dateSection));
  if (!start && !end && range) {
    startsAt = serviceTime(`${range[1]} ${range[3]} ${range[4]}`, range[4], timeZone)!;
    const last = serviceTime(`${range[2]} ${range[3]} ${range[4]}`, range[4], timeZone)!;
    const lastDate = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(last);
    const nextDate = new Date(Date.parse(`${lastDate}T12:00:00Z`) + 86400000)
      .toISOString()
      .slice(0, 10);
    endsAt = parseWallClock(`${nextDate} 00:00:00`, timeZone);
  }
  if (endsAt !== undefined && endsAt < startsAt) throw new Error("Reversed linked advisory period");
  return {
    feed: {
      ...feed,
      alerts: [
        {
          id: source,
          title: plain(title),
          description,
          routeIds,
          startsAt,
          ...(endsAt === undefined ? {} : { endsAt }),
          ...(stopScoped ? { stopScoped: true as const, affectedStations: stopIds, targets } : {}),
          updatedAt: now,
        },
      ],
    },
    pageUrls: [],
  };
}
