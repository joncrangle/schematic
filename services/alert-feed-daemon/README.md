# Alert Feed Daemon

A lightweight proxy daemon to poll, parse, and serve transit alert feeds when edge workers cannot reach an upstream or when supported GHD board parsing should run outside Workers.

Translates upstream web advisories into standard GTFS-Realtime Protobuf (`FeedMessage`) binary payloads. RSS/Atom sources are validated and forwarded unchanged, preserving categories, routes, IDs, dates, and CDATA for Core's existing decoder. All observations are cached in memory and served over HTTP; no feed database is used.

## Configuration

- `PORT`: HTTP port to listen on (default: `3001`).
- `FEED_ALERT_PROXY_TOKEN`: Optional shared secret required via `x-feed-token` header or `?token=` query param. Generate a random token with `openssl rand -hex 32`.
- `POLL_INTERVAL_SECS`: Interval in seconds between background scrape cycles (default: `180`).
- `MAX_STALENESS_SECS`: Maximum duration in seconds of upstream unreachability before returning 503 instead of stale cache (default: `3600`).
- `ALERT_FEED_CONFIG`: Optional path to a JSON feed registry. Without it, the binary uses the bundled `feeds.json` defaults.

The bundled registry serves YRT, GRT, DRT, Milton, Thunder Bay, and OC Transpo by default. YRT needs off-Workers egress because its upstream blocks Cloudflare; the other supported GHD boards move large HTML parsing off Workers. The registry also supports the generic `heading-service-notices`, `service-announcement-board`, `route-notice-index`, `route-status-table`, and `route-station-advisories` parsers; `route-station-advisories` also requires `timeZone` for its calendar dates. Configure optional `routeNames` only when aliases are explicit in the source prose. For `heading-service-notices`, `clearStatementNames` lists the service names an explicit no-changes paragraph may use to clear the board; any other qualifier stays unconfirmed. These parsers do not map stop names to GTFS stop IDs or infer route suspensions from closures or schedule changes. The direct HTML sources remain available to self-hosted callers. The GHD parser accepts compatible board templates by configuration without Rust changes or rebuilding the image. For RSS/Atom, use `parser: "rss"` with `id` and `upstreamUrl`. Omit GHD-only `routeParser`, `timeZone`, and `maxAgeMinutes`; Core's RSS source still owns interpretation and expiry. `pollIntervalSecs` and `maxStalenessSecs` can be set at the registry default or per feed. Per-feed values override the environment defaults. Poll intervals must be positive and representable by the runtime timer. Staleness thresholds may be zero, which makes a cached feed stale as soon as its recorded age becomes positive. An empty `feeds` array starts no pollers while keeping `/health` available.

## Usage

```bash
bun run alerts:dev     # Run in development mode
bun run alerts:build   # Build release binary
bun run alerts:start   # Run release binary
bun run alerts:test    # Run tests
bun run alerts:check   # Run cargo check
bun run alerts:inspect # Decode live protobuf output via protoc
```

## Building for older x86-64 hosts

Published `linux/amd64` binaries target baseline x86-64, with no AVX or newer
instruction defaults. AWS-LC runs its CPU probe from a constructor before the
process can choose a slower path, so a binary compiled with a newer default
`-march` traps with `SIGILL` on hosts that predate AVX. The release workflow and
`Dockerfile` pass `-march=x86-64 -mno-avx -mno-avx2` to the C compiler on
x86-64 builds and verify the result under QEMU with an AVX-free CPU model.
Other architectures are unaffected.

## Endpoints

- `GET /<feed>.pb` for GHD sources (or `GET /<feed>`)
  - Content-Type: `application/x-protobuf`
  - Returns binary GTFS-RT `FeedMessage`.
  - Returns `503 Service Unavailable` on cold boot until the first background scrape completes.
- `GET /<feed>.xml` for RSS/Atom sources (or `GET /<feed>`)
  - Content-Type: `application/rss+xml` or `application/atom+xml`.
  - Returns the validated upstream XML bytes unchanged. Rejects HTML, malformed XML, DTDs, missing or duplicate RSS channels, and responses over 2 MiB.
  - Shares token authentication, ETag/304, cold-start 503, stale warnings, and maximum-staleness 503 with protobuf sources.
- `GET /health`
  - Content-Type: `application/json`
  - Returns `{"status":"ok"}` for uptime/monitoring probes.

## Deploying with Cloudflare Workers (Cloudflare Tunnel)

When deploying Schematic on Cloudflare Workers, the daemon can run on any host with unblocked egress (as a standalone compiled binary or Docker container) and expose its port to your Cloudflare deployment via a Cloudflare Tunnel:

1. **Generate token**:
   ```bash
   openssl rand -hex 32
   ```
