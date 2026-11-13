import { decodeLinkedServiceNotices } from "./linkedServiceNotices";
import { embeddedServiceNotices } from "./embeddedServiceNotices";
import { transitNoticeBoard } from "./transitNoticeBoard";
import { componentServiceStatus } from "./componentServiceStatus";
import { stableAlertFallbackId } from "~/domain/alerts/stableAlertId";
import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { formatNoticeText } from "./htmlNoticeText";
import {
  publishedAdvisoryPeriod,
  publishedAdvisoryTimestamp,
} from "./ghdNewsServiceAdvisoriesParser";
import type { DecodedFeed } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;
type StopTarget = { stopId: string; routeId?: string };
const CLEAR_STATEMENT =
  /^there are no (.+?) service changes planned at this time(?:[.!](?:\s|$)|$)/iu;
/** Only a declared whole-service name clears, so scoped claims never read as all-clear. */
function explicitlyClear(text: string, clearStatementNames: readonly string[]): boolean {
  const qualifier = CLEAR_STATEMENT.exec(text)?.[1]?.toLowerCase();
  return clearStatementNames.some((name) => name.toLowerCase() === qualifier);
}
export type PublicationReference = {
  readonly publicationYear: number;
  readonly validFrom: string;
  readonly validThrough: string;
};

function hasNoticeText(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  const normalized = ` ${words.join(" ")} `;
  return [
    "detour",
    "closure",
    "outage",
    "outages",
    "temporarily closed",
    "service alert",
    "service alerts",
    "not be running",
    "service disruption",
    "affected services",
    "service change",
    "service changes",
    "schedule change",
    "schedule changes",
    "schedule adjustment",
    "schedule adjustments",
    "route adjustment",
    "route adjustments",
    "route status",
    "not in service",
    "not operating",
    "combined with",
    "combined into",
  ].some((phrase) => normalized.includes(` ${phrase} `));
}

function hasWholeToken(text: string, token: string): boolean {
  const normalized = text.toLowerCase();
  const needle = token.toLowerCase();
  let at = normalized.indexOf(needle);
  while (at >= 0) {
    if (
      !/[a-z0-9]/u.test(normalized[at - 1] ?? "") &&
      !/[a-z0-9]/u.test(normalized[at + needle.length] ?? "")
    )
      return true;
    at = normalized.indexOf(needle, at + 1);
  }
  return false;
}

export function decodeHeadingServiceNotices(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
  stopNames: Readonly<Record<string, readonly string[]>> = {},
  timeZone = "UTC",
  publicationReference?: PublicationReference,
  clearStatementNames: readonly string[] = [],
): DecodedFeed {
  const linked = decodeLinkedServiceNotices(html, source, now, timeZone, routeNames, stopNames);
  if (linked) {
    if (linked.pageUrls.length) throw new Error("Service updates require their detail pages");
    return linked.feed;
  }
  return decodeHeadingServiceNoticeBody(
    html,
    source,
    now,
    routeNames,
    stopNames,
    timeZone,
    publicationReference,
    clearStatementNames,
  );
}

/** Heading-led advisory sections on a mixed schedules/advisories page.
 * Sections stay active while published. Dates in prose are never invented.
 * A missing board or unrecognized empty page fails rather than proving recovery.
 */
