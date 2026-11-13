import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import contract from "../fixtures/realtime/i3.contract.json";
import statusContract from "../fixtures/realtime/component-status.contract.json";
import { normalizeI3ServiceStatus } from "~/infrastructure/realtime/i3ServiceStatus";
import { componentServiceStatus } from "~/infrastructure/realtime/componentServiceStatus";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";

describe("i3 service status parity", () => {
  it.each(contract.filter((c) => !c.invalid))("$name", (c) => {
    expect(
      JSON.parse(
        JSON.stringify(
          normalizeI3ServiceStatus(c.input, {
            excludedDescriptionPrefixes:
              "excludedDescriptionPrefixes" in c ? c.excludedDescriptionPrefixes : undefined,
            redundantSummaryPrefixes:
              "redundantSummaryPrefixes" in c ? c.redundantSummaryPrefixes : undefined,
          }),
        ),
      ),
    ).toEqual(c.expected);
  });
  it.each(contract.filter((c) => c.invalid))("rejects $name", (c) => {
    expect(() =>
      normalizeI3ServiceStatus(c.input, {
        excludedDescriptionPrefixes:
          "excludedDescriptionPrefixes" in c ? c.excludedDescriptionPrefixes : undefined,
        redundantSummaryPrefixes:
          "redundantSummaryPrefixes" in c ? c.redundantSummaryPrefixes : undefined,
      }),
    ).toThrow();
  });
  it.each(statusContract.filter((c) => !c.invalid))("$name", (c) => {
    expect(componentServiceStatus(c.html, c.routes, c.stops)).toEqual(c.expected);
  });
  it.each(statusContract.filter((c) => c.invalid))("rejects $name", (c) => {
    expect(() => componentServiceStatus(c.html, c.routes, c.stops)).toThrow();
  });
  it.each(["en", "fr"] as const)(
    "resolves seeded identities, stop scope, directions and %s copy through snapshots",
    async (locale) => {
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          locale,
          timeZone: "UTC",
          now: () => 1700000200000,
          sources: [
            { type: "json", parser: "i3-service-status", url: "https://sample.test/status" },
          ],
          fetch: async () => Response.json(contract[0]!.input),
          getSourceAgencyScope: () =>
            Effect.succeed({
              directionsByRoute: new Map([
                ["route-a|south", 1],
                ["route-a|north", 0],
              ]),
              routeIds: new Set(["route-a"]),
              stopIds: new Set(["stop-a"]),
              routesByShortName: new Map([["A", ["route-a"]]]),
              stopsByCode: new Map([["123", ["stop-a"]]]),
            }),
        }),
      );
      expect(snapshot.alerts).toHaveLength(1);
      expect(snapshot.alerts[0]).toMatchObject({
        title: locale === "fr" ? "Votre arrêt" : "Your stop",
        scope: "station",
        affectedRouteIds: ["route-a"],
        targets: [{ routeId: "route-a", directionId: 1, station: { stationName: "stop-a" } }],
      });
      expect(snapshot.sourceUpdatedAt).toBe(1700000100000);
    },
  );
});

const identityScope = {
  directionsByRoute: new Map([
    ["route-a|south", 1],
    ["route-a|north", 0],
  ]),
  routeIds: new Set(["route-a"]),
  stopIds: new Set(["stop-a"]),
  routesByShortName: new Map([["A", ["route-a"]]]),
  stopsByCode: new Map([["123", ["stop-a"]]]),
};
const sources = [
  { type: "json", parser: "i3-service-status", url: "https://sample.test/status" },
  {
    type: "web",
    parser: "heading-service-notices",
    url: "https://sample.test/web",
    routeNames: { A: ["Line A"] },
    stopNames: { central: ["Central"] },
  },
] as const;
const now = 1700000200000;

