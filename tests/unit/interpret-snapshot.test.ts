import { Schema } from "effect";
import { AgencySnapshotSchema } from "~/agencies/types";
import { makeStationSchematic, makeTestProvider } from "../helpers/agency-fixtures";
import { describe, expect, it } from "vitest";
import { deriveLineStatuses, interpretSnapshot } from "~/domain/interpretSnapshot";
import { toServiceAlerts, toUpcomingClosures } from "~/domain/serviceAlerts";
import { buildMapModel, deriveMapProjection } from "~/core/map";
import type { DecodedFeed, GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
import type { AgencyAlert, AgencyManifest, Schematic } from "~/agencies/types";

const NOW = 1_800_000_000_000;

function feed(alerts: DecodedFeed["alerts"], timestamp = NOW): DecodedFeed {
  return {
    header: { version: "2.0", timestamp },
    tripUpdates: [],
    vehiclePositions: [],
    alerts,
  };
}

const railSchematic = makeStationSchematic(["North", "Campus", "South"], "R1");
const railManifest = makeTestProvider({
  alertInterpretation: {
    lineIds: ["R1"],
    rules: [
      {
        priority: 200,
        match: {
          textIncludes: ["pedestrian bridge", "station access", "access route", "stairway"],
        },
        result: { kind: "accessibility", severity: "normal" },
      },
    ],
  },
}).manifest;
const defaultManifest = makeTestProvider().manifest;
const frenchAlertManifest = makeTestProvider({
  alertInterpretation: {
    rules: [
      {
        priority: 400,
        match: {
          textIncludes: ["aucun service", "service interrompu", "voyage annulé"],
        },
        result: { kind: "suspension", severity: "severe" },
      },
      {
        priority: 100,
        match: { titleIncludes: ["déviation"] },
        result: { kind: "information", severity: "normal", serviceChange: "detour" },
      },
    ],
  },
}).manifest;
const busManifest = makeTestProvider({
  modes: ["bus"],
  stationService: { routeType: "bus" },
}).manifest;
const metroSchematic = {
  ...makeStationSchematic(["North", "Middle", "South", "Hub", "Campus"], "5"),
  stationAliases: { "old-campus": "campus" },
};

function interpretFixtureAlert(
  alerts: DecodedFeed["alerts"],
  now = NOW,
): ReturnType<typeof interpretSnapshot> {
  return interpretSnapshot(feed(alerts, now), {
    agencyId: "regional",
    now,
    manifest: railManifest as unknown as AgencyManifest,
    stationIndex: railSchematic.stationIndex,
    schematic: railSchematic,
  });
}

describe("structured effect outranks prose", () => {
  it("drops blank affected station references", () => {
    const snapshot = interpretFixtureAlert([
      {
        id: "blank-stop",
        title: "Service suspended",
        startsAt: NOW,
        updatedAt: NOW,
        effect: "NO_SERVICE",
        description: "Service suspended",
        routeIds: ["R1"],
        affectedStations: ["", "  ", "feed-campus"],
      },
    ]);
    expect(snapshot.alerts[0]?.affectedStations).toEqual([
      { stationId: "campus", stationName: "Campus" },
    ]);
  });
  it.each([
    "No service until the obstruction is cleared",
    "Service suspended while floodwater is cleared",
    "No service until restrictions are lifted",
    "Service suspended until roadwork has ended",
  ])("keeps an unstructured active suspension severe: %s", (description) => {
    const snapshot = interpretSnapshot(
      feed([{ id: "active", description, routeIds: ["301"] } as never]),
      { agencyId: "sample", now: NOW, manifest: defaultManifest as unknown as AgencyManifest },
    );
    expect(snapshot.alerts[0]?.severity).toBe("severe");
    expect(snapshot.alerts[0]?.kind).toBe("suspension");
  });
  it.each([
    ["has cleared", "The incident has cleared."],
    ["lifted", "Two-car requirement lifted."],
    ["snow has cleared", "Snow has cleared; buses still delayed 20 min."],
    ["stop has reopened", "Bus stop has reopened."],
    ["service has resumed", "Bus service has resumed."],
  ])("keeps a structured NO_SERVICE severe despite %s", (_term, description) => {
    // A resolution rule matches prose anywhere in the alert, and its terms are
    // not specific to a resolution: "lifted" is also "speed restriction lifted"
    // and "cleared" is also "snow has cleared", both describing an ongoing
    // severe disruption. Applying that tier before the structured effect hid a
    // live no-service alert behind a word in its own description.
    const snapshot = interpretFixtureAlert([
      { id: "a1", effect: "NO_SERVICE", description, routeIds: ["R1"] } as never,
    ]);

    expect(snapshot.alerts[0]?.kind).toBe("suspension");
    expect(snapshot.alerts[0]?.severity).toBe("severe");
  });

  it("still lets a baseline rule elevate above a bland structured effect", () => {
    // The fix gates the clearing direction only. A feed publishing a bland
    // effect while its text announces an emergency is understating itself, and
    // the text is worth trusting there.
    const snapshot = interpretFixtureAlert([
      {
        id: "a1",
        effect: "DETOUR",
        description: "Emergency detour in effect.",
        routeIds: ["R1"],
      } as never,
    ]);

    expect(snapshot.alerts[0]?.severity).toBe("degraded");
  });

  it("keeps an unstructured alert that states nothing severe at normal severity", () => {
    // This input supplies prose only, with no structured effect to weigh.
    // Severity for such an alert is the fallback, so this pins that the
    // fallback is normal rather than degraded. It cannot also prove the
    // resolution rule fired, because that rule resolves to the same severity;
    // the baseline phrase table owns that fact.
    const snapshot = interpretFixtureAlert([
      { id: "a1", description: "Regular service has resumed.", routeIds: ["R1"] } as never,
    ]);

    expect(snapshot.alerts[0]?.severity).toBe("normal");
  });

  it("still derives a severe suspension from unstructured prose", () => {
    const snapshot = interpretFixtureAlert([
      { id: "a1", description: "There will be no service tonight.", routeIds: ["R1"] } as never,
    ]);

    expect(snapshot.alerts[0]?.kind).toBe("suspension");
    expect(snapshot.alerts[0]?.severity).toBe("severe");
  });
});

describe("French operator wording", () => {
  it.each(["Déviation d’urgence", "Déviation d'urgence"])(
    "keeps an emergency headline degraded ahead of standing-detour information: %s",
    (title) => {
      const manifest = makeTestProvider({
        alertInterpretation: {
          rules: [
            {
              priority: 360,
              match: { titleIncludes: ["déviation d’urgence", "déviation d'urgence"] },
              result: { kind: "delay", severity: "degraded", serviceChange: "detour" },
            },
            {
              priority: 350,
              match: { titleIncludes: ["déviation"] },
              result: { kind: "information", severity: "normal", serviceChange: "detour" },
            },
          ],
        },
      }).manifest;
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "emergency",
            title: `${title} sur le circuit 20`,
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
        ]),
        { agencyId: "sample", now: NOW, manifest },
      );
      expect(snapshot.alerts[0]).toMatchObject({
        kind: "delay",
        severity: "degraded",
        serviceChange: "detour",
      });
    },
  );

  it("uses shared French vocabulary without an agency-specific rules table", () => {
    const suspension = interpretSnapshot(
      feed([
        {
          id: "baseline-french-suspension",
          title: "Aucun service entre North et South",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, schematic: metroSchematic as unknown as Schematic },
    );
    const detour = interpretSnapshot(
      feed([
        {
          id: "baseline-french-detour",
          title: "Déviation : Circuits 20 et 21",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW },
    );

    expect(suspension.alerts[0]).toMatchObject({ kind: "suspension", severity: "severe" });
    expect(detour.alerts[0]).toMatchObject({
      kind: "information",
      severity: "normal",
      serviceChange: "detour",
    });
  });

  it.each([
    "Circuit 42 suspendu près de la station Centrale",
    "Ligne 1 suspendue entre North et South",
    "Circuits 20 et 21 suspendus",
  ])("classifies a French suspended-service headline as severe like English: %s", (title) => {
    const snapshot = interpretSnapshot(
      feed([{ id: "french-suspended", title, startsAt: NOW - 1_000, updatedAt: NOW }]),
      { agencyId: "sample", now: NOW },
    );

    expect(snapshot.alerts[0]).toMatchObject({ kind: "suspension", severity: "severe" });
  });

  it("classifies explicit French service suspensions and resolves entre/et spans", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "french-suspension",
          title: "Aucun service entre North et South",
          description: "Service interrompu pendant les travaux.",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        manifest: frenchAlertManifest as unknown as AgencyManifest,
        schematic: metroSchematic as unknown as Schematic,
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "suspension",
      severity: "severe",
      fromStation: { stationId: "north", stationName: "North" },
      toStation: { stationId: "south", stationName: "South" },
    });
  });

  it("keeps a source-configured French detour informational and marked as a detour", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "french-detour",
          title: "Déviation : Circuits 20 et 21",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, manifest: frenchAlertManifest as unknown as AgencyManifest },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "information",
      severity: "normal",
      serviceChange: "detour",
    });
  });

  it("does not make the broad word perturbation a global severe rule", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "broad-perturbation",
          title: "Perturbation majeure du service",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, manifest: defaultManifest as unknown as AgencyManifest },
    );

    expect(snapshot.alerts[0]).toMatchObject({ kind: "information", severity: "normal" });
  });

  it("lets an OC-style headline override keep a historical suspension phrase informational", () => {
    const ocStyleManifest = makeTestProvider({
      alertInterpretation: {
        rules: [
          {
            priority: 400,
            match: { titleIncludes: ["aucun service", "service suspendu"] },
            result: { kind: "suspension", severity: "severe" },
          },
          {
            priority: 350,
            match: { titleIncludes: ["déviation"] },
            result: { kind: "information", severity: "normal", serviceChange: "detour" },
          },
        ],
      },
    }).manifest;
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "historical-french-suspension",
          title: "Déviation : Circuit 20",
          description: "Hier, aucun service était offert pendant les travaux; le circuit a repris.",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, manifest: ocStyleManifest as unknown as AgencyManifest },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "information",
      severity: "normal",
      serviceChange: "detour",
    });
  });
});

