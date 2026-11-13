/**
 * Pure camera math shared by schematic renderers and the map engine. It has
 * no DOM, agency, or reactive dependencies.
 */

export interface Point {
  readonly x: number;
  readonly y: number;
}

export interface Size {
  readonly width: number;
  readonly height: number;
}

export interface MapBoundingBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
  readonly centerX: number;
  readonly centerY: number;
}

export interface ViewportTransform {
  readonly zoom: number;
  readonly pan: Point;
}

export interface MapCamera {
  readonly width: number;
  readonly height: number;
  readonly zoom: number;
  readonly pan: Point;
}

export interface TargetViewportInsets {
  readonly top?: number;
  readonly bottom?: number;
  readonly left?: number;
  readonly right?: number;
}

export interface MapCameraConfig {
  readonly viewBoxWidth: number;
  readonly viewBoxHeight: number;
  readonly minZoom: number;
  readonly maxZoom: number;
  readonly defaultBounds: MapBoundingBox;
}

export interface MapCameraEngine {
  readonly computeFitTransform: (width: number, height: number) => ViewportTransform | null;
  readonly computeTargetViewport: (
    bounds: MapBoundingBox,
    containerWidth: number,
    containerHeight: number,
    paddingFactor?: number,
    insets?: TargetViewportInsets,
  ) => ViewportTransform | null;
  readonly transformMapPointToContainer: (point: Point, camera: MapCamera) => Point | undefined;
  readonly transformContainerPointToMap: (
    containerPoint: Point,
    camera: MapCamera,
  ) => Point | undefined;
}

/** Shared margin for initial and responsive fit calculations. */
export const MAP_FIT_FACTOR = 0.95;

export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export function createMapCamera(config: MapCameraConfig): MapCameraEngine {
  const { viewBoxWidth, viewBoxHeight, minZoom, maxZoom, defaultBounds } = config;

  const computeFitTransform = (width: number, height: number): ViewportTransform | null => {
    if (!width || !height) return null;

    const scale = Math.min(width / viewBoxWidth, height / viewBoxHeight);
    const visibleWidth = width / scale;
    const visibleHeight = height / scale;
    const zoom = clamp(
      Math.min(
        (visibleWidth * MAP_FIT_FACTOR) / defaultBounds.width,
        (visibleHeight * MAP_FIT_FACTOR) / defaultBounds.height,
      ),
      minZoom,
      maxZoom,
    );

    return {
      zoom,
      pan: {
        x: viewBoxWidth / 2 - defaultBounds.centerX * zoom,
        y: viewBoxHeight / 2 - defaultBounds.centerY * zoom,
      },
    };
  };

  const computeTargetViewport = (
    bounds: MapBoundingBox,
    containerWidth: number,
    containerHeight: number,
    paddingFactor = 0.9,
    insets: TargetViewportInsets = { top: 84, bottom: 32, left: 24, right: 24 },
  ): ViewportTransform | null => {
    if (!containerWidth || !containerHeight) return null;

    const scale = Math.min(containerWidth / viewBoxWidth, containerHeight / viewBoxHeight);
    const visibleWidth = containerWidth / scale;
    const visibleHeight = containerHeight / scale;
    const topInset = (insets.top ?? 0) / scale;
    const bottomInset = (insets.bottom ?? 0) / scale;
    const leftInset = (insets.left ?? 0) / scale;
    const rightInset = (insets.right ?? 0) / scale;
    const usableWidth = Math.max(100, visibleWidth - leftInset - rightInset);
    const usableHeight = Math.max(100, visibleHeight - topInset - bottomInset);
    const routeWidth = Math.max(bounds.width, 100);
    const routeHeight = Math.max(bounds.height, 100);
    const optimalZoom = Math.min(
      (usableWidth * paddingFactor) / routeWidth,
      (usableHeight * paddingFactor) / routeHeight,
    );
    const zoom = clamp(optimalZoom, minZoom, maxZoom);
    const centerOffsetX = (leftInset - rightInset) / 2;
    const centerOffsetY = (topInset - bottomInset) / 2;

    return {
      zoom,
      pan: {
        x: viewBoxWidth / 2 - bounds.centerX * zoom + centerOffsetX,
        y: viewBoxHeight / 2 - bounds.centerY * zoom + centerOffsetY,
      },
    };
  };

  const transformMapPointToContainer = (point: Point, camera: MapCamera): Point | undefined => {
    if (!camera.width || !camera.height) return undefined;

    const scale = Math.min(camera.width / viewBoxWidth, camera.height / viewBoxHeight);
    const offsetX = (camera.width - viewBoxWidth * scale) / 2;
    const offsetY = (camera.height - viewBoxHeight * scale) / 2;

    return {
      x: offsetX + (point.x * camera.zoom + camera.pan.x) * scale,
      y: offsetY + (point.y * camera.zoom + camera.pan.y) * scale,
    };
  };

  const transformContainerPointToMap = (
    containerPoint: Point,
    camera: MapCamera,
  ): Point | undefined => {
    if (!camera.width || !camera.height || camera.zoom === 0) return undefined;

    const scale = Math.min(camera.width / viewBoxWidth, camera.height / viewBoxHeight);
    const offsetX = (camera.width - viewBoxWidth * scale) / 2;
    const offsetY = (camera.height - viewBoxHeight * scale) / 2;

    return {
      x: ((containerPoint.x - offsetX) / scale - camera.pan.x) / camera.zoom,
      y: ((containerPoint.y - offsetY) / scale - camera.pan.y) / camera.zoom,
    };
  };

  return {
    computeFitTransform,
    computeTargetViewport,
    transformMapPointToContainer,
    transformContainerPointToMap,
  };
}
