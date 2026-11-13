# Notification incident runbook

Use this for a missed, late, duplicate, or unexpected recovery push. Start with
the deployment that served the rider and an explicit incident time with offset.
A local subscription or passing mocked replay cannot establish production
delivery.

## Establish the evidence

1. Identify Workers or self-host, the deployed revision, agency, affected line or
   stop, rider subscription, and commute window. Record Toronto local time and
   UTC. Keep the original alert ID and feed capture when available; an upstream
   ID may disappear or change after recovery.
2. Inspect that agency's sources in the [data catalog](../../src/agencies/agencyCatalog.ts)
   and manifest. Follow [fetchAgencyAlerts](../../src/infrastructure/realtime/fetchAgencyAlerts.ts),
   including runtime activation and proxy requirements. An arbitrary public
   endpoint is not necessarily the deployed source.
3. Capture the feed with its fetch time and HTTP result. TTC's JSON source uses
   manifest `timestampMode: "agency-local-wall-clock"` because its `Z` suffix
   describes Toronto wall-clock values. Core applies the agency timezone;
   manually treating that suffix as UTC repeats the September missed-alert bug.
4. Replay the capture below at the incident's evaluation time. Check normalized
   lifecycle/severity, commute eligibility, agency-qualified favorite matching,
   and content-hash dedupe. The [production evaluator](../../src/services/notifications/AlertEvaluatorService.ts)
   owns all those decisions; use its replay instead of reconstructing them.
5. Correlate production subscription and ledger records with scheduler logs.
   Conclude which stage failed only when its evidence is present. If logs or
   the original feed are unavailable, identify that specific missing evidence.

## Offline replay

`bun run notifications:diagnose --help` describes the input contract. The command
uses an anonymous in-memory subscription and mock push transport. It has no
live fetch fallback, production credentials, or database writes. The separate
`alerts:spoof` command sends real pushes and is not an incident replay.

Capture only the affected subscription's policy fields in a private local file:

```json
{
  "timezone": "America/Toronto",
  "commuteSchedules": [
    {
      "id": "evening",
      "label": "Evening",
      "enabled": true,
      "days": [1, 2, 3, 4, 5],
      "start": "15:30",
      "end": "17:30"
    }
  ],
  "favouriteLines": [{ "agencyId": "ttc", "lineId": "2" }],
  "favouriteStations": [],
  "favouriteSurfaceRoutes": []
}
```

Exclude endpoint, `auth`, and `p256dh`. Keep private captures outside the repo.
Choose the zero-based source index from the manifest, not from another agency:

```sh
bun run notifications:diagnose --agency ttc --source 0 --feed /tmp/incident-feed \
  --subscription /tmp/incident-preferences.json --now 2026-09-29T16:00:00-04:00
```

Raw feed mode uses the selected manifest's single-response JSON, RSS, or GTFS-RT
adapter, station attribution, and interpretation rules. It reconstructs only
that source, not the full agency snapshot. Delivery-history replay requires
snapshot mode so absent alerts from uncaptured sources cannot fabricate recovery. It refuses web parsers,
inactive/secret-dependent sources, and uncaptured request URLs. For a source
needing pagination or unavailable transport configuration, capture its
normalized [AgencySnapshot](../../src/agencies/types.ts) through the deployed
runtime and use snapshot mode:

```sh
bun run notifications:diagnose --snapshot /tmp/incident-snapshot.json \
  --subscription /tmp/incident-preferences.json --deliveries /tmp/incident-deliveries.json \
  --now 2026-09-29T16:00:00-04:00
```

Snapshot mode retains captured lifecycle values. Capture/normalize at the same
evaluation time rather than using today's already-expired snapshot to explain
yesterday's eligibility. Each file is limited to 5 MiB; replay accepts at most
1,000 alerts and 1,000 delivery rows. Omit `--deliveries` for an empty baseline.
For dedupe/recovery, export only that subscription's rows with `agencyId`,
`alertId`, `incidentKey`, `status`, `deliveredAt`, and optional `lineId`/`routeId`.
The command's accepted pushes are hypothetical mock results.

## Production correlation