describe("interpretSnapshot (Core alert interpretation)", () => {
  it("does not infer line identity from bus route ids when the agency declares no lines", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "kingston-2",
          title: "Princess Street closed",
          startsAt: NOW,
          updatedAt: NOW,
          routeIds: ["2"],
        },
      ]),
      {
        agencyId: "local",
        now: NOW,
        manifest: busManifest as unknown as AgencyManifest,
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      affectedRouteIds: ["2"],
    });
    expect(snapshot.alerts[0].affectedLineIds).toBeUndefined();
  });

  it.each([
    ["NO_SERVICE", "suspension", "severe"],
    ["REDUCED_SERVICE", "slow-service", "degraded"],
    ["SIGNIFICANT_DELAYS", "delay", "degraded"],
    ["DETOUR", "information", "normal"],
  ] as const)("prioritizes GTFS-RT effect %s", (effect, kind, severity) => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "a1",
          title: "Routine information",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          effect,
          routeIds: ["blue"],
        },
      ]),
      { agencyId: "metro", now: NOW, lineIds: ["blue"] },
    );

    expect(snapshot.alerts[0]).toMatchObject({ kind, severity, affectedLineIds: ["blue"] });
  });

  it("carries structured detour semantics to downstream presentation as informational service change", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "structured-detour",
          title: "Route change",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          effect: "DETOUR",
        },
      ]),
      { agencyId: "metro", now: NOW },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "information",
      severity: "normal",
      serviceChange: "detour",
    });
  });

  it.each([
    ["emergency detour ended on Route 58", "information", "normal"],
    ["regular service resumed on all lines", "information", "normal"],
    ["stops have reopened following construction", "information", "normal"],
    ["emergency detour around police investigation", "delay", "degraded"],
    ["no service between station A and B", "suspension", "severe"],
    ["service suspended due to weather", "suspension", "severe"],
    ["detour via alternate street", "information", "normal"],
  ] as const)(
    "classifies standard English alert phrase '%s' via baseline rules",
    (title, expectedKind, expectedSeverity) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "baseline-test",
            title,
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            routeIds: ["blue"],
          },
        ]),
        { agencyId: "metro", now: NOW, lineIds: ["blue"] },
      );

      expect(snapshot.alerts[0]).toMatchObject({
        kind: expectedKind,
        severity: expectedSeverity,
      });
    },
  );

  it("leaves unstructured operator prose informational and preserves lifecycle", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "fr-1",
          title: "Détour prévu ce week-end",
          description: "Travaux sur la ligne",
          startsAt: NOW - 60_000,
          endsAt: NOW + 120_000,
          updatedAt: NOW,
          routeIds: ["Viva Blue"],
        },
      ]),
      {
        agencyId: "metro",
        now: NOW,
        lineIds: ["blue"],
        routeLineMap: { "Viva Blue": "blue" },
      },
    );

    expect(snapshot).toMatchObject({ agencyId: "metro", freshness: "live" });
    expect(snapshot.alerts[0]).toMatchObject({
      kind: "information",
      severity: "normal",
      lifecycle: "active",
      affectedRouteIds: ["Viva Blue"],
      affectedLineIds: ["blue"],
    });
  });

  // A suffixed family drawn as one line needs EVERY branch in the map. An unmapped
  // sibling is not a declared line id either, so it attributes to nothing and fails
  // silently: the half-written map looks healthy while that route's alerts go
  // unattributed and the line keeps showing normal.
  it.each([
    ["12A", "12"],
    ["12B", "12"],
    ["12C", undefined],
  ] as const)(
    "folds suffixed route %s onto its parent line, or attributes nothing when unmapped",
    (routeId, lineId) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: `family-${routeId}`,
            title: "Route change",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "DETOUR",
            routeIds: [routeId],
          },
        ]),
        {
          agencyId: "test",
          now: NOW,
          lineIds: ["12"],
          routeLineMap: { "12A": "12", "12B": "12" },
        },
      );

      expect(snapshot.alerts[0]?.affectedRouteIds).toEqual([routeId]);
      expect(snapshot.alerts[0]?.affectedLineIds).toEqual(lineId ? [lineId] : undefined);
    },
  );

  it("uses the highest-priority matching manifest rule without agency code", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "priority-rule",
          title: "Service interruption at the terminal",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          routeIds: ["blue"],
        },
      ]),
      {
        agencyId: "metro",
        now: NOW,
        lineIds: ["blue"],
        rules: [
          {
            priority: 10,
            match: { textIncludes: ["service interruption"] },
            result: { kind: "delay", severity: "degraded" },
          },
          {
            priority: 20,
            match: { textIncludes: ["service interruption"] },
            result: { kind: "suspension", severity: "severe" },
          },
        ],
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({ kind: "suspension", severity: "severe" });
  });

  it.each([
    {
      title: "Platform relocation",
      description: "No service last month; alternate stops now serve all trips.",
      category: "Detours",
      severity: "normal",
    },
    {
      title: "Route 42 service suspended",
      description: "No trains between Campus and West.",
      category: "General Message",
      severity: "severe",
    },
    {
      title: "Emergency detour: Route 42",
      description: "No service between Campus and West.",
      category: "Detours",
      severity: "severe",
    },
    {
      title: "Emergency detour: Route 42",
      description: "Buses use parallel streets.",
      category: "Detours",
      severity: "degraded",
    },
  ])(
    "limits operational rules to current headline semantics: $title / $severity",
    ({ title, description, category, severity }) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "notice",
            title,
            description,
            routeIds: ["42"],
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            sourceFields: { rssCategory: category },
          },
        ]),
        {
          agencyId: "sample",
          now: NOW,
          lineIds: ["42"],
          rules: [
            {
              priority: 375,
              match: { titleIncludes: ["emergency detour"], textIncludes: ["no service"] },
              result: { kind: "suspension", severity: "severe" },
            },
            {
              priority: 375,
              match: { titleIncludes: ["service suspended"] },
              result: { kind: "suspension", severity: "severe" },
            },
            {
              priority: 350,
              match: { titleIncludes: ["emergency detour"] },
              result: { kind: "delay", severity: "degraded" },
            },
            {
              priority: 200,
              match: { sourceField: "rssCategory", sourceValue: "Detours" },
              result: { kind: "information", severity: "normal" },
            },
          ],
        },
      );
      expect(snapshot.alerts[0]!.severity).toBe(severity);
      expect(deriveLineStatuses(snapshot.alerts, ["42"])["42"]!.severity).toBe(severity);
    },
  );

  it("matches source-field values without coercing their types", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "boolean-source",
          title: "Boolean source",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          sourceFields: { enabled: true },
        },
        {
          id: "string-source",
          title: "String source",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          sourceFields: { enabled: "true" },
        },
      ]),
      {
        agencyId: "metro",
        now: NOW,
        rules: [
          {
            match: { sourceField: "enabled", sourceValue: true },
            result: { kind: "delay", severity: "degraded" },
          },
        ],
      },
    );

    expect(snapshot.alerts).toMatchObject([
      { id: "boolean-source", kind: "delay", severity: "degraded" },
      { id: "string-source", kind: "information", severity: "normal" },
    ]);
  });

  it.each([
    [NOW - 59_000, "live"],
    [NOW - 60_000, "live"],
    [NOW - 180_000, "live"],
    [0, "unavailable"],
  ] as const)(
    "uses successful receipt freshness despite feed header age",
    (timestamp, freshness) => {
      const snapshot = interpretSnapshot(feed([], timestamp), { agencyId: "regional", now: NOW });
      expect(snapshot.freshness).toBe(freshness);
      expect(snapshot.sourceUpdatedAt).toBe(timestamp);
    },
  );

  it("marks a partially failed feed set stale even when one source was received", () => {
    const snapshot = interpretSnapshot(feed([], NOW - 180_000), {
      agencyId: "regional",
      now: NOW,
      feedIsStale: true,
    });

    expect(snapshot.freshness).toBe("stale");
  });

  describe("manifest-driven route interpretation", () => {
    it("canonicalizes versioned route IDs in both alert scope and stop targets", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "versioned",
            title: "Stop closure",
            startsAt: NOW - 1000,
            updatedAt: NOW,
            routeIds: ["version-7", "unknown"],
            targets: [{ routeId: "version-7", stopId: "platform" }],
          },
        ]),
        {
          agencyId: "sample",
          now: NOW,
          manifest: {
            alertInterpretation: {
              lineIds: ["R"],
              routeIdNormalization: { aliases: { "version-7": "R" } },
            },
          },
        },
      );
      expect(snapshot.alerts[0]).toMatchObject({
        affectedRouteIds: ["R", "unknown"],
        affectedLineIds: ["R"],
        targets: [{ routeId: "R", station: { stationName: "platform" } }],
      });
    });
    const ttcNormalization = {
      stripPrefix: "line",
      extractPattern: "\\b([12456])\\b",
    } as const;
    const ruleManifest = {
      alertInterpretation: {
        lineIds: ["1", "2", "4", "5", "6"],
        rules: [
          {
            priority: 100,
            match: { textIncludes: ["reduced speed zone", "slower than usual"] },
            result: { kind: "slow-service", severity: "degraded" },
          },
        ],
        routeIdNormalization: { ...ttcNormalization },
      },
    } as const;

    it("normalizes raw decoder route ids through the manifest rule", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-1",
            title: "Delay on Line 1",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "SIGNIFICANT_DELAYS",
            routeIds: ["Line 1", "97"],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest },
      );

      expect(snapshot.alerts[0]).toMatchObject({
        affectedRouteIds: ["1", "97"],
        affectedLineIds: ["1"],
      });
    });

    it("passes route ids through untouched without a normalization rule", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-2",
            title: "Delay on Line 1",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "SIGNIFICANT_DELAYS",
            routeIds: ["Line 1", "97"],
          },
        ]),
        { agencyId: "sample", now: NOW },
      );

      expect(snapshot.alerts[0]).toMatchObject({ affectedRouteIds: ["Line 1", "97"] });
    });

    it("preserves route-stop target pairs while normalizing their route ids", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "target-pairs",
            title: "Station disruption",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "NO_SERVICE",
            routeIds: ["Line 1", "97"],
            targets: [{ routeId: "Line 1", stopId: "opaque-stop-a" }, { routeId: "97" }],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest },
      );

      expect(snapshot.alerts[0]).toMatchObject({
        affectedRouteIds: ["1", "97"],
        affectedLineIds: ["1"],
        targets: [{ routeId: "1", station: { stationName: "opaque-stop-a" } }, { routeId: "97" }],
        scope: "station",
      });
      expect(deriveLineStatuses(snapshot.alerts, ["1"])["1"]?.severity).toBe("degraded");
    });

    it("prefers a per-call normalization override over the manifest rule", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-3",
            title: "Delay on Line 1",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "SIGNIFICANT_DELAYS",
            routeIds: ["Line 1"],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest, routeIdNormalization: {} },
      );

      expect(snapshot.alerts[0]).toMatchObject({ affectedRouteIds: ["Line 1"] });
    });

    it("infers line and span fallbacks from normalized routes and stops", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-4",
            title: "No service",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "NO_SERVICE",
            routeIds: ["Line 5"],
            affectedStations: ["station-a", "station-b"],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest },
      );

      expect(snapshot.alerts[0]).toMatchObject({
        affectedRouteIds: ["5"],
        affectedLineIds: ["5"],
        fromStation: { stationName: "station-a" },
        toStation: { stationName: "station-b" },
      });
    });

    it("does not infer a continuous line span when more than two stops are affected", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "multi-stop",
            title: "Construction",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            routeIds: ["Line 5"],
            affectedStations: ["stop-1", "stop-2", "stop-3"],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest },
      );

      expect(snapshot.alerts[0].fromStation).toBeUndefined();
      expect(snapshot.alerts[0].toStation).toBeUndefined();
    });

    it("classifies detour advisories as delay even when mentioning road closures or cancelled stops", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "detour-alert",
            title: "Transit Alert",
            description:
              "Princess Street closed between Division and Concession. Route 4 to detour via Brock. No service to stops A and B.",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            routeIds: ["4"],
          },
        ]),
        {
          agencyId: "local",
          now: NOW,
          lineIds: ["4"],
          rules: [
            {
              priority: 100,
              match: { textIncludes: ["detour"] },
              result: { kind: "delay", severity: "degraded", serviceChange: "detour" },
            },
          ],
        },
      );

      expect(snapshot.alerts[0].kind).toBe("delay");
      expect(snapshot.alerts[0].severity).toBe("degraded");
    });

    it("classifies an alert as degraded when only a subset of platforms at a station are closed", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "bay-closure",
            title: "Transit Alert",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "NO_SERVICE",
            routeIds: ["2"],
            affectedStations: ["bay-1"],
          },
        ]),
        {
          agencyId: "local",
          now: NOW,
          lineIds: ["2"],
          stationIndex: [
            {
              id: "bus-terminal",
              schematicId: "bus-terminal",
              name: "Bus Terminal",
              lat: 44.25,
              lon: -76.5,
              lines: ["2"],
              platformIds: ["bay-1", "bay-2"],
            },
          ],
        },
      );

      expect(snapshot.alerts[0].kind).toBe("delay");
      expect(snapshot.alerts[0].severity).toBe("degraded");
    });

    it("keeps explicit feed line and span values over inference", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-5",
            title: "No service",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "NO_SERVICE",
            lineId: "2",
            routeIds: ["Line 5"],
            fromStationId: "station-x",
            affectedStations: ["station-a", "station-b"],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest },
      );

      expect(snapshot.alerts[0]).toMatchObject({
        affectedLineIds: expect.arrayContaining(["2"]),
        fromStation: { stationName: "station-x" },
      });
    });

    it("derives equipment outages from alert text with default keywords", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-6",
            title: "Elevator outage at Union",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            routeIds: ["1"],
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: ruleManifest },
      );

      expect(snapshot.alerts[0]?.equipmentOutages).toEqual([
        expect.objectContaining({ id: "raw-6", type: "elevator" }),
      ]);
    });

    it("recognizes French elevator and escalator wording in operator alerts", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "french-elevator",
            title: "Ascenseur: Station Blair et navette",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
          {
            id: "french-escalator",
            title: "Escalier mécanique hors service",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: defaultManifest as unknown as AgencyManifest },
      );

      expect(snapshot.alerts.map((alert) => alert.equipmentOutages?.[0]?.type)).toEqual([
        "elevator",
        "escalator",
      ]);
    });

    it("does not classify ordinary French stairs as an escalator outage", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "ordinary-stairs",
            title: "Escalier fermé",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: defaultManifest as unknown as AgencyManifest },
      );

      expect(snapshot.alerts[0]?.equipmentOutages).toBeUndefined();
    });

    it("preserves accented equipment identifiers and does not consume descriptive words", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "french-escalator-id",
            title: "Escalier mécanique É2 fermé",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
          {
            id: "french-escalator-descriptive",
            title: "Escalier mécanique hors service à la station",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: defaultManifest as unknown as AgencyManifest },
      );

      expect(snapshot.alerts[0]?.equipmentOutages?.[0]).toMatchObject({
        type: "escalator",
        equipment: "Escalier mécanique É2",
        rawText: "Escalier mécanique É2 fermé ",
      });
      expect(snapshot.alerts[1]?.equipmentOutages?.[0]).toMatchObject({
        type: "escalator",
        equipment: "Escalier mécanique",
        rawText: "Escalier mécanique hors service à la station ",
      });
    });

    it.each([
      ["Escalator B2 out of service at Union", "Escalator B2", "escalator"],
      ["Elevator out of service at Union", "Elevator", "elevator"],
      ["Escalator unavailable at Union", "Escalator", "escalator"],
    ])("extracts the equipment name from %s without its status", (title, equipment, type) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "english-escalator",
            title,
            startsAt: NOW - 1_000,
            updatedAt: NOW,
          },
        ]),
        { agencyId: "sample", now: NOW, manifest: defaultManifest as unknown as AgencyManifest },
      );

      expect(snapshot.alerts[0]?.equipmentOutages?.[0]).toMatchObject({
        type,
        equipment,
        rawText: `${title} `,
      });
    });

    it("derives equipment outages from manifest equipment keywords", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-7",
            title: "Lift outage at Union",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            routeIds: ["R1"],
          },
        ]),
        {
          agencyId: "regional",
          now: NOW,
          manifest: {
            alertInterpretation: { equipmentKeywords: { lift: ["lift"] } },
          },
        },
      );

      expect(snapshot.alerts[0]?.equipmentOutages).toEqual([
        expect.objectContaining({ id: "raw-7", type: "other", equipment: "Lift outage" }),
      ]);
    });

    it("derives no outage when manifest keywords do not match", () => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "raw-8",
            title: "Elevator outage at Union",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            routeIds: ["R1"],
          },
        ]),
        {
          agencyId: "regional",
          now: NOW,
          manifest: {
            alertInterpretation: { equipmentKeywords: { lift: ["lift"] } },
          },
        },
      );

      expect(snapshot.alerts[0]?.equipmentOutages).toBeUndefined();
    });
  });

  it("derives ranked line status while leaving systemwide alerts unattributed", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "line-1",
          title: "Delay",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          effect: "SIGNIFICANT_DELAYS",
          routeIds: ["1"],
        },
        {
          id: "systemwide",
          title: "Information",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["1", "2"] },
    );

    const statuses = deriveLineStatuses(snapshot.alerts, ["1", "2"]);
    expect(statuses["1"]).toMatchObject({ lineId: "1", severity: "degraded" });
    expect(statuses["2"]).toMatchObject({ lineId: "2", severity: "normal", alerts: [] });
  });

  it("canonicalizes GTFS station ids before downstream station filtering and map projection", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "union-closure",
          title: "No service at Union",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          routeIds: ["1"],
          fromStationId: "feed-hub",
          affectedStations: ["feed-hub"],
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        manifest: { alertInterpretation: { lineIds: ["1"] } },
        stationIndex: metroSchematic.stationIndex,
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      fromStation: { stationId: "hub", stationName: "Hub" },
      affectedStations: [{ stationId: "hub", stationName: "Hub" }],
    });
  });

  it("resolves aliases to schematic identity while preserving unknown names without guessing", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "alias-and-unknown",
          title: "No service",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          fromStationId: "old-campus",
          toStationId: "Future Station",
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        schematic: metroSchematic as unknown as Schematic,
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      fromStation: { stationId: "campus", stationName: "Campus" },
      toStation: { stationName: "Future Station" },
    });
  });

  it.each([
    { from: "North Campus", to: "South", fromId: "north-campus", toId: "south" },
    { from: "South", to: "Campus North", fromId: "south", toId: "campus-north" },
  ])("preserves complete station names in $from to $to spans", ({ from, to, fromId, toId }) => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "overlapping-names",
          title: `No service between ${from} and ${to} stations`,
          startsAt: NOW,
          updatedAt: NOW,
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        schematic: makeStationSchematic(["Campus", "North Campus", "Campus North", "South"]),
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      fromStation: { stationId: fromId, stationName: from },
      toStation: { stationId: toId, stationName: to },
    });
  });

  it("retains bounded and ambiguous station spans across a batch of alerts", () => {
    const schematic = makeStationSchematic(["Campus", "South", "Central East", "Central West"]);
    const snapshot = interpretSnapshot(
      feed(
        [
          "No service between Old Campus and South",
          "Delay between Central and South",
          "Closure between Unlisted and South",
        ].map((title, index) => ({ id: `span-${index}`, title, startsAt: NOW, updatedAt: NOW })),
      ),
      {
        agencyId: "sample",
        now: NOW,
        schematic: {
          ...schematic,
          stationAliases: { "Old Campus": "campus" },
          stations: schematic.stations.map((station) => ({
            ...station,
            name: station.name.startsWith("Central") ? "Central" : station.name,
          })),
        },
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      fromStation: { stationId: "campus", stationName: "Campus" },
      toStation: { stationId: "south", stationName: "South" },
    });
    expect(snapshot.alerts[1]).toMatchObject({
      fromStation: { stationName: "Central" },
      toStation: { stationId: "south", stationName: "South" },
    });
    expect(snapshot.alerts[1]?.fromStation?.stationId).toBeUndefined();
    expect(snapshot.alerts[2]?.fromStation).toBeUndefined();
    expect(snapshot.alerts[2]?.toStation).toBeUndefined();
  });

  it("does not infer a subway line from digits embedded in a surface route id", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "streetcar-506",
          title: "506 detour",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          routeIds: ["506"],
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["1", "2", "4", "5", "6"] },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      affectedRouteIds: ["506"],
      affectedLineIds: undefined,
    });
  });

  it("keeps future structured disruptions in the upcoming category and out of live line status", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "future-closure",
          title: "Planned closure between Union and St Andrew",
          startsAt: NOW + 60_000,
          updatedAt: NOW,
          effect: "NO_SERVICE",
          routeIds: ["1"],
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        lineIds: ["1"],
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "upcoming",
      severity: "normal",
      lifecycle: "upcoming",
    });
    expect(deriveLineStatuses(snapshot.alerts, ["1"])["1"]?.severity).toBe("normal");
  });

  it.each([
    ["There will be no train service tonight", "REDUCED_SERVICE", "upcoming", "normal"],
    ["There will be no train service tonight", "NO_SERVICE", "suspension", "severe"],
    ["Trains are running at reduced speed", "REDUCED_SERVICE", "slow-service", "degraded"],
  ] as const)(
    "applies an advance-notice rule only to its declared wording and effect: %s / %s",
    (title, effect, kind, severity) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: "closure-notice",
            title,
            effect,
            routeIds: ["R1"],
            // The notice's publication window includes the present, even when
            // its text describes work that will happen later.
            startsAt: NOW - 60_000,
            updatedAt: NOW,
          },
        ]),
        {
          agencyId: "sample",
          now: NOW,
          lineIds: ["R1"],
          rules: [
            {
              match: {
                effects: ["REDUCED_SERVICE"],
                titleIncludes: ["there will be no train service"],
              },
              result: { kind: "upcoming", severity: "normal" },
            },
          ],
        },
      );

      expect(snapshot.alerts[0]).toMatchObject({ kind, severity });
      expect(deriveLineStatuses(snapshot.alerts, ["R1"])["R1"]?.severity).toBe(severity);
      expect(toUpcomingClosures(snapshot.alerts)).toHaveLength(kind === "upcoming" ? 1 : 0);
      expect(toServiceAlerts(snapshot.alerts)).toHaveLength(kind === "upcoming" ? 0 : 1);
    },
  );

  it("uses declared reduced-speed semantics instead of the broad delay effect", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "ttc-rsz",
          title: "Subway trains will move slower than usual between stations",
          category: "Reduced Speed Zone",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          effect: "SIGNIFICANT_DELAYS",
          routeIds: ["1"],
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        lineIds: ["1"],
        rules: [
          {
            priority: 100,
            match: { textIncludes: ["reduced speed zone"] },
            result: { kind: "slow-service", severity: "degraded" },
          },
        ],
      },
    );

    expect(snapshot.alerts[0]).toMatchObject({ kind: "slow-service", severity: "degraded" });
  });

  it("classifies the Campus pedestrian-bridge closure as an active station accessibility warning", () => {
    const snapshot = interpretFixtureAlert([
      {
        id: "go-campus-bridge",
        title: "Campus - Pedestrian Bridge South of Campus - Construction",
        description:
          "Until further notice, the pedestrian bridge over Main Street will be closed for repairs. Customers wishing to access to the path to the Campus, will have to cross the street at West Street and Main Street and proceed to the north stairway on Main Street. This will add an additional 10 minutes to your commute.",
        startsAt: NOW - 1_000,
        updatedAt: NOW,
        effect: "NO_SERVICE",
        routeIds: ["R1"],
        affectedStations: ["feed-campus"],
      },
    ]);

    expect(snapshot).toMatchObject({
      agencyId: "regional",
      freshness: "live",
      alerts: [
        {
          id: "go-campus-bridge",
          kind: "accessibility",
          severity: "normal",
          lifecycle: "active",
          affectedLineIds: ["R1"],
          affectedRouteIds: ["R1"],
          affectedStations: [{ stationId: "campus", stationName: "Campus" }],
          title: "Campus - Pedestrian Bridge South of Campus - Construction",
        },
      ],
    });
    expect(snapshot.alerts[0]?.description).toContain("pedestrian bridge over Main Street");

    const projection = deriveMapProjection(snapshot, buildMapModel(railSchematic));
    expect(projection.stationAccessibilityOutages.has("campus")).toBe(true);
    expect(projection.stationSeverities.has("campus")).toBe(false);
    expect(projection.statusOverlaySegments).toEqual([]);

    const serviceAlert = toServiceAlerts(snapshot.alerts, railSchematic)[0];
    expect(serviceAlert).toMatchObject({
      kind: "accessibility",
      lineId: undefined,
      scope: "station",
    });
  });

  it.each(["pedestrian bridge", "station access", "access route", "stairway"] as const)(
    "uses explicit facility-access vocabulary for %s closures",
    (phrase) => {
      const snapshot = interpretFixtureAlert([
        {
          id: `go-${phrase.replaceAll(" ", "-")}`,
          title: `Campus - ${phrase} closure`,
          description: "Customers have a temporary alternative route.",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          effect: "NO_SERVICE",
          routeIds: ["R1"],
          affectedStations: ["feed-campus"],
        },
      ]);

      expect(snapshot.alerts[0]).toMatchObject({
        kind: "accessibility",
        severity: "normal",
        lifecycle: "active",
        affectedStations: [{ stationId: "campus" }],
      });
    },
  );

  it("keeps an unrelated NO_SERVICE alert as a severe suspension", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "go-signal-failure",
          title: "Rail line service suspended",
          description: "Trains are not running because of a signal failure.",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          effect: "NO_SERVICE",
          routeIds: ["R1"],
        },
      ]),
      { agencyId: "regional", now: NOW, manifest: railManifest as unknown as AgencyManifest },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "suspension",
      severity: "severe",
      lifecycle: "active",
      affectedLineIds: ["R1"],
    });
  });

  it.each([
    [
      "generic station construction delay",
      "regional",
      railManifest as unknown as AgencyManifest,
      "Station construction delay",
      "Construction work is causing delays near the station.",
      "SIGNIFICANT_DELAYS",
      "delay",
      "degraded",
    ],
    [
      "same closure under another agency",
      "sample",
      undefined,
      "Campus - Pedestrian Bridge South of Campus - Construction",
      "Until further notice, the pedestrian bridge over Main Street will be closed for repairs.",
      "NO_SERVICE",
      "suspension",
      "severe",
    ],
  ] as const)(
    "does not broaden facility-access semantics at the %s boundary",
    (_caseName, agencyId, manifest, title, description, effect, kind, severity) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: `${agencyId}-boundary`,
            title,
            description,
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect,
            routeIds: agencyId === "regional" ? ["R1"] : ["1"],
          },
        ]),
        {
          agencyId,
          now: NOW,
          manifest,
          lineIds: agencyId === "regional" ? undefined : ["1"],
        },
      );

      expect(snapshot.alerts[0]).toMatchObject({ kind, severity });
    },
  );

  it.each([
    "Oct. 17-18: Regional line service adjustments",
    "October 17-18, 2026: Regional line service adjustments",
    "17-18 oct. : Ajustements du service régional",
    "Ce week-end, le service sera ajusté.",
    "This weekend, service will be adjusted due to planned construction.",
  ])("keeps a published advance notice out of current severe status: %s", (title) => {
    const now = Date.parse("2026-10-16T12:00:00-04:00");
    const snapshot = interpretSnapshot(
      feed(
        [
          {
            id: "advance-construction",
            title,
            description: "There will be no train service between North and South.",
            effect: "NO_SERVICE",
            routeIds: ["R1"],
            startsAt: Date.parse("2026-10-01T12:00:00-04:00"),
            endsAt: now + 60_000,
            updatedAt: now,
          },
        ],
        now,
      ),
      {
        agencyId: "sample",
        now,
        lineIds: ["R1"],
        interpretation: { titleDateTimezone: "America/Toronto" },
      },
    );
    expect(snapshot.alerts[0]).toMatchObject({
      lifecycle: "upcoming",
      kind: "upcoming",
      severity: "normal",
      startsAt: Date.parse("2026-10-17T00:00:00-04:00"),
      endsAt: Date.parse("2026-10-19T00:00:00-04:00"),
    });
    expect(deriveLineStatuses(snapshot.alerts, ["R1"])["R1"]?.severity).toBe("normal");
  });

  it.each([
    ["2026-10-17T00:00:00-04:00", "active", "severe"],
    ["2026-10-18T23:59:59-04:00", "active", "severe"],
    ["2026-10-19T00:00:00-04:00", "expired", "severe"],
  ] as const)("uses the title impact window at %s", (time, lifecycle, severity) => {
    const now = Date.parse(time);
    const snapshot = interpretSnapshot(
      feed(
        [
          {
            id: "dated-construction",
            title: "Oct. 17-18: Regional service adjustments",
            effect: "NO_SERVICE",
            routeIds: ["R1"],
            startsAt: Date.parse("2026-10-01T12:00:00-04:00"),
            endsAt: Date.parse("2026-10-16T12:00:00-04:00"),
            updatedAt: Date.parse("2026-10-16T12:00:00-04:00"),
          },
        ],
        now,
      ),
      {
        agencyId: "sample",
        now,
        lineIds: ["R1"],
        interpretation: { titleDateTimezone: "America/Toronto" },
      },
    );
    expect(snapshot.alerts[0]).toMatchObject({ lifecycle, severity });
    expect(deriveLineStatuses(snapshot.alerts, ["R1"])["R1"]?.severity).toBe(
      lifecycle === "active" ? "severe" : "normal",
    );
  });

  it.each([
    ["Oct. 17-18: Service adjustments", undefined],
    ["Service suspended", "America/Toronto"],
    ["Oct. 32-33: Service adjustments", "America/Toronto"],
    ["Service suspended, repairs expected Oct. 17-18", "America/Toronto"],
  ])(
    "preserves feed timing without an opted-in valid title date: %s",
    (title, titleDateTimezone) => {
      const now = Date.parse("2026-10-16T12:00:00-04:00");
      const snapshot = interpretSnapshot(
        feed(
          [
            {
              id: "current-suspension",
              title,
              effect: "NO_SERVICE",
              startsAt: now - 60_000,
              updatedAt: now,
            },
          ],
          now,
        ),
        { agencyId: "sample", now, interpretation: { titleDateTimezone } },
      );
      expect(snapshot.alerts[0]).toMatchObject({
        lifecycle: "active",
        severity: "severe",
        startsAt: now - 60_000,
      });
    },
  );

  it.each([
    [
      "Jan. 2-3: Service adjustments",
      "2026-12-30T12:00:00-05:00",
      "2027-01-02T00:00:00-05:00",
      "2027-01-04T00:00:00-05:00",
    ],
    [
      "Oct. 31: Service adjustments",
      "2026-10-30T12:00:00-04:00",
      "2026-10-31T00:00:00-04:00",
      "2026-11-01T00:00:00-04:00",
    ],
    [
      "This weekend, service will be adjusted",
      "2026-10-30T12:00:00-04:00",
      "2026-10-31T00:00:00-04:00",
      "2026-11-02T00:00:00-05:00",
    ],
  ])("resolves title dates across calendar boundaries: %s", (title, received, start, end) => {
    const now = Date.parse(received);
    const snapshot = interpretSnapshot(
      feed(
        [
          {
            id: "calendar-boundary",
            title,
            effect: "NO_SERVICE",
            startsAt: now,
            updatedAt: now,
          },
        ],
        now,
      ),
      { agencyId: "sample", now, interpretation: { titleDateTimezone: "America/Toronto" } },
    );
    expect(snapshot.alerts[0]).toMatchObject({
      lifecycle: "upcoming",
      severity: "normal",
      startsAt: Date.parse(start),
      endsAt: Date.parse(end),
    });
  });

  it("uses active-period timing instead of planned wording for an already active alert", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "recurring-planned-closure",
          title: "There will be no subway service due to planned track work",
          startsAt: NOW - 60_000,
          endsAt: NOW + 60_000,
          updatedAt: NOW,
          effect: "REDUCED_SERVICE",
          routeIds: ["2"],
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["2"] },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      kind: "slow-service",
      severity: "degraded",
      lifecycle: "active",
    });
    expect(deriveLineStatuses(snapshot.alerts, ["2"])["2"]?.alerts).toHaveLength(1);
  });

  it("deduplicates repeated feed records by id or equivalent alert content", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "same-id",
          title: "Signal delay",
          description: "Trains are holding",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          routeIds: ["1"],
        },
        {
          id: "same-id",
          title: "Signal delay",
          description: "Trains are holding",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          routeIds: ["1"],
        },
        {
          id: "different-id",
          title: "Signal delay",
          description: "Trains are holding",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          routeIds: ["1"],
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["1"] },
    );

    expect(snapshot.alerts.map((alert) => alert.id)).toEqual(["same-id"]);
  });

  it("keeps same-content advisories with disjoint windows separate", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "weekend-1",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW - 10_000,
          endsAt: NOW - 5_000,
          updatedAt: NOW,
        },
        {
          id: "weekend-2",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW + 5_000,
          endsAt: NOW + 10_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["R7"] },
    );

    expect(snapshot.alerts).toHaveLength(2);
    expect(snapshot.alerts.map((alert) => alert.lifecycle)).toEqual(["expired", "upcoming"]);
  });

  it("does not merge disjoint windows just because their upstream ids match", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "reused-id",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW - 10_000,
          endsAt: NOW - 5_000,
          updatedAt: NOW,
        },
        {
          id: "reused-id",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW + 5_000,
          endsAt: NOW + 10_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["R7"] },
    );

    expect(snapshot.alerts).toHaveLength(2);
    expect(snapshot.alerts[0]?.id).not.toBe(snapshot.alerts[1]?.id);
  });

  it("merges overlapping windows and extends the combined end", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "closure-a",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW - 10_000,
          endsAt: NOW + 10_000,
          updatedAt: NOW,
        },
        {
          id: "closure-b",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW - 5_000,
          endsAt: NOW + 20_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["R7"] },
    );

    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.endsAt).toBe(NOW + 20_000);
  });

  it("merges an open-ended window while retaining any preceding gap", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "closure-a",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW - 10_000,
          endsAt: NOW - 5_000,
          updatedAt: NOW,
        },
        {
          id: "closure-b",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: NOW + 5_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW, lineIds: ["R7"] },
    );

    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({
      lifecycle: "upcoming",
      activePeriods: [{ startsAt: NOW - 10_000, endsAt: NOW - 5_000 }, { startsAt: NOW + 5_000 }],
      endsAt: undefined,
    });
  });

  it("keeps gaps in a multi-range alert inactive", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "recurring-closure",
          title: "Track closure",
          routeIds: ["R7"],
          startsAt: 1_000,
          endsAt: 9_500,
          activePeriods: [
            { startsAt: 1_000, endsAt: 2_000 },
            { startsAt: 9_000, endsAt: 9_500 },
          ],
          impactPeriods: [{ startsAt: 1_500, endsAt: 2_000 }],
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: 5_000, lineIds: ["R7"] },
    );

    expect(snapshot.alerts[0]).toMatchObject({
      lifecycle: "upcoming",
      activePeriods: [
        { startsAt: 1_000, endsAt: 2_000 },
        { startsAt: 9_000, endsAt: 9_500 },
      ],
      impactPeriods: [{ startsAt: 1_500, endsAt: 2_000 }],
    });
  });

  it("keeps an end-only period active until its exclusive end", () => {
    const alert: GenericAlert = {
      id: "end-only-period",
      title: "Track closure",
      startsAt: NOW + 1_000,
      endsAt: NOW + 2_000,
      activePeriods: [{ endsAt: NOW + 2_000 }],
      updatedAt: NOW,
      routeIds: ["R1"],
    };
    const snapshot = interpretFixtureAlert([alert]);
    const atExclusiveEnd = interpretFixtureAlert([alert], NOW + 2_000);

    expect(snapshot.alerts[0]).toMatchObject({
      lifecycle: "active",
      startsAt: NOW + 1_000,
      endsAt: NOW + 2_000,
      activePeriods: [{ endsAt: NOW + 2_000 }],
    });
    expect(atExclusiveEnd.alerts[0]?.lifecycle).toBe("expired");
  });

  it("uses feed presence when an alert has impact time without display time", () => {
    const snapshot = interpretFixtureAlert(
      [
        {
          id: "impact-only",
          title: "Track closure",
          startsAt: NOW,
          updatedAt: NOW,
          routeIds: ["R1"],
          impactPeriods: [{ startsAt: NOW + 1_000, endsAt: NOW + 2_000 }],
        },
      ],
      NOW + 3_000,
    );

    expect(snapshot.alerts[0]).toMatchObject({
      lifecycle: "active",
      impactPeriods: [{ startsAt: NOW + 1_000, endsAt: NOW + 2_000 }],
    });
  });

  it("merges cross-feed copies with different ids when one has opaque station ids", () => {
    const title = "Line 5: No service between North and South";
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "gtfs-75064",
          title: "No service between North and South",
          description: "Service disruption reported by GTFS-RT",
          cause: "ACCIDENT",
          lineId: "5",
          routeIds: ["5"],
          fromStationId: "feed-north",
          toStationId: "feed-south",
          affectedStations: ["feed-south", "feed-middle", "feed-north"],
          effect: "NO_SERVICE",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
        {
          id: "json-75064",
          title,
          lineId: "5",
          routeIds: ["5"],
          fromStationId: "North",
          toStationId: "South",
          affectedStations: ["South", "Middle", "North"],
          effect: "NO_SERVICE",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        lineIds: ["1", "2", "4", "5", "6"],
        interpretation: { stripLinePrefixFromTitle: true },
        stationIndex: metroSchematic.stationIndex,
      },
    );

    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({
      fromStation: { stationId: "north", stationName: "North" },
      toStation: { stationId: "south", stationName: "South" },
      affectedStations: [
        { stationId: "south", stationName: "South" },
        { stationId: "middle", stationName: "Middle" },
        { stationId: "north", stationName: "North" },
      ],
    });
  });

  it.each([
    ["a placeholder", "Transit Alert"],
    ["a publisher category", "Information"],
  ])("keeps distinct advisories that share %s title and route", (_kind, title) => {
    const placeholder = (id: string, description: string | undefined, startsAt = NOW - 1_000) => ({
      id,
      title,
      description,
      routeIds: ["101"],
      effect: "OTHER_EFFECT",
      startsAt,
      updatedAt: NOW,
    });
    const snapshot = interpretSnapshot(
      feed([
        placeholder("a", "Construction on Main Street. Stop 2400 will not be serviced."),
        placeholder("b", "Construction on Eve Street will affect service.", NOW - 500),
      ]),
      { agencyId: "sample", now: NOW },
    );

    expect(snapshot.alerts.map((alert) => alert.description)).toEqual([
      "Construction on Main Street. Stop 2400 will not be serviced.",
      "Construction on Eve Street will affect service.",
    ]);
  });

  it("still merges a placeholder-titled text alert with its description-less twin", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "text",
          title: "Transit Alert",
          description: "Detour on Main Street.",
          routeIds: ["101"],
          effect: "NO_SERVICE",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
        {
          id: "stops",
          title: "Transit Alert",
          routeIds: ["101"],
          targets: [{ routeId: "101", stopId: "2400" }],
          effect: "NO_SERVICE",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      { agencyId: "sample", now: NOW },
    );

    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]?.description).toBe("Detour on Main Street.");
  });

  it("retains translated safety evidence when cross-feed copies are merged", () => {
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "english-copy",
          title: "Transit Alert",
          routeIds: ["5"],
          effect: undefined,
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
        {
          id: "french-copy",
          title: "Line 5: Transit Alert",
          routeIds: ["5"],
          sourceTranslations: [{ field: "title", text: "Aucun service", language: "fr" }],
          effect: undefined,
          startsAt: NOW - 1_000,
          updatedAt: NOW,
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        interpretation: { stripLinePrefixFromTitle: true },
      },
    );

    expect(snapshot.alerts).toHaveLength(1);
    expect(snapshot.alerts[0]).toMatchObject({ kind: "suspension", severity: "severe" });
  });

  it("keeps same-name stations with distinct schematic IDs as separate alerts", () => {
    const stationIndex = [
      {
        id: "feed-east",
        schematicId: "central-east",
        name: "Central",
        lat: 43,
        lon: -79,
        lines: ["1"],
        platformIds: [],
      },
      {
        id: "feed-west",
        schematicId: "central-west",
        name: "Central",
        lat: 43.1,
        lon: -79.1,
        lines: ["1"],
        platformIds: [],
      },
    ];
    const snapshot = interpretSnapshot(
      feed([
        {
          id: "central-east-alert",
          title: "Central disruption",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          affectedStations: ["feed-east"],
        },
        {
          id: "central-west-alert",
          title: "Central disruption",
          startsAt: NOW - 1_000,
          updatedAt: NOW,
          affectedStations: ["feed-west"],
        },
      ]),
      { agencyId: "test", now: NOW, stationIndex },
    );

    expect(snapshot.alerts).toHaveLength(2);
    expect(snapshot.alerts.map((alert) => alert.affectedStations?.[0]?.stationId)).toEqual([
      "central-east",
      "central-west",
    ]);
  });

  it.each([
    ["sample", ["1", "2", "4", "5", "6"]],
    ["regional", ["R1", "MI", "KI", "BR", "R1", "ST", "LE", "UP"]],
    ["metro", ["blue", "purple", "orange", "yellow"]],
    ["local", undefined],
    ["via-rail", undefined],
  ] as const)(
    "keeps the interpreted snapshot wire shape consistent for %s",
    (agencyId, lineIds) => {
      const snapshot = interpretSnapshot(
        feed([
          {
            id: `${agencyId}-alert`,
            title: "Service suspended",
            startsAt: NOW - 1_000,
            updatedAt: NOW,
            effect: "NO_SERVICE",
            routeIds: [lineIds?.[0] ?? "route-1"],
          },
        ]),
        { agencyId, now: NOW, lineIds },
      );

      expect(snapshot).toMatchObject({
        agencyId,
        generatedAt: NOW,
        freshness: "live",
        alerts: [{ kind: "suspension", severity: "severe", lifecycle: "active" }],
      });
    },
  );

  describe("deriveLineStatuses", () => {
    const LINE_IDS = ["1", "2"];

    const sampleAlert = (
      id: string,
      severity: "normal" | "degraded" | "severe",
      affectedLineIds?: readonly string[],
    ): AgencyAlert => ({
      id,
      kind: "delay",
      severity,
      lifecycle: "active",
      scope: "network",
      title: id,
      startsAt: 0,
      updatedAt: 0,
      affectedLineIds,
    });

    it("folds attributed alerts onto their line by severity rank, defaulting to normal", () => {
      const statuses = deriveLineStatuses(
        [sampleAlert("a", "degraded", ["2"]), sampleAlert("b", "severe", ["2"])],
        LINE_IDS,
      );

      expect(statuses["2"].severity).toBe("severe");
      expect(statuses["2"].alerts.map((alert) => alert.id)).toEqual(["a", "b"]);
      expect(statuses["1"]).toEqual({ lineId: "1", severity: "normal", alerts: [] });
    });

    it("attaches multi-line alerts to every attributed line", () => {
      const statuses = deriveLineStatuses(
        [sampleAlert("syswide", "degraded", ["1", "2"])],
        LINE_IDS,
      );

      expect(statuses["1"].alerts.map((alert) => alert.id)).toEqual(["syswide"]);
      expect(statuses["2"].alerts.map((alert) => alert.id)).toEqual(["syswide"]);
    });

    it("never attaches unattributed alerts to any line", () => {
      const statuses = deriveLineStatuses(
        [sampleAlert("vague", "severe"), sampleAlert("empty", "severe", [])],
        LINE_IDS,
      );

      for (const lineId of LINE_IDS) {
        expect(statuses[lineId]).toEqual({ lineId, severity: "normal", alerts: [] });
      }
    });

    it("ignores attribution to lines outside declared schematic ids", () => {
      const statuses = deriveLineStatuses([sampleAlert("ghost", "degraded", ["9"])], LINE_IDS);

      expect(statuses["1"].alerts).toEqual([]);
      expect(statuses["2"].alerts).toEqual([]);
    });

    it("derives nothing for agencies without declared lines", () => {
      expect(deriveLineStatuses([sampleAlert("a", "degraded")], [])).toEqual({});
    });

    it("degrades line severity rather than shutting down the line for station-scoped severe alerts", () => {
      const statuses = deriveLineStatuses(
        [
          {
            ...sampleAlert("bypass", "severe", ["2"]),
            scope: "station",
          },
        ],
        LINE_IDS,
      );

      expect(statuses["2"].severity).toBe("degraded");
    });

    it("does not degrade line status for station-scoped informational alerts", () => {
      const statuses = deriveLineStatuses(
        [
          {
            ...sampleAlert("info", "normal", ["2"]),
            kind: "information",
            scope: "station",
          },
        ],
        LINE_IDS,
      );

      expect(statuses["2"].severity).toBe("normal");
      expect(statuses["2"].alerts.map((alert) => alert.id)).toEqual(["info"]);
    });

    it("does not degrade line status for station accessibility alerts", () => {
      const statuses = deriveLineStatuses(
        [
          {
            ...sampleAlert("elevator", "severe", ["2"]),
            kind: "accessibility",
            scope: "station",
          },
        ],
        LINE_IDS,
      );

      expect(statuses["2"].severity).toBe("normal");
      expect(statuses["2"].alerts.map((alert) => alert.id)).toEqual(["elevator"]);
    });
  });
});

