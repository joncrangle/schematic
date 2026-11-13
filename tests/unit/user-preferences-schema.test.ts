import { describe, expect, it } from "vitest";
import {
  decodeUserPreferences,
  DEFAULT_PREFERENCES,
  encodeUserPreferences,
  type UserPreferences,
} from "~/domain/preferences/UserPreferences";
import { resolveInterchangeBadgeVisibility } from "~/domain/map/InterchangeBadgeVisibility";

describe("agency selection preference", () => {
  it("defaults to auto", () => {
    expect(DEFAULT_PREFERENCES.agency).toBe("auto");
  });

  it("round-trips a pinned agency id", () => {
    const pinned = { ...DEFAULT_PREFERENCES, agency: "go" };
    const decoded = decodeUserPreferences(encodeUserPreferences(pinned));
    expect(decoded.agency).toBe("go");
  });

  it("falls back to auto when the persisted field is missing or invalid", () => {
    const incomplete = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
    delete incomplete.agency;
    expect(decodeUserPreferences(JSON.stringify(incomplete)).agency).toBe("auto");

    const broken = { ...DEFAULT_PREFERENCES, agency: 42 };
    expect(decodeUserPreferences(broken).agency).toBe("auto");

    const empty = { ...DEFAULT_PREFERENCES, agency: "" };
    expect(decodeUserPreferences(empty).agency).toBe("auto");
  });
});

describe("favourite agencies preference", () => {
  it("defaults to an empty array", () => {
    expect(DEFAULT_PREFERENCES.favouriteAgencies).toEqual([]);
  });

  it("round-trips favourited agency ids", () => {
    const withFavourites = { ...DEFAULT_PREFERENCES, favouriteAgencies: ["ttc", "go"] };
    const decoded = decodeUserPreferences(encodeUserPreferences(withFavourites));
    expect(decoded.favouriteAgencies).toEqual(["ttc", "go"]);
  });

  it("falls back gracefully to empty array when missing or corrupt", () => {
    const incomplete = { ...DEFAULT_PREFERENCES } as Record<string, unknown>;
    delete incomplete.favouriteAgencies;
    expect(decodeUserPreferences(JSON.stringify(incomplete)).favouriteAgencies).toEqual([]);

    const broken = {
      ...DEFAULT_PREFERENCES,
      favouriteAgencies: "not-an-array" as unknown as string[],
    };
    expect(decodeUserPreferences(broken).favouriteAgencies).toEqual([]);

    const mixed = {
      ...DEFAULT_PREFERENCES,
      favouriteAgencies: ["ttc", 123, null] as unknown as string[],
    };
    expect(decodeUserPreferences(mixed).favouriteAgencies).toEqual(["ttc"]);
  });
});

describe("interchange badge visibility preference", () => {
  it("uses responsive defaults until a visibility is chosen", () => {
    expect(DEFAULT_PREFERENCES.interchangeBadgeVisibility).toBeNull();
    expect(resolveInterchangeBadgeVisibility(null, true)).toBe("compact");
    expect(resolveInterchangeBadgeVisibility(null, false)).toBe("full");
  });

  it.each(["full", "compact", "hidden"] as const)("round-trips an explicit %s choice", (mode) => {
    const preferences = { ...DEFAULT_PREFERENCES, interchangeBadgeVisibility: mode };
    expect(
      decodeUserPreferences(encodeUserPreferences(preferences)).interchangeBadgeVisibility,
    ).toBe(mode);
  });
});

