import { makeStationSchematic } from "../helpers/agency-fixtures";
import { describe, it, expect } from "vitest";
import {
  buildRouteSvgPathD,
  decodePolyline,
  decodePolylineCached,
  encodePolyline,
} from "~/domain/map/MapGeometry";
import {
  deriveMapProjection,
  buildMapModel,
  excludeReducedSpeedZones,
  MAX_SNAP_DISTANCE_RATIO,
} from "~/core/map";
import { SNAP_HEADROOM } from "~/domain/map/MapGeometry";
import type { AgencySnapshot, Schematic } from "~/agencies/types";

const testSchematic: Schematic = {
  viewBoxWidth: 2400,
  viewBoxHeight: 1600,
  lines: [],
  stations: [],
  viewport: {
    bounds: { minX: 780, maxX: 2060, minY: 500, maxY: 1490 },
    minZoom: 0.5,
    maxZoom: 16,
  },
  geoProjection: {
    refLonWest: -79.5356,
    refLonEast: -79.2637,
    refXWest: 809.28,
    refXEast: 2026.28,
    refLatNorth: 43.7806,
    refLatSouth: 43.6453,
    refYNorth: 556.89,
    refYSouth: 1477.89,
  },
};

const testTopology = buildMapModel(testSchematic);
const testGeometry = testTopology.geometry;
const testCamera = testTopology.camera;
const {
  extractRouteMapPoints,
  projectGeoToMapPoint,
  projectGeoBoundingBoxToMapBounds,
  computeRouteBoundingBox,
} = testGeometry;
const { computeTargetViewport } = testCamera;

