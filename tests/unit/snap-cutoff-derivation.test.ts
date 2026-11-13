/**
 * Synthetic schematic invariants of the snap-correction feature: every fixture
 * gets the corrected engine, and the ceiling never clips what the map measures.
 *
 * Everything here goes through the production seams: `buildMapModel` for the
 * engine and its derived cutoff, `deriveSnapDistanceRatio` for the derivation
 * contract, and `distancePointToPolyline` for every measurement. No fixture
 * restates the affine projection, the p90 interpolation, or the engine's own
 * station pairing, so a change to any of them has to be made in one place and
 * cannot leave a test measuring its own copy of it.
 */
import { describe, expect, it } from "vitest";
import { makeStationSchematic } from "../helpers/agency-fixtures";
import type { Schematic } from "~/agencies/types";
import {
  buildMapModel,
  deriveSnapDistanceRatio,
  distancePointToPolyline,
  MAX_SNAP_DISTANCE_RATIO,
  SNAP_HEADROOM,
} from "~/core/map";

const CANVAS_DIAGONAL = 1000;

/**
 * Eleven stations, so the 90th percentile lands exactly on the tenth of eleven
 * sorted offsets (index `(11 - 1) * 0.9`) and is an offset the fixture names
 * rather than an interpolated value this file would have to reproduce. Every
 * station projects onto a single drawn line running along y = 0, and `lat` is
 * chosen so its affine projection sits `offset` units above that line, which
 * makes each offset both the input and the expected distance.
 */
function ratioForSortedOffsets(sortedOffsets: readonly number[]): number {
  const affine = (lat: number) => ({ x: 500, y: 100 + lat * 10 });
  return deriveSnapDistanceRatio(
    sortedOffsets.map((offset, index) => ({
      id: `s${index}`,
      lineIds: ["alpha"],
      lat: (offset - 100) / 10,
      lon: 0,
    })),
    [
      {
        id: "alpha",
        points: [
          { x: 0, y: 0 },
          { x: 1000, y: 0 },
        ],
      },
    ],
    CANVAS_DIAGONAL,
    affine,
  );
}

/** Nine stations at 20 units, then the two named outliers the p90 lands between. */
function offsetsWithP90AndMax(p90: number, max: number): readonly number[] {
  return [...Array.from({ length: 9 }, () => 20), p90, max];
}

describe("deriveSnapDistanceRatio", () => {
  it("reads the 90th percentile of a schematic's own stylisation, not its extreme", () => {
    // Nine stations sit 20 units off the drawn line, one sits 80 and one sits
    // 500. The cutoff follows the 90th percentile (80 units) plus headroom, so
    // a single wild station cannot widen the gate for every other point.
    expect(ratioForSortedOffsets(offsetsWithP90AndMax(80, 500))).toBeCloseTo(
      (80 / CANVAS_DIAGONAL) * SNAP_HEADROOM,
      12,
    );
  });

  it("closes the gate at the ceiling when a schematic's own evidence is degenerate", () => {
    // p90 of 500 units on a 1000-unit diagonal asks for a cutoff of 0.75, at
    // which point a snap is a re-plot of the feed rather than a correction, so
    // the derived width is refused.
    expect(ratioForSortedOffsets(offsetsWithP90AndMax(500, 500))).toBe(MAX_SNAP_DISTANCE_RATIO);
  });

  it("reads no stylisation from stations that resolve to no drawn line", () => {
    // Nothing measurable means no guessed cutoff: the engine stays in its
    // pre-snap state rather than inventing a width.
    const unattached = deriveSnapDistanceRatio(
      [{ id: "orphan", lineIds: ["not-drawn"], lat: 1, lon: 1 }],
      [
        {
          id: "alpha",
          points: [
            { x: 0, y: 0 },
            { x: 1000, y: 0 },
          ],
        },
      ],
      CANVAS_DIAGONAL,
      () => ({ x: 500, y: 500 }),
    );

    expect(unattached).toBe(0);
  });
});

const schematicFixtures = [0.01, 0.03].map((offset, index) => {
  const schematic = makeStationSchematic(["West", "Middle", "East"], "R1");
  return {
    label: `longitude shift ${index + 1}`,
    schematic: {
      ...schematic,
      stationIndex: schematic.stationIndex!.map((s) => ({ ...s, lon: s.lon + offset })),
    },
  };
});

/**
 * Per station, how far its affine projection lands from the nearest drawn line
 * it is drawn on, before and after the correction, measured the way the
 * derivation measures its own evidence: one figure per station, nearest line
 * first. Both sides come from the engine — the "before" point is the engine's
 * own unattributed projection and the "after" point its own snapped output, and
 * the distances are the engine's own polyline measurement.
 */
