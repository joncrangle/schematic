import { stripHtml } from "./stripHtml";
import { translationEvidence } from "./translatedString";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { GenericAlertTargetSchema, type JsonAlertTimestampMode } from "~/agencies/types";
import { DecodedFeedSchema, type DecodedFeed, type GenericAlert } from "./gtfsRealtimeDecoder";
import { stableAlertFallbackId } from "~/domain/alerts/stableAlertId";

const RawStopSchema = Schema.Struct({
  id: Schema.Union([Schema.String, Schema.Number]),
  name: Schema.optional(Schema.NullOr(Schema.String)),
  code: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
});

const RawAlertSchema = Schema.Struct({
  tripIds: Schema.optional(Schema.Array(Schema.String)),
  tripScoped: Schema.optional(Schema.Boolean),
  stopScoped: Schema.optional(Schema.Boolean),
  targets: Schema.optional(Schema.NullOr(Schema.Array(GenericAlertTargetSchema))),
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  newsId: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  summary: Schema.optional(Schema.NullOr(Schema.String)),
  publishDateUtc: Schema.optional(Schema.NullOr(Schema.String)),
  posted_at: Schema.optional(Schema.NullOr(Schema.String)),
  start_time: Schema.optional(Schema.NullOr(Schema.String)),
  expires_at: Schema.optional(Schema.NullOr(Schema.String)),
  category: Schema.optional(Schema.NullOr(Schema.String)),
  severity: Schema.optional(Schema.NullOr(Schema.String)),
  reason: Schema.optional(Schema.NullOr(Schema.String)),
  closed_stops: Schema.optional(Schema.NullOr(Schema.Array(RawStopSchema))),
  alternate_stops: Schema.optional(Schema.NullOr(Schema.Array(RawStopSchema))),
  routes: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Union([Schema.String, Schema.Number]))),
  ),
  affectsAllRoutes: Schema.optional(Schema.Boolean),
  title: Schema.optional(Schema.NullOr(Schema.String)),
  headerText: Schema.optional(Schema.NullOr(Schema.String)),
  description: Schema.optional(Schema.NullOr(Schema.String)),
  route: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  stopName: Schema.optional(Schema.NullOr(Schema.String)),
  stopStart: Schema.optional(Schema.NullOr(Schema.String)),
  stopEnd: Schema.optional(Schema.NullOr(Schema.String)),
  stopStartId: Schema.optional(Schema.NullOr(Schema.String)),
  stopEndId: Schema.optional(Schema.NullOr(Schema.String)),
  stops: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  stopIDList: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  stopNameList: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  effectDesc: Schema.optional(Schema.NullOr(Schema.String)),
  effect: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  accessibility: Schema.optional(Schema.NullOr(Schema.String)),
  alertType: Schema.optional(Schema.NullOr(Schema.String)),
  activePeriod: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        start: Schema.optional(Schema.NullOr(Schema.String)),
        end: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
  ),
});

const AlertBucketsSchema = Schema.Struct({
  short_term: Schema.optional(Schema.Array(RawAlertSchema)),
  long_term: Schema.optional(Schema.Array(RawAlertSchema)),
}).check(
  Schema.makeFilter((buckets) =>
    buckets.short_term !== undefined || buckets.long_term !== undefined
      ? undefined
      : { path: [], issue: "alerts must declare short_term or long_term" },
  ),
);

const RawResponseSchema = Schema.Union([
  Schema.Array(RawAlertSchema),
  Schema.Struct({
    routes: Schema.optional(Schema.Array(RawAlertSchema)),
    accessibility: Schema.optional(Schema.Array(RawAlertSchema)),
    alerts: Schema.optional(AlertBucketsSchema),
  }),
]);
type RawAlert = Schema.Schema.Type<typeof RawAlertSchema>;
type RawResponse = Schema.Schema.Type<typeof RawResponseSchema>;

function isAlertArray(response: RawResponse): response is readonly RawAlert[] {
  return Array.isArray(response);
}

function stopGuidance(label: string, stops: RawAlert["closed_stops"]): string | undefined {
  const names = stops
    ?.map((stop) => {
      const name = stop.name?.trim() || String(stop.id).trim();
      const code = stop.code == null ? "" : String(stop.code).trim();
      return code ? `${name} (${code})` : name;
    })
    .filter(Boolean);
  return names?.length ? `${label}: ${names.join("; ")}.` : undefined;
}

export class JsonAlertDecodeError extends Data.TaggedError("JsonAlertDecodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface GenericJsonAlertDecoderOptions {
  readonly timestampMode?: JsonAlertTimestampMode;
  readonly timeZone?: string;
  /** Stable source identity used only when an upstream alert has no id. */
  readonly sourceScope?: string;
  /** Declared content language supplied by the source manifest or runtime. */
  readonly language?: string;
}

interface TimestampParts {
  readonly year: number;
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  readonly second: number;
}

