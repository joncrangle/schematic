import type {
  TripTerminalLookup,
  TripDirectionLookup,
  TripRouteLookup,
} from "~/domain/surface/boarding";
import * as Schema from "effect/Schema";

import { SeveritySchema } from "~/domain/severitySchema";
import { lookupLocaleTag, type UiLocale } from "~/domain/locale";
import type { RequestScopedEffectCache } from "~/domain/requestScopedEffectCache";
import type { HostConcurrencyLimiter } from "~/infrastructure/http/hostConcurrency";

const NonBlankStringSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    value.trim().length > 0 ? undefined : "must contain at least one non-whitespace character",
  ),
);
const LocaleSchema = NonBlankStringSchema.check(
  Schema.makeFilter((value) => {
    try {
      Intl.getCanonicalLocales(value);
      return undefined;
    } catch {
      return "must be a valid BCP 47 locale";
    }
  }),
);
const TimeZoneSchema = NonBlankStringSchema.check(
  Schema.makeFilter((value) => {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: value }).format();
      return undefined;
    } catch {
      return "must be a valid IANA time zone";
    }
  }),
);
const FiniteNumberSchema = Schema.Finite;
const PositiveFiniteNumberSchema = FiniteNumberSchema.check(Schema.isGreaterThan(0));
const NonNegativeFiniteNumberSchema = FiniteNumberSchema.check(Schema.isGreaterThanOrEqualTo(0));
const LatitudeSchema = FiniteNumberSchema.check(Schema.isBetween({ minimum: -90, maximum: 90 }));
const LongitudeSchema = FiniteNumberSchema.check(Schema.isBetween({ minimum: -180, maximum: 180 }));
const NonEmptyStringArraySchema = Schema.Array(NonBlankStringSchema).check(Schema.isMinLength(1));

function duplicateValues(values: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) duplicates.add(value);
    seen.add(value);
  }
  return [...duplicates];
}

function duplicateIssue(
  path: readonly PropertyKey[],
  values: readonly string[],
): Schema.FilterIssue[] {
  return duplicateValues(values).map((value) => ({
    path,
    issue: `duplicate value "${value}"`,
  }));
}

/**
 * Agency provider contract, core-owned.
 *
 * Every data shape here is an Effect Schema: the schema is the single
 * source of truth and the plain type is derived via `Schema.Type<typeof …>`,
 * so compile-time types and wire validation cannot drift. Function-bearing
 * shapes (ProviderRuntimeContext, AgencyProvider) stay plain interfaces.
 * Providers import these; core never imports providers except via registry.
 */

export const BoundingBoxSchema = Schema.Struct({
  minLat: LatitudeSchema,
  maxLat: LatitudeSchema,
  minLon: LongitudeSchema,
  maxLon: LongitudeSchema,
}).check(
  Schema.makeFilter((box) => {
    const issues: Schema.FilterIssue[] = [];
    if (box.minLat > box.maxLat) {
      issues.push({ path: ["minLat"], issue: "must be less than or equal to maxLat" });
    }
    if (box.minLon > box.maxLon) {
      issues.push({ path: ["minLon"], issue: "must be less than or equal to maxLon" });
    }
    return issues;
  }),
);
export type BoundingBox = Schema.Schema.Type<typeof BoundingBoxSchema>;

export const TransitModeSchema = Schema.Union([
  Schema.Literal("subway"),
  Schema.Literal("ferry"),
  Schema.Literal("rail"),
  Schema.Literal("streetcar"),
  Schema.Literal("bus"),
  Schema.Literal("express"),
]);
export type TransitMode = Schema.Schema.Type<typeof TransitModeSchema>;

const DirectionInferenceModeSchema = Schema.Union([
  Schema.Literal("east-west"),
  Schema.Literal("north-south"),
]);

const RouteTypeRuleSchema = Schema.Struct({
  routeType: TransitModeSchema,
  routeIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  minId: Schema.optional(Schema.Int),
  maxId: Schema.optional(Schema.Int),
}).check(
  Schema.makeFilter((rule) => {
    const issues: Schema.FilterIssue[] = [];
    if (!rule.routeIds && rule.minId === undefined && rule.maxId === undefined) {
      issues.push({
        path: [],
        issue: "must declare routeIds, minId, or maxId as a matcher",
      });
    }
    if (rule.minId !== undefined && rule.maxId !== undefined && rule.minId > rule.maxId) {
      issues.push({ path: ["minId"], issue: "must be less than or equal to maxId" });
    }
    if (rule.routeIds && duplicateValues(rule.routeIds).length > 0) {
      issues.push(...duplicateIssue(["routeIds"], rule.routeIds));
    }
    return issues;
  }),
);

/** Declarative policy for provider-specific route and bearing interpretation. */
export const RouteInterpretationConfigSchema = Schema.Struct({
  routeTypeRules: Schema.optional(Schema.Array(RouteTypeRuleSchema)),
  directionInference: Schema.optional(
    Schema.Struct({
      default: Schema.optional(DirectionInferenceModeSchema),
      routeOverrides: Schema.optional(Schema.Record(Schema.String, DirectionInferenceModeSchema)),
      /** North-south feeds where direction_id 0 means southbound and 1 means northbound. */
      invertNorthSouth: Schema.optional(Schema.Boolean),
    }),
  ),
});
export type RouteInterpretationConfig = Schema.Schema.Type<typeof RouteInterpretationConfigSchema>;

export const StationRouteTypeSchema = Schema.Union([
  Schema.Literal("subway"),
  Schema.Literal("ferry"),
  Schema.Literal("rail"),
  Schema.Literal("bus"),
]);
export type StationRouteType = Schema.Schema.Type<typeof StationRouteTypeSchema>;

/** Declarative configuration for an agency's geographic station-arrivals port. */
export const StationServiceConfigSchema = Schema.Struct({
  routeType: StationRouteTypeSchema,
  /** Whether each served line should render as its own station card. */
  splitByLine: Schema.optional(Schema.Boolean),
});
export type StationServiceConfig = Schema.Schema.Type<typeof StationServiceConfigSchema>;

/**
 * One agency may serve station panels in more than one mode (GRT serves ION
 * light rail as `rail` and its terminals as `bus`). The manifest accepts a
 * single entry or a non-empty array with unique route types; a single entry
 * decodes unchanged so existing manifests keep working.
 */
export const StationServiceSchema = Schema.Union([
  StationServiceConfigSchema,
  Schema.Array(StationServiceConfigSchema)
    .check(Schema.isMinLength(1))
    .check(
      Schema.makeFilter((services) =>
        duplicateValues(services.map((service) => service.routeType)).length > 0
          ? duplicateIssue(
              [],
              services.map((service) => service.routeType),
            )
          : undefined,
      ),
    ),
]);
export type StationService = Schema.Schema.Type<typeof StationServiceSchema>;

/**
 * Normalizes the manifest's stationService into its array form. Single-entry
 * manifests decode as a lone object and behave exactly as before; multi-mode
 * agencies fan out one stations source per entry.
 */
export function normalizeStationServices(
  service: StationService | undefined,
): readonly StationServiceConfig[] {
  if (service === undefined) return [];
  if (typeof service === "object" && "routeType" in service) return [service];
  return service;
}

/** Optional per-agency proximity policy; Core supplies safe defaults. */
export const ProximityConfigSchema = Schema.Struct({
  radiusMeters: PositiveFiniteNumberSchema,
  bucketMeters: PositiveFiniteNumberSchema,
}).check(
  Schema.makeFilter((config) =>
    config.bucketMeters <= config.radiusMeters
      ? undefined
      : { path: ["bucketMeters"], issue: "must be less than or equal to radiusMeters" },
  ),
);
export type ProximityConfig = Schema.Schema.Type<typeof ProximityConfigSchema>;

export const AgencyScopeSchema = Schema.Union([
  Schema.Literal("regional"),
  Schema.Literal("national"),
  Schema.Literal("international"),
]);
export type AgencyScope = Schema.Schema.Type<typeof AgencyScopeSchema>;

export const AgencyJurisdictionSchema = Schema.Struct({
  country: NonBlankStringSchema,
  region: Schema.optional(NonBlankStringSchema),
  coverage: Schema.optional(Schema.Array(NonBlankStringSchema)),
});
export type AgencyJurisdiction = Schema.Schema.Type<typeof AgencyJurisdictionSchema>;

export const FeedAuthSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("none") }),
  Schema.Struct({
    type: Schema.Literal("query_param"),
    parameterName: NonBlankStringSchema,
    secretName: Schema.optional(NonBlankStringSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("header"),
    headerName: NonBlankStringSchema,
    secretName: Schema.optional(NonBlankStringSchema),
  }),
  Schema.Struct({
    type: Schema.Literal("custom"),
    scheme: Schema.Literal("sha256-minute"),
    keySecretName: NonBlankStringSchema,
    secretName: NonBlankStringSchema,
    keyParameter: NonBlankStringSchema,
    signatureParameter: NonBlankStringSchema,
  }),
]);
export type FeedAuth = Schema.Schema.Type<typeof FeedAuthSchema>;

/** Explicit HTTP content-negotiation overrides supported by GTFS-RT adapters. */
export const FeedAcceptSchema = Schema.Union([
  Schema.Literal("*/*"),
  Schema.Literal("application/octet-stream"),
  Schema.Literal("application/protocol-buffer"),
  Schema.Literal("text/plain"),
]);
export type FeedAccept = Schema.Schema.Type<typeof FeedAcceptSchema>;

export const RealtimeFeedKindSchema = Schema.Union([
  Schema.Literal("vehicle_positions"),
  Schema.Literal("trip_updates"),
  /** Optional mode-specific trip feed used by station proximity adapters. */
  Schema.Literal("station_trip_updates"),
  /** Optional per-stop JSON departures feed used by station proximity adapters. */
  Schema.Literal("station_departures"),
  /** Generic NextBus/UmoIQ endpoint used as a declared realtime fallback. */
  Schema.Literal("nextbus"),
  /** Vendor-hosted Tmix AnyRide endpoint. */
  Schema.Literal("tmix_anyride"),
  Schema.Literal("zenbus"),
  Schema.Literal("tsimobile"),
  /** Encrypted network-wide train map with station-local times; see `TrainMapGtfsIndex`. */
  Schema.Literal("train_map"),
  Schema.Literal("swiftly"),
  Schema.Literal("transloc"),
  Schema.Literal("samsara_boards"),
  Schema.Literal("cityway"),
  Schema.Literal("passio"),
  Schema.Literal("hubup"),
  Schema.Literal("bustime"),
  Schema.Literal("tripspark"),
  Schema.Literal("fleet_integrations"),
  /** Per-terminal ferry sailing boards keyed by operator terminal codes. */
  Schema.Literal("ferry_sailing_boards"),
]);
export type RealtimeFeedKind = Schema.Schema.Type<typeof RealtimeFeedKindSchema>;

/** GTFS-RT vehicle fields an upstream feed declares unreliable. */
export const RealtimeVehicleFieldSchema = Schema.Union([
  Schema.Literal("speed"),
  Schema.Literal("occupancy_status"),
]);
export type RealtimeVehicleField = Schema.Schema.Type<typeof RealtimeVehicleFieldSchema>;

/** How a vehicle feed's duplicate fixes of one trip are reduced to one. */
export const DuplicateVehicleFixesSchema = Schema.Literal("collapse-by-trip");
export type DuplicateVehicleFixes = Schema.Schema.Type<typeof DuplicateVehicleFixesSchema>;

/**
 * How an AnyRide feed's duplicate vehicle fixes are reduced to one. AnyRide
 * locates a bus through the call that names it, so the same physical bus is
 * also reachable through its next trip's call and reports an identical fix.
 */
export const TmixDuplicateVehicleFixesSchema = Schema.Literal("collapse-by-fix");
export type TmixDuplicateVehicleFixes = Schema.Schema.Type<typeof TmixDuplicateVehicleFixesSchema>;

const AnyRideProfileValueSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[A-Za-z0-9_.-]+$/.test(value)
      ? undefined
      : "must be a header-safe token of letters, digits, '_', '.' or '-'",
  ),
);

