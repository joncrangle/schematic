import { decodeHTML, decodeHTMLAttribute } from "entities";
import {
  GHD_BLOCK_TAGS,
  GHD_EMPTY_NEWSFEED_MESSAGE,
  GHD_EMPTY_NEWSFEED_SECTION_CLASSES,
  GHD_NESTED_VARIANTS,
  GHD_SIBLING_PAIR_VARIANT,
  GHD_TEMPLATE_VARIANTS,
  hasGhdClass,
} from "./ghdNewsServiceAdvisoryTemplates";
import type {
  GhdExtractedAdvisory,
  GhdExtractedPage,
  GhdTemplateName,
} from "./ghdNewsServiceAdvisoryExtractionTypes";

interface RewriterText {
  readonly text: string;
  readonly lastInTextNode: boolean;
}

interface RewriterElement {
  readonly tagName: string;
  getAttribute(name: string): string | null;
  remove(): void;
  onEndTag(handler: () => void): void;
}

interface RewriterHandlers {
  element?(element: RewriterElement): void;
  text?(text: RewriterText): void;
}

interface HTMLRewriterLike {
  on(selector: string, handlers: RewriterHandlers): HTMLRewriterLike;
  transform(response: Response): Response;
}

type HTMLRewriterConstructor = new () => HTMLRewriterLike;

const VOID_TAGS = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);
const PARAGRAPH_CLOSING_START_TAGS = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "details",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "hgroup",
  "hr",
  "li",
  "main",
  "menu",
  "nav",
  "ol",
  "p",
  "pre",
  "search",
  "section",
  "table",
  "dd",
  "dt",
  "ul",
]);
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);
const TABLE_CELL_TAGS = new Set(["td", "th"]);
const TABLE_SECTION_TAGS = new Set(["thead", "tbody", "tfoot"]);
const SELECT_SCOPE_TAGS = new Set(["select", "datalist"]);
const HTML_STRUCTURE_TAGS = new Set([
  ...PARAGRAPH_CLOSING_START_TAGS,
  ...TABLE_CELL_TAGS,
  ...TABLE_SECTION_TAGS,
  "a",
  "table",
  "tr",
  "select",
  "datalist",
  "option",
  "optgroup",
  "thead",
  "tbody",
  "tfoot",
]);

type TextCapture = { readonly parts: string[] };
interface CardCapture {
  readonly variant: GhdTemplateName;
  readonly fallbackParts: string[];
  title?: TextCapture;
  titleHref?: string;
  content?: TextCapture;
  postedDate?: TextCapture;
}
interface PaginationCapture {
  readonly variant: GhdTemplateName;
  readonly hrefs: string[];
}
interface ElementFrame {
  readonly tagName: string;
  readonly isHidden: boolean;
  readonly isTemplate: boolean;
  readonly isVerifiedEmptyNewsFeedSection: boolean;
  readonly emptyNewsFeedMarker?: TextCapture;
  /** True for the section holding a sibling-pair (accordion) board. */
  readonly isSiblingPairSection: boolean;
  /** True for the element holding a sibling-pair board's items, whose emptiness proves an empty board. */
  readonly isBoardContainer: boolean;
  /** The text a board container holds directly. */
  readonly boardText?: TextCapture;
  /** Set when a board container has an element child. */
  boardHasChild?: boolean;
  /** Heading text inside a sibling-pair section, checked against its empty-board heading. */
  readonly siblingPairHeading?: TextCapture;
  readonly startedCaptures: TextCapture[];
  readonly startedCards: CardCapture[];
  readonly startedPagination: PaginationCapture[];
  /** The most recently closed child element, which is the next element's previous sibling. */
  lastClosedChild?: ElementFrame;
  finished: boolean;
}
export interface HTMLRewriterExtractionOptions {
  /** Test seam used to verify text is accumulated across stream chunks. */
  readonly inputChunkBytes?: number;
}

