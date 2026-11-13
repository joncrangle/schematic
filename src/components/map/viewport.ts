import { type Accessor, createSignal, flush, onSettled } from "solid-js";
import {
  cameraTransform,
  computeZoomAtPoint,
  viewBoxPlacement,
  type CameraState,
} from "./viewport/transform";
import type { GeometryPort, MapBoundingBox, Point } from "~/core/map";
import type { RouteShape, SurfaceStop } from "~/domain/surface/types";

const MOVE_THRESHOLD = 8;

/** Schematic camera framing supplied by the topology (agency-declared). */
export interface MapViewportConfig {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly initialZoom: number;
  readonly initialPan: Point;
  /** Renderer-owned camera fit operation. */
  readonly fitTransform: (width: number, height: number) => { zoom: number; pan: Point } | null;
  /** Optional camera bounds. Return the nearest legal pan for the zoom. */
  readonly clampPan?: (pan: Point, zoom: number) => Point;
  /** Optional wheel sensitivity. Return the zoom factor for a wheel delta. */
  readonly wheelZoomFactor?: (delta: number) => number;
  /** Geometry operations used to derive route bounds from tracking data. */
  readonly geometry?: GeometryPort;
  /** Renderer-owned camera fit operation for a route bounding box. */
  readonly getFraming?: (
    bounds: MapBoundingBox,
    containerSize: { width: number; height: number },
  ) => { zoom: number; pan: Point } | null;
  /**
   * Line the framed route belongs to, resolved by the caller from the same
   * manifest data the overlay uses. Framed geometry is snapped exactly as the
   * overlay's is, so the camera fits what is drawn.
   */
  readonly activeLineId?: () => string | undefined;
  /** Effective reduced-motion preference supplied by the app shell. */
  readonly prefersReducedMotion?: Accessor<boolean>;
}

interface ContainerSize {
  width: number;
  height: number;
}

interface PointerPosition {
  x: number;
  y: number;
}

