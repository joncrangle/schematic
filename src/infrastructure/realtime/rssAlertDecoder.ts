import { XMLParser, XMLValidator } from "fast-xml-parser";
import { validateDecodedFeed, type DecodedFeed, type GenericAlert } from "./gtfsRealtimeDecoder";
import { translationEvidence } from "./translatedString";
import { stripHtml } from "./stripHtml";
import { stableAlertFallbackId } from "~/domain/alerts/stableAlertId";

type XmlRecord = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@_",
  textNodeName: "#text",
  cdataPropName: "#cdata",
  isArray: (name) => name === "item" || name === "entry",
});

export interface RssAlertDecoderOptions {
  readonly now?: number;
  /** Stable source identity used only when an upstream item has no id or link. */
  readonly sourceScope?: string;
  /** Declared content language supplied by the source manifest. */
  readonly language?: string;
  /** RSS has no standard alert expiry; the source declares this policy. */
  readonly maxAgeMinutes?: number;
  readonly expiryPolicy?: "publication-age" | "feed-presence";
  readonly routeCategoryPrefix?: string;
  /** Opt in to numeric route/line lists explicitly named in the entry title. */
  readonly routeIdsFromTitle?: boolean;
  /** One capture group extracts a source-declared locale-neutral item identity. */
  readonly incidentIdentityPattern?: string;
  /** Identity namespace shared by source variants in one language group. */
  readonly incidentIdentityNamespace?: string;
}

/**
 * Decodes the common RSS/Atom alert shape used by operator announcement feeds.
 * XML structure, namespaces, CDATA, entities, and repeated elements are
 * handled by fast-xml-parser. The decoder only maps the resulting fields into
 * the shared feed contract.
 */
export function decodeRssAlertFeed(
  xml: string,
  {
    now = Date.now(),
    sourceScope = "rss",
    language,
    maxAgeMinutes,
    expiryPolicy,
    routeCategoryPrefix,
    routeIdsFromTitle,
    incidentIdentityPattern,
    incidentIdentityNamespace,
  }: RssAlertDecoderOptions,
): DecodedFeed {
  if (expiryPolicy !== "feed-presence" && maxAgeMinutes === undefined) {
    throw new Error("RSS publication-age expiry requires maxAgeMinutes");
  }
  // DTDs can expand arbitrary entities. Skip comments and CDATA while scanning
  // declarations so quoted operator text is not mistaken for a document DTD.
  const declarations = xml.matchAll(
    /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE\b/gu,
  );
  if ([...declarations].some(([declaration]) => declaration.startsWith("<!DOCTYPE"))) {
    throw new Error("RSS documents must not contain a DTD");
  }
  if (XMLValidator.validate(xml) !== true) throw new Error("Invalid RSS XML document");
  assertXmlEntities(xml);
  const document = parser.parse(xml) as unknown;
  assertXmlNamespaces(document);
  assertFeedDocument(document);
  const entries = collectEntries(document);
  const identityExpression =
    incidentIdentityPattern && incidentIdentityNamespace
      ? new RegExp(incidentIdentityPattern)
      : undefined;
  const alerts: GenericAlert[] = entries.flatMap((entry) => {
    const rawTitle = fieldText(entry, ["title"]);
    const title = rawTitle ? stripHtml(rawTitle) || undefined : undefined;
    if (!title) throw new Error("RSS entries require a visible non-empty title");

    const rawDescription = fieldText(entry, [
      "description",
      "content:encoded",
      "summary",
      "content",
    ]);
    const description = rawDescription ? stripHtml(rawDescription) || undefined : undefined;
    const link = fieldText(entry, ["link"]) ?? attributeValue(entry, "link", "href");
    const guid = fieldText(entry, ["guid", "id"]);
    const incidentIdentity =
      identityExpression && incidentIdentityNamespace
        ? extractIncidentIdentity(identityExpression, incidentIdentityNamespace, [guid, link])
        : undefined;
    const publishedAt = parseDate(fieldText(entry, ["pubDate", "published", "updated", "dc:date"]));
    const explicitStart = parseDate(
      fieldText(entry, ["startDate", "start-date", "effectiveDate", "effective"]),
    );
    const inferredStart = publishedAt ?? now;
    const rawExplicitEnd = parseDate(
      fieldText(entry, [
        "endDate",
        "end-date",
        "expirationDate",
        "expiration-date",
        "expires",
        "expiryDate",
      ]),
    );
    const explicitEnd =
      rawExplicitEnd !== undefined &&
      (explicitStart === undefined || rawExplicitEnd >= explicitStart)
        ? rawExplicitEnd
        : undefined;
    const policyEnd =
      expiryPolicy !== "feed-presence" && publishedAt
        ? publishedAt + maxAgeMinutes! * 60_000
        : undefined;
    const candidateEnd = explicitEnd ?? (rawExplicitEnd === undefined ? policyEnd : undefined);
    const endsAt =
      candidateEnd !== undefined && (explicitStart === undefined || candidateEnd >= explicitStart)
        ? candidateEnd
        : undefined;
    const startsAt = explicitStart ?? Math.min(inferredStart, endsAt ?? inferredStart);
    const categories = (Array.isArray(entry.category) ? entry.category : [entry.category])
      .map(textValue)
      .filter((value): value is string => value !== undefined);
    const routeCategories = routeCategoryPrefix
      ? categories.filter((category) => category.startsWith(routeCategoryPrefix))
      : [];
    const categoryRoutes = [
      ...new Set(
        routeCategories.flatMap((category) =>
          category
            .slice(routeCategoryPrefix!.length)
            .split(/[,/\s]+/)
            .filter(Boolean),
        ),
      ),
    ];
    const category = categories.find((category) => !routeCategories.includes(category));
    const id =
      guid ??
      link ??
      stableAlertFallbackId("rss-alert", sourceScope ?? "rss", {
        title,
        description: description ?? null,
        explicitStart: explicitStart ?? null,
        publishedAt: publishedAt ?? null,
        explicitEnd: explicitEnd ?? null,
        categories,
        routeIds: categoryRoutes,
      });

    return [
      {
        id,
        incidentIdentity,
        title,
        description,
        routeIds:
          categoryRoutes.length > 0
            ? categoryRoutes
            : routeIdsFromTitle
              ? titleRouteIds(title)
              : undefined,
        category,
        sourceFields: category ? { rssCategory: category } : undefined,
        sourceTranslations: language
          ? [
              ...translationEvidence("title", [{ text: title }], language, "text"),
              ...translationEvidence("description", [{ text: description }], language, "text"),
            ]
          : undefined,
        startsAt,
        endsAt,
        updatedAt: publishedAt ?? now,
      },
    ];
  });

  return validateDecodedFeed({
    header: { version: "rss", timestamp: now },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  });
}