/**
 * AnyRide data and display profiles. The tenant's web app copies both from
 * `GetConfigOptions` into request headers, and the data profile changes which
 * departures a stop returns, so a declared profile is part of the wire contract.
 */
export const AnyRideProfileSchema = Schema.Struct({
  /** Sent as the `anyride-profile-data` request header. */
  data: AnyRideProfileValueSchema,
  /** Sent as the `anyride-profile-display` request header. */
  display: Schema.optional(AnyRideProfileValueSchema),
});
export type AnyRideProfile = Schema.Schema.Type<typeof AnyRideProfileSchema>;

export const HttpUrlSchema = Schema.String.check(
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0
        ? undefined
        : "must be an HTTP or HTTPS URL with a hostname";
    } catch {
      return "must be a valid HTTP or HTTPS URL";
    }
  }),
);
export type HttpUrl = Schema.Schema.Type<typeof HttpUrlSchema>;

export const JsonAlertParserSchema = Schema.Union([
  Schema.Literal("generic-alert-feed"),
  Schema.Literal("everbridge-messages"),
  Schema.Literal("component-service-notices"),
  Schema.Literal("content-fragment-notices"),
  Schema.Literal("normalized-alert-feed"),
  Schema.Literal("tripspark-advisories"),
  Schema.Literal("i3-service-status"),
  Schema.Literal("mapstrat-broadcast"),
  Schema.Literal("transloc-messages"),
  Schema.Literal("hubup-service-alerts"),
  Schema.Literal("eum-search-advisories"),
  Schema.Literal("rendered-advisory-board"),
  Schema.Literal("attribute-advisories"),
  Schema.Literal("keyed-service-notices"),
  Schema.Literal("bucketed-transit-alerts"),
  Schema.Literal("jsonapi-transit-notices"),
]);
export type JsonAlertParser = Schema.Schema.Type<typeof JsonAlertParserSchema>;

export const WebAlertParserSchema = Schema.Union([
  Schema.Literal("ghd-news-service-advisories"),
  Schema.Literal("heading-service-notices"),
  Schema.Literal("service-announcement-board"),
  Schema.Literal("route-notice-index"),
  Schema.Literal("route-status-table"),
  Schema.Literal("disruption-details-table"),
  Schema.Literal("stop-closure-table"),
  Schema.Literal("route-station-advisories"),
]);
export type WebAlertParser = Schema.Schema.Type<typeof WebAlertParserSchema>;

const AlertWireFormatSchema = Schema.Union([Schema.Literal("protobuf"), Schema.Literal("json")]);

/** Timestamp semantics for non-standard JSON alert feeds. */
export const JsonAlertTimestampModeSchema = Schema.Union([
  Schema.Literal("iso8601"),
  Schema.Literal("agency-local-wall-clock"),
]);
export type JsonAlertTimestampMode = Schema.Schema.Type<typeof JsonAlertTimestampModeSchema>;

const RssMaxAgeMinutesSchema = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 525_600 }));
const IncidentIdentityPatternSchema = Schema.String.check(
  Schema.makeFilter((pattern) => {
    if (pattern.length > 256) {
      return { path: [], issue: "must be at most 256 characters" };
    }
    try {
      new RegExp(pattern);
    } catch {
      return { path: [], issue: "must be a valid regular expression" };
    }
    return countCaptureGroups(pattern) === 1
      ? undefined
      : { path: [], issue: "must contain exactly one capture group" };
  }),
);

export const AlertRuntimeTargetSchema = Schema.Union([
  Schema.Literal("cloudflare"),
  Schema.Literal("self-hosted"),
]);
export type AlertRuntimeTarget = Schema.Schema.Type<typeof AlertRuntimeTargetSchema>;

const PublicationReferenceSchema = Schema.Struct({
  /** Fixed year verified from an authoritative publication, never the poll year. */
  publicationYear: Schema.Int.check(Schema.isBetween({ minimum: 2020, maximum: 2050 })),
  validFrom: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
  validThrough: Schema.String.check(Schema.isPattern(/^\d{4}-\d{2}-\d{2}$/u)),
}).check(
  Schema.makeFilter((reference) =>
    (() => {
      const validDate = (value: string) => {
        const [year, month, day] = value.split("-").map(Number);
        const parsed = new Date(Date.UTC(year!, month! - 1, day));
        return (
          parsed.getUTCFullYear() === year &&
          parsed.getUTCMonth() === month! - 1 &&
          parsed.getUTCDate() === day
        );
      };
      return validDate(reference.validFrom) &&
        validDate(reference.validThrough) &&
        reference.validFrom.startsWith(`${reference.publicationYear}-`) &&
        reference.validThrough.startsWith(`${reference.publicationYear}-`) &&
        reference.validFrom <= reference.validThrough
        ? undefined
        : { path: ["validThrough"], issue: "must be a valid date on or after validFrom" };
    })(),
  ),
);

const alertSourceCommonFields = {
  /** Minimum interval between upstream reads, shared with realtime consumers. */
  pollIntervalSeconds: Schema.optional(PositiveFiniteNumberSchema),
  /** A successful read still cannot establish agency-wide advisory completeness. */
  coverage: Schema.optional(Schema.Literal("partial")),
  /** BCP-47 language of operator-authored alert text, when the source is single-language. */
  language: Schema.optional(LocaleSchema),
  /** Groups translations of one logical source so Core can choose one variant. */
  languageGroup: Schema.optional(NonBlankStringSchema),
  devProxyPrefix: Schema.optional(NonBlankStringSchema),
  auth: Schema.optional(FeedAuthSchema),
  enabled: Schema.optional(Schema.Boolean),
  runtimes: Schema.optional(Schema.Array(AlertRuntimeTargetSchema)),
  disabledReason: Schema.optional(NonBlankStringSchema),
  baseUrlSecretName: Schema.optional(NonBlankStringSchema),
  /** An unprovisioned enabled source makes the runtime's combined snapshot incomplete. */
  requiredForCompleteness: Schema.optional(Schema.Boolean),
};

const gtfsRtAlertFields = {
  /** Enrich matching incidents; retain unmatched entities with effect-based fallback wording. */
  entityOnly: Schema.optional(Schema.Boolean),
  /** Explicit media type for the GTFS-RT source's Accept request header. */
  accept: Schema.optional(FeedAcceptSchema),
};

const unsupportedAcceptField = {
  /** The field is intentionally rejected rather than silently discarded. */
  accept: Schema.optional(Schema.Never),
};

/** A provider-selected upstream alert source. Core owns every adapter. */
const FeedNamespaceSchema = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9-]*$/));
export const AlertSourceSchema = Schema.Union([
  Schema.Struct({
    ...alertSourceCommonFields,
    ...unsupportedAcceptField,
    type: Schema.Literal("zenbus-messages"),
    url: HttpUrlSchema,
    stopCodeMap: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  }),
  Schema.Struct({
    ...alertSourceCommonFields,
    ...gtfsRtAlertFields,
    type: Schema.Literal("gtfs-rt"),
    idNamespace: Schema.optional(FeedNamespaceSchema),
    ignoredStopIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
    stopIdAliases: Schema.optional(Schema.Literal("static-code")),
    url: HttpUrlSchema,
    descriptionField: Schema.optional(
      Schema.Union([Schema.Literal("description_text"), Schema.Literal("tts_description_text")]),
    ),
    /** GTFS-RT's standard JSON or protobuf wire representation. */
    format: Schema.optional(AlertWireFormatSchema),
    /**
     * An operator that always publishes at least one standing alert never has a
     * truly empty board, so a feed with zero alerts is a stub or a failure. The
     * source then reports stale instead of a clean board. Opt-in.
     */
    emptyIsStale: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({
    ...alertSourceCommonFields,
    ...unsupportedAcceptField,
    type: Schema.Literal("json"),
    url: HttpUrlSchema,
    parser: JsonAlertParserSchema,
    sessionTokenArgument: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
    ),
    excludedNewsIds: Schema.optional(NonEmptyStringArraySchema),
    /** Standing location notices represented by static topology, not live disruptions. */
    excludedDescriptionPrefixes: Schema.optional(NonEmptyStringArraySchema),
    /** Drop stop-list summaries only when detailed notices cover their scope and period. */
    redundantSummaryPrefixes: Schema.optional(NonEmptyStringArraySchema),
    /**
     * Age of the document's own header timestamp after which the board reports
     * stale. A publisher that republishes less often than ten minutes needs a
     * wider window so a quiet but current board is not read as frozen.
     */
    maxHeaderAgeMinutes: Schema.optional(PositiveFiniteNumberSchema),
    timestampMode: Schema.optional(JsonAlertTimestampModeSchema),
    method: Schema.optional(Schema.Literal("POST")),
    body: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }).check(
    Schema.makeFilter((source) => {
      if (
        (source.sessionTokenArgument !== undefined || source.excludedNewsIds !== undefined) &&
        source.parser !== "tripspark-advisories"
      )
        return { path: ["parser"], issue: "TripSpark options require tripspark-advisories" };
      if (
        (source.excludedDescriptionPrefixes || source.redundantSummaryPrefixes) &&
        source.parser !== "i3-service-status"
      ) {
        return { path: ["excludedDescriptionPrefixes"], issue: "requires i3-service-status" };
      }
      if (source.body !== undefined && source.method !== "POST") {
        return { path: ["body"], issue: "requires method POST" };
      }
      if (source.maxHeaderAgeMinutes !== undefined && source.parser !== "i3-service-status") {
        return { path: ["maxHeaderAgeMinutes"], issue: "requires i3-service-status" };
      }
      if (
        source.parser === "eum-search-advisories" &&
        (source.method !== "POST" || source.body === undefined)
      ) {
        return { path: ["parser"], issue: "eum-search-advisories requires a POST body" };
      }
      return undefined;
    }),
  ),
  Schema.Struct({
    ...alertSourceCommonFields,
    ...unsupportedAcceptField,
    type: Schema.Literal("rss"),
    url: HttpUrlSchema,
    /** RSS has no standard alert expiry, so each source declares its policy. */
    maxAgeMinutes: Schema.optional(RssMaxAgeMinutesSchema),
    expiryPolicy: Schema.optional(
      Schema.Union([Schema.Literal("publication-age"), Schema.Literal("feed-presence")]),
    ),
    routeCategoryPrefix: Schema.optional(NonBlankStringSchema),
    routeIdsFromTitle: Schema.optional(Schema.Boolean),
    /** One capture group extracts a locale-neutral identity from an RSS GUID or link. */
    incidentIdentityPattern: Schema.optional(IncidentIdentityPatternSchema),
  }).check(
    Schema.makeFilter((source) => {
      if (source.incidentIdentityPattern !== undefined && source.languageGroup === undefined) {
        return {
          path: ["incidentIdentityPattern"],
          issue: "requires languageGroup so translated variants share an identity namespace",
        };
      }
      if (source.expiryPolicy === "feed-presence") {
        return source.maxAgeMinutes === undefined
          ? undefined
          : { path: ["maxAgeMinutes"], issue: "must be omitted for feed-presence expiry" };
      }
      return source.maxAgeMinutes !== undefined
        ? undefined
        : { path: ["maxAgeMinutes"], issue: "is required for publication-age expiry" };
    }),
  ),
  Schema.Struct({
    ...alertSourceCommonFields,
    ...unsupportedAcceptField,
    type: Schema.Literal("web"),
    /** Opt-in compatibility for legacy folded HTTP response headers on self-hosted runtimes. */
    allowLegacyResponseHeaders: Schema.optional(Schema.Boolean),
    /** Deadline for an individual page from an accessible but slow publisher. */
    requestTimeoutMs: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10_000 })),
    ),
    url: HttpUrlSchema,
    parser: WebAlertParserSchema,
    /** Operator-published route names used by heading-led and service announcement boards. */
    routeNames: Schema.optional(Schema.Record(NonBlankStringSchema, NonEmptyStringArraySchema)),
    /** Published title aliases for heading-led notices, keyed by station name or feed stop ID. */
    stopNames: Schema.optional(Schema.Record(NonBlankStringSchema, NonEmptyStringArraySchema)),
    /** Fixed, externally verified year and validity window for yearless source dates. */
    publicationReference: Schema.optional(PublicationReferenceSchema),
    /**
     * Service names the page's "There are no … service changes planned at this
     * time" sentence may name to clear the board. A clear claim naming anything
     * else, such as one time window or mode, stays unconfirmed.
     */
    clearStatementNames: Schema.optional(NonEmptyStringArraySchema),
    /** Bounded override for complete boards that fit the agency's Workers subrequest budget. */
    cloudflareMaxCrawlPages: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 })),
    ),
    /**
     * Caps how long a posting stays live when the page states no end date.
     * Unset means postings are never aged out.
     */
    maxAgeMinutes: Schema.optional(RssMaxAgeMinutesSchema),
  }).check(
    Schema.makeFilter((source) => {
      if (source.stopNames !== undefined && source.parser !== "heading-service-notices")
        return { path: ["stopNames"], issue: "requires heading-service-notices" };
      if (source.publicationReference !== undefined && source.parser !== "heading-service-notices")
        return { path: ["publicationReference"], issue: "requires heading-service-notices" };
      if (source.clearStatementNames !== undefined && source.parser !== "heading-service-notices")
        return { path: ["clearStatementNames"], issue: "requires heading-service-notices" };
      if (
        source.routeNames !== undefined &&
        ![
          "heading-service-notices",
          "service-announcement-board",
          "route-notice-index",
          "route-status-table",
          "disruption-details-table",
          "stop-closure-table",
          "route-station-advisories",
        ].includes(source.parser)
      ) {
        return {
          path: ["routeNames"],
          issue:
            "is only valid for heading-service-notices, service-announcement-board, route-notice-index, route-status-table, disruption-details-table, stop-closure-table, and route-station-advisories",
        };
      }
      return undefined;
    }),
  ),
  Schema.Struct({
    ...alertSourceCommonFields,
    ...unsupportedAcceptField,
    type: Schema.Literal("anyride-messages"),
    /**
     * The AnyRide API base URL, or with `relay` the alert-feed daemon document
     * that already holds the polled messages.
     */
    url: HttpUrlSchema,
    /** Scopes the calls whose lines attribute a message, as for realtime feeds. */
    operatorPrefix: Schema.optional(NonBlankStringSchema),
    profile: Schema.optional(AnyRideProfileSchema),
    /**
     * Representative GTFS stops to poll, each with the routes it serves. AnyRide
     * has no messages endpoint: a message is only visible at the stops polled.
     */
    stops: Schema.optional(
      Schema.Array(
        Schema.Struct({
          stopId: NonBlankStringSchema,
          routeIds: Schema.Array(NonBlankStringSchema).check(Schema.isMinLength(1)),
        }),
      ).check(Schema.isMinLength(1)),
    ),
    /** `url` serves the daemon's normalized message document instead of AnyRide. */
    relay: Schema.optional(Schema.Literal("daemon-document")),
  }).check(
    Schema.makeFilter((source) => {
      if (source.relay !== undefined) return undefined;
      if (source.operatorPrefix === undefined) {
        return { path: ["operatorPrefix"], issue: "is required unless relay is declared" };
      }
      return source.stops === undefined
        ? { path: ["stops"], issue: "is required unless relay is declared" }
        : undefined;
    }),
  ),
]);
export type AlertSource = Schema.Schema.Type<typeof AlertSourceSchema>;