describe("Route Projection & Polyline Utilities (Seam 1)", () => {
  it("decodes Google Encoded Polyline strings into [lat, lon] tuples", () => {
    // Google official example: "_p~iF~ps|U_ulLnnqC_mqNvxq`@" -> (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
    const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    const decoded = decodePolyline(encoded);
    expect(decoded.length).toBe(3);
    expect(decoded[0][0]).toBeCloseTo(38.5, 4);
    expect(decoded[0][1]).toBeCloseTo(-120.2, 4);
    expect(decoded[1][0]).toBeCloseTo(40.7, 4);
    expect(decoded[1][1]).toBeCloseTo(-120.95, 4);
    expect(decoded[2][0]).toBeCloseTo(43.252, 4);
    expect(decoded[2][1]).toBeCloseTo(-126.453, 4);
  });

  it("handles empty or invalid polyline strings gracefully", () => {
    expect(decodePolyline("")).toEqual([]);
    expect(decodePolyline("...")).toEqual([]);
  });

  describe("decodePolylineCached (per-shape WeakMap memoization)", () => {
    // Google official example -> (38.5, -120.2), (40.7, -120.95), (43.252, -126.453)
    const encoded = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";

    it("returns an empty result for missing, nullish, or invalid shapes", () => {
      for (const shape of [undefined, null, {}, { polyline: "" }, { polyline: "..." }]) {
        expect(decodePolylineCached(shape)).toEqual([]);
      }
    });

    it("returns the SAME array for repeat calls with the same shape object (cache hit)", () => {
      // One tracking snapshot keeps one shape object identity across the
      // overlay geometry pass and the frameRoute pass; both must share
      // the single decoded result.
      const shape = { polyline: encoded };
      const first = decodePolylineCached(shape);
      const second = decodePolylineCached(shape);
      expect(second).toBe(first);
      expect(first.length).toBe(3);
    });

    it("decodes distinct shape objects independently", () => {
      const shapeA = { polyline: "_p~iF~ps|U" }; // -> (38.5, -120.2)
      // NB: "_ulLnnqC" is the DELTA chunk of Google's concatenated example
      // (second point minus first), so standalone it decodes to the delta
      // itself (2.2, -0.75), not to the absolute (40.7, -120.95).
      const shapeB = { polyline: "_ulLnnqC" }; // -> (2.2, -0.75)
      const a = decodePolylineCached(shapeA);
      const b = decodePolylineCached(shapeB);
      expect(a).not.toBe(b);
      expect(a.length).toBe(1);
      expect(b.length).toBe(1);
      expect(b[0][0]).toBeCloseTo(2.2, 4);
      expect(b[0][1]).toBeCloseTo(-0.75, 4);
    });

    it("uses the feed shape when it covers the stop corridor", () => {
      const shape = {
        polyline: encoded,
        directionId: 0,
        id: "s1",
        routeId: "504",
        headsign: "",
        minLat: 0,
        maxLat: 0,
        minLon: 0,
        maxLon: 0,
        pointCount: 3,
      };
      const stops = [
        { lat: 38.5, lon: -120.2, name: "A", id: "a", wheelchair: 1 as const, routes: ["504"] },
      ];
      const viaShape = extractRouteMapPoints(shape, stops);
      const viaProjectionFallback = stops.map((stop) => projectGeoToMapPoint(stop.lat, stop.lon));
      // Shape polyline wins over stop-sequence fallback and projects all points.
      expect(viaShape.length).toBe(3);
      expect(viaShape[0].x).toBeCloseTo(viaProjectionFallback[0].x, 2);
      expect(viaShape[0].y).toBeCloseTo(viaProjectionFallback[0].y, 2);
    });

    it("uses the ordered stop corridor when a shape does not cover its stops", () => {
      const stops = [
        { lat: 43.7, lon: -79.4 },
        { lat: 43.705, lon: -79.37 },
        { lat: 43.71, lon: -79.39 },
      ];
      const shape = {
        polyline: encodePolyline([
          [43.7, -79.4],
          [43.7, -79.39],
          [43.71, -79.39],
        ]),
      };

      const actual = extractRouteMapPoints(shape, stops);

      expect(actual).toEqual(stops.map((stop) => projectGeoToMapPoint(stop.lat, stop.lon)));
    });

    it.each([
      {
        label: "one station endpoint",
        stops: [
          { lat: 43.7, lon: -79.4, parentStationId: "station-a" },
          { lat: 43.705, lon: -79.37 },
          { lat: 43.71, lon: -79.39 },
        ],
      },
      {
        label: "two station endpoints",
        stops: [
          { lat: 43.7, lon: -79.4, parentStationId: "station-a" },
          { lat: 43.705, lon: -79.37 },
          { lat: 43.71, lon: -79.39, parentStationId: "station-b" },
        ],
      },
    ])(
      "keeps the %s fallback in geographic stop space without warping the corridor",
      ({ stops }) => {
        const shape = {
          polyline: encodePolyline([
            [43.65, -79.45],
            [43.65, -79.44],
            [43.66, -79.44],
          ]),
        };

        expect(extractRouteMapPoints(shape, stops)).toEqual(
          stops.map((stop) => projectGeoToMapPoint(stop.lat, stop.lon)),
        );
      },
    );
  });

  it("projects geographic coordinates to SVG map coordinate system aligning with subway stations", () => {
    // Union Station (~43.6453, -79.3806)
    const unionPoint = projectGeoToMapPoint(43.6453, -79.3806);
    expect(unionPoint.x).toBeGreaterThan(1350);
    expect(unionPoint.x).toBeLessThan(1550);
    expect(unionPoint.y).toBeGreaterThan(1350);
    expect(unionPoint.y).toBeLessThan(1550);

    // Finch Station (~43.7806, -79.4149)
    const finchPoint = projectGeoToMapPoint(43.7806, -79.4149);
    expect(finchPoint.y).toBeLessThan(unionPoint.y); // North is lower Y in SVG

    // Kipling Station (~43.6376, -79.5356)
    const kiplingPoint = projectGeoToMapPoint(43.6376, -79.5356);
    // Kennedy Station (~43.7325, -79.2637)
    const kennedyPoint = projectGeoToMapPoint(43.7325, -79.2637);
    expect(kiplingPoint.x).toBeLessThan(kennedyPoint.x); // West is lower X

    const geoBox = { minLat: 43.63, maxLat: 43.78, minLon: -79.54, maxLon: -79.26 };
    const mapBounds = projectGeoBoundingBoxToMapBounds(geoBox);
    expect(mapBounds.width).toBeGreaterThan(1000);
    expect(mapBounds.height).toBeGreaterThan(800);
  });

  it("computes map bounding box from points", () => {
    const points = [
      { x: 1000, y: 800 },
      { x: 1400, y: 600 },
      { x: 1200, y: 1100 },
    ];
    const bbox = computeRouteBoundingBox(points);
    expect(bbox.minX).toBe(1000);
    expect(bbox.maxX).toBe(1400);
    expect(bbox.minY).toBe(600);
    expect(bbox.maxY).toBe(1100);
    expect(bbox.width).toBe(400);
    expect(bbox.height).toBe(500);
    expect(bbox.centerX).toBe(1200);
    expect(bbox.centerY).toBe(850);
  });

  it("builds SVG path d string from projected map points", () => {
    const points = [
      { x: 100, y: 200 },
      { x: 150, y: 250 },
      { x: 200, y: 300 },
    ];
    const d = buildRouteSvgPathD(points);
    expect(d).toBe("M 100,200 L 150,250 L 200,300");
  });
});

