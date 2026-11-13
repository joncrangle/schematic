declare const __SCHEMATIC_DEV_PROXY_ORIGIN__: unknown;

/**
 * Returns the current dev server origin for feed declarations that opt into a
 * local proxy. Production builds intentionally return undefined so declared
 * feeds always use their upstream URL there.
 */
export function getDevRequestOrigin(): string | undefined {
  if (!import.meta.env.DEV || typeof __SCHEMATIC_DEV_PROXY_ORIGIN__ !== "string") return undefined;
  return __SCHEMATIC_DEV_PROXY_ORIGIN__;
}
