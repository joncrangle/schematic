import { parseFragment, type DefaultTreeAdapterTypes } from "parse5";
import {
  GHD_BLOCK_TAGS,
  GHD_EMPTY_NEWSFEED_MESSAGE,
  GHD_EMPTY_NEWSFEED_SECTION_CLASSES,
  GHD_HEADING_TAGS,
  GHD_NESTED_VARIANTS,
  GHD_SIBLING_PAIR_VARIANT,
  GHD_TEMPLATE_VARIANTS,
  hasGhdClass,
} from "./ghdNewsServiceAdvisoryTemplates";
import type { GhdExtractedPage } from "./ghdNewsServiceAdvisoryExtractionTypes";

type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;

/** Reference extraction path. Keep this as the behavior oracle for Workers. */
export function extractGhdPageWithParse5(html: string): GhdExtractedPage {
  const document = parseFragment(html);
  const variant = GHD_NESTED_VARIANTS.find((candidate) =>
    findElements(document, (element) => hasClass(element, candidate.item)).some((item) =>
      findFirstElement(
        item,
        (element) => element.tagName === "a" && hasClass(element, candidate.title),
      ),
    ),
  );
  const hasKnownCardContainer = GHD_NESTED_VARIANTS.some(
    (candidate) =>
      findElements(document, (element) => hasClass(element, candidate.item)).length > 0,
  );
  const accordion = hasKnownCardContainer ? undefined : extractSiblingPairBoard(document);
  if (accordion && GHD_SIBLING_PAIR_VARIANT) {
    return {
      variant: GHD_SIBLING_PAIR_VARIANT.name,
      advisories: accordion,
      paginationBlocks: paginationBlocks(document),
    };
  }
  const hasVerifiedEmptyNewsFeed = !hasKnownCardContainer && hasRecognizedEmptyNewsFeed(document);

  const advisories = variant
    ? findElements(document, (element) => hasClass(element, variant.item)).map((item) => {
        const titleElement = findFirstElement(
          item,
          (element) => element.tagName === "a" && hasClass(element, variant.title),
        );
        const content =
          findFirstElement(item, (element) => hasClass(element, variant.content)) ?? item;
        const dateElement = variant.postedDate
          ? findFirstElement(item, (element) => hasClass(element, variant.postedDate!))
          : undefined;
        return {
          titleText: titleElement ? textContent(titleElement) : undefined,
          titleHref: titleElement ? attributeValue(titleElement, "href") : undefined,
          contentText: textContent(content),
          postedDateText: dateElement ? textContent(dateElement) : undefined,
        };
      })
    : [];

  return {
    variant: variant?.name ?? (hasVerifiedEmptyNewsFeed ? "news-feed-list" : undefined),
    advisories,
    paginationBlocks: paginationBlocks(document),
  };
}

/**
 * Reads a sibling-pair board: each `p.tab` holds the title link and the very
 * next element sibling holds the body. A tab without its title link or its body
 * sibling comes back without a title, so the page is rejected instead of
 * silently dropping an advisory. Undefined unless the board's section exists and
 * either carries tabs or carries its own empty-board heading.
 */
function extractSiblingPairBoard(document: Node): GhdExtractedPage["advisories"] | undefined {
  const variant = GHD_SIBLING_PAIR_VARIANT;
  const container = variant?.container;
  if (!variant || !container) return undefined;
  const sections = findElements(
    document,
    (element) => element.tagName === "section" && hasClass(element, container),
  );
  const tabs = sections.flatMap((section) =>
    findElements(section, (element) => element.tagName === "p" && hasClass(element, variant.item)),
  );
  if (tabs.length === 0) {
    const hasEmptyHeading = sections.some((section) =>
      findElements(section, (element) => GHD_HEADING_TAGS.has(element.tagName)).some(
        (heading) => textContent(heading) === variant.emptyHeading,
      ),
    );
    // The heading also sits above a populated board, so it proves nothing alone.
    // The board must be present and hold no content at all: anything else in it
    // is markup this parser does not recognise, and that fails the page.
    const boardClass = variant.board;
    const boards = boardClass
      ? sections.flatMap((section) =>
          findElements(section, (element) => hasClass(element, boardClass)),
        )
      : [];
    const everyBoardIsBlank = boards.every(
      (board) => !childNodes(board).some(isElement) && textContent(board) === "",
    );
    return hasEmptyHeading && boards.length > 0 && everyBoardIsBlank ? [] : undefined;
  }
  const advisories = tabs.map((tab) => {
    const titleElement = findFirstElement(
      tab,
      (element) => element.tagName === "a" && hasClass(element, variant.title),
    );
    const body = nextElementSibling(tab);
    const bodyMatches =
      body !== undefined && body.tagName === "div" && hasClass(body, variant.content);
    return {
      titleText: titleElement && bodyMatches ? textContent(titleElement) : undefined,
      contentText: bodyMatches ? textContent(body) : "",
    };
  });
  return advisories.some((advisory) => advisory.titleText !== undefined) ? advisories : undefined;
}