const realtimeFeedCommonFields = {
  url: HttpUrlSchema,
  format: Schema.Union([Schema.Literal("protobuf"), Schema.Literal("json")]),
  auth: Schema.optional(FeedAuthSchema),
  pollIntervalSeconds: Schema.optional(PositiveFiniteNumberSchema),
  /** Optional station-line scope for per-stop departures feeds. */
  lineIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  unreliableVehicleFields: Schema.optional(Schema.Array(RealtimeVehicleFieldSchema)),
  /** Optional local-dev proxy prefix for runtimes unable to reach an upstream directly. */
  devProxyPrefix: Schema.optional(NonBlankStringSchema),
};

const IdPrefixPatternSchema = NonBlankStringSchema.check(
  Schema.makeFilter((value) => {
    try {
      const pattern = new RegExp(value, "u");
      return value.startsWith("^") && !pattern.test("")
        ? undefined
        : "must match a nonempty leading prefix";
    } catch {
      return "must be a valid anchored regular expression";
    }
  }),
);

export const TripDirectionExtensionSchema = Schema.Struct({
  fieldNumber: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1000),
    Schema.isLessThanOrEqualTo(536870911),
  ),
  directionFieldNumber: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(1),
    Schema.isLessThanOrEqualTo(536870911),
  ),
  values: Schema.Record(NonBlankStringSchema, Schema.Union([Schema.Literal(0), Schema.Literal(1)])),
});
export type TripDirectionExtension = Schema.Schema.Type<typeof TripDirectionExtensionSchema>;

const gtfsRtFeedFields = {
  completeTripUpdates: Schema.optional(Schema.Literal(true)),
  vehicleTripSource: Schema.optional(Schema.Literal("entity-trip-update")),
  tripDirectionExtension: Schema.optional(TripDirectionExtensionSchema),
  emptyTripUpdates: Schema.optional(Schema.Literal("error")),
  predictionTimeSource: Schema.optional(Schema.Literal("static-with-delay")),
  stopIdAliases: Schema.optional(Schema.Literal("static-code")),
  idNamespace: Schema.optional(FeedNamespaceSchema),
  /** Explicit media type for a GTFS-RT feed's Accept request header. */
  accept: Schema.optional(FeedAcceptSchema),
  /** Resolve trip directions from static membership when vendor descriptors are unreliable. */
  tripDirectionSource: Schema.optional(Schema.Literal("static")),
  /** Collapse duplicate upstream vehicle fixes that report the same trip. Opt-in. */
  duplicateVehicleFixes: Schema.optional(DuplicateVehicleFixesSchema),
  /**
   * GTFS-RT alerts feed whose active `NO_SERVICE` alerts name cancelled trips in
   * `informed_entity.trip`. Predictions for those trips are dropped, because the
   * operator's trip feed may keep predicting a trip its alerts have cancelled.
   * Opt-in, and read with this feed's auth and Accept override.
   */
  cancelledTripsFrom: Schema.optional(HttpUrlSchema),
};

/** Generated from official stops.txt and trips.txt by the manual seeder. */
export const TsimobileGtfsIndexSchema = Schema.Struct({
  stops: Schema.Record(NonBlankStringSchema, NonBlankStringSchema),
  trains: Schema.Record(
    NonBlankStringSchema,
    Schema.Struct({
      routeId: NonBlankStringSchema,
      directionId: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
      headsign: NonBlankStringSchema,
    }),
  ),
});
export type TsimobileGtfsIndex = Schema.Schema.Type<typeof TsimobileGtfsIndexSchema>;

/** Hub boards whose rides list every call, so a few hubs reveal every stop they serve. */
export const StationTimetablesSourceSchema = Schema.Struct({
  /** Hub stations polled; their rides reveal every other stop they serve. */
  stations: NonEmptyStringArraySchema,
  /** Region codes ending each stop's city name (`Toronto, ON`) that this agency owns. */
  cityRegions: NonEmptyStringArraySchema,
});
export type StationTimetablesSource = Schema.Schema.Type<typeof StationTimetablesSourceSchema>;

/** Seeder-generated; station times are offset-free, so each code carries its GTFS zone. */
export const TrainMapGtfsIndexSchema = Schema.Struct({
  stops: Schema.Record(
    NonBlankStringSchema,
    Schema.Struct({
      stopId: NonBlankStringSchema,
      name: NonBlankStringSchema,
      /** The published `trip_headsign` of trains terminating here, when they agree on one. */
      headsign: Schema.optional(NonBlankStringSchema),
      timeZone: TimeZoneSchema,
    }),
  ),
  trains: Schema.Record(
    NonBlankStringSchema,
    Schema.Struct({
      routeId: NonBlankStringSchema,
      directionId: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
    }),
  ),
});
export type TrainMapGtfsIndex = Schema.Schema.Type<typeof TrainMapGtfsIndexSchema>;

const HexSchema = NonBlankStringSchema.check(
  Schema.makeFilter((value) =>
    /^(?:[0-9a-f]{2})+$/.test(value) ? undefined : "must be lowercase hexadecimal bytes",
  ),
);

/** Public key material from the operator's own web client; a rotation is a manifest change. */
export const TrainMapDecryptionSchema = Schema.Struct({
  publicKey: NonBlankStringSchema,
  salt: HexSchema,
  iv: HexSchema,
  iterations: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 })),
  /** Base64 characters at the end of the body that carry the per-request password. */
  passwordLength: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4_096 })),
});
export type TrainMapDecryption = Schema.Schema.Type<typeof TrainMapDecryptionSchema>;

const TerminalCodeSchema = Schema.String.check(
  Schema.makeFilter((value) =>
    /^[A-Z]{3}$/.test(value) ? undefined : "must be a three-letter uppercase terminal code",
  ),
);

/** Generated from official trips.txt by the manual seeder; keyed `DEPT>DEST`. */
export const FerrySailingLegIndexSchema = Schema.Record(
  NonBlankStringSchema,
  Schema.Struct({
    routeId: NonBlankStringSchema,
    directionId: Schema.Union([Schema.Literal(0), Schema.Literal(1)]),
    headsign: NonBlankStringSchema,
  }),
);
export type FerrySailingLegIndex = Schema.Schema.Type<typeof FerrySailingLegIndexSchema>;

const ferrySailingBoardsFeedSchema = Schema.Struct({
  ...realtimeFeedCommonFields,
  ...unsupportedAcceptField,
  kind: Schema.Literal("ferry_sailing_boards"),
  format: Schema.Literal("json"),
  /** Wall-clock zone of the board's offset-free timestamps. */
  timeZone: TimeZoneSchema,
  /** Curated operator terminal code → GTFS parent station ID. */
  terminals: Schema.Record(TerminalCodeSchema, NonBlankStringSchema),
  /** Curated board identities and their GTFS routes; the API has no listing endpoint. */
  boards: Schema.Array(
    Schema.Struct({
      terminal: TerminalCodeSchema,
      board: NonBlankStringSchema,
      routeId: NonBlankStringSchema,
    }),
  ).check(Schema.isMinLength(1)),
  /** Seed-generated direction and headsign per terminal pair. */
  legs: FerrySailingLegIndexSchema,
  /** Seed-generated rider-facing terminal names for pairs absent from the static feed. */
  terminalNames: Schema.Record(TerminalCodeSchema, NonBlankStringSchema),
}).check(
  Schema.makeFilter((feed) => {
    if (!feed.url.includes("{terminal}") || !feed.url.includes("{board}")) {
      return { path: ["url"], issue: "must include the {terminal} and {board} placeholders" };
    }
    const unknown = feed.boards.find((board) => feed.terminals[board.terminal] === undefined);
    if (unknown) {
      return { path: ["boards"], issue: `terminal ${unknown.terminal} is not declared` };
    }
    return undefined;
  }),
);

/** Field paths are dot-separated object keys; arrays are selected explicitly. */
export const StationDeparturesResponseMappingSchema = Schema.Struct({
  networkStations: Schema.optional(
    Schema.Struct({
      path: NonBlankStringSchema,
      idField: NonBlankStringSchema,
      groupsField: NonBlankStringSchema,
      stopCodes: Schema.Record(NonBlankStringSchema, NonBlankStringSchema),
    }),
  ),
  routeAliases: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  directionAliases: Schema.optional(Schema.Record(NonBlankStringSchema, Schema.Literals([0, 1]))),
  timeFormat: Schema.optional(Schema.Literals(["countdown-seconds", "local-time"])),
  updatedAtField: Schema.optional(NonBlankStringSchema),
  maxAgeSeconds: Schema.optional(PositiveFiniteNumberSchema),
  realtimeOnly: Schema.optional(Schema.Boolean),
  delaySecondsField: Schema.optional(NonBlankStringSchema),
  stopSequenceField: Schema.optional(NonBlankStringSchema),
  timeZone: Schema.optional(TimeZoneSchema),
  scheduledTimeField: Schema.optional(NonBlankStringSchema),
  realtimePresenceField: Schema.optional(NonBlankStringSchema),
  routesPath: NonBlankStringSchema,
  routeIdField: NonBlankStringSchema,
  departuresField: NonBlankStringSchema,
  timeField: NonBlankStringSchema,
  directionField: Schema.optional(NonBlankStringSchema),
  directionPattern: Schema.optional(IncidentIdentityPatternSchema),
  headsignField: Schema.optional(NonBlankStringSchema),
  tripIdField: Schema.optional(NonBlankStringSchema),
  realtimeField: Schema.optional(NonBlankStringSchema),
  cancelledField: Schema.optional(NonBlankStringSchema),
  offRouteField: Schema.optional(NonBlankStringSchema),
  stopClosedField: Schema.optional(NonBlankStringSchema),
  terminalField: Schema.optional(NonBlankStringSchema),
});
export type StationDeparturesResponseMapping = Schema.Schema.Type<
  typeof StationDeparturesResponseMappingSchema