const LOCAL_WALL_CLOCK_TIMESTAMP =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?Z$/;

function timestampParts(formatter: Intl.DateTimeFormat, epochMs: number): TimestampParts {
  const values = Object.fromEntries(
    formatter.formatToParts(new Date(epochMs)).map(({ type, value }) => [type, value]),
  );
  return {
    year: Number(values.year),
    month: Number(values.month),
    day: Number(values.day),
    hour: Number(values.hour),
    minute: Number(values.minute),
    second: Number(values.second),
  };
}

function sameTimestampParts(actual: TimestampParts, expected: TimestampParts): boolean {
  return (
    actual.year === expected.year &&
    actual.month === expected.month &&
    actual.day === expected.day &&
    actual.hour === expected.hour &&
    actual.minute === expected.minute &&
    actual.second === expected.second
  );
}

/** Parses an operator's local wall-clock timestamp that is incorrectly suffixed with Z. */
function parseAgencyLocalWallClockTimestamp(value: string, timeZone: string | undefined): number {
  if (!timeZone) return Date.parse(value);
  const match = LOCAL_WALL_CLOCK_TIMESTAMP.exec(value);
  if (!match) return Date.parse(value);

  const expected: TimestampParts = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4]),
    minute: Number(match[5]),
    second: Number(match[6] ?? 0),
  };
  const milliseconds = Number((match[7] ?? "").padEnd(3, "0").slice(0, 3) || 0);
  const wallClockSecond = Date.UTC(
    expected.year,
    expected.month - 1,
    expected.day,
    expected.hour,
    expected.minute,
    expected.second,
  );

  try {
    const formatter = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    let candidateSecond = wallClockSecond;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const observed = timestampParts(formatter, candidateSecond);
      const observedAsUtc = Date.UTC(
        observed.year,
        observed.month - 1,
        observed.day,
        observed.hour,
        observed.minute,
        observed.second,
      );
      const nextCandidateSecond = wallClockSecond - (observedAsUtc - candidateSecond);
      if (nextCandidateSecond === candidateSecond) break;
      candidateSecond = nextCandidateSecond;
    }

    const candidate = candidateSecond + milliseconds;
    return sameTimestampParts(timestampParts(formatter, candidate), expected)
      ? candidate
      : Number.NaN;
  } catch {
    return Date.parse(value);
  }
}

function timestampParser(options: GenericJsonAlertDecoderOptions): (value: string) => number {
  return options.timestampMode === "agency-local-wall-clock"
    ? (value) => parseAgencyLocalWallClockTimestamp(value, options.timeZone)
    : (value) => Date.parse(value);
}