/**
 * A stylised schematic: two horizontal lines that the geographic anchors
 * deliberately place away from. The anchors span lon -79.6..-79.1 over
 * x 0..800 and lat 43.9..43.5 over y 0..600, so
 * x = (lon + 79.6) * 1600 and y = (43.9 - lat) * 1500.
 *
 * Canvas diagonal is 1000. Every station's coordinates project onto y = 300
 * while both its anchor and the "alpha" line running through that anchor are
 * drawn at y = 220, so the schematic displaces its own corridor by 80 units.
 * The cutoff is derived from exactly that displacement: 80 * 1.5 = 120 units,
 * which is what the assertions below are written against. Deriving rather than
 * hardcoding is the point, and the ceiling stays clear of it so the measurement,
 * not the guard, is what sizes the correction.
 */
const SNAP_LON = -79.35;
/** WGS84 that projects onto the requested schematic y at SNAP_LON. */
const latForY = (y: number) => 43.9 - y / 1500;
/** WGS84 that projects onto the requested schematic x. */
const lonForX = (x: number) => -79.6 + x / 1600;

/** Where the stations' own coordinates project, and where the drawing is not. */
const SNAP_AFFINE_Y = 300;
/** y of the drawn "alpha" corridor and the anchors it runs through. */
const SNAP_ALPHA_Y = 220;
/** How far the schematic draws its corridor from where the feed says it is. */
const SNAP_STYLISATION = SNAP_AFFINE_Y - SNAP_ALPHA_Y;
/** The cutoff the engine derives from that displacement. */
const SNAP_CUTOFF = SNAP_STYLISATION * SNAP_HEADROOM;

const snapStations = [0, 1, 2, 3].map((index) => ({
  id: `alpha-${index}`,
  schematicId: `alpha-${index}`,
  name: `Alpha ${index}`,
  x: 200 + index * 100,
  y: SNAP_ALPHA_Y,
  lat: latForY(SNAP_AFFINE_Y),
  lon: lonForX(200 + index * 100),
  lines: ["alpha"],
  platformIds: [],
}));

const snapSchematic: Schematic = {
  viewBoxWidth: 800,
  viewBoxHeight: 600,
  lines: [
    {
      id: "alpha",
      name: "Alpha",
      color: "#111111",
      points: [
        { x: 100, y: SNAP_ALPHA_Y },
        { x: 700, y: SNAP_ALPHA_Y },
      ],
    },
    {
      id: "beta",
      name: "Beta",
      color: "#222222",
      points: [
        { x: 100, y: 80 },
        { x: 700, y: 80 },
      ],
    },
  ],
  stations: snapStations.map((station) => ({
    id: station.schematicId,
    name: station.name,
    x: station.x,
    y: station.y,
    lines: station.lines,
  })),
  stationIndex: snapStations,
  viewport: {
    bounds: { minX: 0, maxX: 800, minY: 0, maxY: 600 },
    minZoom: 0.5,
    maxZoom: 8,
  },
  geoProjection: {
    refLonWest: -79.6,
    refLonEast: -79.1,
    refXWest: 0,
    refXEast: 800,
    refLatNorth: 43.9,
    refLatSouth: 43.5,
    refYNorth: 0,
    refYSouth: 600,
  },
};

/**
 * Nothing opts this schematic in: every schematic gets the corrected engine, so
 * this one only has to be a map whose own corridors are drawn away from its own
 * geography. Its shape is arbitrary; the stylisation is the point.
 */
const snapGeometry = buildMapModel(snapSchematic).geometry;