Workers use `DB_NOTIFICATIONS`; local Miniflare and self-hosted
`DATA_DIR/push-notifications.db` have independent subscriptions and ledgers.
See [ADR-0009](../adr/0009-two-database-storage-topology.md) and the
[subscription schema](../../src/infrastructure/storage/subscriptionSchema.ts).
Workers read validated subscriptions once per invocation before polling. They
select agencies referenced by current favourites or outstanding `active_sent`
incidents, then evaluate only current-window favourites and outstanding
recovery recipients for each agency. Self-hosted evaluation applies the same
recipient prefilter while continuing to poll every registered agency.
Commute windows do not restrict this selection: a removed favourite still needs
a complete live snapshot to record silent recovery. With no validated
subscriptions, no feeds are fetched. Repository read errors fail the invocation.
Current favourites with a closed commute window still keep their agency in the
Worker polling set, but do not incur delivery-history reads until their window
opens or they have an outstanding delivery.

Workers persist one recipient cursor per scheduled cadence in the notification
database. A bounded page of at most 50 candidates starts at that cursor, and
the first candidate's agency runs alone before the remaining agencies run concurrently. Within each agency, locales follow the selected recipient order so a fixed locale order cannot consume every tick's budget. Each invocation advances the cursor
by the number of recipients that finish evaluation, with a one-position
fallback when none finish. This keeps repeated fully deferred runs moving
through the recipient order. Outstanding `active_sent` deliveries for selected
recipients are loaded in one agency-scoped batch query rather than one query
per recipient. Terminal history remains available to diagnostics for 30 days
after recovery.

`getActiveSubscriptions` prunes registrations whose `updated_at` is older than
365 days, tombstones whose `deleted_at` is older than 365 days, expired claims,
and terminal delivery rows older than 30 days. SQL-backed repositories run the
registration, tombstone, claim, and terminal-delivery cleanup statements at
most once per binding per day in each worker isolate or self-hosted process.
The first read after that interval spends four additional queries from the
invocation budget. A cold adapter also spends one query to create the terminal
index, plus one `ALTER TABLE` query when an existing delivery table lacks a column.
These bootstrap statements are charged to the same invocation budget. A
returning client recreates its row on its next registration sync.

The outstanding-target query uses a covering partial index on
`(agency_id, subscription_id)` restricted to `active_sent`, so cleared history
does not contribute to its scan. A second partial index covers terminal
delivery timestamps for pruning. Lazy bootstrap adds both indexes and the
`terminal_at` column to existing databases; successful and concurrent bootstrap
is shared per binding identity, and failed initialization is retried. Building
the indexes scans existing rows once. Active rows remain indexed for recovery
and dedupe until a complete snapshot clears them. Recovery moves a row into the
terminal index, and pruning removes it after the retention period. These are
notification-ledger mutations, never feed-payload storage or polling writes.
D1 counts index maintenance and persisted retry-state mutations toward billed
row writes; see
[D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/).

Terminal history stays for 30 days after its status changes. `terminal_at`
tracks that time separately from `delivered_at`, which remains the last accepted
push time for `cleared_silent`. Existing terminal rows without `terminal_at`
use `delivered_at` as their best available age. The 30-day window supports recent
incident review and replay while bounding cleared-row storage. Active incidents
have no age limit because they still suppress duplicate pushes and may need a
silent recovery after the next complete snapshot. The first cleanup after
rollout may remove a backlog of old terminal rows; those deletions and index
maintenance count toward D1's billed row writes.

