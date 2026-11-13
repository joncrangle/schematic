import { clamp, type MapCamera } from "~/core/map";
import type { Point } from "~/core/map";

/**
 * Pure viewport transform math: every zoom/pan computation the camera
 * performs, free of DOM and reactivity so both the gesture engine and the
 * framing controller share one source of truth.
 */

/** How the SVG viewBox sits inside the container (letterbox-aware). */
export interface ViewboxPlacement {
  readonly scale: number;
  readonly offsetX: number;
  readonly offsetY: number;
}

/** A camera position: zoom factor plus map-space pan offset. */
export type CameraState = Pick<MapCamera, "zoom" | "pan">;

export function viewBoxPlacement(
  rect: { width: number; height: number },
  viewBoxWidth: number,
  viewBoxHeight: number,
): ViewboxPlacement {
  const scale = Math.min(rect.width / viewBoxWidth, rect.height / viewBoxHeight);

  return {
    scale,
    offsetX: (rect.width - viewBoxWidth * scale) / 2,
    offsetY: (rect.height - viewBoxHeight * scale) / 2,
  };
}

/**
 * Zooms the camera by `factor` about a container point, keeping that point
 * pinned to its map coordinate. Returns null when the clamp bounds absorb
 * the whole factor, callers treat that as "nothing happened".
 */
export function computeZoomAtPoint(input: {
  readonly camera: CameraState;
  readonly factor: number;
  readonly containerPoint: Point;
  readonly placement: ViewboxPlacement;
  readonly minZoom: number;
  readonly maxZoom: number;
}): CameraState | null {
  const { camera, factor, containerPoint, placement, minZoom, maxZoom } = input;

  const svgX = (containerPoint.x - placement.offsetX) / placement.scale;
  const svgY = (containerPoint.y - placement.offsetY) / placement.scale;

  const nextZoom = clamp(camera.zoom * factor, minZoom, maxZoom);
  if (nextZoom === camera.zoom) {
    return null;
  }

  const ratio = nextZoom / camera.zoom;

  return {
    zoom: nextZoom,
    pan: {
      x: svgX - ratio * (svgX - camera.pan.x),
      y: svgY - ratio * (svgY - camera.pan.y),
    },
  };
}

export function cameraTransform(zoom: number, pan: Point): string {
  return `translate(${pan.x}, ${pan.y}) scale(${zoom})`;
}