function extractIncidentIdentity(
  expression: RegExp,
  namespace: string,
  candidates: readonly (string | undefined)[],
): { readonly namespace: string; readonly value: string } | undefined {
  for (const candidate of candidates) {
    if (!candidate || candidate.length > 2_048) continue;
    const value = expression.exec(candidate)?.[1]?.trim();
    if (value) return { namespace, value };
  }
  return undefined;
}

/** fast-xml-parser validates tag structure but permits undeclared entities. */
function assertXmlEntities(xml: string): void {
  const content = xml.replace(/<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>/gu, "");
  for (const match of content.matchAll(/&([^;\s<&]*);?/gu)) {
    const entity = match[1]!;
    if (!match[0].endsWith(";")) throw new Error("Invalid XML entity");
    if (["amp", "lt", "gt", "quot", "apos"].includes(entity)) continue;
    const code = /^#\d+$/u.test(entity)
      ? Number(entity.slice(1))
      : /^#x[\da-fA-F]+$/u.test(entity)
        ? Number.parseInt(entity.slice(2), 16)
        : NaN;
    if (
      ![9, 10, 13].includes(code) &&
      !(code >= 0x20 && code <= 0xd7ff) &&
      !(code >= 0xe000 && code <= 0xfffd) &&
      !(code >= 0x10000 && code <= 0x10ffff)
    )
      throw new Error("Invalid XML entity");
  }
}

/** Namespace declarations apply to the declaring element and its descendants. */
function assertXmlNamespaces(value: unknown, inherited = new Set(["xml"])): void {
  if (Array.isArray(value)) {
    for (const child of value) assertXmlNamespaces(child, inherited);
    return;
  }
  if (!isRecord(value)) return;
  for (const [name, child] of Object.entries(value)) {
    if (name.startsWith("?") || name.startsWith("#") || name.startsWith("@_")) continue;
    for (const element of Array.isArray(child) ? child : [child]) {
      const prefixes = new Set(inherited);
      if (isRecord(element)) {
        for (const [attribute, namespace] of Object.entries(element)) {
          if (attribute.startsWith("@_xmlns:") && typeof namespace === "string" && namespace) {
            prefixes.add(attribute.slice("@_xmlns:".length));
          }
        }
      }
      const names = [
        name,
        ...Object.keys(isRecord(element) ? element : {})
          .filter((key) => key.startsWith("@_") && !key.startsWith("@_xmlns"))
          .map((key) => key.slice(2)),
      ];
      if (names.some((key) => key.includes(":") && !prefixes.has(key.split(":")[0]!))) {
        throw new Error("Undeclared XML namespace");
      }
      assertXmlNamespaces(element, prefixes);
    }
  }
}

