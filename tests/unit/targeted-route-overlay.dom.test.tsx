// @vitest-environment happy-dom
import { describe, it, expect, afterEach } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { anchorKey } from "~/domain/map/MapGeometry";
import { buildMapModel } from "~/core/map";
import { makeStationSchematic } from "../helpers/agency-fixtures";
import { type RouteTrackingData, type SurfaceStop } from "~/domain/surface/types";
import type { StationInfo } from "~/core/map";
import { TargetedRouteOverlay } from "~/components/map/TargetedRouteOverlay";
import type { TargetedRouteTracking } from "~/lib/routeTrackingLifecycle";

const authored = makeStationSchematic(["North", "Middle", "South"], "8");
const sampleSchematic = {
  ...authored,
  lines: authored.lines.map((line) => ({
    ...line,
    points: [
      { x: 0, y: 10 },
      { x: 90, y: 40 },
    ],
  })),
  stationIndex: authored.stationIndex!.map((entry) => ({ ...entry, lon: entry.lon - 0.08 })),
};
const geometry = buildMapModel(sampleSchematic).geometry;

// The authored map displaces its feed corridor so attributed and affine
// positions differ visibly. This exercises correction through the real engine.
const WEBER_LINE_ID = "8";
const weberStops: SurfaceStop[] = (sampleSchematic.stationIndex ?? [])
  .filter((entry) =>
    sampleSchematic.stations
      .find((station) => station.id === entry.schematicId)
      ?.lines.includes(WEBER_LINE_ID),
  )
  .sort((first, second) => second.lat - first.lat)
  .map((entry) => ({
    id: entry.id,
    name: entry.name,
    lat: entry.lat,
    lon: entry.lon,
    wheelchair: 1 as const,
    routes: [WEBER_LINE_ID],
  }));

const [firstStop, secondStop] = weberStops;

afterEach(cleanup);

/**
 * Pulls the numeric pair out of both coordinate forms the overlay emits:
 * SVG attribute `translate(x, y)` (stop nodes) and CSS style
 * `translate(Xpx, Ypx)` (vehicle markers).
 */
function translatePair(transform: string): [number, number] {
  const match = transform.match(/translate\((-?[\d.]+)(?:px)?,\s*(-?[\d.]+)(?:px)?\)/);
  expect(match).not.toBeNull();
  return [Number(match![1]), Number(match![2])];
}

/**
 * The stop node `g` for this stop name. Resolved from the title's own nearest
 * `g` rather than by scanning groups: the overlay layer group also contains the
 * title in its subtree, so a substring-free scan would match the outermost
 * ancestor first and hand back a node with no transform of its own.
 */
function stopGroupFor(root: ParentNode, name: string): SVGGElement {
  const title = Array.from(root.querySelectorAll("circle > title")).find(
    (candidate) => candidate.textContent === name,
  );
  expect(title, `no stop node titled "${name}"`).toBeDefined();
  const group = title!.closest("g");
  expect(group).not.toBeNull();
  return group as SVGGElement;
}

