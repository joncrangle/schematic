import { Schema } from "effect";
import { describe, it, expect } from "vitest";
import {
  AgencyManifestConfigSchema,
  AgencyManifestSchema,
  AgencyAlertSchema,
  AgencyStationReferenceSchema,
  AgencySnapshotSchema,
  AlertInterpretationRuleSchema,
  AlertSourceSchema,
  normalizeStationServices,
  RealtimeFeedConfigSchema,
  SchematicSchema,
  resolveLocalizedAttribution,
} from "../../src/agencies/types";
import { interpretSnapshot } from "~/domain/interpretSnapshot";
import { makeMinimalSchematic } from "../helpers/fixtures";

import { makeTestManifest, makeTestProvider } from "../helpers/agency-fixtures";
const subwayManifestConfig = makeTestManifest();
const railManifestConfig = makeTestManifest({
  id: "regional",
  modes: ["rail"],
  stationService: { routeType: "rail" },
});
const busManifestConfig = makeTestManifest({
  id: "local",
  modes: ["bus"],
  stationService: { routeType: "bus" },
});
const secondBusManifestConfig = makeTestManifest({
  id: "metro",
  modes: ["bus"],
  stationService: { routeType: "bus" },
});
const providerFixture = makeTestProvider();
const manifestFixture = providerFixture.manifest;
const realtimeFeedsFixture = providerFixture.realtime?.feeds ?? [];
const alertSourcesFixture = providerFixture.alerts ?? [];

