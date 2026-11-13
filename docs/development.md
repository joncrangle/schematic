# Local development and testing

Start with the [contributor setup](../CONTRIBUTING.md#development-setup), including copying `wrangler.sample.jsonc` to `wrangler.jsonc`. The sample IDs work locally; production deployment requires your own databases. See the [deployment guide](deployment/deployment-guide.html) for hosting.

Run the commands below from the repository root.

## Tests

Use [test standards](../CODING_STANDARDS.md#tests) for test design and completion
requirements. Runner scripts are in [package.json](../package.json).

```sh
# Offline unit suite
bun run test

# Focused unit file
bun run test tests/unit/runtime-bindings.test.ts

# Opt-in integration suite using temporary SQLite databases and stubbed network boundaries
bun run test:integration
```

[vitest.config.ts](../vitest.config.ts) divides unit tests into `unit-node` and
`unit-dom`. The DOM project supplies Happy DOM for `@solidjs/testing-library`.
For owned-scope writes, initialization timing, pending-query suspension, or
secondary runner errors, follow [Solid debugging](agents/solid.md).

`bun run docs:check` checks local documentation links and Markdown heading
anchors separately from behavior tests.

## Nearby search

Nearby station and surface-route searches cap their radius at 1,500 metres.
`MAX_PROXIMITY_RADIUS_METERS` and `clampProximityRadius` in
[src/domain/proximity.ts](../src/domain/proximity.ts) enforce this limit for
queries and storage adapters. The bbox prefilter adds a conservative margin;
the final distance check still enforces the requested, clamped radius.

Query and RPC radii, walking-time calculations, and the location spoof drawer
remain metric. Rider-facing distance and speed labels follow the regional unit
default or an explicit unit-system preference. The no-stops message renders the
same cap as `1.5 km` or `0.9 mi`; switching units never changes query coverage.

## Web Push notifications

To enable background commute disruption push notifications:

```bash
# Generate a new VAPID keypair
bunx web-push generate-vapid-keys
```

Copy the generated public and private keys into your `.env`:

```env
VAPID_PUBLIC_KEY="BK..."
VAPID_PRIVATE_KEY="..."
VAPID_SUBJECT="mailto:admin@example.com"
```

Registration accepts HTTPS endpoints from FCM, Mozilla Autopush, Windows
Push, and Apple Web Push. A self-hosted push provider can be added with
`PUSH_ENDPOINT_HOSTS`, a comma-separated list of exact hostnames without a
scheme or port. For example, `PUSH_ENDPOINT_HOSTS=push.example.net`. Keep this
list to push services you trust; registration and delivery still require HTTPS
on port 443.

Registration of new subscriptions is bounded on both hosting targets. Each
client network (an IPv4 address or IPv6 /64) may register
`PUSH_REGISTRATION_LIMIT` new endpoints (default 10) per
`PUSH_REGISTRATION_WINDOW_MINUTES` (default 60); re-syncing an endpoint that
is already stored is never limited. New endpoints are refused once
`PUSH_SUBSCRIPTION_CEILING` subscriptions (default 50000) are stored. A
subscription that has never received a push is deleted
`PUSH_UNDELIVERED_RETENTION_DAYS` (default 30) after it was first stored.

On Workers the client network comes from `cf-connecting-ip`. Self-hosted
instances use the last `X-Forwarded-For` hop, so run a reverse proxy that
appends the connecting address to that header. Without one, callers can choose
their own address and only the instance ceiling bounds them; callers without
the header share one allowance. The limiter stores only a salted hash of the
client network. Each window's salt is deleted at the next registration or
daily prune after the window ends.

Every request that reaches the server is also rate limited per client network,
keyed the same way, and refused with `429` past the limit. Workers use the
`REQUEST_RATE_LIMITER` binding declared in `wrangler.sample.jsonc`, and a
Workers deploy without it answers `503`. Self-hosted instances and local
development without the binding count in process: `REQUEST_RATE_LIMIT`
requests (default 600) per `REQUEST_RATE_LIMIT_WINDOW_SECONDS` (default 60).
As with registration, callers without an `X-Forwarded-For` hop share one
allowance, so a self-hosted instance serving several riders needs the reverse
proxy described above.

## Running locally

### Development server

```bash
# Build the service worker bundle
bun run build:sw

# Start development server on port 3000 (HTTP by default)
bun run dev

# Or run with self-signed HTTPS:
bun run dev:https
```

Open [http://localhost:3000](http://localhost:3000) in your browser.

### Seeding transit data

The application ingests static transit topology and schedules (routes, stops, canonical shapes) from each agency's published GTFS (General Transit Feed Specification) feed.

- **Interactive Seeder Wizard (Mini-TUI):**

  ```bash
  bun run seed
  ```

  Launches an interactive terminal wizard to select registered agencies and database targets (SQLite, local Miniflare D1, or both). The agency list renders in a fixed-height viewport, so a long registry scrolls instead of overflowing the terminal. Prompts use the alternate screen buffer to preserve earlier output across redraws and resizes. In very short panes, the focused option takes priority over the title and key help.

  Wizard keys: `↑`/`↓` or `j`/`k` move, `Tab` (or `Space`) toggles the row (a region header toggles its visible members), `a` toggles every visible agency, `i` inverts the visible selection, `/` opens the filter by agency name, id, or region path, `Tab` toggles a match without leaving the filter, `←`/`→` or `[`/`]` collapse and expand a region, `Enter` applies an open filter or accepts the selection, and `Esc` clears an active filter before cancelling. While a filter is active, accepting submits only the matching agencies. `q` behaves like `Esc`, while `Ctrl+C` cancels immediately.

  The select-all row describes its real scope: `All matching agencies` while a filter is active, and `All visible agencies` while a region is collapsed.

- **Non-Interactive CLI Seeding:**
  ```bash
  # Ingest one agency into SQLite and local D1
  bun scripts/seed.ts --agency=ttc --db=both

  # Seed all agencies into both SQLite and local Miniflare D1
  bun scripts/seed.ts --agency=all --db=both

  # Ingest an explicit GTFS archive override
  bun scripts/seed.ts --agency=go --zip=/path/to/go-gtfs.zip
  ```

Adding `--db=d1` or `--db=both` mirrors the GTFS static data into the local Miniflare D1 database so surface routes appear under `vite dev`. D1 uses two databases: `DB_TRANSIT` for all agency topology data (partitioned by `agency_id`) and `DB_NOTIFICATIONS` for push subscriptions.

For an installed application's SQLite data, add `--database-only --db=sqlite`. This mode
requires an agency or scope selection in noninteractive runs and skips all source and
generated-asset writes. Container images bundle this CLI as the `init` command; see
[first-run container setup](deployment/deployment-guide.html#container).

### Simulating alerts

`bun run alerts:spoof` fabricates a transit alert and runs it through the real dispatch pipeline: severe filter, commute-window gate, line/station/route matching against your saved favourites, delivery dedup, and VAPID push. Only the realtime feed fetch is skipped. It reads subscriptions from the same local miniflare D1 database `vite dev` uses and VAPID keys from `.env`, so it works standalone or alongside a running dev server.

```bash
bun run alerts:spoof -- --help

# Defaults: severe Line 2 suspension at Castle Frank
bun run alerts:spoof

# Fully specify agency, line, stations, and severity
bun run alerts:spoof -- --agency go --line Lakeshore-East \
  --stations "Union Station" --severity severe --kind suspension

# Degraded slow-service on Line 1 with custom copy
bun run alerts:spoof -- --line 1 --stations "St George" \
  --severity degraded --kind slow-service \
  --title "SPOOF: Slow service southbound" \
  --description "Signal issues between St George and Union."
```

Notes:

- Pushes are only delivered for `severe` alerts to devices whose commute window is currently open and whose favourite lines/stations/routes match.
- Re-running with identical flags delivers again. Each simulation gets a fresh alert id, bypassing per-alert dedup by design.
- The script refuses to run when `NODE_ENV=production`.

### Testing on a phone or another device

Browsers restrict Service Workers and Web Push to Secure Contexts (`localhost` or trusted HTTPS). When testing from a mobile device or another computer over your local network IP (e.g. `http://192.168.x.x:3000`):

1. On your testing device (Chrome/Chromium), navigate to:
   ```
   chrome://flags/#unsafely-treat-insecure-origin-as-secure
   ```
2. Add your dev server URL (e.g. `http://192.168.x.x:3000`).
3. Enable the flag and relaunch Chrome.

This grants the local IP full Secure Context privileges (enabling Service Worker registration, Geolocation, and Web Push subscriptions) without SSL certificate warnings.

### Self-hosted production server

To build and run the self-hosted production server locally:

```bash
bun run build
bun run start
```

`DATA_DIR` is **required** for SQLite storage: transit topology (`transit.db`) and push notifications (`push-notifications.db`) persist in that directory (e.g. `DATA_DIR=./data`). Copy `.env.example` to `.env` (Bun loads it natively) or export the variable before starting. With no storage configured (no `DATA_DIR` on self-host, no D1 binding on Workers), the server fails loudly at startup instead of silently using memory.

Static assets are served by the Bun server itself via a build-once allowlist over `dist/client` (`src/server-static-assets.ts`): hashed `/assets/*` chunks ship `Cache-Control: public, max-age=31536000, immutable`; `/sw.js` ships `no-cache` so the service worker always revalidates. Anything that is not an allowlisted file (application routes, non-GET/HEAD methods, malformed paths) falls through to the SSR handler untouched, which keeps owning its own 404s. On Cloudflare Workers this seam never activates: Workers Assets continues serving statics at the edge unchanged.
