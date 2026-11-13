// @vitest-environment happy-dom
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, cleanup } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { createSelectionController } from "~/components/map/controllers/SelectionController";
import type { LiveVehiclePosition, SurfaceStop } from "~/domain/surface/types";
import type { Point } from "~/core/map";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function run<T>(body: () => T): T {
  let out: T;
  render(() => {
    out = body();
    return null;
  });
  return out!;
}

const vehicle = (id: string): LiveVehiclePosition =>
  ({
    vehicleId: id,
    directionId: 0,
    speed: 1,
    occupancyStatus: "fewSeatsAvailable",
    position: { latitude: 0, longitude: 0 },
  }) as unknown as LiveVehiclePosition;

const surfaceStop = (id: string): SurfaceStop =>
  ({ id, name: `Stop ${id}` }) as unknown as SurfaceStop;

describe("SelectionController", () => {
  const controllerInput = (options?: { dragged?: boolean; mapPoint?: Point | null }) => ({
    hasMovedDistance: () => options?.dragged ?? false,
    camera: () => ({ width: 1200, height: 800, zoom: 1, pan: { x: 0, y: 0 } }),
    transformContainerPointToMap: () => options?.mapPoint ?? null,
    containerRect: () => ({ left: 0, top: 0 }),
  });

  it("toggleStation selects a station and moves focus to the popover", async () => {
    await run(async () => {
      const selection = createSelectionController(controllerInput());
      const popover = document.createElement("div");
      const focusPopover = vi.spyOn(popover, "focus");
      selection.setPopoverElement(popover);

      selection.toggleStation("museum");
      // Solid 2 stages writes: commit before asserting accessors, and before
      // the queued focus microtask reads the committed popover element.
      flush();

      expect(selection.selectedStationId()).toBe("museum");
      await Promise.resolve();
      expect(focusPopover).toHaveBeenCalled();
      expect(selection.selectedSegmentId()).toBeNull();
    });
  });

  it("deselecting restores focus to the previously selected station node", async () => {
    await run(async () => {
      const selection = createSelectionController(controllerInput());
      const stationNode = document.createElement("button");
      Object.defineProperty(stationNode, "focus", { value: vi.fn() });
      selection.registerStationElement("museum", stationNode as unknown as SVGGElement);

      selection.selectStation("museum");
      await Promise.resolve();
      selection.selectStation(null);
      await Promise.resolve();

      expect(selection.selectedStationId()).toBeNull();
      expect(stationNode.focus).toHaveBeenCalled();
    });
  });

  it("ignores taps once the pointer has dragged the map", () => {
    run(() => {
      const selection = createSelectionController(controllerInput({ dragged: true }));

      selection.toggleStation("museum");
      selection.toggleSegment("seg-1");
      selection.toggleLine("1");

      expect(selection.selectedStationId()).toBeNull();
      expect(selection.selectedSegmentId()).toBeNull();
      expect(selection.hoveredLineId()).toBeNull();
    });
  });

  it("station and segment selection are mutually exclusive", () => {
    run(() => {
      const selection = createSelectionController(controllerInput({ mapPoint: { x: 3, y: 4 } }));

      selection.toggleSegment("seg-1", { clientX: 3, clientY: 4 });
      flush();
      expect(selection.selectedSegmentId()).toBe("seg-1");
      expect(selection.segmentClickMapPoint()).toEqual({ x: 3, y: 4 });

      selection.toggleStation("museum");
      flush();
      expect(selection.selectedStationId()).toBe("museum");
      expect(selection.selectedSegmentId()).toBeNull();
      expect(selection.segmentClickMapPoint()).toBeNull();
    });
  });

  it("toggleSegment deselects when the same segment is tapped again", () => {
    run(() => {
      const selection = createSelectionController(controllerInput());

      selection.toggleSegment("seg-1");
      selection.toggleSegment("seg-1");

      expect(selection.selectedSegmentId()).toBeNull();
      expect(selection.segmentClickMapPoint()).toBeNull();
    });
  });

  it("surface vehicle and stop selection are mutually exclusive", () => {
    run(() => {
      const selection = createSelectionController(controllerInput());
      const point = { x: 1, y: 2 };

      selection.selectVehicle(vehicle("v1"), point);
      flush();
      expect(selection.selectedSurfaceVehicle()?.vehicle.vehicleId).toBe("v1");

      selection.selectStop(surfaceStop("s1"), point);
      flush();
      expect(selection.selectedSurfaceVehicle()).toBeNull();
      expect(selection.selectedSurfaceStop()?.stop.id).toBe("s1");

      selection.selectVehicle(vehicle("v1"), point);
      flush();
      expect(selection.selectedSurfaceStop()).toBeNull();
    });
  });

  it("re-tapping the same vehicle deselects it", () => {
    run(() => {
      const selection = createSelectionController(controllerInput());
      const point = { x: 1, y: 2 };

      selection.selectVehicle(vehicle("v1"), point);
      selection.selectVehicle(vehicle("v1"), point);

      expect(selection.selectedSurfaceVehicle()).toBeNull();
    });
  });

  it("clearSelection resets every selection axis including surface picks", () => {
    run(() => {
      const selection = createSelectionController(controllerInput());
      const point = { x: 1, y: 2 };

      selection.toggleStation("museum");
      selection.toggleSegment("seg-1");
      selection.hoverLine("2");
      selection.selectVehicle(vehicle("v1"), point);

      selection.clearSelection();

      expect(selection.selectedStationId()).toBeNull();
      expect(selection.selectedSegmentId()).toBeNull();
      expect(selection.hoveredLineId()).toBeNull();
      expect(selection.selectedSurfaceVehicle()).toBeNull();
    });
  });

  it("clearSurfaceSelection leaves station and line hover untouched", () => {
    run(() => {
      const selection = createSelectionController(controllerInput());
      const point = { x: 1, y: 2 };

      selection.toggleStation("museum");
      selection.hoverLine("2");
      selection.selectVehicle(vehicle("v1"), point);
      flush();

      selection.clearSurfaceSelection();
      flush();

      expect(selection.selectedStationId()).toBe("museum");
      expect(selection.hoveredLineId()).toBe("2");
      expect(selection.selectedSurfaceVehicle()).toBeNull();
      expect(selection.selectedSurfaceStop()).toBeNull();
    });
  });
});
