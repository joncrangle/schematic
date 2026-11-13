/**
 * The manifest slice the browser registry reads. Feed, alert, and topology
 * configuration is server-only, so the client build trims each manifest at
 * build time (see scripts/lib/agency-schematics-vite-plugin.ts) and the
 * browser registry applies the same trim at runtime for every other caller.
 *
 * The vite plugin imports this module directly, so it must stay free of
 * path aliases and runtime dependencies.
 */

export interface BrowserManifestInput {
  readonly staticTopology?: {
    readonly defaultColor?: string;
    readonly defaultTextColor?: string;
  };
  readonly realtime?: unknown;
  readonly alerts?: readonly unknown[];
  readonly hasLiveAlerts?: boolean;
}

export type TrimmedBrowserManifest<M extends BrowserManifestInput> = Omit<
  M,
  "staticTopology" | "realtime" | "alerts" | "hasLiveAlerts"
> & {
  readonly staticTopology: { readonly defaultColor?: string; readonly defaultTextColor?: string };
  readonly hasLiveAlerts: boolean;
};

/** Drops server-only configuration. Trimming a trimmed manifest is a no-op. */
export function trimBrowserManifest<M extends BrowserManifestInput>(
  manifest: M,
): TrimmedBrowserManifest<M> {
  const { staticTopology, realtime: _realtime, alerts, hasLiveAlerts, ...fields } = manifest;
  const colors: { defaultColor?: string; defaultTextColor?: string } = {};
  if (staticTopology?.defaultColor !== undefined) colors.defaultColor = staticTopology.defaultColor;
  if (staticTopology?.defaultTextColor !== undefined) {
    colors.defaultTextColor = staticTopology.defaultTextColor;
  }
  return {
    ...fields,
    staticTopology: colors,
    hasLiveAlerts: hasLiveAlerts ?? (alerts?.length ?? 0) > 0,
  };
}

// A symbol key cannot come from JSON, so no authored manifest can claim to be
// trimmed and skip full validation.
const BROWSER_MANIFEST = Symbol.for("schematic.browserManifest");

/** Tags a build-time trimmed manifest. Non-enumerable, so spreads drop it. */
export function markBrowserManifest<T extends object>(manifest: T): T {
  Object.defineProperty(manifest, BROWSER_MANIFEST, { value: true });
  return manifest;
}

export function isBrowserManifest(value: unknown): boolean {
  return typeof value === "object" && value !== null && BROWSER_MANIFEST in value;
}
