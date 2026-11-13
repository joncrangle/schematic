# Surface Transit topology reads and refresh

**Status:** Accepted

## Context

Surface topology (routes, stops, shapes, headsigns) is low-churn static data,
read on every nearby and route request. Cloudflare Workers Free allows 10 ms of
CPU per invocation, which streaming GTFS projection exceeds. Self-hosted and
Cloudflare deployments should follow the same policy wherever their runtimes
allow.

## Decision

### Reads are write-free

The shared read-policy kernel used by the D1, SQLite, and memory adapters serves
only stored topology. `getRoute` and `getRouteDetails` return `Option.none` on a
miss and never fetch, revalidate, or persist. Request traffic never writes
topology.

Each adapter has a bounded, per-agency in-process cache beneath the kernel that
reuses nearby candidates, route details, route metadata, and saved-route stop
membership for up to ten minutes. Writes do not invalidate warm entries, so a
warm read can stay stale for up to ten minutes after a refresh.

Shared logic lives in one place: NextBus route-config parsing in
`src/domain/nextbus/parseRouteConfig.ts`, revalidation and nearby-stop selection
in `src/domain/surface/revalidation.ts`, and arrival staleness and
approaching-vehicle ETAs in `NearbyTransit`.

### Writes are explicit

Topology changes only through the crawl and topology-source seam
(`surfaceStore/crawl`, `surfaceStore/topology`), sequenced by
`SurfaceTopologyRefresh`. A crawl submits each complete route to the
agency-bound `SurfaceTopologyWriter.reconcileRoute`, which validates it,
compares it with the stored projection, and writes the minimal change in one
atomic batch. An equivalent route returns `unchanged`; an empty direction map
returns `source-absent`. Missing directions do not delete stored ones, and empty
polylines keep stored geometry.

GTFS seed agencies share `projectGtfsTopology`, which streams CSV entries, and
the incremental reconciler described in
[ADR-0009](0009-two-database-storage-topology.md#incremental-seeding). Invalid
or incomplete projections fail before committing, leaving stored topology in
place. `topology_meta.last_sync` records the last topology change, not the last
check.

### Weekly refresh

Agencies with `staticTopology.source: "seed"` are checked once a week.
`assignTopologyWeekdays` gives each a stable weekday from agency-ID hashes with
least-loaded collision resolution; changing the registered set can rebalance
assignments. Each day at 04:00 UTC the refresh selects that day's agencies and
skips any whose topology is under seven days old. One agency's failure does not
stop the others; it retries at its next weekly opportunity.

- **Cloudflare**: Workers run only alert crons. `scripts/refresh-topology.ts` is
  a portable Bun job that reads an explicit Wrangler configuration and refreshes
  remote D1 directly. The Forgejo workflow runs it daily or on manual dispatch on
  an operator-owned runner; any host that can run Bun on a schedule can use the
  same CLI.
- **Self-hosted**: `SurfaceTopologyScheduler` arms a timer for the next 04:00
  UTC opportunity through the explicit startup hook, with one cycle in flight.
  Importing the server starts no timers, and missed runs are not caught up.

See [refresh setup](../deployment/topology-refresh.md) for credentials and
scheduling.

### Initial seeding and generated artifacts stay manual

An empty store reports `needs-seed` without fetching or writing. The manual
seed workflow populates new agencies and is the emergency path for changes that
cannot wait a week. See
[adding an agency](../agency-reference/topology.md#seeding).

Automatic refresh does not regenerate the compiled `stationIndex` or regional
interchanges. Moved-stop warnings print the old and new coordinates and these
commands:

```sh
bun scripts/seed.ts --agency=<id> --db=sqlite
bun scripts/seed.ts --interchange-only
```

Review, commit, and deploy the generated artifacts.

## Consequences

- Self-hosted and Cloudflare deployments share the read kernel, warm cache,
  writer, and seed path. They differ only in what schedules the weekly refresh.
- Topology changes reach riders within a week, or immediately after a manual
  seed plus up to ten minutes of warm-cache staleness.
- Unchanged topology costs no database writes.
