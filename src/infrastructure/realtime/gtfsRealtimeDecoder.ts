import {
  readLiveStopUpdate,
  liveStopPrediction,
  canonicalFeedStopId,
  type PredictionIdentityOptions,
} from "./scheduledPredictions";
import { namespaceFeedId } from "../gtfs/feedIdentity";
import { cancelledTripIds } from "./gtfsTripDescriptor";
import type { TripRoute } from "~/domain/surface/boarding";
import { decodeTripDescriptor } from "./gtfsTripDescriptor";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ProtobufReader } from "./ProtobufReader";
import { walkFeedMessage } from "./feedMessageWalk";
import { extractStrongTitle, stripHtml } from "./stripHtml";
import {
  type ArrivalPrediction,
  inferDirectionFromBearing,
  type LiveVehiclePosition,
  type OccupancyStatus,
  type VehicleStopStatus,
} from "~/domain/surface/types";
import {
  GenericAlertSchema,
  GenericDecodedFeedSchema,
  type GenericAlertTranslationEvidence,
} from "~/agencies/types";
import type {
  GenericAlertTarget,
  RealtimeVehicleField,
  DuplicateVehicleFixes,
  RouteInterpretationConfig,
} from "~/agencies";
import { routeIdsMatch } from "~/domain/surface/routeIds";
import { collapseByKey, compareVehicleIds } from "~/domain/surface/collapseDuplicateFixes";
import { PLACEHOLDER_ALERT_TITLE } from "~/domain/alerts/placeholderTitle";
import {
  foldGtfsAlertPeriods,
  summarizeAlertPeriods,
  type AlertPeriod,
} from "~/domain/alerts/periods";
import { stableAlertFallbackId } from "~/domain/alerts/stableAlertId";
import { DEFAULT_UI_LOCALE, type UiLocale } from "~/domain/locale";
import {
  selectTranslatedText,
  translationEvidence,
  embeddedTitleEvidence,
} from "./translatedString";

/**
 * Core GTFS-RT binary decoder (D1, ADR-0007).
 *
 * Pure, zero-dependency protobuf decoder shared by every provider.
 * No fetch, no side effects, just bytes → structured feed.
 */

export class DecodeError extends Data.TaggedError("DecodeError")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export type GenericAlert = Schema.Schema.Type<typeof GenericAlertSchema>;

/**
 * Protocol-faithful route id cleanup: trim, drop empties, dedupe in
 * first-appearance order. Agency-specific normalization (prefix strips,
 * digit extraction) lives in Core interpretation, driven by the agency
 * manifest, never in the wire decoder (ADR-0007).
 */
function normalizeRouteIdListGeneric(ids: readonly string[]): readonly string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of ids) {
    const normalized = raw.trim();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    out.push(normalized);
  }
  return out;
}

export type DecodedFeedHeader = Schema.Schema.Type<typeof GenericDecodedFeedSchema>["header"];
export const DecodedFeedSchema = GenericDecodedFeedSchema;
export type DecodedFeed = Schema.Schema.Type<typeof DecodedFeedSchema>;

/** Validates a normalized feed once before it crosses into Core consumers. */
export function validateDecodedFeed(value: unknown): DecodedFeed {
  return Schema.decodeUnknownSync(DecodedFeedSchema)(value);
}

export interface GtfsRealtimeDecodeOptions extends PredictionIdentityOptions {
  readonly idNamespace?: string;
  readonly sourceAgencyScope?: import("~/domain/surface/boarding").SourceAgencyScope;
  /** Stable source identity used only when an upstream alert entity has no id. */
  readonly sourceScope?: string;
  readonly tripRoutes?: ReadonlyMap<string, TripRoute>;
  /** The trip lookup failed, so a shared-feed trip-only selector cannot be classified. */
  readonly tripLookupFailed?: boolean;
  readonly alertDescriptionField?: "description_text" | "tts_description_text";
  /** Rider locale for multilingual alert text in a single GTFS-RT feed. */
  readonly locale?: UiLocale;
  /** Provider default used after the rider's language variant is absent. */
  readonly agencyLocale?: string;
  /** Manifest-declared content language for untagged translations. */
  readonly sourceLanguage?: string;
  readonly routeInterpretation?: RouteInterpretationConfig;
  /** Feed-declared vehicle fields that must not be surfaced as telemetry. */
  readonly unreliableVehicleFields?: readonly RealtimeVehicleField[];
  /** Collapse vehicles that report the same non-empty trip into one fix. */
  readonly duplicateVehicleFixes?: DuplicateVehicleFixes;
  /** Optional route allowlist for proximity queries. */
  readonly routeIds?: ReadonlySet<string>;
  /** Optional stop allowlist for proximity arrival queries. */
  readonly stopIds?: ReadonlySet<string>;
}