describe("trip-scoped and placeholder-titled alerts", () => {
  const base = (alert: Partial<GenericAlert> & Pick<GenericAlert, "id">): GenericAlert => ({
    title: "Transit Alert",
    startsAt: NOW - 1_000,
    updatedAt: NOW,
    ...alert,
  });
  const run = (alerts: GenericAlert[]) =>
    interpretSnapshot(feed(alerts), { agencyId: "sample", now: NOW }).alerts;

  it.each([
    ["a severe suspension", { effect: "NO_SERVICE" }, undefined],
    [
      "a degraded suspension",
      { effect: "OTHER_EFFECT" },
      [
        {
          match: { effects: ["OTHER_EFFECT"] },
          result: { kind: "suspension" as const, severity: "degraded" as const },
        },
      ],
    ],
  ])("never lets cancelled trips become a suspension: %s", (_label, fields, rules) => {
    const [alert] = interpretSnapshot(
      feed([base({ id: "cancel", routeIds: ["7"], tripIds: ["t1"], tripScoped: true, ...fields })]),
      { agencyId: "sample", now: NOW, rules },
    ).alerts;
    expect(alert).toMatchObject({ scope: "trip", kind: "information", severity: "degraded" });
  });

  it("keeps the route's severity when the alert also names the whole route", () => {
    const [alert] = run([
      base({ id: "mixed", routeIds: ["7"], tripIds: ["t1"], effect: "NO_SERVICE" }),
    ]);
    expect(alert).toMatchObject({ scope: "route", kind: "suspension", severity: "severe" });
  });

  it("folds a description-less NO_SERVICE twin into its text alert and keeps the effect", () => {
    const targets = [{ routeId: "15", stopId: "1869" }];
    const alerts = run([
      base({
        id: "ft",
        description: "Due to construction this stop is temporarily out of service.",
        routeIds: ["15"],
        targets,
        effect: "OTHER_EFFECT",
      }),
      base({ id: "ds", routeIds: ["15"], targets, effect: "NO_SERVICE" }),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ id: "ft", scope: "station", kind: "suspension" });
  });

  it("folds a placeholder machine twin into a descriptive headline with identical scope", () => {
    const targets = [{routeId: "R", stopId: "a"}];
    const alerts = run([
      base({id: "text", title: "Elm Street construction", description: "Stops closed for construction.", routeIds: ["R"], targets, effect: "OTHER_EFFECT"}),
      base({id: "machine", routeIds: ["R"], targets, effect: "NO_SERVICE"}),
    ]);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({title: "Elm Street construction", scope: "station", severity: "severe"});
  });

  it("folds split machine twins only when their combined feed scope equals the text notice", () => {
    const targets = [{routeId: "R", stopId: "a"}, {stopId: "b"}];
    const alerts = interpretSnapshot(feed([
      base({id: "text", description: "Elm Street stops closed.", routeIds: ["R"], targets, affectedStations: ["a", "b"], effect: "OTHER_EFFECT"}),
      base({id: "route-stop", routeIds: ["R"], targets: [targets[0]!], affectedStations: ["a"], effect: "NO_SERVICE"}),
      base({id: "stop-only", targets: [targets[1]!], affectedStations: ["b"], effect: "NO_SERVICE"}),
    ]), {agencyId: "sample", now: NOW, stationIndex: [{id: "hub", schematicId: "hub", name: "Hub", platformIds: ["a", "b"], lat: 0, lon: 0, lines: ["R"]}]}).alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({id: "text", scope: "station", severity: "severe"});
    expect(alerts[0]?.targets).toHaveLength(2);
  });

  it("keeps machine records separate when several text notices match their scope and period", () => {
    const targets = [{stopId: "a"}];
    const alerts = run([
      base({id: "first", title: "Construction", description: "Road work.", targets}),
      base({id: "second", title: "Stop relocation", description: "Use adjacent stop.", targets}),
      base({id: "machine", targets, effect: "NO_SERVICE"}),
    ]);
    expect(alerts.map(alert => alert.id)).toEqual(["first", "second", "machine"]);
  });

  it("preserves a severe machine record when the text record has a conflicting specific effect", () => {
    const targets = [{routeId: "R", stopId: "a"}];
    const alerts = run([
      base({id: "text", title: "Road works", description: "Use detour.", routeIds: ["R"], targets, effect: "DETOUR"}),
      base({id: "machine", routeIds: ["R"], targets, effect: "NO_SERVICE"}),
    ]);
    expect(alerts).toHaveLength(2);
    expect(alerts.find(alert => alert.id === "machine")).toMatchObject({severity: "severe", scope: "station"});
  });

  it("does not combine split machine records from different declared lines", () => {
    const alerts = run([
      base({id: "text", lineId: "A", description: "Stops closed.", targets: [{stopId: "a"}, {stopId: "b"}]}),
      base({id: "first", lineId: "A", targets: [{stopId: "a"}], effect: "NO_SERVICE"}),
      base({id: "second", lineId: "B", targets: [{stopId: "b"}], effect: "NO_SERVICE"}),
    ]);
    expect(alerts.map(alert => alert.id)).toEqual(["text", "first", "second"]);
  });

  it("keeps a twin apart when its stops differ at all", () => {
    const alerts = run([
      base({
        id: "ft",
        description: "Stops closed.",
        targets: [{ stopId: "1" }, { stopId: "2" }],
        effect: "OTHER_EFFECT",
      }),
      base({ id: "ds", targets: [{ stopId: "1" }], effect: "NO_SERVICE" }),
    ]);
    expect(alerts.map((alert) => alert.id)).toEqual(["ft", "ds"]);
  });

  describe("feed and page advisories", () => {
    const page = (alert: Partial<GenericAlert> = {}): GenericAlert => ({
      id: "page",
      title: "East End detour",
      description: "Beginning June 29, routes 12 and 16 detour for the Pacific Avenue bridge.",
      routeIds: ["12", "16"],
      effect: "DETOUR",
      startsAt: NOW - 500,
      updatedAt: NOW,
      ...alert,
    });
    const copy = (alert: Partial<GenericAlert> = {}) =>
      base({
        id: "ft",
        description:
          "Due to the Pacific Ave bridge, routes 12 and 16 are on detour beginning June 29.",
        routeIds: ["12", "16"],
        effect: "OTHER_EFFECT",
        startsAt: NOW - 3 * 24 * 3_600_000,
        ...alert,
      });

    it("keeps a route feed notice and page advisory separate with both descriptions", () => {
      const alerts = run([copy(), page()]);
      expect(alerts.map((alert) => alert.id)).toEqual(["ft", "page"]);
      expect(alerts.map((alert) => alert.description)).toEqual([
        "Due to the Pacific Ave bridge, routes 12 and 16 are on detour beginning June 29.",
        "Beginning June 29, routes 12 and 16 detour for the Pacific Avenue bridge.",
      ]);
    });

    it("keeps unrelated open-ended notices on the same routes and start week apart", () => {
      const alerts = run([
        copy({
          description: "Routes 12 and 16 are detouring around Victoria Park.",
          startsAt: NOW - 3 * 24 * 3_600_000,
        }),
        page(),
      ]);
      expect(alerts.map((alert) => alert.id)).toEqual(["ft", "page"]);
    });

    it("keeps stop closures separate from route-level page advisory scope", () => {
      const advisory = page({ routeIds: ["15"], affectedStations: ["1869", "1298"] });
      const alerts = run([
        base({
          id: "closure",
          description: "Stops closed.",
          routeIds: ["15"],
          targets: [{ routeId: "15", stopId: "1869" }],
          effect: "NO_SERVICE",
        }),
        base({
          id: "wider",
          description: "Another stop.",
          routeIds: ["15"],
          targets: [{ routeId: "15", stopId: "9999" }],
          effect: "OTHER_EFFECT",
        }),
        advisory,
      ]);
      expect(alerts.map((alert) => alert.id)).toEqual(["closure", "wider", "page"]);
    });
  });
});