function nextElementSibling(element: Element): Element | undefined {
  const siblings = element.parentNode ? childNodes(element.parentNode) : [];
  const index = siblings.indexOf(element);
  return siblings.slice(index + 1).find(isElement);
}

function hasRecognizedEmptyNewsFeed(document: Node): boolean {
  return findElements(
    document,
    (element) =>
      element.tagName === "section" &&
      GHD_EMPTY_NEWSFEED_SECTION_CLASSES.every((className) => hasClass(element, className)),
  ).some((section) =>
    childNodes(section).some(
      (child) =>
        isElement(child) &&
        child.tagName === "p" &&
        textContent(child) === GHD_EMPTY_NEWSFEED_MESSAGE,
    ),
  );
}

function paginationBlocks(document: Node): GhdExtractedPage["paginationBlocks"] {
  const blocks: NonNullable<GhdExtractedPage["paginationBlocks"]>[number][] = [];
  for (const variant of GHD_TEMPLATE_VARIANTS) {
    const paginationClass = variant.pagination;
    if (paginationClass === undefined) continue;
    const pagination = findFirstElement(document, (element) => hasClass(element, paginationClass));
    if (!pagination) continue;
    blocks.push({
      variant: variant.name,
      hrefs: findElements(pagination, (element) => element.tagName === "a")
        .map((link) => attributeValue(link, "href"))
        .filter((href): href is string => href !== undefined),
    });
  }
  return blocks;
}

function isElement(node: Node): node is Element {
  return "tagName" in node;
}

function childNodes(node: Node): readonly Node[] {
  return "childNodes" in node ? node.childNodes : [];
}

function findElements(node: Node, predicate: (element: Element) => boolean): Element[] {
  const elements: Element[] = [];
  for (const child of childNodes(node)) {
    if (isElement(child)) {
      if (predicate(child)) elements.push(child);
      elements.push(...findElements(child, predicate));
    }
  }
  return elements;
}

function findFirstElement(
  node: Node,
  predicate: (element: Element) => boolean,
): Element | undefined {
  for (const child of childNodes(node)) {
    if (isElement(child)) {
      if (predicate(child)) return child;
      const nested = findFirstElement(child, predicate);
      if (nested) return nested;
    }
  }
  return undefined;
}

function hasClass(element: Element, className: string): boolean {
  return hasGhdClass(attributeValue(element, "class"), className);
}

/** Matches the reference decoder's entity, block, and script/style handling. */
function textContent(node: Node): string {
  const pieces: string[] = [];
  const visit = (current: Node) => {
    if ("value" in current) {
      pieces.push(current.value);
      return;
    }
    if (!isElement(current)) {
      for (const child of childNodes(current)) visit(child);
      return;
    }
    if (current.tagName === "style" || current.tagName === "script") {
      pieces.push(" ");
      return;
    }
    if (current.tagName === "br") pieces.push("\n");
    for (const child of current.childNodes) visit(child);
    if (GHD_BLOCK_TAGS.has(current.tagName)) pieces.push("\n");
  };
  visit(node);
  return pieces
    .join("")
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}

function attributeValue(element: Element, name: string): string | undefined {
  return element.attrs.find((attribute) => attribute.name === name)?.value;
}