const OCCUPANCY_MAP: Record<number, OccupancyStatus> = {
  0: "EMPTY",
  1: "MANY_SEATS_AVAILABLE",
  2: "FEW_SEATS_AVAILABLE",
  3: "STANDING_ROOM_ONLY",
  4: "CRUSHED_STANDING_ROOM_ONLY",
  5: "FULL",
  6: "NOT_ACCEPTING_PASSENGERS",
};

const STOP_STATUS_MAP: Record<number, VehicleStopStatus> = {
  0: "INCOMING_AT",
  1: "STOPPED_AT",
  2: "IN_TRANSIT_TO",
};

/**
 * Pure decode: bytes → DecodedFeed. Throws on malformed wire data; callers
 * wrap via `decodeGtfsRealtimeFeed` for honest Effect error channel.
 */
function decodeSync(buffer: Uint8Array, options: GtfsRealtimeDecodeOptions = {}): DecodedFeed {
  let header: DecodedFeedHeader = {
    version: "2.0",
    timestamp: Date.now(),
  };

  const tripUpdates: ArrivalPrediction[] = [];
  const vehiclePositions: LiveVehiclePosition[] = [];
  const decodedFixes: DecodedFix[] = [];
  const alerts: GenericAlert[] = [];
  let sourceScopeIncomplete = false;

  const { droppedEntities } = walkFeedMessage(buffer, {
    onHeader: (sub) => {
      header = decodeFeedHeader(sub);
    },
    onEntity: (entity) => {
      // Decode into fresh buffers and commit only on success, so a malformed
      // entity contributes nothing to the feed.
      const entityTrips: ArrivalPrediction[] = [];
      const entityVehicles: LiveVehiclePosition[] = [];
      const entityFixes: DecodedFix[] = [];
      const entityAlerts: GenericAlert[] = [];
      const scopeState = { incomplete: false };
      decodeFeedEntity(
        entity,
        header.timestamp,
        entityTrips,
        entityVehicles,
        entityAlerts,
        options,
        entityFixes,
        scopeState,
      );
      sourceScopeIncomplete ||= scopeState.incomplete;
      tripUpdates.push(...entityTrips);
      vehiclePositions.push(...entityVehicles);
      decodedFixes.push(...entityFixes);
      alerts.push(...entityAlerts);
    },
  });

  const cancelled = cancelledTripIds(buffer, options.idNamespace);
  return validateDecodedFeed({
    header,
    tripUpdates: tripUpdates.filter((arrival) => !cancelled.has(arrival.tripId)),
    vehiclePositions:
      options.duplicateVehicleFixes === "collapse-by-trip"
        ? collapseDuplicateVehicleFixes(decodedFixes)
        : vehiclePositions,
    alerts,
    ...(sourceScopeIncomplete ? { sourceScopeIncomplete } : {}),
    ...(droppedEntities > 0 ? { droppedEntities } : {}),
  });
}

/** A decoded fix and whether it carried its own timestamp or inherited the feed header's. */
interface DecodedFix {
  readonly vehicle: LiveVehiclePosition;
  readonly stamped: boolean;
}