describe("transport-independent named route scope", () => {
  it("attributes named notices after decoding and preserves explicit published route IDs", () => {
    const snapshot = interpretSnapshot(feed([
      { id: "named", title: "Riverside route detour", startsAt: NOW, updatedAt: NOW },
      { id: "explicit", title: "Route 9 at Riverside Avenue", routeIds: ["9"], startsAt: NOW, updatedAt: NOW },
      { id: "partial-name", title: "Riversideway service change", startsAt: NOW, updatedAt: NOW },
      { id: "unresolved-trip", title: "Riverside cancelled departure", tripScoped: true, startsAt: NOW, updatedAt: NOW },
    ]), { agencyId: "fictional", now: NOW, interpretation: {
      lineIds: ["2", "9"], routeNames: { "2": ["Riverside"] },
    } });
    expect(snapshot.alerts.map((alert) => alert.affectedLineIds)).toEqual([["2"], ["9"], undefined, undefined]);
    expect(snapshot.alerts[3]?.affectedRouteIds).toBeUndefined();
    expect(snapshot.alerts[3]?.scope).toBe("trip");
  });
});

describe("published advisory impact captions", () => {
  it.each([
    [
      "No Service on Civic Day",
      "Please note that there will be no Northport bus service on Civic Day November 11th.",
      "2026-11-11T00:00:00-05:00",
      "2026-11-12T00:00:00-05:00",
    ],
    [
      "No Service",
      "<p>Regular Route will not be running on  Founders Day November 11 2026!</p><p>The regional shuttle will run as usual.</p>",
      "2026-11-11T00:00:00-05:00",
      "2026-11-12T00:00:00-05:00",
    ],
    [
      "Updated construction detour: August 24 – September 4, 2026",
      "",
      "2026-08-24T00:00:00-04:00",
      "2026-09-05T00:00:00-04:00",
    ],
    [
      "Festival service changes",
      "Road closures run June 12 and June 13, with a Transit detour on June 13.",
      "2026-06-13T00:00:00-04:00",
      "2026-06-14T00:00:00-04:00",
    ],
    [
      "Regional detour | Sept. 21 – Oct. 16, 2026",
      "",
      "2026-09-21T00:00:00-04:00",
      "2026-10-17T00:00:00-04:00",
    ],
    [
      "Route cancellation | October 22, 2026",
      "",
      "2026-10-22T00:00:00-04:00",
      "2026-10-23T00:00:00-04:00",
    ],
    [
      "Holiday affected services",
      "A prior phase ended September 30. Service impacts concern Heritage Day, which occurs on Monday, October 12. Another phase starts November 1.",
      "2026-10-12T00:00:00-04:00",
      "2026-10-13T00:00:00-04:00",
    ],
    [
      "Regional detour | December 20 – January 5, 2027",
      "",
      "2026-12-20T00:00:00-05:00",
      "2027-01-06T00:00:00-05:00",
    ],
  ])(
    "uses the stated impact instead of publication-age expiry: %s",
    (title, description, start, end) => {
      const published = Date.parse("2026-09-20T00:00:00-04:00");
      const alert = {
        id: "published",
        title,
        description,
        startsAt: published,
        endsAt: published + 86_400_000,
        updatedAt: published,
      };
      const read = (now: number) =>
        interpretSnapshot(feed([alert], now), {
          agencyId: "sample",
          now,
          interpretation: { titleDateTimezone: "America/Toronto" },
        }).alerts[0];
      expect(read(Date.parse(start) - 1)).toMatchObject({
        lifecycle: "upcoming",
        startsAt: Date.parse(start),
        endsAt: Date.parse(end),
      });
      expect(read(Date.parse(end) - 1)).toMatchObject({ lifecycle: "active" });
      expect(read(Date.parse(end))).toMatchObject({ lifecycle: "expired" });
    },
  );

  it("rejects a contradictory explicit caption instead of claiming a fresh all-clear", () => {
    expect(() =>
      interpretSnapshot(
        feed([
          {
            id: "invalid",
            title: "Detour | December 20, 2026 – January 5, 2026",
            startsAt: NOW,
            updatedAt: NOW,
          },
        ]),
        { agencyId: "sample", now: NOW, interpretation: { titleDateTimezone: "America/Toronto" } },
      ),
    ).toThrow(/impact period/);
  });

  it("attributes coordinated published route names to both fictional routes", () => {
    const s = interpretSnapshot(
      feed([
        {
          id: "joint",
          title: "Detours on both routes",
          description: "Both the Northport and Southport transit routes are detoured.",
          startsAt: NOW,
          updatedAt: NOW,
        },
      ]),
      {
        agencyId: "sample",
        now: NOW,
        lineIds: ["A", "B"],
        interpretation: {
          routeNames: { A: ["Northport route", "Northport and Southport"], B: ["Southport"] },
        },
      },
    );
    expect(s.alerts[0]).toMatchObject({
      affectedRouteIds: ["A", "B"],
      affectedLineIds: ["A", "B"],
    });
  });
});

