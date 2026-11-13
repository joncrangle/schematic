import * as Data from "effect/Data";
import { PLACEHOLDER_ALERT_TITLE } from "~/domain/alerts/placeholderTitle";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { GenericAlertTranslationEvidence } from "~/agencies/types";
import {
  DecodeError,
  validateDecodedFeed,
  type DecodedFeed,
  type GenericAlert,
} from "./gtfsRealtimeDecoder";
import { extractStrongTitle, stripHtml } from "./stripHtml";
import { DEFAULT_UI_LOCALE, type UiLocale } from "~/domain/locale";
import {
  selectTranslatedText,
  translationEvidence,
  embeddedTitleEvidence,
} from "./translatedString";
import {
  foldAlertPeriods,
  foldGtfsAlertPeriods,
  summarizeAlertPeriods,
  type AlertPeriod,
} from "~/domain/alerts/periods";
import { stableAlertFallbackId } from "~/domain/alerts/stableAlertId";

const JsonNumberSchema = Schema.Union([Schema.Number, Schema.String]);

const TranslationSchema = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
  language: Schema.optional(Schema.NullOr(Schema.String)),
});

const TranslatedStringSchema = Schema.Struct({
  translation: Schema.optional(Schema.NullOr(Schema.Array(TranslationSchema))),
});

const ActivePeriodSchema = Schema.Struct({
  start: Schema.optional(Schema.NullOr(JsonNumberSchema)),
  end: Schema.optional(Schema.NullOr(JsonNumberSchema)),
});

const ImpactPeriodSchema = ActivePeriodSchema;