/** True when `candidate` should replace `kept` as the one fix of a trip. */
function isPreferredFix(candidate: DecodedFix, kept: DecodedFix): boolean {
  const candidateStamped = candidate.stamped;
  const keptStamped = kept.stamped;
  if (candidateStamped !== keptStamped) return candidateStamped;
  if (candidate.vehicle.timestamp !== kept.vehicle.timestamp) {
    return candidate.vehicle.timestamp > kept.vehicle.timestamp;
  }
  return compareVehicleIds(candidate.vehicle.vehicleId, kept.vehicle.vehicleId) < 0;
}

/**
 * Collapses fixes that share a non-empty trip id into the freshest one. A
 * stamped fix beats an unstamped one, which only inherits the header time, and
 * ties go to the lowest vehicle id. Fixes without a trip id are kept untouched,
 * and the first-seen order of surviving trips is preserved.
 */
function collapseDuplicateVehicleFixes(fixes: readonly DecodedFix[]): LiveVehiclePosition[] {
  return collapseByKey(fixes, (fix) => fix.vehicle.tripId, isPreferredFix).map(
    (fix) => fix.vehicle,
  );
}

function decodeFeedHeader(reader: ProtobufReader): DecodedFeedHeader {
  let version = "2.0";
  let timestamp = Date.now();

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if (fieldNum === 1 && wireType === 2) {
      version = reader.readString();
    } else if (fieldNum === 3 && wireType === 0) {
      const tsSec = reader.readVarint();
      if (tsSec > 0) timestamp = tsSec * 1000;
    } else {
      reader.skip(wireType);
    }
  }

  return { version, timestamp };
}

function decodeFeedEntity(
  reader: ProtobufReader,
  feedTimestamp: number,
  tripUpdates: ArrivalPrediction[],
  vehiclePositions: LiveVehiclePosition[],
  alerts: GenericAlert[],
  options: GtfsRealtimeDecodeOptions,
  decodedFixes: DecodedFix[],
  scopeState: { incomplete: boolean },
): void {
  let entityId = "";

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if (fieldNum === 1 && wireType === 2) {
      entityId = namespaceFeedId(reader.readString(), options.idNamespace);
    } else if (fieldNum === 3 && wireType === 2) {
      const sub = reader.readSubReader();
      decodeTripUpdate(sub, entityId, tripUpdates, options);
    } else if (fieldNum === 4 && wireType === 2) {
      const sub = reader.readSubReader();
      const pos = decodeVehiclePosition(sub, entityId, feedTimestamp, options);
      if (pos) {
        vehiclePositions.push(pos.vehicle);
        decodedFixes.push(pos);
      }
    } else if (fieldNum === 5 && wireType === 2) {
      const sub = reader.readSubReader();
      const alert = decodeAlert(sub, entityId, feedTimestamp, options, scopeState);
      if (alert) alerts.push(alert);
    } else {
      reader.skip(wireType);
    }
  }
}