describe("agency contract schemas", () => {
  it("decodes a runtime manifest through the provider contract", () => {
    expect(Schema.decodeUnknownSync(AgencyManifestSchema)(manifestFixture)).toEqual(
      manifestFixture,
    );
  });

  it.each([subwayManifestConfig, railManifestConfig, busManifestConfig, secondBusManifestConfig])(
    "decodes manifest.json for $id through AgencyManifestConfigSchema",
    (json) => {
      expect(Schema.decodeUnknownSync(AgencyManifestConfigSchema)(json)).toBeDefined();
    },
  );

  it.each([
    ["bus", { ...busManifestConfig, stationService: { routeType: "bus" as const } }],
    ["subway", { ...subwayManifestConfig, stationService: { routeType: "subway" as const } }],
    ["rail", { ...railManifestConfig, stationService: { routeType: "rail" as const } }],
  ] as const)("decodes manifest stationService with matching mode %s", (routeType, json) => {
    const decoded = Schema.decodeUnknownSync(AgencyManifestConfigSchema)(json);
    expect(normalizeStationServices(decoded.stationService)).toEqual([
      expect.objectContaining({ routeType }),
    ]);
  });

  it("decodes a multi-mode stationService array for rail plus bus panels", () => {
    const decoded = Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
      ...railManifestConfig,
      modes: ["rail", "bus"],
      stationService: [{ routeType: "rail" }, { routeType: "bus" }],
    });
    expect(normalizeStationServices(decoded.stationService)).toEqual([
      expect.objectContaining({ routeType: "rail" }),
      expect.objectContaining({ routeType: "bus" }),
    ]);
  });

  it("rejects a stationService array with duplicate route types", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
        ...railManifestConfig,
        modes: ["rail", "bus"],
        stationService: [{ routeType: "rail" }, { routeType: "rail" }],
      }),
    ).toThrow(/duplicate value "rail"/);
  });

  it("rejects a stationService array when a route type is not declared in modes", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
        ...busManifestConfig,
        stationService: [{ routeType: "bus" }, { routeType: "rail" }],
      }),
    ).toThrow(/requires the rail mode to be declared/);
  });

  it("rejects manifest stationService when routeType is not declared in modes", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
        ...busManifestConfig,
        stationService: { routeType: "subway" },
      }),
    ).toThrow(/requires the subway mode to be declared/);
  });

  it.each([
    ["id", { ...subwayManifestConfig, id: undefined }],
    ["name", { ...subwayManifestConfig, name: undefined }],
    ["locale", { ...subwayManifestConfig, locale: undefined }],
    ["timezone", { ...subwayManifestConfig, timezone: undefined }],
    ["bounds", { ...subwayManifestConfig, bounds: undefined }],
    ["modes", { ...subwayManifestConfig, modes: undefined }],
    ["attribution", { ...subwayManifestConfig, attribution: undefined }],
    ["status", { ...subwayManifestConfig, status: undefined }],
    ["staticTopology", { ...subwayManifestConfig, staticTopology: undefined }],
    ["stationService", { ...subwayManifestConfig, stationService: undefined }],
    ["realtime", { ...subwayManifestConfig, realtime: undefined }],
  ])("rejects manifest.json missing required section %s", (_section, badJson) => {
    expect(() => Schema.decodeUnknownSync(AgencyManifestConfigSchema)(badJson)).toThrow();
  });

  it("rejects manifest.json when realtime.feeds is empty", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
        ...subwayManifestConfig,
        realtime: { feeds: [] },
      }),
    ).toThrow();
  });

  it.each([
    [
      "not-a-url",
      {
        ...subwayManifestConfig,
        attribution: { ...subwayManifestConfig.attribution, url: "not-a-url" },
      },
    ],
    [
      "ftp-url",
      {
        ...subwayManifestConfig,
        attribution: { ...subwayManifestConfig.attribution, url: "ftp://example.com" },
      },
    ],
    [
      "invalid-feed-url",
      {
        ...subwayManifestConfig,
        realtime: {
          feeds: [{ kind: "trip_updates", url: "htp://broken", format: "protobuf" }],
        },
      },
    ],
    [
      "invalid-static-feed-url",
      {
        ...subwayManifestConfig,
        staticTopology: { feeds: [{ url: "invalid-url" }] },
      },
    ],
    [
      "rss-source-without-max-age",
      {
        ...subwayManifestConfig,
        alerts: [{ type: "rss", url: "https://alerts.example.test/rss" }],
      },
    ],
  ])("rejects malformed manifest.json config %s", (_case, badJson) => {
    expect(() => Schema.decodeUnknownSync(AgencyManifestConfigSchema)(badJson)).toThrow();
  });

  it.each([
    {
      label: "nextbus",
      feed: {
        kind: "nextbus" as const,
        url: "https://feeds.example.test/nextbus",
        format: "json" as const,
        accept: "application/octet-stream" as const,
      },
    },
    {
      label: "station departures",
      feed: {
        kind: "station_departures" as const,
        url: "https://feeds.example.test/departures/{stopId}",
        format: "json" as const,
        accept: "application/octet-stream" as const,
      },
    },
  ])("rejects accept on the unsupported $label realtime variant", ({ feed }) => {
    expect(() => Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toThrow();
  });

  it.each([
    {
      label: "JSON",
      source: {
        type: "json" as const,
        url: "https://feeds.example.test/alerts.json",
        parser: "generic-alert-feed" as const,
        accept: "application/octet-stream" as const,
      },
    },
    {
      label: "RSS",
      source: {
        type: "rss" as const,
        url: "https://feeds.example.test/alerts.rss",
        maxAgeMinutes: 60,
        accept: "application/octet-stream" as const,
      },
    },
    {
      label: "web",
      source: {
        type: "web" as const,
        url: "https://feeds.example.test/alerts.html",
        parser: "ghd-news-service-advisories" as const,
        accept: "application/octet-stream" as const,
      },
    },
  ])("rejects accept on the unsupported $label alert variant", ({ source }) => {
    expect(() => Schema.decodeUnknownSync(AlertSourceSchema)(source)).toThrow();
  });

  it.each([
    ["vehicle_positions", "application/octet-stream"],
    ["vehicle_positions", "text/plain"],
    ["vehicle_positions", "*/*"],
    ["trip_updates", "application/octet-stream"],
    ["trip_updates", "text/plain"],
    ["trip_updates", "*/*"],
    ["station_trip_updates", "application/octet-stream"],
    ["station_trip_updates", "text/plain"],
    ["station_trip_updates", "*/*"],
  ] as const)("accepts GTFS-RT %s feeds with the %s compatibility override", (kind, accept) => {
    const feed = {
      kind,
      url: "https://feeds.example.test/gtfs-rt",
      format: "protobuf" as const,
      accept,
    };
    expect(Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toEqual(feed);
  });

  it.each([
    "application/octet-stream",
    "application/protocol-buffer",
    "text/plain",
    "*/*",
  ] as const)("accepts the %s compatibility override on GTFS-RT alert sources", (accept) => {
    const source = {
      type: "gtfs-rt" as const,
      url: "https://feeds.example.test/alerts.pb",
      format: "protobuf" as const,
      accept,
    };
    expect(Schema.decodeUnknownSync(AlertSourceSchema)(source)).toEqual(source);
  });
  it.each(["application/x-protobuf", "application/json", "file/download"])(
    "rejects unsupported explicit GTFS-RT media type %s",
    (accept) => {
      const feed = {
        kind: "vehicle_positions" as const,
        url: "https://feeds.example.test/gtfs-rt",
        format: "protobuf" as const,
        accept,
      };
      const source = {
        type: "gtfs-rt" as const,
        url: "https://feeds.example.test/gtfs-rt-alerts",
        format: "protobuf" as const,
        accept,
      };

      expect(() => Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toThrow();
      expect(() => Schema.decodeUnknownSync(AlertSourceSchema)(source)).toThrow();
    },
  );
  it.each(realtimeFeedsFixture)("decodes feed config $url through the contract", (feed) => {
    expect(Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toEqual(feed);
  });

  it("requires per-stop JSON feeds to declare a stopId URL placeholder", () => {
    const feed = {
      kind: "station_departures" as const,
      url: "https://example.test/next-train/{stopId}",
      format: "json" as const,
      lineIds: ["5", "6"],
    };
    expect(Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toEqual(feed);
    expect(() =>
      Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({
        ...feed,
        url: "https://example.test/next-train",
      }),
    ).toThrow();
  });

  it("accepts a POST stop placeholder and rejects a body on GET", () => {
    const feed = {
      kind: "station_departures",
      format: "json",
      method: "POST",
      url: "https://example.test/estimates",
      bodyTemplate: { stopCode: "{stopId}", date: "{date}" },
      dateTimezone: "America/Toronto",
      responseMapping: {
        routesPath: "routes",
        routeIdField: "id",
        departuresField: "times",
        timeField: "departure",
      },
    };
    expect(Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toEqual(feed);
    expect(() =>
      Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({ ...feed, method: "GET" }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({
        ...feed,
        bodyTemplate: { date: "{date}" },
      }),
    ).toThrow();
  });

  it.each(alertSourcesFixture)("decodes alert source $url through the contract", (source) => {
    expect(Schema.decodeUnknownSync(AlertSourceSchema)(source)).toEqual(source);
  });

  describe("tmix_anyride feeds", () => {
    const tmixFeed = {
      kind: "tmix_anyride" as const,
      url: "https://milton.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api",
      format: "json" as const,
      operatorPrefix: "60",
    };

    it("decodes a declared Tmix feed with its operator prefix", () => {
      expect(Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(tmixFeed)).toEqual(tmixFeed);
    });

    it("rejects a Tmix feed that is not a json wire format", () => {
      expect(() =>
        Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({ ...tmixFeed, format: "protobuf" }),
      ).toThrow(/must be json for tmix_anyride feeds/);
    });

    it("rejects a Tmix feed that omits the multi-tenant operator prefix", () => {
      expect(() =>
        Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({
          ...tmixFeed,
          operatorPrefix: undefined,
        }),
      ).toThrow(/\["operatorPrefix"\]/);
    });

    it.each(["", "   "])("rejects a blank operator prefix %j", (operatorPrefix) => {
      expect(() =>
        Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({ ...tmixFeed, operatorPrefix }),
      ).toThrow(/\["operatorPrefix"\]/);
    });
  });

  describe("AnyRide profile headers and duplicate fixes", () => {
    const tmixFeed = {
      kind: "tmix_anyride" as const,
      url: "https://anyride.example.test/api",
      format: "json" as const,
      operatorPrefix: "70",
    };

    it("decodes a declared profile and the opt-in fix collapse", () => {
      const feed = {
        ...tmixFeed,
        profile: { data: "tenant_data", display: "tenant" },
        duplicateVehicleFixes: "collapse-by-fix" as const,
      };
      expect(Schema.decodeUnknownSync(RealtimeFeedConfigSchema)(feed)).toEqual(feed);
    });

    it.each([
      ["a profile value that is not a header-safe token", { profile: { data: "a b" } }],
      ["a profile value that would break a header line", { profile: { data: "a\r\nX: y" } }],
      ["a profile with no data value", { profile: { display: "tenant" } }],
      ["an unknown collapse mode", { duplicateVehicleFixes: "collapse-by-trip" }],
    ])("rejects %s", (_label, overrides) => {
      expect(() =>
        Schema.decodeUnknownSync(RealtimeFeedConfigSchema)({ ...tmixFeed, ...overrides }),
      ).toThrow();
    });
  });

  describe("anyride-messages alert sources", () => {
    const source = {
      type: "anyride-messages" as const,
      url: "https://anyride.example.test/api",
      operatorPrefix: "70",
      stops: [{ stopId: "S1", routeIds: ["A"] }],
    };

    it("decodes a polled source and a daemon-relayed source", () => {
      expect(Schema.decodeUnknownSync(AlertSourceSchema)(source)).toEqual(source);
      const relayed = {
        type: "anyride-messages" as const,
        url: "https://alerts.example.test/fictional.json",
        relay: "daemon-document" as const,
      };
      expect(Schema.decodeUnknownSync(AlertSourceSchema)(relayed)).toEqual(relayed);
    });

    it.each([
      ["operatorPrefix", { operatorPrefix: undefined }],
      ["stops", { stops: undefined }],
      ["at least one stop", { stops: [] }],
      ["routes on every stop", { stops: [{ stopId: "S1", routeIds: [] }] }],
    ])("rejects a polled source without %s", (_label, overrides) => {
      expect(() =>
        Schema.decodeUnknownSync(AlertSourceSchema)({ ...source, ...overrides }),
      ).toThrow();
    });
  });

  it("decodes alert source with enabled, runtimes, and disabledReason", () => {
    const source = {
      type: "web" as const,
      url: "https://example.test/alerts",
      parser: "ghd-news-service-advisories" as const,
      maxAgeMinutes: 10_080,
      enabled: false,
      runtimes: ["self-hosted"] as const,
      disabledReason: "Blocked on cloudflare",
    };
    expect(Schema.decodeUnknownSync(AlertSourceSchema)(source)).toEqual(source);
  });

  describe("service announcement web source options", () => {
    const source = {
      type: "web" as const,
      url: "https://example.test/announcements",
      parser: "service-announcement-board" as const,
      routeNames: { R7: ["7"] },
    };

    it("accepts declared route aliases", () => {
      expect(Schema.decodeUnknownSync(AlertSourceSchema)(source)).toEqual(source);
    });

    it("rejects route aliases on web parsers that do not consume them", () => {
      expect(() =>
        Schema.decodeUnknownSync(AlertSourceSchema)({
          type: "web",
          url: source.url,
          parser: "ghd-news-service-advisories",
          routeNames: source.routeNames,
        }),
      ).toThrow();
    });
  });

  it("rejects alert source with unrecognized runtime target", () => {
    const source = {
      type: "web",
      url: "https://example.test/alerts",
      parser: "ghd-news-service-advisories",
      runtimes: ["invalid-runtime"],
    };
    expect(() => Schema.decodeUnknownSync(AlertSourceSchema)(source)).toThrow();
  });

  it("decodes manifest routeIdNormalization and equipmentKeywords through the contract", () => {
    const json = {
      ...subwayManifestConfig,
      alertInterpretation: {
        ...subwayManifestConfig.alertInterpretation,
        routeIdNormalization: { stripPrefix: "line", extractPattern: "\\b([12456])\\b" },
        equipmentKeywords: { elevator: ["elevator"], escalator: ["escalator"] },
      },
    };
    const decoded = Schema.decodeUnknownSync(AgencyManifestConfigSchema)(json);
    expect(decoded.alertInterpretation?.routeIdNormalization).toEqual({
      stripPrefix: "line",
      extractPattern: "\\b([12456])\\b",
    });
    expect(decoded.alertInterpretation?.equipmentKeywords).toEqual({
      elevator: ["elevator"],
      escalator: ["escalator"],
    });
  });

  it.each([
    ["empty matcher", { match: {}, result: { kind: "delay", severity: "degraded" } }],
    [
      "sourceValue without sourceField",
      {
        match: { sourceValue: "Reduced Speed Zone" },
        result: { kind: "slow-service", severity: "degraded" },
      },
    ],
  ] as const)("rejects alert interpretation rule with %s", (_case, rule) => {
    expect(() => Schema.decodeUnknownSync(AlertInterpretationRuleSchema)(rule)).toThrow();
  });

  it.each([
    ["invalid regex", "([unclosed"],
    ["no capture group", "\\b[12456]\\b"],
    ["two capture groups", "(\\b[12]\\b)(\\b[45]\\b)"],
  ])("rejects manifest routeIdNormalization with %s", (_case, extractPattern) => {
    const json = {
      ...subwayManifestConfig,
      alertInterpretation: {
        ...subwayManifestConfig.alertInterpretation,
        routeIdNormalization: { extractPattern },
      },
    };
    expect(() => Schema.decodeUnknownSync(AgencyManifestConfigSchema)(json)).toThrow();
  });

  it.each([
    [
      { stationId: "union", stationName: "Union" },
      { stationId: "union", stationName: "Union" },
    ],
    [{ stationName: "Outside schematic coverage" }, { stationName: "Outside schematic coverage" }],
  ] as const)("decodes structured station reference %j", (input, expected) => {
    expect(Schema.decodeUnknownSync(AgencyStationReferenceSchema)(input)).toEqual(expected);
  });

  it.each([
    { stationId: "", stationName: "Union" },
    { stationId: "Union", stationName: "Union" },
    { stationId: "union", stationName: "   " },
  ])("rejects invalid structured station reference %j", (input) => {
    expect(() => Schema.decodeUnknownSync(AgencyStationReferenceSchema)(input)).toThrow();
  });

  it("round-trips an interpreted feed through AgencySnapshotSchema unchanged", () => {
    const now = 1_700_000_000_000;
    const snapshot = interpretSnapshot(
      {
        header: { version: "2.0", timestamp: now - 10_000 },
        tripUpdates: [],
        vehiclePositions: [],
        alerts: [
          {
            id: "alert-1",
            lineId: "1",
            fromStationId: "st-geo",
            toStationId: "union",
            equipmentOutages: [
              {
                id: "eq-1",
                type: "escalator",
                equipment: "Escalator 1",
                location: "Concourse",
                rawText: "Escalator 1 between mezzanine and concourse is out of service",
              },
            ],
            title: "No service between St George and Union",
            startsAt: now - 60_000,
            updatedAt: now,
            effect: "NO_SERVICE",
          },
        ],
      },
      { agencyId: "sample", now, lineIds: ["1", "2", "4", "5", "6"] },
    );

    expect(Schema.decodeUnknownSync(AgencySnapshotSchema)(snapshot)).toEqual(snapshot);
  });

  it("accepts station-span annotations on alerts", () => {
    const now = 1_700_000_000_000;
    const snapshot = {
      agencyId: "sample",
      generatedAt: now,
      freshness: "live",
      alerts: [
        {
          id: "alert-1",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          affectedLineIds: ["1"],
          fromStation: { stationName: "st-geo" },
          toStation: { stationName: "union" },
          scope: "segment",
          title: "No service between St George and Union",
          startsAt: now - 60_000,
          updatedAt: now,
        },
      ],
    } as const;

    expect(Schema.decodeUnknownSync(AgencySnapshotSchema)(snapshot)).toEqual(snapshot);
  });

  it("rejects the removed string-valued AgencyAlert station fields", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencyAlertSchema)({
        id: "alert-1",
        kind: "suspension",
        severity: "severe",
        lifecycle: "active",
        fromStationId: "union",
        affectedStations: ["Union"],
        title: "No service",
        startsAt: 0,
        updatedAt: 0,
      }),
    ).toThrow();
  });

  it("rejects severity outside the core ladder", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencySnapshotSchema)({
        agencyId: "sample",
        generatedAt: 0,
        freshness: "live",
        alerts: [
          {
            id: "bad",
            kind: "delay",
            severity: "catastrophic",
            lifecycle: "active",
            title: "nope",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
      }),
    ).toThrow();
  });

  it.each([
    [
      "reversed geographic bounds",
      {
        ...subwayManifestConfig,
        bounds: [{ minLat: 44, maxLat: 43, minLon: -80, maxLon: -79 }],
      },
    ],
    ["empty mode list", { ...subwayManifestConfig, modes: [] }],
    [
      "non-positive proximity radius",
      { ...subwayManifestConfig, proximity: { radiusMeters: 0, bucketMeters: 75 } },
    ],
    [
      "invalid HTTP URL",
      {
        ...subwayManifestConfig,
        attribution: { ...subwayManifestConfig.attribution, url: "https://" },
      },
    ],
    [
      "nextbus source without a slug",
      {
        ...subwayManifestConfig,
        staticTopology: {
          source: "nextbus",
          feeds: [{ url: "https://example.test/static.zip" }],
          agencySlug: undefined,
        },
      },
    ],
    [
      "route rule without a matcher",
      {
        ...subwayManifestConfig,
        routeInterpretation: {
          routeTypeRules: [{ routeType: "bus" }],
        },
      },
    ],
  ])("rejects semantically invalid manifest config: %s", (_case, value) => {
    expect(() => Schema.decodeUnknownSync(AgencyManifestConfigSchema)(value)).toThrow();
  });

  it("decodes manifest attribution with a French localized variant", () => {
    const decoded = Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
      ...subwayManifestConfig,
      attribution: {
        ...subwayManifestConfig.attribution,
        translations: {
          fr: {
            url: "https://example.test/fr-data",
            license: "Licence Exemple FR",
          },
        },
      },
    });
    expect(decoded.attribution.translations?.fr?.url).toBe("https://example.test/fr-data");
  });

  it("rejects manifest attribution with an invalid French variant URL", () => {
    expect(() =>
      Schema.decodeUnknownSync(AgencyManifestConfigSchema)({
        ...subwayManifestConfig,
        attribution: {
          ...subwayManifestConfig.attribution,
          translations: { fr: { url: "not-a-url" } },
        },
      }),
    ).toThrow();
  });

  it.each([
    ["fr-CA", "https://example.test/fr-data", "Licence Exemple FR"],
    ["fr", "https://example.test/fr-data", "Licence Exemple FR"],
    ["en-CA", "https://example.test/data", "CC0"],
    ["de", "https://example.test/data", "CC0"],
  ])("selects the %s attribution variant with fallback", (locale, url, license) => {
    const resolved = resolveLocalizedAttribution(
      {
        name: "Sample Open Data",
        url: "https://example.test/data",
        license: "CC0",
        translations: {
          fr: { url: "https://example.test/fr-data", license: "Licence Exemple FR" },
        },
      },
      locale,
    );
    expect(resolved.url).toBe(url);
    expect(resolved.license).toBe(license);
  });

  it("falls back to the default attribution when no French variant exists", () => {
    const resolved = resolveLocalizedAttribution(
      { name: "Sample Open Data", url: "https://example.test/data", license: "CC0" },
      "fr-CA",
    );
    expect(resolved.url).toBe("https://example.test/data");
    expect(resolved.license).toBe("CC0");
  });

  it("matches a regional attribution key for a rider in that region", () => {
    const resolved = resolveLocalizedAttribution(
      {
        name: "Sample Open Data",
        url: "https://example.test/data",
        license: "CC0",
        translations: {
          "fr-CA": { url: "https://example.test/fr-ca-data", license: "Licence Exemple CA" },
        },
      },
      "fr-CA",
    );
    expect(resolved.url).toBe("https://example.test/fr-ca-data");
  });

  it("resolves a variant for any locale key without resolver changes", () => {
    const resolved = resolveLocalizedAttribution(
      {
        name: "Sample Open Data",
        url: "https://example.test/data",
        license: "CC0",
        translations: {
          es: { url: "https://example.test/es-data", license: "Licencia Ejemplo ES" },
        },
      },
      "es-MX",
    );
    expect(resolved.url).toBe("https://example.test/es-data");
    expect(resolved.license).toBe("Licencia Ejemplo ES");
  });
});