2. **Run daemon**:
   - **Native binary**: `PORT=3001 FEED_ALERT_PROXY_TOKEN=your_token ALERT_FEED_CONFIG=/path/to/feeds.json bun run alerts:start`
   - **Pre-built container (recommended)**: `docker run -d --name alert-feed-daemon -p 3001:3001 -e FEED_ALERT_PROXY_TOKEN=your_token -e ALERT_FEED_CONFIG=/etc/alert-feed-daemon/feeds.json -v "$PWD/services/alert-feed-daemon/feeds.json:/etc/alert-feed-daemon/feeds.json:ro" ghcr.io/joncrangle/alert-feed-daemon:latest`
   - **Docker Compose**: `FEED_ALERT_PROXY_TOKEN=your_token docker compose up -d alert-feed-daemon`
   - **Build locally**: `docker build -f services/alert-feed-daemon/Dockerfile -t ghcr.io/joncrangle/alert-feed-daemon:latest .`
3. **Expose port via Cloudflare Tunnel**: Route your tunnel hostname (e.g. `alerts.yourdomain.com`) to port `3001`.
4. **Configure Worker**: Set the tunnel base URL and the same token in Worker secrets:
   ```bash
   bunx wrangler secret put FEED_ALERT_PROXY_BASE_URL
   # Enter tunnel URL, e.g.: https://alerts.yourdomain.com

   bunx wrangler secret put FEED_ALERT_PROXY_TOKEN
   # Enter the same token
   ```

The Compose service mounts `services/alert-feed-daemon/feeds.json` read-only. Edit that file to add another supported GHD board, then restart the daemon to load the change; the container image does not need to be rebuilt. GHD feed IDs are served at `/<id>.pb`; RSS/Atom feed IDs at `/<id>.xml`, including `/oc-transpo.xml` and `/oc-transpo-fr.xml`. For deployments using the Workers proxy sources, update and verify the daemon before deploying the Worker manifests; provision `FEED_ALERT_PROXY_BASE_URL` and `FEED_ALERT_PROXY_TOKEN` first. Without the base URL secret, Cloudflare-only proxy sources are inactive. Agencies with no other source are unavailable; GRT's remaining official feed stays stale because its required board is missing. See the [agency guide](../../docs/agency-reference/alert-sources.md#proxy-backed-alert-sources) for the manifest declaration and registry fields.