describe("published restoration chronology", () => {
  const cancellation: GenericAlert = {
    id: "cancel",
    title: "Eastport transit route cancellation | September 11, 2026",
    description: "The Eastport route is cancelled due to mechanical issues.",
    startsAt: Date.parse("2026-09-10T00:00:00-04:00"),
    updatedAt: Date.parse("2026-09-10T00:00:00-04:00"),
  };
  const restoration: GenericAlert = {
    id: "restore",
    title: "Eastport transit route operational | September 11, 2026",
    description: "The Eastport route is operational as the mechanical issues have been resolved.",
    startsAt: Date.parse("2026-09-11T00:00:00-04:00"),
    updatedAt: Date.parse("2026-09-11T00:00:00-04:00"),
  };
  const options = {
    agencyId: "fictional",
    now: Date.parse("2026-09-11T16:00:00-04:00"),
    interpretation: {
      titleDateTimezone: "America/Toronto",
      reconcilePublishedRestorations: true,
      lineIds: ["A"],
      routeNames: { A: ["Eastport"] },
      rules: [
        {
          match: { titleIncludes: ["cancellation"] },
          result: { kind: "suspension", severity: "severe" },
        },
      ],
    },
  } as const;
  it("retires the explicitly matched cancellation at the later restoration publication", () => {
    const snapshot = interpretSnapshot(feed([cancellation, restoration]), options);
    expect(snapshot.alerts.find((a) => a.id === "cancel")).toMatchObject({
      lifecycle: "expired",
      endsAt: restoration.updatedAt,
    });
    expect(deriveLineStatuses(snapshot.alerts, ["A"]).A?.severity).toBe("normal");
    expect(() => Schema.decodeUnknownSync(AgencySnapshotSchema)(snapshot)).not.toThrow();
  });
  it.each([
    { ...restoration, updatedAt: cancellation.updatedAt },
    { ...restoration, description: "Service is operational after roadworks have been resolved." },
    { ...restoration, title: "Westport transit route operational | September 11, 2026" },
    { ...restoration, title: "Eastport transit route operational | September 12, 2026" },
  ])("preserves cancellations without an unambiguous later matching restoration", (candidate) => {
    const snapshot = interpretSnapshot(feed([cancellation, candidate]), options);
    expect(snapshot.alerts.find((a) => a.id === "cancel")?.lifecycle).toBe("active");
  });
});