describe("Projection onto a stylised schematic's drawn line", () => {
  // Everything below asserts against the production affine projection rather
  // than a recomputed one, so these pin the composition of affine-then-snap
  // rather than the anchor arithmetic the engine already covers above.
  const affine = (lat: number, lon: number) => snapGeometry.projectGeoToMapPoint(lat, lon);

  it("sizes its cutoff from the displacement the drawing declares, not from the ceiling", () => {
    const canvasDiagonal = Math.hypot(snapSchematic.viewBoxWidth, snapSchematic.viewBoxHeight);
    expect(snapGeometry.snapCutoffRatio * canvasDiagonal).toBe(SNAP_CUTOFF);
    // Every assertion below is written against a cutoff the measurement sized.
    // If the ceiling ever clamped this fixture instead, those numbers would be
    // measuring the guard rather than the derivation.
    expect(SNAP_CUTOFF).toBeLessThan(MAX_SNAP_DISTANCE_RATIO * canvasDiagonal);
  });

  it("places a point that projects beside its own line onto that line", () => {
    // Projects 10 units below "alpha": inside the cutoff, so it belongs there.
    const projected = affine(latForY(SNAP_ALPHA_Y + 10), SNAP_LON);
    expect(projected).toEqual({ x: 400, y: SNAP_ALPHA_Y + 10 });

    const snapped = snapGeometry.projectGeoToMapPoint(latForY(SNAP_ALPHA_Y + 10), SNAP_LON, {
      lineId: "alpha",
    });
    expect(snapped).toEqual({ x: 400, y: SNAP_ALPHA_Y });
  });

  it("prefers the attributed line over a nearer line the point is not on", () => {
    // Projects 60 units from "beta" and 80 from "alpha". Both are inside the
    // 120-unit cutoff, so only the attribution decides which one it lands on.
    expect(affine(latForY(140), SNAP_LON)).toEqual({ x: 400, y: 140 });

    expect(snapGeometry.projectGeoToMapPoint(latForY(140), SNAP_LON, { lineId: "alpha" })).toEqual({
      x: 400,
      y: SNAP_ALPHA_Y,
    });
    expect(snapGeometry.projectGeoToMapPoint(latForY(140), SNAP_LON, { lineId: "beta" })).toEqual({
      x: 400,
      y: 80,
    });
  });

  it("leaves the affine point alone when the nearest point on its line is beyond the cutoff", () => {
    // 140 units from "alpha" and 280 from "beta", both past the 120-unit
    // cutoff: a real correction would be a 140-unit jump, so neither line is
    // admissible and the point stays where the feed put it.
    const lat = latForY(360);
    expect(affine(lat, SNAP_LON)).toEqual({ x: 400, y: 360 });

    expect(snapGeometry.projectGeoToMapPoint(lat, SNAP_LON, { lineId: "alpha" })).toEqual({
      x: 400,
      y: 360,
    });
  });

  it("leaves the affine point alone when the schematic draws no such line", () => {
    // A route the schematic does not draw resolves to no target at all, which
    // is what keeps a streetcar off a nearby subway trunk.
    const lat = latForY(SNAP_ALPHA_Y + 10);
    expect(snapGeometry.projectGeoToMapPoint(lat, SNAP_LON, { lineId: "not-drawn" })).toEqual(
      affine(lat, SNAP_LON),
    );
  });

  it("scales the correction to the canvas, so the same relative offset is treated the same way on any canvas", () => {
    // Quartering the canvas AND the anchors keeps every relationship intact,
    // so both maps must reach the same verdict on the same relative offset.
    // Proportion, not a unit count, is what the cutoff is expressed in.
    const scale = (factor: number) =>
      buildMapModel({
        ...snapSchematic,
        viewBoxWidth: 800 * factor,
        viewBoxHeight: 600 * factor,
        stations: snapSchematic.stations.map((station) => ({
          ...station,
          x: station.x * factor,
          y: station.y * factor,
        })),
        lines: snapSchematic.lines.map((line) => ({
          ...line,
          points: line.points.map((point) => ({ x: point.x * factor, y: point.y * factor })),
        })),
        stationIndex: snapStations.map((station) => ({
          ...station,
          x: station.x * factor,
          y: station.y * factor,
          // Keep each station 80*factor units below its projected point, so
          // the stylisation scales with the canvas exactly as the geometry does.
          lat: latForY(SNAP_AFFINE_Y * factor),
          lon: lonForX(station.x * factor),
        })),
        viewport: {
          ...snapSchematic.viewport,
          bounds: {
            minX: 0,
            maxX: 800 * factor,
            minY: 0,
            maxY: 600 * factor,
          },
        },
        geoProjection: {
          ...snapSchematic.geoProjection,
          refXEast: 800 * factor,
          refYSouth: 600 * factor,
        },
      } as Schematic).geometry;

    const full = scale(1);
    const half = scale(0.5);

    // 70 units below "alpha" on the full canvas: inside its 120-unit cutoff,
    // so it snaps. On the half canvas the same point is 35 units below a
    // line whose cutoff is also 60 units, so the same relative verdict holds.
    const lat = latForY(290);
    expect(full.projectGeoToMapPoint(lat, SNAP_LON, { lineId: "alpha" }).y).toBe(SNAP_ALPHA_Y);
    expect(half.projectGeoToMapPoint(lat, SNAP_LON, { lineId: "alpha" }).y).toBe(
      SNAP_ALPHA_Y * 0.5,
    );
  });

  it("rounds a snapped point to the same hundredth the affine projection uses", () => {
    const alpha = snapSchematic.lines[0]!.points;
    // lon chosen so the projected x lands between vertices, on the diagonal
    // foot of a segment: an unrounded correction would expose float noise.
    const lon = -79.6 + 317.331 / 1600;
    const snapped = snapGeometry.projectGeoToMapPoint(latForY(137), lon, { lineId: "alpha" });

    expect(snapped.y).toBe(alpha[0]!.y);
    expect(Number.isInteger(snapped.x * 100)).toBe(true);
  });

  // A corridor drawn 10 units off its own line, supplied two ways: live feeds
  // do not always carry a persisted shape, so both must be corrected alike.
  const offLine = {
    polyline: encodePolyline([
      [latForY(SNAP_ALPHA_Y + 10), -79.475],
      [latForY(SNAP_ALPHA_Y + 10), SNAP_LON],
      [latForY(SNAP_ALPHA_Y + 10), -79.225],
    ]),
  };
  const offLineStops = [
    { lat: latForY(SNAP_ALPHA_Y + 10), lon: -79.475 },
    { lat: latForY(SNAP_ALPHA_Y + 10), lon: SNAP_LON },
    { lat: latForY(SNAP_ALPHA_Y + 10), lon: -79.225 },
  ];

  it.each([
    { label: "a feed shape", shape: offLine, stops: undefined },
    { label: "an ordered stop sequence", shape: undefined, stops: offLineStops },
  ])("draws the corridor of $label on its attributed line", ({ shape, stops }) => {
    const corridor = snapGeometry.extractRouteMapPoints(shape, stops, { lineId: "alpha" });
    const affineCorridor = snapGeometry.extractRouteMapPoints(shape, stops);

    expect(corridor.length).toBe(affineCorridor.length);
    expect(corridor.length).toBeGreaterThan(1);
    for (let index = 0; index < corridor.length; index += 1) {
      // Every vertex moves onto "alpha", and moves off where the affine
      // projection put it, so the corridor is corrected rather than unchanged.
      expect(corridor[index]!.y).toBe(SNAP_ALPHA_Y);
      expect(affineCorridor[index]!.y).toBeCloseTo(SNAP_ALPHA_Y + 10, 1);
    }
  });

  it("keeps choosing the stop corridor over an uncovered shape once an attribution is supplied", () => {
    // Snapping pulls the shape's vertices onto the same line as the stops, so
    // a decision made after snapping could not tell the two apart. The
    // branch choice stays a question about the feed's own geography.
    const stops = [
      { lat: latForY(SNAP_AFFINE_Y), lon: -79.475 },
      { lat: latForY(SNAP_AFFINE_Y), lon: SNAP_LON },
    ];
    const shape = {
      polyline: encodePolyline([
        [latForY(200), -79.475],
        [latForY(200), SNAP_LON],
      ]),
    };

    expect(snapGeometry.extractRouteMapPoints(shape, stops, { lineId: "alpha" })).toEqual(
      snapGeometry.extractRouteMapPoints(undefined, stops, { lineId: "alpha" }),
    );
    // Sanity on the fixture: the shape really is the discarded option.
    expect(snapGeometry.extractRouteMapPoints(shape, stops).length).toBe(stops.length);
  });

  it("returns the affine point unchanged for a schematic that draws no lines", () => {
    const lineFree = buildMapModel({ ...snapSchematic, lines: [] } as Schematic).geometry;
    const lat = latForY(SNAP_ALPHA_Y + 10);

    expect(lineFree.projectGeoToMapPoint(lat, SNAP_LON, { lineId: "alpha" })).toEqual(
      lineFree.projectGeoToMapPoint(lat, SNAP_LON),
    );
  });

  it("frames the route inside the map's usable container", () => {
    const bbox = {
      minX: 1000,
      maxX: 1400,
      minY: 600,
      maxY: 1000,
      width: 400,
      height: 400,
      centerX: 1200,
      centerY: 800,
    };

    const container = { width: 800, height: 600 };
    const target = computeTargetViewport(bbox, container)!;
    const camera = { ...container, ...target };
    const corners = [
      { x: bbox.minX, y: bbox.minY },
      { x: bbox.maxX, y: bbox.maxY },
    ].map((point) => testCamera.transformMapPointToContainer(point, camera)!);

    expect(corners[0]!.x).toBeGreaterThanOrEqual(24);
    expect(corners[1]!.x).toBeLessThanOrEqual(container.width - 24);
    expect(corners[0]!.y).toBeGreaterThanOrEqual(84);
    expect(corners[1]!.y).toBeLessThanOrEqual(container.height - 32);
  });
});