>;

const stationDeparturesFeedSchema = Schema.Struct({
  ...realtimeFeedCommonFields,
  ...unsupportedAcceptField,
  kind: Schema.Literal("station_departures"),
  headers: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  method: Schema.optional(Schema.Union([Schema.Literal("GET"), Schema.Literal("POST")])),
  bodyTemplate: Schema.optional(Schema.Record(NonBlankStringSchema, Schema.String)),
  dateTimezone: Schema.optional(TimeZoneSchema),
  requestStopIdPattern: Schema.optional(IncidentIdentityPatternSchema),
  emptyBoardIsError: Schema.optional(Schema.Boolean),
  responseMapping: Schema.optional(StationDeparturesResponseMappingSchema),
  requestsPerMinute: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10000 })),
  ),
}).check(
  Schema.makeFilter((feed) => {
    if (feed.format !== "json") {
      return { path: ["format"], issue: "must be json for station_departures feeds" };
    }
    if (feed.requestsPerMinute && !feed.pollIntervalSeconds)
      return { path: ["requestsPerMinute"], issue: "requires pollIntervalSeconds" };
    if (feed.bodyTemplate && feed.method !== "POST") {
      return { path: ["bodyTemplate"], issue: "requires POST" };
    }
    if (
      !feed.responseMapping?.networkStations &&
      !feed.url.includes("{stopId}") &&
      !Object.values(feed.bodyTemplate ?? {}).some((value) => value.includes("{stopId}"))
    ) {
      return { path: ["url"], issue: "must include the {stopId} placeholder" };
    }
    return undefined;
  }),
);

export const RealtimeFeedConfigSchema = Schema.Union([
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("samsara_boards"),
    format: Schema.Literal("json"),
    trackerOrigin: HttpUrlSchema,
    orgId: NonBlankStringSchema,
    requestsPerMinute: Schema.optional(Schema.Int.check(Schema.isGreaterThan(0))),
    stations: Schema.Record(
      NonBlankStringSchema,
      Schema.Struct({
        name: NonBlankStringSchema,
        lat: Schema.Number,
        lon: Schema.Number,
        routeIds: Schema.Array(NonBlankStringSchema),
      }),
    ),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("cityway"),
    format: Schema.Literal("json"),
    riderPageUrl: HttpUrlSchema,
    networkId: NonBlankStringSchema,
    timeZone: TimeZoneSchema,
    stopMap: Schema.Record(
      NonBlankStringSchema,
      Schema.Array(
        Schema.Struct({
          logicalStopId: NonBlankStringSchema,
          physicalStopId: NonBlankStringSchema,
          lineId: NonBlankStringSchema,
          routeId: NonBlankStringSchema,
          direction: Schema.Literals([1, 2]),
        }),
      ),
    ),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("passio"),
    format: Schema.Literal("json"),
    userId: NonBlankStringSchema,
    timeZone: TimeZoneSchema,
    routeMap: Schema.Record(NonBlankStringSchema, NonBlankStringSchema),
    stopRoutes: Schema.Record(NonBlankStringSchema, NonEmptyStringArraySchema),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("hubup"),
    format: Schema.Literal("json"),
    companyTag: NonBlankStringSchema,
    tailsUrl: HttpUrlSchema,
    timeZone: TimeZoneSchema,
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("zenbus"),
    format: Schema.Literal("protobuf"),
    gtfsIndex: Schema.Record(
      NonBlankStringSchema,
      Schema.Struct({
        routeId: NonBlankStringSchema,
        stopIds: NonEmptyStringArraySchema,
        directionId: Schema.Literals([0, 1]),
        headsign: Schema.String,
      }),
    ),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("tripspark"),
    format: Schema.Literal("json"),
    dateTimezone: TimeZoneSchema,
    vehicleTimeZone: TimeZoneSchema,
    sessionTokenArgument: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 8 })),
    ),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("bustime"),
    format: Schema.Literal("xml"),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("transloc"),
    emptyArrivals: Schema.optional(Schema.Literal("error")),
    stopIdField: Schema.optional(Schema.Literals(["StopId", "RouteStopId"])),
    format: Schema.Literal("json"),
    idPrefix: Schema.optional(Schema.String),
    routeIds: NonEmptyStringArraySchema,
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("fleet_integrations"),
    format: Schema.Literal("json"),
    routeIds: NonEmptyStringArraySchema,
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("swiftly"),
    format: Schema.Literal("json"),
  }),
  ferrySailingBoardsFeedSchema,
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("tsimobile"),
    format: Schema.Literal("json"),
    gtfsIndex: TsimobileGtfsIndexSchema,
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("train_map"),
    /** The decrypted document; the wire body is an encrypted text envelope. */
    format: Schema.Literal("json"),
    decryption: TrainMapDecryptionSchema,
    /** Zone of each train's offset-free `updated_at` record time. */
    recordTimeZone: TimeZoneSchema,
    gtfsIndex: TrainMapGtfsIndexSchema,
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    ...StationTimetablesSourceSchema.fields,
    kind: Schema.Literal("station_timetables"),
    format: Schema.Literal("json"),
    /** Board history kept so a ride already past its hub still carries its later calls. */
    lookbackHours: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 })),
    lookaheadHours: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 12 })),
    /** Seed-generated direction of each line's published direction label. */
    directions: Schema.Record(
      NonBlankStringSchema,
      Schema.Record(NonBlankStringSchema, Schema.Union([Schema.Literal(0), Schema.Literal(1)])),
    ),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...gtfsRtFeedFields,
    kind: Schema.Literal("vehicle_positions"),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...gtfsRtFeedFields,
    kind: Schema.Literal("trip_updates"),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...gtfsRtFeedFields,
    kind: Schema.Literal("station_trip_updates"),
  }),
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("nextbus"),
  }),
  stationDeparturesFeedSchema,
  Schema.Struct({
    ...realtimeFeedCommonFields,
    ...unsupportedAcceptField,
    kind: Schema.Literal("tmix_anyride"),
    /**
     * Required: AnyRide is multi-tenant, so an operator prefix is the only
     * thing keeping other municipalities' vehicles off this agency's map.
     */
    operatorPrefix: NonBlankStringSchema,
    /** Request headers the tenant's own web app sends; absent sends none. */
    profile: Schema.optional(AnyRideProfileSchema),
    /** Seed-generated GTFS stop ID → AnyRide external stop-area query. Presence opts into generation. */
    stopAreaMap: Schema.optional(Schema.Record(Schema.String, NonBlankStringSchema)),
    /** Collapse one physical bus reported through several calls. Opt-in. */
    duplicateVehicleFixes: Schema.optional(TmixDuplicateVehicleFixesSchema),
  }).check(
    Schema.makeFilter((feed) => {
      if (feed.format !== "json") {
        return { path: ["format"], issue: "must be json for tmix_anyride feeds" };
      }
      return undefined;
    }),
  ),
]);
export type RealtimeFeedConfig = Schema.Schema.Type<typeof RealtimeFeedConfigSchema>;

export const StaticGtfsFeedSchema = Schema.Struct({
  idNamespace: Schema.optional(FeedNamespaceSchema),
  stripIdPrefixPattern: Schema.optional(IdPrefixPatternSchema),
  name: Schema.optional(NonBlankStringSchema),
  url: HttpUrlSchema,
  cacheFileName: Schema.optional(NonBlankStringSchema),
  /** Builds the archive from station boards instead of downloading a published GTFS. */
  zenbus: Schema.optional(Schema.Struct({ timeZone: TimeZoneSchema })),
  samsaraStations: Schema.optional(
    Schema.Struct({
      timeZone: TimeZoneSchema,
      routeAliases: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
      coordinateOverrides: Schema.optional(
        Schema.Record(
          NonBlankStringSchema,
          Schema.Struct({ lat: Schema.Number, lon: Schema.Number }),
        ),
      ),
    }),
  ),
  passio: Schema.optional(
    Schema.Struct({ userId: NonBlankStringSchema, timeZone: TimeZoneSchema }),
  ),
  stationTimetables: Schema.optional(
    Schema.Struct({
      ...StationTimetablesSourceSchema.fields,
      /** Zone the archive's scheduled times of day are written in. */
      timeZone: TimeZoneSchema,
    }),
  ),
});
export type StaticGtfsFeed = Schema.Schema.Type<typeof StaticGtfsFeedSchema>;

export const StaticTopologySourceSchema = Schema.Struct({
  /** Published fleet services with live positions but no stop or shape feed. */
  vehicleOnlyRoutes: Schema.optional(
    Schema.Array(
      Schema.Struct({
        id: NonBlankStringSchema,
        shortName: NonBlankStringSchema,
        longName: NonBlankStringSchema,
      }),
    ),
  ),
  routeDirectionIds: Schema.optional(Schema.Record(NonBlankStringSchema, Schema.Literals([0, 1]))),
  additionalRouteTypes: Schema.optional(
    Schema.Array(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  ),
  /** Source operators selected from a shared GTFS archive. Realtime is restricted to seeded trips. */
  sourceAgencyIds: Schema.optional(NonEmptyStringArraySchema),
  /** Raw GTFS route IDs omitted from rider-facing topology, before ID folding. */
  excludedRouteIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  feeds: Schema.optional(Schema.Array(StaticGtfsFeedSchema)),
  defaultColor: Schema.optional(NonBlankStringSchema),
  defaultTextColor: Schema.optional(NonBlankStringSchema),
  /**
   * Seed every route with `defaultColor` and `defaultTextColor` instead of the
   * feed's `route_color` and `route_text_color`. For feeds that publish one
   * placeholder colour on every route.
   */
  ignoreFeedRouteColors: Schema.optional(Schema.Boolean),
  source: Schema.optional(Schema.Union([Schema.Literal("nextbus"), Schema.Literal("seed")])),
  agencySlug: Schema.optional(NonBlankStringSchema),
  /** Field used as the stable route ID across static and realtime feeds. */
  routeIdField: Schema.optional(Schema.Union([Schema.Literal("id"), Schema.Literal("short_name")])),
}).check(
  Schema.makeFilter((topology) => {
    const issues: Schema.FilterIssue[] = [];
    const feeds = topology.feeds ?? [];
    const vehicleRouteIds = (topology.vehicleOnlyRoutes ?? []).map((route) => route.id);
    if (duplicateValues(vehicleRouteIds).length > 0)
      issues.push(...duplicateIssue(["vehicleOnlyRoutes"], vehicleRouteIds));
    const feedUrls = feeds.map((feed) => feed.url);
    if (duplicateValues(feedUrls).length > 0) {
      issues.push(...duplicateIssue(["feeds"], feedUrls));
    }
    if (
      feeds.length > 0 &&
      (topology.source ?? "nextbus") === "nextbus" &&
      topology.agencySlug === undefined
    ) {
      issues.push({
        path: ["agencySlug"],
        issue: "is required when staticTopology.source is nextbus",
      });
    }
    return issues;
  }),
);
export type StaticTopologySource = Schema.Schema.Type<typeof StaticTopologySourceSchema>;

export const CityPresetSchema = Schema.Struct({
  name: NonBlankStringSchema,
  lat: LatitudeSchema,
  lon: LongitudeSchema,
});
export type CityPreset = Schema.Schema.Type<typeof CityPresetSchema>;

/** Declarative per-agency route id normalization applied by Core interpretation. */
export const RouteIdNormalizationSchema = Schema.Struct({
  /** Versioned feed route IDs mapped to stable public route IDs. */
  aliases: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  /** Case-insensitive prefix stripped unless the next character is a letter. */
  stripPrefix: Schema.optional(NonBlankStringSchema),
  /** Regex source with exactly one capture group; the group is the normalized id. */
  extractPattern: Schema.optional(NonBlankStringSchema),
}).check(
  Schema.makeFilter((config) => {
    if (config.extractPattern === undefined) return undefined;
    try {
      new RegExp(config.extractPattern);
    } catch {
      return {
        path: ["extractPattern"],
        issue: "must be a valid regular expression",
      };
    }
    return countCaptureGroups(config.extractPattern) === 1
      ? undefined
      : {
          path: ["extractPattern"],
          issue: "must contain exactly one capture group",
        };
  }),
);
export type RouteIdNormalization = Schema.Schema.Type<typeof RouteIdNormalizationSchema>;

/** Counts regex capture groups, ignoring escaped parens and character classes. */
function countCaptureGroups(source: string): number {
  let count = 0;
  let inClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i];
    if (char === "\\") {
      i += 1;
      continue;
    }
    if (char === "[") {
      inClass = true;
      continue;
    }
    if (char === "]") {
      inClass = false;
      continue;
    }
    if (!inClass && char === "(" && source[i + 1] !== "?") count += 1;
  }
  return count;
}