it("interprets linked operator words as advisory prose", () => {
  const snapshot = interpretSnapshot(
    feed([
      {
        id: "holiday",
        title: "Heritage Day",
        description:
          "There will be no [City Transit](https://example.test/transit) service on Monday.",
        startsAt: NOW - 100,
        updatedAt: NOW,
      },
    ]),
    {
      agencyId: "fictional",
      now: NOW,
      interpretation: {
        rules: [
          {
            match: { textIncludes: ["no City Transit service"] },
            result: { kind: "suspension", severity: "severe" },
          },
        ],
      },
    },
  );
  expect(snapshot.alerts[0]).toMatchObject({ kind: "suspension", severity: "severe" });
});

it("uses declared stop identity extraction for an unstructured boarding closure", () => {
  const snapshot = interpretSnapshot(feed([{ id: "closure", title: "Transit Alert", description: "Stop #1234 (West Road) will be temporarily closed.\nUse Stop #5678 instead.", routeIds: ["B7"], targets: [{ routeId: "B7" }], startsAt: NOW - 1000, updatedAt: NOW }]), {
    agencyId: "sample", now: NOW,
    interpretation: { stopIdPattern: "Stop #([0-9]+)[^\\n]*?temporarily closed", rules: [{ priority: 100, match: { textIncludes: ["temporarily closed"] }, result: { kind: "suspension", severity: "severe" } }] },
  });
  expect(snapshot.alerts[0]).toMatchObject({ scope: "station", title: "Stop #1234 (West Road) will be temporarily closed.", affectedStations: [{ stationName: "1234" }], targets: [{ routeId: "B7", station: { stationName: "1234" } }] });
});

