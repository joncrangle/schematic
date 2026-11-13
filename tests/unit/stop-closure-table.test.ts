import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { decodeStopClosureTable } from "~/infrastructure/realtime/stopClosureTableParser";
import type { GenericAlert } from "~/infrastructure/realtime/gtfsRealtimeDecoder";
type Case = {
  name: string;
  html: string;
  routeNames?: Record<string, string[]>;
  notices?: Omit<GenericAlert, "updatedAt">[];
  error?: boolean;
};
const contract: { cases: Case[] } = JSON.parse(
  readFileSync(new URL("../fixtures/stop-closure-table/contract.json", import.meta.url), "utf8"),
);
describe("stop closure table", () => {
  it.each(contract.cases.filter((entry) => !entry.error))("$name", (entry) => {
    expect(
      decodeStopClosureTable(
        entry.html,
        "https://example.test/status",
        1234,
        "America/Regina",
        entry.routeNames,
      ).alerts,
    ).toEqual(entry.notices!.map((notice) => ({ ...notice, updatedAt: 1234 })));
  });
  it.each(contract.cases.filter((entry) => entry.error))("$name", (entry) => {
    expect(() =>
      decodeStopClosureTable(
        entry.html,
        "https://example.test/status",
        1234,
        "America/Regina",
        entry.routeNames,
      ),
    ).toThrow();
  });
});

it.each(["web", "json"] as const)(
  "resolves explicit public codes through pinned identities for %s notices",
  async (type) => {
    const Effect = await import("effect/Effect");
    const { fetchAgencyAlerts } = await import("~/infrastructure/realtime/fetchAgencyAlerts");
    const html = contract.cases[0].html;
    const wire = [
      {
        id: "closure",
        title: "Stop 42 closed",
        start_time: "2027-01-10T06:00:00Z",
        stops: ["Stop 42"],
        targets: [{ routeId: "R7", stopId: "Stop 42", stopCode: "42" }],
        stopScoped: true,
        effect: "NO_SERVICE",
      },
    ];
    const snapshot = await Effect.runPromise(
      fetchAgencyAlerts({
        agencyId: "sample",
        now: () => Date.parse("2027-01-11T12:00:00Z"),
        timeZone: "America/Regina",
        sources:
          type === "web"
            ? [
                {
                  type,
                  parser: "stop-closure-table",
                  url: "https://sample.test/closures",
                  routeNames: { R7: ["7"] },
                },
              ]
            : [{ type, parser: "generic-alert-feed", url: "https://sample.test/proxy.json" }],
        fetch: (async () =>
          type === "web" ? new Response(html) : Response.json(wire)) as typeof fetch,
        getSourceAgencyScope: () =>
          Effect.succeed({
            routeIds: new Set(["R7"]),
            stopIds: new Set(["PLATFORM"]),
            stopsByCode: new Map([["42", ["PLATFORM"]]]),
          }),
        stationIndex: [
          {
            id: "hub",
            schematicId: "hub",
            name: "Hub",
            lat: 52,
            lon: -113,
            lines: ["R7"],
            platformIds: ["PLATFORM"],
          },
        ],
      }),
    );
    expect(snapshot.alerts).toEqual([
      expect.objectContaining({
        scope: "station",
        severity: "severe",
        affectedStations: [{ stationId: "hub", stationName: "Hub" }],
      }),
    ]);
  },
);

it("keeps ambiguous public codes readable without picking a platform", async () => {
  const Effect = await import("effect/Effect");
  const { fetchAgencyAlerts } = await import("~/infrastructure/realtime/fetchAgencyAlerts");
  const snapshot = await Effect.runPromise(
    fetchAgencyAlerts({
      agencyId: "sample",
      now: () => Date.parse("2027-01-11T12:00:00Z"),
      timeZone: "America/Regina",
      sources: [
        {
          type: "web",
          parser: "stop-closure-table",
          url: "https://sample.test/ambiguous",
          routeNames: { R7: ["7"] },
        },
      ],
      fetch: (async () => new Response(contract.cases[0].html)) as typeof fetch,
      getSourceAgencyScope: () =>
        Effect.succeed({
          routeIds: new Set(["R7"]),
          stopIds: new Set(["A", "B"]),
          stopsByCode: new Map([["42", ["A", "B"]]]),
        }),
    }),
  );
  expect(snapshot.alerts[0]).toMatchObject({
    scope: "station",
    affectedStations: [{ stationName: "Stop 42" }],
  });
});
