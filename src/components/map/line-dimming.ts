import type { Accessor } from "solid-js";

/**
 * SVG stroke opacities for map line and alert layers. Tests pin these exact
 * values as rendered attributes, so renaming keys is safe but changing a
 * value is a deliberate visual change.
 */
export const MAP_OPACITY = {
  /** Normal line track stroke. */
  lineStroke: "0.95",
  /** Wide halo shown behind a hovered/selected line's track. */
  lineHoverHalo: "0.35",
  /** Line tracks on non-selected lines fade to this ghost value. */
  lineDimmed: "0.2",
  /** Warning alert (delay / severe) main stroke. */
  alertStroke: "0.9",
  /** Warning alert halo aura. */
  alertHalo: "0.35",
  /** Slow-zone main stroke: dashed amber at full warning opacity, distinct by dash/width, no halo. */
  rszStroke: "0.9",
  /** Fully invisible, alerts on non-selected lines vanish entirely. */
  hidden: "0",
} as const;

export interface LineDimming {
  /** True when this layer's line is the currently selected or hovered one. */
  readonly isSelected: Accessor<boolean>;
  /** True when a different line is selected or hovered and this layer should fade back. */
  readonly isDimmed: Accessor<boolean>;
}

/**
 * Shared dimming predicate for map layers tied to a single line.
 *
 * The accessor combines clicked selection with temporary badge hover.
 * Other lines dim while either is active; leaving a badge restores the selection.
 * Consumers decide how to render dimming (stroke opacity, etc.) so the
 * predicate stays presentation-free.
 */
export function createLineDimming(
  lineId: string,
  hoveredLineId?: Accessor<string | null>,
): LineDimming {
  const isSelected = () => hoveredLineId?.() === lineId;

  const isDimmed = () => hoveredLineId?.() != null && !isSelected();

  return { isSelected, isDimmed };
}
