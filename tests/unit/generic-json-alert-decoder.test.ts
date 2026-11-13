import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { decodeGenericJsonAlertFeed } from "~/infrastructure/realtime/genericJsonAlertDecoder";
import { interpretSnapshot } from "~/domain/interpretSnapshot";
import { deriveMapProjection, buildMapModel } from "~/core/map";
import shapeContract from "../fixtures/generic-json/contract.json";
import { makeStationSchematic } from "../helpers/agency-fixtures";

const sampleSchematic = makeStationSchematic(
  ["Outer West", "North", "Middle", "South", "Outer East"],
  "5",
);

describe("generic JSON alert decoder", () => {
  it.each([
    {
      name: "the last second before spring forward",
      timestamp: "2024-03-10T01:59:59Z",
      expected: Date.parse("2024-03-10T06:59:59Z"),
    },
    {
      name: "the first second after spring forward",
      timestamp: "2024-03-10T03:00:00Z",
      expected: Date.parse("2024-03-10T07:00:00Z"),
    },
    {
      name: "a wall clock in the spring-forward gap",
      timestamp: "2024-03-10T02:30:00Z",
      expected: Date.parse("2026-10-16T12:00:00Z"),
    },
    {
      name: "the ambiguous fall-back hour resolves to its earlier occurrence",
      timestamp: "2024-11-03T01:30:00Z",
      expected: Date.parse("2024-11-03T05:30:00Z"),
    },
    {
      name: "the last second before the fall-back transition",
      timestamp: "2024-11-03T01:59:59Z",
      expected: Date.parse("2024-11-03T05:59:59Z"),
    },
    {
      name: "the first second after the fall-back transition",
      timestamp: "2024-11-03T02:00:00Z",
      expected: Date.parse("2024-11-03T07:00:00Z"),
    },
    {
      name: "fractional seconds retain millisecond precision",
      timestamp: "2024-01-15T12:34:56.789123Z",
      expected: Date.parse("2024-01-15T17:34:56.789Z"),
    },
    {
      name: "an invalid time zone falls back to the suffixed UTC timestamp",
      timestamp: "2024-01-15T12:34:56.789Z",
      timeZone: "Not/A_Real_Zone",
      expected: Date.parse("2024-01-15T12:34:56.789Z"),
    },
  ])("parses agency-local timestamps for $name", async ({ timestamp, timeZone, expected }) => {
    const now = Date.parse("2026-10-16T12:00:00Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        [{ id: "dst-case", title: "DST case", activePeriod: { start: timestamp } }],
        now,
        { timestampMode: "agency-local-wall-clock", timeZone: timeZone ?? "America/Toronto" },
      ),
    );

    expect(feed.alerts[0]?.startsAt).toBe(expected);
  });

  it("flattens advisory buckets while preserving periods, routes, stops, and labelled evidence", async () => {
    const now = Date.parse("2026-10-14T16:00:00Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        shapeContract.find((entry) => entry.name === "bucketed advisories")!.payload,
        now,
      ),
    );
    expect(feed.alerts).toEqual([
      expect.objectContaining({
        id: "17",
        title: "Bridge & detour",
        description:
          "Closed to through traffic.\nUse the alternate stop.\n\nClosed stops: Closed stop (101).\n\nAlternate stops: Alternate stop (102).",
        routeIds: ["R7", "8"],
        affectedStations: ["Closed stop"],
        targets: [{ stopId: "S1" }],
        category: "detour",
        sourceFields: { category: "detour", severity: "warning", reason: "construction" },
        startsAt: Date.parse("2026-10-14T13:00:00Z"),
        endsAt: Date.parse("2026-10-15T03:59:00Z"),
      }),
      expect.objectContaining({
        id: "18",
        startsAt: Date.parse("2026-10-12T12:00:00Z"),
        endsAt: undefined,
      }),
    ]);
  });

  it("keeps unordered closed stops as points and replacements as boarding guidance", async () => {
    const now = Date.parse("2026-10-14T16:00:00Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        {
          alerts: {
            short_term: [
              {
                id: "closure",
                title: "Stop closure",
                category: "stop_closure",
                routes: ["R1"],
                closed_stops: [
                  { id: "feed-north", name: "North" },
                  { id: "feed-south", name: "South" },
                ],
                alternate_stops: [{ id: "feed-middle", name: "Middle" }],
              },
            ],
            long_term: [],
          },
        },
        now,
      ),
    );
    const snapshot = interpretSnapshot(feed, {
      agencyId: "sample",
      now,
      stationIndex: sampleSchematic.stationIndex,
      schematic: sampleSchematic,
      interpretation: {
        rules: [
          {
            match: { sourceField: "category", sourceValue: "stop_closure" },
            result: { kind: "information", severity: "degraded" },
          },
        ],
      },
    });
    expect(snapshot.alerts[0]).toMatchObject({
      scope: "station",
      kind: "information",
      severity: "degraded",
      affectedStations: [
        { stationId: "north", stationName: "North" },
        { stationId: "south", stationName: "South" },
      ],
      fromStation: undefined,
      toStation: undefined,
      description: "Closed stops: North; South.\n\nAlternate stops: Middle.",
    });
  });

  it.each(shapeContract)(
    "matches the shared JSON contract: $name",
    async ({ payload, valid, expected }) => {
      const outcome = await Effect.runPromise(
        decodeGenericJsonAlertFeed(payload, 1791993600000),
      ).then(
        (value) => ({ ok: true as const, value: JSON.parse(JSON.stringify(value)), error: "" }),
        (error) => ({ ok: false as const, value: null, error: String(error) }),
      );
      expect({
        ok: outcome.ok,
        value: outcome.ok ? outcome.value : null,
        invalidFeedError: !outcome.ok && outcome.error.includes("Invalid JSON alert feed"),
      }).toEqual({
        ok: valid,
        value: valid ? expected : null,
        invalidFeedError: !valid,
      });
    },
  );

  it("keeps published news active with structured route scope and plain-text summaries", async () => {
    const summary = "<p>Until construction is complete.</p>";
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed([
        {
          newsId: 42,
          title: "Bridge detour",
          summary,
          routes: ["R1", "R2"],
          publishDateUtc: "2026-04-29T12:00:00Z",
        },
        {
          newsId: 43,
          title: "Network notice",
          summary,
          routes: null,
          affectsAllRoutes: true,
          publishDateUtc: "2026-04-29T12:00:00Z",
        },
      ]),
    );
    expect(feed.alerts).toEqual([
      expect.objectContaining({
        id: "42",
        description: "Until construction is complete.",
        routeIds: ["R1", "R2"],
        startsAt: Date.parse("2026-04-29T12:00:00Z"),
        endsAt: undefined,
      }),
      expect.objectContaining({ id: "43", routeIds: undefined, endsAt: undefined }),
    ]);
  });

  it("normalizes route and accessibility advisories into Core alerts", async () => {
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        {
          routes: [
            {
              id: "slow-1",
              route: "Line 1",
              headerText: "Reduced speed",
              description: "Proceed with caution",
              stopStart: "dundas",
              stopEnd: "union",
              effectDesc: "Reduced speed zone",
            },
          ],
          accessibility: [
            {
              id: "elevator-1",
              title: "Elevator outage",
              accessibility: "elevator",
              route: "1,2,19,97,300,320",
            },
          ],
        },
        1_700_000_000_000,
      ),
    );

    expect(feed.alerts).toEqual([
      expect.objectContaining({
        id: "slow-1",
        title: "Reduced speed",
        lineId: undefined,
        routeIds: ["Line 1"],
        sourceFields: { effectDescription: "Reduced speed zone" },
        fromStationId: "dundas",
        toStationId: "union",
        equipmentOutages: undefined,
        startsAt: 1_700_000_000_000,
      }),
      expect.objectContaining({
        id: "elevator-1",
        title: "Elevator outage",
        routeIds: undefined,
        lineId: undefined,
        category: "elevator",
        equipmentOutages: undefined,
      }),
    ]);
  });

  it("keeps the richer spatial attribution when GTFS-RT and JSON copies share an id", async () => {
    const now = Date.parse("2026-08-30T12:15:25.837Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        {
          total: 36,
          lastUpdated: "2026-08-30T12:15:25.837Z",
          routes: [
            {
              id: "75064",
              route: "5",
              stopStart: "North",
              stopEnd: "South",
              stops: ["16777", "16778", "16779"],
              stopIDList: ["South", "Middle", "North"],
              title:
                "No service between North and South stations due to an investigation at Middle.",
              description: "",
              effect: "NO_SERVICE",
              effectDesc: "No Service",
              headerText:
                "Line 5 Rapid: No service between North and South stations due to an investigation at Middle.",
            },
          ],
        },
        now,
      ),
    );

    const gtfsCopy = {
      ...feed.alerts[0]!,
      id: "gtfs-75064",
      title: "No service between North and South stations due to an investigation at Middle.",
      description: "Service disruption reported by GTFS-RT",
      category: undefined,
      cause: "ACCIDENT",
      fromStationId: "feed-north",
      toStationId: "feed-south",
      affectedStations: [
        "feed-north",
        "platform-north",
        "feed-middle",
        "platform-middle",
        "platform-south",
        "feed-south",
      ],
    };
    const interpretedSnapshot = interpretSnapshot(
      { ...feed, alerts: [gtfsCopy, ...feed.alerts] },
      {
        agencyId: "sample",
        now,
        lineIds: ["5"],
        stationIndex: sampleSchematic.stationIndex,
        schematic: sampleSchematic,
        interpretation: { stripLinePrefixFromTitle: true },
      },
    );
    expect(interpretedSnapshot.alerts).toHaveLength(1);
    expect(interpretedSnapshot.alerts[0]).toMatchObject({
      fromStation: { stationId: "north", stationName: "North" },
      toStation: { stationId: "south", stationName: "South" },
    });

    // The production runtime passes this interpreted snapshot directly into
    // Core Map, where station IDs select topology and names remain labels.
    const projection = deriveMapProjection(interpretedSnapshot, buildMapModel(sampleSchematic));
    const segment = projection.statusOverlaySegments[0];
    const linePath = buildMapModel(sampleSchematic).linesById.get("5")?.pathD;

    expect(projection.statusOverlaySegments).toHaveLength(1);
    expect(segment).toMatchObject({ fromStation: "North", toStation: "South" });
    expect(segment?.pathD).not.toBe(linePath);
    expect(Object.fromEntries(projection.stationSeverities)).toEqual({
      north: "severe",
      middle: "severe",
      south: "severe",
    });
  });

  it("treats whitespace-only optional upstream strings as absent", async () => {
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed({
        routes: [
          {
            id: "   ",
            route: "   ",
            effect: "   ",
            effectDesc: "   ",
            accessibility: "   ",
          },
        ],
      }),
    );

    expect(feed.alerts).toEqual([
      expect.objectContaining({
        id: expect.stringMatching(/^json-alert-[0-9a-f]{16}$/u),
        lineId: undefined,
        routeIds: undefined,
        category: undefined,
        effect: undefined,
      }),
    ]);
  });

  it("retains an expired end when the start was inferred", async () => {
    const now = Date.parse("2026-10-15T12:00:00Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        [{ title: "Expired advisory", expires_at: "2020-01-01T00:00:00Z" }],
        now,
      ),
    );

    expect(feed.alerts[0]).toMatchObject({
      startsAt: Date.parse("2020-01-01T00:00:00Z"),
      endsAt: Date.parse("2020-01-01T00:00:00Z"),
    });
    const snapshot = interpretSnapshot(feed, { agencyId: "sample", now });
    expect(snapshot.alerts[0]?.lifecycle).toBe("expired");
  });

  it("keeps an expired end when the only inferred start is newer", async () => {
    const end = Date.parse("2020-01-01T00:00:00Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed(
        [
          {
            title: "Expired advisory",
            posted_at: "2026-10-14T12:00:00Z",
            expires_at: "2020-01-01T00:00:00Z",
          },
        ],
        Date.parse("2026-10-15T12:00:00Z"),
      ),
    );

    expect(feed.alerts[0]).toMatchObject({ startsAt: end, endsAt: end });
  });

  it("builds stable fallback ids from source scope and alert content", async () => {
    const payload = [{ title: "Bridge closure", routes: ["R7"] }];
    const decode = (sourceScope: string, now: number) =>
      Effect.runPromise(decodeGenericJsonAlertFeed(payload, now, { sourceScope }));

    const first = (await decode("https://sample.test/alerts-a", 1_700_000_000_000)).alerts[0];
    const sameSource = (await decode("https://sample.test/alerts-a", 1_800_000_000_000)).alerts[0];
    const otherSource = (await decode("https://sample.test/alerts-b", 1_700_000_000_000)).alerts[0];

    expect(first?.id).toMatch(/^json-alert-[0-9a-f]{16}$/u);
    expect(sameSource?.id).toBe(first?.id);
    expect(otherSource?.id).not.toBe(first?.id);
  });

  it("parses activePeriod into non-negative startsAt and endsAt", async () => {
    const startMs = Date.parse("2026-09-03T10:00:00Z");
    const endMs = Date.parse("2026-09-03T18:00:00Z");
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed({
        routes: [
          {
            id: "scheduled-1",
            activePeriod: {
              start: "2026-09-03T10:00:00Z",
              end: "2026-09-03T18:00:00Z",
            },
          },
          {
            id: "sentinel-end",
            activePeriod: {
              start: "2026-09-03T10:00:00Z",
              end: "0001-01-01T00:00:00Z",
            },
          },
        ],
      }),
    );

    expect(feed.alerts[0]).toMatchObject({
      startsAt: startMs,
      endsAt: endMs,
    });
    expect(feed.alerts[1]).toMatchObject({
      startsAt: startMs,
      endsAt: undefined,
    });
  });

  it("preserves slow-service classification through interpretation when activePeriod is present", async () => {
    const feed = await Effect.runPromise(
      decodeGenericJsonAlertFeed({
        routes: [
          {
            id: "rsz-1",
            route: "1",
            title: "Subway trains will move slower than usual from Union to King",
            effectDesc: "Reduced Speed Zone",
            effect: "SIGNIFICANT_DELAYS",
            activePeriod: {
              start: "2026-08-10T11:00:00Z",
              end: "0001-01-01T00:00:00Z",
            },
          },
        ],
      }),
    );

    const snapshot = interpretSnapshot(feed, {
      agencyId: "sample",
      now: Date.now(),
      lineIds: ["1"],
      rules: [
        {
          priority: 100,
          match: { sourceField: "effectDescription", sourceValue: "Reduced Speed Zone" },
          result: { kind: "slow-service", severity: "degraded" },
        },
      ],
    });

    expect(snapshot.alerts[0]).toMatchObject({
      id: "rsz-1",
      kind: "slow-service",
      severity: "degraded",
    });
  });
});
