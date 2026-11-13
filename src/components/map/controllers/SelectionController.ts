import { createSignal, type Accessor } from "solid-js";
import type { LiveVehiclePosition, SurfaceStop } from "~/domain/surface/types";
import type { MapCamera } from "~/core/map";
import type { Point } from "~/core/map";

/**
 * Owns every "what is the user looking at" decision on the map:
 * station/segment/line selection, surface vehicle and stop picks, popover
 * focus management. The canvas component renders whatever this reports.
 */

export interface SelectedSurfaceVehicle {
  readonly vehicle: LiveVehiclePosition;
  readonly point: Point;
}

export interface SelectedSurfaceStop {
  readonly stop: SurfaceStop;
  readonly point: Point;
}

export interface ContainerRect {
  readonly left: number;
  readonly top: number;
}

export function createSelectionController(input: {
  readonly hasMovedDistance: Accessor<boolean>;
  readonly camera: Accessor<MapCamera>;
  /** Container-point (client-relative) → map point; null when outside viewBox. */
  readonly transformContainerPointToMap: (
    containerPoint: Point,
    camera: MapCamera,
  ) => Point | null | undefined;
  readonly containerRect: Accessor<ContainerRect | null>;
}) {
  const [selectedStationId, setSelectedStationId] = createSignal<string | null>(null, {
    ownedWrite: true,
  });

  const [selectedSegmentId, setSelectedSegmentId] = createSignal<string | null>(null, {
    ownedWrite: true,
  });

  const [segmentClickMapPoint, setSegmentClickMapPoint] = createSignal<Point | null>(null, {
    ownedWrite: true,
  });

  const [selectedSurfaceVehicle, setSelectedSurfaceVehicle] =
    createSignal<SelectedSurfaceVehicle | null>(null, { ownedWrite: true });

  const [selectedSurfaceStop, setSelectedSurfaceStop] = createSignal<SelectedSurfaceStop | null>(
    null,
    { ownedWrite: true },
  );

  const [selectedLineId, setSelectedLineId] = createSignal<string | null>(null, {
    ownedWrite: true,
  });

  const [hoveredLineId, setHoveredLineId] = createSignal<string | null>(null, {
    ownedWrite: true,
  });

  const [popoverElement, setPopoverElementRaw] = createSignal<HTMLDivElement | undefined>(
    undefined,
    { ownedWrite: true },
  );
  const setPopoverElement = (el?: HTMLDivElement) => {
    setPopoverElementRaw(el);
  };

  const stationElements = new Map<string, SVGGElement>();

  let lastFocusedStationId: string | null = null;

  const selectStation = (stationId: string | null) => {
    setSelectedSegmentId(null);
    setSegmentClickMapPoint(null);
    setSelectedStationId(stationId);

    if (stationId) {
      lastFocusedStationId = stationId;
      queueMicrotask(() => {
        popoverElement()?.focus();
      });
    } else if (lastFocusedStationId) {
      const previousId = lastFocusedStationId;
      lastFocusedStationId = null;
      queueMicrotask(() => {
        stationElements.get(previousId)?.focus();
      });
    }
  };

  const toggleStation = (stationId: string) => {
    if (input.hasMovedDistance()) {
      return;
    }

    selectStation(selectedStationId() === stationId ? null : stationId);
  };

  const toggleSegment = (id: string, clickPosition?: { clientX: number; clientY: number }) => {
    if (input.hasMovedDistance()) {
      return;
    }

    // Compare before selectStation clears the id, otherwise the second tap
    // on the same segment would read null and re-select instead of closing.
    const wasSelected = selectedSegmentId() === id;

    selectStation(null);

    if (wasSelected) {
      setSelectedSegmentId(null);
      setSegmentClickMapPoint(null);
      return;
    }

    if (clickPosition) {
      const rect = input.containerRect();
      if (rect) {
        const mapPoint = input.transformContainerPointToMap(
          {
            x: clickPosition.clientX - rect.left,
            y: clickPosition.clientY - rect.top,
          },
          input.camera(),
        );
        setSegmentClickMapPoint(mapPoint ?? null);
      }
    } else {
      setSegmentClickMapPoint(null);
    }

    setSelectedSegmentId(id);
  };

  const toggleLine = (lineId: string) => {
    if (input.hasMovedDistance()) {
      return;
    }

    setSelectedLineId(selectedLineId() === lineId ? null : lineId);
    setHoveredLineId(null);
  };

  const hoverLine = (lineId: string | null) => {
    setHoveredLineId(lineId);
  };

  const selectVehicle = (veh: LiveVehiclePosition, point: Point) => {
    setSelectedSurfaceStop(null);
    setSelectedSurfaceVehicle((prev) =>
      prev?.vehicle.vehicleId === veh.vehicleId ? null : { vehicle: veh, point },
    );
  };

  const selectStop = (stop: SurfaceStop, point: Point) => {
    setSelectedSurfaceVehicle(null);
    setSelectedSurfaceStop((prev) => (prev?.stop.id === stop.id ? null : { stop, point }));
  };

  const clearSurfaceSelection = () => {
    setSelectedSurfaceVehicle(null);
    setSelectedSurfaceStop(null);
  };

  const clearSelection = () => {
    selectStation(null);
    setSelectedSegmentId(null);
    setSegmentClickMapPoint(null);
    setHoveredLineId(null);
    setSelectedLineId(null);
    clearSurfaceSelection();
  };

  const selectedVehicleId = () => selectedSurfaceVehicle()?.vehicle.vehicleId ?? null;

  const selectedStopId = () => selectedSurfaceStop()?.stop.id ?? null;

  return {
    selectedStationId,
    selectedSegmentId,
    segmentClickMapPoint,
    selectedSurfaceVehicle,
    selectedSurfaceStop,
    selectedVehicleId,
    selectedStopId,
    hoveredLineId: () => hoveredLineId() ?? selectedLineId(),
    popoverElement,
    setPopoverElement,
    registerStationElement: (stationId: string, element: SVGGElement) => {
      stationElements.set(stationId, element);
    },
    forgetStationElements: () => {
      stationElements.clear();
    },
    selectStation,
    toggleStation,
    toggleSegment,
    toggleLine,
    hoverLine,
    selectVehicle,
    selectStop,
    clearSurfaceSelection,
    clearSelection,
  };
}