const syntheticSchematic: Schematic = {
  viewBoxWidth: 2400,
  viewBoxHeight: 1600,
  lines: [
    {
      id: "1",
      name: "Line 1",
      color: "#F8B332",
      points: [
        { x: 0, y: 0 },
        { x: 100, y: 100 },
      ],
    },
  ],
  stations: [
    { id: "museum", name: "Museum", x: 100, y: 100, lines: ["1"] },
    { id: "yorkdale", name: "Yorkdale", x: 110, y: 110, lines: ["1"] },
    { id: "lawrence-west", name: "Lawrence West", x: 120, y: 120, lines: ["1"] },
    { id: "eglinton", name: "Eglinton", x: 130, y: 130, lines: ["1"] },
    { id: "finch", name: "Finch", x: 140, y: 140, lines: ["1"] },
    { id: "kennedy", name: "Kennedy", x: 150, y: 150, lines: ["1"] },
    { id: "bloor-yonge", name: "Bloor-Yonge", x: 160, y: 160, lines: ["1"] },
  ],
  viewport: {
    bounds: { minX: 0, maxX: 2400, minY: 0, maxY: 1600 },
    minZoom: 0.5,
    maxZoom: 16,
  },
  geoProjection: {
    refLonWest: -79.6,
    refLonEast: -79.1,
    refXWest: 0,
    refXEast: 2400,
    refLatNorth: 43.9,
    refLatSouth: 43.5,
    refYNorth: 0,
    refYSouth: 1600,
  },
  sequences: {
    "1": ["museum", "yorkdale", "lawrence-west", "eglinton", "finch", "kennedy", "bloor-yonge"],
  },
};