export class UnsupportedGhdMarkupError extends Error {
  constructor(triggerTag: string, openTag: string) {
    super(
      `Unsupported GHD markup: starting <${triggerTag}> implicitly closes <${openTag}> around an advisory field`,
    );
    this.name = "UnsupportedGhdMarkupError";
  }
}

/**
 * Streaming Workers extraction. The response is consumed by HTMLRewriter, so
 * selectors and text callbacks run in workerd's native HTML parser without
 * building a JS DOM. Only compact card and link records survive the stream.
 */
export async function extractGhdPageWithHTMLRewriter(
  html: string,
  options: HTMLRewriterExtractionOptions = {},
): Promise<GhdExtractedPage> {
  const Constructor = (globalThis as typeof globalThis & { HTMLRewriter?: HTMLRewriterConstructor })
    .HTMLRewriter;
  if (!Constructor) throw new Error("HTMLRewriter is available only in Cloudflare Workers");

  const cards: CardCapture[] = [];
  const activeCards: CardCapture[] = [];
  const activeCaptures: TextCapture[] = [];
  const paginationBlocks: PaginationCapture[] = [];
  const activePagination: PaginationCapture[] = [];
  const openElements: ElementFrame[] = [];
  let hiddenDepth = 0;
  let templateDepth = 0;
  let hasVerifiedEmptyNewsFeed = false;
  let sawSiblingPairSection = false;
  let hasSiblingPairEmptyHeading = false;
  let boardContainerCount = 0;
  let boardContainerHasContent = false;
  let lastClosedAtRoot: ElementFrame | undefined;

  const append = (text: string): void => {
    if (hiddenDepth > 0 || templateDepth > 0) return;
    for (const card of activeCards) card.fallbackParts.push(text);
    for (const capture of activeCaptures) capture.parts.push(text);
  };
  const removeLast = <T>(values: T[], value: T): void => {
    const index = values.lastIndexOf(value);
    if (index >= 0) values.splice(index, 1);
  };
  const startCapture = (capture: TextCapture, started: TextCapture[]): void => {
    activeCaptures.push(capture);
    started.push(capture);
  };

  const finishFrame = (frame: ElementFrame): void => {
    if (frame.finished) return;
    frame.finished = true;
    if (GHD_BLOCK_TAGS.has(frame.tagName)) append("\n");
    if (
      frame.emptyNewsFeedMarker &&
      normalizeText(frame.emptyNewsFeedMarker.parts.join("")) === GHD_EMPTY_NEWSFEED_MESSAGE
    ) {
      hasVerifiedEmptyNewsFeed = true;
    }
    if (frame.isBoardContainer) {
      boardContainerCount += 1;
      if (frame.boardHasChild || normalizeText((frame.boardText?.parts ?? []).join("")) !== "") {
        boardContainerHasContent = true;
      }
    }
    if (
      frame.siblingPairHeading &&
      normalizeText(frame.siblingPairHeading.parts.join("")) ===
        GHD_SIBLING_PAIR_VARIANT?.emptyHeading
    ) {
      hasSiblingPairEmptyHeading = true;
    }
    for (const capture of [...frame.startedCaptures].reverse()) removeLast(activeCaptures, capture);
    for (const block of frame.startedPagination) removeLast(activePagination, block);
    for (const card of [...frame.startedCards].reverse()) removeLast(activeCards, card);
    if (frame.isHidden) hiddenDepth = Math.max(0, hiddenDepth - 1);
    if (frame.isTemplate) templateDepth = Math.max(0, templateDepth - 1);
    removeLast(openElements, frame);
    const parent = openElements.at(-1);
    if (parent) parent.lastClosedChild = frame;
    else lastClosedAtRoot = frame;
  };
  const closeFrom = (index: number): void => {
    while (openElements.length > index) finishFrame(openElements[openElements.length - 1]!);
  };
  const closeFrame = (frame: ElementFrame): void => {
    if (frame.finished) return;
    const index = openElements.lastIndexOf(frame);
    if (index >= 0) closeFrom(index);
    else finishFrame(frame);
  };
  const closeImplicitAt = (index: number, triggerTag: string): void => {
    const frame = openElements[index]!;
    const ownershipMoved = openElements
      .slice(index + 1)
      .some(
        (descendant) =>
          descendant.startedCaptures.length > 0 ||
          descendant.startedCards.length > 0 ||
          descendant.startedPagination.length > 0,
      );
    // Native HTML recovery may end a wrapper while it owns descendant cards or
    // fields. Rebuilding the full tree here would erase the streaming benefit;
    // reject that page so the adapter reports a source failure (or a partial
    // subpage read) instead of a complete empty board.
    if (ownershipMoved) throw new UnsupportedGhdMarkupError(triggerTag, frame.tagName);
    closeFrom(index);
  };
  const closeLastOpen = (predicate: (frame: ElementFrame) => boolean, triggerTag: string): void => {
    for (let index = openElements.length - 1; index >= 0; index -= 1) {
      if (predicate(openElements[index]!)) {
        closeImplicitAt(index, triggerTag);
        return;
      }
    }
  };
  const closeLastOpenInScope = (
    predicate: (frame: ElementFrame) => boolean,
    isScope: (frame: ElementFrame) => boolean,
    triggerTag: string,
  ): void => {
    let scopeIndex = -1;
    for (let index = openElements.length - 1; index >= 0; index -= 1) {
      if (isScope(openElements[index]!)) {
        scopeIndex = index;
        break;
      }
    }
    if (scopeIndex < 0) return;
    for (let index = openElements.length - 1; index > scopeIndex; index -= 1) {
      if (predicate(openElements[index]!)) {
        closeImplicitAt(index, triggerTag);
        return;
      }
    }
  };
  const repairImpliedClosures = (tagName: string): void => {
    if (tagName === "a") closeLastOpen((frame) => frame.tagName === "a", tagName);
    if (tagName === "li") {
      let listScope = -1;
      for (let index = openElements.length - 1; index >= 0; index -= 1) {
        if (["ul", "ol", "menu"].includes(openElements[index]!.tagName)) {
          listScope = index;
          break;
        }
      }
      for (let index = openElements.length - 1; index > listScope; index -= 1) {
        if (openElements[index]!.tagName === "li") {
          closeImplicitAt(index, tagName);
          break;
        }
      }
    }
    if (tagName === "dt" || tagName === "dd") {
      let listScope = -1;
      for (let index = openElements.length - 1; index >= 0; index -= 1) {
        if (openElements[index]!.tagName === "dl") {
          listScope = index;
          break;
        }
      }
      for (let index = openElements.length - 1; index > listScope; index -= 1) {
        if (openElements[index]!.tagName === "dt" || openElements[index]!.tagName === "dd") {
          closeImplicitAt(index, tagName);
          break;
        }
      }
    }
    if (TABLE_CELL_TAGS.has(tagName)) {
      closeLastOpenInScope(
        (frame) => TABLE_CELL_TAGS.has(frame.tagName),
        (frame) => frame.tagName === "table",
        tagName,
      );
    }
    if (tagName === "tr" || TABLE_SECTION_TAGS.has(tagName)) {
      closeLastOpenInScope(
        (frame) => TABLE_CELL_TAGS.has(frame.tagName),
        (frame) => frame.tagName === "table",
        tagName,
      );
      closeLastOpenInScope(
        (frame) => frame.tagName === "tr",
        (frame) => frame.tagName === "table",
        tagName,
      );
    }
    if (TABLE_SECTION_TAGS.has(tagName)) {
      closeLastOpenInScope(
        (frame) => TABLE_SECTION_TAGS.has(frame.tagName),
        (frame) => frame.tagName === "table",
        tagName,
      );
    }
    if (tagName === "option" || tagName === "optgroup") {
      closeLastOpenInScope(
        (frame) => frame.tagName === "option",
        (frame) => SELECT_SCOPE_TAGS.has(frame.tagName),
        tagName,
      );
    }
    if (tagName === "optgroup") {
      closeLastOpenInScope(
        (frame) => frame.tagName === "optgroup",
        (frame) => frame.tagName === "select",
        tagName,
      );
    }
    if (HEADING_TAGS.has(tagName)) {
      closeLastOpen((frame) => HEADING_TAGS.has(frame.tagName), tagName);
    }
    if (PARAGRAPH_CLOSING_START_TAGS.has(tagName)) {
      closeLastOpen((frame) => frame.tagName === "p", tagName);
    }
  };

  const rewriter = new Constructor()
    .on("html", {
      element(element) {
        // Extraction only needs the callbacks; emitting the unchanged document
        // creates a large stream of output chunks that the caller must drain.
        element.remove();
      },
    })
    .on(relevantMarkupSelector(), {
      element(element) {
        const tagName = element.tagName.toLowerCase();
        if (templateDepth > 0) {
          if (tagName === "template") {
            templateDepth += 1;
            element.onEndTag(() => {
              templateDepth = Math.max(0, templateDepth - 1);
            });
          }
          return;
        }

        repairImpliedClosures(tagName);
        const classAttribute = decodeHTMLAttribute(element.getAttribute("class") ?? "");
        const startedCaptures: TextCapture[] = [];
        const startedCards: CardCapture[] = [];
        const startedPagination: PaginationCapture[] = [];
        const parentCards = [...activeCards];
        const parentFrame = openElements.at(-1);
        const emptyNewsFeedMarker =
          tagName === "p" && parentFrame?.isVerifiedEmptyNewsFeedSection
            ? { parts: [] }
            : undefined;
        if (emptyNewsFeedMarker) startCapture(emptyNewsFeedMarker, startedCaptures);

        // A sibling-pair board names its advisory by a tab and puts the body in
        // the next element sibling, so the tab starts a card and the sibling body
        // is attached to it when it opens.
        const siblingPair = GHD_SIBLING_PAIR_VARIANT;
        const insideSiblingPairSection = openElements.some((frame) => frame.isSiblingPairSection);
        const isSiblingPairSection =
          siblingPair?.container !== undefined &&
          tagName === "section" &&
          hasGhdClass(classAttribute, siblingPair.container);
        if (isSiblingPairSection) sawSiblingPairSection = true;
        let siblingPairHeading: TextCapture | undefined;
        if (parentFrame?.isBoardContainer) parentFrame.boardHasChild = true;
        const isBoardContainer =
          insideSiblingPairSection &&
          siblingPair?.board !== undefined &&
          hasGhdClass(classAttribute, siblingPair.board);
        const boardText: TextCapture | undefined = isBoardContainer ? { parts: [] } : undefined;
        if (boardText) startCapture(boardText, startedCaptures);
        if (siblingPair && insideSiblingPairSection) {
          if (HEADING_TAGS.has(tagName)) {
            siblingPairHeading = { parts: [] };
            startCapture(siblingPairHeading, startedCaptures);
          }
          if (tagName === "div" && hasGhdClass(classAttribute, siblingPair.content)) {
            const previous = parentFrame ? parentFrame.lastClosedChild : lastClosedAtRoot;
            const tabCard = previous?.startedCards.find(
              (card) => card.variant === siblingPair.name && card.content === undefined,
            );
            if (tabCard) {
              tabCard.content = { parts: [] };
              startCapture(tabCard.content, startedCaptures);
            }
          }
          if (tagName === "p" && hasGhdClass(classAttribute, siblingPair.item)) {
            const card: CardCapture = { variant: siblingPair.name, fallbackParts: [] };
            cards.push(card);
            activeCards.push(card);
            startedCards.push(card);
          }
        }

        // parse5 treats script/style as one blank space and excludes their text.
        const isHiddenTag = tagName === "script" || tagName === "style";
        if (isHiddenTag) append(" ");
        if (tagName === "br") append("\n");

        for (const variant of GHD_TEMPLATE_VARIANTS) {
          // A sibling-pair board starts its cards and attaches its bodies above.
          const isNested = variant.layout === undefined;
          const itemMatches = isNested && hasGhdClass(classAttribute, variant.item);
          const titleMatches = tagName === "a" && hasGhdClass(classAttribute, variant.title);
          const contentMatches = isNested && hasGhdClass(classAttribute, variant.content);
          const dateMatches = Boolean(
            variant.postedDate && hasGhdClass(classAttribute, variant.postedDate),
          );
          const paginationMatches =
            variant.pagination !== undefined && hasGhdClass(classAttribute, variant.pagination);

          // A matching field belongs to every enclosing advisory, just as a
          // descendant search in the reference tree does.
          for (const card of parentCards) {
            if (card.variant !== variant.name) continue;
            if (titleMatches && !card.title) {
              card.title = { parts: [] };
              card.titleHref = element.getAttribute("href") ?? undefined;
              startCapture(card.title, startedCaptures);
            }
            if (contentMatches && !card.content) {
              card.content = { parts: [] };
              startCapture(card.content, startedCaptures);
            }
            if (dateMatches && !card.postedDate) {
              card.postedDate = { parts: [] };
              startCapture(card.postedDate, startedCaptures);
            }
          }

          if (paginationMatches) {
            const block: PaginationCapture = { variant: variant.name, hrefs: [] };
            paginationBlocks.push(block);
            activePagination.push(block);
            startedPagination.push(block);
          }

          if (itemMatches) {
            const card: CardCapture = { variant: variant.name, fallbackParts: [] };
            cards.push(card);
            activeCards.push(card);
            startedCards.push(card);
          }
        }
        if (tagName === "a") {
          const href = element.getAttribute("href");
          if (href !== null) {
            for (const block of activePagination) block.hrefs.push(href);
          }
        }

        const isTemplate = tagName === "template";
        const frame: ElementFrame = {
          tagName,
          isHidden: isHiddenTag,
          isTemplate,
          isVerifiedEmptyNewsFeedSection:
            tagName === "section" &&
            GHD_EMPTY_NEWSFEED_SECTION_CLASSES.every((className) =>
              hasGhdClass(classAttribute, className),
            ),
          ...(emptyNewsFeedMarker !== undefined ? { emptyNewsFeedMarker } : {}),
          isSiblingPairSection,
          isBoardContainer,
          ...(boardText !== undefined ? { boardText } : {}),
          ...(siblingPairHeading !== undefined ? { siblingPairHeading } : {}),
          startedCaptures,
          startedCards,
          startedPagination,
          finished: false,
        };
        openElements.push(frame);
        if (isHiddenTag) hiddenDepth += 1;
        if (isTemplate) templateDepth += 1;
        if (VOID_TAGS.has(tagName)) closeFrame(frame);
        else element.onEndTag(() => closeFrame(frame));
      },
      text(text) {
        if (hiddenDepth > 0 || templateDepth > 0) return;
        append(text.text);
      },
    });

  const input =
    options.inputChunkBytes === undefined ? html : makeInputBody(html, options.inputChunkBytes);
  await consumeBody(rewriter.transform(new Response(input)));
  // Native callbacks do not emit end tags for every element left open at EOF.
  closeFrom(0);

  // A sibling-pair board is read only when no nested card exists, matching the
  // reference extractor's precedence. Its tab needs both a title and a body.
  const hasNestedCards = cards.some((card) =>
    GHD_NESTED_VARIANTS.some((candidate) => candidate.name === card.variant),
  );
  const isRecognizedCard = (card: CardCapture): boolean =>
    card.title !== undefined &&
    (card.variant !== GHD_SIBLING_PAIR_VARIANT?.name ||
      (!hasNestedCards && card.content !== undefined));
  const cardVariant = GHD_TEMPLATE_VARIANTS.find((candidate) =>
    cards.some((card) => card.variant === candidate.name && isRecognizedCard(card)),
  );
  const hasSiblingPairCards = cards.some((card) => card.variant === GHD_SIBLING_PAIR_VARIANT?.name);
  const hasEmptySiblingPairBoard =
    !hasNestedCards &&
    !hasSiblingPairCards &&
    sawSiblingPairSection &&
    hasSiblingPairEmptyHeading &&
    boardContainerCount > 0 &&
    !boardContainerHasContent;
  const variant =
    cardVariant ??
    (hasEmptySiblingPairBoard
      ? GHD_SIBLING_PAIR_VARIANT
      : cards.length === 0 && hasVerifiedEmptyNewsFeed
        ? GHD_TEMPLATE_VARIANTS.find((candidate) => candidate.name === "news-feed-list")
        : undefined);
  const advisories: GhdExtractedAdvisory[] = cardVariant
    ? cards
        .filter((card) => card.variant === cardVariant.name)
        .map((card) =>
          cardVariant.layout === "sibling-pair"
            ? {
                titleText:
                  card.title && card.content ? normalizeText(card.title.parts.join("")) : undefined,
                contentText: normalizeText((card.content?.parts ?? []).join("")),
              }
            : {
                titleText: card.title ? normalizeText(card.title.parts.join("")) : undefined,
                titleHref:
                  card.titleHref === undefined ? undefined : decodeHTMLAttribute(card.titleHref),
                contentText: normalizeText((card.content?.parts ?? card.fallbackParts).join("")),
                postedDateText: card.postedDate
                  ? normalizeText(card.postedDate.parts.join(""))
                  : undefined,
              },
        )
    : [];

  const pagination = GHD_TEMPLATE_VARIANTS.flatMap((candidate) => {
    const first = paginationBlocks.find((block) => block.variant === candidate.name);
    return first
      ? [{ variant: candidate.name, hrefs: first.hrefs.map((href) => decodeHTMLAttribute(href)) }]
      : [];
  });
  return { variant: variant?.name, advisories, paginationBlocks: pagination };
}