/** Alert categories shared by every agency-facing snapshot. */
export const AlertKindSchema = Schema.Union([
  Schema.Literal("delay"),
  Schema.Literal("slow-service"),
  Schema.Literal("suspension"),
  Schema.Literal("accessibility"),
  Schema.Literal("upcoming"),
  Schema.Literal("information"),
]);
export type AlertKind = Schema.Schema.Type<typeof AlertKindSchema>;

/** Source-independent service-change detail used by surface presentation. */
export const AlertServiceChangeSchema = Schema.Literal("detour");
export type AlertServiceChange = Schema.Schema.Type<typeof AlertServiceChangeSchema>;

/** Scope of the operational impact, distinct from its severity. */
export const AlertScopeSchema = Schema.Union([
  Schema.Literal("network"),
  Schema.Literal("line"),
  Schema.Literal("segment"),
  Schema.Literal("station"),
  Schema.Literal("route"),
  /** Named trips only, such as a cancelled departure. Never a whole line. */
  Schema.Literal("trip"),
]);
export type AlertScope = Schema.Schema.Type<typeof AlertScopeSchema>;

const AlertEffectValueSchema = Schema.Union([NonBlankStringSchema, FiniteNumberSchema]);
export const AlertSourceValueSchema = Schema.Union([
  NonBlankStringSchema,
  FiniteNumberSchema,
  Schema.Boolean,
]);
export type AlertSourceValue = Schema.Schema.Type<typeof AlertSourceValueSchema>;

/** A generic predicate evaluated against protocol fields and optional text. */
export const AlertInterpretationRuleSchema = Schema.Struct({
  priority: Schema.optional(Schema.Int),
  match: Schema.Struct({
    effects: Schema.optional(Schema.Array(AlertEffectValueSchema)),
    sourceField: Schema.optional(NonBlankStringSchema),
    sourceValue: Schema.optional(AlertSourceValueSchema),
    textIncludes: Schema.optional(NonEmptyStringArraySchema),
    titleIncludes: Schema.optional(NonEmptyStringArraySchema),
  }),
  result: Schema.Struct({
    kind: AlertKindSchema,
    severity: SeveritySchema,
    serviceChange: Schema.optional(AlertServiceChangeSchema),
  }),
}).check(
  Schema.makeFilter((rule) => {
    const { effects, sourceField, sourceValue, textIncludes, titleIncludes } = rule.match;
    const hasPredicate =
      (effects?.length ?? 0) > 0 ||
      sourceField !== undefined ||
      (textIncludes?.length ?? 0) > 0 ||
      (titleIncludes?.length ?? 0) > 0;
    if (sourceValue !== undefined && sourceField === undefined) {
      return { path: ["match", "sourceValue"], issue: "requires sourceField" };
    }
    return hasPredicate ? undefined : { path: ["match"], issue: "must declare a predicate" };
  }),
);
export type AlertInterpretationRule = Schema.Schema.Type<typeof AlertInterpretationRuleSchema>;

/** Declarative Core alert interpretation and attribution policy for a manifest. */
export const AlertInterpretationConfigSchema = Schema.Struct({
  /** Treat explicit title dates and holiday occurrence clauses as impact windows. */
  titleDateTimezone: Schema.optional(TimeZoneSchema),
  /** Preserve verified machine service windows when title dates are publication captions. */
  preserveFeedPeriods: Schema.optional(Schema.Boolean),
  /** Exact publisher timestamp used to mean an unknown retirement. */
  openEndedEndTimestamp: Schema.optional(FiniteNumberSchema),
  /** Reconcile untimed web copies only against a unique matching timed incident. */
  reconcileUntimedNotices: Schema.optional(Schema.Boolean),
  /** One capture containing a feed stop ID in an explicitly published stop-scoped notice. */
  stopIdPattern: Schema.optional(IncidentIdentityPatternSchema),
  /** Retire paired publication-dated cancellations only after an explicit later restoration. */
  reconcilePublishedRestorations: Schema.optional(Schema.Boolean),
  lineIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  routeLineMap: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  /** Published route names used only when an alert carries no explicit route scope, on any transport. */
  routeNames: Schema.optional(Schema.Record(NonBlankStringSchema, NonEmptyStringArraySchema)),
  rules: Schema.optional(Schema.Array(AlertInterpretationRuleSchema)),
  routeIdNormalization: Schema.optional(RouteIdNormalizationSchema),
  /** Ignore a leading `Line N:` segment when comparing duplicate alert titles. */
  stripLinePrefixFromTitle: Schema.optional(Schema.Boolean),
  equipmentKeywords: Schema.optional(
    Schema.Record(NonBlankStringSchema, Schema.Array(NonBlankStringSchema)),
  ),
});
export type AlertInterpretationConfig = Schema.Schema.Type<typeof AlertInterpretationConfigSchema>;

const NonEmptyBoundsSchema = Schema.Array(BoundingBoxSchema).check(Schema.isMinLength(1));
const NonEmptyTransitModesSchema = Schema.Array(TransitModeSchema).check(Schema.isMinLength(1));

export const AttributionTranslationSchema = Schema.Struct({
  name: Schema.optional(NonBlankStringSchema),
  url: Schema.optional(HttpUrlSchema),
  license: Schema.optional(NonBlankStringSchema),
  licenseIsStatement: Schema.optional(Schema.Boolean),
});
export type AttributionTranslation = Schema.Schema.Type<typeof AttributionTranslationSchema>;

/** Defaults apply; a locale entry overrides only the fields it sets. */
export const AttributionSchema = Schema.Struct({
  name: NonBlankStringSchema,
  url: HttpUrlSchema,
  license: NonBlankStringSchema,
  /** Render a required acknowledgement verbatim instead of adding a licence prefix. */
  licenseIsStatement: Schema.optional(Schema.Boolean),
  translations: Schema.optional(Schema.Record(LocaleSchema, AttributionTranslationSchema)),
});
export type Attribution = Schema.Schema.Type<typeof AttributionSchema>;

/** Look up the locale tag then its base language; fall back to defaults. */
export function resolveLocalizedAttribution(
  attribution: Attribution,
  locale: string,
): {
  readonly name: string;
  readonly url: string;
  readonly license: string;
  readonly licenseIsStatement?: boolean;
} {
  const translations = attribution.translations ?? {};
  const key = lookupLocaleTag(locale, Object.keys(translations));
  const variant = key === undefined ? undefined : translations[key];
  const licenseIsStatement = variant?.licenseIsStatement ?? attribution.licenseIsStatement;
  return {
    name: variant?.name ?? attribution.name,
    url: variant?.url ?? attribution.url,
    license: variant?.license ?? attribution.license,
    ...(licenseIsStatement === undefined ? {} : { licenseIsStatement }),
  };
}

const agencyManifestFields = {
  id: NonBlankStringSchema,
  name: NonBlankStringSchema,
  shortName: Schema.optional(NonBlankStringSchema),
  /** Rider-facing city or region served, independent of the operator name. */
  serviceArea: Schema.optional(NonBlankStringSchema),
  serviceAreaTranslations: Schema.optional(Schema.Record(LocaleSchema, NonBlankStringSchema)),
  brandColor: Schema.optional(NonBlankStringSchema),
  locale: LocaleSchema,
  timezone: TimeZoneSchema,
  bounds: NonEmptyBoundsSchema,
  focus: Schema.optional(Schema.Struct({ lat: LatitudeSchema, lon: LongitudeSchema })),
  modes: NonEmptyTransitModesSchema,
  proximity: Schema.optional(ProximityConfigSchema),
  stationService: StationServiceSchema,
  attribution: AttributionSchema,
  status: Schema.Union([Schema.Literal("active"), Schema.Literal("experimental")]),
  scope: Schema.optional(AgencyScopeSchema),
  jurisdiction: Schema.optional(AgencyJurisdictionSchema),
  cityPresets: Schema.optional(Schema.Array(CityPresetSchema)),
  /**
   * Onboarding route ids for the Favourites tab's Popular Routes section.
   * Provider-owned data. No component may hardcode one agency's network
   *. Omit it when the agency has no suggestions. The section
   * hides then.
   */
  popularSurfaceRoutes: Schema.optional(
    NonEmptyStringArraySchema.check(
      Schema.makeFilter((ids) =>
        duplicateValues(ids).length > 0 ? duplicateIssue([], ids) : undefined,
      ),
    ),
  ),
  directionLiterals: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  /** Public route designators for chips whose canonical feed IDs differ from their short names. */
  routeShortNames: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
  routeInterpretation: Schema.optional(RouteInterpretationConfigSchema),
  alertInterpretation: Schema.optional(AlertInterpretationConfigSchema),
} as const;

interface ManifestValidationShape {
  readonly bounds: readonly BoundingBox[];
  readonly modes: readonly TransitMode[];
  readonly stationService: StationServiceConfig | readonly StationServiceConfig[];
  readonly cityPresets?: readonly CityPreset[];
}

const agencyManifestSemanticCheck = Schema.makeFilter<ManifestValidationShape>((manifest) => {
  const issues: Schema.FilterIssue[] = [];
  if (duplicateValues(manifest.modes).length > 0) {
    issues.push(...duplicateIssue(["modes"], manifest.modes));
  }
  for (const service of normalizeStationServices(manifest.stationService)) {
    if (!manifest.modes.includes(service.routeType)) {
      issues.push({
        path: ["stationService", "routeType"],
        issue: `requires the ${service.routeType} mode to be declared`,
      });
    }
  }
  for (const preset of manifest.cityPresets ?? []) {
    if (
      !manifest.bounds.some(
        (bounds) =>
          preset.lat >= bounds.minLat &&
          preset.lat <= bounds.maxLat &&
          preset.lon >= bounds.minLon &&
          preset.lon <= bounds.maxLon,
      )
    ) {
      issues.push({
        path: ["cityPresets"],
        issue: `preset "${preset.name}" must fall inside a declared bounds entry`,
      });
    }
  }
  return issues;
});

export const AgencyManifestSchema = Schema.Struct(agencyManifestFields).check(
  agencyManifestSemanticCheck,
);
export type AgencyManifest = Schema.Schema.Type<typeof AgencyManifestSchema>;

export const AgencyManifestConfigSchema = Schema.Struct({
  ...agencyManifestFields,
  alerts: Schema.optional(Schema.Array(AlertSourceSchema)),
  staticTopology: StaticTopologySourceSchema,
  realtime: Schema.Struct({
    feeds: Schema.Array(RealtimeFeedConfigSchema).check(Schema.isMinLength(1)),
  }),
}).check(agencyManifestSemanticCheck);
export type AgencyManifestConfig = Schema.Schema.Type<typeof AgencyManifestConfigSchema>;

