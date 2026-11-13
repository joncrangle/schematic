import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { formatNoticeText } from "./htmlNoticeText";
import { parseWallClock } from "./wallClock";
import type { DecodedFeed } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
const allElements = (node: Node): Element[] =>
  "childNodes" in node
    ? node.childNodes.flatMap((child) =>
        "tagName" in child ? [child, ...allElements(child)] : allElements(child),
      )
    : [];
const attr = (node: Element, name: string) => node.attrs.find((a) => a.name === name)?.value;
const hasClass = (node: Element, name: string) => attr(node, "class")?.split(/\s+/u).includes(name);
const plain = (node: Node) => stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
const candidate =
  /autobus|transport|circuits?|d[ée]tours?|travaux|circulation|fermeture|incident|cong[ée]|f[ée]ri[ée]|temp[êe]te|verglas/iu;
const transit = /autobus|transport en commun|transport collectif|minibus|circuits?\s+\d/iu;
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
function dateOf(text: string, zone: string): number {
  const iso = /(?:^|\/)(20\d\d-\d\d-\d\d)(?:\/|$)/u.exec(text)?.[1];
  if (iso) return parseWallClock(`${iso} 00:00:00`, zone);
  const french = /\b(\d{1,2})\s+(\p{L}+)\s+(20\d{2})\b/u.exec(text);
  const month = french && months.indexOf(french[2].toLowerCase());
  if (!french || month === null || month < 0) throw new Error("Unreadable municipal news date");
  return parseWallClock(
    `${french[3]}-${String(month + 1).padStart(2, "0")}-${french[1].padStart(2, "0")} 00:00:00`,
    zone,
  );
}

function publishedEnd(title: string, published: number, zone: string): number | undefined {
  const names = months.join("|");
  const range = new RegExp(
    `\\bdu\\s+(\\d{1,2})(?:\\s+(${names}))?\\s+au\\s+(\\d{1,2})\\s+(${names})(?:\\s+(20\\d{2}))?`,
    "iu",
  ).exec(title);
  if (!range) return undefined;
  const month = months.indexOf(range[4].toLowerCase()) + 1;
  const year = Number(
    range[5] ??
      new Intl.DateTimeFormat("en", { timeZone: zone, year: "numeric" }).format(published),
  );
  const date = `${year}-${String(month).padStart(2, "0")}-${range[3].padStart(2, "0")}`;
  parseWallClock(`${date} 00:00:00`, zone);
  const following = new Date(Date.parse(`${date}T12:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return parseWallClock(`${following} 00:00:00`, zone);
}
const disruption =
  /retards?|annul|suspend|d[ée]tour|d[ée]plac|non desserv|ferm[ée]|r[ée]percussions|impacts?|perturb|r[ée]duit|all[ée]g[ée]/iu;

/** News archives supply candidates; full articles establish whether public transit is affected. */
export function decodeMunicipalNews(
  html: string,
  source: string,
  now: number,
  timeZone: string,
): { feed: DecodedFeed; pageUrls: string[] } | undefined {
  const all = allElements(parse(html));
  const feed: DecodedFeed = {
    header: { version: "municipal-news", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: [],
  };
  const newsDetail = all.some((n) => hasClass(n, "page-top-no-image__title--news"));
  const body =
    all.find((n) => hasClass(n, "CommuniquesWrap")) ??
    (newsDetail ? all.find((n) => hasClass(n, "main__dynamic")) : undefined);
  if (body) {
    const title = all.filter((n) => n.tagName === "h1").at(-1);
    if (!title || !plain(title) || !plain(body))
      throw new Error("Incomplete municipal news article");
    const startsAt = dateOf(
      source.includes("/communiques/")
        ? new URL(source).pathname
        : plain(all.find((n) => hasClass(n, "page-top-no-image__metas")) ?? body),
      timeZone,
    );
    const description = formatNoticeText(body, source).replace(/\s+/gu, " ").trim();
    // A dated archive is a news channel, not a standing service-advisory board.
    const transitDisruption = allElements(body)
      .filter((n) => n.tagName === "p" || n.tagName === "li")
      .some((n) => transit.test(plain(n)) && disruption.test(plain(n)));
    if (!transitDisruption) return { feed, pageUrls: [] };
    const endsAt = publishedEnd(plain(title), startsAt, timeZone);
    if (endsAt !== undefined && endsAt <= now) return { feed, pageUrls: [] };
    const reopened = allElements(body)
      .filter((n) => n.tagName === "p")
      .slice(0, 2)
      .some((n) =>
        /^Toutes les rues sont maintenant ouvertes à la circulation[.!]?$/iu.test(plain(n)),
      );
    if (reopened) return { feed, pageUrls: [] };
    return {
      feed: {
        ...feed,
        alerts: [
          {
            id: source,
            title: plain(title),
            description,
            startsAt,
            ...(endsAt === undefined ? {} : { endsAt }),
            routeIds: [],
            updatedAt: now,
          },
        ],
      },
      pageUrls: [],
    };
  }
  const cards = all.filter((n) => hasClass(n, "d-flex-comm") || hasClass(n, "news-list__item"));
  if (!cards.length) return undefined;
  const pageUrls: string[] = [];
  for (const card of cards) {
    const children = allElements(card);
    const title = children.find((n) => n.tagName === "h5" || hasClass(n, "news-list__title"));
    const date = children.find((n) => hasClass(n, "comm-date") || hasClass(n, "news-list__metas"));
    const link = children.find((n) => n.tagName === "a" && hasClass(n, "news-list__link"));
    const href = link
      ? attr(link, "href")
      : /^document\.location='([^']+)'$/u.exec(attr(card, "onclick") ?? "")?.[1];
    if (!title || !date || !href || !plain(title))
      throw new Error("Incomplete municipal news card");
    dateOf(plain(date), timeZone);
    if (!candidate.test(plain(card))) continue;
    const url = new URL(href, source);
    if (url.origin !== new URL(source).origin) throw new Error("Foreign municipal news article");
    pageUrls.push(url.href);
  }
  // Earlier archive months remain candidates until the publisher resolves their notices.
  const controls = all.flatMap((n) => {
    const match = /^javascript:fChangeComm\('[^']+','(\d{4})','(\d{1,2})'\)$/u.exec(
      attr(n, "href") ?? "",
    );
    return match ? [{ year: Number(match[1]), month: Number(match[2]) }] : [];
  });
  if (controls.length) {
    const path = /\.load\('([^']+)\?y='/u.exec(html)?.[1];
    if (!path) throw new Error("Missing municipal news archive endpoint");
    for (const { year, month } of controls) {
      if (month < 1 || month > 12) throw new Error("Invalid municipal archive month");
      pageUrls.push(new URL(`${path}?y=${year}&m=${month}`, source).href);
    }
  }
  return { feed, pageUrls: [...new Set(pageUrls)] };
}
