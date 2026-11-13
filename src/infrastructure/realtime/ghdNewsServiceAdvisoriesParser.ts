import type { HostingTarget } from "~/infrastructure/env/hostingTarget";
import { validateDecodedFeed, type DecodedFeed, type GenericAlert } from "./gtfsRealtimeDecoder";
import { extractGhdPageWithHTMLRewriter } from "./ghdNewsServiceAdvisoriesHtmlRewriterExtractor";
import { GHD_TEMPLATE_VARIANTS } from "./ghdNewsServiceAdvisoryTemplates";
import { decodeHeadingServiceNotices } from "./headingServiceNoticesParser";
import type { GhdExtractedPage } from "./ghdNewsServiceAdvisoryExtractionTypes";

export type {
  GhdExtractedAdvisory,
  GhdExtractedPage,
} from "./ghdNewsServiceAdvisoryExtractionTypes";

export interface GhdNewsServiceAdvisoriesParserOptions {
  readonly html: string;
  readonly now?: number;
  readonly timeZone?: string;
  /** Minutes a posting stays live when the page states no end date. */
  readonly maxAgeMinutes?: number;
  /** Page the advisories were read from; names accordion items, which carry no link of their own. */
  readonly pageUrl?: string;
}

export interface DecodeGhdPageOptions extends GhdNewsServiceAdvisoriesParserOptions {
  readonly hostingTarget: HostingTarget;
  readonly pageUrl: string;
}

export class UnsupportedGhdPageError extends Error {
  constructor() {
    super("Unsupported GHD advisory page: no recognized card or verified empty-board marker");
    this.name = "UnsupportedGhdPageError";
  }
}

/**
 * Decodes one advisory page and its same-origin pagination links. Cloudflare
 * uses Workers' streaming HTMLRewriter; other runtimes load the parse5 reference
 * extractor. Both paths hand the same compact records to the same interpreter.
 * Ownership-ambiguous HTML recovery on Workers throws and remains a page
 * failure, which the web adapter exposes as unavailable or partial/stale.
 */
export async function decodeGhdPage({
  html,
  hostingTarget,
  pageUrl,
  now = Date.now(),
  timeZone = "America/Toronto",
  maxAgeMinutes,
}: DecodeGhdPageOptions): Promise<{ readonly feed: DecodedFeed; readonly pageUrls: string[] }> {
  const HTMLRewriter = (globalThis as typeof globalThis & { HTMLRewriter?: unknown }).HTMLRewriter;
  const extracted =
    hostingTarget === "cloudflare" && typeof HTMLRewriter === "function"
      ? await extractGhdPageWithHTMLRewriter(html)
      : await (
          await import("./ghdNewsServiceAdvisoriesParse5Extractor")
        ).extractGhdPageWithParse5(html);
  if (extracted.advisories.length === 0 && html.includes("gs-news-details-meta")) {
    return {
      feed: decodeHeadingServiceNotices(html, pageUrl, now, {}, {}, timeZone),
      pageUrls: [],
    };
  }
  const feed = decodeGhdExtractedAdvisories(extracted, { now, timeZone, maxAgeMinutes, pageUrl });
  const details = feed.alerts.flatMap((alert) => {
    if (!/\baffected services\b/iu.test(alert.title)) return [];
    try {
      const target = new URL(alert.id, pageUrl);
      if (target.origin !== new URL(pageUrl).origin || target.hash || target.href === pageUrl)
        return [];
      return [target.href];
    } catch {
      return [];
    }
  });
  return {
    feed: {
      ...feed,
      alerts: feed.alerts.filter((alert) => {
        try {
          return !details.includes(new URL(alert.id, pageUrl).href);
        } catch {
          return true;
        }
      }),
    },
    pageUrls: [...ghdPageUrlsFromExtraction(extracted, pageUrl), ...details],
  };
}

/** Compatibility entry point for callers that only need the decoded feed. */
export async function decodeGhdNewsServiceAdvisories(
  options: GhdNewsServiceAdvisoriesParserOptions,
): Promise<DecodedFeed> {
  return (
    await decodeGhdPage({
      ...options,
      hostingTarget: "self-hosted",
      pageUrl: options.pageUrl ?? "https://ghd.invalid/",
    })
  ).feed;
}

/** Returns pagination URLs for callers that only need the page links. */
export async function ghdNewsServiceAdvisoryPageUrls(
  html: string,
  sourceUrl: string,
): Promise<string[]> {
  const extracted = await (
    await import("./ghdNewsServiceAdvisoriesParse5Extractor")
  ).extractGhdPageWithParse5(html);
  assertGhdPageRecognized(extracted);
  return ghdPageUrlsFromExtraction(extracted, sourceUrl);
}

