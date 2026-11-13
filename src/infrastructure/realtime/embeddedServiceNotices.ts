import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { parseWallClock } from "./wallClock";
import type { DecodedFeed, GenericAlert } from "./gtfsRealtimeDecoder";
import type { PublicationReference } from "./headingServiceNoticesParser";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
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
const datePattern =
  /\b(January|February|March|April|May|June|July|August|September|October|November|December|Jan|Feb|Mar|Apr|Jun|Jul|Aug|Sep|Sept|Oct|Nov|Dec)\.?\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?\b/giu;
function elements(node: Node): Element[] {
  return "childNodes" in node
    ? node.childNodes.flatMap((child) =>
        "tagName" in child ? [child, ...elements(child)] : elements(child),
      )
    : [];
}
const hasClass = (node: Element, name: string) =>
  node.attrs
    .find((a) => a.name === "class")
    ?.value.split(/\s+/u)
    .includes(name);
const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
const serviceText =
  /\b(?:detour|construction|service reductions?|not be running|end service|suspend(?:ed|sion)?|cancel(?:led|ed|lations?)?|service schedule)\b/iu;

/** Embedded public posts and bulletin cards are bounded independently of site navigation. */
export function embeddedServiceNotices(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>>,
  timeZone: string,
  reference?: PublicationReference,
): DecodedFeed | undefined {
  const all = elements(parse(html));
  const social = all.filter((n) => hasClass(n, "fts-jal-single-fb-post"));
  const bulletins: Element[] = [];
  let section = "";
  for (const node of all) {
    if (node.tagName === "h3") section = plain(node);
    if (
      /^Service Bulletins$/iu.test(section) &&
      hasClass(node, "list-group-item") &&
      elements(node).some((child) => hasClass(child, "fa-exclamation-triangle"))
    )
      bulletins.push(node);
  }
  if (!social.length && !bulletins.length) return undefined;
  const alerts: GenericAlert[] = [];
  for (const card of social.length ? social : bulletins) {
    const children = elements(card);
    const message = social.length ? children.find((n) => hasClass(n, "fts-jal-fb-message")) : card;
    const heading = children.find((n) => /^h[1-6]$/u.test(n.tagName));
    if (!message || !plain(message) || (!social.length && !heading))
      throw new Error("Incomplete embedded service notice");
    let description = plain(message)
      .replace(/last updated \d{1,2}\/\d{1,2}\/\d{4} \d{1,2}:\d{2}:\d{2} [AP]M/iu, "")
      .trim();
    if (social.length && !serviceText.test(description)) continue;
    let title = heading ? plain(heading) : description.split(/(?<=[.!?])\s/u)[0];
    if (/^No weather bulletins$/iu.test(title)) continue;
    if (/^Heads up[,!]/iu.test(title))
      title =
        description
          .slice(title.length)
          .trim()
          .split(/(?<=[.!?])\s/u)[0] || title;
    if (!social.length) description = description.slice(title.length).trim();
    const full = `${title} ${description}`;
    const publication = /last updated \d{1,2}\/\d{1,2}\/(\d{4})/iu.exec(plain(card));
    const year = publication ? Number(publication[1]) : reference?.publicationYear;
    if (
      reference &&
      (new Date(now).toISOString().slice(0, 10) < reference.validFrom ||
        new Date(now).toISOString().slice(0, 10) > reference.validThrough)
    )
      throw new Error("Embedded notice publication reference expired");
    const dates = [...full.matchAll(datePattern)];
    const first = dates[0];
    let startsAt = 0;
    let endsAt: number | undefined;
    if (first && (first[3] || year)) {
      const month =
        months.findIndex((m) => m.startsWith(first[1].toLowerCase().replace(/\.$/u, ""))) + 1;
      const date = `${first[3] || year}-${String(month).padStart(2, "0")}-${first[2].padStart(2, "0")}`;
      startsAt = parseWallClock(`${date} 00:00:00`, timeZone);
      const clock = /end service\b.*?\bat (\d{1,2}):(\d{2})\s*([AP])\.?M/iu.exec(full);
      if (clock)
        startsAt = parseWallClock(
          `${date} ${String((Number(clock[1]) % 12) + (clock[3].toUpperCase() === "P" ? 12 : 0)).padStart(2, "0")}:${clock[2]}:00`,
          timeZone,
        );
      if (
        !/\b(?:starting|begin|beginning|until|through)\b/iu.test(full) ||
        /not be running|end service/iu.test(full)
      ) {
        const next = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000)
          .toISOString()
          .slice(0, 10);
        endsAt = parseWallClock(`${next} 00:00:00`, timeZone);
      }
      if (
        /\b(?:detour ends|return to regular service|regular service.*resume)\b/iu.test(full) &&
        !/end service|not be running/iu.test(full)
      ) {
        endsAt = parseWallClock(`${date} 00:00:00`, timeZone);
        startsAt = 0;
      }
    }
    const routeTokens = [
      ...full.matchAll(
        /\broutes?\s+(\d+[A-Za-z]?(?:-\d+)?(?:(?:\s*,\s*(?:and\s+)?|\s+(?:and|&)\s+|\s*\/\s*)\d+[A-Za-z]?(?:-\d+)?)*)/giu,
      ),
    ].map((m) => m[1]);
    const routeIds = Object.entries(routeNames)
      .filter(([, names]) =>
        names.some((name) =>
          routeTokens.some((s) =>
            [...s.matchAll(/\d+[A-Za-z]?(?:-\d+)?/gu)].some(
              (t) => t[0].toLowerCase() === name.toLowerCase(),
            ),
          ),
        ),
      )
      .map(([id]) => id)
      .sort();
    const scopeText = full.replace(/\b(St|Dr|Ave|Rd|Blvd)\./giu, "$1");
    const closed = scopeText.match(
      /\b(?:unable to service|not servic(?:e|ing)|not serv(?:e|ing)|closed)\s+stops?\b[^.!?]*/iu,
    )?.[0];
    const stops = closed ? [...new Set([...closed.matchAll(/\b\d{3,}\b/gu)].map((m) => m[0]))] : [];
    const targets = stops.flatMap((stopId) =>
      (routeIds.length ? routeIds : [undefined]).map((routeId) => ({
        stopId,
        ...(routeId ? { routeId } : {}),
      })),
    );
    alerts.push({
      id: `${source}#${title}`,
      title,
      description,
      startsAt,
      ...(endsAt === undefined ? {} : { endsAt }),
      routeIds,
      ...(targets.length ? { targets, affectedStations: stops } : {}),
      updatedAt: now,
    });
  }
  return {
    header: { version: "embedded-service-notices", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}
