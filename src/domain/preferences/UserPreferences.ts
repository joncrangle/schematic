import * as Schema from "effect/Schema";
import { DEFAULT_UI_LOCALE, normalizeLocale, type UiLocale } from "~/domain/locale";
import { UiLocaleSchema } from "~/domain/localeSchema";

export type DateOrder = "locale" | "ymd" | "mdy" | "dmy";
export type TimeFormat = "locale" | "12h" | "24h";
export type UnitSystem = "locale" | "metric" | "imperial";
export type Spelling = "locale" | "canadian" | "american";

export type ReduceMotion = "system" | "reduce" | "no-preference";

export type InterchangeBadgeVisibility = "full" | "compact" | "hidden";
export type InterchangeBadgeVisibilityPreference = InterchangeBadgeVisibility | null;

/**
 * Manual agency selection: `"auto"` resolves the agency from the
 * effective position's bbox match; any registered agency id pins it.
 */
export type AgencySelection = "auto" | (string & {});

export interface CommuteSchedule {
  id: string;
  label: string;
  /** Absent on legacy schedules; explicit edits retain rider-authored text. */
  labelSource?: "default" | "user";
  enabled: boolean;
  days: readonly number[]; // 0-6 (Sun-Sat)
  start: string; // '07:30'
  end: string; // '09:30'
}

/** Agency-qualified identity for a saved surface route. */
export interface FavouriteSurfaceRouteRef {
  readonly agencyId: string;
  readonly routeId: string;
}

/** Agency-qualified identity for a saved schematic line. */
export interface FavouriteLineRef {
  readonly agencyId: string;
  readonly lineId: string;
}

/** Agency-qualified identity for a saved station name. */
export interface FavouriteStationRef {
  readonly agencyId: string;
  readonly stationName: string;
}

export interface UserPreferences {
  version: 1;
  locale: UiLocale;
  dateOrder: DateOrder;
  timeFormat: TimeFormat;
  unitSystem: UnitSystem;
  /** English chrome spelling; other languages ignore it. */
  spelling: Spelling;
  reducedMotion: ReduceMotion; // default: 'system'
  showReducedSpeedZones: boolean;
  /** Null means use compact on mobile and full on desktop. */
  interchangeBadgeVisibility: InterchangeBadgeVisibilityPreference;
  favouriteLines: readonly FavouriteLineRef[];
  favouriteStations: readonly FavouriteStationRef[];
  favouriteSurfaceRoutes: readonly FavouriteSurfaceRouteRef[];
  favouriteAgencies: readonly string[];
  commuteSchedules: readonly CommuteSchedule[];
  /** Manual agency picker state: "auto" resolves via bbox match. */
  agency: AgencySelection;
}

/**
 * Preference fields that user mutations may change. The `version` tag is owned
 * exclusively by the preference codec and is never user-settable.
 */
export type MutablePreferenceKey = Exclude<keyof UserPreferences, "version">;

/**
 * Preference slices mirrored onto the server-side push subscription record.
 * Mutations to any other key skip the push-sync network call entirely;
 * `resetPreferences` subsumes all of these keys and therefore mirrors too.
 */
export const PUSH_RELEVANT_PREFERENCE_KEYS: readonly MutablePreferenceKey[] = [
  "favouriteLines",
  "favouriteStations",
  "favouriteSurfaceRoutes",
  "commuteSchedules",
  "locale",
];

export const ReduceMotionSchema = Schema.Union([
  Schema.Literal("system"),
  Schema.Literal("reduce"),
  Schema.Literal("no-preference"),
]);

export const InterchangeBadgeVisibilitySchema = Schema.Union([
  Schema.Literal("full"),
  Schema.Literal("compact"),
  Schema.Literal("hidden"),
]);

const ScheduleDaySchema = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 6 }));
const TimeOfDaySchema = Schema.String.check(Schema.isPattern(/^(?:[01]\d|2[0-3]):[0-5]\d$/));

export const CommuteScheduleSchema = Schema.Struct({
  id: Schema.NonEmptyString,
  label: Schema.NonEmptyString,
  labelSource: Schema.optional(Schema.Literals(["default", "user"])),
  enabled: Schema.Boolean,
  days: Schema.Array(ScheduleDaySchema),
  start: TimeOfDaySchema,
  end: TimeOfDaySchema,
});

export const FavouriteSurfaceRouteRefSchema = Schema.Struct({
  agencyId: Schema.NonEmptyString,
  routeId: Schema.NonEmptyString,
});

export const FavouriteLineRefSchema = Schema.Struct({
  agencyId: Schema.NonEmptyString,
  lineId: Schema.NonEmptyString,
});

export const FavouriteStationRefSchema = Schema.Struct({
  agencyId: Schema.NonEmptyString,
  stationName: Schema.NonEmptyString,
});

