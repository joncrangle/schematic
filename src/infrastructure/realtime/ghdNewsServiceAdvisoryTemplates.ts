/**
 * The server-rendered CMS modules used by service advisory boards: the two GHD
 * Digital News card modules and the Umbraco anchored-accordion board. These are
 * CMS shapes, so selectors and the corresponding semantic date behavior stay in
 * one shared declaration for both extractors.
 */
export interface GhdTemplateVariant {
  readonly name: "news-blog" | "news-feed-list" | "anchored-accordion";
  readonly item: string;
  readonly title: string;
  readonly content: string;
  /** The feed-list template renders its posting date outside the advisory body. */
  readonly postedDate?: string;
  /** Boards that paginate declare the block; the accordion board is one page. */
  readonly pagination?: string;
  /**
   * `sibling-pair` boards render the title and the body as consecutive sibling
   * elements (`p.tab` then `div.repeatable-content`) rather than nesting the
   * body inside the item. The default is a body nested in the item.
   */
  readonly layout?: "sibling-pair";
  /** Class of the `section` that holds a sibling-pair board. */
  readonly container?: string;
  /**
   * Class of the element inside that section which holds the board's items. A
   * board is empty only when this element is present and has no content at all.
   */
  readonly board?: string;
  /**
   * Heading that proves a sibling-pair board with zero items is the operator's
   * own empty board rather than a changed or challenge page.
   */
  readonly emptyHeading?: string;
}

export const GHD_TEMPLATE_VARIANTS: readonly GhdTemplateVariant[] = [
  {
    name: "news-blog",
    item: "blogItem",
    title: "newsTitle",
    content: "blogItem-contentContainer",
    pagination: "pagination-container",
  },
  {
    name: "news-feed-list",
    item: "gs-feed-list-item",
    title: "gs-feed-list-title",
    content: "gs-feed-list-description",
    postedDate: "gs-feed-list-date",
    pagination: "pagination",
  },
  {
    name: "anchored-accordion",
    item: "tab",
    title: "anchored-accordion-item",
    content: "repeatable-content",
    layout: "sibling-pair",
    container: "usn_cmp_anchoredaccordion",
    board: "anchored-accordion",
    emptyHeading: "Transit Detours and Service Alerts",
  },
];

/** Variants whose body is nested in the item, in template priority order. */
export const GHD_NESTED_VARIANTS = GHD_TEMPLATE_VARIANTS.filter(
  (variant) => variant.layout === undefined,
);

/** The sibling-pair accordion board, which a page matches only when no nested card exists. */
export const GHD_SIBLING_PAIR_VARIANT = GHD_TEMPLATE_VARIANTS.find(
  (variant) => variant.layout === "sibling-pair",
);

export const GHD_HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "h5", "h6"]);

export const GHD_BLOCK_TAGS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6"]);

/** The only verified no-results marker shared by the current GHD News boards. */
export const GHD_EMPTY_NEWSFEED_SECTION_CLASSES = [
  "content",
  "component",
  "listing-component",
  "usn_cmp_newsfeed",
] as const;
export const GHD_EMPTY_NEWSFEED_MESSAGE = "No articles were found.";

export function hasGhdClass(classAttribute: string | null | undefined, className: string): boolean {
  return classAttribute?.split(/\s+/u).includes(className) ?? false;
}