See [`docs/deployment/deployment-guide.html#proxy`](../../docs/deployment/deployment-guide.html#proxy) for full details.

Upgrade the daemon binary/image before adding the first RSS registry entry. Verify
`/oc-transpo.xml` and `/oc-transpo-fr.xml` return their English and French feeds through your tunnel using the configured
`x-feed-token`. A failed upstream poll retains the last good document with a
stale warning; the Worker must not infer recovery from it. RSS forwarding fixes
egress access; RSS decoding still runs in Workers on changed documents.

Generic JSON advisory sources may use `parser: "generic-alert-feed"` with an
upstream URL and no GHD-only options. The daemon validates flat, route/accessibility,
and short/long-term bucketed documents and serves their original bytes at
`/<id>.json`. Core's generic JSON adapter normalizes the forwarded document,
including route and stop IDs, category evidence, HTML, and offset-bearing periods.
The shared shape contract is `tests/fixtures/generic-json/contract.json`.
Niagara's public JSON source is consumed directly and needs no proxy entry.

Mapstrat broadcasts use `parser: "mapstrat-broadcast"`. EUM Portal advisory
searches use `parser: "eum-search-advisories"` and a `requestBody` object carrying
the board's search options. Both validate their envelope and forward the original
JSON to Core. Truncated or unreadable-date EUM boards set the stale warning; an
empty broadcast is a quiet board. Core sources retain the matching JSON parser; their own
manifest supplies timezone and route interpretation. Shared normalization cases
live in `tests/fixtures/vendor-json/contract.json` and run in both languages.

Consat AnyRide service messages use `parser: "anyride-messages"`. `upstreamUrl` is
the tenant's AnyRide API base; the entry also needs `operatorPrefix`, an optional
`profile` (`data`, `display`) and `stops` (1 to 40 of `{ stopId, routeIds }`).
The daemon POSTs `GetCalls` for each stop with the profile headers, folds the
`messages` into one alert per id and serves the decoded feed as JSON at
`/<id>.json`; a stop that failed or answered with no content marks the feed
partial and stale, and no readable stop serves nothing. Core consumes it through
an `anyride-messages` source with `relay: "daemon-document"`. The shared contract
is `tests/fixtures/realtime/tmix/messages.contract.json`.

## Blocked official GTFS-RT feeds

Use `gtfs-rt-protobuf` or `gtfs-rt-json` to validate and forward an official
GTFS-RT alert document through off-Workers egress. These serve `/<id>.pb` and
`/<id>.json` respectively. JSON uses the snake_case field names accepted by
Core, including `header.gtfs_realtime_version`. Supported header versions are
`1.0` and `2.0`; an empty entity list is valid. Both formats validate known nested field types and required-field presence
against the compiled GTFS-RT schema, then retain the original bytes, including
extension fields. The daemon does not interpret alert scope,
severity or language. Existing agency routing is unchanged until its manifest
explicitly declares the proxy source.

```json
{
  "feeds": [{
    "id": "sample-alerts",
    "parser": "gtfs-rt-protobuf",
    "upstreamUrl": "https://operator.example/alerts.pb",
    "request": {
      "headers": { "Accept": "application/x-protobuf" },
      "headerSecrets": { "x-api-key": "FEED_SAMPLE_API_KEY" },
      "querySecrets": { "access_key": "FEED_SAMPLE_QUERY_KEY" }
    }
  }]
}
```

The optional `request` object works for every parser, including each GHD page
and AnyRide stop request. Set the referenced environment variables on the
machine running the daemon before starting it. These are separate from
`FEED_ALERT_PROXY_TOKEN`, which authenticates downstream callers. Keep credential
values out of registry files and static `headers`. Missing or blank environment
values and invalid header names or values reject startup. Header names are
case-insensitive; duplicate names and parser-owned or transport headers such as
`Host`, `Connection`, `Content-Length`, `Content-Type`, conditional `If-*`
headers, and AnyRide profile headers are rejected. The poller does not perform
upstream conditional cache revalidation. Query credential names must not already appear in
`upstreamUrl`. Credentials are URL-encoded and applied to every subrequest
without duplicating echoed query credentials.

All upstream clients refuse redirects, including redirects on GHD sources.
Configure the final upstream URL. Requests outside the configured upstream
origin are refused before sending credentials. Both GTFS-RT relay formats
reject HTTP failures, HTML challenges, invalid envelopes, empty responses and
bodies larger than 2 MiB, including streamed responses without Content-Length.
Failures retain the last good cached document and its successful observation
time. The existing stale warning and maximum-staleness 503 policy still apply.

## Feed diagnostics

`GET /status` uses the same header or query token authentication as feed
endpoints. When `FEED_ALERT_PROXY_TOKEN` is unset, it is unauthenticated like those
endpoints. `/health` remains a public process-liveness probe. Status responses
use `Cache-Control: no-store` and contain a `feeds` array sorted by feed ID:

```json
{
  "feeds": [{
    "id": "sample-alerts",
    "lastAttemptSecs": 1792454400,
    "lastSuccessSecs": 1792454220,
    "cachedAgeSecs": 180,
    "partial": false,
    "stale": true,
    "lastFailure": "http"
  }]
}
```

Timestamps are Unix seconds. `lastAttemptSecs` is null until a poll starts;
`lastSuccessSecs` and `cachedAgeSecs` are null until a usable document is cached.
`partial` describes that cached document. `stale` is true for a cold feed, an
incomplete read, a failed refresh, or a document past its maximum staleness.
`lastFailure` clears on success. Its bounded values are `transport`, `http`,
`decode`, `too-large`, or `upstream`. The last category covers errors from older
adapters that do not provide a typed failure. Status and poll-failure logs omit
upstream URLs, request headers, payloads and raw errors. Feed IDs `health` and
`status` are reserved.


### Legacy response headers

The upstream client accepts obsolete folded response headers and unfolds them
before parsing. This supports official servers that still send multiline CSP
headers, while retaining TLS verification, response size bounds, and redirect
restrictions. Red Deer's stop closure board uses the `stop-closure-table`
parser and remains available at `/red-deer.json`. Its TypeScript equivalent
parses the official page directly on both app runtimes; Cloudflare egress was
verified reachable, so the agency does not require the daemon proxy.

## Zenbus and municipal notices

`zenbus-messages` reads publicapp protobuf wall messages and emits a normalized
JSON feed. Configure `timeZone` and the seed-generated `stopCodeMap` when stop
codes need joining to native platform IDs. Communication and impact periods
remain separate, including source calendar dates.

The heading-notice parser also reconciles municipal news cards and their
articles, including lazy monthly archives and leading reopening updates.
Use a daemon relay when Cloudflare cannot reach the publisher. Rouyn-Noranda
and Saint-Hyacinthe are fetched directly: deployed Cloudflare checks returned
HTTP 200 for both. Rouyn-Noranda allows ten seconds per page. Truncated archive
reads remain stale instead of implying an all-clear.