describe("UserPreferences Domain & Effect Schema", () => {
  // Both accepted input forms must decode to the same value: a raw object and
  // its encodeUserPreferences JSON serialization.
  it.each([
    ["a raw object", (prefs: UserPreferences) => prefs],
    ["an encoded JSON string", (prefs: UserPreferences) => encodeUserPreferences(prefs)],
  ])("decodes valid user preferences given %s correctly", (_form, toInput) => {
    const valid: UserPreferences = {
      version: 1,
      dateOrder: "locale",
      timeFormat: "locale",
      unitSystem: "locale",
      spelling: "american",
      locale: "fr-CA",
      reducedMotion: "reduce",
      showReducedSpeedZones: false,
      interchangeBadgeVisibility: "hidden",
      favouriteLines: [
        { agencyId: "ttc", lineId: "1" },
        { agencyId: "ttc", lineId: "2" },
      ],
      favouriteStations: [
        { agencyId: "ttc", stationName: "Bloor-Yonge" },
        { agencyId: "ttc", stationName: "St George" },
      ],
      favouriteSurfaceRoutes: [
        { agencyId: "ttc", routeId: "504" },
        { agencyId: "ttc", routeId: "501" },
      ],
      favouriteAgencies: ["ttc"],
      agency: "auto",
      commuteSchedules: [
        {
          id: "work_morning",
          label: "Work Morning",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "08:00",
          end: "10:00",
        },
      ],
    };

    const decoded = decodeUserPreferences(toInput(valid));
    expect(decoded).toEqual(valid);
  });

  it("round-trips surface favourites together with their agency", () => {
    const preferences = {
      ...DEFAULT_PREFERENCES,
      favouriteSurfaceRoutes: [{ agencyId: "ttc", routeId: "501" }],
    };

    expect(
      decodeUserPreferences(encodeUserPreferences(preferences)).favouriteSurfaceRoutes,
    ).toEqual([{ agencyId: "ttc", routeId: "501" }]);
  });

  it("falls back gracefully to DEFAULT_PREFERENCES on null, undefined, or empty string", () => {
    expect(decodeUserPreferences(null)).toEqual(DEFAULT_PREFERENCES);
    expect(decodeUserPreferences(undefined)).toEqual(DEFAULT_PREFERENCES);
    expect(decodeUserPreferences("")).toEqual(DEFAULT_PREFERENCES);
  });

  it.each([null, "invalid json {[[", 12345, {}])(
    "does not share mutable defaults when decoding %p",
    (raw) => {
      const expected = structuredClone(DEFAULT_PREFERENCES);
      const first = decodeUserPreferences(raw);
      expect(first.commuteSchedules).not.toBe(DEFAULT_PREFERENCES.commuteSchedules);
      expect(first.commuteSchedules[0]).not.toBe(DEFAULT_PREFERENCES.commuteSchedules[0]);
      (first.commuteSchedules[0]!.days as number[]).push(6);
      first.commuteSchedules[0]!.label = "changed";
      (first.favouriteAgencies as string[]).push("sample");
      (first.favouriteSurfaceRoutes as unknown[]).push({ agencyId: "sample", routeId: "1" });
      expect(decodeUserPreferences(raw)).toEqual(expected);
      expect(DEFAULT_PREFERENCES).toEqual(expected);
    },
  );

  it("handles corrupted JSON strings safely by returning defaults", () => {
    expect(decodeUserPreferences("invalid json {[[")).toEqual(DEFAULT_PREFERENCES);
    expect(decodeUserPreferences(12345)).toEqual(DEFAULT_PREFERENCES);
  });

  it("normalizes partial objects and fills missing/invalid fields with defaults", () => {
    const partial = {
      version: 1,
      reducedMotion: "invalid_value",
      showReducedSpeedZones: "not_a_boolean",
      interchangeBadgeVisibility: "not-a-mode",
      favouriteLines: [{ agencyId: "ttc", lineId: "1" }, { agencyId: "", lineId: "2" }, null],
      favouriteStations: [{ agencyId: "ttc", stationName: "Union" }, "Union"],
    };

    const decoded = decodeUserPreferences(partial);
    expect(decoded.version).toBe(1);
    expect(decoded.reducedMotion).toBe("system");
    expect(decoded.showReducedSpeedZones).toBe(true);
    expect(decoded.interchangeBadgeVisibility).toBeNull();
    expect(decoded.favouriteLines).toEqual([{ agencyId: "ttc", lineId: "1" }]);
    expect(decoded.favouriteStations).toEqual([{ agencyId: "ttc", stationName: "Union" }]);
    expect(decoded.favouriteSurfaceRoutes).toEqual([]);
    expect(decoded.favouriteAgencies).toEqual([]);
    expect(decoded.commuteSchedules).toEqual(DEFAULT_PREFERENCES.commuteSchedules);
  });

  it("preserves valid commute schedules while filtering invalid items during normalization", () => {
    const partial = {
      version: 1,
      commuteSchedules: [
        {
          id: "valid_1",
          label: "Valid Schedule",
          enabled: true,
          days: [1, 2, 3],
          start: "07:00",
          end: "09:00",
          lineIds: ["1"],
          surfaceRouteIds: [],
        },
        {
          id: "corrupted_schedule",
          enabled: "not_bool",
        },
        {
          id: "invalid_time",
          label: "Invalid time",
          enabled: true,
          days: [1, 2, 3],
          start: "25:00",
          end: "09:00",
        },
      ],
    };

    const decoded = decodeUserPreferences(partial);
    expect(decoded.commuteSchedules.length).toBe(1);
    expect(decoded.commuteSchedules[0].id).toBe("valid_1");
    expect(
      (decoded.commuteSchedules[0] as unknown as Record<string, unknown>).lineIds,
    ).toBeUndefined();
    expect(
      (decoded.commuteSchedules[0] as unknown as Record<string, unknown>).surfaceRouteIds,
    ).toBeUndefined();
  });

  it.each([4, 5, 6, 99])(
    "resets unsupported preference version %s using the browser language",
    (version) => {
      expect(
        decodeUserPreferences({ ...DEFAULT_PREFERENCES, version, locale: "en-CA" }, "fr-CA"),
      ).toEqual({ ...DEFAULT_PREFERENCES, locale: "fr-CA" });
    },
  );

  it("uses the supplied locale for a v1 object with an invalid locale", () => {
    expect(decodeUserPreferences({ ...DEFAULT_PREFERENCES, locale: "de-DE" }, "fr-CA").locale).toBe(
      "fr-CA",
    );
  });
});

describe("regional display preferences", () => {
  it.each([
    { dateOrder: "locale", timeFormat: "locale", unitSystem: "locale" },
    { dateOrder: "ymd", timeFormat: "12h", unitSystem: "metric" },
    { dateOrder: "mdy", timeFormat: "24h", unitSystem: "imperial" },
    { dateOrder: "dmy", timeFormat: "locale", unitSystem: "locale" },
  ] as const)("round-trips $dateOrder, $timeFormat, $unitSystem at v1", (display) => {
    const preferences = { ...DEFAULT_PREFERENCES, ...display };
    expect(decodeUserPreferences(encodeUserPreferences(preferences))).toEqual(preferences);
  });
  it("repairs invalid display choices independently", () => {
    expect(
      decodeUserPreferences({
        ...DEFAULT_PREFERENCES,
        dateOrder: "invalid",
        timeFormat: 12,
        unitSystem: null,
        spelling: "british",
      }),
    ).toMatchObject({
      dateOrder: "locale",
      timeFormat: "locale",
      unitSystem: "locale",
      spelling: "locale",
    });
  });
});
