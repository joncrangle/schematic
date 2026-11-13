import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "./stripHtml";
import { formatNoticeText } from "./htmlNoticeText";
import type { DecodedFeed, GenericAlert } from "./gtfsRealtimeDecoder";

type Node = DefaultTreeAdapterTypes.Node;

type Block =
  | { readonly kind: "heading"; readonly text: string }
  | {
      readonly kind: "paragraph";
      readonly plain: string;
      readonly formatted: string;
    }
  | { readonly kind: "separator" | "list" };

function plainText(node: Node): string {
  return stripHtml(serializeOuter(node)).replace(/\s+/gu, " ").trim();
}

function collectBlocks(node: Node, source: string, blocks: Block[]): void {
  if (!("childNodes" in node)) return;
  for (const child of node.childNodes) {
    if (!("tagName" in child)) continue;
    const tag = child.tagName;
    if (["nav", "footer", "aside", "script", "style"].includes(tag)) continue;
    if (/^h[1-6]$/u.test(tag)) {
      const text = plainText(child);
      if (text) blocks.push({ kind: "heading", text });
      continue;
    }
    if (tag === "p") {
      const plain = plainText(child);
      if (plain) {
        blocks.push({
          kind: "paragraph",
          plain,
          formatted: formatNoticeText(child, source).replace(/\s+/gu, " ").trim(),
        });
      }
      continue;
    }
    if (tag === "hr") {
      blocks.push({ kind: "separator" });
      continue;
    }
    if (tag === "ul" || tag === "ol") {
      blocks.push({ kind: "list" });
      continue;
    }
    collectBlocks(child, source, blocks);
  }
}

function normalizeHeading(text: string): string {
  return text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean)
    .join(" ");
}

function isServiceAnnouncementHeading(text: string): boolean {
  const normalized = normalizeHeading(text);
  return normalized === "service announcement" || normalized === "service announcements";
}

function isNoticeParagraph(text: string): boolean {
  const words = text
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter(Boolean);
  const hasPhrase = (...tokens: string[]) =>
    words.some((_, index) => tokens.every((token, offset) => words[index + offset] === token));
  return (
    words.some((word) =>
      ["closed", "closure", "construction", "reconstruction", "detour", "diversion"].includes(word),
    ) ||
    hasPhrase("not", "servicing") ||
    hasPhrase("not", "serving") ||
    hasPhrase("not", "stopping") ||
    hasPhrase("service", "disruption") ||
    hasPhrase("service", "advisory") ||
    hasPhrase("service", "alert") ||
    hasPhrase("service", "alerts") ||
    hasPhrase("stop", "unavailable")
  );
}

function hasWholeToken(text: string, alias: string): boolean {
  const normalizedText = text.toLowerCase();
  const normalizedAlias = alias.trim().toLowerCase();
  if (!normalizedAlias) return false;
  let index = normalizedText.indexOf(normalizedAlias);
  while (index >= 0) {
    const before = normalizedText[index - 1] ?? "";
    const after = normalizedText[index + normalizedAlias.length] ?? "";
    if (!/[a-z0-9]/u.test(before) && !/[a-z0-9]/u.test(after)) return true;
    index = normalizedText.indexOf(normalizedAlias, index + 1);
  }
  return false;
}

function explicitRouteText(text: string): string[] {
  const clauses: string[] = [];
  const marker = /\broutes?\b/giu;
  const routeListTerminator =
    /\b(?:will|would|is|are|was|were|has|have|had|can|could|may|might|must|should|shall|do|does|did|be|being|been|follow|use|detour|remain|close|closed|suspend|suspended|serve|travel|operate|continue|not)\b/iu;
  for (const match of text.matchAll(marker)) {
    const afterMarker = text
      .slice((match.index ?? 0) + match[0].length)
      .replace(/^\s*[:#-]?\s*/u, "");
    const sentence = afterMarker.split(/[.!?;]/u, 1)[0] ?? "";
    const terminator = routeListTerminator.exec(sentence);
    clauses.push(terminator ? sentence.slice(0, terminator.index) : sentence);
  }
  return clauses;
}

function declaredRouteIds(
  text: string,
  routeNames: Readonly<Record<string, readonly string[]>>,
): string[] {
  const routeClauses = explicitRouteText(text);
  return Object.entries(routeNames)
    .filter(([, aliases]) =>
      aliases.some((alias) => {
        const withoutPrefix = alias.replace(/^routes?\s+/iu, "");
        return routeClauses.some((clause) => hasWholeToken(clause, withoutPrefix));
      }),
    )
    .map(([routeId]) => routeId)
    .sort();
}

function splitTitleAndDescription(text: string): {
  readonly title: string;
  readonly description?: string;
} {
  for (const match of text.matchAll(/[.!?](?=\s+)/gu)) {
    const boundary = match.index! + match[0].length - 1;
    const remainder = text.slice(boundary + 1).trimStart();
    const firstWord = /^([A-Za-z]+)/u.exec(remainder)?.[1];
    if (firstWord && firstWord.length > 1 && /^[A-Z]/u.test(firstWord)) {
      const title = text.slice(0, boundary + 1).trim();
      const description = remainder.trim();
      return { title, ...(description ? { description } : {}) };
    }
  }
  return { title: text.trim() };
}

/**
 * Reads paragraph notices from a page headed "Service Announcement". Notices
 * stay active while published; prose dates and effects are never inferred.
 */
export function decodeServiceAnnouncementBoard(
  html: string,
  source: string,
  now: number,
  routeNames: Readonly<Record<string, readonly string[]>> = {},
): DecodedFeed {
  const document = parse(html);
  let main: Node | undefined;
  function findMain(node: Node): void {
    if (main || !("childNodes" in node)) return;
    for (const child of node.childNodes) {
      if ("tagName" in child && child.tagName === "main") {
        main = child;
        return;
      }
      findMain(child);
    }
  }
  findMain(document);
  if (!main) throw new Error("Missing main service content");

  const blocks: Block[] = [];
  collectBlocks(main, source, blocks);
  const headingIndex = blocks.findIndex(
    (block) => block.kind === "heading" && isServiceAnnouncementHeading(block.text),
  );
  if (headingIndex < 0) throw new Error("Missing service announcement board");

  const notices: GenericAlert[] = [];
  for (const block of blocks.slice(headingIndex + 1)) {
    if (block.kind === "heading" || block.kind === "list") break;
    if (block.kind !== "paragraph") continue;
    if (!isNoticeParagraph(block.plain)) {
      if (notices.length > 0) break;
      continue;
    }

    const { title, description } = splitTitleAndDescription(block.formatted || block.plain);
    const routeIds = declaredRouteIds(block.plain, routeNames);
    notices.push({
      id: `${source}#${[title, description].filter(Boolean).join(" ")}`,
      title,
      description,
      startsAt: 0,
      routeIds,
      updatedAt: now,
    });
  }
  if (notices.length === 0) {
    throw new Error("No recognizable service announcements; recovery is unconfirmed");
  }
  return {
    header: { version: "service-announcement-board", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts: notices,
  };
}
