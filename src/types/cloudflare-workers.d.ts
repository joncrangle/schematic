// Ambient declaration for workerd's `cloudflare:workers` module.
//
// Present in production Workers deploys AND local `vite dev` via
// @cloudflare/vite-plugin (miniflare serves wrangler.jsonc bindings).
// Kept in its own import-free .d.ts so it stays a global script file —
// ambient module declarations cannot live inside a module-typed file.
declare module "cloudflare:workers" {
  export const env: Record<
    string,
    import("~/infrastructure/storage/RuntimeBindings").D1DatabaseBinding | undefined
  > & {
    // Dedicated notifications DB, not an agency, global push storage.
    readonly DB_NOTIFICATIONS?: import("~/infrastructure/storage/RuntimeBindings").D1DatabaseBinding;
    // Consolidated static transit topology DB (ADR-0009).
    readonly DB_TRANSIT?: import("~/infrastructure/storage/RuntimeBindings").D1DatabaseBinding;
  };
}