describe("agency contract schemas", () => {
  it("decodes declarative sequences and corner insertions on schematics", () => {
    const schematic = {
      viewBoxWidth: 100,
      viewBoxHeight: 100,
      lines: [{ id: "1", name: "Line 1", color: "#000000", points: [{ x: 0, y: 0 }] }],
      stations: [
        { id: "st-george", name: "St George", x: 1, y: 1, lines: ["1"] },
        { id: "union", name: "Union", x: 5, y: 5, lines: ["1"] },
      ],
      sequences: { "1": ["st-george", "union"] },
      cornerInsertions: [
        { lineId: "1", stationId: "union", before: { x: 4, y: 6 }, after: { x: 6, y: 6 } },
      ],
      viewport: {
        bounds: { minX: 0, maxX: 100, minY: 0, maxY: 100 },
        minZoom: 0.5,
        maxZoom: 4,
      },
      geoProjection: {
        refLonWest: -80,
        refLonEast: -79,
        refXWest: 0,
        refXEast: 100,
        refLatNorth: 44,
        refLatSouth: 43,
        refYNorth: 0,
        refYSouth: 100,
      },
    };

    expect(Schema.decodeUnknownSync(SchematicSchema)(schematic)).toEqual(schematic);
  });

  it.each([
    [
      "uppercase schematic station id",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        stations: [{ ...schematic.stations[0]!, id: "Alpha" }, ...schematic.stations.slice(1)],
      }),
    ],
    [
      "duplicate schematic station id",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        stations: [
          ...schematic.stations,
          { ...schematic.stations[1]!, name: "Also Beta", x: 50, id: "alpha" },
        ],
      }),
    ],
    [
      "duplicate sequence station id",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        sequences: { L1: ["alpha", "alpha"] },
      }),
    ],
    [
      "non-positive viewBox",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({ ...schematic, viewBoxWidth: 0 }),
    ],
    [
      "viewport outside viewBox",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        viewport: { ...schematic.viewport, bounds: { ...schematic.viewport.bounds, minX: -1 } },
      }),
    ],
    [
      "reversed zoom range",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        viewport: { ...schematic.viewport, minZoom: 4, maxZoom: 1 },
      }),
    ],
    [
      "undeclared station line",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        stations: [
          { ...schematic.stations[0]!, lines: ["missing"] },
          ...schematic.stations.slice(1),
        ],
      }),
    ],
    [
      "undeclared sequence station",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        sequences: { L1: ["missing"] },
      }),
    ],
    [
      "unknown corner station id",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        cornerInsertions: [
          { lineId: "L1", stationId: "missing", before: { x: 1, y: 1 }, after: { x: 2, y: 2 } },
        ],
      }),
    ],
    [
      "unknown station index schematic id",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        stationIndex: [
          {
            id: "feed-alpha",
            schematicId: "missing",
            name: "Alpha",
            lat: 43,
            lon: -79,
            lines: ["L1"],
            platformIds: [],
          },
        ],
      }),
    ],
    [
      "ambiguous station alias",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        stations: [
          { ...schematic.stations[0]!, name: "Twin" },
          { ...schematic.stations[1]!, name: "Twin" },
        ],
        stationAliases: { twin: "alpha" },
      }),
    ],
    [
      "degenerate geographic projection",
      (schematic: ReturnType<typeof makeMinimalSchematic>) => ({
        ...schematic,
        geoProjection: { ...schematic.geoProjection, refLonWest: -79 },
      }),
    ],
  ])("rejects semantically invalid schematic data: %s", (_case, makeCandidate) => {
    expect(() =>
      Schema.decodeUnknownSync(SchematicSchema)(makeCandidate(makeMinimalSchematic())),
    ).toThrow();
  });
});
