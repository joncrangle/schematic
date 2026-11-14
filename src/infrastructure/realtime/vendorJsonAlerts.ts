import {
  normalizeContentFragments,
  normalizeIncidentMessages,
  normalizeComponentNotices,
} from "./incidentMessageBoards";
import { normalizeHubupAlerts } from "./hubup/hubupAlerts";
import {
  normalizeBucketedTransitAlerts,
  normalizeJsonApiTransitNotices,
} from "./transitNoticeEnvelopes";
import { normalizeRenderedAdvisoryBoard } from "./renderedAdvisoryBoard";
import * as Schema from "effect/Schema";
import type { JsonAlertParser } from "~/agencies/types";

const Token = Schema.Union([Schema.String, Schema.Number]);
const Broadcast = Schema.Array(
  Schema.Struct({
    id: Token,
    message: Schema.String,
    routeNum: Token,
    stopNum: Token,
    isForDetour: Schema.Boolean,
    type: Schema.String,
  }),
);
const OptionalText = Schema.optional(Schema.NullOr(Schema.String));
const Search = Schema.Struct({
  totalCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  value: Schema.Array(
    Schema.Struct({
      document: Schema.Struct({
        Title: Schema.String,
        RouteTitle: Schema.String,
        Detour: Schema.String,
        RoutesAffected: Schema.String,
        Approx_x002e_StartDate: OptionalText,
        Approx_x002e_EndDate: OptionalText,
        Notes: OptionalText,
        Revised: OptionalText,
      }),
    }),
  ),
});
const AttributeAdvisories = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Token,
      attributes: Schema.Struct({
        title: Schema.String,
        description: Schema.String,
        startDate: Schema.String,
        endDate: Schema.String,
      }),
    }),
  ),
  meta: Schema.Struct({
    pagination: Schema.Struct({ total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) }),
  }),
});
function numericWallDate(value: string, end: boolean): string {
  const match = /^(\d{2})-(\d{2})-(\d{4})$/.exec(value);
  if (!match) throw new Error("Invalid advisory date");
  const [, day, month, year] = match,
    date = new Date(`${year}-${month}-${day}T00:00:00.000Z`);
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== `${year}-${month}-${day}`
  )
    throw new Error("Invalid advisory date");
  return new Date(date.getTime() + (end ? 86400000 : 0)).toISOString();
}
const months =
  "January February March April May June July August September October November December".split(
    " ",
  );
const monthWord = new RegExp(`\\b(${months.join("|")})\\b`);
const monthDay = new RegExp(`\\b(${months.join("|")}) (\\d{1,2}),`);

/** A CMS's English display date, expressed as local wall time for the shared decoder. */
export function advisoryWallTime(
  value: string | null | undefined,
  end: boolean,
): string | undefined {
  if (!value?.trim()) return undefined;
  const year = value.match(/\b(\d{4})\b/)?.[1];
  if (!year) return undefined;
  const y = Number(year);
  let m: number;
  let d: number;
  if (/^End of /i.test(value)) {
    // Whole words only, so "Mayor" never names May.
    const named = value.match(monthWord)?.[1];
    m = named ? months.indexOf(named) + 1 : 12;
    d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  } else {
    const dated = value.match(monthDay);
    if (!dated) return undefined;
    m = months.indexOf(dated[1]) + 1;
    d = Number(dated[2]);
  }
  const clock = value.match(/\b(\d{1,2}):(\d{2})\s*(AM|PM)\b/i);
  const hour = clock ? (Number(clock[1]) % 12) + (clock[3].toUpperCase() === "PM" ? 12 : 0) : 0;
  const minute = clock ? Number(clock[2]) : 0;
  if (clock && (Number(clock[1]) < 1 || Number(clock[1]) > 12 || minute > 59)) return undefined;
  // Date-only expiry includes that service day. The end is exclusive.
  let date = new Date(Date.UTC(y, m - 1, d, hour, minute));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d)
    return undefined;
  if (end && !clock) date = new Date(date.getTime() + 86_400_000);
  return date.toISOString();
}