it("reconciles an untimed equipment notice with its precise machine incident", () => {
  const title = "October 19 - November 6: North Station elevator temporarily closed";
  const body = "The elevator at North Station is closed for maintenance.";
  const start = Date.parse("2026-10-19T10:30:00Z");
  const end = Date.parse("2026-11-06T09:00:00Z");
  const now = Date.parse("2026-10-23T12:00:00Z");
  const snapshot = interpretSnapshot(feed([
    { id: "wire", title: "Transit Alert", description: `${title}\n${body}\nUse the functioning escalator. Take a shuttle between North and South Station.`, routeIds: ["R1"], targets: [{ routeId: "R1" }], startsAt: start, endsAt: end, updatedAt: now },
    { id: "web", title, description: `${body}\n[Replacement map](https://example.test/shuttle.pdf)`, routeIds: ["R1"], affectedStations: ["North"], targets: [{ stopId: "North" }], startsAt: 0, updatedAt: now },
  ], now), { agencyId: "sample", now, schematic: railSchematic, interpretation: { titleDateTimezone: "America/Edmonton", preserveFeedPeriods: true, reconcileUntimedNotices: true } });
  expect(snapshot.alerts).toHaveLength(1);
  expect(snapshot.alerts[0]).toMatchObject({ id: "wire", scope: "station", startsAt: start, endsAt: end, affectedStations: [{ stationId: "north", stationName: "North" }], equipmentOutages: [{ type: "elevator", equipment: "elevator", location: "North" }] });
  expect(snapshot.alerts[0].description).toContain("https://example.test/shuttle.pdf");
  expect(snapshot.alerts[0].toStation).toBeUndefined();
});