export function parseAgencyManifestConfig(raw: unknown): {
  readonly manifest: AgencyManifest;
  readonly staticTopology: StaticTopologySource;
  readonly realtime: { readonly feeds: readonly RealtimeFeedConfig[] };
  readonly alerts?: readonly AlertSource[];
} {
  const decoded = Schema.decodeUnknownSync(AgencyManifestConfigSchema)(raw);
  const { staticTopology, realtime, alerts, ...manifest } = decoded;
  return {
    manifest,
    staticTopology,
    realtime,
    alerts,
  };
}

const SchematicPointSchema = Schema.Struct({
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
});

/** Stable, agency-scoped identity for a station drawn on a schematic. */
export const SchematicStationIdSchema = NonBlankStringSchema.check(
  Schema.makeFilter((value) =>
    /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)
      ? undefined
      : "must be a lowercase kebab-case schematic station id",
  ),
);
export type SchematicStationId = Schema.Schema.Type<typeof SchematicStationIdSchema>;

export const SchematicLineSchema = Schema.Struct({
  id: NonBlankStringSchema,
  name: NonBlankStringSchema,
  color: NonBlankStringSchema,
  /** Ordered polyline of schematic-space points tracing the full line path. */
  points: Schema.Array(SchematicPointSchema).check(Schema.isMinLength(1)),
});
export type SchematicLine = Schema.Schema.Type<typeof SchematicLineSchema>;

/** Hand-tuned text-label placement for a station on the schematic canvas. */
export const SchematicLabelSchema = Schema.Struct({
  leader: Schema.optional(Schema.Boolean),
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  rot: Schema.optional(FiniteNumberSchema),
  anchor: Schema.optional(
    Schema.Union([
      Schema.Literal("start"),
      Schema.Literal("middle"),
      Schema.Literal("end"),
      Schema.Literal("inherit"),
    ]),
  ),
});
export type SchematicLabel = Schema.Schema.Type<typeof SchematicLabelSchema>;

export const SchematicStationSchema = Schema.Struct({
  id: SchematicStationIdSchema,
  name: NonBlankStringSchema,
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  /** Ids (SchematicLine.id) of every line serving this station. */
  lines: NonEmptyStringArraySchema,
  accessible: Schema.optional(Schema.Boolean),
  /** End-of-line station; renderers may emphasize it like an interchange. */
  terminal: Schema.optional(Schema.Boolean),
  label: Schema.optional(SchematicLabelSchema),
});
export type SchematicStation = Schema.Schema.Type<typeof SchematicStationSchema>;

/** Round line-bullet rendered directly onto the schematic canvas. */
export const SchematicBadgeSchema = Schema.Struct({
  line: NonBlankStringSchema,
  /** Some agencies use a badge color without a numeric label. */
  num: Schema.String,
  x: FiniteNumberSchema,
  y: FiniteNumberSchema,
  color: NonBlankStringSchema,
  textColor: NonBlankStringSchema,
});
export type SchematicBadge = Schema.Schema.Type<typeof SchematicBadgeSchema>;

/**
 * Default camera framing for the schematic: the region operators see on
 * open plus the zoom range they may reach.
 */
const SchematicBoundsSchema = Schema.Struct({
  minX: FiniteNumberSchema,
  maxX: FiniteNumberSchema,
  minY: FiniteNumberSchema,
  maxY: FiniteNumberSchema,
}).check(
  Schema.makeFilter((bounds) => {
    const issues: Schema.FilterIssue[] = [];
    if (bounds.minX > bounds.maxX) {
      issues.push({ path: ["minX"], issue: "must be less than or equal to maxX" });
    }
    if (bounds.minY > bounds.maxY) {
      issues.push({ path: ["minY"], issue: "must be less than or equal to maxY" });
    }
    return issues;
  }),
);

export const SchematicViewportConfigSchema = Schema.Struct({
  bounds: SchematicBoundsSchema,
  minZoom: PositiveFiniteNumberSchema,
  maxZoom: PositiveFiniteNumberSchema,
}).check(
  Schema.makeFilter((viewport) =>
    viewport.minZoom <= viewport.maxZoom
      ? undefined
      : { path: ["minZoom"], issue: "must be less than or equal to maxZoom" },
  ),
);
export type SchematicViewportConfig = Schema.Schema.Type<typeof SchematicViewportConfigSchema>;

/**
 * Geographic reference anchors binding WGS84 coordinates to schematic
 * space (two west/east lon→x pairs, two north/south lat→y pairs).
 */
export const SchematicGeoProjectionSchema = Schema.Struct({
  refLonWest: LongitudeSchema,
  refLonEast: LongitudeSchema,
  refXWest: FiniteNumberSchema,
  refXEast: FiniteNumberSchema,
  refLatNorth: LatitudeSchema,
  refLatSouth: LatitudeSchema,
  refYNorth: FiniteNumberSchema,
  refYSouth: FiniteNumberSchema,
}).check(
  Schema.makeFilter((projection) => {
    const issues: Schema.FilterIssue[] = [];
    if (projection.refLonWest >= projection.refLonEast) {
      issues.push({
        path: ["refLonWest"],
        issue: "must be less than refLonEast",
      });
    }
    if (projection.refLatSouth >= projection.refLatNorth) {
      issues.push({
        path: ["refLatSouth"],
        issue: "must be less than refLatNorth",
      });
    }
    if (projection.refXWest === projection.refXEast) {
      issues.push({ path: ["refXWest"], issue: "must differ from refXEast" });
    }
    if (projection.refYNorth === projection.refYSouth) {
      issues.push({ path: ["refYNorth"], issue: "must differ from refYSouth" });
    }
    return issues;
  }),
);
export type SchematicGeoProjection = Schema.Schema.Type<typeof SchematicGeoProjectionSchema>;

/**
 * Declarative corner geometry: when a span traverses `stationId` on `lineId`,
 * renderers splice in the U-turn legs `before`/`after` the station anchor,
 * oriented by approach direction.
 */
export const SchematicCornerInsertionSchema = Schema.Struct({
  lineId: NonBlankStringSchema,
  stationId: SchematicStationIdSchema,
  before: SchematicPointSchema,
  after: SchematicPointSchema,
});
export type SchematicCornerInsertion = Schema.Schema.Type<typeof SchematicCornerInsertionSchema>;

/** Optional geographic station index used by Core's automatic stations port. */
export const SchematicStationIndexEntrySchema = Schema.Struct({
  id: NonBlankStringSchema,
  schematicId: Schema.optional(SchematicStationIdSchema),
  name: NonBlankStringSchema,
  lat: LatitudeSchema,
  lon: LongitudeSchema,
  lines: Schema.Array(NonBlankStringSchema),
  platformIds: Schema.Array(NonBlankStringSchema),
  /** Feed-owned boarding routes, independent of the simplified drawing. */
  departureRouteIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  /**
   * Destination terminal per lowercase direction word, declared on stations
   * where the feed's direction vocabulary misleads on its own. Station cards
   * show the terminal instead of the direction word, and only there: every
   * other station renders plain labels. Any agency declares the same field
   * on its own entries, and reseeds preserve it with the other curated
   * fields. No consumer branches on agency or station identity.
   */
  directionTermini: Schema.optional(Schema.Record(NonBlankStringSchema, NonBlankStringSchema)),
});
export type SchematicStationIndexEntry = Schema.Schema.Type<
  typeof SchematicStationIndexEntrySchema
>;

/**
 * A station reference in an interpreted AgencyAlert. The schematic ID is
 * repository-owned identity; the name is presentation text retained for
 * mapless and feed-only references.
 */
export const AgencyStationReferenceSchema = Schema.Struct({
  stationId: Schema.optional(SchematicStationIdSchema),
  stationName: NonBlankStringSchema,
});
export type AgencyStationReference = Schema.Schema.Type<typeof AgencyStationReferenceSchema>;

interface SchematicValidationShape {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly lines: readonly { readonly id: string }[];
  readonly stations: readonly {
    readonly id: SchematicStationId;
    readonly name: string;
    readonly lines: readonly string[];
  }[];
  readonly badges?: readonly { readonly line: string }[];
  readonly viewport: SchematicViewportConfig;
  readonly sequences?: Readonly<Record<string, readonly string[]>>;
  readonly branchSequences?: Readonly<Record<string, readonly (readonly string[])[]>>;
  readonly cornerInsertions?: readonly {
    readonly lineId: string;
    readonly stationId: SchematicStationId;
  }[];
  readonly stationAliases?: Readonly<Record<string, SchematicStationId>>;
  readonly stationIndex?: readonly {
    readonly id: string;
    readonly schematicId?: SchematicStationId;
    readonly lines: readonly string[];
  }[];
}

