// @vitest-environment happy-dom
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { flush } from "solid-js";
import { render, cleanup, screen } from "@solidjs/testing-library";
import type { MapViewportConfig } from "~/components/map/viewport";
import { createMapViewport } from "~/components/map/viewport";
import {
  cameraTransform,
  computeZoomAtPoint,
  viewBoxPlacement,
} from "~/components/map/viewport/transform";
import { useMobileViewport } from "~/hooks/useMobileViewport";
import { buildMapModel } from "~/core/map";
import { makeTestSchematic } from "../helpers/agency-fixtures";
import type { RouteShape, SurfaceStop } from "~/domain/surface/types";

type Viewport = ReturnType<typeof createMapViewport>;
const testTopology = buildMapModel(makeTestSchematic());
const testCamera = testTopology.camera;

let fireContainerResize: ((width: number, height: number) => void) | undefined;
let initialResizeSize = { width: 1200, height: 800 };

class FakeResizeObserver {
  private disconnected = false;
  private emit: (width: number, height: number) => void;

  constructor(callback: ResizeObserverCallback) {
    this.emit = fireContainerResize = (width, height) => {
      callback(
        [
          {
            contentRect: {
              width,
              height,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              right: width,
              bottom: height,
            },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      flush();
    };
  }

  observe(): void {
    const size = initialResizeSize;
    queueMicrotask(() => {
      if (!this.disconnected) this.emit(size.width, size.height);
    });
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }
}

vi.stubGlobal("ResizeObserver", FakeResizeObserver);

const FIT_CONFIG: MapViewportConfig = {
  viewBoxWidth: 1000,
  viewBoxHeight: 500,
  minZoom: 0.5,
  maxZoom: 4,
  initialZoom: 1,
  initialPan: { x: 0, y: 0 },
  fitTransform: (width, height) => ({
    zoom: Math.min(width / 1000, height / 500),
    pan: { x: 0, y: 0 },
  }),
};

const routeShape = (directionId: number): RouteShape => ({
  id: `504_${directionId}`,
  routeId: "504",
  directionId,
  headsign: directionId === 0 ? "Eastbound" : "Westbound",
  polyline: "",
  minLat: 43.65,
  maxLat: 43.69,
  minLon: -79.47,
  maxLon: -79.3,
  pointCount: 2,
});

const routeStops: SurfaceStop[] = [
  {
    id: "west",
    name: "West",
    lat: 43.654,
    lon: -79.467,
    wheelchair: 1,
    routes: ["504"],
  },
  {
    id: "east",
    name: "East",
    lat: 43.689,
    lon: -79.3015,
    wheelchair: 1,
    routes: ["504"],
  },
];

function routeConfig(prefersReducedMotion: () => boolean): MapViewportConfig {
  return {
    ...FIT_CONFIG,
    geometry: testTopology.geometry,
    getFraming: (bounds, size) => testCamera.computeTargetViewport(bounds, size),
    prefersReducedMotion,
  };
}

function stubElementRect(width = 1200, height = 800): void {
  initialResizeSize = { width, height };
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
    () =>
      ({
        width,
        height,
        left: 0,
        top: 0,
        right: width,
        bottom: height,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      }) as DOMRect,
  );
}

async function mountViewport(config: MapViewportConfig = FIT_CONFIG): Promise<Viewport> {
  stubElementRect();
  const host = document.createElement("div");
  document.body.append(host);
  let viewport: Viewport | undefined;
  render(() => {
    viewport = createMapViewport(() => host, config);
    return null;
  });
  const captured = viewport!;
  await vi.waitFor(() => expect(captured.isReady()).toBe(true));
  return captured;
}

async function captureCamera(viewport: Viewport) {
  return {
    zoom: viewport.zoom(),
    pan: { ...viewport.pan() },
    manual: viewport.hasManualTransform(),
  };
}

beforeEach(() => {
  initialResizeSize = { width: 1200, height: 800 };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("createMapViewport — manual-transform bookkeeping", () => {
  it("fits from the first resize measurement without forcing layout during startup", async () => {
    stubElementRect();
    const readRect = vi.mocked(HTMLElement.prototype.getBoundingClientRect);
    const host = document.createElement("div");
    document.body.append(host);
    let viewport!: Viewport;
    render(() => {
      viewport = createMapViewport(() => host, FIT_CONFIG);
      return null;
    });

    expect(readRect).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(viewport.isReady()).toBe(true));
    expect(viewport.containerSize()).toEqual({ width: 1200, height: 800 });
    expect(viewport.zoom()).toBe(1.2);
  });
  it("auto-refits on container resize while the camera is untouched", async () => {
    const viewport = await mountViewport();

    fireContainerResize!(600, 400);

    expect(viewport.zoom()).toBe(0.6);
  });

  it("zooms at the wheel position and marks the camera manual", async () => {
    stubElementRect();
    const host = document.createElement("div");
    document.body.append(host);
    let viewport: Viewport | undefined;
    render(() => {
      viewport = createMapViewport(() => host, FIT_CONFIG);
      return null;
    });
    await vi.waitFor(() => expect(viewport!.isReady()).toBe(true));
    const before = viewport!.zoom();

    host.dispatchEvent(new WheelEvent("wheel", { deltaY: -100, clientX: 500, clientY: 300 }));

    expect(viewport!.zoom()).toBeGreaterThan(before);
    expect(viewport!.hasManualTransform()).toBe(true);
  });

  it("resetViewport restores the topology fit and clears manual state", async () => {
    const viewport = await mountViewport();
    viewport.zoomFromCenter(2);

    viewport.resetViewport();

    expect(viewport.zoom()).toBe(1.2);
    expect(viewport.pan()).toEqual({ x: 0, y: 0 });
    expect(viewport.hasManualTransform()).toBe(false);
  });

  it("keeps resize auto-refit active after programmatic setCamera writes", async () => {
    const viewport = await mountViewport();

    viewport.setCamera({ zoom: 2, pan: { x: 40, y: 12 } });

    expect(viewport.zoom()).toBe(2);
    expect(viewport.hasManualTransform()).toBe(false);

    fireContainerResize!(600, 400);

    expect(viewport.zoom()).toBe(0.6);
  });

  it("disables resize auto-refit once the user gestures the camera", async () => {
    const viewport = await mountViewport();

    viewport.zoomFromCenter(2);
    const zoomAfterGesture = viewport.zoom();

    fireContainerResize!(600, 400);

    expect(viewport.hasManualTransform()).toBe(true);
    expect(viewport.zoom()).toBe(zoomAfterGesture);
  });

  it("restores the manual flag alongside the camera when exiting a targeted session", async () => {
    const viewport = await mountViewport();

    viewport.zoomFromCenter(2);
    const saved = await captureCamera(viewport);

    // Targeted-mode framing animates through the manual setters.
    viewport.setZoom(3);
    viewport.setPan({ x: 7, y: 9 });

    viewport.setCamera({ zoom: saved.zoom, pan: saved.pan }, { manual: saved.manual });

    expect(viewport.zoom()).toBe(saved.zoom);
    expect(viewport.hasManualTransform()).toBe(true);
  });

  it("re-arms auto-refit when the restored snapshot predates any manual gesture", async () => {
    const viewport = await mountViewport();

    const saved = await captureCamera(viewport);

    // Targeted-mode framing flags the camera manual…
    viewport.setZoom(3);
    expect(viewport.hasManualTransform()).toBe(true);

    // …but the restore puts back exactly what the session began with.
    viewport.setCamera({ zoom: saved.zoom, pan: saved.pan }, { manual: saved.manual });

    expect(viewport.hasManualTransform()).toBe(false);

    fireContainerResize!(600, 400);

    expect(viewport.zoom()).toBe(0.6);
  });

  it("derives fitTransform directly from topology geometry", async () => {
    stubElementRect();
    const host = document.createElement("div");
    document.body.append(host);
    let viewport: Viewport | undefined;
    const topologyConfig: MapViewportConfig = {
      viewBoxWidth: 1000,
      viewBoxHeight: 500,
      minZoom: 0.5,
      maxZoom: 4,
      initialZoom: 1,
      initialPan: { x: 0, y: 0 },
      fitTransform: (w, h) => ({
        zoom: Math.min(w / 1000, h / 500),
        pan: { x: 10, y: 20 },
      }),
    };
    render(() => {
      viewport = createMapViewport(() => host, topologyConfig);
      return null;
    });
    await vi.waitFor(() => expect(viewport!.isReady()).toBe(true));
    expect(viewport!.zoom()).toBe(1.2);
    expect(viewport!.pan()).toEqual({ x: 10, y: 20 });
  });

  it("centers a destination station without changing the current zoom", async () => {
    const viewport = await mountViewport();
    viewport.setZoom(2);

    viewport.centerOnPoint({ x: 300, y: 100 });

    expect(viewport.zoom()).toBe(2);
    expect(viewport.pan()).toEqual({ x: -100, y: 50 });
    expect(viewport.hasManualTransform()).toBe(true);
  });

  it.each([
    ["centerOnPoint", (viewport: Viewport) => viewport.centerOnPoint({ x: 300, y: 100 })],
    [
      "placePointAtContainerPoint",
      (viewport: Viewport) =>
        viewport.placePointAtContainerPoint({ x: 300, y: 100 }, { x: 420, y: 260 }),
    ],
  ])("%s cancels active framing before a same-zoom camera write", async (_name, command) => {
    vi.useFakeTimers();
    const viewport = await mountViewport(routeConfig(() => false));
    viewport.frameRoute(routeShape(0), routeStops);
    expect(viewport.isAnimating()).toBe(true);

    const zoomBeforeCommand = viewport.zoom();
    command(viewport);

    const panAfterCommand = { ...viewport.pan() };
    expect(viewport.isAnimating()).toBe(false);
    vi.advanceTimersByTime(500);
    expect(viewport.zoom()).toBe(zoomBeforeCommand);
    expect(viewport.pan()).toEqual(panAfterCommand);
  });

  it("places a destination station at an existing container position without changing zoom", async () => {
    const viewport = await mountViewport();
    viewport.setZoom(2);

    viewport.placePointAtContainerPoint({ x: 300, y: 100 }, { x: 420, y: 260 });

    expect(viewport.zoom()).toBe(2);
    expect(viewport.pan().x).toBeCloseTo(-250);
    expect(viewport.pan().y).toBeCloseTo(-66.6666667);
    expect(viewport.hasManualTransform()).toBe(true);
  });

  it("pans through the pointer down, move, and up lifecycle", async () => {
    vi.useFakeTimers();
    const viewport = await mountViewport();
    const host = document.createElement("div");

    viewport.pointerHandlers.onPointerDown({
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 100,
      currentTarget: host,
    } as unknown as PointerEvent);
    viewport.pointerHandlers.onPointerMove({
      pointerId: 1,
      clientX: 140,
      clientY: 130,
      currentTarget: host,
    } as unknown as PointerEvent);
    vi.advanceTimersByTime(20);

    expect(viewport.isDragging()).toBe(true);
    expect(viewport.hasMovedDistance()).toBe(true);
    expect(viewport.pan()).not.toEqual({ x: 0, y: 0 });

    viewport.pointerHandlers.onPointerUp({
      pointerId: 1,
      clientX: 140,
      clientY: 130,
      currentTarget: host,
    } as unknown as PointerEvent);

    expect(viewport.isDragging()).toBe(false);
  });

  it("reports an unsuccessful placement while the container has no geometry", async () => {
    vi.restoreAllMocks();
    stubElementRect(0, 0);
    const host = document.createElement("div");
    document.body.append(host);
    let viewport: Viewport | undefined;

    render(() => {
      viewport = createMapViewport(() => host, FIT_CONFIG);
      return null;
    });

    expect(viewport!.placePointAtContainerPoint({ x: 300, y: 100 }, { x: 420, y: 260 })).toBe(
      false,
    );
  });
});

describe("createMapViewport — targeted route lifecycle", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("frames the route shape and stops through the public route command", async () => {
    const bounds = {
      minX: 10,
      maxX: 80,
      minY: 20,
      maxY: 100,
      width: 70,
      height: 80,
      centerX: 45,
      centerY: 60,
    };
    const target = { zoom: 2.4, pan: { x: -12, y: 18 } };
    const extractRouteMapPoints = vi.fn(() => [{ x: 10, y: 20 }]);
    const computeRouteBoundingBox = vi.fn(() => bounds);
    const getFraming = vi.fn(() => target);
    const geometry = {
      snapCutoffRatio: 0,
      extractRouteMapPoints,
      computeRouteBoundingBox,
      projectGeoBoundingBoxToMapBounds: vi.fn(() => bounds),
      projectGeoToMapPoint: vi.fn(),
      drawnLineMapPoints: vi.fn(),
    };
    const viewport = await mountViewport({
      ...FIT_CONFIG,
      geometry,
      getFraming,
      prefersReducedMotion: () => true,
    });

    viewport.frameRoute(routeShape(0), routeStops);

    expect(extractRouteMapPoints).toHaveBeenCalledWith(routeShape(0), routeStops);
    expect(computeRouteBoundingBox).toHaveBeenCalledWith([{ x: 10, y: 20 }]);
    expect(getFraming).toHaveBeenCalledWith(bounds, viewport.containerSize());
    expect(viewport.isAnimating()).toBe(false);
    expect(viewport.zoom()).toBe(target.zoom);
    expect(viewport.pan()).toEqual(target.pan);
    expect(viewport.hasManualTransform()).toBe(false);
  });

  it("frames a drawn route by its drawn line, not by the trip's projected shape", async () => {
    // The rider enlarged a route the schematic draws, so the route they asked to
    // see is the drawn line. Framing the trip's own shape instead framed a
    // fraction of it: on GO, twelve of sixteen rail directions zoomed to the
    // maximum on a stub because the drawn line spans 540 units where the same
    // stations project to 314.
    const drawnBounds = {
      minX: 0,
      maxX: 540,
      minY: 300,
      maxY: 375,
      width: 540,
      height: 75,
      centerX: 270,
      centerY: 337.5,
    };
    const shapeBounds = { ...drawnBounds, width: 97, height: 20, minX: 100, maxX: 197 };
    const target = { zoom: 1.6, pan: { x: 4, y: -2 } };
    const drawnLineMapPoints = vi.fn(() => [
      { x: 0, y: 300 },
      { x: 540, y: 375 },
    ]);
    const extractRouteMapPoints = vi.fn(() => [
      { x: 100, y: 300 },
      { x: 197, y: 320 },
    ]);
    const computeRouteBoundingBox = vi.fn(
      (points: readonly ({ x: number; y: number } | [number, number])[]) =>
        points === drawnLineMapPoints.mock.results[0]!.value ? drawnBounds : shapeBounds,
    );
    const getFraming = vi.fn(() => target);
    const viewport = await mountViewport({
      ...FIT_CONFIG,
      geometry: {
        snapCutoffRatio: 0,
        extractRouteMapPoints,
        computeRouteBoundingBox,
        projectGeoBoundingBoxToMapBounds: vi.fn(),
        projectGeoToMapPoint: vi.fn(),
        drawnLineMapPoints,
      },
      getFraming,
      activeLineId: () => "LW",
      prefersReducedMotion: () => true,
    });

    viewport.frameRoute(routeShape(0), routeStops);

    expect(drawnLineMapPoints).toHaveBeenCalledWith("LW");
    expect(getFraming).toHaveBeenCalledWith(drawnBounds, viewport.containerSize());
    expect(extractRouteMapPoints).not.toHaveBeenCalled();
    expect(viewport.zoom()).toBe(target.zoom);
  });

  it("frames the trip shape when the schematic draws no line for the route", async () => {
    // Every bus route at every agency lands here, so the fallback is the common
    // case rather than an edge: with no line to draw, the trip's own shape is the
    // only description of where the route goes that exists.
    const bounds = {
      minX: 10,
      maxX: 80,
      minY: 20,
      maxY: 100,
      width: 70,
      height: 80,
      centerX: 45,
      centerY: 60,
    };
    const target = { zoom: 2.4, pan: { x: -12, y: 18 } };
    const extractRouteMapPoints = vi.fn(() => [{ x: 10, y: 20 }]);
    const computeRouteBoundingBox = vi.fn(() => bounds);
    const getFraming = vi.fn(() => target);
    const viewport = await mountViewport({
      ...FIT_CONFIG,
      geometry: {
        snapCutoffRatio: 0,
        extractRouteMapPoints,
        computeRouteBoundingBox,
        projectGeoBoundingBoxToMapBounds: vi.fn(),
        projectGeoToMapPoint: vi.fn(),
        drawnLineMapPoints: vi.fn(() => undefined),
      },
      getFraming,
      activeLineId: () => "504",
      prefersReducedMotion: () => true,
    });

    viewport.frameRoute(routeShape(0), routeStops);

    expect(extractRouteMapPoints).toHaveBeenCalledWith(routeShape(0), routeStops, {
      lineId: "504",
    });
    expect(getFraming).toHaveBeenCalledWith(bounds, viewport.containerSize());
  });

  it("falls back to the shape geographic bounds when no route points are available", async () => {
    const bounds = {
      minX: 10,
      maxX: 80,
      minY: 20,
      maxY: 100,
      width: 70,
      height: 80,
      centerX: 45,
      centerY: 60,
    };
    const target = { zoom: 2.4, pan: { x: -12, y: 18 } };
    const projectGeoBoundingBoxToMapBounds = vi.fn(() => bounds);
    const geometry = {
      snapCutoffRatio: 0,
      extractRouteMapPoints: vi.fn(() => []),
      computeRouteBoundingBox: vi.fn(),
      projectGeoBoundingBoxToMapBounds,
      projectGeoToMapPoint: vi.fn(),
      drawnLineMapPoints: vi.fn(),
    };
    const getFraming = vi.fn(() => target);
    const viewport = await mountViewport({
      ...FIT_CONFIG,
      geometry,
      getFraming,
      prefersReducedMotion: () => true,
    });

    viewport.frameRoute(routeShape(0), routeStops);

    expect(projectGeoBoundingBoxToMapBounds).toHaveBeenCalledWith(routeShape(0));
    expect(getFraming).toHaveBeenCalledWith(bounds, viewport.containerSize());
    expect(viewport.zoom()).toBe(target.zoom);
    expect(viewport.pan()).toEqual(target.pan);
  });

  it("captures the entry camera once and restores it after targeted mode", async () => {
    const viewport = await mountViewport(routeConfig(() => true));
    viewport.setZoom(1.8);
    viewport.setPan({ x: 42, y: -18 });
    const saved = await captureCamera(viewport);

    viewport.enterTargetedMode();
    viewport.frameRoute(routeShape(0), routeStops);
    viewport.setCamera({ zoom: 3, pan: { x: 9, y: 10 } });
    viewport.enterTargetedMode();
    viewport.exitTargetedMode();

    expect(await captureCamera(viewport)).toEqual(saved);
  });

  it("restores an untouched camera as non-manual", async () => {
    const viewport = await mountViewport(routeConfig(() => true));
    const initial = await captureCamera(viewport);

    viewport.enterTargetedMode();
    viewport.frameRoute(routeShape(0), routeStops);
    viewport.exitTargetedMode();

    expect(await captureCamera(viewport)).toEqual(initial);
  });

  it("does not change the restored camera when targeted exit is repeated", async () => {
    const viewport = await mountViewport(routeConfig(() => true));
    viewport.setZoom(1.8);
    viewport.setPan({ x: 42, y: -18 });

    viewport.enterTargetedMode();
    viewport.frameRoute(routeShape(0), routeStops);
    viewport.exitTargetedMode();
    const restored = await captureCamera(viewport);

    viewport.exitTargetedMode();

    expect(await captureCamera(viewport)).toEqual(restored);
  });

  it("resets the camera when targeted mode has no saved session", async () => {
    const viewport = await mountViewport(routeConfig(() => true));
    viewport.setZoom(2);
    viewport.exitTargetedMode();

    expect(viewport.hasManualTransform()).toBe(false);
    expect(viewport.zoom()).toBe(1.2);
  });

  it("resetViewport cancels active framing before restoring the fit", async () => {
    vi.useFakeTimers();
    const viewport = await mountViewport(routeConfig(() => false));
    viewport.frameRoute(routeShape(0), routeStops);
    expect(viewport.isAnimating()).toBe(true);

    viewport.resetViewport();

    expect(viewport.isAnimating()).toBe(false);
    expect(viewport.zoom()).toBe(1.2);
  });

  it("animates for 400ms, converges to the fit camera, and exposes cancellation", async () => {
    vi.useFakeTimers();
    const viewport = await mountViewport(routeConfig(() => false));
    const expected = testCamera.computeTargetViewport(
      testTopology.geometry.computeRouteBoundingBox(
        testTopology.geometry.extractRouteMapPoints(routeShape(1), routeStops),
      ),
      viewport.containerSize(),
    );

    viewport.frameRoute(routeShape(1), routeStops);
    expect(viewport.isAnimating()).toBe(true);
    vi.advanceTimersByTime(420);

    expect(viewport.isAnimating()).toBe(false);
    expect(viewport.zoom()).toBeCloseTo(expected!.zoom);
    expect(viewport.pan()).toEqual(expected!.pan);

    viewport.frameRoute(routeShape(0), routeStops);
    expect(viewport.isAnimating()).toBe(true);
    viewport.setZoom(viewport.zoom() + 0.1);
    expect(viewport.isAnimating()).toBe(false);
  });

  it("cancels framing as soon as a user starts dragging", async () => {
    vi.useFakeTimers();
    const viewport = await mountViewport(routeConfig(() => false));
    const host = document.createElement("div");

    viewport.frameRoute(routeShape(0), routeStops);
    expect(viewport.isAnimating()).toBe(true);

    viewport.pointerHandlers.onPointerDown({
      pointerId: 1,
      pointerType: "touch",
      button: 0,
      clientX: 100,
      clientY: 100,
      currentTarget: host,
    } as unknown as PointerEvent);

    expect(viewport.isAnimating()).toBe(false);
  });

  it("retries a zero-sized container once and stops if it remains unavailable", async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    stubElementRect(0, 0);
    const host = document.createElement("div");
    document.body.append(host);
    let viewport: Viewport | undefined;
    render(() => {
      viewport = createMapViewport(
        () => host,
        routeConfig(() => true),
      );
      return null;
    });
    const request = vi.spyOn(globalThis, "requestAnimationFrame");

    viewport!.frameRoute(routeShape(0), routeStops);
    vi.advanceTimersByTime(100);

    expect(request).toHaveBeenCalledTimes(1);
    expect(viewport!.isAnimating()).toBe(false);
  });

  it("completes the bounded retry when the container becomes measurable", async () => {
    vi.useFakeTimers();
    vi.restoreAllMocks();
    let width = 0;
    let height = 0;
    initialResizeSize = { width, height };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width,
          height,
          left: 0,
          top: 0,
          right: width,
          bottom: height,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
    const host = document.createElement("div");
    document.body.append(host);
    const target = { zoom: 2.4, pan: { x: -12, y: 18 } };
    const getFraming = vi.fn(() => target);
    let viewport: Viewport | undefined;
    render(() => {
      viewport = createMapViewport(() => host, {
        ...routeConfig(() => true),
        getFraming,
      });
      return null;
    });

    viewport!.frameRoute(routeShape(0), routeStops);
    width = 1200;
    height = 800;
    fireContainerResize!(width, height);
    vi.advanceTimersByTime(100);

    expect(getFraming).toHaveBeenCalledWith(expect.anything(), { width, height });
    expect(viewport!.zoom()).toBe(target.zoom);
    expect(viewport!.pan()).toEqual(target.pan);
  });

  it("cancels a pending framing animation when the viewport is disposed", async () => {
    vi.useFakeTimers();
    stubElementRect();
    const host = document.createElement("div");
    document.body.append(host);
    let viewport: Viewport | undefined;
    const mounted = render(() => {
      viewport = createMapViewport(
        () => host,
        routeConfig(() => false),
      );
      return null;
    });
    await vi.waitFor(() => expect(viewport!.isReady()).toBe(true));
    viewport!.frameRoute(routeShape(0), routeStops);
    const cancel = vi.spyOn(globalThis, "cancelAnimationFrame");

    mounted.unmount();

    expect(cancel).toHaveBeenCalled();
  });
});

describe("viewBoxPlacement", () => {
  it("scales by the limiting dimension and centers the other axis letterboxing style", () => {
    const wide = viewBoxPlacement({ width: 1200, height: 800 }, 800, 600);
    expect(wide.scale).toBeCloseTo(800 / 600);
    expect(wide.offsetY).toBe(0);
    expect(wide.offsetX).toBeCloseTo((1200 - 800 * (800 / 600)) / 2);

    const tall = viewBoxPlacement({ width: 600, height: 1200 }, 800, 600);
    expect(tall.scale).toBeCloseTo(600 / 800);
    expect(tall.offsetX).toBe(0);
    expect(tall.offsetY).toBeCloseTo((1200 - 600 * (600 / 800)) / 2);
  });
});

describe("computeZoomAtPoint", () => {
  const identityPlacement = { scale: 1, offsetX: 0, offsetY: 0 };

  it("keeps the anchored container point pinned to the same map coordinate", () => {
    const before = { zoom: 1, pan: { x: -40, y: 20 } };
    const anchor = { x: 500, y: 300 };

    const after = computeZoomAtPoint({
      camera: before,
      factor: 2,
      containerPoint: anchor,
      placement: identityPlacement,
      minZoom: 0.5,
      maxZoom: 8,
    })!;

    expect(after.zoom).toBe(2);
    const mapBefore = {
      x: (anchor.x - identityPlacement.offsetX) / identityPlacement.scale - before.pan.x,
      y: (anchor.y - identityPlacement.offsetY) / identityPlacement.scale - before.pan.y,
    };
    const mapAfter = {
      x: (anchor.x - after.pan.x) / after.zoom,
      y: (anchor.y - after.pan.y) / after.zoom,
    };
    expect(mapAfter.x).toBeCloseTo(mapBefore.x);
    expect(mapAfter.y).toBeCloseTo(mapBefore.y);
  });

  it("reports no movement when the factor is neutralized by the clamp bounds", () => {
    const camera = { zoom: 8, pan: { x: 0, y: 0 } };
    const next = computeZoomAtPoint({
      camera,
      factor: 2,
      containerPoint: { x: 10, y: 10 },
      placement: identityPlacement,
      minZoom: 0.5,
      maxZoom: 8,
    });
    expect(next).toBeNull();
  });

  it("honors letterboxed placement when converting the anchor into map space", () => {
    const placement = { scale: 2, offsetX: 100, offsetY: 50 };
    const camera = { zoom: 1, pan: { x: 0, y: 0 } };

    const next = computeZoomAtPoint({
      camera,
      factor: 3,
      containerPoint: { x: 200, y: 150 },
      placement,
      minZoom: 0.5,
      maxZoom: 8,
    })!;

    expect(next.zoom).toBe(3);
    expect(next.pan.x).toBeCloseTo(50 - 3 * (50 - 0));
    expect(next.pan.y).toBeCloseTo(50 - 3 * (50 - 0));
  });
});

describe("cameraTransform", () => {
  it("serializes pan then scale in SVG transform order", () => {
    expect(cameraTransform(1.25, { x: 12, y: -3 })).toBe("translate(12, -3) scale(1.25)");
  });
});

interface TestMediaQueryList extends MediaQueryList {
  emit(matches: boolean): void;
}

function createTestMediaQueryList(initialMatches: boolean): TestMediaQueryList {
  let matches = initialMatches;
  const listeners = new Set<(event: MediaQueryListEvent) => void>();

  return {
    get matches() {
      return matches;
    },
    media: "(max-width: 767px)",
    onchange: null,
    addEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") {
        listeners.add(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    removeEventListener: vi.fn((_type: string, listener: EventListenerOrEventListenerObject) => {
      if (typeof listener === "function") {
        listeners.delete(listener as (event: MediaQueryListEvent) => void);
      }
    }),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => true),
    emit(nextMatches: boolean) {
      matches = nextMatches;
      const event = { matches: nextMatches, media: this.media } as MediaQueryListEvent;
      for (const listener of listeners) listener(event);
    },
  };
}

function ViewportProbe() {
  const isMobile = useMobileViewport();
  return <span data-testid="viewport">{isMobile() ? "mobile" : "desktop"}</span>;
}

describe("useMobileViewport", () => {
  it("tracks media-query changes and removes its listener on cleanup", () => {
    const mediaQuery = createTestMediaQueryList(true);
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => mediaQuery),
    );

    const { unmount } = render(() => <ViewportProbe />);

    expect(screen.getByTestId("viewport").textContent).toBe("mobile");

    mediaQuery.emit(false);
    flush();

    expect(screen.getByTestId("viewport").textContent).toBe("desktop");

    unmount();
    expect(mediaQuery.removeEventListener).toHaveBeenCalledOnce();
  });
});