/** Words that are never route numbers, however they are capitalised. */
const ROUTE_SKIP_WORDS = new Set(["and", "route", "highway", "hwy"]);
/** Words after which a number names a roadway rather than a route. */
const ROUTE_ROADWAY_WORDS = new Set([
  "highway",
  "hwy",
  "avenue",
  "ave",
  "street",
  "st",
  "road",
  "rd",
]);
/** Splits advisory text into candidate tokens the same way the Rust tokenizer does. */
const ROUTE_TOKEN_SPLIT = /[,/\s]/u;
/** Trims the leading and trailing non-alphanumeric characters off a token. */
const NON_ALPHANUMERIC_EDGES = /^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu;
const ASCII_LETTER = /[A-Za-z]/;
/** The word after which a run of stop ids may follow. */
const STOP_WORD = /\bstops?\b/giu;
/** Whitespace or the separators these pages put after the stop word. */
const STOP_SEPARATOR = /[\s:,#-]/u;
/** Characters that may appear inside a run of stop ids, including the word "and". */
const STOP_ID_CHAR = /[\d\s,&and]/iu;
/** An ASCII run of digits, which is what a route number and a day number are. */
const DIGITS_ONLY = /^\d+$/u;
/** Titles indicating that an emergency detour, stop closure, or road disruption has ended. */
const ADVISORY_RESOLUTION_TITLE =
  /\b(?:ended|has ended|cleared|has cleared|reopened|has reopened|resumed|regular service resumed|lifted)\b/i;

/** Month names and the three-letter abbreviations these templates render. */
const MONTHS: Readonly<Record<string, number>> = {
  january: 1,
  jan: 1,
  february: 2,
  feb: 2,
  march: 3,
  mar: 3,
  april: 4,
  apr: 4,
  may: 5,
  june: 6,
  jun: 6,
  july: 7,
  jul: 7,
  august: 8,
  aug: 8,
  september: 9,
  sep: 9,
  october: 10,
  oct: 10,
  november: 11,
  nov: 11,
  december: 12,
  dec: 12,
};
/** Years outside this window are treated as day numbers, not years. */
const EARLIEST_YEAR = 2020;
const LATEST_YEAR = 2050;

/**
 * The label vocabulary every GHD Digital advisory template is written against.
 * Both extraction paths share this interpretation and the Rust daemon carries
 * the matching canonicalisation in `parsers::ghd_news`.
 */
const FIELD_LABELS: Readonly<Record<string, CanonicalField>> = {
  when: "when",
  where: "where",
  reason: "reason",
  why: "reason",
  event: "reason",
  "routes affected": "routes",
  "route affected": "routes",
  "route(s)": "routes",
  routes: "routes",
  route: "routes",
  detour: "detour",
  "alternative stops": "stops",
  "alternative stop": "stops",
  "stops missed": "stops",
  "stop missed": "stops",
  stops: "stops",
  stop: "stops",
};
/** Labels written with several words are only ever written with a colon. */
const SINGLE_WORD_LABELS = new Set(
  Object.keys(FIELD_LABELS).filter((label) => !label.includes(" ")),
);

type CanonicalField = "when" | "where" | "reason" | "routes" | "detour" | "stops";

/**
 * Ceiling on pages read for one advisory board, so the request cost of a
 * refresh is knowable in advance rather than a function of what upstream links.
 */
export const MAX_CRAWL_PAGES = 10;

/**
 * Workers-only crawl ceiling. A board's first pages carry its current
 * advisories; deeper pages are history. Three pages keep a slow-cadence poll
 * of every GHD board inside the per-invocation subrequest budget, while
 * self-hosted keeps the full ten. A source can opt into a larger bounded
 * Workers read when its cold-poll budget permits. The crawl reports itself
 * partial when it stops early, so a capped read never presents as complete.
 */
export const CLOUDFLARE_MAX_CRAWL_PAGES = 3;

export function resolveMaxCrawlPages(
  hostingTarget?: HostingTarget,
  cloudflareMaxCrawlPages?: number,
): number {
  return hostingTarget === "cloudflare"
    ? Math.min(MAX_CRAWL_PAGES, Math.max(1, cloudflareMaxCrawlPages ?? CLOUDFLARE_MAX_CRAWL_PAGES))
    : MAX_CRAWL_PAGES;
}

function decodeGhdExtractedAdvisories(
  extracted: GhdExtractedPage,
  {
    now,
    timeZone,
    maxAgeMinutes,
    pageUrl,
  }: Required<Pick<GhdNewsServiceAdvisoriesParserOptions, "now" | "timeZone">> &
    Pick<GhdNewsServiceAdvisoriesParserOptions, "maxAgeMinutes" | "pageUrl">,
): DecodedFeed {
  assertGhdPageRecognized(extracted);
  const variant = GHD_TEMPLATE_VARIANTS.find((candidate) => candidate.name === extracted.variant);
  if (!variant) throw new UnsupportedGhdPageError();

  const dateFormatters = createDateFormatters(timeZone);
  let currentYear: number | undefined;
  const yearAtNow = (): number => (currentYear ??= yearInZone(now, dateFormatters));
  const alerts = extracted.advisories.flatMap((advisory, index) => {
    const title = advisory.titleText?.replace(/\s+/gu, " ").trim();
    if (!title) return [];
    const lines = advisory.contentText.split("\n");
    if (variant.layout === "sibling-pair") {
      return [decodeSiblingPairAdvisory({ title, lines, now, dateFormatters, pageUrl })];
    }
    const fields = parseLabeledFields(lines);
    const routes = (
      fields.routes === undefined ? titleRouteTokens(title, lines) : routeFieldTokens(fields.routes)
    ).join(" ");
    const routeIds = parseRouteIds(routes);
    const posted =
      advisory.postedDateText !== undefined
        ? parsePostedAt(
            { text: advisory.postedDateText, prefix: "bare" },
            dateFormatters,
            yearAtNow(),
          )
        : parsePostedAt(
            { text: lines.join("\n"), prefix: "posted-on" },
            dateFormatters,
            yearAtNow(),
          );
    const postedAt = posted?.timestamp;
    const defaultYear = posted?.year ?? yearAtNow();
    const stated = parsePeriod(fields.when, dateFormatters, defaultYear);
    const anchor = postedAt ?? now;
    const startsAt = stated?.startsAt ?? anchor;
    const isResolved = ADVISORY_RESOLUTION_TITLE.test(title);
    const endsAt = isResolved
      ? startsAt
      : (stated?.endsAt ?? ageFromPostedAt(anchor, maxAgeMinutes));
    const id = advisory.titleHref || `ghd-advisory-${slug(title)}-${index}`;
    const description = advisoryDescription(lines, title);
    const affectedStations = parseStopIds(lines);

    const alert: GenericAlert = {
      id,
      title,
      description: description || undefined,
      startsAt,
      endsAt,
      routeIds: routeIds.length > 0 ? routeIds : undefined,
      affectedStations: affectedStations.length > 0 ? affectedStations : undefined,
      category: fields.reason,
      effect: !isResolved && mentionsDetour(lines, fields) ? "DETOUR" : undefined,
      updatedAt: postedAt ?? now,
    };
    return [alert];
  });

  return validateDecodedFeed({
    header: { version: "ghd-news", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  });
}

/**
 * Reads one item of a sibling-pair (accordion) board. These boards publish free
 * prose with no labelled fields and no posting date, so every fact is read from
 * the title and body text, and the Rust daemon's `build_gtfs_entity_at` carries
 * the identical rules:
 *
 * - Identity is the page plus the title's slug with the transient `- NEW` marker
 *   removed, because the item's own anchor ordinal shifts when items are inserted.
 * - Routes come from `Route N` / `Routes N … and M` phrases, never from stray
 *   numbers: a stop id, a street number, or a date stays out of the route list.
 * - The period comes from the first line that states a date, preferring the body
 *   over the title. A yearless start uses the occurrence nearest now, narrowed
 *   to years matching a weekday stated directly before the date when present.
 *   A period with no stated end stays open while the item is listed, and a
 *   phrase such as "late Fall 2026" is not a date.
 */
function decodeSiblingPairAdvisory({
  title,
  lines,
  now,
  dateFormatters,
  pageUrl,
}: {
  readonly title: string;
  readonly lines: readonly string[];
  readonly now: number;
  readonly dateFormatters: DateFormatters;
  readonly pageUrl: string | undefined;
}): GenericAlert {
  const routeIds = parseRouteIds(parseRoutePhraseIds([title, ...lines]).join(" "));
  const dateLine = [...lines, title].find(
    (line) => parseAdvisoryDates(line, NEAREST_YEAR_PROBE).length > 0,
  );
  const stated =
    dateLine === undefined ? undefined : parseAccordionPeriod(dateLine, now, dateFormatters);
  const startsAt = stated?.startsAt ?? now;
  const isResolved = ADVISORY_RESOLUTION_TITLE.test(title);
  const endsAt = isResolved ? startsAt : stated?.endsAt;
  const description = advisoryDescription(lines, title);
  const affectedStations = parseStopIds(lines);
  const mentionsDetourInTitle = title.toLowerCase().includes("detour");
  const page = (pageUrl ?? "").split("#")[0];

  return {
    id: `${page}#${slug(stripNewMarker(title)) || "advisory"}`,
    title,
    description: description || undefined,
    startsAt,
    endsAt,
    routeIds: routeIds.length > 0 ? routeIds : undefined,
    affectedStations: affectedStations.length > 0 ? affectedStations : undefined,
    effect:
      !isResolved && (mentionsDetourInTitle || mentionsDetour(lines, {})) ? "DETOUR" : undefined,
    updatedAt: now,
  };
}

/** A year only used to read a date's month and day before its year is chosen. */
const NEAREST_YEAR_PROBE = 2000;

/** Removes a trailing `- NEW` marker, which a notice carries only while it is fresh. */
function stripNewMarker(title: string): string {
  const trimmed = title.trimEnd();
  if (trimmed.slice(-3).toUpperCase() !== "NEW") return title;
  const rest = trimmed.slice(0, -3).trimEnd();
  const dash = rest.slice(-1);
  return dash === "-" || dash === "–" || dash === "—" ? rest.slice(0, -1).trimEnd() : title;
}

function trimNonAlphanumericEdges(token: string): string {
  return token.replace(NON_ALPHANUMERIC_EDGES, "");
}

/** A token that ends its sentence, which stops a plural route phrase from running on. */
function endsSentence(token: string): boolean {
  return token.endsWith(".") || token.endsWith(":") || token.endsWith(";");
}

/**
 * Reads route ids from `Route N` and `Routes N … and M` phrases. A plural phrase
 * keeps reading to the end of its sentence, adding a route number only when it
 * directly follows another route number or an `and` / `&`. That reads
 * "Routes 12 East End and 16 Balmoral" and "Routes 1/2/11/13" as their routes
 * while leaving "Route Changes" and "Route 15 will not operate along 2nd Street"
 * with only the routes they name.
 */
function parseRoutePhraseIds(texts: readonly string[]): string[] {
  const routeIds: string[] = [];
  const add = (token: string): void => {
    const routeId = token.toUpperCase();
    if (!routeIds.includes(routeId)) routeIds.push(routeId);
  };
  for (const text of texts) {
    const tokens = text.split(/[,/\s]+/u).filter((token) => token.length > 0);
    for (const [index, raw] of tokens.entries()) {
      const word = trimNonAlphanumericEdges(raw).toLowerCase();
      if (word !== "route" && word !== "routes") continue;
      const firstRaw = tokens[index + 1] ?? "";
      const first = trimNonAlphanumericEdges(firstRaw);
      if (!isRouteToken(first)) continue;
      add(first);
      if (endsSentence(firstRaw)) continue;
      let followsRoute = true;
      let followsConjunction = false;
      for (const nextRaw of tokens.slice(index + 2)) {
        const next = trimNonAlphanumericEdges(nextRaw);
        if (word === "route" && !isRouteToken(next)) break;
        if (isRouteToken(next) && (followsRoute || followsConjunction)) {
          add(next);
          followsRoute = true;
          followsConjunction = false;
        } else {
          followsConjunction = nextRaw === "&" || next.toLowerCase() === "and";
          followsRoute = false;
        }
        if (endsSentence(nextRaw)) break;
      }
    }
  }
  return routeIds;
}

/** Stop reading a route field when its route list turns into narrative or street numbers. */
function routeFieldTokens(field: string): string[] {
  return [
    ...parseRoutePhraseIds([`Routes ${field}`]),
    ...parseRouteIds(field).filter((route) => route.startsWith("Viva ")),
  ];
}

/** Unlabelled headlines are prose: only route phrases or a leading route label establish scope. */
function titleRouteTokens(title: string, lines: readonly string[]): string[] {
  const routes = parseRoutePhraseIds([title, ...lines]);
  const first = title.trim().split(/\s+/u)[0] ?? "";
  if (isRouteToken(first) && /^\S+\s+[-–—:]/u.test(title.trim())) routes.unshift(first);
  routes.push(...parseRouteIds(title).filter((route) => route.startsWith("Viva ")));
  return [...new Set(routes)];
}

/** Weekday spellings the accordion prose may put immediately before a date. */
const WEEKDAYS: Readonly<Record<string, number>> = {
  sunday: 0,
  sun: 0,
  monday: 1,
  mon: 1,
  tuesday: 2,
  tue: 2,
  tues: 2,
  wednesday: 3,
  wed: 3,
  thursday: 4,
  thu: 4,
  thur: 4,
  thurs: 4,
  friday: 5,
  fri: 5,
  saturday: 6,
  sat: 6,
};

/**
 * Chooses the occurrence nearest now. A weekday stated before the date narrows
 * candidates to years where the weekday agrees; without a year or weekday, the
 * source leaves the intended year ambiguous.
 */
function startYearFor(line: string, now: number, dateFormatters: DateFormatters): number {
  const current = yearInZone(now, dateFormatters);
  const first = parseAdvisoryDates(line, NEAREST_YEAR_PROBE)[0];
  if (!first) return current;
  if (first.year !== NEAREST_YEAR_PROBE) return first.year;
  const weekday = weekdayBeforeFirstDate(line, first);
  const years = Array.from({ length: 15 }, (_, index) => current - 7 + index);
  const validCandidates = years.flatMap((year) => {
    const probe = new Date(Date.UTC(year, first.month - 1, first.day));
    if (probe.getUTCMonth() !== first.month - 1) return [];
    return [{ year, distance: Math.abs(dateTimestamp({ ...first, year }, dateFormatters) - now) }];
  });
  if (validCandidates.length === 0) return current;
  const weekdayCandidates =
    weekday === undefined
      ? validCandidates
      : validCandidates.filter((candidate) => {
          const probe = new Date(Date.UTC(candidate.year, first.month - 1, first.day));
          return probe.getUTCDay() === weekday;
        });
  return (weekdayCandidates.length > 0 ? weekdayCandidates : validCandidates).reduce(
    (best, candidate) => (candidate.distance < best.distance ? candidate : best),
  ).year;
}

/** Reads a weekday only when it directly precedes the first date in the line. */
function weekdayBeforeFirstDate(line: string, date: AdvisoryDate): number | undefined {
  const tokens = advisoryTokens(line);
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (MONTHS[tokens[index]!.toLowerCase()] !== date.month) continue;
    if (trimmedNumber(tokens[index + 1] ?? "") !== date.day) continue;
    return WEEKDAYS[trimNonAlphanumericEdges(tokens[index - 1]!).toLowerCase()];
  }
  return undefined;
}

/**
 * A period read with the start's year, whose yearless end is the first
 * occurrence on or after the start: "December 28 to January 4" ends next year.
 */
function parseAccordionPeriod(
  line: string,
  now: number,
  dateFormatters: DateFormatters,
): { readonly startsAt?: number; readonly endsAt?: number } | undefined {
  const year = startYearFor(line, now, dateFormatters);
  const period = parsePeriod(line, dateFormatters, year);
  if (
    period?.startsAt !== undefined &&
    period.endsAt !== undefined &&
    period.endsAt < period.startsAt
  ) {
    return {
      startsAt: period.startsAt,
      endsAt: parsePeriod(line, dateFormatters, year + 1)?.endsAt,
    };
  }
  return period;
}

function assertGhdPageRecognized(extracted: GhdExtractedPage): void {
  if (!extracted.variant || extracted.advisories.some((advisory) => !advisory.titleText?.trim()))
    throw new UnsupportedGhdPageError();
}

/** Resolve page-relative links and keep only distinct same-origin destinations. */
function ghdPageUrlsFromExtraction(extracted: GhdExtractedPage, sourceUrl: string): string[] {
  let page: URL;
  try {
    page = new URL(sourceUrl);
  } catch {
    return [];
  }

  for (const variant of GHD_TEMPLATE_VARIANTS) {
    const pagination = extracted.paginationBlocks.find((block) => block.variant === variant.name);
    if (!pagination) continue;
    const urls: string[] = [];
    for (const rawHref of pagination.hrefs) {
      const href = rawHref.trim();
      if (!href || href === "#" || href.startsWith("javascript:")) continue;
      let absolute: URL;
      try {
        absolute = new URL(href, page);
      } catch {
        continue;
      }
      if (absolute.origin !== page.origin || absolute.href === page.href) continue;
      if (!urls.includes(absolute.href)) urls.push(absolute.href);
    }
    if (urls.length > 0) return urls;
  }
  return [];
}

/**
 * The English auxiliaries and modals, a closed class, so a short list is the
 * whole of it. A field value never opens with one; a sentence does.
 */
const AUXILIARY_VERBS: ReadonlySet<string> = new Set([
  "am",
  "are",
  "be",
  "been",
  "being",
  "can",
  "could",
  "did",
  "do",
  "does",
  "had",
  "has",
  "have",
  "is",
  "may",
  "might",
  "must",
  "shall",
  "should",
  "was",
  "were",
  "will",
  "would",
]);

/**
 * Whether a bare label's value reads as a clause of prose rather than a value.
 *
 * A value names what its label names and stops there: `50 –…`, `#1608 - Kingston
 * Rd Westbound`. A line whose first token is an identifier and whose second is an
 * auxiliary is a sentence with the identifier as its subject — "Route 91 will
 * detour on …" — and adopting it would put a whole detour sentence into a route
 * list. This is what lets the full label vocabulary apply to every agency: no
 * operator needs a private subset to keep its prose out of its own fields.
 */
function readsAsClause(value: string): boolean {
  const [identifier, next] = value.split(/\s+/u);
  if (identifier === undefined || next === undefined) return false;
  if (!/^#?\d+[A-Za-z]?$/u.test(identifier)) return false;
  return AUXILIARY_VERBS.has(next.replace(/[^A-Za-z]/gu, "").toLowerCase());
}

/**
 * Splits a leading label off an advisory line.
 *
 * Most fields are written as `Label: value`, some as a bare label word with no
 * colon, and a prose line that happens to carry a colon is not a label at all.
 * Both implementations read a line the same way: the first colon settles it, and
 * a line without a colon opens a field on a leading single-word label whose value
 * is a value and not a clause. That keeps "Route 9A:" on a Milton advisory out of
 * the route list, reads DRT's bare "Stop #1608 …", and leaves YRT's "Route 91
 * will detour …" as the prose it is.
 */
function splitLeadingLabel(line: string): { label: string; value: string } | undefined {
  const colon = line.indexOf(":");
  if (colon >= 0) {
    // A colon settles the line. The text before it either names a field, or the
    // line is prose that happens to contain one, as in Milton's "Route 9A:" —
    // where a bare-label read would wrongly turn a route name into a route field.
    const label = line.slice(0, colon).trim().toLowerCase();
    return label in FIELD_LABELS ? { label, value: line.slice(colon + 1).trim() } : undefined;
  }
  const lowercase = line.toLowerCase();
  let matched: string | undefined;
  for (const label of SINGLE_WORD_LABELS) {
    if (!lowercase.startsWith(label)) continue;
    const endsWord = !/^[\p{L}\p{N}]/u.test(lowercase.slice(label.length));
    if (endsWord && (matched === undefined || label.length > matched.length)) matched = label;
  }
  if (matched === undefined) return undefined;
  const value = line.slice(matched.length).trim();
  return readsAsClause(value) ? undefined : { label: matched, value };
}

/**
 * Reads the canonical fields out of an advisory body.
 *
 * A label with nothing after it on its line — a bare `Detour:`, the way YRT
 * writes one — adopts the lines that follow it, which is where the operator put
 * the value. A label that already carries a value does not: a DRT advisory's
 * `Routes: 905, 920` is followed by a fresh paragraph of prose, and absorbing
 * that paragraph would read its dates and stop numbers as route ids.
 */
function parseLabeledFields(lines: readonly string[]): Partial<Record<CanonicalField, string>> {
  const fields: Partial<Record<CanonicalField, string>> = {};
  let open: CanonicalField | undefined;
  for (const line of lines) {
    const split = splitLeadingLabel(line);
    if (split) {
      const field = FIELD_LABELS[split.label]!;
      appendField(fields, field, split.value);
      open = fields[field] === "" ? field : undefined;
      continue;
    }
    if (open) appendField(fields, open, line);
  }
  return fields;
}

function appendField(
  fields: Partial<Record<CanonicalField, string>>,
  field: CanonicalField,
  value: string,
): void {
  const existing = fields[field] ?? "";
  if (value === "") {
    fields[field] = existing;
    return;
  }
  fields[field] = existing === "" ? value : `${existing} ${value}`;
}

/** The advisory body with the title, the posting date, and the read-more link removed. */
function advisoryDescription(lines: readonly string[], title: string): string {
  return lines
    .filter(
      (line) =>
        line !== title &&
        !line.toLowerCase().startsWith("posted on") &&
        line.toLowerCase() !== "read more",
    )
    .join("\n")
    .trim();
}

/**
 * A detour is whatever the operator calls one: a `Detour` field, or the word
 * anywhere in the body. YRT writes "Morning detour …" with no label, so the word
 * is what the daemon's decoder reads too.
 */
function mentionsDetour(
  lines: readonly string[],
  fields: Partial<Record<CanonicalField, string>>,
): boolean {
  if (fields.detour !== undefined) return true;
  return lines.some((line) => line.toLowerCase().includes("detour"));
}

/**
 * Reads route tokens: one uppercase letter, 1-3 digits, or digits plus one trailing letter. Mirrors
 * `parse_standard_route_tokens` in the alert-feed daemon so the two agree.
 * Letters-first tokens (`N1`, `N2`) are outside the vocabulary on both sides, so
 * an operator's prefixed route never becomes a phantom route on one side only.
 */
function parseRouteIds(value: string): string[] {
  // Route IDs are a lexical field, not HTML structure. This deliberately
  // scans every route mention, including one that trails another across an ellipsis.
  const routeIds: string[] = [];
  const tokens = value
    .split(ROUTE_TOKEN_SPLIT)
    .map((token) => token.replace(NON_ALPHANUMERIC_EDGES, ""))
    .filter((token) => token.length > 0);

  for (const [index, token] of tokens.entries()) {
    const lower = token.toLowerCase();
    if (ROUTE_SKIP_WORDS.has(lower)) continue;
    // Exclude roadway numbers, which follow a roadway word.
    if (index > 0 && ROUTE_ROADWAY_WORDS.has(tokens[index - 1]!.toLowerCase())) continue;

    if (isRouteToken(token) && !routeIds.includes(token.toUpperCase())) {
      routeIds.push(token.toUpperCase());
    }
  }

  const vivaRoutes = /\bviva\s+(blue|purple|orange|yellow)\b/gi;
  for (const match of value.matchAll(vivaRoutes)) {
    const routeId = titleCase(`Viva ${match[1]}`);
    if (!routeIds.includes(routeId)) routeIds.push(routeId);
  }
  return routeIds;
}

/** One uppercase ASCII letter, or 1-3 digits with an optional trailing ASCII letter. */
function isRouteToken(token: string): boolean {
  if (/^[A-Z]$/u.test(token)) return true;
  if (token.length >= 1 && token.length <= 3 && DIGITS_ONLY.test(token)) return true;
  if (token.length < 2 || token.length > 4) return false;
  return DIGITS_ONLY.test(token.slice(0, -1)) && ASCII_LETTER.test(token.slice(-1));
}

/**
 * Reads stop ids following the word `stop`/`stops`, tolerating the separators
 * these templates put between the label and the first id: the `#` in DRT's
 * `Stop #1608`, and the second word of a two-word label such as
 * `Stops missed: 9001`. Only a run that directly follows the label counts, so a
 * stop number named later in prose stays a stop and a route field stays a route.
 */
function parseStopIds(lines: readonly string[]): string[] {
  const stopIds: string[] = [];
  for (const line of lines) {
    STOP_WORD.lastIndex = 0;
    for (const match of line.matchAll(STOP_WORD)) {
      const runStart = match.index + match[0].length;
      let cursor = skipStopSeparators(line, runStart);
      // `Stops missed: …` finishes its label before the ids begin; prose that
      // merely continues a sentence ("Stop relocated to 12 metres") does not,
      // because it carries no colon.
      const labelTail = /^[A-Za-z]+:/u.exec(line.slice(cursor));
      if (labelTail) cursor = skipStopSeparators(line, cursor + labelTail[0].length);
      // Ids run until the first character that cannot be part of one.
      while (cursor < line.length && STOP_ID_CHAR.test(line[cursor]!)) cursor += 1;
      for (const id of line.slice(runStart, cursor).match(/\d+/gu) ?? []) {
        if (!stopIds.includes(id)) stopIds.push(id);
      }
    }
  }
  return stopIds;
}

function skipStopSeparators(line: string, from: number): number {
  let cursor = from;
  while (cursor < line.length && STOP_SEPARATOR.test(line[cursor]!)) cursor += 1;
  return cursor;
}

interface AdvisoryDate {
  readonly month: number;
  readonly day: number;
  readonly year: number;
}

/** The words a line of advisory prose is read as, the daemon's tokenizer too. */
const ADVISORY_TOKEN_SPLIT = /[\s,]+/u;

/**
 * Reads every date in a line of advisory prose, the way the daemon's
 * `util::time::extract_dates` does: a month name (or its three-letter
 * abbreviation) followed by a day, with a year taken from the next year-shaped
 * token and otherwise inherited from `defaultYear`. DRT writes "September 30"
 * with no year at all, and reading that as "no period" would anchor a September
 * 15 detour to today.
 */
function parseAdvisoryDates(text: string, defaultYear: number): AdvisoryDate[] {
  const tokens = advisoryTokens(text);
  const dates: AdvisoryDate[] = [];
  for (const [index, token] of tokens.entries()) {
    const month = MONTHS[token.toLowerCase()];
    if (month === undefined) continue;
    const day = trimmedNumber(tokens[index + 1] ?? "");
    if (day === undefined || day < 1 || day > 31) continue;
    dates.push({ month, day, year: readYear(tokens, index + 2) ?? defaultYear });
  }
  return dates;
}

/** The words of a line, the way the daemon tokenizes one before reading dates. */
function advisoryTokens(text: string): string[] {
  return text.split(ADVISORY_TOKEN_SPLIT).filter((token) => token.length > 0);
}

/** The digits a token carries once its non-digit edges are trimmed, if any remain. */
function trimmedNumber(token: string): number | undefined {
  const trimmed = token.replace(NON_ALPHANUMERIC_EDGES, "");
  return DIGITS_ONLY.test(trimmed) ? Number(trimmed) : undefined;
}

/** The first year-shaped token at or after `from`, if the text states one. */
function readYear(tokens: readonly string[], from: number): number | undefined {
  for (let index = from; index < tokens.length; index += 1) {
    const candidate = trimmedNumber(tokens[index]!);
    if (candidate !== undefined && candidate >= EARLIEST_YEAR && candidate <= LATEST_YEAR) {
      return candidate;
    }
  }
  return undefined;
}

interface AdvisoryTime {
  readonly hour: number;
  readonly minute: number;
  readonly meridiem: "am" | "pm";
}

/**
 * Reads the clock times a period states. A time only counts when the token names
 * a meridiem, either on itself (`7am`, `03:00 PM`) or as the next word
 * (`7 a.m.`), which is the daemon's `util::time::extract_times` rule.
 */
function parseAdvisoryTimes(text: string): AdvisoryTime[] {
  const times: AdvisoryTime[] = [];
  const tokens = text.split(/\s+/u).filter((token) => token.length > 0);
  for (const [index, token] of tokens.entries()) {
    const cleaned = token.replace(/[apmAPM.]/gu, "");
    const [hourToken, minuteToken = "0"] = cleaned.split(":");
    const hour = Number(hourToken);
    const minute = Number(minuteToken);
    if (!Number.isInteger(hour) || !Number.isInteger(minute)) continue;
    if (hour < 1 || hour > 12 || minute >= 60) continue;
    const here = token.toLowerCase();
    const next = (tokens[index + 1] ?? "").toLowerCase();
    const isAm =
      here.includes("a.m") || here.includes("am") || next.startsWith("a.m") || next === "am";
    const isPm =
      here.includes("p.m") || here.includes("pm") || next.startsWith("p.m") || next === "pm";
    if (!isAm && !isPm) continue;
    times.push({ hour, minute, meridiem: isPm ? "pm" : "am" });
  }
  return times;
}

/** Whether the template wrote its posting date behind a `Posted on` prefix. */
type PostedAtPrefix = "posted-on" | "bare";

/**
 * Reads the posting date. The `Posted on` line is the only freshness signal on a
 * page that states no period, and the feed-list templates render the same date
 * bare, so both shapes resolve to the same wall clock in the agency's zone.
 */
function parsePostedAt(
  { text, prefix }: { readonly text: string; readonly prefix: PostedAtPrefix },
  dateFormatters: DateFormatters,
  defaultYear: number,
): { readonly timestamp: number; readonly year: number } | undefined {
  const source = prefix === "posted-on" ? postedOnLine(text) : text;
  if (source === undefined) return undefined;
  const date = parseAdvisoryDates(source, defaultYear).at(0);
  if (!date) return undefined;
  return {
    timestamp: dateTimestamp(date, dateFormatters, parseAdvisoryTimes(source).at(0)),
    year: date.year,
  };
}

/** The text after a `Posted on` prefix, which the news module always writes. */
function postedOnLine(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (line.toLowerCase().startsWith("posted on")) return line.slice("posted on".length).trim();
  }
  return undefined;
}

/** Applies the declared max age, when the source declares one. */
function ageFromPostedAt(anchor: number, maxAgeMinutes: number | undefined): number | undefined {
  return maxAgeMinutes === undefined ? undefined : anchor + maxAgeMinutes * 60_000;
}

/** Reads an article's stated window using its fixed publication year, never the poll year. */
export function publishedAdvisoryPeriod(value: string, publication: string, timeZone: string) {
  const year = /\b(\d{4})\b/u.exec(publication)?.[1];
  if (!year) throw new Error("Article publication year is missing");
  const formatters = createDateFormatters(timeZone);
  const posted = parsePostedAt({ text: publication, prefix: "bare" }, formatters, Number(year));
  const period = parsePeriod(value, formatters, Number(year));
  if (
    !posted ||
    period?.startsAt === undefined ||
    period.endsAt === undefined ||
    period.endsAt < period.startsAt
  )
    throw new Error("Article requires a publication date and stated retirement");
  return { postedAt: posted.timestamp, startsAt: period.startsAt, endsAt: period.endsAt };
}

/** Resolves a dated CMS heading in the agency zone using its fixed publication year. */
export function publishedAdvisoryTimestamp(
  dateText: string,
  clockText: string,
  publicationYear: number,
  timeZone: string,
): number {
  const [date] = parseAdvisoryDates(`${dateText} ${publicationYear}`, publicationYear);
  let [time] = parseAdvisoryTimes(clockText);
  if (!time) {
    const clock = /^(\d{1,2}):(\d{2})\s*([ap])?\.?m\.?$/iu.exec(clockText.trim());
    if (!clock) throw new Error("Update heading requires a calendar date and clock time");
    const hour = Number(clock[1]);
    const minute = Number(clock[2]);
    if (hour < 1 || hour > 23 || minute > 59 || (hour > 12 && clock[3]?.toLowerCase() === "a"))
      throw new Error("Invalid notice publication time");
    time = { hour, minute, meridiem: clock[3]?.toLowerCase() === "p" ? "pm" : "am" };
  }
  if (!date) throw new Error("Update heading requires a calendar date and clock time");
  const calendar = new Date(Date.UTC(date.year, date.month - 1, date.day));
  if (
    calendar.getUTCFullYear() !== date.year ||
    calendar.getUTCMonth() + 1 !== date.month ||
    calendar.getUTCDate() !== date.day
  )
    throw new Error("Invalid notice publication date");
  return dateTimestamp(date, createDateFormatters(timeZone), time);
}

/**
 * Prepositions that put the end of a period after them.
 *
 * `Extended until Thursday, December 31` names a retirement, not an opening.
 * These are the only spellings real advisory pages use, and `up to` is the one
 * two-word member, matched on its first word.
 */
const TERMINAL_PREPOSITIONS: ReadonlySet<string> = new Set(["until", "through", "till"]);
/** The two-word member of the same class. */
const TWO_WORD_TERMINAL_PREPOSITION = ["up", "to"];

/**
 * Reads a stated period from a `When` field. Undefined when the field is absent
 * or unparseable, so the caller falls back to the posting date rather than to now.
 *
 * A stated start is left unset when the field states only a retirement, which is
 * what `parsePeriod` returns for `Extended until Thursday, December 31, 2026`:
 * the posting date is the honest start, and a stated end is what keeps the max
 * age from retiring the advisory months before it opens.
 */
function parsePeriod(
  value: string | undefined,
  dateFormatters: DateFormatters,
  defaultYear: number,
): { readonly startsAt?: number; readonly endsAt?: number } | undefined {
  if (!value) return undefined;
  const dates = parseAdvisoryDates(value, defaultYear);
  if (dates.length === 0) return undefined;

  const times = parseAdvisoryTimes(value);
  if (statesOnlyARetirement(value, defaultYear)) {
    const endTime = times.at(-1);
    return { endsAt: dateTimestamp(dates[0]!, dateFormatters, endTime, endTime === undefined) };
  }

  // One date with several times states a same-day window; several dates with a
  // single time state a whole-day span. The daemon pairs them the same way.
  let startTime: AdvisoryTime | undefined;
  let endTime: AdvisoryTime | undefined;
  if (times.length > 0) {
    if (dates.length === 1) {
      startTime = times[0];
      endTime = times[1];
    } else if (times.length === 1) {
      endTime = times[0];
    } else {
      startTime = times[0];
      endTime = times.at(-1);
    }
  }
  const start = dateTimestamp(dates[0]!, dateFormatters, startTime);
  const endsAt =
    dates.length > 1 || endTime !== undefined
      ? dateTimestamp(dates.at(-1)!, dateFormatters, endTime, endTime === undefined)
      : undefined;
  return { startsAt: start, endsAt };
}

/**
 * Whether a `When` field states a retirement and no opening.
 *
 * The discriminator against `Tuesday September 22, 2026 until further notice` is
 * what, if anything, precedes the terminal preposition. A date there is the
 * start, and so is a clock time, because "from 7 a.m. until 7 p.m. on
 * September 30" opens its own beginning and only then ends. With one date in the
 * field and nothing bounding a beginning ahead of the preposition, the
 * preposition terminates nothing but that date, so the date is the end.
 */
function statesOnlyARetirement(value: string, defaultYear: number): boolean {
  if (parseAdvisoryDates(value, defaultYear).length !== 1) return false;
  const tokens = advisoryTokens(value);
  const bound = indexOfTerminalPreposition(tokens);
  if (bound === undefined) return false;
  const opening = tokens.slice(0, bound).join(" ");
  return (
    parseAdvisoryDates(opening, defaultYear).length === 0 &&
    parseAdvisoryTimes(opening).length === 0
  );
}

/** The first word that introduces the end of a period, if the field uses one. */
function indexOfTerminalPreposition(tokens: readonly string[]): number | undefined {
  for (const [index, token] of tokens.entries()) {
    const word = token.replace(NON_ALPHANUMERIC_EDGES, "").toLowerCase();
    if (TERMINAL_PREPOSITIONS.has(word)) return index;
    const next = tokens[index + 1]?.replace(NON_ALPHANUMERIC_EDGES, "").toLowerCase();
    if (word === TWO_WORD_TERMINAL_PREPOSITION[0] && next === TWO_WORD_TERMINAL_PREPOSITION[1]) {
      return index;
    }
  }
  return undefined;
}

interface DateFormatters {
  readonly timeZone: string;
  year?: Intl.DateTimeFormat;
  offset?: Intl.DateTimeFormat | null;
}

const DATE_FORMATTER_CACHE_SIZE = 8;
const dateFormattersByTimeZone = new Map<string, DateFormatters>();

function createDateFormatters(timeZone: string): DateFormatters {
  let dateFormatters = dateFormattersByTimeZone.get(timeZone);
  if (dateFormatters) {
    // Keep recently used agency zones warm without retaining arbitrary input
    // zones indefinitely. A decoder already holding an evicted value is safe.
    dateFormattersByTimeZone.delete(timeZone);
    dateFormattersByTimeZone.set(timeZone, dateFormatters);
    return dateFormatters;
  }

  dateFormatters = { timeZone };
  if (dateFormattersByTimeZone.size >= DATE_FORMATTER_CACHE_SIZE) {
    const leastRecentTimeZone = dateFormattersByTimeZone.keys().next().value;
    if (leastRecentTimeZone !== undefined) dateFormattersByTimeZone.delete(leastRecentTimeZone);
  }
  dateFormattersByTimeZone.set(timeZone, dateFormatters);
  return dateFormatters;
}

function dateTimestamp(
  date: AdvisoryDate,
  dateFormatters: DateFormatters,
  time?: AdvisoryTime,
  endOfDay = false,
): number {
  let hour = time?.hour ?? (endOfDay ? 23 : 0);
  if (time?.meridiem === "pm" && hour < 12) hour += 12;
  if (time?.meridiem === "am" && hour === 12) hour = 0;
  const minute = time?.minute ?? (endOfDay ? 59 : 0);
  const localAsUtc = Date.UTC(date.year, date.month - 1, date.day, hour, minute, endOfDay ? 59 : 0);
  let offsetFormatter = dateFormatters.offset;
  if (offsetFormatter === undefined) {
    try {
      offsetFormatter = new Intl.DateTimeFormat("en-US", {
        timeZone: dateFormatters.timeZone,
        timeZoneName: "longOffset",
      });
    } catch {
      // Fall back below when a deployment does not provide the configured zone.
      offsetFormatter = null;
    }
    dateFormatters.offset = offsetFormatter;
  }
  if (offsetFormatter) {
    try {
      const parts = offsetFormatter.formatToParts(new Date(localAsUtc));
      const offset = parts.find((part) => part.type === "timeZoneName")?.value;
      const offsetMatch = offset?.match(/^GMT([+-])(\d{1,2})(?::(\d{2}))?$/u);
      if (offsetMatch) {
        const offsetMinutes = Number(offsetMatch[2]) * 60 + Number(offsetMatch[3] ?? 0);
        return localAsUtc - (offsetMatch[1] === "+" ? offsetMinutes : -offsetMinutes) * 60_000;
      }
    } catch {
      // Fall back below when a deployment does not provide the configured zone.
    }
  }
  const fallback = Date.UTC(date.year, date.month - 1, date.day, hour, minute);
  return Number.isNaN(fallback) ? localAsUtc : fallback;
}

/** The calendar year an instant falls on in the operator's zone. */
function yearInZone(timestamp: number, dateFormatters: DateFormatters): number {
  const instant = new Date(timestamp);
  const formatter = (dateFormatters.year ??= new Intl.DateTimeFormat("en-US", {
    timeZone: dateFormatters.timeZone,
    year: "numeric",
  }));
  const year = Number(formatter.format(instant));
  return Number.isInteger(year) ? year : instant.getUTCFullYear();
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
}

function titleCase(value: string): string {
  return value.replace(/\b\w/gu, (character) => character.toUpperCase());
}