export function createMapViewport(
  containerRef: Accessor<HTMLDivElement | undefined>,
  config: MapViewportConfig,
) {
  const [zoom, setZoom] = createSignal(config.initialZoom, { ownedWrite: true });

  const [pan, setPan] = createSignal<Point>({ ...config.initialPan }, { ownedWrite: true });

  const [containerSize, setContainerSize] = createSignal<ContainerSize>(
    {
      width: 0,
      height: 0,
    },
    { ownedWrite: true },
  );

  const [isDragging, setIsDragging] = createSignal(false, { ownedWrite: true });

  const [hasMovedDistance, setHasMovedDistance] = createSignal(false, { ownedWrite: true });

  const [isReady, setIsReady] = createSignal(false, { ownedWrite: true });

  const transform = () => cameraTransform(zoom(), pan());

  const viewBoxScale = () => {
    const size = containerSize();
    return viewBoxPlacement(size, config.viewBoxWidth, config.viewBoxHeight).scale;
  };

  /** Scale in rendered container pixels per schematic coordinate. */
  const screenScale = () => zoom() * viewBoxScale();

  /** Converts a rendered scale into this schematic's local zoom factor. */
  const zoomForScreenScale = (scale: number) => {
    const currentViewBoxScale = viewBoxScale();
    return currentViewBoxScale > 0 ? scale / currentViewBoxScale : zoom();
  };

  let hasManuallyTransformed = false;

  const fitTransform = (
    width: number,
    height: number,
  ): {
    zoom: number;
    pan: Point;
  } => {
    if (!width || !height) {
      return {
        zoom: config.initialZoom,
        pan: { ...config.initialPan },
      };
    }

    return (
      config.fitTransform(width, height) ?? {
        zoom: config.initialZoom,
        pan: { ...config.initialPan },
      }
    );
  };

  const readGeometry = (): {
    rect: DOMRect;
    scale: number;
    offsetX: number;
    offsetY: number;
  } | null => {
    const container = containerRef();

    if (!container) {
      return null;
    }

    const rect = container.getBoundingClientRect();

    if (!rect.width || !rect.height) {
      return null;
    }

    return {
      rect,
      ...viewBoxPlacement(rect, config.viewBoxWidth, config.viewBoxHeight),
    };
  };

  const applyPan = (next: Point, zoomValue: number): Point =>
    config.clampPan ? config.clampPan(next, zoomValue) : next;

  const resetViewport = () => {
    cancelFraming();
    hasManuallyTransformed = false;

    const size = containerSize();
    const next = fitTransform(size.width, size.height);

    flush(() => {
      setZoom(next.zoom);
      setPan(applyPan(next.pan, next.zoom));
    });
  };

  const zoomAtContainerPoint = (factor: number, containerX: number, containerY: number) => {
    cancelFraming();
    const geometry = readGeometry();

    if (!geometry) {
      return;
    }

    const next = computeZoomAtPoint({
      camera: { zoom: zoom(), pan: pan() },
      factor,
      containerPoint: { x: containerX, y: containerY },
      placement: geometry,
      minZoom: config.minZoom,
      maxZoom: config.maxZoom,
    });

    if (!next) {
      return;
    }

    hasManuallyTransformed = true;

    flush(() => {
      setZoom(next.zoom);
      setPan(applyPan(next.pan, next.zoom));
    });
  };

  const zoomFromCenter = (factor: number) => {
    const size = containerSize();

    zoomAtContainerPoint(factor, size.width / 2, size.height / 2);
  };

  const activePointers = new Map<number, PointerPosition>();
  const pointerStarts = new Map<number, { x: number; y: number; time: number }>();

  let dragOrigin:
    | {
        x: number;
        y: number;
        panX: number;
        panY: number;
      }
    | undefined;

  let pinchDistance: number | undefined;

  let gestureFrame: number | undefined;
  let framingFrame: number | undefined;
  let framingRetryToken = 0;
  const [isAnimating, setIsAnimating] = createSignal(false, { ownedWrite: true });

  let lastTapTime = 0;
  let lastTapX = 0;
  let lastTapY = 0;
  const DOUBLE_TAP_MAX_DELAY = 400;
  const DOUBLE_TAP_MAX_DISTANCE = 50;

  const cancelFraming = () => {
    framingRetryToken += 1;
    if (framingFrame !== undefined) {
      cancelAnimationFrame(framingFrame);
      framingFrame = undefined;
    }
    flush(() => setIsAnimating(false));
  };

  const updateGesture = () => {
    if (activePointers.size === 1 && dragOrigin) {
      const [pointer] = activePointers.values();
      const origin = dragOrigin;

      const geometry = readGeometry();

      if (!geometry) {
        return;
      }

      const deltaX = pointer.x - origin.x;

      const deltaY = pointer.y - origin.y;

      if (Math.hypot(deltaX, deltaY) > MOVE_THRESHOLD) {
        flush(() => {
          setHasMovedDistance(true);
          hasManuallyTransformed = true;

          setPan(
            applyPan(
              {
                x: origin.panX + deltaX / geometry.scale,
                y: origin.panY + deltaY / geometry.scale,
              },
              zoom(),
            ),
          );
        });
      }

      return;
    }

    if (activePointers.size === 2 && pinchDistance !== undefined) {
      const geometry = readGeometry();

      if (!geometry) {
        return;
      }

      const [a, b] = [...activePointers.values()];

      const distance = Math.hypot(a.x - b.x, a.y - b.y);

      const centerX = (a.x + b.x) / 2 - geometry.rect.left;

      const centerY = (a.y + b.y) / 2 - geometry.rect.top;

      if (distance > 0) {
        flush(() => {
          setHasMovedDistance(true);
        });

        zoomAtContainerPoint(distance / pinchDistance, centerX, centerY);

        pinchDistance = distance;
      }
    }
  };

  const scheduleGestureUpdate = () => {
    if (gestureFrame !== undefined) {
      return;
    }

    gestureFrame = requestAnimationFrame(() => {
      gestureFrame = undefined;
      updateGesture();
    });
  };

  const onPointerDown = (event: PointerEvent) => {
    if (event.pointerType === "mouse" && event.button !== 0) {
      return;
    }

    cancelFraming();

    activePointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    pointerStarts.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
      time: Date.now(),
    });

    flush(() => {
      setHasMovedDistance(false);

      if (activePointers.size === 1) {
        setIsDragging(true);

        const panValue = pan();

        dragOrigin = {
          x: event.clientX,
          y: event.clientY,
          panX: panValue.x,
          panY: panValue.y,
        };

        pinchDistance = undefined;
      } else if (activePointers.size === 2) {
        dragOrigin = undefined;

        const [a, b] = [...activePointers.values()];

        pinchDistance = Math.hypot(a.x - b.x, a.y - b.y);
      }
    });
  };

  const onPointerMove = (event: PointerEvent) => {
    if (!activePointers.has(event.pointerId)) {
      return;
    }

    activePointers.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });

    const start = pointerStarts.get(event.pointerId);
    if (start && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_THRESHOLD) {
      const target = event.currentTarget as Element;
      if (target && !target.hasPointerCapture?.(event.pointerId)) {
        try {
          target.setPointerCapture(event.pointerId);
        } catch {
          // ignore
        }
      }
    }

    scheduleGestureUpdate();
  };

  const endPointer = (event: PointerEvent) => {
    const target = event.currentTarget as Element;

    if (target.hasPointerCapture?.(event.pointerId)) {
      try {
        target.releasePointerCapture(event.pointerId);
      } catch {
        // ignore
      }
    }

    const start = pointerStarts.get(event.pointerId);
    pointerStarts.delete(event.pointerId);

    const now = Date.now();
    const touchDuration = start ? now - start.time : 999;
    const touchDistance = start
      ? Math.hypot(event.clientX - start.x, event.clientY - start.y)
      : 999;
    const isStationaryTap = touchDistance < 20 && touchDuration < 400;

    activePointers.delete(event.pointerId);

    if (activePointers.size === 0) {
      flush(() => {
        setIsDragging(false);
      });
      dragOrigin = undefined;
      pinchDistance = undefined;

      // Handle double-tap to zoom
      if (isStationaryTap) {
        const timeSinceLastTap = now - lastTapTime;
        const distanceFromLastTap = Math.hypot(event.clientX - lastTapX, event.clientY - lastTapY);

        if (
          timeSinceLastTap > 30 &&
          timeSinceLastTap < DOUBLE_TAP_MAX_DELAY &&
          distanceFromLastTap < DOUBLE_TAP_MAX_DISTANCE
        ) {
          const geometry = readGeometry();
          if (geometry) {
            const containerX = event.clientX - geometry.rect.left;
            const containerY = event.clientY - geometry.rect.top;
            zoomAtContainerPoint(1.6, containerX, containerY);
          }
          lastTapTime = 0;
        } else {
          lastTapTime = now;
          lastTapX = event.clientX;
          lastTapY = event.clientY;
        }
      } else {
        lastTapTime = 0;
      }
      return;
    }

    if (activePointers.size === 1) {
      const [remaining] = activePointers.values();

      const currentPan = pan();

      dragOrigin = {
        x: remaining.x,
        y: remaining.y,
        panX: currentPan.x,
        panY: currentPan.y,
      };

      pinchDistance = undefined;
    }
  };

  const onDblClick = (event: MouseEvent) => {
    const geometry = readGeometry();
    if (!geometry) return;
    const containerX = event.clientX - geometry.rect.left;
    const containerY = event.clientY - geometry.rect.top;
    zoomAtContainerPoint(1.6, containerX, containerY);
  };

  const onWheel = (event: WheelEvent) => {
    event.preventDefault();

    const geometry = readGeometry();

    if (!geometry) {
      return;
    }

    const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
    if (delta === 0) return;

    const factor = config.wheelZoomFactor?.(delta) ?? (delta < 0 ? 1.15 : 0.85);

    zoomAtContainerPoint(
      factor,
      event.clientX - geometry.rect.left,
      event.clientY - geometry.rect.top,
    );
  };

  onSettled(() => {
    const container = containerRef();

    if (!container) {
      return;
    }

    // ResizeObserver delivers the initial size after browser layout. Reading
    // getBoundingClientRect here synchronously lays out the entire new SVG
    // during settlement, then fits the same camera again in the observer.
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];

      if (!entry) {
        return;
      }

      const { width, height } = entry.contentRect;

      if (width <= 0 || height <= 0) {
        return;
      }

      flush(() => {
        setContainerSize({
          width,
          height,
        });

        if (!hasManuallyTransformed) {
          const next = fitTransform(width, height);

          setZoom(next.zoom);
          setPan(applyPan(next.pan, next.zoom));
        }

        setIsReady(true);
      });
    });

    observer.observe(container);

    const controller = new AbortController();

    container.addEventListener("wheel", onWheel, {
      passive: false,
      signal: controller.signal,
    });

    return () => {
      observer.disconnect();
      controller.abort();
      cancelFraming();
      if (gestureFrame !== undefined) {
        cancelAnimationFrame(gestureFrame);
        gestureFrame = undefined;
      }
      activePointers.clear();
    };
  });

  const updateZoom = (value: number | ((prev: number) => number)) => {
    cancelFraming();
    hasManuallyTransformed = true;
    return flush(() => setZoom(value));
  };

  const updatePan = (value: Point | ((prev: Point) => Point)) => {
    cancelFraming();
    hasManuallyTransformed = true;
    return flush(() =>
      setPan((prev) => applyPan(typeof value === "function" ? value(prev) : value, zoom())),
    );
  };

  /**
   * Programmatic camera write: moves the camera without marking the
   * transform manual, so container resizes keep auto-refitting. Optionally
   * restores the manual flag captured by a targeted-session snapshot.
   */
  const setCamera = (camera: CameraState, options?: { readonly manual?: boolean }) => {
    if (options?.manual !== undefined) {
      hasManuallyTransformed = options.manual;
    }

    flush(() => {
      setZoom(camera.zoom);
      setPan({ ...camera.pan });
    });
  };

  interface CameraSnapshot {
    readonly camera: CameraState;
    readonly manual: boolean;
  }

  let savedBeforeTargetedMode: CameraSnapshot | null = null;
  let hasExitedTargetedMode = false;

  /** Stops a route framing pass without changing the camera or manual state. */
  const cancelAnimation = () => {
    cancelFraming();
  };

  const frameBoundingBox = (
    bounds: MapBoundingBox,
    durationMs = 400,
    allowZeroSizeRetry = true,
  ): void => {
    cancelFraming();

    const size = containerSize();
    if (!size.width || !size.height) {
      if (!allowZeroSizeRetry) return;

      framingFrame = requestAnimationFrame(() => {
        framingFrame = undefined;
        const retrySize = containerSize();
        if (retrySize.width && retrySize.height) {
          frameBoundingBox(bounds, durationMs, false);
        }
      });
      return;
    }

    const target = config.getFraming?.(bounds, size);
    if (!target) {
      return;
    }

    if (config.prefersReducedMotion?.() || durationMs <= 0) {
      setCamera(target);
      return;
    }

    const startZoom = zoom();
    const startPan = { ...pan() };
    const startTime = performance.now();
    const token = framingRetryToken;
    let lastAnimZoom = startZoom;

    flush(() => setIsAnimating(true));

    const step = (currentTime: number) => {
      framingFrame = undefined;

      if (token !== framingRetryToken || isDragging() || Math.abs(zoom() - lastAnimZoom) > 0.01) {
        flush(() => setIsAnimating(false));
        return;
      }

      const t = Math.min(1, Math.max(0, (currentTime - startTime) / durationMs));
      const eased = cubicBezierEase(t);
      const nextZoom = startZoom + (target.zoom - startZoom) * eased;
      const nextPan: Point = {
        x: startPan.x + (target.pan.x - startPan.x) * eased,
        y: startPan.y + (target.pan.y - startPan.y) * eased,
      };

      setCamera({ zoom: nextZoom, pan: nextPan });
      lastAnimZoom = nextZoom;

      if (t < 1) {
        framingFrame = requestAnimationFrame(step);
      } else {
        flush(() => setIsAnimating(false));
      }
    };

    framingFrame = requestAnimationFrame(step);
  };

  /**
   * Frames a tracked route.
   *
   * A route the schematic draws is framed by its drawn line, not by the trip's
   * own projected shape. The rider asked to enlarge the route, and on a
   * schematic the route IS the drawn line; the feed's shape is a geographic
   * projection of one trip, which is neither the full route nor at the scale
   * the line is drawn. On GO's Lakeshore West that difference is a 540-unit line
   * against a 97-unit shape, so framing the shape zoomed to the maximum on a
   * stub and the rest of the route stayed off screen.
   *
   * A route the schematic does not draw has no line to frame and keeps framing
   * its own shape, which is the only description of where it goes that exists.
   */
  const frameRoute = (shape: RouteShape, stops?: readonly SurfaceStop[]): void => {
    const geometry = config.geometry;
    if (!geometry) return;

    const lineId = config.activeLineId?.();
    const drawnPoints = lineId ? geometry.drawnLineMapPoints(lineId) : undefined;
    if (drawnPoints && drawnPoints.length > 1) {
      frameBoundingBox(geometry.computeRouteBoundingBox(drawnPoints));
      return;
    }

    const points = lineId
      ? geometry.extractRouteMapPoints(shape, stops, { lineId })
      : geometry.extractRouteMapPoints(shape, stops);
    if (points.length > 0) {
      frameBoundingBox(geometry.computeRouteBoundingBox(points));
      return;
    }

    frameBoundingBox(geometry.projectGeoBoundingBoxToMapBounds(shape));
  };

  /** Captures the pre-targeted camera once for the current targeted session. */
  const enterTargetedMode = () => {
    if (savedBeforeTargetedMode) return;

    cancelAnimation();
    hasExitedTargetedMode = false;
    savedBeforeTargetedMode = {
      camera: { zoom: zoom(), pan: { ...pan() } },
      manual: hasManuallyTransformed,
    };
  };

  /** Restores the camera captured before targeted mode, or the normal fit. */
  const exitTargetedMode = () => {
    if (hasExitedTargetedMode) return;
    hasExitedTargetedMode = true;
    cancelAnimation();

    const saved = savedBeforeTargetedMode;
    savedBeforeTargetedMode = null;

    if (saved) {
      setCamera(saved.camera, { manual: saved.manual });
      return;
    }

    resetViewport();
  };

  /**
   * Standard cubic-bezier(0.25, 0.1, 0.25, 1.0) framing curve. Kept here so
   * camera state, animation, and targeted-mode lifecycle have one owner.
   */
  function cubicBezierEase(t: number): number {
    const p1 = 0.1;
    const p2 = 1.0;
    const u = 1 - t;
    return 3 * u * u * t * p1 + 3 * u * t * t * p2 + t * t * t;
  }

  const centerOnPoint = (point: Point, requestedZoom = zoom()) => {
    cancelFraming();
    setCamera(
      {
        zoom: requestedZoom,
        pan: {
          x: config.viewBoxWidth / 2 - point.x * requestedZoom,
          y: config.viewBoxHeight / 2 - point.y * requestedZoom,
        },
      },
      { manual: true },
    );
  };

  /** Places a map point at an existing container position without changing zoom. */
  const placePointAtContainerPoint = (
    point: Point,
    containerPoint: Point,
    requestedZoom = zoom(),
  ): boolean => {
    const geometry = readGeometry();

    if (!geometry || !geometry.scale || !requestedZoom) {
      return false;
    }

    cancelFraming();
    setCamera(
      {
        zoom: requestedZoom,
        pan: {
          x: (containerPoint.x - geometry.offsetX) / geometry.scale - point.x * requestedZoom,
          y: (containerPoint.y - geometry.offsetY) / geometry.scale - point.y * requestedZoom,
        },
      },
      { manual: true },
    );
    return true;
  };

  const hasManualTransform = () => hasManuallyTransformed;

  return {
    zoom,
    screenScale,
    zoomForScreenScale,
    pan,
    setZoom: updateZoom,
    setPan: updatePan,
    setCamera,
    centerOnPoint,
    placePointAtContainerPoint,
    hasManualTransform,
    transform,
    containerSize,
    isDragging,
    hasMovedDistance,
    isReady,
    resetViewport,
    zoomFromCenter,
    isAnimating,
    enterTargetedMode,
    frameRoute,
    exitTargetedMode,
    cancelAnimation,
    pointerHandlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: endPointer,
      onPointerCancel: endPointer,
      onDblClick,
    },
  };
}