describe("Targeted Route Overlay Layer (Seam 4)", () => {
  const sampleTrackingData: RouteTrackingData = {
    route: {
      id: WEBER_LINE_ID,
      shortName: WEBER_LINE_ID,
      longName: "Weber",
      routeType: "rail",
      color: "#0B6E4F",
      textColor: "#FFFFFF",
    },
    shape: {
      id: "8_0",
      routeId: WEBER_LINE_ID,
      directionId: 0,
      headsign: "8 Weber to Conestoga",
      polyline: "",
      minLat: 43.42,
      maxLat: 43.48,
      minLon: -80.53,
      maxLon: -80.44,
      pointCount: 0,
    },
    stops: weberStops,
    vehicles: [
      {
        vehicleId: "37d290f9-1542-4ab1-850c-e30e6484c",
        routeId: WEBER_LINE_ID,
        directionId: 0,
        latitude: secondStop!.lat,
        longitude: secondStop!.lon,
        bearing: 270,
        speed: 5.5,
        timestamp: Date.now(),
      },
    ],
    alerts: [],
  };

  it("renders one positioned node per corridor stop with the stop name as its label", () => {
    const { container } = render(() => (
      <TargetedRouteOverlay geometry={geometry} trackingData={sampleTrackingData} />
    ));

    const stopLabels = Array.from(container.querySelectorAll("circle > title")).map(
      (t) => t.textContent,
    );
    expect(stopLabels).toHaveLength(sampleTrackingData.stops.length);
    for (const stop of sampleTrackingData.stops) {
      expect(stopLabels).toContain(stop.name);
    }
  });

  it("draws the route corridor as a multi-point SVG path stroked with the feed's route color", () => {
    const { container } = render(() => (
      <TargetedRouteOverlay geometry={geometry} trackingData={sampleTrackingData} />
    ));

    const corePath = Array.from(container.querySelectorAll("path")).find(
      (p) => p.getAttribute("stroke") === sampleTrackingData.route.color,
    );
    expect(corePath).toBeDefined();
    const d = corePath!.getAttribute("d") ?? "";
    expect(d.startsWith("M ")).toBe(true);
    expect(d).toContain(" L ");
  });

  it("strokes a drawn route along its drawn line, and an undrawn one along its own shape", () => {
    // The corridor the rider sees. For a route the schematic draws, that is the
    // drawn line, at the scale the map is drawn: the feed's shape is one trip's
    // geographic projection, and on a stylised schematic the two disagree about
    // scale, so drawing the projection shows a stub of the route the rider
    // selected. Read from the real engine rather than recomputed here, so this
    // cannot drift from what the overlay draws.
    const drawn = geometry.drawnLineMapPoints(WEBER_LINE_ID)!;
    expect(drawn.length).toBeGreaterThan(1);
    const drawnBounds = geometry.computeRouteBoundingBox(drawn);

    const attributed = render(() => (
      <TargetedRouteOverlay
        geometry={geometry}
        activeLineId={WEBER_LINE_ID}
        trackingData={sampleTrackingData}
      />
    ));
    const drawnPath = Array.from(attributed.container.querySelectorAll("path")).find(
      (p) => p.getAttribute("stroke") === sampleTrackingData.route.color,
    );
    const drawnD = drawnPath!.getAttribute("d") ?? "";
    // The drawn line's own first and last points, verbatim. Not a bounding-box
    // comparison: a bounding box cannot tell the full line from a fragment of it.
    const asPathPoint = (p: { x: number; y: number }) => `${p.x},${p.y}`;
    expect(drawnD).toContain(asPathPoint(drawn[0]!));
    expect(drawnD).toContain(asPathPoint(drawn.at(-1)!));
    // And it is the full extent, not the projection of the same trip.
    const shapePoints = geometry.extractRouteMapPoints(
      sampleTrackingData.shape,
      sampleTrackingData.stops,
      { lineId: WEBER_LINE_ID },
    );
    const shapeBounds = geometry.computeRouteBoundingBox(shapePoints);
    expect(Math.max(drawnBounds.width, drawnBounds.height)).toBeGreaterThan(
      Math.max(shapeBounds.width, shapeBounds.height),
    );

    // The same overlay with no line drawn keeps the trip's own shape, which is
    // the only description of where an undrawn route goes that exists.
    const unattributed = render(() => (
      <TargetedRouteOverlay geometry={geometry} trackingData={sampleTrackingData} />
    ));
    const shapePath = Array.from(unattributed.container.querySelectorAll("path")).find(
      (p) => p.getAttribute("stroke") === sampleTrackingData.route.color,
    );
    const shapeD = shapePath!.getAttribute("d") ?? "";
    expect(shapeD).not.toContain(asPathPoint(drawn[0]!));
    expect(shapeD.startsWith("M ")).toBe(true);
  });

  it.each(["bus", "streetcar", "express"] as const)(
    "keeps an enlarged %s corridor and its stops in geographic space without vehicles",
    (routeType) => {
      const data: RouteTrackingData = {
        ...sampleTrackingData,
        route: { ...sampleTrackingData.route, routeType },
        vehicles: [],
      };
      const { container } = render(() => (
        <TargetedRouteOverlay
          geometry={geometry}
          activeLineId={WEBER_LINE_ID}
          trackingData={data}
        />
      ));
      const path = Array.from(container.querySelectorAll("path")).find(
        (candidate) => candidate.getAttribute("stroke") === data.route.color,
      );
      expect(path).toBeDefined();
      for (const stop of data.stops) {
        const point = geometry.projectGeoToMapPoint(stop.lat, stop.lon);
        const [x, y] = translatePair(
          stopGroupFor(container, stop.name).getAttribute("transform") ?? "",
        );
        expect(x).toBeCloseTo(point.x, 6);
        expect(y).toBeCloseTo(point.y, 6);
        expect(path!.getAttribute("d")).toContain(`${point.x},${point.y}`);
      }
    },
  );

  it("positions the live vehicle marker at the map point of the stop whose coordinates it shares", () => {
    // The UUID-backed vehicle fixture reports the exact coordinates of the same
    // stop twice; marker and stop node must land on the same production-projected
    // point without the test recomputing any geometry.
    const { container } = render(() => (
      <TargetedRouteOverlay geometry={geometry} trackingData={sampleTrackingData} />
    ));

    const marker = container.querySelector<SVGGElement>(".vehicle-marker-node");
    expect(marker).not.toBeNull();
    const [markerX, markerY] = translatePair(marker!.style.transform);

    const [stopX, stopY] = translatePair(
      stopGroupFor(container, secondStop!.name).getAttribute("transform") ?? "",
    );

    expect(markerX).toBeCloseTo(stopX, 6);
    expect(markerY).toBeCloseTo(stopY, 6);
    const title = marker!.querySelector("title")?.textContent;
    expect(title).toBe("Rail 8 — Weber");
    expect(title).not.toContain(sampleTrackingData.vehicles[0]!.vehicleId);
  });

  it("keeps station-associated surface stops at their projected geographic positions", () => {
    const { container } = render(() => (
      <TargetedRouteOverlay geometry={geometry} trackingData={sampleTrackingData} />
    ));

    const stop = firstStop!;
    const [actualX, actualY] = translatePair(
      stopGroupFor(container, stop.name).getAttribute("transform") ?? "",
    );
    const expected = geometry.projectGeoToMapPoint(stop.lat, stop.lon);

    expect(actualX).toBeCloseTo(expected.x, 6);
    expect(actualY).toBeCloseTo(expected.y, 6);
  });

  it.each([
    {
      label: "vehicle marker",
      find: (root: ParentNode) => root.querySelector(".vehicle-marker-node"),
      readAttribute: false,
    },
    {
      label: "stop node",
      find: (root: ParentNode) => stopGroupFor(root, secondStop!.name),
      readAttribute: true,
    },
  ])(
    "moves the $label onto the active line, and only when one is given",
    ({ find, readAttribute }) => {
      // The overlay's whole job here is the wiring: whatever the geometry port
      // says for the attribution it was handed has to be what it renders. Which
      // line a point lands on, and whether it moves at all, is the port's call
      // and is pinned in route-projection.test.ts against a synthetic schematic.
      const affineVehicle = geometry.projectGeoToMapPoint(
        sampleTrackingData.vehicles[0]!.latitude,
        sampleTrackingData.vehicles[0]!.longitude,
      );
      const affineStop = geometry.projectGeoToMapPoint(secondStop!.lat, secondStop!.lon);
      const snappedVehicle = geometry.projectGeoToMapPoint(
        sampleTrackingData.vehicles[0]!.latitude,
        sampleTrackingData.vehicles[0]!.longitude,
        { lineId: WEBER_LINE_ID },
      );
      const snappedStop = geometry.projectGeoToMapPoint(secondStop!.lat, secondStop!.lon, {
        lineId: WEBER_LINE_ID,
      });

      const readPoint = (root: ParentNode): [number, number] => {
        const node = find(root) as SVGGElement;
        expect(node).toBeDefined();
        return translatePair(
          (readAttribute ? node.getAttribute("transform") : node.style.transform) ?? "",
        );
      };

      const unattributed = render(() => (
        <TargetedRouteOverlay geometry={geometry} trackingData={sampleTrackingData} />
      ));
      const [plainX, plainY] = readPoint(unattributed.container);
      expect(plainX).toBeCloseTo(readAttribute ? affineStop.x : affineVehicle.x, 6);
      expect(plainY).toBeCloseTo(readAttribute ? affineStop.y : affineVehicle.y, 6);

      const attributed = render(() => (
        <TargetedRouteOverlay
          geometry={geometry}
          activeLineId={WEBER_LINE_ID}
          trackingData={sampleTrackingData}
        />
      ));
      const [snappedX, snappedY] = readPoint(attributed.container);
      expect(snappedX).toBeCloseTo(readAttribute ? snappedStop.x : snappedVehicle.x, 6);
      expect(snappedY).toBeCloseTo(readAttribute ? snappedStop.y : snappedVehicle.y, 6);
    },
  );

  it("renders vehicle markers only for the selected direction", () => {
    const trackingEast: TargetedRouteTracking = {
      data: () => sampleTrackingData,
      isStaleForDirection: () => false,
      nearestStopId: () => undefined,
      onDataArrival: () => () => {},
      selectDirection: () => {},
      selectedDirectionId: () => 0,
    };
    const trackingWest: TargetedRouteTracking = {
      ...trackingEast,
      selectedDirectionId: () => 1,
    };

    const eastbound = render(() => (
      <TargetedRouteOverlay
        geometry={geometry}
        tracking={trackingEast}
        trackingData={sampleTrackingData}
      />
    ));
    expect(eastbound.container.querySelector(".vehicle-marker-node")).not.toBeNull();

    const westbound = render(() => (
      <TargetedRouteOverlay
        geometry={geometry}
        tracking={trackingWest}
        trackingData={sampleTrackingData}
      />
    ));
    expect(westbound.container.querySelector(".vehicle-marker-node")).toBeNull();
  });

  describe("connecting interchange resolution through schematic station ids", () => {
    const makeInterchange = (id: string, name: string): StationInfo => ({
      id,
      name,
      x: 1000,
      y: 1000,
      lines: [WEBER_LINE_ID],
      accessible: true,
      isInterchange: true,
      isTerminal: false,
      labelX: 1012,
      labelY: 1004,
      labelRotation: 0,
      labelAnchor: "start",
    });

    const renderOverlay = (
      parentStations: readonly { readonly id: string; readonly name: string }[],
      interchanges: readonly StationInfo[],
    ) =>
      render(() => (
        <TargetedRouteOverlay
          geometry={geometry}
          trackingData={{
            ...sampleTrackingData,
            stops: sampleTrackingData.stops.map((stop, i) => ({
              ...stop,
              parentStation: parentStations[i]?.name,
              parentStationId: parentStations[i]?.id,
            })),
          }}
          interchangeStations={interchanges}
        />
      ));

    it("highlights interchanges by schematic id even when display names differ", () => {
      const { container } = renderOverlay(
        [
          { id: "central", name: "Central" },
          { id: "fairway", name: "Fairway" },
        ],
        [
          makeInterchange("central", "Central"),
          makeInterchange("fairway", "Fairway"),
          makeInterchange("place_KUN", "King/University"),
        ],
      );

      const highlights = container.querySelectorAll(".connecting-interchange-highlight");
      // King/University is on the line but unconnected to this route: never
      // highlighted.
      expect(highlights.length).toBe(2);
      const titled = Array.from(highlights).map((g) => g.querySelector("title")?.textContent);
      expect(titled.some((text) => text?.includes("Central"))).toBe(true);
      expect(titled.some((text) => text?.includes("Fairway"))).toBe(true);
    });

    it("does not highlight when no interchange connects to the route", () => {
      const { container } = renderOverlay(
        [{ id: "central", name: "Central" }],
        [makeInterchange("fairway", "Fairway")],
      );
      expect(container.querySelectorAll(".connecting-interchange-highlight").length).toBe(0);
    });
  });
});

describe("anchorKey (engine anchor-key grammar)", () => {
  // One canonical statement of the shared grammar: case-folded with
  // whitespace, hyphens, underscores, dots, and apostrophes stripped.
  it.each([
    ["Finch", "finch"],
    ["Sheppard-Yonge", "sheppardyonge"],
    ["_Bloor_Yonge_", "blooryonge"],
    ["St. George", "stgeorge"],
    ["Queen's Park", "queenspark"],
    ["O'Connor", "oconnor"],
    ["\tSt.  Clair West \n", "stclairwest"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(anchorKey(input)).toBe(expected);
  });
});
