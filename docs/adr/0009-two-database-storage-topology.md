# ADR-0009: Two-Database Storage Topology

## Status

Accepted

## Context

Schematic serves many agencies from one deployment. Storage must:

1. Stay within Cloudflare Workers' limit of six simultaneous D1 connections per
   request, however many agencies are registered.
2. Let a contributor add an agency without provisioning a database, editing
   `wrangler.jsonc`, or configuring new bindings.
3. Support spatial and interchange queries across agencies in SQL.
4. Keep self-hosted backups and volumes simple.

## Decision

1. **Two databases**:
   - **`DB_TRANSIT` (`transit-status-db`)** holds all agency static topology
     (`routes`, `stops`, `route_shapes`, `route_stops`,
     `route_direction_trips`, `route_trip_terminals`, `topology_meta`,
     `seed_topology_meta`).
   - **`DB_NOTIFICATIONS` (`push-notifications-db`)** holds push subscriptions,
     the delivery ledger, delivery claims, and scheduler cursors.
2. **Agency scoping**: every topology table has an `agency_id TEXT NOT NULL`
   column and a composite primary key such as `(agency_id, id)`. Queries and
   writes are scoped by `agency_id`.
3. **Self-hosting mirror**: self-hosted deployments use flat SQLite files,
   `DATA_DIR/transit.db` and `DATA_DIR/push-notifications.db`.
4. **Lazy schema provisioning**: tables are created on first access with
   `CREATE TABLE IF NOT EXISTS`, and new columns are added after checking the
   existing table.

### Incremental seeding

`surfaceStore/seedSync.ts` owns the comparison and mutation plan for SQLite,
local D1, remote D1, and automatic static GTFS refresh. Keys are `agency_id`
plus the table's identity. The reconciler upserts only new or changed rows and
deletes only keys absent from the complete incoming projection, so other
agencies' rows are never touched. SQLite and local D1 commit the delta through
one batch; remote D1 submits it as one rollback-capable Wrangler SQL import.

`seed_topology_meta` stores the archive/configuration hash and per-table hashes.
Automatic refresh uses them to skip unchanged input and tables. Manual seeds and
D1 transfers set `verifyDestination: true`, bypass the hashes, and compare the
actual destination rows, so an emergency seed can repair corrupted rows. A no-op
sync writes nothing. Initial seeds write the full selected topology; later runs
write only the delta and required metadata, so operators should monitor actual
D1 rows written.

Automatic refresh never populates an empty agency partition; it reports
`needs-seed`, and manual seeding is the initial-population and emergency path.
Scheduling is described in
[ADR-0005](0005-surface-topology-reads-and-refresh.md). Alert payloads are
transient in the Workers Cache API or daemon memory and are never stored.

### Alert identity lookups

Alert fetching and decoding perform no D1 queries. Static GTFS identities used
for short-name/stop-code resolution, shared-feed membership, and optional
trip-to-route enrichment are generated during manual seeding. The deployment
contains a server-only catalog and immutable, content-addressed JSON assets.
Cloudflare reads them through the ASSETS binding; self-hosted Bun reads the
same deployed static files. There is no database fallback for alerts.

Station and surface departures treat the same trip index as a cache in front of
D1 for trip routes and directions. The refresh job runs daily but refreshes each
agency about weekly (ADR-0005), while the index changes only on a seed and
deployment, so trips missing from the index (or every trip, when the index fails
to load) resolve in D1, and the database is skipped for route and direction
lookups when the index covers every trip. Trip terminals are not indexed and are
always read from D1, memoized per isolate.

Scope files contain only route and stop identities plus unambiguous cardinal
directions. Trip indexes use 32 hash partitions per agency; a lookup reads only
the partitions named by its trip IDs. The resolver checks byte counts, SHA-256,
and schemas before caching. Cache storage, file sizes, concurrent reads, and
read deadlines are bounded. Artifact generations participate in the decoded
feed cache key, so a deployment cannot reuse results resolved against different
static identities.

Missing required membership fails only its dependent source. Other successful
sources remain visible as stale. Optional trip enrichment failures preserve the
original alert with unresolved scope. Selectors naming an explicit foreign
agency are excluded. A selector without `agency_id` is excluded when its route
or stop is absent from the pinned membership, or when it names only a trip
absent from the pinned trip index. Foreign trips are absent from the index by
definition, and shared feeds routinely publish such selectors, so retaining
them would leave the source permanently stale. The accepted tradeoff is that an
unattributed selector for this agency's own route or trip newer than the
deployment is dropped until the next seed and deployment. A selector naming this
agency explicitly is kept even when its route is newer than the deployment.
Notification subscription and delivery
operations still use DB_NOTIFICATIONS; nearby, departure, and topology queries
still use DB_TRANSIT.