function decodeTripUpdate(
  reader: ProtobufReader,
  entityId: string,
  outArrivals: ArrivalPrediction[],
  options: GtfsRealtimeDecodeOptions,
): void {
  if (
    options.routeIds &&
    !matchesRequestedRoute(
      findRouteId(reader, options.tripRoutes, options.idNamespace),
      options.routeIds,
    )
  )
    return;

  let tripId = entityId;
  let routeId = "";
  let directionId: number | undefined;
  let vehicleId: string | undefined;
  let canceled = false;

  const stopUpdates: ReturnType<typeof readLiveStopUpdate>[] = [];
  let tripDescriptor: ReturnType<typeof decodeTripDescriptor> | undefined;

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if (fieldNum === 1 && wireType === 2) {
      const descriptor = decodeTripDescriptor(
        reader.readSubReader(),
        options.tripRoutes,
        options.idNamespace,
        options.tripDirectionExtension,
      );
      tripDescriptor = descriptor;
      tripId = descriptor.tripId ?? tripId;
      routeId = descriptor.routeId ?? routeId;
      directionId = descriptor.directionId;
      canceled = descriptor.canceled;
    } else if (fieldNum === 2 && wireType === 2) {
      const sub = reader.readSubReader();
      const stop = readLiveStopUpdate(sub, options);
      if (!options.stopIds || !stop.stopId || options.stopIds.has(stop.stopId))
        stopUpdates.push(stop);
    } else if (fieldNum === 3 && wireType === 2) {
      const sub = reader.readSubReader();
      while (sub.hasMore()) {
        const subTag = sub.readTag();
        if (!subTag) break;
        const [subField, subWire] = subTag;
        if (subField === 1 && subWire === 2)
          vehicleId = namespaceFeedId(sub.readString(), options.idNamespace) || undefined;
        else sub.skip(subWire);
      }
    } else {
      reader.skip(wireType);
    }
  }

  const normalizedTripId = tripId.trim();
  const normalizedRouteId = routeId.trim();
  const normalizedVehicleId = vehicleId?.trim() || undefined;
  const normalizedEntityId = entityId.trim() || undefined;
  // GTFS-RT permits partially populated entities. A prediction without a
  // trip or route cannot be joined to static topology, so omit that entity
  // before the normalized feed crosses the Effect Schema boundary.
  if (canceled || !normalizedTripId || !normalizedRouteId) return;

  const resolvedDirectionId = directionId ?? 0;

  for (const su of stopUpdates) {
    const prediction = tripDescriptor && liveStopPrediction(su, tripDescriptor, options);
    if (
      prediction &&
      (!options.stopIds || (prediction.stopId && options.stopIds.has(prediction.stopId)))
    ) {
      outArrivals.push({
        tripId: normalizedTripId,
        routeId: normalizedRouteId,
        directionId: resolvedDirectionId,
        vehicleId: normalizedVehicleId,
        stopSequence: su.stopSequence,
        ...prediction,
        scheduleRelationship: su.relationship ?? "SCHEDULED",
        isRealtime: true,
        rawEntityId: normalizedEntityId,
        ...(directionId === undefined ? { directionInferred: true } : {}),
        ...(su.headsign === undefined ? {} : { headsign: su.headsign }),
      });
    }
  }
}

function decodeVehiclePosition(
  reader: ProtobufReader,
  entityId: string,
  feedTimestamp: number,
  options: GtfsRealtimeDecodeOptions,
): DecodedFix | null {
  if (
    options.routeIds &&
    !matchesRequestedRoute(
      findRouteId(reader, options.tripRoutes, options.idNamespace),
      options.routeIds,
    )
  ) {
    return null;
  }

  let vehicleId = entityId;
  let tripId: string | undefined;
  let routeId = "";
  let directionId: number | undefined;
  let latitude = 0;
  let longitude = 0;
  let bearing: number | undefined;
  let speed: number | undefined;
  let currentStopSequence: number | undefined;
  let stopId: string | undefined;
  let currentStatus: VehicleStopStatus | undefined;
  let occupancyStatus: OccupancyStatus | undefined;
  let timestamp = feedTimestamp;
  let stamped = false;

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if (fieldNum === 1 && wireType === 2) {
      const descriptor = decodeTripDescriptor(
        reader.readSubReader(),
        options.tripRoutes,
        options.idNamespace,
        options.tripDirectionExtension,
      );
      tripId = descriptor.tripId;
      routeId = descriptor.routeId ?? routeId;
      directionId = descriptor.directionId;
    } else if (fieldNum === 2 && wireType === 2) {
      const sub = reader.readSubReader();
      while (sub.hasMore()) {
        const sTag = sub.readTag();
        if (!sTag) break;
        const [sField, sWire] = sTag;
        if (sField === 1 && sWire === 5) latitude = sub.readFloat();
        else if (sField === 2 && sWire === 5) longitude = sub.readFloat();
        else if (sField === 3 && sWire === 5) bearing = sub.readFloat();
        else if (sField === 5 && sWire === 5) {
          const value = sub.readFloat();
          if (!options.unreliableVehicleFields?.includes("speed")) speed = value;
        } else sub.skip(sWire);
      }
    } else if (fieldNum === 3 && wireType === 0) {
      currentStopSequence = reader.readVarint();
    } else if (fieldNum === 4 && wireType === 0) {
      currentStatus = STOP_STATUS_MAP[reader.readVarint()] || "IN_TRANSIT_TO";
    } else if (fieldNum === 5 && wireType === 0) {
      const ts = reader.readVarint();
      if (ts > 0) {
        timestamp = ts * 1000;
        stamped = true;
      }
    } else if (fieldNum === 7 && wireType === 2) {
      stopId = canonicalFeedStopId(reader.readString(), options) || undefined;
    } else if (fieldNum === 8 && wireType === 2) {
      const sub = reader.readSubReader();
      while (sub.hasMore()) {
        const sTag = sub.readTag();
        if (!sTag) break;
        const [sField, sWire] = sTag;
        if (sField === 1 && sWire === 2)
          vehicleId = namespaceFeedId(sub.readString(), options.idNamespace) || vehicleId;
        else sub.skip(sWire);
      }
    } else if (fieldNum === 9 && wireType === 0) {
      const value = reader.readVarint();
      if (!options.unreliableVehicleFields?.includes("occupancy_status")) {
        occupancyStatus = OCCUPANCY_MAP[value];
      }
    } else {
      reader.skip(wireType);
    }
  }

  if (latitude === 0 && longitude === 0) return null;

  const normalizedVehicleId = vehicleId.trim();
  const normalizedRouteId = routeId.trim();
  if (!normalizedVehicleId || !normalizedRouteId) return null;
  tripId = tripId?.trim() || undefined;

  const resolvedDirectionId =
    directionId !== undefined
      ? directionId
      : inferDirectionFromBearing(normalizedRouteId, bearing, options.routeInterpretation);

  const vehicle: LiveVehiclePosition = {
    vehicleId: normalizedVehicleId,
    routeId: normalizedRouteId,
    directionId: resolvedDirectionId,
    tripId,
    latitude,
    longitude,
    bearing,
    speed,
    currentStopSequence,
    stopId,
    currentStatus,
    occupancyStatus,
    timestamp,
  };
  return { vehicle, stamped };
}