function relevantMarkupSelector(): string {
  const selectors = new Set<string>(["template"]);
  // Empty-state recognition depends on direct parentage, including inline
  // wrappers that do not otherwise affect advisory text or HTML repair.
  selectors.add(`section.${GHD_EMPTY_NEWSFEED_SECTION_CLASSES.join(".")} *`);
  for (const tagName of HTML_STRUCTURE_TAGS) selectors.add(tagName);
  for (const variant of GHD_TEMPLATE_VARIANTS) {
    if (variant.layout === "sibling-pair") {
      // The board's items and bodies are found by position inside its section.
      if (variant.container) selectors.add(`section.${variant.container} *`);
      continue;
    }
    selectors.add(`.${variant.item}`);
    selectors.add(`.${variant.item} *`);
    if (variant.pagination !== undefined) {
      selectors.add(`.${variant.pagination}`);
      selectors.add(`.${variant.pagination} *`);
    }
  }
  return [...selectors].join(", ");
}

function makeInputBody(html: string, chunkBytes?: number): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(html);
  const maxChunkBytes = Math.max(1, Math.floor(chunkBytes ?? bytes.byteLength));
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (let offset = 0; offset < bytes.byteLength; offset += maxChunkBytes) {
        controller.enqueue(bytes.slice(offset, offset + maxChunkBytes));
      }
      controller.close();
    },
  });
}

async function consumeBody(response: Response): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error("HTMLRewriter returned a response without a body");
  try {
    while (!(await reader.read()).done) {
      // HTMLRewriter has already delivered this chunk's parser callbacks. The
      // transformed document is removed so only fragment fallback output is
      // discarded here.
    }
  } finally {
    reader.releaseLock();
  }
}

function normalizeText(text: string): string {
  return decodeHTML(text)
    .split("\n")
    .map((line) => line.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n");
}
