import { parse, serializeOuter, type DefaultTreeAdapterTypes } from "parse5";
import { stripHtml } from "../stripHtml";
import {
  requestTripSparkJson,
  requestTripSparkText,
  type TripSparkHttpOptions,
  type TripSparkSessionConfig,
} from "./tripsparkHttp";
type Node = DefaultTreeAdapterTypes.Node;
type Element = DefaultTreeAdapterTypes.Element;
type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid TripSpark advisory record");
  return value as RecordValue;
}
function rows(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid TripSpark advisory collection");
  return value;
}
const plain = (html: string) => stripHtml(html.replace(/<(ul|ol)\b/giu, "<br><$1"));
const text = (v: unknown) => (typeof v === "string" ? v.trim() : "");
function byClass(node: Node, name: string, found: Element[] = []): Element[] {
  if (
    "tagName" in node &&
    node.attrs.some((a) => a.name === "class" && a.value.split(/\s/u).includes(name))
  )
    found.push(node);
  if ("childNodes" in node) for (const child of node.childNodes) byClass(child, name, found);
  return found;
}
function subjects(title: string): string[] {
  const match = /\broutes?\s*#?\s*([0-9]+[A-Z]?(?:\s*(?:&|,|and)\s*#?\s*[0-9]+[A-Z]?)*)/iu.exec(
    title,
  );
  return match ? [...match[1].matchAll(/[0-9]+[A-Z]?/giu)].map((m) => m[0]) : [];
}
function detail(html: string, title: string): { description: string; lines: string[] } {
  const dom = parse(html),
    heading = byClass(dom, "form-title"),
    body = byClass(dom, "note-editable");
  if (
    heading.length !== 1 ||
    body.length !== 1 ||
    stripHtml(serializeOuter(heading[0])).replace(/\s+/gu, " ").trim() !==
      title.replace(/\s+/gu, " ").trim()
  )
    throw new Error("Unrecognized TripSpark story");
  const lines = plain(serializeOuter(body[0]))
    .split("\n")
    .map((s) => s.replace(/\s+/gu, " ").trim())
    .filter((s) => s && !/^Please download (?:the )?MyRide app/iu.test(s));
  if (!lines.length) throw new Error("Empty TripSpark story");
  return { description: lines.join("\n"), lines };
}
function sectionRoutes(label: string, allowed: readonly string[]): string[] {
  return allowed.filter((id) => {
    if (new RegExp("\\b" + id.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&") + "\\b", "iu").test(label))
      return true;
    const match = /^(\d+)([A-Z])$/u.exec(id);
    if (!match) return false;
    const combined = new RegExp("\\b" + match[1] + "\\s*([A-Z]{2,})\\b", "iu").exec(label);
    return !!combined?.[1].toUpperCase().includes(match[2]);
  });
}
function instant(value: unknown): string {
  const raw = text(value);
  if (!/(?:Z|[+-]\d{2}:\d{2})$/u.test(raw) || !Number.isFinite(Date.parse(raw)))
    throw new Error("Invalid TripSpark notice period");
  return raw;
}
/** Produces protocol facts; date interpretation and severity remain shared Core policy. */
export function decodeTripSparkAdvisories(
  baseInput: unknown,
  newsInput: unknown,
  details: Readonly<Record<string, string>>,
  excludedNewsIds: readonly string[] = [],
): RecordValue[] {
  const base = record(baseInput),
    routes = rows(base.routes).map(record),
    current = rows(base.serviceInterruptions),
    upcoming = rows(base.upcomingServiceInterruptions),
    interruptions = [...current, ...upcoming].map(record);
  const selectors = new Map<string, { routeId: string; directionText?: string }[]>();
  for (const route of routes) {
    const id = text(route.shortName);
    if (!id) throw new Error("Missing TripSpark route name");
    for (const direction of rows(route.directionList).map(record)) {
      const name = text(record(direction.direction).name);
      for (const key of [
        ...rows(direction.serviceInterruptionKeys),
        ...rows(direction.upcomingServiceInterruptionKeys),
      ]) {
        const k = String(key),
          list = selectors.get(k) ?? [];
        list.push({ routeId: id, ...(name ? { directionText: name } : {}) });
        selectors.set(k, list);
      }
    }
  }
  const keys = new Set(interruptions.map((row) => String(row.key)));
  if ([...selectors.keys()].some((key) => !keys.has(key)))
    throw new Error("Missing TripSpark interruption details");
  const result: RecordValue[] = interruptions.map((row) => {
    const id = String(row.key ?? ""),
      title = text(row.name),
      description = plain(text(row.description));
    if (!id || !title || !description) throw new Error("Incomplete TripSpark interruption");
    if (row.dailyStartTime !== "00:00:00" || row.dailyEndTime !== "23:59:59")
      throw new Error("Unsupported daily TripSpark period");
    const start = instant(row.startDateUtc),
      end = instant(row.endDateUtc);
    if (Date.parse(end) < Date.parse(start)) throw new Error("Reversed TripSpark period");
    const selected = selectors.get(id) ?? [],
      codes = /(?:bus stops will be closed|arrêts d.autobus suivants seront hors service)/iu.test(
        description,
      )
        ? [...description.matchAll(/\bID:\s*([A-Za-z0-9]+)\b/gu)].map((m) => m[1])
        : [];
    const targets = codes.flatMap((code) =>
      selected.length
        ? selected.map((target) => ({ ...target, stopId: "Stop " + code, stopCode: code }))
        : [{ stopId: "Stop " + code, stopCode: code }],
    );
    return {
      id: "interruption:" + id,
      title,
      description,
      start_time: start,
      expires_at: end,
      routes: [...new Set(selected.map((s) => s.routeId))],
      ...(codes.length
        ? {
            stops: codes.map((code) => "Stop " + code),
            targets,
            stopScoped: true,
            effect: "NO_SERVICE",
          }
        : { effect: "DETOUR", ...(selected.length ? { targets: selected } : {}) }),
    };
  });
  for (const item of rows(newsInput)) {
    const news = record(item),
      id = String(news.newsId ?? ""),
      title = text(news.title);
    if (excludedNewsIds.includes(id)) continue;
    if (!id || !title) throw new Error("Incomplete TripSpark news");
    const story = detail(details[id] ?? "", title);
    let routeIds = news.routes == null ? subjects(title) : rows(news.routes).map(String);
    let active = routeIds;
    const targets: { routeId?: string; stopId: string; stopCode: string }[] = [];
    if (
      !routeIds.length &&
      /(?:following routes will be operating|circuits suivants seront en service)/iu.test(
        story.description,
      )
    ) {
      const list = story.lines.slice(
        story.lines.findIndex((l) =>
          /(?:following routes will be operating|circuits suivants seront en service)/iu.test(l),
        ) + 1,
      );
      routeIds = [
        ...new Set(
          list.flatMap((line) =>
            /^\P{L}*\d/iu.test(line)
              ? [...line.matchAll(/\b\d{1,3}[A-Z]?\b/gu)].map((m) => m[0])
              : [],
          ),
        ),
      ];
      active = routeIds;
    }
    if (
      /\b(?:closure|closed|detour|fermeture|fermés?|fermées?|détour|modifications? de trajet)\b/iu.test(
        title + " " + story.description,
      )
    )
      for (const line of story.lines) {
        const heading = /^(?:Bus stops? Closures?|Fermetures? (?:des? )?arrêts?)\s*:?(.*)$/iu.exec(
          line,
        );
        if (heading && heading[1].trim()) {
          active = sectionRoutes(heading[1], routeIds);
          if (!active.length) throw new Error("Unresolved TripSpark closure heading");
        }
        const code = /^(?:(?:Bus\s+)?Stop|Arrêt(?: d.autobus)?)\s*#?\s*([A-Za-z]?\d{3,8})\b/iu.exec(
          line,
        )?.[1];
        if (code)
          targets.push(
            ...(active.length
              ? active.map((routeId) => ({ routeId, stopId: "Stop " + code, stopCode: code }))
              : [{ stopId: "Stop " + code, stopCode: code }]),
          );
      }
    result.push({
      id: "news:" + id,
      title,
      description: story.description,
      publishDateUtc: instant(news.publishDateUtc),
      routes: routeIds,
      affectsAllRoutes: news.affectsAllRoutes === true,
      ...(targets.length
        ? {
            targets,
            stops: [...new Set(targets.map((t) => t.stopId))],
            stopScoped: true,
            effect: "NO_SERVICE",
          }
        : {
            effect: /(?:\bdetour\b|détour|modifications? de trajet|déviation)/iu.test(title)
              ? "DETOUR"
              : "OTHER_EFFECT",
          }),
    });
  }
  return result;
}
export async function fetchTripSparkAdvisories(
  config: TripSparkSessionConfig,
  options: TripSparkHttpOptions,
  excluded: readonly string[] = [],
) {
  const [base, news] = await Promise.all([
    requestTripSparkJson(config, "/RouteMap/GetBaseData/", options, {}),
    requestTripSparkJson(config, "/News/GetAllNews", options),
  ]);
  const items = rows(news)
    .map(record)
    .filter((row) => !excluded.includes(String(row.newsId)));
  if (items.length > 30) throw new Error("TripSpark news budget exceeded");
  const details: Record<string, string> = {};
  let failed = false;
  for (let i = 0; i < items.length; i += 2) {
    const results = await Promise.allSettled(
      items.slice(i, i + 2).map(async (row) => {
        const id = String(row.newsId ?? ""),
          slug = text(row.friendlyUrl);
        if (!id || !slug) throw new Error("Missing TripSpark story identity");
        details[id] = await requestTripSparkText(
          config,
          `/News/${encodeURIComponent(id)}/${encodeURIComponent(slug)}/`,
          options,
        );
      }),
    );
    if (results.some((r) => r.status === "rejected")) failed = true;
  }
  if (failed) throw new Error("Incomplete TripSpark news read");
  return decodeTripSparkAdvisories(base, news, details, excluded);
}