Automatic database refresh does not publish static assets. Refresh these
identities with a manual SQLite seed and deploy the generated catalog and
assets together. They remain pinned to that deployment until the next one,
just like generated schematic station identity. New trip IDs remain unresolved
until then. Shared-feed membership changes require a new seed and deployment.

### Per-trip terminals

`route_stops` holds one canonical trip per route and direction for map geometry
and approximate ETAs. It cannot say where every trip ends, so
`route_trip_terminals` groups trip IDs by agency, route, direction, final stop,
and final stop sequence, in chunks of at most 2,000 IDs.

Nearby and station boards share `isTerminatingPrediction`. A known trip's final
call is excluded, even at an intermediate schematic station; earlier calls on a
loop stay boardable. When realtime omits stop sequences, the terminal stop ID is
the evidence. A trip missing from the lookup keeps its live prediction.

### Notification delivery

**Incident identity.** `alert_deliveries` rows are addressed by
`(agency_id, alert_id, subscription_id)`. Dedupe and recovery use an incident
key, because publishers change upstream IDs between fetches:

- By default the `v1-` key hashes agency, kind, severity, sorted attribution,
  and normalized title.
- A source in a `languageGroup` can declare an `incidentIdentityPattern`. Its
  `v2-` key uses only agency, language group, and the captured operator
  identifier, so translated variants share dedupe and recovery state.

One incident may occupy several rows. The evaluator sends one push and one
all-clear per key per pass. Only `active_sent` rows suppress delivery, so an
incident that clears and recurs pushes again.

**Recovery.** A complete live snapshot updates incident state even when a
subscriber's commute window is closed. A delivered incident absent from that
snapshot becomes `cleared_silent`, with no recovery push, which releases dedupe
for a later recurrence. Recovery requires both the incident key and its upstream
ID to be absent from the current severe set; a headline rewritten under the
same ID is not an all-clear. Stale or unavailable snapshots neither dispatch nor
change the ledger. Transport failures leave the delivery unchanged for retry.

**Subscription write ordering.** Subscription updates and healing deletes carry
a monotonic browser `policyRevision`, persisted in LocalStorage and advanced
before dispatch. SQL accepts an update only when its revision exceeds the stored
one, and a delete only removes a subscription whose revision is no newer. Deletes
record a tombstone keyed by the endpoint's SHA-256 hash and revision, so a late
insert cannot resurrect the subscription. Evaluator pruning of expired endpoints
is unconditional.

**Ownership.** Subscriptions are keyed by their browser-issued endpoint, which
acts as a bearer capability: anyone holding it can change or delete the
registration. Endpoints must stay private and are never logged. Proof of
possession is not implemented. Subscriptions idle for 365 days and tombstones
older than 365 days are pruned.

**Recipient rotation.** Workers persist one monotonic recipient cursor per cron
cadence. Each invocation selects at most 50 interested or recovering recipients,
finishes the first recipient's agency before starting others concurrently, and
advances by the number of recipients that finished (at least one). A
conditional update stops overlapping invocations from advancing the same
position twice. Agency and locale priority follow the cursor, so a slow source
cannot starve the same recipients every run.

**Delivery claims.** Before contacting Web Push, an invocation claims the
delivery in `alert_delivery_claims`, keyed by agency, subscription, incident
key, and locale scope (`v2-` identities share one cross-locale claim). Claims
are separate from `alert_deliveries`, so a pending claim never counts as
delivery or recovery. Outcome writes and releases are conditional on the
claim's owner token. The lease is 30 seconds, three times the push transport
deadline. Rejected, failed, or deferred attempts release their claim. HTTP and
D1 cannot share a transaction, so delivery is at-least-once: a worker that exits
after Web Push accepts a message but before recording it can resend after the
lease expires.

**History retention.** The evaluator reads only `active_sent` rows. Active rows
have no age limit. `cleared_sent` and `cleared_silent` rows record `terminal_at`
and are pruned 30 days later by the daily cleanup, using a partial index on
terminal rows.

## Consequences

- Adding an agency needs no `wrangler.jsonc` or database changes.
- A Worker uses at most two D1 bindings regardless of agency count.
- Initial seeds count fully against D1's daily row-write quota; refreshes cost
  only their delta.