/**
 * Finds the route in a TripDescriptor without decoding the entity payload.
 * Protobuf fields are order-independent, so this bounded first pass keeps
 * route filtering correct even when a producer does not serialize the
 * descriptor first. The full decoder rewinds only for matching entities.
 */
function findRouteId(
  reader: ProtobufReader,
  tripRoutes?: ReadonlyMap<string, TripRoute>,
  idNamespace?: string,
): string | undefined {
  const start = reader.getOffset();
  let routeId: string | undefined;

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;
    if (fieldNum === 1 && wireType === 2) {
      routeId = decodeTripDescriptor(reader.readSubReader(), tripRoutes, idNamespace).routeId;
    } else {
      reader.skip(wireType);
    }
  }

  reader.setOffset(start);
  return routeId;
}

function matchesRequestedRoute(
  routeId: string | undefined,
  requestedRouteIds: ReadonlySet<string>,
): boolean {
  if (!routeId) return false;
  for (const requestedRouteId of requestedRouteIds) {
    if (routeIdsMatch(routeId, requestedRouteId)) return true;
  }
  return false;
}

function decodeAlert(
  reader: ProtobufReader,
  entityId: string,
  feedTimestamp: number,
  options: GtfsRealtimeDecodeOptions,
  scopeState: { incomplete: boolean },
): GenericAlert | null {
  let title = PLACEHOLDER_ALERT_TITLE;
  let description: string | undefined;
  let ttsDescription: string | undefined;
  const sourceTranslations: GenericAlertTranslationEvidence[] = [];
  let hasHeaderText = false;
  const deprecatedPeriods: AlertPeriod[] = [];
  const communicationPeriods: AlertPeriod[] = [];
  const impactPeriodsFromFeed: AlertPeriod[] = [];
  let effect: string | undefined;
  let cause: string | undefined;
  const rawRouteIds: string[] = [];
  const stopIds: string[] = [];
  const tripIds: string[] = [];
  let originalSelectorCount = 0;
  let selectorCount = 0;
  let tripSelectorCount = 0;
  const targets: GenericAlertTarget[] = [];

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if ((fieldNum === 1 || fieldNum === 2 || fieldNum === 3) && wireType === 2) {
      const sub = reader.readSubReader();
      const period: { startsAt?: number; endsAt?: number } = {};
      while (sub.hasMore()) {
        const sTag = sub.readTag();
        if (!sTag) break;
        const [sField, sWire] = sTag;
        if (sField === 1 && sWire === 0) {
          period.startsAt = sub.readVarint() * 1000;
        } else if (sField === 2 && sWire === 0) {
          period.endsAt = sub.readVarint() * 1000;
        } else sub.skip(sWire);
      }
      const destination =
        fieldNum === 1
          ? deprecatedPeriods
          : fieldNum === 2
            ? communicationPeriods
            : impactPeriodsFromFeed;
      destination.push(period);
    } else if (fieldNum === 5 && wireType === 2) {
      const sub = reader.readSubReader();
      originalSelectorCount++;
      let sourceAgencyId: string | undefined;
      let routeId: string | undefined;
      let stopId: string | undefined;
      let tripRouteId: string | undefined;
      let tripId: string | undefined;
      while (sub.hasMore()) {
        const sTag = sub.readTag();
        if (!sTag) break;
        const [sField, sWire] = sTag;
        if (sField === 1 && sWire === 2) {
          sourceAgencyId = sub.readString();
        } else if (sField === 2 && sWire === 2) {
          routeId = namespaceFeedId(sub.readString(), options.idNamespace) || undefined;
        } else if (sField === 4 && sWire === 2) {
          // A trip selector scopes the alert to that trip. Its own route_id, or
          // the route the seeded trips resolve it to, attributes the alert to
          // that route; without either the trip stays unattributed.
          const trip = decodeTripDescriptor(
            sub.readSubReader(),
            options.tripRoutes,
            options.idNamespace,
          );
          tripId = trip.tripId;
          tripRouteId = trip.routeId;
        } else if (sField === 5 && sWire === 2) {
          stopId = namespaceFeedId(sub.readString(), options.idNamespace) || undefined;
        } else sub.skip(sWire);
      }
      const scope = options.sourceAgencyScope;
      const selectedRoute = routeId ?? tripRouteId;
      if (scope) {
        if (sourceAgencyId) {
          // An explicit agency is authoritative; it may name routes newer than the deployed membership.
          if (!scope.agencyIds.has(sourceAgencyId)) continue;
        } else if (
          (selectedRoute && !scope.routeIds.has(selectedRoute)) ||
          (tripId && !selectedRoute && !stopId) ||
          (!selectedRoute && stopId && !scope.stopIds.has(stopId))
        ) {
          // Shared feeds mostly omit agency_id, so ids outside this membership are another
          // operator's, including a trip-only selector the index lacks. A trip whose route
          // resolves in membership, or that names an in-membership stop, survives. When the
          // lookup itself failed, the dropped trip may be ours: report the feed incomplete.
          if (tripId && !selectedRoute && !stopId && options.tripLookupFailed)
            scopeState.incomplete = true;
          continue;
        }
      }
      selectorCount += 1;
      // A stop qualifies the affected portion of a trip, never broadens its scope.
      if (tripId) tripSelectorCount += 1;
      if (tripId) tripIds.push(tripId);
      // A route named by the selector itself wins over one resolved from a trip.
      routeId ??= tripRouteId;
      if (routeId) rawRouteIds.push(routeId);
      if (stopId) stopIds.push(stopId);
      if (routeId || stopId) targets.push({ routeId, stopId });
    } else if (fieldNum === 6 && wireType === 0) {
      cause = GTFS_RT_CAUSE_NAMES[reader.readVarint()];
    } else if (fieldNum === 7 && wireType === 0) {
      effect = GTFS_RT_EFFECT_NAMES[reader.readVarint()];
    } else if (fieldNum === 10 && wireType === 2) {
      const sub = reader.readSubReader();
      const translated = decodeTranslatedString(sub, options.locale, options.agencyLocale);
      sourceTranslations.push(
        ...translationEvidence("title", translated.translations, options.sourceLanguage),
      );
      const headerText = translated.text ? stripHtml(translated.text) || undefined : undefined;
      if (headerText) {
        title = headerText;
        hasHeaderText = true;
      }
    } else if (fieldNum === 11 && wireType === 2) {
      const sub = reader.readSubReader();
      const translated = decodeTranslatedString(sub, options.locale, options.agencyLocale);
      sourceTranslations.push(
        ...translationEvidence("description", translated.translations, options.sourceLanguage),
      );
      sourceTranslations.push(
        ...embeddedTitleEvidence(translated.translations, options.sourceLanguage),
      );
      description = translated.text?.trim() || undefined;
    } else if (fieldNum === 13 && wireType === 2) {
      const translated = decodeTranslatedString(
        reader.readSubReader(),
        options.locale,
        options.agencyLocale,
      );
      sourceTranslations.push(
        ...translationEvidence("description", translated.translations, options.sourceLanguage),
      );
      sourceTranslations.push(
        ...embeddedTitleEvidence(translated.translations, options.sourceLanguage),
      );
      ttsDescription = translated.text?.trim() || undefined;
    } else {
      reader.skip(wireType);
    }
  }

  const routeIds = normalizeRouteIdListGeneric(rawRouteIds);
  const affectedStations = [...new Set(stopIds)];
  const affectedTrips = [...new Set(tripIds)];
  const normalizedEntityId = entityId.trim() || undefined;
  const { activePeriods: selectedPeriods, impactPeriods } = foldGtfsAlertPeriods({
    active: deprecatedPeriods,
    communication: communicationPeriods,
    impact: impactPeriodsFromFeed,
  });
  const timing = summarizeAlertPeriods(selectedPeriods, feedTimestamp);

  // equipment-outage mining are agency interpretation (interpretSnapshot),
  // driven by the agency manifest.
  // Operators that never publish header_text carry the human title as a
  // <strong> run inside description_text, with the body as raw HTML. Lift
  // that run into the title and recover plain text from the description so
  // tags never reach riders literally. Plain-text bodies pass through
  // stripHtml unchanged.
  let resolvedDescription =
    (options.alertDescriptionField === "tts_description_text"
      ? (ttsDescription ?? description)
      : description
    )?.trim() || undefined;
  if (options.sourceAgencyScope && originalSelectorCount > 0 && selectorCount === 0) return null;
  if (!hasHeaderText && resolvedDescription) {
    title = extractStrongTitle(resolvedDescription) ?? title;
  }
  if (resolvedDescription) {
    resolvedDescription = stripHtml(resolvedDescription) || undefined;
  }

  const translationsForIdentity = sourceTranslations
    .map(({ field, text, language }) => ({ field, text, language: language ?? null }))
    .sort((first, second) => {
      const firstKey = `${first.field}\u0000${first.language ?? ""}\u0000${first.text}`;
      const secondKey = `${second.field}\u0000${second.language ?? ""}\u0000${second.text}`;
      return firstKey < secondKey ? -1 : firstKey > secondKey ? 1 : 0;
    });
  const alertId =
    normalizedEntityId ??
    stableAlertFallbackId("gtfs-rt-alert", options.sourceScope ?? "gtfs-rt", {
      translations: translationsForIdentity,
      routeIds: [...new Set(rawRouteIds)].sort(),
      stationIds: [...new Set(stopIds)].sort(),
      tripIds: [...new Set(tripIds)].sort(),
      effect: effect ?? null,
      cause: cause ?? null,
      activePeriods: selectedPeriods,
      impactPeriods,
    });

  return {
    id: alertId,
    title,
    description: resolvedDescription,
    sourceTranslations: sourceTranslations.length > 0 ? sourceTranslations : undefined,
    lineId: undefined,
    fromStationId: undefined,
    toStationId: undefined,
    routeIds: routeIds.length > 0 ? routeIds : undefined,
    targets: targets.length > 0 ? uniqueTargets(targets) : undefined,
    tripIds: affectedTrips.length > 0 ? affectedTrips : undefined,
    // Only when every selector is trip-level: an alert that also names a whole
    // route or stop is about more than those trips.
    tripScoped: selectorCount > 0 && tripSelectorCount === selectorCount ? true : undefined,
    affectedStations: affectedStations.length > 0 ? affectedStations : undefined,
    equipmentOutages: undefined,
    effect,
    cause,
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

/** One target per route and stop pair, so a route named by many trips appears once. */
function uniqueTargets(targets: readonly GenericAlertTarget[]): GenericAlertTarget[] {
  const seen = new Set<string>();
  return targets.filter((target) => {
    const key = `${target.routeId ?? ""}|${target.stopId ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

const GTFS_RT_CAUSE_NAMES: Record<number, string> = {
  1: "UNKNOWN_CAUSE",
  2: "OTHER_CAUSE",
  3: "TECHNICAL_PROBLEM",
  4: "STRIKE",
  5: "DEMONSTRATION",
  6: "ACCIDENT",
  7: "HOLIDAY",
  8: "WEATHER",
  9: "MAINTENANCE",
  10: "CONSTRUCTION",
  11: "POLICE_ACTIVITY",
  12: "MEDICAL_EMERGENCY",
};

const GTFS_RT_EFFECT_NAMES: Record<number, string> = {
  1: "NO_SERVICE",
  2: "REDUCED_SERVICE",
  3: "SIGNIFICANT_DELAYS",
  4: "DETOUR",
  5: "ADDITIONAL_SERVICE",
  6: "MODIFIED_SERVICE",
  7: "OTHER_EFFECT",
  8: "UNKNOWN_EFFECT",
};

interface DecodedTranslatedString {
  readonly text: string | undefined;
  readonly translations: readonly { readonly text: string; readonly language?: string }[];
}

function decodeTranslatedString(
  reader: ProtobufReader,
  locale: UiLocale = DEFAULT_UI_LOCALE,
  agencyLocale: string = DEFAULT_UI_LOCALE,
): DecodedTranslatedString {
  const translations: Array<{ text: string; language?: string }> = [];

  while (reader.hasMore()) {
    const tag = reader.readTag();
    if (!tag) break;
    const [fieldNum, wireType] = tag;

    if (fieldNum === 1 && wireType === 2) {
      const sub = reader.readSubReader();
      let text = "";
      let lang = "";
      while (sub.hasMore()) {
        const sTag = sub.readTag();
        if (!sTag) break;
        const [sField, sWire] = sTag;
        if (sField === 1 && sWire === 2) text = sub.readString();
        else if (sField === 2 && sWire === 2) lang = sub.readString();
        else sub.skip(sWire);
      }
      translations.push({ text, language: lang || undefined });
    } else {
      reader.skip(wireType);
    }
  }

  return { text: selectTranslatedText(translations, locale, agencyLocale), translations };
}

/**
 * Effect-wrapped decode: pure bytes → DecodedFeed.
 * Rejects with DecodeError on malformed wire data; empty feed is success.
 * No fetch, no side effects, agency adapters call this after their own fetch.
 */
export function decodeGtfsRealtimeFeed(
  bytes: Uint8Array,
  options: GtfsRealtimeDecodeOptions = {},
): Effect.Effect<DecodedFeed, DecodeError> {
  return Effect.try({
    try: () => decodeSync(bytes, options),
    catch: (cause) =>
      new DecodeError({
        message: cause instanceof Error ? cause.message : String(cause),
        cause,
      }),
  });
}

/**
 * Synchronous helper for callers that already handle errors non-Effectfully.
 * Kept for internal use; prefer `decodeGtfsRealtimeFeed` at seams.
 */
export function decodeGtfsRealtimeSync(
  bytes: Uint8Array | ArrayBuffer,
  options: GtfsRealtimeDecodeOptions = {},
): DecodedFeed {
  const buf = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return decodeSync(buf, options);
}