export const AgencySelectionSchema = Schema.Union([Schema.Literal("auto"), Schema.NonEmptyString]);

export const UserPreferencesSchema = Schema.Struct({
  version: Schema.Literal(1),
  locale: UiLocaleSchema,
  dateOrder: Schema.Literals(["locale", "ymd", "mdy", "dmy"]),
  timeFormat: Schema.Literals(["locale", "12h", "24h"]),
  unitSystem: Schema.Literals(["locale", "metric", "imperial"]),
  spelling: Schema.Literals(["locale", "canadian", "american"]),
  reducedMotion: ReduceMotionSchema,
  showReducedSpeedZones: Schema.Boolean,
  interchangeBadgeVisibility: Schema.Union([InterchangeBadgeVisibilitySchema, Schema.Null]),
  favouriteLines: Schema.Array(FavouriteLineRefSchema),
  favouriteStations: Schema.Array(FavouriteStationRefSchema),
  favouriteSurfaceRoutes: Schema.Array(FavouriteSurfaceRouteRefSchema),
  favouriteAgencies: Schema.Array(Schema.String),
  commuteSchedules: Schema.Array(CommuteScheduleSchema),
  agency: AgencySelectionSchema,
});

export const DEFAULT_PREFERENCES: UserPreferences = {
  version: 1,
  locale: DEFAULT_UI_LOCALE,
  dateOrder: "locale",
  timeFormat: "locale",
  unitSystem: "locale",
  spelling: "locale",
  reducedMotion: "system",
  showReducedSpeedZones: true,
  interchangeBadgeVisibility: null,
  favouriteLines: [],
  favouriteStations: [],
  favouriteSurfaceRoutes: [],
  favouriteAgencies: [],
  agency: "auto",
  commuteSchedules: [
    {
      id: "morning_commute",
      label: "Morning Commute",
      enabled: true,
      days: [1, 2, 3, 4, 5],
      start: "07:30",
      end: "09:30",
    },
    {
      id: "evening_commute",
      label: "Evening Commute",
      enabled: true,
      days: [1, 2, 3, 4, 5],
      start: "16:30",
      end: "18:30",
    },
  ],
};

export function isFavouriteSurfaceRoute(
  preferences: Pick<UserPreferences, "favouriteSurfaceRoutes">,
  agencyId: string,
  routeId: string,
): boolean {
  return preferences.favouriteSurfaceRoutes.some(
    (ref) => ref.agencyId === agencyId && ref.routeId === routeId,
  );
}

export function isFavouriteLine(
  preferences: Pick<UserPreferences, "favouriteLines">,
  agencyId: string,
  lineId: string,
): boolean {
  return preferences.favouriteLines.some(
    (ref) => ref.agencyId === agencyId && ref.lineId === lineId,
  );
}

export function isFavouriteStation(
  preferences: Pick<UserPreferences, "favouriteStations">,
  agencyId: string,
  stationName: string,
): boolean {
  return preferences.favouriteStations.some(
    (ref) => ref.agencyId === agencyId && ref.stationName === stationName,
  );
}

export function favouriteLineIdsForAgency(
  preferences: Pick<UserPreferences, "favouriteLines">,
  agencyId: string,
): readonly string[] {
  return preferences.favouriteLines
    .filter((ref) => ref.agencyId === agencyId)
    .map((ref) => ref.lineId);
}

export function favouriteStationNamesForAgency(
  preferences: Pick<UserPreferences, "favouriteStations">,
  agencyId: string,
): readonly string[] {
  return preferences.favouriteStations
    .filter((ref) => ref.agencyId === agencyId)
    .map((ref) => ref.stationName);
}

const decodePreferencesSync = Schema.decodeUnknownSync(UserPreferencesSchema);
const decodeCommuteScheduleSync = Schema.decodeUnknownSync(CommuteScheduleSchema);

function decodeFavouriteLineRefs(value: unknown): FavouriteLineRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const ref = item as Record<string, unknown>;
    return typeof ref.agencyId === "string" &&
      ref.agencyId.trim() &&
      typeof ref.lineId === "string" &&
      ref.lineId.trim()
      ? [{ agencyId: ref.agencyId.trim(), lineId: ref.lineId.trim() }]
      : [];
  });
}

function decodeFavouriteStationRefs(value: unknown): FavouriteStationRef[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    if (typeof item !== "object" || item === null) return [];
    const ref = item as Record<string, unknown>;
    return typeof ref.agencyId === "string" &&
      ref.agencyId.trim() &&
      typeof ref.stationName === "string" &&
      ref.stationName.trim()
      ? [{ agencyId: ref.agencyId.trim(), stationName: ref.stationName.trim() }]
      : [];
  });
}