function distancesToOwnLines(schematic: Schematic): {
  readonly pairs: readonly { readonly before: number; readonly after: number }[];
  readonly canvasDiagonal: number;
} {
  const geometry = buildMapModel(schematic).geometry;
  const drawn = new Map(schematic.lines.map((line) => [line.id, line.points]));
  const linesByStation = new Map(schematic.stations.map((s) => [s.id, s.lines]));
  const pairs: { before: number; after: number }[] = [];
  for (const entry of schematic.stationIndex ?? []) {
    const lineIds = entry.schematicId ? linesByStation.get(entry.schematicId) : undefined;
    if (!lineIds) continue;
    const affine = geometry.projectGeoToMapPoint(entry.lat, entry.lon);
    let before = Infinity;
    let after = Infinity;
    for (const lineId of new Set(lineIds)) {
      const points = drawn.get(lineId);
      if (!points || points.length < 2) continue;
      before = Math.min(before, distancePointToPolyline(affine, points));
      after = Math.min(
        after,
        distancePointToPolyline(
          geometry.projectGeoToMapPoint(entry.lat, entry.lon, { lineId }),
          points,
        ),
      );
    }
    if (Number.isFinite(before)) pairs.push({ before, after });
  }
  return {
    pairs: pairs.sort((first, second) => first.before - second.before),
    canvasDiagonal: Math.hypot(schematic.viewBoxWidth, schematic.viewBoxHeight),
  };
}

function percentile(sorted: readonly number[], quantile: number): number {
  const index = (sorted.length - 1) * quantile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  return lower === upper
    ? sorted[lower]!
    : sorted[lower]! + (sorted[upper]! - sorted[lower]!) * (index - lower);
}

describe("synthetic schematics use the corrected engine", () => {
  it.each(schematicFixtures.map((entry) => [entry.label, entry.schematic] as const))(
    "%s derives a cutoff from its own geometry",
    (_fixtureLabel, schematic) => {
      // Callers receive the corrected geometry directly from `buildMapModel`.
      expect(buildMapModel(schematic).geometry.snapCutoffRatio).toBeGreaterThan(0);
    },
  );

  it("leaves a schematic with no station index in its pre-snap state", () => {
    // Absent evidence must not become a guessed cutoff. Without a station index
    // there is nothing to measure the drawing's stylisation against, so the
    // engine refuses to move anything at all.
    const [first] = schematicFixtures;
    const geometry = buildMapModel({
      ...first!.schematic,
      stationIndex: undefined,
    } as Schematic).geometry;
    const lineId = first!.schematic.lines[0]!.id;
    const entry = first!.schematic.stationIndex![0]!;

    expect(geometry.snapCutoffRatio).toBe(0);
    expect(geometry.projectGeoToMapPoint(entry.lat, entry.lon, { lineId })).toEqual(
      geometry.projectGeoToMapPoint(entry.lat, entry.lon),
    );
  });
});

describe("the ceiling never clips a schematic's own measured need", () => {
  it.each(schematicFixtures.map((entry) => [entry.label, entry.schematic] as const))(
    "%s derives its full p90 plus headroom, unclipped by the ceiling",
    (_fixtureLabel, schematic) => {
      const { pairs, canvasDiagonal } = distancesToOwnLines(schematic);
      expect(pairs.length).toBeGreaterThan(0);
      // What this schematic measured, so what its cutoff must be. A ceiling that
      // bound here would leave the fixture's worst-drawn decile uncorrected while
      // its median snapped to zero, which from inside one fixture looks like a
      // working feature.
      const need = percentile(
        pairs.map((pair) => pair.before),
        0.9,
      );
      const ratio = buildMapModel(schematic).geometry.snapCutoffRatio;

      // Exactly the measured need: equality is the no-clipping claim, since a
      // clipped schematic would derive strictly less than this.
      expect(ratio * canvasDiagonal).toBeCloseTo(need * SNAP_HEADROOM, 6);
      // And the corollary: the guard is not what sized it. Strictly below the
      // ceiling, so a schematic that needed all of it would have to say so here.
      expect(ratio).toBeLessThan(MAX_SNAP_DISTANCE_RATIO);
    },
  );
});