describe("i3 independent source failures", () => {
  it("keeps an old empty i3 board stale alongside a current normal web board", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources,
        getSourceAgencyScope: () => Effect.succeed(identityScope),
        fetch: async (url) =>
          String(url).endsWith("/web")
            ? new Response(statusContract[1]!.html)
            : Response.json({ header: { timestamp: 1600000000 }, alerts: [] }),
      }),
    );
    expect(snapshot).toMatchObject({ freshness: "stale", alerts: [] });
  });
  it("retains independently readable web notices when seeded identity lookup fails", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources,
        getSourceAgencyScope: () => Effect.fail(new Error("database unavailable")),
        fetch: async (url) =>
          String(url).endsWith("/web")
            ? new Response(statusContract[0]!.html)
            : Response.json(contract[0]!.input),
      }),
    );
    expect(snapshot).toMatchObject({
      freshness: "stale",
      alerts: [{ title: "Station Central", kind: "accessibility", scope: "station" }],
    });
  });
  it("keeps opposite direction scopes while applying the declared unknown-effect policy", async () => {
    const { makeTestManifest } = await import("../helpers/agency-fixtures");
    const original = contract[0]!.input;
    const south = original.alerts![0]!;
    const north = {
      ...south,
      informed_entities: [{ route_short_name: "A" }, { stop_code: "123" }, { direction_id: "N" }],
    };
    const manifest = makeTestManifest({
      alertInterpretation: {
        rules: [
          {
            priority: 10,
            match: { effects: ["UNKNOWN_EFFECT"] },
            result: { kind: "information", severity: "degraded" },
          },
        ],
      },
    });
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources: [sources[0]],
        manifest,
        getSourceAgencyScope: () => Effect.succeed(identityScope),
        fetch: async () => Response.json({ ...original, alerts: [south, north] }),
      }),
    );
    expect(snapshot.alerts.flatMap((a) => a.targets?.map((t) => t.directionId))).toEqual([1, 0]);
    expect(
      snapshot.alerts.every(
        (a) => a.kind === "information" && a.severity === "degraded" && a.scope === "station",
      ),
    ).toBe(true);
  });
  it("preserves unknown selector dimensions without attributing them to known routes", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources: [sources[0]],
        getSourceAgencyScope: () =>
          Effect.succeed({
            ...identityScope,
            routesByShortName: new Map(),
            stopsByCode: new Map(),
          }),
        fetch: async () => Response.json(contract[0]!.input),
      }),
    );
    expect(snapshot.alerts[0]).toMatchObject({
      scope: "station",
      affectedLineIds: undefined,
      affectedRouteIds: ["route-short:A"],
      targets: [{ routeId: "route-short:A", station: { stationName: "stop-code:123" } }],
    });
  });
});

describe("i3 header age window", () => {
  it.each([
    {
      label: "reads an eleven-minute-old board stale under the ten-minute default",
      maxHeaderAgeMinutes: undefined,
      ageMinutes: 11,
      expected: "stale",
    },
    {
      label: "reads a twenty-minute-old board live inside a declared twenty-five-minute window",
      maxHeaderAgeMinutes: 25,
      ageMinutes: 20,
      expected: "live",
    },
    {
      label: "reads a twenty-six-minute-old board stale beyond a declared twenty-five-minute window",
      maxHeaderAgeMinutes: 25,
      ageMinutes: 26,
      expected: "stale",
    },
  ])("$label", async ({ maxHeaderAgeMinutes, ageMinutes, expected }) => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources: [
          {
            type: "json",
            parser: "i3-service-status",
            url: "https://sample.test/status",
            ...(maxHeaderAgeMinutes === undefined ? {} : { maxHeaderAgeMinutes }),
          },
        ],
        getSourceAgencyScope: () => Effect.succeed(identityScope),
        fetch: async () =>
          Response.json({
            header: { timestamp: now / 1000 - ageMinutes * 60 },
            alerts: [],
          }),
      }),
    );
    expect(snapshot).toMatchObject({ freshness: expected, alerts: [] });
  });
});

describe("directional i3 regression guards", () => {
  it("keeps a proxy Warning response stale even with a current header", async () => {
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources: [sources[0]],
        getSourceAgencyScope: () => Effect.succeed(identityScope),
        fetch: async () =>
          Response.json(
            { header: { timestamp: now / 1000 }, alerts: [] },
            { headers: { Warning: '110 - "Response is stale"' } },
          ),
      }),
    );
    expect(snapshot.freshness).toBe("stale");
  });
  it("uses route-specific direction IDs and preserves each direction's overlapping period", async () => {
    const original = contract[0]!.input;
    const base = original.alerts![0]!;
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        timeZone: "UTC",
        now: () => now,
        sources: [sources[0]],
        getSourceAgencyScope: () =>
          Effect.succeed({
            ...identityScope,
            directionsByRoute: new Map([
              ["route-a|south", 0],
              ["route-a|north", 1],
            ]),
          }),
        fetch: async () =>
          Response.json({
            ...original,
            alerts: [
              { ...base, active_periods: { start: 1700000000, end: 1700000250 } },
              {
                ...base,
                informed_entities: [
                  { route_short_name: "A" },
                  { stop_code: "123" },
                  { direction_id: "North" },
                ],
                active_periods: { start: 1700000100, end: 1700000300 },
              },
            ],
          }),
      }),
    );
    expect(
      snapshot.alerts.map((a) => ({
        direction: a.targets?.[0]?.directionId,
        start: a.startsAt,
        end: a.endsAt,
      })),
    ).toEqual([
      { direction: 0, start: 1700000000000, end: 1700000250000 },
      { direction: 1, start: 1700000100000, end: 1700000300000 },
    ]);
  });
});