export function decodeHeadingServiceNoticeBody(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
  stopNames: Readonly<Record<string, readonly string[]>> = {},
  timeZone = "UTC",
  publicationReference?: PublicationReference,
  clearStatementNames: readonly string[] = [],
): DecodedFeed {
  const embedded = embeddedServiceNotices(
    html,
    source,
    now,
    routeNames,
    timeZone,
    publicationReference,
  );
  if (embedded) return embedded;
  const routeArticles = decodeRouteHeadingArticles(html, source, now, routeNames);
  if (routeArticles) return routeArticles;
  const transit = transitNoticeBoard(html, source, now, routeNames, timeZone);
  if (transit) return transit;
  const status = componentServiceStatus(html, routeNames, stopNames);
  if (status)
    return {
      header: { version: "component-service-status", timestamp: now },
      tripUpdates: [],
      vehiclePositions: [],
      alerts: status.map((a) => ({
        id: stableAlertFallbackId("component-status", source, a),
        startsAt: now,
        title: a.title,
        description: a.description,
        routeIds: a.routes,
        affectedStations: a.stops,
        effect: a.effect,
        targets: a.stops.length
          ? a.stops.flatMap((stopId) =>
              (a.routes.length ? a.routes : [undefined]).map((routeId) => ({
                routeId,
                stopId,
              })),
            )
          : a.routes.map((routeId) => ({ routeId })),
        updatedAt: now,
      })),
    };
  const disclosure = disclosureAccordionNotices(html) ?? accordionGroupNotices(html);
  if (disclosure === "")
    return {
      header: { version: "heading-service-notices", timestamp: now },
      tripUpdates: [],
      vehiclePositions: [],
      alerts: [],
    };
  const document = parse(disclosure ?? accordionNotices(html) ?? componentNotices(html) ?? html);
  const archive = decodeUpdateCards(
    document,
    source,
    now,
    routeNames,
    stopNames,
    timeZone,
    publicationReference,
  );
  if (archive) return archive;
  const listArticle = decodeRouteListArticle(document, source, now, routeNames, timeZone);
  if (listArticle) return listArticle;
  const article = decodePublishedArticle(document, source, now, routeNames, stopNames, timeZone);
  if (article) return article;
  const blocks: {
    tag: string;
    text: string;
    plain: string;
    listed: boolean;
    targets: StopTarget[];
  }[] = [];
  let foundMain = false;
  function walk(node: Node, inMain: boolean): void {
    const tag = "tagName" in node ? node.tagName : "";
    if (["script", "style", "nav", "footer", "aside"].includes(tag)) return;
    if (tag === "main") foundMain = true;
    const inside = inMain || tag === "main";
    if (inside && ["h2", "h3", "h4", "p", "li", "tr", "hr"].includes(tag)) {
      const text = stripHtml(serializeOuter(node).replace(/<\/(?:th|td)>/giu, " </td>"))
        .replace(/\s+/gu, " ")
        .replace(/^\*\s+/u, "")
        .trim();
      const formatted = (
        tag === "tr" && "childNodes" in node
          ? node.childNodes.map((child) => formatNoticeText(child, source)).join(" ")
          : formatNoticeText(node, source)
      )
        .replace(/\s+/gu, " ")
        .trim()
        .replace(/^\*\s+/u, "");
      if (text || tag === "hr")
        blocks.push({
          tag,
          plain: text,
          text: ["p", "li", "tr"].includes(tag) ? formatted : text,
          listed: "attrs" in node && node.attrs.some((attr) => attr.name === LISTED_NOTICE),
          targets: closedStopTargets(node, routeNames),
        });
      return;
    }
    if ("childNodes" in node) for (const child of node.childNodes) walk(child, inside);
  }
  walk(document, false);
  if (!foundMain) throw new Error("Missing main service content");
  const sections: {
    title: string;
    dated: boolean;
    listed: boolean;
    postedAt?: number;
    body: { text: string; plain: string; targets: StopTarget[] }[];
  }[] = [];
  const isDate = (text: string) =>
    /^(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}$/iu.test(
      text,
    );
  let pendingDate: number | undefined;
  let separated = false;
  for (const block of blocks) {
    if (block.tag === "hr") {
      separated = !sections.at(-1)?.body.some((block) => /^Route\(s\):/iu.test(block.plain));
      pendingDate = undefined;
      continue;
    }
    if (block.tag === "p" && isDate(block.plain)) {
      pendingDate = Date.parse(`${block.plain} 00:00:00 GMT`);
      const parts = block.plain.split(/[ ,]+/u);
      const months = [
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
      const parsed = new Date(pendingDate);
      if (
        !Number.isFinite(pendingDate) ||
        parsed.getUTCDate() !== Number(parts[1]) ||
        parsed.getUTCMonth() !== months.indexOf(parts[0].toLowerCase()) ||
        parsed.getUTCFullYear() !== Number(parts[2])
      )
        throw new Error("Invalid notice publication date");
      continue;
    }
    if (["h2", "h3", "h4"].includes(block.tag)) {
      sections.push({
        title: block.text,
        dated: block.tag === "h4" && pendingDate !== undefined,
        listed: block.listed,
        postedAt: block.tag === "h4" ? pendingDate : undefined,
        body: [],
      });
      pendingDate = undefined;
      separated = false;
    } else if (!separated) sections.at(-1)?.body.push(block);
  }
  const notices = new Map<
    string,
    {
      title: string;
      description: string;
      postedAt?: number;
      targets: StopTarget[];
    }
  >();
  for (const section of sections) {
    const noticeStart =
      section.dated || section.listed || hasNoticeText(section.title)
        ? 0
        : section.body.findIndex((block) => hasNoticeText(block.plain));
    if (noticeStart < 0) continue;
    const body = section.body.slice(noticeStart).map((block) => block.text);
    const description = body.join("\n");
    if (!description) throw new Error("Service notice has no body");
    const key =
      section.postedAt === undefined ? section.title : `${section.postedAt}-${section.title}`;
    const prior = notices.get(key);
    const paragraphs = [...new Set([...(prior?.description.split("\n") ?? []), ...body])];
    notices.set(key, {
      title: section.title,
      description: paragraphs.join("\n"),
      postedAt: section.postedAt,
      targets: [
        ...(prior?.targets ?? []),
        ...section.body.slice(noticeStart).flatMap((block) => block.targets),
      ],
    });
  }
  if (
    !notices.size &&
    !blocks.some((block) => block.tag === "p" && explicitlyClear(block.plain, clearStatementNames))
  )
    throw new Error("No recognizable service notices; recovery is unconfirmed");
  return {
    header: { version: "heading-service-notices", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [...notices.values()].flatMap(({ title, description, postedAt, targets }) => {
      const stationCaption = description
        .split("\n")
        .find((line) => /^Affected stations:/iu.test(line));
      const captionStations = stationCaption
        ? Object.entries(stopNames).filter(([, names]) =>
            names.some((name) => hasWholeToken(stationCaption, name)),
          )
        : [];
      const affectedDescription = description
        .split(/(?<=[.!?])\s+|\n/u)
        .filter(
          (sentence) =>
            !/\bshuttle\b/iu.test(sentence) ||
            /\b(?:closed|closure|outage|out of service)\b/iu.test(sentence),
        )
        .join(" ");
      const stations = (stationCaption ? captionStations : Object.entries(stopNames))
        .filter(([, names]) =>
          names.some(
            (name) =>
              (stationCaption !== undefined && hasWholeToken(stationCaption, name)) ||
              hasWholeToken(title, name) ||
              (/\b(?:station|terminal)\b/iu.test(name)
                ? hasWholeToken(affectedDescription, name)
                : ["Station", "Terminal"].some((kind) =>
                    hasWholeToken(affectedDescription, `${name} ${kind}`),
                  )),
          ),
        )
        .map(([id]) => id)
        .sort();
      const labelled = labelledNoticePeriod(description, timeZone);
      const routeCaption = description
        .split("\n")
        .find((line) => /^Routes?(?:\(s\))?:/iu.test(line));
      return (labelled?.windows ?? [undefined]).map((window) => ({
        id: `${source}#${postedAt === undefined ? "" : `${postedAt}-`}${title}${labelled && labelled.windows.length > 1 ? `#${window!.startsAt}` : ""}`,
        title,
        description,
        routeIds: Object.entries(routeNames)
          .filter(([, names]) =>
            names.some((name) =>
              hasWholeToken(routeCaption ? routeCaption : `${title} ${description}`, name),
            ),
          )
          .map(([id]) => id)
          .sort(),
        ...(Object.keys(stopNames).length || targets.length
          ? {
              affectedStations: targets.length ? [] : stations,
              targets: targets.length
                ? [...new Map(targets.map((target) => [JSON.stringify(target), target])).values()]
                : stations.map((stopId) => ({ stopId })),
            }
          : {}),
        startsAt: window?.startsAt ?? postedAt ?? 0,
        ...(window?.endsAt === undefined ? {} : { endsAt: window.endsAt }),
        updatedAt: now,
      }));
    }),
  };
}

/** Route headings establish affected scope; alternatives in the body do not. */
function decodeRouteHeadingArticles(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>>,
): DecodedFeed | undefined {
  const alerts: DecodedFeed["alerts"][number][] = [];
  let unrecognizedArticle = false;
  function walk(node: Node): void {
    if (!("tagName" in node)) {
      if ("childNodes" in node) node.childNodes.forEach(walk);
      return;
    }
    if (["nav", "footer", "aside", "script", "style"].includes(node.tagName)) return;
    if (node.tagName !== "article") {
      node.childNodes.forEach(walk);
      return;
    }
    function hasArticle(child: Node): boolean {
      return (
        ("tagName" in child && child.tagName === "article") ||
        ("childNodes" in child && child.childNodes.some(hasArticle))
      );
    }
    if (node.childNodes.some(hasArticle)) {
      node.childNodes.forEach(walk);
      return;
    }
    const headings: Node[] = [];
    function collect(child: Node): void {
      if ("tagName" in child && /^h[1-6]$/u.test(child.tagName)) headings.push(child);
      else if ("childNodes" in child) child.childNodes.forEach(collect);
    }
    collect(node);
    const title = headings.length === 1 ? stripHtml(serializeOuter(headings[0])).trim() : "";
    if (!/^(?:Ligne|Route)\s*#\s*[\p{L}\d+-]+$/iu.test(title)) {
      unrecognizedArticle = true;
      return;
    }
    const routeIds = Object.entries(routeNames)
      .filter(([, names]) => names.some((name) => name.toLowerCase() === title.toLowerCase()))
      .map(([id]) => id)
      .sort();
    if (!routeIds.length) throw new Error("Unmapped route article heading");
    function body(child: Node): string {
      if (!("tagName" in child)) return formatNoticeText(child, source);
      if (/^h[1-6]$/u.test(child.tagName)) return "";
      if (["script", "style", "br"].includes(child.tagName)) return " ";
      if (child.tagName === "a") return formatNoticeText(child, source);
      const text = child.childNodes.map(body).join("");
      return ["div", "p", "li", "section", "article"].includes(child.tagName) ? `${text} ` : text;
    }
    const description = node.childNodes.map(body).join("").replace(/\s+/gu, " ").trim();
    if (!description) throw new Error("Route article has no body");
    alerts.push({
      id: `${source}#${title}`,
      title,
      description,
      routeIds,
      startsAt: 0,
      updatedAt: now,
    });
  }
  walk(parse(html));
  if (alerts.length && unrecognizedArticle) throw new Error("Incomplete route article board");
  return alerts.length
    ? {
        header: { version: "heading-service-notices", timestamp: now },
        tripUpdates: [],
        vehiclePositions: [],
        alerts,
      }
    : undefined;
}

/** Yearless update cards are a reverse-chronological rolling board. */
function decodeUpdateCards(
  document: Node,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>>,
  stopNames: Readonly<Record<string, readonly string[]>>,
  timeZone: string,
  publicationReference: PublicationReference | undefined,
): DecodedFeed | undefined {
  const cards: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: Node) => {
    if (
      "tagName" in node &&
      node.attrs.some(
        (attr) => attr.name === "class" && attr.value.split(/\s+/u).includes("service-update"),
      )
    ) {
      cards.push(node);
      return;
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);
  if (!cards.length) return undefined;
  if (!publicationReference)
    throw new Error("Yearless update archive has no verified publication reference");
  const validReferenceDate = (value: string) => {
    if (!value.startsWith(`${publicationReference.publicationYear}-`)) return false;
    const [year, month, day] = value.split("-").map(Number);
    const date = new Date(Date.UTC(year!, month! - 1, day));
    return (
      date.getUTCFullYear() === year &&
      date.getUTCMonth() === month! - 1 &&
      date.getUTCDate() === day
    );
  };
  if (
    !Number.isInteger(publicationReference.publicationYear) ||
    publicationReference.publicationYear < 2020 ||
    publicationReference.publicationYear > 2050 ||
    !validReferenceDate(publicationReference.validFrom) ||
    !validReferenceDate(publicationReference.validThrough) ||
    publicationReference.validFrom > publicationReference.validThrough
  )
    throw new Error("Invalid verified publication reference");
  const localParts = new Intl.DateTimeFormat("en", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const localDate = `${localParts.find((part) => part.type === "year")?.value}-${localParts.find((part) => part.type === "month")?.value}-${localParts.find((part) => part.type === "day")?.value}`;
  if (localDate < publicationReference.validFrom || localDate > publicationReference.validThrough)
    throw new Error("Verified publication reference is outside its validity window");
  const alerts = cards.flatMap((card) => {
    const headings: Node[] = [],
      paragraphs: Node[] = [];
    const walk = (node: Node) => {
      if ("tagName" in node && node.tagName === "h4") headings.push(node);
      else if ("tagName" in node && node.tagName === "p") paragraphs.push(node);
      else if ("childNodes" in node) node.childNodes.forEach(walk);
    };
    walk(card);
    const heading = headings.length === 1 ? stripHtml(serializeOuter(headings[0])).trim() : "";
    const date = /^([A-Za-z]+ \d{1,2}) (\d{1,2}):(\d{2})(am|pm)$/iu.exec(heading);
    const description = paragraphs
      .map((p) => formatNoticeText(p, source).replace(/\s+/gu, " ").trim())
      .join("\n");
    const months = [
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
    const [month, day] = (date?.[1] ?? "").toLowerCase().split(" ");
    const monthIndex = months.indexOf(month);
    const calendarDate = new Date(
      Date.UTC(publicationReference.publicationYear, monthIndex, Number(day)),
    );
    if (
      !date ||
      !description ||
      monthIndex < 0 ||
      calendarDate.getUTCMonth() !== monthIndex ||
      +date[2] < 1 ||
      +date[2] > 12 ||
      +date[3] > 59
    )
      throw new Error("Invalid dated service update");
    if (/\bno closures\b/iu.test(description)) return [];
    const publicationAt = publishedAdvisoryTimestamp(
      date[1],
      `${date[2]}:${date[3]}${date[4]}`,
      publicationReference.publicationYear,
      timeZone,
    );
    const eventStart =
      /\b(?:today,?\s+)?([A-Za-z]+\s+\d{1,2}),?\s+from\s+(\d{1,2}:\d{2}\s*[ap]\.?(?:m\.?)?)/iu.exec(
        description,
      );
    const startsAt = eventStart
      ? publishedAdvisoryTimestamp(
          eventStart[1],
          eventStart[2],
          publicationReference.publicationYear,
          timeZone,
        )
      : publicationAt;
    const publication = `${date[1]}, ${publicationReference.publicationYear}`;
    const until = /\buntil\s+([A-Za-z]+\s+\d{1,2})\b/iu.exec(description)?.[1];
    const endClock =
      /\buntil\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)(?=\s|[,!?]|$)/iu.exec(description)?.[1] ??
      /\bfrom\s+\d{1,2}:\d{2}\s*[ap]\.?m\.?(?:\s|,)[^!?]{0,100}?\bto\s+(\d{1,2}:\d{2}\s*[ap]\.?m\.?)(?=\s|[,!?]|$)/iu.exec(
        description,
      )?.[1];
    const today = /\btoday\b/iu.test(description);
    const oneDayService =
      /\b(?:cancelled|canceled|cancelling|canceling)\b/iu.test(description) &&
      /\bfollowing\b/iu.test(description) &&
      /\b\d{1,2}:\d{2}\s*[ap]\.?m\.?/iu.test(description);
    const endDate = /\buntil\s+further\s+notice\b/iu.test(description)
      ? undefined
      : (until ?? (today || oneDayService ? date[1] : undefined));
    const endDateText = until ?? eventStart?.[1] ?? date[1];
    const endsAt =
      endClock && !/\bapproximately\b/iu.test(description)
        ? publishedAdvisoryTimestamp(
            endDateText,
            endClock,
            publicationReference.publicationYear,
            timeZone,
          )
        : endDate && !/\bapproximately\b/iu.test(description)
          ? publishedAdvisoryPeriod(
              `from ${endDate}, ${publicationReference.publicationYear} to ${endDate}, ${publicationReference.publicationYear}`,
              publication,
              timeZone,
            ).endsAt
          : undefined;
    const routeList = /\broutes?\s+([\w\s,&/+-]+?)(?:\s+(?:are|have|will|is|were)\b|:)/iu.exec(
      description,
    )?.[1];
    const routeIds = Object.entries(routeNames)
      .filter(
        ([id, names]) =>
          names.some((name) => hasWholeToken(description, name)) ||
          (routeList !== undefined && hasWholeToken(routeList, id)),
      )
      .map(([id]) => id)
      .sort();
    const stations = Object.entries(stopNames)
      .filter(([, names]) => names.some((name) => hasWholeToken(description, name)))
      .map(([id]) => id)
      .sort();
    const title = `${heading}: ${description.split(/(?<=[.!?])\s/u)[0]}`;
    return [
      {
        id: `${source}#${publicationAt}-${title}`,
        title,
        description,
        routeIds,
        startsAt,
        ...(endsAt === undefined ? {} : { endsAt }),
        updatedAt: publicationAt,
        ...(stations.length
          ? {
              affectedStations: stations,
              targets: stations.flatMap((stopId) =>
                (routeIds.length ? routeIds : [undefined]).map((routeId) => ({
                  stopId,
                  ...(routeId ? { routeId } : {}),
                })),
              ),
            }
          : {}),
      },
    ];
  });
  return {
    header: { version: "heading-service-notices", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}

/** Reads individually scoped route entries from a dated news article. */
function decodeRouteListArticle(
  document: Node,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>>,
  timeZone: string,
): DecodedFeed | undefined {
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);
  const hasClass = (node: DefaultTreeAdapterTypes.Element, name: string) =>
    node.attrs
      .find((attr) => attr.name === "class")
      ?.value.split(/\s+/u)
      .includes(name);
  const header = elements.find((element) => hasClass(element, "blog-post__header"));
  if (!header) return undefined;
  const article = header.parentNode;
  if (!article || !("tagName" in article) || article.tagName !== "article")
    throw new Error("Invalid article structure");
  elements.length = 0;
  visit(article);
  const date = elements.find((element) => hasClass(element, "date"));
  if (!date) throw new Error("Missing article date");
  const publication = stripHtml(serializeOuter(date)).trim();
  const items = elements.filter((element) => {
    const parent = element.parentNode;
    return (
      element.tagName === "li" &&
      parent &&
      "tagName" in parent &&
      parent.tagName === "ul" &&
      !hasClass(parent, "wp-block-social-links")
    );
  });
  if (!items.length) throw new Error("Missing article notices");
  const alerts = items.map((item) => {
    const description = stripHtml(serializeOuter(item)).replace(/\s+/gu, " ").trim();
    const title = description.split(":", 1)[0].trim();
    const routes = Object.entries(routeNames)
      .filter(([, names]) => names.some((name) => hasWholeToken(title, name)))
      .map(([id]) => id)
      .sort();
    if (!description.includes(":") || !routes.length)
      throw new Error("Unrecognized article notice scope");
    const range =
      /\bfrom\s+([A-Za-z]+\s+\d{1,2})\s+to\s+(approximately\s+)?([A-Za-z]+\s+\d{1,2})/iu.exec(
        description,
      );
    const single =
      /\b(?:starting|starts service on|ends service on)\s+([A-Za-z]+\s+\d{1,2})/iu.exec(
        description,
      );
    const start = range?.[1] ?? single?.[1];
    if (!start) throw new Error("Article notice lacks a readable start date");
    const period = publishedAdvisoryPeriod(
      `from ${start} to ${range?.[3] ?? start}`,
      publication,
      timeZone,
    );
    const startsAt = /\bends service on\b/iu.test(description)
      ? period.endsAt + 1000
      : period.startsAt;
    return {
      id: `${source}#${startsAt}-${title}`,
      title,
      description,
      routeIds: routes,
      startsAt,
      ...(range && !range[2] ? { endsAt: period.endsAt } : {}),
      updatedAt: now,
    };
  });
  return {
    header: { version: "heading-service-notices", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}

/** Extracts only an explicit date range, excluding nearby historical or planned dates. */
function articleDateRange(text: string): string | undefined {
  const tokens = text.split(/\s+/u);
  const months = new Set([
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
    "jan",
    "feb",
    "mar",
    "apr",
    "jun",
    "jul",
    "aug",
    "sep",
    "sept",
    "oct",
    "nov",
    "dec",
  ]);
  const month = (index: number) =>
    months.has((tokens[index] ?? "").toLowerCase().replace(/\.$/u, ""));
  const day = (index: number) => /^\d{1,2}[,.]?$/u.test(tokens[index] ?? "");
  const year = (index: number) => /^\d{4}[,.]?$/u.test(tokens[index] ?? "");
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].toLowerCase() !== "on" || tokens[index - 1]?.toLowerCase() !== "service")
      continue;
    let start = index + 1;
    if (
      /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday),?$/iu.test(tokens[start] ?? "")
    )
      start++;
    if (!month(start) || !day(start + 1)) continue;
    let end = start + 2;
    if (year(end)) end++;
    const date = tokens.slice(start, end).join(" ").replace(/[,.]$/u, "");
    return `from ${date} to ${date}`;
  }
  for (let index = 0; index < tokens.length; index++) {
    if (tokens[index].toLowerCase() !== "from" || !month(index + 1) || !day(index + 2)) continue;
    let end = index + 3;
    if (year(end)) end++;
    if (tokens[end]?.toLowerCase() !== "to" || !month(end + 1) || !day(end + 2)) continue;
    end += 3;
    if (year(end)) end++;
    return tokens.slice(index, end).join(" ");
  }
  return undefined;
}

/** Govstack news details have a dated meta section followed by one article body. */
function decodePublishedArticle(
  document: Node,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>>,
  stopNames: Readonly<Record<string, readonly string[]>>,
  timeZone: string,
): DecodedFeed | undefined {
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: Node) => {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(visit);
  };
  visit(document);
  const main = elements.find((node) => node.tagName === "main");
  if (!main) return undefined;
  elements.length = 0;
  visit(main);
  const hasClass = (node: DefaultTreeAdapterTypes.Element, name: string) =>
    node.attrs
      .find((attr) => attr.name === "class")
      ?.value.split(/\s+/u)
      .includes(name);
  const meta = elements.find((node) => hasClass(node, "gs-news-details-meta"));
  if (!meta) return undefined;
  elements.length = 0;
  visit(meta);
  const publication = elements.find((node) => hasClass(node, "gs-news-details-date"));
  elements.length = 0;
  visit(main);
  const siblings =
    meta.parentNode && "childNodes" in meta.parentNode ? meta.parentNode.childNodes : [];
  const body = siblings
    .slice(siblings.indexOf(meta) + 1)
    .find((node): node is DefaultTreeAdapterTypes.Element => "tagName" in node);
  const titleNode = elements.find((node) => node.tagName === "h1");
  if (!body || !hasClass(body, "usn_cmp_text") || !publication || !titleNode)
    throw new Error("Incomplete news article");
  const title = stripHtml(serializeOuter(titleNode)).trim();
  const paragraphs: string[] = [];
  const collect = (node: Node) => {
    if ("tagName" in node) {
      if (["nav", "footer", "aside", "script", "style"].includes(node.tagName)) return;
      if (["p", "li", "h2", "h3", "h4"].includes(node.tagName)) {
        const text = formatNoticeText(node, source).replace(/\s+/gu, " ").trim();
        if (text) paragraphs.push(text);
        return;
      }
    }
    if ("childNodes" in node) node.childNodes.forEach(collect);
  };
  collect(body);
  const description = paragraphs.join("\n");
  if (!title || !hasNoticeText(`${title} ${description}`))
    throw new Error("Article is not a service notice");
  const periodText = paragraphs.map(articleDateRange).find((text) => text !== undefined);
  if (!periodText) throw new Error("Article has no stated retirement");
  const period = publishedAdvisoryPeriod(
    periodText,
    stripHtml(serializeOuter(publication)),
    timeZone,
  );
  const stations = Object.entries(stopNames)
    .filter(([, names]) =>
      names.some(
        (name) =>
          hasWholeToken(title, name) ||
          ["Station", "Terminal"].some((kind) => hasWholeToken(description, `${name} ${kind}`)),
      ),
    )
    .map(([id]) => id)
    .sort();
  return {
    header: { version: "heading-service-notices", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [
      {
        id: `${source}#${period.startsAt}-${title}`,
        title,
        description,
        startsAt: period.startsAt,
        endsAt: period.endsAt,
        updatedAt: now,
        routeIds: Object.entries(routeNames)
          .filter(([, names]) =>
            names.some((name) => hasWholeToken(`${title} ${description}`, name)),
          )
          .map(([id]) => id)
          .sort(),
        ...(Object.keys(stopNames).length
          ? {
              affectedStations: stations,
              targets: stations.map((stopId) => ({ stopId })),
            }
          : {}),
      },
    ],
  };
}

/** AEM components bound notices independently of navigation and explanatory accordions. */
function componentNotices(html: string): string | undefined {
  const document = parse(html);
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const walk = (node: Node) => {
    if ("tagName" in node) elements.push(node);
    if ("childNodes" in node) node.childNodes.forEach(walk);
  };
  walk(document);
  const hasClass = (node: DefaultTreeAdapterTypes.Element, name: string) =>
    node.attrs
      .find((attr) => attr.name === "class")
      ?.value.split(/\s+/u)
      .includes(name);
  const main = elements.find((node) => hasClass(node, "maincontentparct"));
  if (!main) return undefined;
  elements.length = 0;
  walk(main);
  const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const notices: { title: string; body: string }[] = [];
  for (const component of elements.filter(
    (node) => hasClass(node, "alert-body") || (hasClass(node, "text") && hasClass(node, "parbase")),
  )) {
    const descendants: DefaultTreeAdapterTypes.Element[] = [];
    const visit = (node: Node) => {
      if ("tagName" in node) descendants.push(node);
      if ("childNodes" in node) node.childNodes.forEach(visit);
    };
    visit(component);
    const heading = descendants.find((node) => /^h[234]$/u.test(node.tagName));
    if (!heading) continue;
    const title = plain(descendants.find((node) => hasClass(node, "title-text")) ?? heading);
    if (!hasNoticeText(title)) continue;
    const body = component.childNodes
      .filter((node) => node !== heading)
      .map((node) =>
        "tagName" in node && node.tagName === "a"
          ? `<p>${serializeOuter(node)}</p>`
          : serializeOuter(node),
      )
      .join("");
    // A heading-only component labels the following table rather than an incident.
    if (!stripHtml(body).trim()) continue;
    notices.push({ title, body });
  }
  let equipment: string | undefined;
  for (const element of elements) {
    if (/^h[234]$/u.test(element.tagName)) {
      const title = plain(element).toLowerCase();
      equipment =
        title === "planned elevator outages"
          ? "elevator"
          : title === "planned escalator outages"
            ? "escalator"
            : undefined;
    }
    if (element.tagName !== "table" || !equipment) continue;
    const rows: DefaultTreeAdapterTypes.Element[] = [];
    const visit = (node: Node) => {
      if ("tagName" in node && node.tagName === "tr") rows.push(node);
      if ("childNodes" in node) node.childNodes.forEach(visit);
    };
    visit(element);
    const cells = (row: DefaultTreeAdapterTypes.Element) =>
      row.childNodes.filter(
        (node): node is DefaultTreeAdapterTypes.Element =>
          "tagName" in node && ["td", "th"].includes(node.tagName),
      );
    const headers = rows.length ? cells(rows[0]).map(plain) : [];
    if (
      rows.length < 2 ||
      !headers.includes("Outage Start Date") ||
      !headers.includes("Expected In-Service Date")
    )
      throw new Error("Unrecognized outage table");
    for (const row of rows.slice(1)) {
      const values = cells(row).map((cell) =>
        plain(cell).replace(
          /^(?:Location|Direction|Outage Start Date|Expected In-Service Date):\s*/u,
          "",
        ),
      );
      if (values.length !== headers.length || values.some((value) => !value))
        throw new Error("Incomplete outage row");
      const location = values[0];
      const dateKey = (text: string) =>
        text
          .toLowerCase()
          .replace(/\b(?:monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/gu, "")
          .replace(/[\s,–—-]+/gu, " ")
          .trim();
      const periodKey = dateKey(
        `${values[headers.indexOf("Outage Start Date")]} - ${values[headers.indexOf("Expected In-Service Date")]}`,
      );
      if (
        notices.some(
          (notice) =>
            hasWholeToken(notice.title, location) &&
            hasWholeToken(notice.title, equipment!) &&
            dateKey(
              notice.title.includes("|")
                ? notice.title.split("|").at(-1)!
                : notice.title.split(":")[0],
            ) === periodKey,
        )
      )
        continue;
      notices.push({
        title: `${location}${hasWholeToken(location, equipment) ? "" : ` ${equipment}`} outage | ${values[headers.indexOf("Outage Start Date")]} - ${values[headers.indexOf("Expected In-Service Date")]}`,
        body: values
          .map((value, index) => `<p>${escape(headers[index])}: ${escape(value)}</p>`)
          .join(""),
      });
    }
  }
  // Banners and asides are scoped callouts, so only body text may clear the board.
  let clear: DefaultTreeAdapterTypes.Element | undefined;
  const findClear = (node: Node, inText: boolean): void => {
    if (clear || !("tagName" in node)) return;
    if (
      ["nav", "footer", "aside", "script", "style"].includes(node.tagName) ||
      hasClass(node, "alert-body")
    )
      return;
    const inside =
      inText || (hasClass(node, "text") === true && hasClass(node, "parbase") === true);
    if (inside && node.tagName === "p" && CLEAR_STATEMENT.test(plain(node))) {
      clear = node;
      return;
    }
    node.childNodes.forEach((child) => findClear(child, inside));
  };
  findClear(main, false);
  return `<main>${clear ? `<p>${escape(plain(clear))}</p>` : ""}${notices.map(({ title, body }) => `<h3>${escape(title)}</h3>${body}<hr>`).join("")}</main>`;
}

/** An empty disclosure set under an advisory heading is the quiet board, returned as "". */
function disclosureAccordionNotices(html: string): string | undefined {
  type Element = DefaultTreeAdapterTypes.Element;
  const elements: Element[] = [];
  const visit = (node: Node, found: Element[]) => {
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach((child) => visit(child, found));
  };
  visit(parse(html), elements);
  const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
  const hasClass = (node: Element, name: string) =>
    (attr(node, "class") ?? "").split(/\s+/u).includes(name);
  const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const childElements = (node: Element) =>
    node.childNodes.filter((child): child is Element => "tagName" in child);
  let boards = 0;
  const notices: string[] = [];
  for (const board of elements.filter((node) => hasClass(node, "accordion"))) {
    const set = childElements(board).find((child) => hasClass(child, "accordSet"));
    if (!set) continue;
    const parent = board.parentNode as Element | null;
    const siblings = parent && "childNodes" in parent ? childElements(parent) : [];
    const heading = siblings[siblings.indexOf(board) - 1];
    if (
      !heading ||
      !/^h[234]$/u.test(heading.tagName) ||
      (!hasNoticeText(plain(heading)) && !/\b(?:detours|closures)\b/iu.test(plain(heading)))
    )
      continue;
    boards += 1;
    const members: Element[] = [];
    visit(set, members);
    const buttons = members.filter((node) => node.tagName === "button");
    const panels = members.filter((node) => hasClass(node, "accordCnt"));
    if (!buttons.length && plain(set)) throw new Error("Unrecognized disclosure board content");
    if (buttons.length !== panels.length) throw new Error("Incomplete disclosure notice");
    for (const button of buttons) {
      const controls = attr(button, "aria-controls");
      const panel = controls ? panels.find((node) => attr(node, "id") === controls) : undefined;
      if (!panel || !plain(button) || !plain(panel))
        throw new Error("Incomplete disclosure notice");
      notices.push(
        `<h3>${escape(plain(button))}</h3>${panel.childNodes.map((child) => serializeOuter(child)).join("")}<hr>`,
      );
    }
  }
  if (!boards) return undefined;
  return notices.length ? `<main>${notices.join("")}</main>` : "";
}

/** Marks a heading whose board already established it as a notice. */
const LISTED_NOTICE = "data-listed-notice";

/** Accordion groups list one notice per item under an advisory heading.
 * A titled group with no item list is the quiet board, returned as "".
 */
function accordionGroupNotices(html: string): string | undefined {
  type Element = DefaultTreeAdapterTypes.Element;
  const elements: Element[] = [];
  const visit = (node: Node, found: Element[]) => {
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach((child) => visit(child, found));
  };
  visit(parse(html), elements);
  const hasClass = (node: Element, name: string) =>
    (node.attrs.find((a) => a.name === "class")?.value ?? "").split(/\s+/u).includes(name);
  const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const childElements = (node: Element) =>
    node.childNodes.filter((child): child is Element => "tagName" in child);
  const incomplete = () => new Error("Incomplete accordion group notice");
  // A quiet board has no item markup at all; moved or renamed items must not read as all-clear.
  const isAccordionItemMarkup = (node: Element) =>
    node.tagName === "button" ||
    (node.attrs.find((a) => a.name === "class")?.value ?? "")
      .split(/\s+/u)
      .some((name) => name.startsWith("m-accordion") || name.startsWith("o-accordion-group__list"));
  let boards = 0;
  const notices: string[] = [];
  for (const group of elements.filter((node) => hasClass(node, "o-accordion-group"))) {
    const heading = childElements(group).find((child) =>
      hasClass(child, "o-accordion-group__title"),
    );
    if (
      !heading ||
      !/^h[234]$/u.test(heading.tagName) ||
      (!hasNoticeText(plain(heading)) && !/\b(?:detours|closures|impacts)\b/iu.test(plain(heading)))
    )
      continue;
    boards += 1;
    const list = childElements(group).find((child) => hasClass(child, "o-accordion-group__list"));
    if (!list) {
      const members: Element[] = [];
      group.childNodes.forEach((child) => visit(child, members));
      if (members.some(isAccordionItemMarkup))
        throw new Error("Unrecognized accordion group content");
      continue;
    }
    const rows = childElements(list);
    if (!rows.length || rows.some((row) => row.tagName !== "li"))
      throw new Error("Unrecognized accordion group content");
    for (const row of rows) {
      const members: Element[] = [];
      row.childNodes.forEach((child) => visit(child, members));
      const trigger = members.find(
        (node) => node.tagName === "button" && hasClass(node, "m-accordion__trigger"),
      );
      const content = members.find((node) => hasClass(node, "m-accordion__content"));
      if (!trigger || !content || !plain(trigger) || !plain(content)) throw incomplete();
      notices.push(
        `<h3 ${LISTED_NOTICE}>${escape(plain(trigger))}</h3>${content.childNodes.map((child) => serializeOuter(child)).join("")}<hr>`,
      );
    }
  }
  if (!boards) return undefined;
  return notices.length ? `<main>${notices.join("")}</main>` : "";
}

/** Drupal accordion boards bound incidents independently of the page's introductory main. */
function accordionNotices(html: string): string | undefined {
  const elements: DefaultTreeAdapterTypes.Element[] = [];
  const visit = (node: Node, found: DefaultTreeAdapterTypes.Element[]) => {
    if ("tagName" in node) found.push(node);
    if ("childNodes" in node) node.childNodes.forEach((child) => visit(child, found));
  };
  visit(parse(html), elements);
  const hasClass = (node: DefaultTreeAdapterTypes.Element, name: string) =>
    node.attrs
      .find((attr) => attr.name === "class")
      ?.value.split(/\s+/u)
      .includes(name);
  const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
  const escape = (value: string) =>
    value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  const boards = elements.filter((node) => hasClass(node, "accordion-module"));
  if (!boards.length) return undefined;
  const notices: string[] = [];
  for (const board of boards) {
    const nodes: DefaultTreeAdapterTypes.Element[] = [];
    visit(board, nodes);
    const heading = nodes.find((node) => /^h[234]$/u.test(node.tagName));
    if (!heading || (!hasNoticeText(plain(heading)) && !/\bclosures\b/iu.test(plain(heading))))
      continue;
    for (const section of nodes.filter((node) => hasClass(node, "accordion__section"))) {
      const children: DefaultTreeAdapterTypes.Element[] = [];
      visit(section, children);
      const title = children.find((node) => hasClass(node, "accordion__section__title"));
      const body = children.find((node) => hasClass(node, "accordion__section__content"));
      if (!title || !body || !plain(title) || !plain(body))
        throw new Error("Incomplete accordion notice");
      if (
        /^no (?:general )?(?:detours|service alerts|closures) (?:in effect|at this time)\.?$/iu.test(
          plain(body),
        )
      )
        continue;
      notices.push(`<h3>${escape(plain(title))}</h3>${serializeOuter(body)}<hr>`);
    }
  }
  return notices.length ? `<main>${notices.join("")}</main>` : undefined;
}

/** Closed-stop rows retain their route pairing and never include replacement boarding columns. */
function closedStopTargets(
  node: Node,
  routeNames: Readonly<Record<string, readonly string[]>>,
): StopTarget[] {
  if (!("tagName" in node)) return [];
  const plain = (value: Node) => stripHtml(serializeOuter(value)).replace(/\s+/gu, " ").trim();
  let text = plain(node);
  let stopId: string | undefined;
  if (node.tagName === "tr") {
    let table: Node | null = node;
    while (table && !("tagName" in table && table.tagName === "table"))
      table = "parentNode" in table ? table.parentNode : null;
    if (!table) return [];
    const headers: string[] = [];
    const collectHeaders = (value: Node) => {
      if ("tagName" in value && value.tagName === "th") headers.push(plain(value));
      else if ("childNodes" in value) value.childNodes.forEach(collectHeaders);
    };
    collectHeaders(table);
    const firstCell = node.childNodes.find((child) => "tagName" in child && child.tagName === "td");
    if (!firstCell) return [];
    text = plain(firstCell);
    if (headers.some((header) => /^Closed bus stops:$/iu.test(header))) {
      stopId = /\bBus stop #(\d+)\b/iu.exec(text)?.[1];
    } else {
      // A `Stop | Status` table whose rows lead with the feed stop ID: `8737: King Street`.
      const rows: Node[] = [];
      const collectRows = (value: Node) => {
        if ("tagName" in value && value.tagName === "tr") rows.push(value);
        else if ("childNodes" in value) value.childNodes.forEach(collectRows);
      };
      collectRows(table);
      const headerRow = rows[0];
      const headerCell =
        headerRow && "childNodes" in headerRow
          ? headerRow.childNodes.find(
              (child) => "tagName" in child && ["td", "th"].includes(child.tagName),
            )
          : undefined;
      if (headerRow === node || !headerCell || !/^stops?$/iu.test(plain(headerCell))) return [];
      stopId = /^([A-Za-z]*\d+):/u.exec(text)?.[1];
    }
  } else if (node.tagName === "li") {
    stopId = /^Bus stop #(\d+)\b.*? - Routes?\b/iu.exec(text)?.[1];
  } else if (node.tagName === "p") {
    stopId = /\bBus stop #(\d+)\b.*?\b(?:will be|is|are) (?:temporarily )?closed\b/iu.exec(
      text,
    )?.[1];
  }
  if (!stopId) return [];
  const routes = Object.entries(routeNames)
    .filter(([, names]) => names.some((name) => hasWholeToken(text, name)))
    .map(([id]) => id)
    .sort();
  return routes.length ? routes.map((routeId) => ({ stopId, routeId })) : [{ stopId }];
}

// Labelled service windows use their own stated year, never the polling year.
function labelledNoticePeriod(description: string, timeZone: string) {
  if (!/^Route\(s\):/imu.test(description)) return undefined;
  const fields = Object.fromEntries(
    [
      ...description.matchAll(
        /(?:^|\n| )((?:Start |End )?Date|Time):\s*(.*?)(?= (?:End Date):|\n|$)/gimu,
      ),
    ].map((m) => [m[1].toLowerCase(), m[2].trim()]),
  );
  const start = fields["start date"] ?? fields.date;
  const end = fields["end date"] ?? fields.date;
  const clock = fields.time?.match(
    /^(\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?) (?:to|-) (\d{1,2}(?::\d{2})?\s*[ap]\.?m\.?)$/iu,
  );
  function timestamp(date: string, time: string) {
    const year = /\b(\d{4})\b/u.exec(date)?.[1];
    if (!year) throw new Error("Labelled notice requires an explicit date year");
    return publishedAdvisoryTimestamp(
      date.replace(/\bSept\.?/giu, "Sep").replace(/\b([A-Za-z]{3})\./gu, "$1"),
      time,
      Number(year),
      timeZone,
    );
  }
  const startsAt = start ? timestamp(start, clock?.[1] ?? "12:00 am") : 0;
  const endsAt =
    end && /\b\d{1,2},? \d{4}\b/u.test(end) && !/N\/A|until further notice/iu.test(end)
      ? timestamp(end, clock?.[2] ?? "11:59 pm") + (clock ? 0 : 59_000)
      : undefined;
  if (endsAt !== undefined && endsAt < startsAt) throw new Error("Invalid labelled notice period");
  const windows = [{ startsAt, ...(endsAt === undefined ? {} : { endsAt }) }];
  if (clock && start && end && endsAt !== undefined) {
    const dateFormat = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "long",
      day: "numeric",
    });
    const finalDate = dateFormat.format(timestamp(end, "12:00 pm"));
    windows.length = 0;
    for (let day = timestamp(start, "12:00 pm"); ; day += 86_400_000) {
      if (windows.length >= 366) throw new Error("Labelled daily notice exceeds one year");
      const date = dateFormat.format(day);
      windows.push({ startsAt: timestamp(date, clock[1]), endsAt: timestamp(date, clock[2]) });
      if (date === finalDate) break;
    }
  }
  return { windows };
}