/** Converts the small JSON alert shape used by some operators to Core data. */
export function decodeGenericJsonAlertFeed(
  payload: unknown,
  now = Date.now(),
  options: GenericJsonAlertDecoderOptions = {},
): Effect.Effect<DecodedFeed, JsonAlertDecodeError> {
  const parseTimestamp = timestampParser(options);
  return Schema.decodeUnknownEffect(RawResponseSchema)(payload).pipe(
    Effect.mapError(
      (cause) => new JsonAlertDecodeError({ message: "Invalid JSON alert feed", cause }),
    ),
    Effect.map((decoded) => {
      const rawAlerts: readonly { raw: RawAlert; isAccessibility: boolean }[] = isAlertArray(
        decoded,
      )
        ? decoded.map((raw) => ({ raw, isAccessibility: false }))
        : [
            ...(decoded.routes ?? []).map((raw) => ({
              raw,
              isAccessibility: false,
            })),
            ...(decoded.accessibility ?? []).map((raw) => ({ raw, isAccessibility: true })),
            ...(decoded.alerts
              ? [...(decoded.alerts.short_term ?? []), ...(decoded.alerts.long_term ?? [])]
              : []
            ).map((raw) => ({ raw, isAccessibility: false })),
          ];
      const alerts: GenericAlert[] = rawAlerts.map(({ raw, isAccessibility }) => {
        // Operator CMS bodies can carry HTML; riders see plain text.
        const headerText = stripHtml(raw.headerText ?? "");
        const title = headerText || stripHtml(raw.title ?? "") || "Transit advisory";
        // Raw feed value: route normalization is agency interpretation
        // (interpretSnapshot), driven by the agency manifest.
        const normalizedRoute =
          isAccessibility || raw.route == null ? undefined : String(raw.route).trim();
        const route = normalizedRoute || undefined;
        const category =
          [raw.category, raw.effectDesc, raw.accessibility]
            .map((value) => value?.trim())
            .filter((value): value is string => Boolean(value))
            .join(" ") || undefined;
        const sourceFields = Object.fromEntries(
          [
            ["effectDescription", raw.effectDesc?.trim()],
            ["accessibility", raw.accessibility?.trim()],
            ["category", raw.category?.trim()],
            ["severity", raw.severity?.trim()],
            ["reason", raw.reason?.trim()],
          ].filter((entry): entry is [string, string] => Boolean(entry[1])),
        );
        const stationFromHeader = headerText.split(":", 1)[0]?.trim() || undefined;
        const listedStations = [raw.stopIDList, raw.stopNameList, raw.stops]
          .find((stations) => stations && stations.length > 0)
          ?.map((station) => station.trim())
          .filter(Boolean);
        const closedStops = raw.closed_stops ?? [];
        const bucketStations = closedStops
          .map((stop) => stop.name?.trim() || String(stop.id).trim())
          .filter(Boolean);
        const affectedStations =
          listedStations ??
          (bucketStations.length
            ? [...new Set(bucketStations)]
            : raw.stopName?.trim()
              ? [raw.stopName.trim()]
              : undefined);
        // Replacements remain boarding options, not closed points. Keep the
        // published names/codes in rider guidance and IDs in point targets.
        const description =
          [
            stripHtml(raw.description ?? "") || stripHtml(raw.summary ?? "") || undefined,
            stopGuidance("Closed stops", raw.closed_stops),
            stopGuidance("Alternate stops", raw.alternate_stops),
          ]
            .filter(Boolean)
            .join("\n\n") || undefined;
        const rawId = raw.id ?? raw.newsId;
        const normalizedAlertId = rawId == null ? "" : String(rawId).trim();
        const parseOptionalTimestamp = (value: string | null | undefined) => {
          if (!value?.trim()) return undefined;
          const parsed = parseTimestamp(value);
          return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
        };
        const explicitStart =
          parseOptionalTimestamp(raw.activePeriod?.start) ?? parseOptionalTimestamp(raw.start_time);
        const inferredStart =
          explicitStart ??
          parseOptionalTimestamp(raw.posted_at) ??
          parseOptionalTimestamp(raw.publishDateUtc) ??
          now;
        const rawEnd =
          parseOptionalTimestamp(raw.activePeriod?.end) ?? parseOptionalTimestamp(raw.expires_at);
        const explicitEnd =
          rawEnd !== undefined && (explicitStart === undefined || rawEnd >= explicitStart)
            ? rawEnd
            : undefined;
        // Generic JSON has one window. Preserve equal explicit bounds so an
        // already completed advisory cannot turn into an unbounded one.
        const startsAt = explicitStart ?? Math.min(inferredStart, explicitEnd ?? inferredStart);
        const endsAt = explicitEnd;
        // Explicit feed-stated span only: line inference and equipment-outage
        // mining are agency interpretation (interpretSnapshot).
        const routeIds =
          isAccessibility || raw.affectsAllRoutes
            ? undefined
            : (raw.routes
                ?.map(String)
                .map((id) => id.trim())
                .filter(Boolean) ?? (route ? [route] : undefined));
        const id =
          normalizedAlertId ||
          stableAlertFallbackId("json-alert", options.sourceScope ?? "generic-json", {
            ...raw,
            id: undefined,
            newsId: undefined,
          });
        return {
          id,
          tripIds: raw.tripIds,
          tripScoped: raw.tripScoped === true ? true : undefined,
          stopScoped: raw.stopScoped === true ? true : undefined,
          title,
          description,
          sourceTranslations: options.language
            ? [
                ...translationEvidence("title", [{ text: title }], options.language, "text"),
                ...translationEvidence(
                  "description",
                  [{ text: description }],
                  options.language,
                  "text",
                ),
              ]
            : undefined,
          lineId: undefined,
          routeIds,
          sourceFields: Object.keys(sourceFields).length > 0 ? sourceFields : undefined,
          fromStationId: raw.stopStart?.trim() || raw.stopStartId?.trim() || stationFromHeader,
          toStationId:
            raw.stopEnd?.trim() ||
            raw.stopEndId?.trim() ||
            (raw.accessibility ? stationFromHeader : undefined),
          affectedStations,
          targets:
            raw.targets ??
            (closedStops.length
              ? closedStops
                  .filter((stop) => String(stop.id).trim())
                  .map((stop) => ({ stopId: String(stop.id).trim() }))
              : undefined),
          equipmentOutages: undefined,
          category,
          effect:
            typeof raw.effect === "number"
              ? raw.effect
              : typeof raw.effect === "string"
                ? raw.effect.trim() || undefined
                : undefined,
          startsAt,
          endsAt,
          updatedAt: now,
        };
      });
      return {
        header: { version: "json", timestamp: now },
        tripUpdates: [],
        vehiclePositions: [],
        alerts,
      };
    }),
    Effect.flatMap((feed) =>
      Schema.decodeUnknownEffect(DecodedFeedSchema)(feed).pipe(
        Effect.mapError(
          (cause) =>
            new JsonAlertDecodeError({ message: "Invalid normalized JSON alert feed", cause }),
        ),
      ),
    ),
  );
}
