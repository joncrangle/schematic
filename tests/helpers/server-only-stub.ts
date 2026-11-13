/**
 * Vitest stub for the `server-only` boundary marker
 * (`@solidjs/vite-plugin/boundary-modules`).
 *
 * The marker is compile-time only: production builds fail when a
 * client-bundled module imports it, and server bundles resolve it to an
 * empty module. Vitest runs neither transform, so this side-effect-free
 * stub stands in for the marker and lets server-only modules load their
 * real implementations under test.
 */
export {};
