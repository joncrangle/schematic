import type { Point, Size } from "~/core/map";

export interface PopoverPosition {
  readonly x: number;
  readonly y: number;
  readonly placement: "top" | "bottom";
  readonly arrowLeft: number;
}

export interface CalculatePopoverPositionOptions {
  readonly topOffset?: number;
  readonly bottomOffset?: number;
  readonly padding?: number;
  readonly arrowPadding?: number;
}

/** Calculates a clamped popover position in the map container. */
export function calculatePopoverPosition(
  anchor: Point,
  popoverSize: Size,
  containerSize: Size,
  options: CalculatePopoverPositionOptions = {},
): PopoverPosition {
  const padding = options.padding ?? 12;
  const topOffset = options.topOffset ?? 8;
  const bottomOffset = options.bottomOffset ?? topOffset;
  const arrowPadding = options.arrowPadding ?? 16;
  const popoverWidth = Math.max(0, popoverSize.width);
  const popoverHeight = Math.max(0, popoverSize.height);
  const containerWidth = Math.max(0, containerSize.width);
  const containerHeight = Math.max(0, containerSize.height);

  let x = anchor.x - popoverWidth / 2;
  if (containerWidth > 0) {
    const maxLeft = Math.max(padding, containerWidth - padding - popoverWidth);
    x = Math.max(padding, Math.min(x, maxLeft));
  }

  let placement: "top" | "bottom" = "top";
  let y = anchor.y - topOffset - popoverHeight;
  if (containerHeight > 0) {
    const spaceAbove = anchor.y - topOffset;
    const spaceBelow = containerHeight - (anchor.y + bottomOffset);
    if (y < padding) {
      if (spaceBelow >= popoverHeight + padding || spaceBelow > spaceAbove) {
        placement = "bottom";
        y = anchor.y + bottomOffset;
      }
    }
    const maxTop = Math.max(padding, containerHeight - padding - popoverHeight);
    y = Math.max(padding, Math.min(y, maxTop));
  }

  const relativeAnchorX = anchor.x - x;
  const maxArrowLeft = Math.max(arrowPadding, popoverWidth - arrowPadding);
  return {
    x,
    y,
    placement,
    arrowLeft: Math.max(arrowPadding, Math.min(relativeAnchorX, maxArrowLeft)),
  };
}