const syntheticTopology = buildMapModel(syntheticSchematic);
const railTopology = buildMapModel(makeStationSchematic(["West", "Hub", "East"], "R1"));
const busTopology = buildMapModel(makeStationSchematic(["North", "South"], "blue"));
const stationRef = (stationId: string, stationName = stationId) => ({ stationId, stationName });
const nameOnlyStationRef = (stationName: string) => ({ stationName });

describe("Station Bypass & Alert Projections", () => {
  it.each([
    ["Regional Transit", "regional", railTopology, "R1"],
    ["Local Transit", "local", busTopology, "blue"],
  ] as const)(
    "draws a full schematic line for a %s alert without stop endpoints",
    (agencyName, agencyId, topology, lineId) => {
      const line = topology.linesById.get(lineId);
      expect(line).toBeDefined();

      const snapshot: AgencySnapshot = {
        agencyId,
        generatedAt: Date.now(),
        freshness: "live",
        alerts: [
          {
            id: `${agencyId}-line-alert`,
            kind: "delay",
            severity: "degraded",
            lifecycle: "active",
            scope: "line",
            affectedLineIds: [lineId],
            title: `${agencyName} service alert`,
            startsAt: Date.now(),
            updatedAt: Date.now(),
          },
        ],
      };

      const projection = deriveMapProjection(snapshot, topology);

      expect(projection.statusOverlaySegments).toHaveLength(1);
      expect(projection.statusOverlaySegments[0]).toMatchObject({
        id: `${agencyId}-line-alert`,
        lineId,
        pathD: line!.pathD,
      });
    },
  );

  it("does not create a status overlay segment for a normal severity informational alert", () => {
    const line = railTopology.linesById.get("R1");
    expect(line).toBeDefined();

    const snapshot: AgencySnapshot = {
      agencyId: "regional",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "go-info-alert",
          kind: "information",
          severity: "normal",
          lifecycle: "active",
          scope: "line",
          affectedLineIds: ["R1"],
          title: "Regional advisory",
          startsAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, railTopology);
    expect(projection.statusOverlaySegments).toEqual([]);
  });

  it("does not broaden an unresolved station-scoped alert to the full line", () => {
    const line = syntheticTopology.linesById.get("1");
    expect(line).toBeDefined();

    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "unresolved-station-alert",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "segment",
          affectedLineIds: ["1"],
          fromStation: nameOnlyStationRef("opaque-stop-a"),
          toStation: nameOnlyStationRef("opaque-stop-b"),
          affectedStations: [
            nameOnlyStationRef("opaque-stop-a"),
            nameOnlyStationRef("opaque-stop-b"),
          ],
          title: "Service disruption between two stations",
          startsAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);

    expect(projection.statusOverlaySegments).toEqual([]);
    expect(line!.pathD).toBeTruthy();
  });

  it("targets bounded spans by schematic ID even when display names change", () => {
    const line = syntheticTopology.linesById.get("1");
    expect(line).toBeDefined();

    const projection = deriveMapProjection(
      {
        agencyId: "sample",
        generatedAt: 0,
        freshness: "live",
        alerts: [
          {
            id: "renamed-span",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            scope: "segment",
            affectedLineIds: ["1"],
            fromStation: stationRef("museum", "Former Museum"),
            toStation: stationRef("lawrence-west", "Former Lawrence West"),
            title: "No service",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
      },
      syntheticTopology,
    );

    expect(projection.statusOverlaySegments[0]).toMatchObject({
      fromStation: "Museum",
      toStation: "Lawrence West",
    });
    expect(projection.statusOverlaySegments[0]?.pathD).not.toBe(line!.pathD);
  });

  it("keeps same-name affected stations independently keyed by schematic ID", () => {
    const projection = deriveMapProjection(
      {
        agencyId: "sample",
        generatedAt: 0,
        freshness: "live",
        alerts: [
          {
            id: "duplicate-name-stations",
            kind: "suspension",
            severity: "severe",
            lifecycle: "active",
            scope: "station",
            affectedStations: [stationRef("museum", "Central"), stationRef("yorkdale", "Central")],
            title: "Station disruption",
            startsAt: 0,
            updatedAt: 0,
          },
        ],
      },
      syntheticTopology,
    );

    expect([...projection.stationSeverities.entries()]).toEqual([
      ["museum", "severe"],
      ["yorkdale", "severe"],
    ]);
  });

  it("projects severe status purely from shipped affectedStations, never re-derived from text", () => {
    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "opaque-severe",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "station",
          title: "Crew response in progress",
          description: "Stand by for updates.",
          startsAt: Date.now(),
          updatedAt: Date.now(),
          affectedStations: [stationRef("museum", "Museum")],
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);
    expect(projection.stationSeverities.get("museum")).toBe("severe");
    expect(projection.stationSeverities.size).toBe(1);
  });

  it("projects degraded status at shipped severity for alerts", () => {
    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "opaque-degraded",
          kind: "delay",
          severity: "degraded",
          lifecycle: "active",
          scope: "station",
          title: "Crew response in progress",
          description: "Stand by for updates.",
          startsAt: Date.now(),
          updatedAt: Date.now(),
          affectedStations: [stationRef("museum", "Museum")],
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);
    expect(projection.stationSeverities.get("museum")).toBe("degraded");
    expect(projection.stationSeverities.size).toBe(1);
  });

  it("aggregates multiple alerts on a station by severity rank", () => {
    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "alert-severe",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "station",
          title: "Suspension",
          startsAt: Date.now(),
          updatedAt: Date.now(),
          affectedStations: [stationRef("museum", "Museum")],
        },
        {
          id: "alert-degraded",
          kind: "delay",
          severity: "degraded",
          lifecycle: "active",
          scope: "station",
          title: "Delay",
          startsAt: Date.now(),
          updatedAt: Date.now(),
          affectedStations: [stationRef("museum", "Museum")],
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);
    expect(projection.stationSeverities.get("museum")).toBe("severe");
  });

  it("excludes route-attributed alerts that do not touch the station's lines from stationSeverities", () => {
    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "unrelated-route",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "station",
          affectedRouteIds: ["510"],
          affectedStations: [stationRef("museum", "Museum")],
          title: "Route 510 disruption",
          startsAt: Date.now(),
          updatedAt: Date.now(),
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);
    expect(projection.stationSeverities.has("museum")).toBe(false);
  });

  it("does not rescue stations client-side when affectedStations ships empty", () => {
    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "rescue-proof",
          kind: "suspension",
          severity: "severe",
          lifecycle: "active",
          scope: "network",
          title: "Trains are not stopping at Museum station right now.",
          startsAt: Date.now(),
          updatedAt: Date.now(),
          affectedStations: [],
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);
    expect(projection.stationSeverities.size).toBe(0);
  });

  it("derives accessibility outage stations from shipped endpoints and affectedStations", () => {
    const snapshot: AgencySnapshot = {
      agencyId: "sample",
      generatedAt: Date.now(),
      freshness: "live",
      alerts: [
        {
          id: "access-kennedy",
          kind: "accessibility",
          severity: "normal",
          lifecycle: "active",
          scope: "station",
          fromStation: stationRef("kennedy", "Kennedy"),
          toStation: stationRef("kennedy", "Kennedy"),
          title: "Kennedy: Elevator out of service",
          description: "Elevator 16D2L out of service",
          startsAt: Date.now(),
          updatedAt: Date.now(),
        },
        {
          id: "access-bloor",
          kind: "accessibility",
          severity: "normal",
          lifecycle: "active",
          scope: "station",
          title: "Accessibility notice",
          startsAt: Date.now(),
          updatedAt: Date.now(),
          affectedStations: [stationRef("bloor-yonge", "Bloor-Yonge")],
        },
      ],
    };

    const projection = deriveMapProjection(snapshot, syntheticTopology);
    expect(projection.stationAccessibilityOutages.has("kennedy")).toBe(true);
    expect(projection.stationAccessibilityOutages.has("bloor-yonge")).toBe(true);
  });
});