/**
 * Decodes and validates unknown data into UserPreferences with fallback to default values.
 * Handles both JSON strings and JS objects, normalizing partial or corrupt states safely.
 */
export function decodeUserPreferences(
  raw: unknown,
  fallbackLocale: UiLocale = DEFAULT_UI_LOCALE,
): UserPreferences {
  const defaultPreferences = (): UserPreferences => structuredClone(DEFAULT_PREFERENCES);
  if (!raw) {
    return { ...defaultPreferences(), locale: fallbackLocale };
  }

  let parsed = raw;
  if (typeof raw === "string") {
    try {
      parsed = JSON.parse(raw);
    } catch {
      return { ...defaultPreferences(), locale: fallbackLocale };
    }
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { ...defaultPreferences(), locale: fallbackLocale };
  }

  if ("version" in parsed && parsed.version !== 1) {
    return { ...defaultPreferences(), locale: fallbackLocale };
  }

  try {
    return decodePreferencesSync(parsed) as UserPreferences;
  } catch {
    // Attempt fallback / graceful normalization
    const defaults = defaultPreferences();
    const candidate = parsed as Record<string, unknown>;
    const locale = normalizeLocale(candidate.locale, fallbackLocale);
    const reducedMotion: ReduceMotion =
      candidate.reducedMotion === "reduce" ||
      candidate.reducedMotion === "no-preference" ||
      candidate.reducedMotion === "system"
        ? candidate.reducedMotion
        : defaults.reducedMotion;

    const showReducedSpeedZones =
      typeof candidate.showReducedSpeedZones === "boolean"
        ? candidate.showReducedSpeedZones
        : defaults.showReducedSpeedZones;

    const interchangeBadgeVisibility =
      candidate.interchangeBadgeVisibility === "full" ||
      candidate.interchangeBadgeVisibility === "compact" ||
      candidate.interchangeBadgeVisibility === "hidden"
        ? candidate.interchangeBadgeVisibility
        : candidate.interchangeBadgeVisibility === null
          ? null
          : defaults.interchangeBadgeVisibility;

    const favouriteLines = decodeFavouriteLineRefs(candidate.favouriteLines);

    const favouriteStations = decodeFavouriteStationRefs(candidate.favouriteStations);

    const favouriteSurfaceRoutes = Array.isArray(candidate.favouriteSurfaceRoutes)
      ? candidate.favouriteSurfaceRoutes.flatMap((ref) => {
          if (typeof ref !== "object" || ref === null) return [];
          const value = ref as Record<string, unknown>;
          return typeof value.agencyId === "string" &&
            value.agencyId.length > 0 &&
            typeof value.routeId === "string" &&
            value.routeId.length > 0
            ? [{ agencyId: value.agencyId, routeId: value.routeId }]
            : [];
        })
      : defaults.favouriteSurfaceRoutes;

    const favouriteAgencies = Array.isArray(candidate.favouriteAgencies)
      ? candidate.favouriteAgencies.filter((a): a is string => typeof a === "string")
      : defaults.favouriteAgencies;

    let commuteSchedules = defaults.commuteSchedules;
    if (Array.isArray(candidate.commuteSchedules)) {
      const validSchedules: CommuteSchedule[] = [];
      for (const item of candidate.commuteSchedules) {
        try {
          validSchedules.push(decodeCommuteScheduleSync(item));
        } catch {
          // Invalid entries are discarded while valid entries survive.
        }
      }
      commuteSchedules = validSchedules;
    }

    const agency: AgencySelection =
      candidate.agency === "auto" ||
      (typeof candidate.agency === "string" && candidate.agency.length > 0)
        ? candidate.agency
        : defaults.agency;

    return {
      version: 1,
      locale,
      dateOrder:
        candidate.dateOrder === "ymd" ||
        candidate.dateOrder === "mdy" ||
        candidate.dateOrder === "dmy"
          ? candidate.dateOrder
          : "locale",
      timeFormat:
        candidate.timeFormat === "12h" || candidate.timeFormat === "24h"
          ? candidate.timeFormat
          : "locale",
      unitSystem:
        candidate.unitSystem === "metric" || candidate.unitSystem === "imperial"
          ? candidate.unitSystem
          : "locale",
      spelling:
        candidate.spelling === "canadian" || candidate.spelling === "american"
          ? candidate.spelling
          : "locale",
      reducedMotion,
      showReducedSpeedZones,
      interchangeBadgeVisibility,
      favouriteLines,
      favouriteStations,
      favouriteSurfaceRoutes,
      favouriteAgencies,
      commuteSchedules,
      agency,
    };
  }
}

/**
 * Serializes UserPreferences to a JSON string.
 */
export function encodeUserPreferences(preferences: UserPreferences): string {
  return JSON.stringify(preferences);
}