const TripSelectorSchema = Schema.Struct({
  trip_id: Schema.optional(Schema.NullOr(Schema.String)),
  route_id: Schema.optional(Schema.NullOr(Schema.String)),
  direction_id: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

const EntitySelectorSchema = Schema.Struct({
  trip: Schema.optional(Schema.NullOr(TripSelectorSchema)),
  direction_text: Schema.optional(Schema.String),
  direction_id: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  route_id: Schema.optional(Schema.NullOr(Schema.String)),
  stop_id: Schema.optional(Schema.NullOr(Schema.String)),
});

const AlertSchema = Schema.Struct({
  // Communication time controls display; impact time describes disruption.
  // `active_period` remains a fallback for older feeds and is ignored whenever
  // either newer field supplies a range.
  active_period: Schema.optional(Schema.NullOr(Schema.Array(ActivePeriodSchema))),
  communication_period: Schema.optional(Schema.NullOr(Schema.Array(ActivePeriodSchema))),
  impact_period: Schema.optional(Schema.NullOr(Schema.Array(ImpactPeriodSchema))),
  informed_entity: Schema.optional(Schema.NullOr(Schema.Array(EntitySelectorSchema))),
  effect: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  cause: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  header_text: Schema.optional(Schema.NullOr(TranslatedStringSchema)),
  description_text: Schema.optional(Schema.NullOr(TranslatedStringSchema)),
  tts_description_text: Schema.optional(Schema.NullOr(TranslatedStringSchema)),
});

const FeedEntitySchema = Schema.Struct({
  id: Schema.optional(Schema.NullOr(Schema.Union([Schema.String, Schema.Number]))),
  is_deleted: Schema.optional(Schema.NullOr(Schema.Boolean)),
  alert: Schema.optional(Schema.NullOr(AlertSchema)),
});

const FeedMessageSchema = Schema.Struct({
  header: Schema.Struct({
    gtfs_realtime_version: Schema.String,
    timestamp: Schema.optional(Schema.NullOr(JsonNumberSchema)),
  }),
  entity: Schema.optional(Schema.NullOr(Schema.Array(FeedEntitySchema))),
});

type FeedMessage = Schema.Schema.Type<typeof FeedMessageSchema>;

export class JsonDecodeError extends Data.TaggedError("JsonDecodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

/**
 * Decodes the standard JSON mapping of a GTFS-RT alert FeedMessage.
 *
 * The wire representation is protocol-level data, so this decoder deliberately
 * does not know an agency's route naming or classification rules. Those remain
 * in interpretSnapshot and the provider manifest respectively.
 */
export function decodeGtfsRealtimeJsonAlertFeed(
  bytes: Uint8Array,
  now = Date.now(),
  descriptionField?: "description_text" | "tts_description_text",
  locale: UiLocale = DEFAULT_UI_LOCALE,
  agencyLocale: string = DEFAULT_UI_LOCALE,
  sourceLanguage?: string,
  sourceScope = "gtfs-rt-json",
): Effect.Effect<DecodedFeed, DecodeError | JsonDecodeError> {
  return Effect.try({
    try: () => JSON.parse(new TextDecoder().decode(bytes)) as unknown,
    catch: (cause) => new JsonDecodeError({ message: "Invalid GTFS-RT JSON", cause }),
  }).pipe(
    Effect.flatMap((payload) =>
      Schema.decodeUnknownEffect(FeedMessageSchema)(payload).pipe(
        Effect.mapError(
          (cause) => new JsonDecodeError({ message: "Invalid GTFS-RT JSON feed", cause }),
        ),
        Effect.map((feed) => ({ feed, payload })),
      ),
    ),
    Effect.map(({ feed, payload }) => {
      const decoded = decodeValidatedGtfsRealtimeJsonAlerts(
        feed,
        now,
        descriptionField,
        locale,
        agencyLocale,
        sourceLanguage,
        sourceScope,
      );
      const raw = payload as { entity?: { is_deleted?: boolean; alert?: unknown }[] };
      const entities = (raw.entity ?? []).filter((entity) => !entity.is_deleted && entity.alert);
      return {
        ...decoded,
        alerts: decoded.alerts.map((alert, index) => ({
          ...alert,
          sourceFields: extensionSourceFields(entities[index]?.alert),
        })),
      };
    }),
    Effect.flatMap((feed) =>
      Effect.try({
        try: () => validateDecodedFeed(feed),
        catch: (cause) =>
          new DecodeError({ message: "Invalid normalized GTFS-RT JSON feed", cause }),
      }),
    ),
  );
}

export function decodeValidatedGtfsRealtimeJsonAlerts(
  feed: FeedMessage,
  now: number,
  descriptionField?: "description_text" | "tts_description_text",
  locale: UiLocale = DEFAULT_UI_LOCALE,
  agencyLocale: string = DEFAULT_UI_LOCALE,
  sourceLanguage?: string,
  sourceScope = "gtfs-rt-json",
): DecodedFeed {
  const timestamp = epochMillis(feed.header.timestamp, now);
  const alerts = (feed.entity ?? []).flatMap((entity) => {
    if (entity.is_deleted || !entity.alert) return [];
    return [
      toGenericAlert(
        entity.alert,
        entity.id,
        timestamp,
        descriptionField,
        locale,
        agencyLocale,
        sourceLanguage,
        sourceScope,
      ),
    ];
  });

  return {
    header: {
      version: feed.header.gtfs_realtime_version.trim(),
      timestamp,
    },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}

function toGenericAlert(
  alert: Schema.Schema.Type<typeof AlertSchema>,
  rawId: string | number | null | undefined,
  feedTimestamp: number,
  descriptionField?: "description_text" | "tts_description_text",
  locale: UiLocale = DEFAULT_UI_LOCALE,
  agencyLocale: string = DEFAULT_UI_LOCALE,
  sourceLanguage?: string,
  sourceScope = "gtfs-rt-json",
): GenericAlert {
  const toRanges = (
    periods: readonly Schema.Schema.Type<typeof ActivePeriodSchema>[] | null | undefined,
  ): AlertPeriod[] =>
    foldAlertPeriods(
      (periods ?? []).map((period) => {
        const start = epochMillis(period.start, Number.NaN);
        const end = epochMillis(period.end, Number.NaN);
        return {
          startsAt: Number.isFinite(start) && start >= 0 ? start : undefined,
          endsAt: Number.isFinite(end) && end >= 0 ? end : undefined,
        };
      }),
    );
  const { activePeriods: selectedPeriods, impactPeriods } = foldGtfsAlertPeriods({
    active: toRanges(alert.active_period),
    communication: toRanges(alert.communication_period),
    impact: toRanges(alert.impact_period),
  });
  const timing = summarizeAlertPeriods(selectedPeriods, feedTimestamp);
  const routeIds = uniqueNonBlank(
    (alert.informed_entity ?? []).map(
      (selector) => selector.route_id?.trim() || selector.trip?.route_id,
    ),
  );
  const affectedStations = uniqueNonBlank(
    (alert.informed_entity ?? []).map((selector) => selector.stop_id),
  );
  const targets = (alert.informed_entity ?? []).flatMap((selector) => {
    const routeId = selector.route_id?.trim() || selector.trip?.route_id?.trim() || undefined;
    const stopId = selector.stop_id?.trim() || undefined;
    return routeId || stopId
      ? [
          {
            routeId,
            stopId,
            directionId: selector.direction_id ?? selector.trip?.direction_id,
            directionText: selector.direction_text,
          },
        ]
      : [];
  });
  const tripIds = uniqueNonBlank(
    (alert.informed_entity ?? []).map((selector) => selector.trip?.trip_id),
  );
  const normalizedId = String(rawId ?? "").trim();
  const id =
    normalizedId ||
    stableAlertFallbackId("gtfs-rt-json-alert", sourceScope, {
      ...alert,
      id: undefined,
    });
  const sourceTranslations: GenericAlertTranslationEvidence[] = [];
  const headerTranslation = translatedString(alert.header_text, locale, agencyLocale);
  sourceTranslations.push(
    ...translationEvidence("title", headerTranslation.translations, sourceLanguage),
  );
  const descriptionTranslation = translatedString(alert.description_text, locale, agencyLocale);
  sourceTranslations.push(
    ...translationEvidence("description", descriptionTranslation.translations, sourceLanguage),
  );
  sourceTranslations.push(
    ...embeddedTitleEvidence(descriptionTranslation.translations, sourceLanguage),
  );
  const ttsTranslation = translatedString(alert.tts_description_text, locale, agencyLocale);
  sourceTranslations.push(
    ...translationEvidence("description", ttsTranslation.translations, sourceLanguage),
  );
  sourceTranslations.push(...embeddedTitleEvidence(ttsTranslation.translations, sourceLanguage));
  const rawDescription =
    (descriptionField === "tts_description_text" ? ttsTranslation.text : undefined) ??
    translatedText(alert.description_text, locale, agencyLocale);
  const header = headerTranslation.text
    ? stripHtml(headerTranslation.text) || undefined
    : undefined;
  // Mirror the protobuf decoder: a missing header lifts the <strong> run
  // from the description, and the rendered description is always plain text.
  const title =
    header ??
    (rawDescription ? extractStrongTitle(rawDescription) : undefined) ??
    PLACEHOLDER_ALERT_TITLE;
  const description = rawDescription ? stripHtml(rawDescription) || undefined : undefined;

  return {
    id,
    title,
    description,
    sourceTranslations: sourceTranslations.length > 0 ? sourceTranslations : undefined,
    routeIds: routeIds.length > 0 ? routeIds : undefined,
    targets: targets.length > 0 ? targets : undefined,
    tripIds: tripIds.length > 0 ? tripIds : undefined,
    tripScoped:
      alert.informed_entity?.length &&
      alert.informed_entity.every((selector) => Boolean(selector.trip?.trip_id?.trim()))
        ? true
        : undefined,
    affectedStations: affectedStations.length > 0 ? affectedStations : undefined,
    sourceFields: undefined,
    effect: alert.effect === null ? undefined : alert.effect,
    cause: alert.cause === null ? undefined : alert.cause,
    startsAt: timing.startsAt,
    endsAt: timing.endsAt,
    activePeriods:
      selectedPeriods.length > 1 || selectedPeriods.some(({ startsAt }) => startsAt === undefined)
        ? selectedPeriods
        : undefined,
    impactPeriods: impactPeriods.length > 0 ? impactPeriods : undefined,
    updatedAt: feedTimestamp,
  };
}

function translatedText(
  value: Schema.Schema.Type<typeof TranslatedStringSchema> | null | undefined,
  locale: UiLocale = DEFAULT_UI_LOCALE,
  agencyLocale: string = DEFAULT_UI_LOCALE,
): string | undefined {
  return translatedString(value, locale, agencyLocale).text;
}

function translatedString(
  value: Schema.Schema.Type<typeof TranslatedStringSchema> | null | undefined,
  locale: UiLocale,
  agencyLocale: string,
): {
  readonly text: string | undefined;
  readonly translations: readonly {
    readonly text?: string | null;
    readonly language?: string | null;
  }[];
} {
  const translations = value?.translation ?? [];
  return {
    text: selectTranslatedText(translations, locale, agencyLocale),
    translations,
  };
}

function epochMillis(value: string | number | null | undefined, fallback: number): number {
  if (value === null || value === undefined || value === "") return fallback;
  const seconds = typeof value === "number" ? value : Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1_000 : fallback;
}

function uniqueNonBlank(values: readonly (string | null | undefined)[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const normalized = value?.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

/** Fully qualified protobuf extension names keep vendor evidence out of Core policy. */
function extensionSourceFields(value: unknown): GenericAlert["sourceFields"] {
  if (!value || typeof value !== "object") return undefined;
  const fields: Record<string, string | number | boolean> = {};
  for (const [namespace, extension] of Object.entries(value)) {
    if (
      !namespace.includes(".") ||
      !extension ||
      typeof extension !== "object" ||
      Array.isArray(extension)
    )
      continue;
    for (const [name, field] of Object.entries(extension)) {
      if (
        typeof field === "string" ||
        typeof field === "boolean" ||
        (typeof field === "number" && Number.isFinite(field))
      )
        fields[`${namespace}.${name}`] = field;
    }
  }
  return Object.keys(fields).length ? fields : undefined;
}
