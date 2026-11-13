import { describe, expect, it } from "vitest";
import {
  makeTestNetwork,
  makeTestProvider,
  makeStationSchematic,
  makeTestSchematic,
} from "../helpers/agency-fixtures";
import {
  areMapProjectionsEqual,
  buildMapModel,
  deriveMapProjection,
  distancePointToPolyline,
  normalizeInterchangeBadgeRequests,
  placeInterchangeBadges,
  placeWalkingInterchangeMarkers,
  type MapProjection,
} from "~/core/map";
import { buildSmoothPathD } from "~/domain/map/MapGeometry";
import type { AgencyAlert, AgencySnapshot } from "~/agencies/types";
import { createTopologyCache } from "~/services/schematic/TopologyCache";

import { projectInterchangeBadgeAgencies } from "~/core/map/interchange-agencies";
import {
  formatSegmentTooltip,
  formatStationAriaLabel,
  formatStationTooltip,
} from "~/components/map/tooltips";
import type { StatusSegmentKind } from "~/core/map";
import { decodeInterchangeDataset } from "~/domain/map/Interchange";
import { fr } from "~/i18n/fr";
import { translateFromDictionary } from "~/i18n/translate";

const frenchText = (
  key: Parameters<typeof translateFromDictionary>[0],
  params?: Readonly<Record<string, string | number>>,
) => translateFromDictionary(key, fr, params);