function schematicAliasKey(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

const schematicSemanticCheck = Schema.makeFilter<SchematicValidationShape>((schematic) => {
  const issues: Schema.FilterIssue[] = [];
  const lineIds = schematic.lines.map((line) => line.id);
  const stationIds = schematic.stations.map((station) => station.id);
  const declaredLineIds = new Set(lineIds);
  const declaredStationIds = new Set(stationIds);

  if (schematic.viewBoxWidth <= 0) {
    issues.push({ path: ["viewBoxWidth"], issue: "must be greater than zero" });
  }
  if (schematic.viewBoxHeight <= 0) {
    issues.push({ path: ["viewBoxHeight"], issue: "must be greater than zero" });
  }
  issues.push(...duplicateIssue(["lines"], lineIds));
  issues.push(...duplicateIssue(["stations"], stationIds));

  if (
    schematic.viewport.bounds.minX < 0 ||
    schematic.viewport.bounds.maxX > schematic.viewBoxWidth ||
    schematic.viewport.bounds.minY < 0 ||
    schematic.viewport.bounds.maxY > schematic.viewBoxHeight
  ) {
    issues.push({
      path: ["viewport", "bounds"],
      issue: "must be contained within the schematic viewBox",
    });
  }

  for (const station of schematic.stations) {
    for (const lineId of station.lines) {
      if (!declaredLineIds.has(lineId)) {
        issues.push({
          path: ["stations", station.name, "lines"],
          issue: `references undeclared line "${lineId}"`,
        });
      }
    }
  }

  for (const badge of schematic.badges ?? []) {
    if (!declaredLineIds.has(badge.line)) {
      issues.push({
        path: ["badges", badge.line],
        issue: `references undeclared line "${badge.line}"`,
      });
    }
  }

  const traversals = [
    ...Object.entries(schematic.sequences ?? {}),
    ...Object.entries(schematic.branchSequences ?? {}).flatMap(([lineId, branches]) =>
      branches.map((branch) => [lineId, branch] as const),
    ),
  ];
  for (const [lineId, sequence] of traversals) {
    if (!declaredLineIds.has(lineId)) {
      issues.push({
        path: ["sequences", lineId],
        issue: `references undeclared line "${lineId}"`,
      });
    }
    issues.push(...duplicateIssue(["sequences", lineId], sequence));
    for (const stationId of sequence) {
      if (!declaredStationIds.has(stationId)) {
        issues.push({
          path: ["sequences", lineId],
          issue: `references undeclared station "${stationId}"`,
        });
        continue;
      }
      const station = schematic.stations.find((candidate) => candidate.id === stationId);
      if (station && !station.lines.includes(lineId)) {
        issues.push({
          path: ["sequences", lineId],
          issue: `station "${stationId}" does not list line "${lineId}"`,
        });
      }
    }
  }

  for (const insertion of schematic.cornerInsertions ?? []) {
    if (!declaredLineIds.has(insertion.lineId)) {
      issues.push({
        path: ["cornerInsertions", insertion.lineId],
        issue: `references undeclared line "${insertion.lineId}"`,
      });
    }
    if (!declaredStationIds.has(insertion.stationId)) {
      issues.push({
        path: ["cornerInsertions", insertion.stationId],
        issue: `references undeclared station "${insertion.stationId}"`,
      });
      continue;
    }
    const station = schematic.stations.find((candidate) => candidate.id === insertion.stationId);
    if (station && !station.lines.includes(insertion.lineId)) {
      issues.push({
        path: ["cornerInsertions", insertion.stationId],
        issue: `station "${insertion.stationId}" does not list line "${insertion.lineId}"`,
      });
    }
  }

  const stationIndexIds = (schematic.stationIndex ?? []).map((station) => station.id);
  issues.push(...duplicateIssue(["stationIndex"], stationIndexIds));
  for (const station of schematic.stationIndex ?? []) {
    for (const lineId of station.lines) {
      if (!declaredLineIds.has(lineId)) {
        issues.push({
          path: ["stationIndex", station.id, "lines"],
          issue: `references undeclared line "${lineId}"`,
        });
      }
    }
    if (station.schematicId && !declaredStationIds.has(station.schematicId)) {
      issues.push({
        path: ["stationIndex", station.id, "schematicId"],
        issue: `references undeclared station "${station.schematicId}"`,
      });
    }
  }

  const aliases = schematic.stationAliases ?? {};
  const aliasKeys = Object.keys(aliases).map(schematicAliasKey);
  issues.push(...duplicateIssue(["stationAliases"], aliasKeys));
  for (const [alias, stationId] of Object.entries(aliases)) {
    if (!declaredStationIds.has(stationId)) {
      issues.push({
        path: ["stationAliases", alias],
        issue: `references undeclared station "${stationId}"`,
      });
    }
  }

  const namesByKey = new Map<string, SchematicStationId[]>();
  for (const station of schematic.stations) {
    const key = schematicAliasKey(station.name);
    namesByKey.set(key, [...(namesByKey.get(key) ?? []), station.id]);
  }
  for (const [alias, stationId] of Object.entries(aliases)) {
    const matchingStationIds = namesByKey.get(schematicAliasKey(alias)) ?? [];
    if (matchingStationIds.length > 1) {
      issues.push({
        path: ["stationAliases", alias],
        issue: `is ambiguous across stations ${matchingStationIds.join(", ")}`,
      });
    }
    if (matchingStationIds.length === 1 && matchingStationIds[0] !== stationId) {
      issues.push({
        path: ["stationAliases", alias],
        issue: `conflicts with canonical station "${matchingStationIds[0]}"`,
      });
    }
  }

  return issues;
});

/**
 * A complete drawable agency schematic. Everything the
 * renderer needs (geometry, framing, labels, badges) travels here so
 * no component hardcodes one agency's network.
 */
export const SchematicSchema = Schema.Struct({
  viewBoxWidth: PositiveFiniteNumberSchema,
  viewBoxHeight: PositiveFiniteNumberSchema,
  lines: Schema.Array(SchematicLineSchema),
  stations: Schema.Array(SchematicStationSchema),
  badges: Schema.optional(Schema.Array(SchematicBadgeSchema)),
  viewport: SchematicViewportConfigSchema,
  geoProjection: SchematicGeoProjectionSchema,
  /** Ordered schematic station ids per line id, the topology's traversal order. */
  sequences: Schema.optional(Schema.Record(Schema.String, Schema.Array(SchematicStationIdSchema))),
  branchSequences: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Array(Schema.Array(SchematicStationIdSchema).check(Schema.isMinLength(2))),
    ),
  ),
  /** Provider-owned normalized aliases for feed station names used during seed normalization. */
  stationAliases: Schema.optional(Schema.Record(NonBlankStringSchema, SchematicStationIdSchema)),
  cornerInsertions: Schema.optional(Schema.Array(SchematicCornerInsertionSchema)),
  stationIndex: Schema.optional(Schema.Array(SchematicStationIndexEntrySchema)),
}).check(schematicSemanticCheck);
export type Schematic = Schema.Schema.Type<typeof SchematicSchema>;

/** Normalized realtime arrival produced by Core's feed adapters. */
export const GenericArrivalPredictionSchema = Schema.Struct({
  isTerminalCall: Schema.optional(Schema.Boolean),
  tripId: NonBlankStringSchema,
  routeId: NonBlankStringSchema,
  directionId: FiniteNumberSchema,
  vehicleId: Schema.optional(NonBlankStringSchema),
  stopSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  stopId: Schema.optional(NonBlankStringSchema),
  predictedTime: NonNegativeFiniteNumberSchema,
  delaySeconds: FiniteNumberSchema,
  scheduleRelationship: Schema.Union([
    Schema.Literal("SCHEDULED"),
    Schema.Literal("ADDED"),
    Schema.Literal("SKIPPED"),
    Schema.Literal("NO_DATA"),
  ]),
  isRealtime: Schema.Boolean,
  /**
   * Destination display from the stop update (`stop_headsign`): the terminal
   * the trip is travelling to. Absent when the feed omits it. Optional and
   * additive so feeds without headsigns validate exactly as before.
   */
  headsign: Schema.optional(NonBlankStringSchema),
  /**
   * True when the feed published no direction and the adapter inferred
   * `directionId` from other evidence rather than reading it from the
   * operator. Optional and additive; absent means a real direction id.
   */
  directionInferred: Schema.optional(Schema.Boolean),
  directionAuthoritative: Schema.optional(Schema.Boolean),
  freshness: Schema.optional(
    Schema.Union([Schema.Literal("live"), Schema.Literal("recent"), Schema.Literal("stale")]),
  ),
  rawEntityId: Schema.optional(NonBlankStringSchema),
});
export type GenericArrivalPrediction = Schema.Schema.Type<typeof GenericArrivalPredictionSchema>;

export const GenericTripUpdateSchema = Schema.Struct({
  tripId: NonBlankStringSchema,
  routeId: NonBlankStringSchema,
  directionId: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  vehicleId: Schema.optional(NonBlankStringSchema),
  stopUpdates: Schema.Array(
    Schema.Struct({
      stopSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
      stopId: Schema.optional(NonBlankStringSchema),
      predictedTime: Schema.optional(NonNegativeFiniteNumberSchema),
      delaySeconds: Schema.optional(FiniteNumberSchema),
      relationship: Schema.optional(
        Schema.Union([
          Schema.Literal("SCHEDULED"),
          Schema.Literal("ADDED"),
          Schema.Literal("SKIPPED"),
          Schema.Literal("NO_DATA"),
        ]),
      ),
    }),
  ),
});
export type GenericTripUpdate = Schema.Schema.Type<typeof GenericTripUpdateSchema>;

export const GenericVehiclePositionSchema = Schema.Struct({
  vehicleId: NonBlankStringSchema,
  tripId: Schema.optional(NonBlankStringSchema),
  routeId: NonBlankStringSchema,
  directionId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  latitude: LatitudeSchema,
  longitude: LongitudeSchema,
  bearing: Schema.optional(
    FiniteNumberSchema.check(Schema.isBetween({ minimum: 0, maximum: 360 })),
  ),
  speed: Schema.optional(NonNegativeFiniteNumberSchema),
  currentStopSequence: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  stopId: Schema.optional(NonBlankStringSchema),
  currentStatus: Schema.optional(
    Schema.Union([
      Schema.Literal("INCOMING_AT"),
      Schema.Literal("STOPPED_AT"),
      Schema.Literal("IN_TRANSIT_TO"),
    ]),
  ),
  occupancyStatus: Schema.optional(
    Schema.Union([
      Schema.Literal("EMPTY"),
      Schema.Literal("MANY_SEATS_AVAILABLE"),
      Schema.Literal("FEW_SEATS_AVAILABLE"),
      Schema.Literal("STANDING_ROOM_ONLY"),
      Schema.Literal("CRUSHED_STANDING_ROOM_ONLY"),
      Schema.Literal("FULL"),
      Schema.Literal("NOT_ACCEPTING_PASSENGERS"),
    ]),
  ),
  timestamp: NonNegativeFiniteNumberSchema,
  freshness: Schema.optional(
    Schema.Union([Schema.Literal("live"), Schema.Literal("recent"), Schema.Literal("stale")]),
  ),
});
export type GenericVehiclePosition = Schema.Schema.Type<typeof GenericVehiclePositionSchema>;

export const EquipmentOutageSchema = Schema.Struct({
  id: NonBlankStringSchema,
  type: Schema.Union([
    Schema.Literal("elevator"),
    Schema.Literal("escalator"),
    Schema.Literal("other"),
  ]),
  equipment: NonBlankStringSchema,
  location: Schema.String,
  rawText: NonBlankStringSchema,
});
export type EquipmentOutage = Schema.Schema.Type<typeof EquipmentOutageSchema>;

export const GenericAlertTargetSchema = Schema.Struct({
  /** Published stop code, distinct from a canonical platform ID. */
  stopCode: Schema.optional(NonBlankStringSchema),
  directionText: Schema.optional(NonBlankStringSchema),
  directionId: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  routeId: Schema.optional(NonBlankStringSchema),
  stopId: Schema.optional(NonBlankStringSchema),
}).check(
  Schema.makeFilter((target) =>
    target.routeId !== undefined || target.stopId !== undefined
      ? undefined
      : { path: [], issue: "must declare routeId or stopId" },
  ),
);
export type GenericAlertTarget = Schema.Schema.Type<typeof GenericAlertTargetSchema>;

export const GenericAlertTranslationEvidenceSchema = Schema.Struct({
  field: Schema.Union([Schema.Literal("title"), Schema.Literal("description")]),
  text: NonBlankStringSchema,
  language: Schema.optional(Schema.String),
});
export type GenericAlertTranslationEvidence = Schema.Schema.Type<
  typeof GenericAlertTranslationEvidenceSchema
>;

export const AlertPeriodSchema = Schema.Struct({
  /** Missing start means the period has no lower bound. */
  startsAt: Schema.optional(NonNegativeFiniteNumberSchema),
  /** Missing end means the period has no upper bound. */
  endsAt: Schema.optional(NonNegativeFiniteNumberSchema),
}).check(
  Schema.makeFilter((period) =>
    period.startsAt === undefined || period.endsAt === undefined || period.endsAt > period.startsAt
      ? undefined
      : {
          path: ["endsAt"],
          issue: "must be greater than startsAt for a non-empty half-open period",
        },
  ),
);
export type AlertPeriodValue = Schema.Schema.Type<typeof AlertPeriodSchema>;

export const GenericAlertSchema = Schema.Struct({
  id: NonBlankStringSchema,
  /** Optional canonical source identity shared by explicitly grouped language variants. */
  incidentIdentity: Schema.optional(
    Schema.Struct({
      namespace: NonBlankStringSchema,
      value: NonBlankStringSchema,
    }),
  ),
  title: NonBlankStringSchema,
  description: Schema.optional(NonBlankStringSchema),
  startsAt: NonNegativeFiniteNumberSchema,
  endsAt: Schema.optional(NonNegativeFiniteNumberSchema),
  /** Exact non-contiguous windows for alerts that recur across separate periods. */
  activePeriods: Schema.optional(Schema.Array(AlertPeriodSchema)),
  /** GTFS-RT windows when affected service is disrupted, separate from communication time. */
  impactPeriods: Schema.optional(Schema.Array(AlertPeriodSchema)),
  routeIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  /** Preserves the route/stop relationship from GTFS informed_entity. */
  targets: Schema.optional(Schema.Array(GenericAlertTargetSchema)),
  /** Trips named by GTFS informed_entity.trip, which scope the alert to those trips. */
  tripIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  /** True when every informed_entity selector is trip-level, so the alert reaches those trips only. */
  tripScoped: Schema.optional(Schema.Literal(true)),
  /** Published stop restriction, even when the source omits the stop identity. */
  stopScoped: Schema.optional(Schema.Literal(true)),
  lineId: Schema.optional(NonBlankStringSchema),
  fromStationId: Schema.optional(NonBlankStringSchema),
  toStationId: Schema.optional(NonBlankStringSchema),
  affectedStations: Schema.optional(Schema.Array(NonBlankStringSchema)),
  equipmentOutages: Schema.optional(Schema.Array(EquipmentOutageSchema)),
  category: Schema.optional(NonBlankStringSchema),
  /** Format-adapter fields retained for declarative source rules. */
  sourceFields: Schema.optional(
    Schema.Record(Schema.String, Schema.Union([Schema.String, FiniteNumberSchema, Schema.Boolean])),
  ),
  /** Unselected source translations retained only while classifying evidence. */
  sourceTranslations: Schema.optional(Schema.Array(GenericAlertTranslationEvidenceSchema)),
  /** GTFS-RT Alert.effect, retained as a protocol value for Core interpretation. */
  effect: Schema.optional(Schema.Union([NonBlankStringSchema, FiniteNumberSchema])),
  cause: Schema.optional(Schema.Union([NonBlankStringSchema, FiniteNumberSchema])),
  updatedAt: NonNegativeFiniteNumberSchema,
}).check(
  Schema.makeFilter((alert) =>
    alert.endsAt === undefined || alert.endsAt >= alert.startsAt
      ? undefined
      : { path: ["endsAt"], issue: "must be greater than or equal to startsAt" },
  ),
);
export type GenericAlert = Schema.Schema.Type<typeof GenericAlertSchema>;