/** Only an actual complete RSS channel or Atom root can establish feed absence. */
function assertFeedDocument(document: unknown): void {
  if (!isRecord(document)) throw new Error("Unsupported RSS document");
  const roots = Object.entries(document).filter(([name]) => !name.startsWith("?"));
  if (roots.length !== 1) throw new Error("RSS requires one document root");
  const [name, root] = roots[0]!;
  const rootName = name.split(":").at(-1);
  if (Array.isArray(root)) throw new Error("RSS requires one document root");
  if (rootName === "feed") return;
  if (rootName !== "rss" || !isRecord(root)) throw new Error("Unsupported RSS document");
  const channels = Object.entries(root).filter(([key]) => key.split(":").at(-1) === "channel");
  if (channels.length !== 1 || Array.isArray(channels[0]![1])) {
    throw new Error("RSS requires exactly one channel");
  }
}

/** Read only explicit lists, never incidental road numbers, dates, or stop codes. */
function titleRouteIds(title: string): readonly string[] | undefined {
  const routeIds = new Set<string>();
  const lists =
    /\b(?:routes?|lines?|circuits?|itin[eé]raires?)\s+(\d{1,3}[a-z]?\b(?:\s*(?:,|\/|\band\b|\bet\b)\s*\d{1,3}[a-z]?\b)*)/gi;
  for (const match of title.matchAll(lists)) {
    for (const token of match[1]!.matchAll(/\d{1,3}[a-z]?\b/gi))
      routeIds.add(token[0].toUpperCase());
  }
  const leading = /^(\d{1,3}[a-z]?)\s+[^:]+:/i.exec(title);
  if (leading) routeIds.add(leading[1]!.toUpperCase());
  return routeIds.size > 0 ? [...routeIds] : undefined;
}

function collectEntries(value: unknown): XmlRecord[] {
  if (Array.isArray(value)) return value.flatMap(collectEntries);
  if (!isRecord(value)) return [];

  const entries: XmlRecord[] = [];
  for (const [name, child] of Object.entries(value)) {
    const localName = name.includes(":") ? name.slice(name.lastIndexOf(":") + 1) : name;
    if (localName === "item" || localName === "entry") {
      entries.push(
        ...(Array.isArray(child) ? child : [child]).map((entry) => (isRecord(entry) ? entry : {})),
      );
      continue;
    }
    entries.push(...collectEntries(child));
  }
  return entries;
}

function fieldText(record: XmlRecord, names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = textValue(record[name]);
    if (value) return value;
  }

  for (const [key, value] of Object.entries(record)) {
    const localName = key.includes(":") ? key.slice(key.lastIndexOf(":") + 1) : key;
    if (names.some((name) => name === localName || name.endsWith(`:${localName}`))) {
      const text = textValue(value);
      if (text) return text;
    }
  }
  return undefined;
}

function textValue(value: unknown): string | undefined {
  if (typeof value === "string" || typeof value === "number") {
    return String(value).trim() || undefined;
  }
  if (Array.isArray(value)) {
    return value.map(textValue).filter(Boolean).join(" ").trim() || undefined;
  }
  if (!isRecord(value)) return undefined;

  const direct = [textValue(value["#text"]), textValue(value["#cdata"])].filter(Boolean);
  if (direct.length > 0) return direct.join(" ").trim() || undefined;

  return (
    Object.entries(value)
      .filter(
        ([key]) => !key.startsWith("@_") && !["script", "style"].includes(key.split(":").at(-1)!),
      )
      .map(([, child]) => textValue(child))
      .filter(Boolean)
      .join(" ")
      .trim() || undefined
  );
}

function attributeValue(
  record: XmlRecord,
  elementName: string,
  attributeName: string,
): string | undefined {
  const element = record[elementName];
  if (isRecord(element)) {
    const value = element[`@_${attributeName}`];
    return typeof value === "string" ? value.trim() || undefined : undefined;
  }
  return undefined;
}

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}
