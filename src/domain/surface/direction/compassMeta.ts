/**
 * Compass presentation meta for Surface Transit directions.
 *
 * Angle/shortCode vocabulary moved out of the route-tracking presentation
 * helpers; mode tint (getSurfaceModeMeta*) stays with its callers.
 */

/**
 * Ordered compass rules: compound directions precede their single words
 * ("northeast" also contains "north"), preserving the historical cascade's
 * precedence exactly as data instead of an if-ladder.
 */
const COMPASS_META_RULES: readonly {
  readonly needles: readonly string[];
  readonly angle: number;
  readonly shortCode: string;
}[] = [
  { needles: ["north", "east"], angle: 45, shortCode: "NE" },
  { needles: ["north", "west"], angle: 315, shortCode: "NW" },
  { needles: ["south", "east"], angle: 135, shortCode: "SE" },
  { needles: ["south", "west"], angle: 225, shortCode: "SW" },
  { needles: ["north"], angle: 0, shortCode: "N" },
  { needles: ["east"], angle: 90, shortCode: "E" },
  { needles: ["south"], angle: 180, shortCode: "S" },
  { needles: ["west"], angle: 270, shortCode: "W" },
];

export function getDirectionCompassMeta(label: string): { angle: number; shortCode: string } {
  const norm = (label || "").trim().toLowerCase();
  const rule = COMPASS_META_RULES.find((r) => r.needles.every((w) => norm.includes(w)));
  if (rule) return { angle: rule.angle, shortCode: rule.shortCode };
  return { angle: 0, shortCode: norm.slice(0, 2).toUpperCase() || "DIR" };
}