/** Normalize vendor envelopes without operator identities or route-number heuristics. */
export function normalizeVendorJsonAlerts(
  payload: unknown,
  parser: JsonAlertParser,
): {
  alerts: unknown;
  partial: boolean;
} {
  if (parser === "content-fragment-notices") return normalizeContentFragments(payload);
  if (parser === "everbridge-messages") return normalizeIncidentMessages(payload);
  if (parser === "component-service-notices") return normalizeComponentNotices(payload);
  if (parser === "bucketed-transit-alerts") return normalizeBucketedTransitAlerts(payload);
  if (parser === "jsonapi-transit-notices") return normalizeJsonApiTransitNotices(payload);
  if (parser === "keyed-service-notices") {
    const notice = Schema.Struct({
      key: Token,
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      type: Schema.optional(Schema.String),
      message: Schema.optional(Schema.String),
      category: Schema.optional(Schema.String),
      updatedAt: Schema.optional(Schema.String),
    });
    const feed = Schema.decodeUnknownSync(
      Schema.Struct({
        queryTime: Schema.String,
        serviceAdvisories: Schema.optional(Schema.Array(notice)),
        systemMessages: Schema.optional(Schema.Array(notice)),
      }),
    )(payload);
    if (
      feed.queryTime.length !== 19 ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(feed.queryTime) ||
      (feed.serviceAdvisories === undefined && feed.systemMessages === undefined)
    )
      throw new Error("Unrecognized service notice board");
    const alerts = [
      ...(feed.serviceAdvisories ?? []).map((item) => ({ item, prefix: "advisory" })),
      ...(feed.systemMessages ?? []).map((item) => ({ item, prefix: "message" })),
    ].map(({ item, prefix }) => {
      const title = item.title ?? item.type;
      const description = item.body ?? item.message;
      if (!title?.trim() || !description?.trim()) throw new Error("Unreadable service notice");
      const routes = [
        ...new Set([...description.matchAll(/\broute\s+([a-z0-9]+)\b/gi)].map((match) => match[1])),
      ];
      const stops = [
        ...new Set([...description.matchAll(/^\*\s+(\d+)\s+-\s+\S/gm)].map((match) => match[1])),
      ];
      if (
        item.updatedAt !== undefined &&
        (item.updatedAt.length !== 19 ||
          !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(item.updatedAt))
      )
        throw new Error("Invalid service notice update time");
      return {
        id: `${prefix}-${item.key}`,
        title,
        description,
        ...((item.category ?? item.type) ? { category: item.category ?? item.type } : {}),
        ...(item.updatedAt ? { posted_at: `${item.updatedAt}Z` } : {}),
        routes,
        stops,
        targets: stops.map((stopId) => ({ stopId })),
      };
    });
    return { alerts, partial: false };
  }
  if (parser === "attribute-advisories") {
    const data = Schema.decodeUnknownSync(AttributeAdvisories)(payload);
    return {
      partial: data.meta.pagination.total !== data.data.length,
      alerts: data.data.map(({ id, attributes: item }) => {
        if (!item.title.trim() || !item.description.trim())
          throw new Error("Empty advisory content");
        const start = numericWallDate(item.startDate, false),
          end = numericWallDate(item.endDate, true);
        if (end <= start) throw new Error("Reversed advisory period");
        return {
          id,
          title: item.title,
          description: item.description,
          effect: "UNKNOWN_EFFECT",
          activePeriod: { start, end },
        };
      }),
    };
  }
  if (parser === "rendered-advisory-board") return normalizeRenderedAdvisoryBoard(payload);
  if (parser === "hubup-service-alerts") return normalizeHubupAlerts(payload);
  if (parser === "transloc-messages") {
    const records = Schema.decodeUnknownSync(
      Schema.Array(
        Schema.Struct({
          id: Token,
          text: Schema.String,
          created_at: Schema.String,
          end_date: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    )(payload);
    const date = (value: string): string => {
      const match =
        /^([A-Z][a-z]{2}) ([A-Z][a-z]{2}) (\d{2}) (\d{2}):(\d{2})(?::(\d{2}))? ([+-])(\d{2}):?(\d{2}) (\d{4})$/.exec(
          value,
        );
      if (!match) throw new Error("Invalid TransLoc message date");
      const months = [
        "Jan",
        "Feb",
        "Mar",
        "Apr",
        "May",
        "Jun",
        "Jul",
        "Aug",
        "Sep",
        "Oct",
        "Nov",
        "Dec",
      ];
      const month = months.indexOf(match[2]);
      const local = new Date(0);
      local.setUTCFullYear(Number(match[10]), month, Number(match[3]));
      local.setUTCHours(Number(match[4]), Number(match[5]), Number(match[6] ?? 0), 0);
      if (
        month < 0 ||
        local.getUTCMonth() !== month ||
        local.getUTCDate() !== Number(match[3]) ||
        local.getUTCHours() !== Number(match[4]) ||
        local.getUTCMinutes() !== Number(match[5]) ||
        local.getUTCSeconds() !== Number(match[6] ?? 0) ||
        ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()] !== match[1] ||
        Number(match[8]) > 23 ||
        Number(match[9]) > 59
      )
        throw new Error("Invalid TransLoc message date");
      const offset =
        (Number(match[8]) * 60 + Number(match[9])) * 60_000 * (match[7] === "+" ? 1 : -1);
      return new Date(local.getTime() - offset).toISOString();
    };
    return {
      partial: false,
      alerts: records.map((item) => {
        if (!item.text.trim()) throw new Error("Empty TransLoc message");
        const start = date(item.created_at);
        const end = item.end_date ? date(item.end_date) : undefined;
        if (end && end <= start) throw new Error("Reversed TransLoc message period");
        return {
          id: String(item.id),
          title: item.text,
          effect: "UNKNOWN_EFFECT",
          activePeriod: { start, ...(end ? { end } : {}) },
        };
      }),
    };
  }
  if (parser === "generic-alert-feed") return { alerts: payload, partial: false };
  if (parser === "mapstrat-broadcast") {
    const records = Schema.decodeUnknownSync(Broadcast)(payload);
    const alerts = records.map((record) => {
      if (!record.message.trim()) throw new Error("Broadcast message is empty");
      const route = String(record.routeNum).trim();
      const stop = String(record.stopNum).trim();
      return {
        // id=0 is shared by all generated detours. The shared decoder hashes content.
        id: undefined,
        title: record.message,
        route: route && route !== "0" ? route : undefined,
        closed_stops: stop && stop !== "0" ? [{ id: stop }] : undefined,
        effect: record.isForDetour ? "DETOUR" : undefined,
        category: record.type,
      };
    });
    // Mapstrat lists only live broadcasts, so an empty array is a quiet board.
    return { alerts, partial: false };
  }
  const result = Schema.decodeUnknownSync(Search)(payload);
  let partial = result.totalCount !== result.value.length;
  const alerts = result.value.map(({ document: item }) => {
    if (!item.Detour.trim() || !item.RouteTitle.trim() || !item.RoutesAffected.trim()) {
      throw new Error("Incomplete search advisory");
    }
    const start = advisoryWallTime(item.Approx_x002e_StartDate, false);
    const end = advisoryWallTime(item.Approx_x002e_EndDate, true);
    // An unfamiliar published date remains visible and marks the read incomplete.
    if ((item.Approx_x002e_StartDate && !start) || (item.Approx_x002e_EndDate && !end))
      partial = true;
    return {
      id: item.RoutesAffected,
      title: `${item.Title.trim()}: ${item.Detour.trim()}`,
      description: [
        item.Approx_x002e_StartDate,
        item.Approx_x002e_EndDate,
        item.Notes,
        item.RoutesAffected,
      ]
        .filter(Boolean)
        .join("\n"),
      route: item.RouteTitle.trim(),
      effect: "DETOUR",
      activePeriod: { start, end },
    };
  });
  return { alerts, partial };
}
