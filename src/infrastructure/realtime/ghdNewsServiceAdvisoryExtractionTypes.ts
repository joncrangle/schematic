import type { GhdTemplateVariant } from "./ghdNewsServiceAdvisoryTemplates";

export type GhdTemplateName = GhdTemplateVariant["name"];

export interface GhdExtractedAdvisory {
  readonly titleText?: string;
  readonly titleHref?: string;
  readonly contentText: string;
  readonly postedDateText?: string;
}

export interface GhdExtractedPaginationBlock {
  readonly variant: GhdTemplateName;
  readonly hrefs: readonly string[];
}

export interface GhdExtractedPage {
  /** Set only when a recognized item contains its recognized title link. */
  readonly variant?: GhdTemplateName;
  readonly advisories: readonly GhdExtractedAdvisory[];
  /** First pagination block for each template, in template priority order. */
  readonly paginationBlocks: readonly GhdExtractedPaginationBlock[];
}
