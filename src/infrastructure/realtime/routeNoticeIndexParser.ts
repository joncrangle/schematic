import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import type { DecodedFeed, GenericAlert } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

const EMPTY_REGION = "no service notices at this time";

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function plainText(node: Node): string {
  return stripHtml(serializeOuter(node))
    .replace(/[^\S\uFEFF]+/gu, " ")
    .trim();
}

/** Decoded text that keeps no-break spaces, which separate a title from its route. */
function rawText(node: Node): string {
  if (node.nodeName === "#text") return (node as DefaultTreeAdapterTypes.TextNode).value;
  return "childNodes" in node ? node.childNodes.map(rawText).join("") : "";
}

function classes(element: Element): string[] {
  return (element.attrs.find(({ name }) => name === "class")?.value ?? "").split(/\s+/u);
}

/** Region headings and the nodes between them, in document order. */
function regions(document: Node): { heading: string; nodes: Node[] }[] {
  const found: { heading: string; nodes: Node[] }[] = [];
  function walk(node: Node): void {
    if (!("childNodes" in node)) return;
    for (const child of node.childNodes) {
      if (isElement(child) && /^h[1-6]$/u.test(child.tagName)) {
        if (classes(child).includes("service-region")) {
          found.push({ heading: plainText(child), nodes: [] });
          continue;
        }
        // Any other heading closes the current region.
        if (found.length > 0) found.push({ heading: "", nodes: [] });
        continue;
      }
      const current = found.at(-1);
      if (
        current?.heading &&
        (child.nodeName === "#text" || (isElement(child) && child.tagName === "a"))
      ) {
        current.nodes.push(child);
        continue;
      }
      if (current?.heading && isElement(child) && child.tagName === "hr") continue;
      walk(child);
    }
  }
  walk(document);
  return found.filter((region) => region.heading);
}

/** Reads region-grouped notice links; an unrecognized page or unmapped route never reads as all-clear. */
export function decodeRouteNoticeIndex(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
): DecodedFeed {
  const found = regions(parse(html));
  if (found.length === 0) throw new Error("Missing service notice regions");
  const notices = new Map<string, { title: string; routes: string[]; routeIds: Set<string> }>();
  let partial = false;
  for (const region of found) {
    const links = region.nodes.filter(
      (node): node is Element =>
        isElement(node) &&
        node.attrs.some(
          ({ name, value }) => name === "href" && value.includes("serviceNoticeCode="),
        ),
    );
    if (links.length === 0) {
      const text = region.nodes
        .map(plainText)
        .join(" ")
        .replace(/[^\S\uFEFF]+/gu, " ")
        .trim()
        .toLowerCase();
      if (text !== EMPTY_REGION)
        throw new Error(`Unrecognized service notice region: ${region.heading}`);
      continue;
    }
    for (const link of links) {
      const href = link.attrs.find(({ name }) => name === "href")!.value;
      const url = new URL(href, source);
      const code = url.searchParams.get("serviceNoticeCode")?.trim();
      const routeCode = url.searchParams.get("subscriptionRoute")?.trim();
      if (!code || !routeCode) throw new Error(`Service notice link lacks its codes: ${href}`);
      const [rawTitle, ...rest] = rawText(link).split("\u00a0-\u00a0");
      const title = rawTitle.replace(/[^\S\uFEFF]+/gu, " ").trim();
      const routeName = rest
        .join(" - ")
        .replace(/[^\S\uFEFF]+/gu, " ")
        .trim();
      if (!title) throw new Error(`Service notice ${code} has no title`);
      const routeIds = Object.entries(routeNames)
        .filter(([, aliases]) => aliases.includes(routeCode))
        .map(([routeId]) => routeId);
      if (routeIds.length === 0) {
        partial = true;
        continue;
      }
      const notice = notices.get(code) ?? { title, routes: [], routeIds: new Set<string>() };
      if (routeName && !notice.routes.includes(routeName)) notice.routes.push(routeName);
      for (const routeId of routeIds) notice.routeIds.add(routeId);
      notices.set(code, notice);
    }
  }
  const alerts: GenericAlert[] = [...notices].map(([code, notice]) => {
    const link = new URL(source);
    link.search = "";
    link.hash = "";
    link.searchParams.set("serviceNoticeCode", code);
    return {
      id: link.href,
      title: notice.title,
      description: [...notice.routes, `[Service notice](${link.href})`].join("\n"),
      startsAt: 0,
      routeIds: [...notice.routeIds].sort(),
      updatedAt: now,
    };
  });
  return {
    header: { version: "route-notice-index", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
    ...(partial ? { partial: true } : {}),
  };
}
