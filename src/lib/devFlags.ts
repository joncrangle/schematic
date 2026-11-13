import { getNodeEnv } from "~/infrastructure/env/ServerEnv";

/**
 * Server-side dev flags.
 *
 * All reads happen at call time (never at module load) so they stay correct
 * across runtimes. Runtime env precedence is owned by the single server-env
 * seam (infrastructure/env/ServerEnv.ts); this module owns only the
 * dev-status truth table below.
 */

/**
 * True when the running bundle is a development build.
 *
 * Primary signal is Vite's statically replaced `import.meta.env.DEV` (same
 * runtime-guarded read as infrastructure/logging/logger.ts). Vite substitutes
 * it per bundle, `true` in dev builds, including `vite dev` served through
 * @cloudflare/vite-plugin's local workerd, and `false` in production builds —
 * so it distinguishes BUNDLES, not RUNTIMES. That makes it immune to wrangler
 * `vars.NODE_ENV` pollution inside local workerd:
 * wrangler.jsonc sets vars.NODE_ENV="production", so a runtime-only NODE_ENV
 * check misread the developer's own laptop as production. It also closes the
 * old fail-open hole: a prod bundle with NODE_ENV unset everywhere now sees
 * DEV === false and rejects instead of defaulting to allowed.
 *
 * Only when no build-time flag exists at all (non-bundled runtimes: vitest,
 * plain Bun/Node scripts) do we fall back to the runtime NODE_ENV check via
 * ServerEnv.getNodeEnv().
 *
 * This remains the hard server-side gate for dev-only RPCs: client-side UI
 * gating alone is insufficient because server functions stay reachable in
 * deployed environments regardless of what the browser renders.
 */
export function isDevServer(): boolean {
  return evaluateDevStatus(getBuildTimeDevFlag());
}

/**
 * Reads Vite's build-time flag defensively. In real bundles Vite statically
 * replaces this expression (boolean literal); in non-Vite runtimes it is
 * simply absent. Never assume the shape, callers must treat it as unknown.
 */
function getBuildTimeDevFlag(): unknown {
  return typeof import.meta !== "undefined" ? import.meta.env?.DEV : undefined;
}

/**
 * Pure decision core for {@link isDevServer}, split out so the truth table is
 * unit-testable without fighting vitest's import.meta.env proxying (its env
 * object inherits DEV values from a prototype chain, making delete/shadow
 * tricks unreliable across modules).
 *
 * A genuine build-time flag is strictly boolean and always wins. Anything else
 * (undefined in scripts, stringified variants in exotic runtimes) defers to
 * the runtime NODE_ENV fallback.
 */
export function evaluateDevStatus(buildTimeDevFlag: unknown): boolean {
  if (typeof buildTimeDevFlag === "boolean") return buildTimeDevFlag;
  // Non-bundled runtimes (vitest, scripts): fall back to runtime env.
  return getNodeEnv() !== "production";
}