it.each([
  ["ACCESSIBILITY_ISSUE", "accessibility", "normal"],
  ["SIGNIFICANT_DELAYS", "delay", "degraded"],
  ["DETOUR", "information", "normal"],
  ["NO_SERVICE", "suspension", "severe"],
])("preserves the published %s effect when a station also groups bus bays", (effect, kind, severity) => {
  const snapshot = interpretSnapshot(feed([{ id: "notice", title: "Station notice", startsAt: NOW - 1000, updatedAt: NOW, routeIds: ["R"], affectedStations: ["rail-a", "rail-b"], effect }]), {
    agencyId: "sample", now: NOW,
    manifest: makeTestProvider({ alertInterpretation: { lineIds: ["R"] } }).manifest,
    stationIndex: [{ id: "hub", schematicId: "hub", name: "Hub", lat: 0, lon: 0, lines: ["R"], platformIds: ["rail-a", "rail-b", "bus-bay"], departureRouteIds: ["R", "BUS"] }],
  });
  expect(snapshot.alerts[0]).toMatchObject({ kind, severity });
  expect(deriveLineStatuses(snapshot.alerts, ["R"])["R"].severity).toBe(severity === "severe" ? "degraded" : severity);
});

it.each([
  ["an unstructured", undefined, "R"],
  ["a route-less", "NO_SERVICE", undefined],
])("keeps %s partial platform closure degraded", (_label, effect, lineId) => {
  const snapshot = interpretSnapshot(
    feed([
      {
        id: "closure",
        title: "Platform closed",
        startsAt: NOW - 1000,
        updatedAt: NOW,
        lineId,
        affectedStations: ["a"],
        effect,
      },
    ]),
    {
      agencyId: "sample",
      now: NOW,
      lineIds: ["R"],
      stationIndex: [
        { id: "hub", schematicId: "hub", name: "Hub", lat: 0, lon: 0, lines: ["R"], platformIds: ["a", "b"] },
      ],
    },
  );
  expect(snapshot.alerts[0]).toMatchObject({ kind: "delay", severity: "degraded" });
});

it("removes only the publisher-declared open-ended retirement sentinel", () => {
  const sentinel = 32_503_694_400_000;
  const input = feed([
    {
      id: "closure",
      updatedAt: NOW,
      title: "Stop closure",
      startsAt: NOW - 1000,
      endsAt: sentinel,
      activePeriods: [{ startsAt: NOW - 1000, endsAt: sentinel }],
    },
  ]);
  const snapshot = interpretSnapshot(input, {
    agencyId: "sample",
    now: NOW,
    interpretation: { openEndedEndTimestamp: sentinel },
  });
  expect(snapshot.alerts[0].endsAt).toBeUndefined();
  expect(snapshot.alerts[0].activePeriods).toEqual([{ startsAt: NOW - 1000, endsAt: undefined }]);
  expect(interpretSnapshot(input, { agencyId: "sample", now: NOW }).alerts[0].endsAt).toBe(
    sentinel,
  );
});

it("keeps a published stop restriction at station scope without inventing a stop", () => {
  const snapshot = interpretSnapshot(feed([{id: "closure", title: "Stop closure", startsAt: NOW - 1000, updatedAt: NOW, routeIds: ["R1"], stopScoped: true, effect: "NO_SERVICE"}]), {agencyId: "sample", now: NOW, lineIds: ["R1"]});
  expect(snapshot.alerts[0]).toMatchObject({scope: "station", affectedRouteIds: ["R1"]});
  expect(deriveLineStatuses(snapshot.alerts, ["R1"])["R1"].severity).toBe("normal");
});

it("does not merge an unidentified stop restriction into an otherwise identical route notice", () => {
  const alert: GenericAlert = {id: "notice", title: "Construction", startsAt: NOW - 1000, updatedAt: NOW, routeIds: ["R1"]};
  const snapshot = interpretSnapshot(feed([alert, {...alert, stopScoped: true}]), {agencyId: "sample", now: NOW, lineIds: ["R1"]});
  expect(snapshot.alerts.map((alert) => alert.scope)).toEqual(["line", "station"]);
});
