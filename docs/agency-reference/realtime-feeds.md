# Realtime feeds

Part of the [agency guide](../add-an-agency.md). `realtime.feeds` lists vehicle,
trip, and station-arrival feeds. Every feed declares `kind`, `url`, and
`format`. Core owns GTFS-RT protobuf and JSON decoding
(`decodeGtfsRealtimeFeed`), so you never parse protobuf yourself.

## Feed kinds

| `kind`                 | Use                                                                                     |
| ---------------------- | --------------------------------------------------------------------------------------- |
| `vehicle_positions`    | GTFS-RT vehicle positions                                                               |
| `trip_updates`         | GTFS-RT trip predictions, the default source for station arrivals                       |
| `station_trip_updates` | A mode-specific GTFS-RT trip feed; station arrivals prefer it over `trip_updates`       |
| `station_departures`   | An agency JSON departures endpoint; see [JSON departure boards](#json-departure-boards) |
| `nextbus`              | NextBus/UmoIQ, used only when the GTFS-RT vehicle or arrival feed is unavailable        |
| `tmix_anyride`         | Consat/Tmix AnyRide; see [Tmix AnyRide](#tmix-anyride)                                  |
| `fleet_integrations`   | Supplemental live vehicle positions; see [Fleet Integrations](#fleet-integrations)      |
| `transloc`             | Ride Systems JSON tracking; see [TransLoc](#transloc-ride-systems)                      |
| `bustime`              | Clever Devices XML tracking; see [BusTime](#clever-devices-bustime)                     |
| `swiftly`              | Swiftly JSON city tracking; see [Swiftly](#swiftly)                                     |
| `tsimobile`            | Network-wide JSON train tracking; see [TSI mobile](#tsi-mobile)                         |
| `train_map`            | Encrypted network-wide train map; see [train map](#train-map)                           |
| `samsara_boards`       | Public shared-route ETAs and station-board vehicle observations; see [Samsara station boards](#samsara-station-boards) |
| `station_timetables`   | Hub departure and arrival boards; see [station timetables](#station-timetables)         |
| `ferry_sailing_boards` | Per-terminal JSON sailing boards; see [ferry sailing boards](#ferry-sailing-boards)     |

`pollIntervalSeconds` records the publisher's intended cadence. It never
permits polling faster than the publisher allows. `unreliableVehicleFields`
suppresses known-bad `speed` or `occupancy_status` values.

Adding a new kind means adding a Core adapter. The schema rejects unknown kinds,
and `networkDocumentFeed` assigns every known kind to a path. Wire vehicle and
station dispatch in `genericGtfsRealtimeSource.ts` and
`genericStationsSource.ts`, including feed-only interchange callers, before
registering a kind.

## GTFS-RT quirks

Each of these is opt-in. Declare one only after a live capture shows the
problem, and record what you saw.

**`completeTripUpdates: true`** for a verified feed whose ordered stop updates
include the trip's final call, even when realtime trip IDs do not match static.
Core uses seeded station coordinates to infer travel direction under the
manifest's direction policy, names the actual destination, and excludes only
the final call from boarding. Direction and destination are resolved before
stop filtering. Do not enable this for truncated or rolling prediction windows.

**`vehicleTripSource: "entity-trip-update"`** for a combined entity whose vehicle
omits its route and uses a different trip identifier. Core joins it only to the
single trip update in that entity, keeping the physical vehicle ID and timestamp.
Explicit vehicle route identities remain unchanged. Verify the relationship
against a live capture before enabling this.

**`tripDirectionSource: "static"`** for feeds with unreliable trip directions.
Core joins ordinary and modified trip IDs to seeded trips before tracking and
arrival filtering. Known static directions win; unknown trips keep their
descriptor values.

**`duplicateVehicleFixes: "collapse-by-trip"`** for a feed that reports one bus
under two vehicle IDs. Confirm first: same trip and route, positions within
metres, timestamps within seconds. Core keeps one fix per non-empty `trip_id`,
preferring the freshest (its own timestamp beats an inherited header one), then
the lowest vehicle ID, compared numerically when both are integers. It never
merges by vehicle ID or position. Fixes without a trip stay as published. The
collapse runs per feed, so duplicates across two feeds survive.

**`cancelledTripsFrom`** on the `trip_updates` feed, set to the GTFS-RT alerts
URL, for a trip feed that still predicts trips its alerts cancelled. To check,
take the trips in active `NO_SERVICE` alerts and look for them across a few
polls. Overlap changes during the day: on 2026-10-15 Thunder Bay predicted 20 of
24 active cancellations, and a later sample showed none of 27 in 3,621 updates.
Record the check time and counts.

Core then drops predictions for trips named by `informed_entity.trip` in active
`NO_SERVICE` alerts. The alerts feed reuses the trip feed's auth and `accept`
and is read alongside it, so no extra round trip. It fails open: if the alerts
feed can't be read, predictions show unfiltered and the failure is logged. Only
an alert in force now cancels. A trip's own `schedule_relationship: CANCELED`
always applies without this option.

**`tripDirectionExtension`** reads an operator-published protobuf direction enum
when the standard `direction_id` is absent. Declare `fieldNumber`,
`directionFieldNumber`, and `values` mapping wire enums to GTFS directions 0/1.
Standard directions take precedence; an unknown enum stays inferred. The bulk
and station departure decoders share the mapping. The daemon forwards these
GTFS bytes unchanged, including unknown extension fields.

**Modified trips.** Core accepts `modified_trip.affected_trip_id` when the
ordinary `trip_id` is absent, and fills a missing `route_id` from seeded trip
membership. Keep static topology current, since unknown trips can't be assigned
a route. When an event has both `time` and `scheduled_time`, their difference is
the delay even if the publisher sends `delay: 0`.

## JSON departure boards

`station_departures` reads an agency JSON endpoint. Its URL or body template
must contain the literal `{stopId}`. It may declare `lineIds` to scope
departures to particular schematic lines.

For POST, declare `method: "POST"` and a `bodyTemplate` object whose string
values substitute `{stopId}` and `{date}`. `dateTimezone` picks the local date
(default UTC). A body requires POST.

For nested absolute-time responses, declare `responseMapping` with `routesPath`,
`routeIdField`, `departuresField`, and `timeField`, as dot-separated paths.
Optional fields: `directionField` (0/1 or compass words), `headsignField`,
`tripIdField`, `realtimeField`, `cancelledField`, `offRouteField`,
`stopClosedField`, and `terminalField`.

For offset-free timestamps, set `timeZone` on the mapping. `scheduledTimeField`
computes delay from the published schedule. `headsignField` and `directionField`
read each call first, then the route; direction also falls back to the document.
`directionPattern` extracts a 0/1 direction from its first capture group when a
vendor encodes it inside a variant ID. Boolean cancellation fields accept both
JSON booleans and the strings `"true"` / `"false"`. `realtimePresenceField` requires
a live marker such as an assigned bus ID; calls without it are excluded.

GET mappings also serve surface departures through requested stop allowlists.
They never sweep an entire route or network. `requestsPerMinute` limits actual
upstream requests to the feed origin in a sliding process-wide window, shared
by provider ports. Cached stop reads do not consume that budget. This limit is
per isolate on Workers; the publisher's aggregate limit still applies across
isolates. Leave room for alert polling, and treat upstream 429s as failures
without retrying. `pollIntervalSeconds` shares wire reads across station and
surface callers, including through the Workers edge cache.

- Closed stops and cancelled, terminal, and off-route calls are excluded.
- Missing route arrays, departure arrays, or bad timestamps fail the read
  rather than returning an empty board.
- A decoded nested board, empty or not, overrides bulk trip predictions for its
  stops and declared routes.
- Without a mapping, the flat `line` / `directionText` / relative-minute
  `nextTrains` contract applies.

## NextBus fallback

An agency with a NextBus/UmoIQ-compatible provider may add
`{ "kind": "nextbus", "url": "…", "format": "json" }` beside its GTFS-RT feeds.
Core uses it only when the GTFS-RT vehicle or arrival feed is unavailable. The
declaration is the only place for the upstream URL and agency query parameters.

## Tmix AnyRide

`tmix_anyride` is the Consat/Tmix adapter and the pattern to follow when an
operator's only live source is a proprietary JSON API. The manifest names the
base URL and an `operatorPrefix`, because the platform is multi-tenant and
returns every tenant's vehicles. A second Tmix agency is manifest data only.

AnyRide's `line` can be a full public route name rather than the GTFS route ID.
Map every verified wire label with `alertInterpretation.routeLineMap`; Core
applies it to tracking filters, vehicle and arrival identities, and static
direction inference. Add the same labels to `routeIdNormalization.aliases` when
message alerts need route and stop scope.

Optional tenant settings:

- **`profile: { data, display? }`** sends the `anyride-profile-data` and
  `anyride-profile-display` headers the tenant's own web app sends. Copy both
  from the tenant's `GetConfigOptions`. The data profile changes which
  departures a stop returns (one probe saw about ten calls with it and one
  without), and an unknown value returns HTTP 500.
- **`duplicateVehicleFixes: "collapse-by-fix"`** reduces calls that report a
  byte-identical fix (same latitude, longitude, and timestamp) to the
  earliest-departing call, ties to the lowest call id. AnyRide locates a bus
  through every call it will serve, so the bus also appears under its next
  trips, even on interlined routes. It shares
  `src/domain/surface/collapseDuplicateFixes.ts` with `collapse-by-trip`.
- **`stopAreaMap: {}`** when GTFS stop IDs differ from AnyRide's numeric
  stop-area IDs. Declare it empty before the first seed. The seed CLI fills it
  from profile-scoped `GetLines` / `GetStopAreas`, GTFS stop names, and ordered
  occurrences. Missing, conflicting, or ambiguous matches fail the seed. Review
  and commit the map, and reseed when either side changes stop identities. An
  unmapped stop fails rather than showing an empty board.
- **`anyride-messages` alerts.** AnyRide has no messages endpoint, so an
  `alerts` entry with `type: "anyride-messages"` reads the `messages` array of
  `GetCalls` at representative stops: `stops: [{ stopId, routeIds }]`, at least
  one per route and both termini where cheap. Prefer stops served by one route
  and drawn in the schematic. Polls count against `TMIX_MAX_SUBREQUESTS`, and a
  stop the realtime source just polled is reused (`tmixStopPollCache`).
  - One alert per message id, scoped to the queried stop, attributed to the
    lines in `affectedCalls` or else the stop's declared routes. Text stays
    verbatim. An alert is active while its id appears.
  - A failed, empty, or budget-dropped stop makes the read partial and stale.
    No readable stop fails the source.
  - Classify with `alertInterpretation.rules` using `sourceField`
    `isDisturbance`, `isInfo`, and `priority`. Unmatched messages stay
    information.
  - The daemon implements the same rules (`parser: "anyride-messages"` with
    `operatorPrefix`, `profile`, and `stops`) at `/<id>.json`. Declare a second
    source with `relay: "daemon-document"` when the upstream blocks Workers.
    Both pass `tests/fixtures/realtime/tmix/messages.contract.json`.

## TSI mobile

`tsimobile` reads a network-wide JSON train-tracking document. It must be the
only realtime feed. Declare `pollIntervalSeconds` (300 for VIA's best-effort
endpoint) and a generated `gtfsIndex`. The seed command rebuilds the index from
`stop_code` and `trip_short_name` and puts every served rail station in
`stationIndex`, even ones the schematic omits. Change the drawn subset with
aliases and sequences, then reseed. Never hand-copy opaque stop IDs into a
prediction join. The adapter shares one document across station and vehicle
queries and shows a tracked-trains-only notice. Omit `alerts` when the operator
has no live network alert feed.

## Train map

`train_map` reads an encrypted, network-wide GeoJSON train map. It must be the
only realtime feed. Declare `decryption` (the page's published public key,
salt, IV, PBKDF2 iterations, and sealed-password length), `recordTimeZone` for
the offset-free `updated_at` stamps, and a generated `gtfsIndex`. The seed
command builds the index from `stop_code`, each stop's `stop_timezone` (or the
agency zone), and the rail `trip_short_name` numbers of `sourceAgencyIds`. It
fails if one number belongs to two routes or directions. Station times are read
in each station's own zone. Only `Active` trains whose record is under 15
minutes old count. A station becomes a prediction only if it has a future
estimated departure and no recorded departure. Trains and station codes the
archive does not know are skipped, not failed, because the map also tracks
services outside the static feed. Station cards show tracked trains only, as for
`tsimobile`.

## Station timetables

`station_timetables` polls the departure and arrival boards of a few hub
stations, whose rides list every ordered call, so the hubs cover every stop
their rides serve. It must be the only realtime feed. The URL holds `{station}`,
`{board}`, `{from}` and `{to}`; `lookbackHours` and `lookaheadHours` set the
board window, which the API caps at 36 hours. `cityRegions` lists the region
codes ending each stop's city name (`Toronto, ON`, `Washington, D.C.`) that the
agency owns, so a cross-border operator splits its stops between national
modules without polling the other's stations. Only an `ESTIMATED` departure at
an owned stop, in the future and updated within the hour, becomes a prediction;
schedule-only and cancelled calls never do. A coach appears with a fix under 10
minutes old on a ride serving an owned stop. Every board must read for a
refresh to count, and boards listing no rides fail the read. The seed writes
each line's `directions` from the static archive.

Without a published GTFS, declare the static feed with `stationTimetables`
(`stations`, `cityRegions`, `timeZone`) and the same URL. The seed and the weekly
refresh build a GTFS archive from two days of boards: routes from line codes,
stops from owned calls, one trip per stop pattern, and directions oriented by
each ride's full call order.

## Ferry sailing boards

`ferry_sailing_boards` reads one JSON board per terminal and route, keyed by the
operator's terminal codes. It must be the only realtime feed.

- The URL contains `{terminal}` and `{board}`.
- Declare `timeZone` for the board's offset-free local times.
- Declare a curated `terminals` map from each code to its GTFS parent station.
- Declare every `boards` entry with its GTFS `routeId`, because the API has no
  listing endpoint. Include only boards observed to list sailings.

The seed command generates `legs` (direction and headsign per terminal pair) and
`terminalNames`, and builds one station per terminal with its berths as
platforms. A pair missing from the static feed keeps the board's route with
direction `0`. Departed and cancelled sailings are dropped. Rows show the
scheduled time plus the operator's non-routine status text, never an invented
prediction. An unrecognized board, undeclared terminal, or schema change fails
the read, and a failed read reuses the last good board as stale.

## The `accept` override

`accept` changes the request media type for GTFS-RT vehicle, trip, station trip,
and `gtfs-rt` alert sources. It never changes the decoder (`format` does) or the
URL.

- Defaults: protobuf sends `application/x-protobuf`, JSON sends
  `application/json`, and a non-GTFS source with no format sends no `Accept`.
  A `gtfs-rt` alert with no format counts as protobuf.
- Allowed overrides: `application/octet-stream`, `application/protocol-buffer`,
  `text/plain`, and `*/*`. Explicit `application/x-protobuf` and
  `application/json` are rejected; use the defaults.
- Use an override only for an origin that rejects the default (often HTTP 406).
  Use `*/*` only when it rejects the specific types too.
- Validation rejects `accept` on NextBus, `station_departures`, and JSON, RSS,
  and web alert sources rather than ignoring it.

```json
{
  "kind": "vehicle_positions",
  "url": "https://example.test/gtfs-rt/vehicle-positions.pb",
  "format": "protobuf",
  "accept": "application/octet-stream"
}
```

## Auth and secrets

Declare feed auth with `FeedAuthSchema`:

```json
"auth": { "type": "header", "headerName": "X-API-Key", "secretName": "FEED_METROLINX_API_KEY" }
```

Providers stay environment-free (ADR-0007). `createAgencyRuntime` injects
`ctx.getSecret(secretName)`, and `applyFeedAuth` adds the header or query
parameter. Set the value in Cloudflare Workers secrets or `.env`. A 401 or 403
logs a warning with key registration steps and fails with `RealtimeError`.

For local `vite dev`, set the secret in the server environment. A feed with
`devProxyPrefix` goes through the same-origin Vite proxy with the secret applied
server-side, so the browser never sees it. Never put a key in browser env vars
or client modules. Don't retry `429`; use bounded retries only for transient
transport and server errors.

## Swiftly

Declare a single `kind: "swiftly"`, `format: "json"` feed whose URL is
`https://api.goswift.ly/real-time/<agency-key>`. It owns vehicles and departures,
so it cannot be combined with another departure source. Supplemental
`fleet_integrations` position feeds may coexist. Use header auth for the
vendor's `Authorization` credential and a deployment `FEED_…` secret. Never
commit the credential or put it in a browser variable.

Core reads `/info/<agency-key>/routes?verbose=true` hourly to join route IDs,
literal route short names and stop codes. Keep static route IDs as the canonical
IDs. Predictions are queried for each requested route/stop pair. Wire documents
share authenticated polling across the surface and station ports at intervals
of at least ten seconds. The adapter owns this polling, so the provider factory
does not wrap it a second time.

Surface reads use at most 40 subrequests, including vehicles and the route
directory, with four concurrent prediction requests. Oversized boards take one
stop per route before another from the same route, and rotate stop selection
with the polling interval. Truncated or failed portions are marked partial;
complete source failure rejects. Targeted stop allowlists restrict the work.

Only vehicle-derived predictions are live. `scheduleBased: true` rows and
`_schedBasedVehicle` identifiers are excluded; live rows can omit
`scheduleBased`. Arrival-only calls with `atEndOfTrip: true` are excluded.
An explicit `departure: true` preserves boarding at a loop's origin even when
that platform also ends the trip. Estimated times stay as published. Vehicle
fixes older than five minutes are omitted.

## Fleet Integrations

`fleet_integrations` reads the public fleet tracker JSON document at its declared
URL. `routeIds` lists the service labels from `data.results[].route_name` that
belong to this agency. The adapter reads only vehicle identifiers, route labels,
GPS fixes, bearing and speed. Driver names, addresses and marker HTML never
enter the normalized payload or parser diagnostics.

These feeds supplement departure sources such as Swiftly. Independent source
failures preserve working data and mark the combined result partial. A targeted
vehicle-only service skips unrelated departure sources. All sources share the
caller's subrequest ceiling, including fleet polls. Wire polls share a minimum
ten-second cadence across consumers.

Fixes older than five minutes, more than one minute into the future, or outside
valid latitude/longitude ranges are omitted. Empty successful fleets stay empty;
malformed documents and upstream failures reject. Numeric strings for speed and
coordinates are supported. The adapter never turns a GPS fix into an upstream
stop prediction.

When the publisher has no static stop or shape feed for these services, declare
them in `staticTopology.vehicleOnlyRoutes`. The seed and weekly refresh retain
their catalog entries alongside GTFS routes without inventing geometry or stops.
The route view frames the declared service area so moving vehicles stay in view,
and explicitly states that stop predictions are unavailable. Failed reads show
unavailable status, or last-known positions marked stale after a previous success. Services with real stop predictions should use
those feeds instead.

## TransLoc Ride Systems

Declare `kind: "transloc"`, `format: "json"`, the `JSONPRelay.svc` base URL,
raw numeric `routeIds`, and an optional `idPrefix` matching static GTFS IDs.
When GTFS uses route-stop identities instead of physical stop identities, declare
`stopIdField: "RouteStopId"`; the default is `StopId`. Verify this join against
seeded stops before enabling departures.
Core batches `GetStopArrivalTimes` across those routes and shares wire polls
between station and surface consumers. Only vehicle-assigned `EstimateTime`
values become live predictions. Departed calls and schedule-only entries are
excluded; empty off-hours boards remain valid.

Vehicle fixes come from `GetMapVehiclePoints`. Core anchors the published
`Seconds` GPS age to the cached response's HTTP date, falling back to receipt
time when the server omits that header. The vendor's vehicle `TimeStamp` can
be hours ahead of its own server clock. Departure epochs are UTC instants.
A failed optional vehicle poll keeps departures visible as a partial result.

## Clever Devices BusTime

Declare `kind: "bustime"`, `format: "xml"`, and the public `/bustime/map` base
URL. Core polls `getBusesForRouteAll.jsp` and requests `getStopPredictions.jsp`
only for selected stops, using seeded public stop codes and route membership.
Ambiguous stop codes fail instead of selecting a different platform. Boards are
bounded and incomplete reads remain partial.

Only vehicle-linked predictions explicitly marked `scheduled=false` become
live departures. `DUE` and minute countdowns are anchored to the cached response's
HTTP date, with receipt time used when absent. Cache hits never advance an old
countdown. `DUE` stays imminent for one 30-second poll interval after that
observation, then expires. Vehicle positions use the document observation time because this
public format has no GPS fix timestamp. Native block IDs are not GTFS trip IDs;
Core uses synthetic vehicle/route identities and topology-based directions.

## Countdown boards and signed queries

A `station_departures` mapping can use `$` for a root row array and for a row
that is itself one departure. `timeFormat: "countdown-seconds"` adds `timeField`
seconds to `updatedAtField`, interpreted in `timeZone`. `maxAgeSeconds` bounds
that source observation. `realtimeOnly: true` excludes rows whose `realtimeField`
is false. `delaySecondsField` and `stopSequenceField` preserve published trip
facts. Declare a feed's required public request headers in `headers`.

A GTFS-RT trip feed can declare `emptyTripUpdates: "error"` when a header-only
payload cannot establish live coverage. This check precedes requested stop
filters, so a valid feed with no matching nearby calls remains a valid read.
TransLoc feeds have the equivalent `emptyArrivals: "error"` option, which
requires an unexpired vehicle-assigned estimate on a declared route before
applying caller filters.

Minute-signed query authentication declares `type: "custom"`,
`scheme: "sha256-minute"`, `keySecretName`, `secretName`, `keyParameter`, and
`signatureParameter`. Both secret names must resolve through the `FEED_`
namespace. The signature is uppercase SHA-256 of the private secret followed by
UTC `yyyyMMddTHHmmZ`. Authentication uses Web Crypto on both runtimes; diagnostic
URLs redact the public key and generated signature. Vehicle-only GTFS-RT reads
skip trip updates and their cancellation source.

## Local-time and stop-code boards

A GET `station_departures` URL can substitute `{date}` as `yyyyMMdd` in
`dateTimezone`. `requestStopIdPattern` extracts the request ID from the first
capture group while keeping the seeded stop ID on returned predictions.
`emptyBoardIsError` rejects an empty root array when that response means an
unknown stop rather than a quiet board.

`responseMapping.timeFormat: "local-time"` reads `HH:mm:ss` in `timeZone`,
including extended hours through `47:59:59`. It places the clock in the window
from six hours before receipt to eighteen hours after receipt, resolving the
calendar day in the operator's zone. Use this only for a current departure
board, not a day-long timetable. Numeric `1` and `0` flags are accepted beside
booleans. A route-level `terminalField` excludes arrival-only boards.

## Zenbus publicapp

`zenbus` reads the publicapp protobuf poll, rather than treating it as GTFS-RT.
It must be the sole realtime feed. Declare `format: "protobuf"` and a polling
interval of at least the operator's web-app cadence. The seed generates
`gtfsIndex` from the native itinerary IDs, ordered stops, route codes and
inferred directions. Vehicle and station consumers share one network poll.

Only columns with a position under five minutes old produce predictions. Calls
must have an `estimactual` time after now and be at or beyond the live target
stop. Aimed-only calls, cancellations, non-passenger service and final calls
are excluded. Relative times use the publisher's UTC midnight, preserving the
service day across time zones. IDs remain exact decimal strings.

For source-native topology, declare `zenbus: { "timeZone": "America/Toronto" }`
on a static feed whose URL is the publicapp `static-data` endpoint. Manual
seeding and weekly refresh read seven dates so weekday and weekend itineraries
remain in the catalog. Native shape points are retained. The generated archive
contains topology patterns, not a timetable service. Its placeholder times
never supply live departures. Reseeding also regenerates the message source's
`stopCodeMap` from the same stop identities.

## Cityway stop boards

A `cityway` feed declares its API origin in `url`, the operator's schedules
page in `riderPageUrl`, `networkId`, `timeZone`, and a seed-generated `stopMap`.
The seeder walks the line/direction roster and joins public stop codes and
boarding coordinates to GTFS stops. Nearby duplicate GTFS records for one code
share the vendor boarding identity. Runtime queries use that index, never a
network-wide roster crawl.

The adapter discovers the public `apikey` from the rider iframe and caches it
for an hour. Boards are requested by logical stop, line and direction, because
the returned journeys omit route IDs. Only non-null `RealTime` values are live;
rows without them retain `TheoreticalTime` and remain marked scheduled.
`EntryNotAllowed` prohibits boarding; `ExitNotAllowed` does not. Offset-free
times use the feed's `timeZone`.

Use a sparse `pollIntervalSeconds`, normally 60. Stop-board requests are
sequential, capped by the invocation budget and a 60-request-per-minute host
limit. Truncation or a failed board is partial, never a complete empty result.
This feed serves departures only; SignalR vehicle tracking is not declared.

## Passio stop boards

A `passio` feed declares `userId`, the vendor timestamp `timeZone`, and
seed-generated `routeMap` and `stopRoutes`. The vendor clock may differ from the
agency timezone. `routeMap` preserves every native pattern as an alias of its
public route. The stop board omits a request `routeId` to read live assignments
across those patterns; a pattern-specific board may contain only an old
schedule fallback. Returned predictions are deduplicated after decoding.

The adapter excludes GPS-error, outdated and out-of-service estimates, checks
observation age, and marks an unusable nonempty board stale. An invocation
budget bounds per-stop reads. The network vehicle board is polled separately
and collapses duplicate physical buses.

For an operator without static GTFS, declare `passio: { userId, timeZone }` on
its static feed and `routeIdField: "short_name"` on `staticTopology`. Seeding
builds topology from native patterns, ordered stops and route points. Its
pattern-only archive has no service calendar and supplies no scheduled arrivals.

## Hubup revised calls

A `hubup` feed declares the passenger API origin in `url`, `tailsUrl`,
`companyTag`, and `timeZone`. Live tails join their revised trip and next-call
identity through the trip-detail endpoint. The adapter resolves revised stops
to real stop IDs, discards calls preceding the live next stop, and adds
`fg_lateness` in minutes to the remaining scheduled calls. Distance remaining
is not a time prediction. A tail without live lateness supplies no arrivals.

Only fresh observations belonging to the requested company and routes count.
An unresolved next-call identity or a stale nonempty scoped feed fails the read.
Extended clocks such as `25:05` stay with the overnight trip's service day.
Vehicle-only queries skip the trip-detail read.

## Samsara station boards

`samsara_boards` declares a station-selectable JSON board in `url`, the public
Samsara `trackerOrigin`, its `orgId`, and a seed-generated `stations` map. Each
station carries its exact board name, coordinates, and source-native route IDs.
Set `pollIntervalSeconds` and `requestsPerMinute` to bound both origins.

The board discovers operator-published sharing links. Core reads their computed
`etaMs` and `etaRefreshedAtMs` through the public tracker protocol, using an
anonymous session and CSRF token kept on the server. No operator credential or
sharing token belongs in a manifest. Cookie rotation is retained; a rejected
session is renewed once within the request budget.

For route reads, a small set of hub boards covers the requested routes. Each
sharing link supplies the complete route's jobs, joined to seeded stops by
the nearest coordinates within 150 metres, requiring a 25-metre lead over any
other candidate. The anchor job also checks its exact
station name and job ID. Nearby reads retain the requested stop allowlist.
Unknown or ambiguous jobs never acquire a guessed stop identity. Fleet-only
reads use the hub boards' fresh GPS fixes without requesting departure trackers.

Only computed, future stop arrival estimates refreshed within twenty minutes
become predictions. Timetable times, completed calls, and the route's terminal
arrival never become boardable departures. Scheduled dwell is not added to
manufacture a departure estimate. Fleet fixes expire after three minutes and
are assigned to the vehicle's most recently started observed route. A failed
job preserves other successful jobs and marks the result partial; an entirely
failed read throws. Complete empty boards remain valid empty results. With no
public advisory channel, omit `alerts` so status remains unavailable.

## Network station countdowns

A GET `station_departures` feed can use `responseMapping.networkStations` for
one network-wide board. Declare the station array `path`, native `idField`,
`groupsField`, and a `stopCodes` map from seeded boarding IDs to native station
codes. `departuresField` selects each group's message array; the ordinary field
mapping then reads each message. `routeAliases` maps published service tokens
such as colors to canonical routes; `directionAliases` maps group labels to 0/1.
Unknown services or missing station records fail the read.

Countdowns accept finite nonnegative numeric values or decimal strings and use
the message's own `updatedAtField`. Cached reads retain the same absolute time
and recheck source age. Network messages without train IDs use an observation
identity scoped to station, route, direction, destination and prediction time,
so array order cannot impersonate a persistent train. They supply no GPS fixes.
A URL may use `{timestamp}` for an epoch-millisecond poll bucket when the
operator's frontend requires a cache-busting query parameter.
