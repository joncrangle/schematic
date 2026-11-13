# ADR-0003: Deployment, Storage Bindings, and PWA Shell Caching

## Status

Accepted

## Context

Schematic is a mobile-first, account-free transit app. It runs on Cloudflare
Workers or as a self-hosted Bun container, and installs as a Progressive Web
App. Domain logic must not depend on Cloudflare APIs, and no secrets or
credentials may be committed.

## Decision

1. **Cloudflare deployment**: `wrangler.jsonc`, copied from
   `wrangler.sample.jsonc`, is the deployment configuration, with the
   `nodejs_compat` flag. It declares the two D1 bindings from
   [ADR-0009](0009-two-database-storage-topology.md). Secrets come from
   `wrangler secret put` or `.env`, never source control.
2. **Self-hosting**: a multi-stage `Dockerfile` builds a non-root Bun runtime
   image. `compose.yaml` mounts `./data:/app/data` for SQLite persistence and
   runs HTTP health checks.
3. **One storage-binding seam**:
   [RuntimeBindings](../../src/infrastructure/storage/RuntimeBindings.ts) owns
   every SQL binding. Its election ladder tries `globalThis.env`, then the
   workerd `cloudflare:workers` module, then `DATA_DIR` through Bun SQLite or
   `node:sqlite`. With no storage configured it throws
   `StorageBindingRefusedError`, naming both remedies. Elections are memoized
   per binding name and retried after a failure. In-memory stores exist only
   for tests.
4. **Service worker** ([src/sw.ts](../../src/sw.ts)):
   - Precaches the app shell into a build-versioned `app-shell-*` cache and
     deletes older shell caches on activation.
   - Navigations are network-first and fall back to the cached shell, then to
     a localized offline page.
   - Static assets are cache-first with background revalidation.
   - API and server-function requests are network-first and never served from
     cache.
   - Hashed `/assets/*` files are immutable; `/sw.js` and `/index.html` are
     always revalidated so deploys take effect.
   - In development the worker stays registered for push and installability
     but leaves every request to Vite.

## Consequences

- Domain logic stays independent of edge infrastructure.
- Cloudflare and self-hosted deployments share the same code paths; only the
  binding source differs.
- Misconfigured storage fails loudly instead of silently using memory.
- The app shell opens offline; live departures and alerts need a connection.