// Protocol-level, agency-agnostic decoded feed.
export const GenericDecodedFeedSchema = Schema.Struct({
  header: Schema.Struct({
    version: NonBlankStringSchema,
    timestamp: NonNegativeFiniteNumberSchema,
  }),
  tripUpdates: Schema.Array(GenericArrivalPredictionSchema),
  vehiclePositions: Schema.Array(GenericVehiclePositionSchema),
  alerts: Schema.Array(GenericAlertSchema),
  /**
   * Set when a source was read incompletely — a paginated crawl lost a page — so
   * the alerts below are everything that survived, not everything published.
   * Carried on the feed rather than raised as a failure, because a partial read
   * is still worth showing; `fetchAgencyAlerts` turns it into the same stale
   * freshness a rejected source produces, which is what stops a half-read board
   * from presenting itself as complete.
   */
  partial: Schema.optional(Schema.Boolean),
  /**
   * A shared-feed trip-only selector was dropped because the trip lookup failed,
   * so it may have been this agency's. Kept on the feed so 304 revalidation
   * stays stale until a read decodes with a working lookup.
   */
  sourceScopeIncomplete: Schema.optional(Schema.Boolean),
  /**
   * Count of malformed protobuf entities the decoder skipped. Absent when none
   * were skipped. The rest of the feed is still usable, so this is for logging
   * and does not mark the feed partial.
   */
  droppedEntities: Schema.optional(NonNegativeFiniteNumberSchema),
});
export type GenericDecodedFeed = Schema.Schema.Type<typeof GenericDecodedFeedSchema>;

// ---------------------------------------------------------------------------
// Alert-centric snapshot contract. Core interprets decoded
// feeds into these shapes and derives line status from affectedLineIds.
// ---------------------------------------------------------------------------

export const AlertLifecycleSchema = Schema.Union([
  Schema.Literal("upcoming"),
  Schema.Literal("active"),
  Schema.Literal("expired"),
]);
export type AlertLifecycle = Schema.Schema.Type<typeof AlertLifecycleSchema>;

export const FreshnessStateSchema = Schema.Union([
  Schema.Literal("live"),
  Schema.Literal("recent"),
  Schema.Literal("stale"),
  Schema.Literal("unavailable"),
]);
export type FreshnessState = Schema.Schema.Type<typeof FreshnessStateSchema>;

export const AgencyAlertTargetSchema = Schema.Struct({
  directionText: Schema.optional(NonBlankStringSchema),
  directionId: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  routeId: Schema.optional(NonBlankStringSchema),
  station: Schema.optional(AgencyStationReferenceSchema),
}).check(
  Schema.makeFilter((target) =>
    target.routeId !== undefined || target.station !== undefined
      ? undefined
      : { path: [], issue: "must declare routeId or station" },
  ),
);
export type AgencyAlertTarget = Schema.Schema.Type<typeof AgencyAlertTargetSchema>;

const AgencyAlertFieldsSchema = Schema.Struct({
  id: NonBlankStringSchema,
  /** Optional canonical source identity shared by explicitly grouped language variants. */
  incidentIdentity: Schema.optional(
    Schema.Struct({
      namespace: NonBlankStringSchema,
      value: NonBlankStringSchema,
    }),
  ),
  kind: AlertKindSchema,
  severity: SeveritySchema,
  lifecycle: AlertLifecycleSchema,
  affectedLineIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  affectedRouteIds: Schema.optional(Schema.Array(NonBlankStringSchema)),
  targets: Schema.optional(Schema.Array(AgencyAlertTargetSchema)),
  affectedStations: Schema.optional(Schema.Array(AgencyStationReferenceSchema)),
  fromStation: Schema.optional(AgencyStationReferenceSchema),
  toStation: Schema.optional(AgencyStationReferenceSchema),
  scope: AlertScopeSchema,
  serviceChange: Schema.optional(AlertServiceChangeSchema),
  equipmentOutages: Schema.optional(Schema.Array(EquipmentOutageSchema)),
  title: NonBlankStringSchema,
  description: Schema.optional(NonBlankStringSchema),
  startsAt: NonNegativeFiniteNumberSchema,
  endsAt: Schema.optional(NonNegativeFiniteNumberSchema),
  activePeriods: Schema.optional(Schema.Array(AlertPeriodSchema)),
  impactPeriods: Schema.optional(Schema.Array(AlertPeriodSchema)),
  updatedAt: NonNegativeFiniteNumberSchema,
}).check(
  Schema.makeFilter((alert) =>
    alert.endsAt === undefined || alert.endsAt >= alert.startsAt
      ? undefined
      : { path: ["endsAt"], issue: "must be greater than or equal to startsAt" },
  ),
);

const AgencyAlertKnownKeys = new Set(Object.keys(AgencyAlertFieldsSchema.fields));

/** AgencyAlert is a closed contract: removed station fields must fail, not strip. */
const StrictAgencyAlertSchema = Schema.StructWithRest(AgencyAlertFieldsSchema, [
  Schema.Record(Schema.String, Schema.Unknown),
]).check(
  Schema.makeFilter<
    Schema.Schema.Type<typeof AgencyAlertFieldsSchema> & Readonly<Record<string, unknown>>
  >((alert) => {
    const unexpectedKeys = Object.keys(alert).filter((key) => !AgencyAlertKnownKeys.has(key));
    return unexpectedKeys.length === 0
      ? undefined
      : unexpectedKeys.map((key) => ({ path: [key], issue: "unexpected AgencyAlert field" }));
  }),
);

// StructWithRest lets the closed-contract check observe excess input keys;
// valid output has no excess keys, so expose the same exact type as the field
// schema to callers.
export const AgencyAlertSchema =
  StrictAgencyAlertSchema as unknown as typeof AgencyAlertFieldsSchema;
export type AgencyAlert = Schema.Schema.Type<typeof AgencyAlertSchema>;

/**
 * The alert-centric snapshot a provider ports to Core: point-in-time
 * service state as data. Bus-only agencies emit alerts only, line-level
 * status is never stored here; schematic-bearing agencies derive it via
 * deriveLineStatuses (~/domain/interpretSnapshot).
 */
export const AgencySnapshotSchema = Schema.Struct({
  agencyId: NonBlankStringSchema,
  /** Epoch milliseconds reported by the upstream feed header, for diagnostics only. */
  sourceUpdatedAt: Schema.optional(NonNegativeFiniteNumberSchema),
  generatedAt: NonNegativeFiniteNumberSchema,
  freshness: FreshnessStateSchema,
  alerts: Schema.Array(AgencyAlertSchema),
}).check(
  Schema.makeFilter((snapshot) =>
    duplicateIssue(
      ["alerts"],
      snapshot.alerts.map((alert) => alert.id),
    ),
  ),
);
export type AgencySnapshot = Schema.Schema.Type<typeof AgencySnapshotSchema>;

// D1 core seams, re-exported for agency authors (Q2/Q17).
export type {
  TopologySource,
  StaticSnapshot,
  RouteTopology,
  StopTopology,
  TopologyError,
} from "~/domain/surface/topologySource";
export type {
  RealtimeSource,
  RealtimeSnapshot,
  RealtimeError,
} from "~/domain/surface/realtimeSource";
export type {
  StationsSource,
  StationsError,
  NearbyStationsQuery,
  SavedStationsQuery,
} from "~/domain/surface/stationsSource";
export type { DecodedFeed, DecodeError } from "~/infrastructure/realtime/gtfsRealtimeDecoder";

export interface TopologySourceContext {
  readonly d1: unknown;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

export interface RealtimeSourceContext {
  readonly getScheduledStopTimes?: import("~/domain/surface/scheduledStopTimes").ScheduledStopLookup;
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly fetch: typeof fetch;
  readonly now?: () => number;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

/**
 * Station feed transport and the static trip-terminal lookup are injected
 * independently so station and nearby boards share the same boarding facts.
 */
export interface StationsSourceContext {
  readonly getScheduledStopTimes?: import("~/domain/surface/scheduledStopTimes").ScheduledStopLookup;
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly getTripTerminals?: TripTerminalLookup;
  readonly getDirectionsForTrips?: TripDirectionLookup;
  readonly locale?: UiLocale;
  readonly now?: () => number;
  readonly fetch?: typeof fetch;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

export interface ProviderRuntimeContext {
  /** Resolves a trip an alert names to its route, when the deployment has seeded trips. */
  readonly getRoutesForTrips?: TripRouteLookup;
  readonly getSourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScopeLookup;
  readonly identityGeneration?: string;
  readonly alertConditionalCache?: Cache;
  /** Shares per-host alert request slots with other agencies polled in the same cycle. */
  readonly alertHostLimiter?: HostConcurrencyLimiter;
  readonly requestCache?: RequestScopedEffectCache;
  readonly alertSourceTypes?: readonly AlertSource["type"][];
  readonly fetch: typeof fetch;
  readonly now: () => number;
  readonly locale?: UiLocale;
  readonly getSecret?: (name: string) => string | undefined;
  readonly devProxyOrigin?: string;
}

export interface AgencyProvider {
  readonly manifest: AgencyManifest;
  readonly staticTopology: StaticTopologySource;
  readonly realtime?: {
    readonly feeds: readonly RealtimeFeedConfig[];
  };
  readonly alerts?: readonly AlertSource[];
  /**
   * Alert-centric snapshot port: Core fetches and interprets
   * the provider's declared alert sources into authoritative AgencySnapshot
   * data.
   */
  readonly snapshot?: {
    readonly get: (ctx: ProviderRuntimeContext) => Promise<AgencySnapshot>;
  };
  /**
   * Optional network map: mapless agencies can omit the schematic and the
   * shell renders their status panels without a map.
   */
  readonly schematic?: Schematic;
  // D1 surface seams. Registry stays env-free; composition root
  // calls these factories with the agency's D1 + fetch when it needs a
  // TopologySource/RealtimeSource. Undefined = agency has no surface layer.
  readonly createTopologySource?: (
    ctx: TopologySourceContext,
  ) => import("~/domain/surface/topologySource").TopologySource;
  readonly createRealtimeSource?: (
    ctx: RealtimeSourceContext,
  ) => import("~/domain/surface/realtimeSource").RealtimeSource;
  /**
   * Subway stations panel port: Core owns the nearby/saved stations
   * panel; each subway-mode agency supplies the one adapter (conformance
   * flags subway-mode providers without one). Undefined = agency has no
   * station-proximity answers.
   */
  readonly createStationsSource?: (
    ctx: StationsSourceContext,
  ) => import("~/domain/surface/stationsSource").StationsSource;
}

/**
 * Browser-safe projection of an agency catalog entry. This is intentionally
 * not an AgencyProvider: the browser has no server runtime ports to call.
 */
export interface BrowserAgency {
  readonly manifest: AgencyManifest;
  /**
   * Light schematic facts readable for any agency without loading geometry.
   * Absent for mapless agencies; the full `Schematic` loads via `loadSchematic`.
   */
  readonly light?: import("./lightIndex").AgencyLightIndex;
  /** Browser-safe display branding projected from the catalog entry. */
  readonly brandColor?: string;
  readonly brandTextColor?: string;
  /** Display capability only; feed declarations remain server-side. */
  readonly hasLiveAlerts?: boolean;
}