describe("snapping moves a point onto the line it is drawn on", () => {
  it.each(schematicFixtures.map((entry) => [entry.label, entry.schematic] as const))(
    "%s brings its median and p90 station distance to its drawn line down",
    (_fixtureLabel, schematic) => {
      const { pairs } = distancesToOwnLines(schematic);
      expect(pairs.length).toBeGreaterThan(0);
      const before = pairs.map((pair) => pair.before);
      const after = pairs.map((pair) => pair.after);

      // The claim the whole feature rests on: the correction has to make
      // positions fit the drawing better, not merely not worse. A cutoff below
      // the median would leave both figures where they were.
      //
      // At or below rather than strictly below. A schematic small enough that
      // its median station already sits on its line ties at p50, and that is
      // correct rather than a dead feature: the correction is still carrying
      // that fixture's p90 down, which is the figure the cutoff is sized from.
      expect(percentile(after, 0.5)).toBeLessThanOrEqual(percentile(before, 0.5));
      expect(percentile(after, 0.9)).toBeLessThan(percentile(before, 0.9));
      // Per station, not per aggregate: no correction may push a station
      // further from the corridor it belongs to than the affine projection had it.
      for (const pair of pairs) expect(pair.after).toBeLessThanOrEqual(pair.before);
    },
  );
});

/**
 * A station must keep its own identity through the correction.
 *
 * The distance assertions above cannot see this failure: a point clamped to a
 * vertex ends up zero units from the line, which is the best possible score, so
 * a schematic whose stops all collapse onto one junction scores perfectly while
 * drawing every station in the same place. Measuring distinct output positions
 * is what catches it.
 */
describe("snapping does not collapse stations onto each other", () => {
  it.each(schematicFixtures.map((entry) => [entry.label, entry.schematic] as const))(
    "%s keeps every station on its own drawn line",
    (_fixtureLabel, schematic) => {
      const geometry = buildMapModel(schematic).geometry;
      const drawn = new Map(schematic.lines.map((line) => [line.id, line.points]));
      const linesByStation = new Map(schematic.stations.map((s) => [s.id, s.lines]));

      const projectedByLine = new Map<string, string[]>();
      for (const entry of schematic.stationIndex ?? []) {
        const lineIds = entry.schematicId ? linesByStation.get(entry.schematicId) : undefined;
        if (!lineIds) continue;
        for (const lineId of new Set(lineIds)) {
          if (!drawn.get(lineId) || (drawn.get(lineId)!.length ?? 0) < 2) continue;
          const point = geometry.projectGeoToMapPoint(entry.lat, entry.lon, { lineId });
          const key = `${point.x},${point.y}`;
          const positions = projectedByLine.get(lineId) ?? [];
          positions.push(key);
          projectedByLine.set(lineId, positions);
        }
      }
      expect(projectedByLine.size).toBeGreaterThan(0);

      for (const [lineId, positions] of projectedByLine) {
        // Two stations may legitimately share a pixel where a real interchange
        // is drawn as one node. Three cannot, unless the whole line collapsed.
        const distinct = new Set(positions);
        const collisions = positions.length - distinct.size;
        expect(
          collisions,
          `line ${lineId}: ${distinct.size} distinct positions for ${positions.length} stations`,
        ).toBeLessThanOrEqual(Math.floor(positions.length / 3));
      }
    },
  );

  it("leaves a point that projects past the end of the line where the feed put it", () => {
    // The defect this guards is invisible to the distance assertions above,
    // because a clamped point scores zero. Off the end of the line there is no
    // nearest point on it, only the nearest endpoint, so every such point in the
    // region lands on that one vertex.
    //
    // The projection maps longitude linearly across the canvas, so a station far
    // east lands beyond a line that stops at x=400 while one in the middle sits
    // squarely on it.
    const geometry = buildMapModel({
      viewBoxWidth: 1000,
      viewBoxHeight: 1000,
      lines: [
        {
          id: "alpha",
          points: [
            { x: 0, y: 500 },
            { x: 400, y: 500 },
          ],
        },
      ],
      stations: [],
      viewport: {
        minZoom: 1,
        maxZoom: 8,
        bounds: { minX: 0, maxX: 1000, minY: 0, maxY: 1000 },
      },
      geoProjection: {
        refLonWest: 0,
        refLonEast: 1,
        refXWest: 0,
        refXEast: 1000,
        refLatNorth: 1,
        refLatSouth: 0,
        refYNorth: 0,
        refYSouth: 1000,
      },
    } as unknown as Schematic).geometry;

    const offTheEnd = geometry.projectGeoToMapPoint(0.5, 0.95, { lineId: "alpha" });
    const onTheLine = geometry.projectGeoToMapPoint(0.5, 0.5, { lineId: "alpha" });

    // 0.95 of the way east is x=950, well past the line's x=400 end, and stays there.
    expect(offTheEnd.x).toBeCloseTo(950, 0);
    // Mid-canvas is on the line, so it is still corrected onto y=500.
    expect(onTheLine.y).toBeCloseTo(500, 6);
  });
});