Workers separately bound notification SQL to D1's
[50 queries per invocation on Free](https://developers.cloudflare.com/d1/platform/limits/).
The same current-invocation repository accounts for bootstrap, subscription and
ledger reads, batched active-history reads, cursor advancement, writes, and pruning.
Before transport, it reserves five queries: one atomic delivery claim and four
for the largest outcome. An accepted active/recovery send records the ledger,
clears retry state, and releases its claim. A rejected send records retry state
and releases its claim. The fifth consecutive hard rejection also writes the
tombstone and deletes the subscription. An expired endpoint uses the tombstone
and delete pair; its claim expires with the short lease. Rejected, failed, or
budget-deferred attempts return unused capacity. Exhausted work fails before
transport; later invocations retry with fresh capacity and rotate recipients.
This bounds query count, not CPU or daily row quotas. A complete live source
snapshot remains live when recipient work is deferred.

Claim acquisition checks persisted retry time as well as the delivery ledger,
so an older subscription snapshot held by another agency cannot bypass backoff.

Claims live separately from accepted delivery history and are keyed by agency,
subscription, incident key, and locale scope. They use the incident key rather
than the upstream alert ID, so feed ID churn cannot admit a second concurrent
push. `v1-` content keys claim per locale; declared `v2-` identities share a
claim across locales. A pending recovery claim leaves every accepted
`active_sent` row untouched. An accepted recovery updates all matching rows for
that incident and locale to `cleared_sent` before releasing the claim.

Each claim expires after 30 seconds. The push transport deadline is ten
seconds. A crashed invocation leaves the claim in place until it can be
reclaimed; owner tokens prevent a stale invocation from completing or releasing
a replacement owner's claim. HTTP acceptance and a database write cannot share
a transaction. If a push service accepts a message and the worker stops before
recording that outcome, a retry after lease expiry can send it again. Delivery
is therefore duplicate-resistant across concurrent evaluations, not exactly
once across HTTP and D1.

Use `--remote` explicitly for production D1 reads. These query examples require
the affected subscription ID, obtained from the rider's existing registration:

```sh
bunx wrangler d1 execute DB_NOTIFICATIONS --remote --command \
  "SELECT timezone, favourite_lines_json, favourite_stations_json, favourite_routes_json, commute_schedules_json FROM push_subscriptions WHERE id = '<subscription-id>'"
bunx wrangler d1 execute DB_NOTIFICATIONS --remote --command \
  "SELECT agency_id, alert_id, incident_key, line_id, route_id, status, delivered_at FROM alert_deliveries WHERE subscription_id = '<subscription-id>' AND agency_id = 'ttc' ORDER BY delivered_at DESC LIMIT 100"
```

Project these facts into the replay schema locally. Do not select or print
endpoint/key columns. The ledger records accepted active/recovery sends, not
failed attempts or device display. `cleared_silent` records recovery observed
outside a commute window; it preserves the last accepted push's `delivered_at`
and does not mean a recovery notification was sent. For accepted sends,
`delivered_at` is the evaluator's supplied time; the push diagnostic's
`observedAt` is the response observation time.

Observe current Worker events with `bunx wrangler tail`. Historical events may
require separate dashboard access under the Worker's Observability/trigger
views. Missing live-tail entries alone do not prove a skipped invocation.
On self-host, capture the existing server/container logs for the incident.

`ProductionScheduler: snapshot received` reports agency, fetch start, observed
time, duration, snapshot generation/source time, freshness, and alert count.
`AlertEvaluator: diagnostic` reports completion counts and push outcomes.
Rejected/expired/failed pushes are warnings with status and timing, without
subscription identity, payload, endpoint, keys, or response body. `LOG_LEVEL=debug`
also exposes skip reasons and snapshot evaluation events. Logs take effect
when the changed application is deployed; they cannot reconstruct old attempts.

Distinguish operator onset, source publication, first observed feed presence,
evaluation, push-service acceptance, and device receipt. One-minute cron
configuration establishes intended cadence, not successful execution or receipt.
The fast alert cron runs every minute and the slow alert cron every fifteen
minutes. Offsetting the slow cron cannot avoid their overlap. Claims protect
these overlaps and invocations that run longer than their cadence.
Use [scheduler tests](../../tests/unit/scheduler-service.test.ts),
[evaluator tests](../../tests/unit/alert-evaluator.test.ts), and
[replay tests](../../tests/unit/notification-diagnostics.test.ts) for regressions
at the stage the evidence identifies.

## Policy and transport checks

`SubscriptionRepository: invalid subscription policies skipped` reports a count
of malformed stored policy rows excluded from evaluation. Valid subscribers
continue; the skipped rows are retained for reconciliation rather than deleted.
Inspect only the affected rider's policy projection, then reopen their app to
sync a validated policy. Database/query failures still fail evaluation.

Only active severe alerts trigger pushes; degraded or upcoming alerts remain
visible in-app. A complete live snapshot is required: `snapshot-not-live` means
no sends or ledger changes, including recovery. Check for partial source failures
when the app has alerts but the evaluator suppresses the snapshot.

An accepted request has a 60-second TTL. If the device is unreachable until after
that lifetime, the message may expire despite an `active_sent` ledger row. HTTP
acceptance is not a device receipt. See [RFC 8030 §5](https://www.rfc-editor.org/rfc/rfc8030.html#section-5).
Do not classify acceptance as successful display.

VAPID signing keys and subscription payload-encryption keys serve different
purposes. A subscription restricted to an old VAPID key is rejected by the push
service ([RFC 8292 §4.2](https://www.rfc-editor.org/rfc/rfc8292.html#section-4.2));
incorrect `p256dh`/`auth` can instead prevent decryption after acceptance. The
client compares the browser's actual `applicationServerKey` with the current
server key, using its local key record only when the browser cannot expose it.
Health checks wait for saved preferences to load. Hydration and reconnect
reconcile the existing browser subscription with the server; failed preference
mirrors receive three retries. Proactive/reactive healing and mirrors share one
queue and read current preferences before registration. Subscription writes
abort after ten seconds; a stored `policy_revision` rejects late older writes
and healing deletes. Atomic deletion retains a hash/revision tombstone so an
older insert cannot recreate the removed subscription. Browser operations also
have deadlines, and reconnect repeats a failed startup key check.
The notification adapter upgrades existing tables lazily
without deleting subscriptions. An old client cannot overwrite a versioned
policy; reload the current app to reconcile it.

A rewritten severe active alert with the same upstream ID is still outstanding
even if its replacement push fails. Neither recovery delivery nor closed-window
bookkeeping treats a changed headline as evidence of resumed service.

Push rejection state lives in `push_subscription_retry_state`, separate from
accepted delivery history. Each subscription has a consecutive retry count, a
consecutive hard-failure count, and a `retry_at` time. The first retry waits two
minutes; later failures double the delay to a one-hour cap. A 429 response's
`Retry-After` value can extend that wait up to 24 hours. An accepted push clears
the retry state. Responses 429 and 5xx, plus network errors and 408/425, retry
with backoff and reset the hard-failure streak. A 413 backs off the request but
does not count toward subscription pruning because it only proves that this
payload was too large.

404 and 410 are direct evidence that the push endpoint is gone, so the evaluator
prunes them immediately. Other endpoint-scoped 4xx responses count as hard
subscription failures, except 401 and 413. A bare 401 stays on backoff without
counting toward deletion because it indicates VAPID authorization, not a dead
endpoint. After five consecutive hard failures, spaced at two, four, eight, and
sixteen minutes, the evaluator tombstones and deletes that subscription. This
gives an endpoint roughly 30 minutes to recover or be reconciled before removal.
The count resets after a transient rejection or an accepted push. Explicit bad
VAPID/JWT response text is treated as a server credential problem: it backs off
without counting toward pruning and invalidates cached agency stacks at most
once every five minutes. A 401/403 status alone does not invalidate stacks.
RFC 8292 also uses 403 for a key that does not match one restricted
subscription, so generic or subscription-key-mismatch responses stay scoped to
that endpoint. VapidClient reads at most 2 KiB of a 401/403 body in memory to
recognize known bad-JWT responses, then discards it. It never logs or persists
provider response text.

Client VAPID-key requests time out after six seconds. Push transport requests
time out after ten seconds. Display text is shortened to keep the
encrypted body within 4096 bytes, while routing metadata remains intact
([RFC 8291 §4](https://www.rfc-editor.org/rfc/rfc8291.html#section-4)). Diagnostics
report status and timing only; the bounded credential check never logs response
text.

Recovery for a recorded line or route is silent when that target is no longer
a favourite. Older station-matched deliveries may carry a line ID without the
station that matched. While any station favourite remains in that agency, those
line-only rows retain their prior recovery behavior because storage cannot
identify which station originally matched. Generic rows without a recorded line
or route remain eligible while any favourite remains in that agency.