const provider = makeTestProvider(
  { id: "sample", name: "Sample Transit", modes: ["subway"] },
  makeTestNetwork(),
);
const rail = makeTestProvider(
  {
    id: "regional",
    name: "Regional Transit",
    shortName: "R",
    modes: ["rail"],
    stationService: { routeType: "rail" },
  },
  makeTestNetwork(),
);
const metro = makeTestProvider(
  { id: "metro", name: "Metro Transit", modes: ["bus"], stationService: { routeType: "bus" } },
  makeTestNetwork(),
);
const busProvider = makeTestProvider(
  { id: "local" },
  makeStationSchematic(["Bus Terminal", "Market"], "2"),
);
const allProviders = () => [provider, rail, metro, busProvider];
const getAgencyById = (id: string) => allProviders().find((p) => p.manifest.id === id);
const agencies = projectInterchangeBadgeAgencies(allProviders());
describe("Core Map", () => {
  it("does not invent affected endpoints for a route-wide advisory", () => {
    const topology = buildMapModel(makeStationSchematic(["North", "Centre", "South"], "R"));
    const projection = deriveMapProjection({ alerts: [{id: "detour", title: "Route detour", kind: "delay", severity: "degraded", lifecycle: "active", scope: "route", affectedLineIds: ["R"], startsAt: 0, updatedAt: 0}] }, topology);
    expect(projection.statusOverlaySegments[0]).toMatchObject({fromStation: "Line R", toStation: "Line R"});
  });
  it.each(["full", "compact", "hidden"] as const)(
    "keeps the walking station visible with a separate %s agency badge",
    (visibility) => {
      const hubs = decodeInterchangeDataset([
        {
          id: "sample-regional-hub",
          endpoints: [
            { agencyId: "sample", stationId: "hub", stationName: "Hub" },
            {
              agencyId: "regional",
              stationId: "north",
              stationName: "North",
              walkingMarkers: { sample: { dx: -120, dy: 80, label: "Regional North" } },
            },
          ],
          badgeOffsets: { sample: { dx: 0, dy: -24 } },
        },
      ]);
      const model = buildMapModel(provider.schematic!);
      const requests = normalizeInterchangeBadgeRequests("sample", hubs, agencies);
      const markers = placeWalkingInterchangeMarkers(model, requests);

      expect(markers).toHaveLength(1);
      expect(markers[0]).toMatchObject({
        activeStationId: "hub",
        targetAgencyId: "regional",
        targetStationId: "north",
        label: "Regional North",
        sourceX: 400,
        sourceY: 300,
        x: 280,
        y: 380,
      });
      const badges = placeInterchangeBadges(model, requests, visibility);
      expect(badges.map((badge) => [badge.agencyLabel, badge.targetAgencyId])).toEqual(
        visibility === "hidden" ? [] : [["R", "regional"]],
      );
      expect(model.stationsById.get("north")).toMatchObject({ x: 400, y: 50 });
    },
  );

  it("does not mark a local station for a different route in the same alert", () => {
    const schematic = busProvider.schematic!;
    const projection = deriveMapProjection(
      {
        agencyId: "local",
        generatedAt: 0,
        freshness: "live",
        alerts: [
          {
            id: "kingston-route-scoped-station-alert",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            scope: "station",
            affectedRouteIds: ["2", "7", "N1"],
            affectedStations: [{ stationId: "bus-terminal", stationName: "Bus Terminal" }],
            targets: [
              {
                routeId: "7",
                station: { stationId: "bus-terminal", stationName: "Bus Terminal" },
              },
            ],
            title: "Transit Alert",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
      },
      buildMapModel(schematic),
    );

    expect(projection.stationSeverities.has("bus-terminal")).toBe(false);
  });

  it("projects a target-only local station alert", () => {
    const schematic = busProvider.schematic!;
    const projection = deriveMapProjection(
      {
        agencyId: "local",
        generatedAt: 0,
        freshness: "live",
        alerts: [
          {
            id: "kingston-target-only-station-alert",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            scope: "station",
            affectedRouteIds: ["2"],
            targets: [
              {
                routeId: "2",
                station: { stationId: "bus-terminal", stationName: "Bus Terminal" },
              },
            ],
            title: "Service suspended",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
      },
      buildMapModel(schematic),
    );

    expect(projection.stationSeverities.get("bus-terminal")).toBe("severe");
  });

  it("invalidates same-id alert projections when geometry changes", () => {
    const previous = {
      statusOverlaySegments: [
        {
          id: "line-5-fire",
          kind: "severe" as const,
          lineId: "5",
          lineName: "Line 5 Eglinton",
          lineColor: "#939598",
          fromStation: "Mount Dennis",
          toStation: "Kennedy",
          note: "No service",
          pathD: "M full-line",
          midpoint: { x: 1, y: 2 },
        },
      ],
      stationSeverities: new Map<string, "normal" | "degraded" | "severe">(),
      stationAccessibilityOutages: new Set<string>(),
    } satisfies MapProjection;

    expect(
      areMapProjectionsEqual(previous, {
        ...previous,
        statusOverlaySegments: [{ ...previous.statusOverlaySegments[0]!, pathD: "M bounded" }],
      }),
    ).toBe(false);
  });

  it("places normalized interchange requests at the active station anchor", () => {
    const model = buildMapModel(provider.schematic!);
    const badges = placeInterchangeBadges(
      model,
      [
        {
          hubId: "sample-go-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "regional",
          targetAgencyName: "Regional Transit",
          targetStationId: "hub",
          targetStationName: "Hub",
          agencyLabel: "R",
          color: "#00a651",
          offset: { dx: 8, dy: -30 },
        },
      ],
      "full",
    );

    expect(badges[0]).toMatchObject({
      targetAgencyId: "regional",
      agencyLabel: "R",
      x: 408,
      y: 270,
    });
  });

  it("retains topology identity and warming order in the app-shell cache", () => {
    const cache = createTopologyCache({ allProviders, maxEntries: 3 });
    const go = getAgencyById("regional")!;
    const model = cache.topologyFor(go);

    expect(cache.topologyFor(go)).toBe(model);
    expect(cache.warmProviderIds("sample", ["metro"])).toEqual(["sample", "metro", "regional"]);
  });

  it("evicts the least recently used model while retaining the cache key contract", () => {
    const cache = createTopologyCache({ allProviders, maxEntries: 2 });
    const sample = getAgencyById("sample")!;
    const go = getAgencyById("regional")!;
    const metro = getAgencyById("metro")!;
    const firstGo = cache.topologyFor(go);
    const firstTtc = cache.topologyFor(sample);

    expect(cache.topologyFor(sample)).toBe(firstTtc);
    cache.topologyFor(metro);

    expect(cache.topologyFor(go)).not.toBe(firstGo);
  });

  it("normalizes provider branding before Core Map places peer badges", () => {
    const requests = normalizeInterchangeBadgeRequests(
      "sample",
      [
        {
          id: "hub",
          endpoints: [
            { agencyId: "sample", stationId: "hub", stationName: "Hub" },
            {
              agencyId: "regional",
              stationId: "hub",
              stationName: "Hub",
              badgeLabel: "Regional Rail",
            },
          ],
          badgeOffsets: {
            sample: { dx: 0, dy: -24 },
            regional: { dx: 0, dy: -24 },
          },
        },
      ],
      agencies,
    );

    expect(requests[0]).toMatchObject({
      targetAgencyId: "regional",
      targetAgencyName: "Regional Transit",
      agencyLabel: "Regional Rail",
      mode: "rail",
    });
  });

  it("maps subway interchange targets to the rail badge glyph", () => {
    const requests = normalizeInterchangeBadgeRequests(
      "regional",
      [
        {
          id: "go-sample-hub",
          endpoints: [
            { agencyId: "regional", stationId: "hub", stationName: "Hub" },
            { agencyId: "sample", stationId: "hub", stationName: "Hub" },
          ],
          badgeOffsets: {
            regional: { dx: 0, dy: -24 },
            sample: { dx: 0, dy: -24 },
          },
        },
      ],
      agencies,
    );

    expect(requests[0]).toMatchObject({ targetAgencyId: "sample", mode: "rail" });
  });

  it("applies agency-specific interchange offsets to the active map", () => {
    const model = buildMapModel(provider.schematic!);
    const badges = placeInterchangeBadges(
      model,
      normalizeInterchangeBadgeRequests(
        "sample",
        [
          {
            id: "sample-go-hub",
            endpoints: [
              { agencyId: "sample", stationId: "hub", stationName: "Hub" },
              { agencyId: "regional", stationId: "hub", stationName: "Hub" },
            ],
            badgeOffsets: {
              sample: { dx: 10, dy: -20 },
              regional: { dx: -50, dy: 30 },
            },
          },
        ],
        agencies,
      ),
      "full",
    );

    expect(badges[0]).toMatchObject({
      x: 410,
      y: 280,
    });
  });

  it("returns no positioned badges for empty or hidden requests", () => {
    const model = buildMapModel(provider.schematic!);
    const request = {
      hubId: "mini-hub",
      activeStationId: "alpha",
      activeStationName: "Alpha",
      targetAgencyId: "peer",
      targetAgencyName: "Peer Transit",
      targetStationId: "peer-alpha",
      targetStationName: "Peer Alpha",
      agencyLabel: "PEER",
      color: "#123456",
      offset: { dx: 0, dy: 0 },
    };

    expect(placeInterchangeBadges(model, [], "full")).toEqual([]);
    expect(placeInterchangeBadges(model, [request], "hidden")).toEqual([]);
  });

  it("centers a single badge at the offset station anchor", () => {
    const model = buildMapModel(provider.schematic!);
    const [badge] = placeInterchangeBadges(
      model,
      [
        {
          hubId: "mini-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "peer",
          targetAgencyName: "Peer Transit",
          targetStationId: "peer-alpha",
          targetStationName: "Peer Alpha",
          agencyLabel: "PEER",
          color: "#123456",
          offset: { dx: 12, dy: -8 },
        },
      ],
      "full",
    );

    expect(badge).toMatchObject({
      x: 412,
      y: 292,
      width: 50,
      height: 18,
      rectY: -9,
      cornerRadius: 9,
      transformOrigin: "25px 0px",
      rowTotalWidth: 50,
      xOffsetFromCenter: -25,
      textX: 25,
      hasIcon: false,
      isCompact: false,
    });
  });

  it("uses the existing gap and centered offsets for every badge in a row", () => {
    const model = buildMapModel(provider.schematic!);
    const badges = placeInterchangeBadges(
      model,
      [
        {
          hubId: "mini-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "peer-a",
          targetAgencyName: "Peer A",
          targetStationId: "peer-a-alpha",
          targetStationName: "Peer Alpha",
          agencyLabel: "A",
          color: "#123456",
          offset: { dx: 12, dy: -8 },
        },
        {
          hubId: "mini-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "peer-b",
          targetAgencyName: "Peer B",
          targetStationId: "peer-b-alpha",
          targetStationName: "Peer Alpha",
          agencyLabel: "BBBB",
          color: "#654321",
          offset: { dx: 12, dy: -8 },
        },
      ],
      "full",
    );

    expect(
      badges.map(
        ({ width, rectY, cornerRadius, transformOrigin, xOffsetFromCenter, rowTotalWidth }) => ({
          width,
          rectY,
          cornerRadius,
          transformOrigin,
          xOffsetFromCenter,
          rowTotalWidth,
        }),
      ),
    ).toEqual([
      {
        width: 42,
        rectY: -9,
        cornerRadius: 9,
        transformOrigin: "21px 0px",
        xOffsetFromCenter: -48,
        rowTotalWidth: 96,
      },
      {
        width: 50,
        rectY: -9,
        cornerRadius: 9,
        transformOrigin: "25px 0px",
        xOffsetFromCenter: -2,
        rowTotalWidth: 96,
      },
    ]);
    expect(badges.every((badge) => badge.x === 412 && badge.y === 292)).toBe(true);
  });

  it("stacks badges vertically when layout is set to vertical", () => {
    const model = buildMapModel(provider.schematic!);
    const badges = placeInterchangeBadges(
      model,
      [
        {
          hubId: "mini-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "peer-a",
          targetAgencyName: "Peer A",
          targetStationId: "peer-a-alpha",
          targetStationName: "Peer Alpha",
          agencyLabel: "A",
          color: "#123456",
          offset: { dx: 12, dy: -8, layout: "vertical" },
        },
        {
          hubId: "mini-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "peer-b",
          targetAgencyName: "Peer B",
          targetStationId: "peer-b-alpha",
          targetStationName: "Peer Alpha",
          agencyLabel: "BBBB",
          color: "#654321",
          offset: { dx: 12, dy: -8, layout: "vertical" },
        },
      ],
      "full",
    );

    expect(
      badges.map(
        ({
          width,
          height,
          rectY,
          xOffsetFromCenter,
          yOffsetFromCenter,
          rowTotalWidth,
          rowTotalHeight,
        }) => ({
          width,
          height,
          rectY,
          xOffsetFromCenter,
          yOffsetFromCenter,
          rowTotalWidth,
          rowTotalHeight,
        }),
      ),
    ).toEqual([
      {
        width: 42,
        height: 18,
        rectY: -9,
        xOffsetFromCenter: -21,
        yOffsetFromCenter: -11,
        rowTotalWidth: 50,
        rowTotalHeight: 40,
      },
      {
        width: 50,
        height: 18,
        rectY: -9,
        xOffsetFromCenter: -25,
        yOffsetFromCenter: 11,
        rowTotalWidth: 50,
        rowTotalHeight: 40,
      },
    ]);
  });

  it.each([
    { visibility: "full" as const, height: 18, hasIcon: true, textX: 19, isCompact: false },
    { visibility: "compact" as const, height: 14, hasIcon: false, textX: 20, isCompact: true },
  ])("preserves $visibility dimensions and presentation facts", (expected) => {
    const model = buildMapModel(provider.schematic!);
    const [badge] = placeInterchangeBadges(
      model,
      [
        {
          hubId: "mini-hub",
          activeStationId: "hub",
          activeStationName: "Hub",
          targetAgencyId: "peer",
          targetAgencyName: "Peer Transit",
          targetStationId: "peer-alpha",
          targetStationName: "Peer Alpha",
          agencyLabel: "PEER",
          mode: "bus",
          color: "#123456",
          offset: { dx: 0, dy: 0 },
        },
      ],
      expected.visibility,
    );

    const { visibility: _visibility, ...presentation } = expected;
    expect(badge).toMatchObject(presentation);
    expect(badge).toMatchObject(
      expected.visibility === "compact"
        ? { rectY: -7, cornerRadius: 7, transformOrigin: "20px 0px" }
        : { rectY: -9, cornerRadius: 9, transformOrigin: "35px 0px" },
    );
  });

  it("does not normalize an excluded peer pair into a badge request", () => {
    const requests = normalizeInterchangeBadgeRequests(
      "regional",
      [
        {
          id: "go-sample-metro-north",
          endpoints: [
            { agencyId: "regional", stationId: "north", stationName: "North" },
            { agencyId: "sample", stationId: "north", stationName: "North" },
            { agencyId: "metro", stationId: "north", stationName: "North" },
          ],
          badgeOffsets: { regional: { dx: 0, dy: -24 } },
          excludedPairs: [
            {
              left: { agencyId: "regional", stationId: "north", stationName: "North" },
              right: { agencyId: "sample", stationId: "north", stationName: "North" },
            },
          ],
        },
      ],
      agencies,
    );

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({ targetAgencyId: "metro" });
  });

  it("does not create a badge for a target endpoint absent from its schematic", () => {
    const requests = normalizeInterchangeBadgeRequests(
      "sample",
      [
        {
          id: "sample-go-yorkdale",
          endpoints: [
            { agencyId: "sample", stationId: "yorkdale", stationName: "Yorkdale" },
            { agencyId: "regional", stationName: "Yorkdale" },
          ],
          badgeOffsets: { sample: { dx: -42, dy: 0 } },
        },
      ],
      agencies,
    );

    expect(requests).toEqual([]);
  });

  it("keeps camera conversion reversible through the Core Map camera port", () => {
    const model = buildMapModel(provider.schematic!);
    const camera = { ...model.initialCamera, width: 900, height: 600 };
    const mapPoint = { x: 1350, y: 1100 };
    const containerPoint = model.camera.transformMapPointToContainer(mapPoint, camera);

    expect(containerPoint).toBeDefined();
    const roundTrip = model.camera.transformContainerPointToMap(containerPoint!, camera);
    expect(roundTrip!.x).toBeCloseTo(mapPoint.x, 6);
    expect(roundTrip!.y).toBeCloseTo(mapPoint.y, 6);
  });

  it("returns null for zero-sized camera framing", () => {
    const model = buildMapModel(provider.schematic!);
    const bounds = model.geometry.computeRouteBoundingBox([]);

    expect(model.camera.computeFitTransform(0, 0)).toBeNull();
    expect(model.camera.computeTargetViewport(bounds, { width: 0, height: 0 })).toBeNull();
  });
});

describe("buildSmoothPathD (engine)", () => {
  it("returns an empty path when there are fewer than two points", () => {
    expect(buildSmoothPathD([])).toBe("");
    expect(buildSmoothPathD([{ x: 1, y: 2 }])).toBe("");
  });

  it("keeps collinear interior vertices as straight segments", () => {
    const d = buildSmoothPathD([
      { x: 0, y: 0 },
      { x: 50, y: 0 },
      { x: 100, y: 0 },
    ]);
    expect(d).toBe("M 0,0 L 50,0 L 100,0");
  });

  it("clamps the corner radius to half the shorter adjacent segment", () => {
    const d = buildSmoothPathD([
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 1 },
    ]);
    expect(d).toBe("M 0,0 L 99.5,0 Q 100,0 100,0.5 L 100,1");
  });

  it("passes through zero-length neighbours without curving", () => {
    const d = buildSmoothPathD([
      { x: 0, y: 0 },
      { x: 0, y: 0 },
      { x: 10, y: 0 },
    ]);
    expect(d).toBe("M 0,0 L 0,0 L 10,0");
  });
});

const sampleSchematic = provider.schematic!;
const sampleTopology = buildMapModel(sampleSchematic);
const stations = Object.fromEntries(
  sampleSchematic.stations.map((station) => [station.name, { x: station.x, y: station.y }]),
);
const stationIdFor = (name: string) =>
  sampleSchematic.stations.find((station) => station.name === name)!.id;
const [line1Corner] = sampleSchematic.cornerInsertions ?? [];
const UNION_WEST_CORNER = line1Corner?.before ?? { x: 350, y: 300 };
const UNION_EAST_CORNER = line1Corner?.after ?? { x: 450, y: 300 };

const snapshotWithAlert = (
  alert: Pick<AgencyAlert, "affectedLineIds" | "fromStation" | "toStation"> &
    Partial<Pick<AgencyAlert, "id" | "title">>,
): AgencySnapshot => {
  const base: AgencyAlert = {
    id: alert.id ?? "parity-alert",
    kind: "suspension",
    severity: "severe",
    lifecycle: "active",
    scope: "segment",
    title: alert.title ?? "No service",
    startsAt: 0,
    updatedAt: 0,
    affectedLineIds: alert.affectedLineIds,
    fromStation: alert.fromStation,
    toStation: alert.toStation,
  };
  return {
    agencyId: "sample",
    generatedAt: 0,
    freshness: "live",
    alerts: [base],
  };
};

const parsePathPoints = (pathD: string) =>
  [...pathD.matchAll(/(?:M|L|Q) (-?[\d.]+),(-?[\d.]+)/g)].map((match) => ({
    x: Number(match[1]),
    y: Number(match[2]),
  }));

const midpointOf = (points: readonly { x: number; y: number }[]) => ({
  x: (points[0]!.x + points[points.length - 1]!.x) / 2,
  y: (points[0]!.y + points[points.length - 1]!.y) / 2,
});

const livePathFor = (lineId: string, from: string, to: string): string | undefined =>
  deriveMapProjection(
    snapshotWithAlert({
      affectedLineIds: [lineId],
      fromStation: { stationId: stationIdFor(from), stationName: from },
      toStation: { stationId: stationIdFor(to), stationName: to },
    }),
    sampleTopology,
  ).statusOverlaySegments.find((segment) => segment.lineId === lineId)?.pathD;

describe("live overlay Hub-loop geometry", () => {
  it("draws a system alert overlay for every affected line", () => {
    const projection = deriveMapProjection(
      snapshotWithAlert({ affectedLineIds: ["1", "2"] }),
      sampleTopology,
    );
    expect(projection.statusOverlaySegments.map((segment) => segment.lineId).sort()).toEqual([
      "1",
      "2",
    ]);
  });
  it("draws a Hub-crossing span west-first through the shared loop corners", () => {
    const livePath = livePathFor("1", "West", "East");
    expect(livePath).toBeDefined();

    const composedFromPublicPieces = buildSmoothPathD([
      stations["West"],
      UNION_WEST_CORNER,
      stations.Hub,
      UNION_EAST_CORNER,
      stations.East,
    ]);
    expect(livePath).toBe(composedFromPublicPieces);
  });

  it("draws a span identically whichever endpoint the alert names first", () => {
    const forward = livePathFor("1", "West", "East");
    const backward = livePathFor("1", "East", "West");
    expect(forward).toBeDefined();
    expect(backward).toBe(forward);
  });

  it("draws a west-endpoint Hub span with its corner before the station", () => {
    const livePath = livePathFor("1", "West", "Hub");
    expect(livePath).toBeDefined();
    expect(livePath).toBe(buildSmoothPathD([stations["West"], UNION_WEST_CORNER, stations.Hub]));
  });

  it("draws an east-endpoint Hub span with its corner after the station", () => {
    const livePath = livePathFor("1", "Hub", "East");
    expect(livePath).toBeDefined();
    expect(livePath).toBe(buildSmoothPathD([stations.Hub, UNION_EAST_CORNER, stations.East]));
  });

  it("draws an endpoint-Hub span identically whichever endpoint the alert names first", () => {
    const forward = livePathFor("1", "West", "Hub");
    const backward = livePathFor("1", "Hub", "West");
    expect(forward).toBeDefined();
    expect(backward).toBe(forward);
  });
});

/** A status span follows an authored bend even without corner insertions. */
describe("live overlay span geometry without declared corners", () => {
  const railSchematic = makeTestSchematic({
    stations: [
      { id: "branch-west", name: "Branch West", x: 10, y: 10, lines: ["R1"] },
      { id: "branch-east", name: "Branch East", x: 40, y: 40, lines: ["R1"] },
      { id: "midway", name: "Midway", x: 60, y: 40, lines: ["R1"] },
      { id: "hub", name: "Hub", x: 90, y: 70, lines: ["R1"] },
    ],
    lines: [
      {
        id: "R1",
        name: "Rail",
        color: "#123456",
        points: [
          { x: 10, y: 10 },
          { x: 10, y: 40 },
          { x: 40, y: 40 },
          { x: 60, y: 40 },
          { x: 60, y: 70 },
          { x: 90, y: 70 },
        ],
      },
    ],
    sequences: { R1: ["branch-west", "branch-east", "midway", "hub"] },
  });
  const railTopology = buildMapModel(railSchematic);
  const railStationIdFor = (name: string) =>
    railSchematic.stations.find((station) => station.name === name)!.id;
  const railSpanPath = (lineId: string, from: string, to: string): string | undefined =>
    deriveMapProjection(
      snapshotWithAlert({
        affectedLineIds: [lineId],
        fromStation: { stationId: railStationIdFor(from), stationName: from },
        toStation: { stationId: railStationIdFor(to), stationName: to },
      }),
      railTopology,
    ).statusOverlaySegments.find((segment) => segment.lineId === lineId)?.pathD;

  it("carries a span through the polyline vertices the straight join cuts across", () => {
    const drawn = railSpanPath("R1", "Branch West", "Branch East");
    const endpoints = [railStationIdFor("Branch West"), railStationIdFor("Branch East")] as const;
    const anchors = endpoints.map((id) => railTopology.anchorFor(id)!);

    // The straight join is a real, wrong answer, so pin that it is not what a
    // span is drawn as.
    expect(drawn).not.toBe(buildSmoothPathD(anchors));

    // Every point the span is drawn through is a point of the line's own drawn
    // geometry. The branch leaves the main corridor, and
    // a chord between the two anchors is nowhere near that diagonal.
    const drawnPoints = parsePathPoints(drawn!);
    const polyline = railSchematic.lines.find((line) => line.id === "R1")!.points;
    for (const point of drawnPoints) {
      expect(distancePointToPolyline(point, polyline)).toBeCloseTo(0, 8);
    }
    expect(distancePointToPolyline(midpointOf(anchors), polyline)).toBeGreaterThan(0);
  });

  it("keeps every station on the span's declared sequence on the drawn path", () => {
    const sequence = railTopology.sequenceFor("R1");
    const from = sequence.indexOf(railStationIdFor("Midway"));
    const to = sequence.indexOf(railStationIdFor("Hub"));
    const points = railTopology.spanFor("R1", sequence.slice(from, to + 1));
    const drawn = buildSmoothPathD(points);
    for (const stationId of sequence.slice(from, to + 1)) {
      const anchor = railTopology.anchorFor(stationId)!;
      expect(distancePointToPolyline(anchor, points)).toBe(0);
      expect(drawn).toContain(`${anchor.x},${anchor.y}`);
    }
  });

  it("draws a span identically whichever endpoint the alert names first", () => {
    expect(railSpanPath("R1", "Branch West", "Branch East")).toBe(
      railSpanPath("R1", "Branch East", "Branch West"),
    );
  });

  describe("formatStationTooltip", () => {
    it.each([
      ["severe", true, "Severe disruption / service suspended"],
      ["severe", false, "Severe disruption / service suspended"],
      ["degraded", true, "Elevator out of service"],
      ["degraded", false, "Delays reported"],
      ["normal", true, "Elevator out of service"],
      ["normal", false, "Normal service"],
    ] as const)(
      "renders %s station with accessibilityOutage=%s as “%s”",
      (status, accessibilityOutage, statusText) => {
        const tooltip = formatStationTooltip({
          name: "Bloor-Yonge",
          lines: ["1", "2"],
          status,
          accessibilityOutage,
        });
        expect(tooltip).toBe(`Bloor-Yonge (Lines 1, 2) — ${statusText}`);
      },
    );

    it.each([
      [["1"], "Line 1"],
      [["1", "2"], "Lines 1, 2"],
      [["1", "2", "4"], "Lines 1, 2, 4"],
    ] as const)("pluralizes the line list at the >1 boundary: %j → %s", (lines, linesText) => {
      expect(formatStationTooltip({ name: "Museum", lines })).toBe(
        `Museum (${linesText}) — Normal service`,
      );
    });

    it("localizes the map title while preserving operator station and line names", () => {
      expect(
        formatStationTooltip(
          { name: "Bloor-Yonge", lines: ["1", "2"], status: "degraded" },
          frenchText,
        ),
      ).toBe("Bloor-Yonge (Lignes 1, 2) — Retards signalés");
    });
  });

  it("builds station accessibility copy from locale-neutral facts", () => {
    expect(
      formatStationAriaLabel({ name: "Delta South", lines: ["1", "2"], accessible: true }),
    ).toBe("Delta South station, lines 1, 2, wheelchair accessible");
    expect(
      formatStationAriaLabel(
        { name: "Delta South", lines: ["1"], accessible: undefined },
        frenchText,
      ),
    ).toBe("Station Delta South, ligne 1, information sur l’accessibilité indisponible");
  });

  describe("formatSegmentTooltip", () => {
    it("labels a route-wide advisory without inventing a station span", () => {
      expect(formatSegmentTooltip({lineName: "River Loop", fromStation: "River Loop", toStation: "River Loop", kind: "delay"})).toBe("River Loop: Route advisory — General Delay");
    });
    it.each([
      ["severe", "Service Suspension"],
      ["delay", "General Delay"],
      ["rsz", "Reduced Speed Zone"],
      ["upcoming", "Upcoming Planned Closure"],
    ] as const satisfies readonly [StatusSegmentKind, string][])(
      "labels kind %s as “%s”",
      (kind, label) => {
        expect(
          formatSegmentTooltip({
            lineName: "Line 1 (Yonge-University)",
            fromStation: "St Clair",
            toStation: "Eglinton",
            kind,
          }),
        ).toBe(`Line 1 (Yonge-University): St Clair to Eglinton — ${label}`);
      },
    );

    it.each([
      ["Track maintenance", "Reduced Speed Zone (Track maintenance)"],
      ["rsz", "Reduced Speed Zone"],
      [undefined, "Reduced Speed Zone"],
    ] as const)(
      "suppresses a note that merely repeats the kind: note=%s → “%s”",
      (note, rendered) => {
        expect(
          formatSegmentTooltip({
            lineName: "Line 1 (Yonge-University)",
            fromStation: "St Clair",
            toStation: "Eglinton",
            kind: "rsz",
            note,
          }),
        ).toBe(`Line 1 (Yonge-University): St Clair to Eglinton — ${rendered}`);
      },
    );
  });

  it("translates segment titles and keeps operator notes verbatim", () => {
    expect(
      formatSegmentTooltip(
        {
          lineName: "Line 1",
          fromStation: "St Clair",
          toStation: "Eglinton",
          kind: "rsz",
          note: "Track work",
        },
        frenchText,
      ),
    ).toBe("Line 1 : Zone de vitesse réduite — de St Clair à Eglinton (Track work)");
  });
});

describe("interchange planning with server providers", () => {
  it("keeps drawable transfer targets when no browser light index is present", () => {
    const providers = allProviders().map(({ light: _light, ...server }) => server);
    const hubs = decodeInterchangeDataset([{ id: "transfer", endpoints: [
      { agencyId: "sample", stationId: "hub", stationName: "Hub" },
      { agencyId: "regional", stationId: "north", stationName: "North" },
    ], badgeOffsets: { sample: { dx: 0, dy: -24 } } }]);
    const requests = normalizeInterchangeBadgeRequests("sample", hubs, projectInterchangeBadgeAgencies(providers));
    expect(requests.map(request => request.targetAgencyId)).toEqual(["regional"]);
  });
});