describe("deriveMapProjection — reduced-speed-zone preference gate", () => {
  const rszSnapshot = (): AgencySnapshot => ({
    agencyId: "sample",
    generatedAt: Date.now(),
    freshness: "live",
    alerts: [
      {
        id: "rsz-gate",
        kind: "slow-service",
        severity: "degraded",
        lifecycle: "active",
        scope: "segment",
        affectedLineIds: ["1"],
        fromStation: stationRef("yorkdale", "Yorkdale"),
        toStation: stationRef("lawrence-west", "Lawrence West"),
        affectedStations: [
          stationRef("yorkdale", "Yorkdale"),
          stationRef("lawrence-west", "Lawrence West"),
        ],
        title: "Reduced speed zone",
        description: "Trains moving slower than usual",
        startsAt: Date.now(),
        updatedAt: Date.now(),
      },
      {
        id: "severe-gate",
        kind: "suspension",
        severity: "severe",
        lifecycle: "active",
        scope: "segment",
        affectedLineIds: ["1"],
        fromStation: stationRef("eglinton", "Eglinton"),
        toStation: stationRef("finch", "Finch"),
        title: "No service",
        startsAt: Date.now(),
        updatedAt: Date.now(),
      },
    ],
  });

  it("projects reduced-speed-zone segments by default", () => {
    expect(
      deriveMapProjection(rszSnapshot(), syntheticTopology).statusOverlaySegments.map((s) => s.id),
    ).toEqual(["rsz-gate", "severe-gate"]);
  });

  it("excludeReducedSpeedZones drops only rsz segments, keeping severe geometry intact", () => {
    const gated = excludeReducedSpeedZones(deriveMapProjection(rszSnapshot(), syntheticTopology));

    expect(gated.statusOverlaySegments.map((s) => s.id)).toEqual(["severe-gate"]);
    expect(gated.statusOverlaySegments[0]!.kind).toBe("severe");
  });

  it("does not let the closed gate erase station severities from rsz alerts", () => {
    const source = deriveMapProjection(rszSnapshot(), syntheticTopology);
    const gated = excludeReducedSpeedZones(source);

    expect(gated.stationSeverities).toBe(source.stationSeverities);
    expect(gated.stationAccessibilityOutages).toBe(source.stationAccessibilityOutages);
  });

  it("excludeReducedSpeedZones returns the same projection when no rsz segments exist", () => {
    const projection = {
      statusOverlaySegments: [],
      stationSeverities: new Map(),
      stationAccessibilityOutages: new Set<string>(),
    };
    expect(excludeReducedSpeedZones(projection)).toBe(projection);
  });
});

/** Drawn-line lookup accepts canonical IDs and rejects undrawn routes. */
describe("a drawn route's corridor comes from the drawn line", () => {
  const model = buildMapModel(makeStationSchematic(["West", "Hub", "East"], "R1"));

  it("returns nothing for a line this schematic does not draw", () => {
    // The other half of the contract. A route with no drawn line has to fall
    // back to its own shape, and that fallback is what every bus route uses.
    expect(model.geometry.drawnLineMapPoints("not-a-line")).toBeUndefined();
    expect(model.geometry.drawnLineMapPoints("901")).toBeUndefined();
  });

  it("resolves a line id that differs only in case or padding", () => {
    // Attribution arrives from a manifest route id, and `snapLineKey` is the one
    // grammar both the snap index and this lookup share, so a hint differing
    // only in case or surrounding whitespace cannot resolve against one and miss
    // the other.
    expect(model.geometry.drawnLineMapPoints(" r1 ")).toEqual(
      model.geometry.drawnLineMapPoints("R1"),
    );
  });
});
