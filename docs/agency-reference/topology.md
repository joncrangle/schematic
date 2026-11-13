# Topology and seeding

Part of the [agency guide](../add-an-agency.md). Surface routes, stops, and
shapes live in the shared transit database (`DB_TRANSIT`), partitioned by
`agency_id`. A new agency needs no new database and no `wrangler.jsonc` edit.
Agencies without static surface topology omit topology feeds.

## Alert identity artifacts

Manual seeding also generates `src/generated/alert-identities.json` and
`public/generated/alert-identities/` for alerts that need static identity.
Commit these generated files together. Do not edit them by hand. They replace
runtime database lookups for shared-feed membership, stop-code/route-name
resolution, and trip-only alert selectors.

To rebuild them from an already seeded local SQLite database without downloading
feeds or contacting D1, run `bun run alerts:index`. Use `--agency=<id>` to update
one agency. `bun run alerts:index:check` verifies deployment completeness and
file integrity without database or network access; `bun run deploy` includes
this check.

Run a manual SQLite seed and deploy after GTFS identity changes. The automatic
database refresh (each agency about weekly) does not update deployed static
assets. A newly introduced trip stays unresolved in alerts until deployment, while
departures fall back to D1 for trips the index lacks; shared-feed route/stop
membership likewise uses the deployed GTFS version. Self-hosted builds need the
catalog and matching static files from the same build, including when SQLite
is seeded separately after building.

## Station identity

Every station in a schematic has an explicit, stable, agency-local lowercase
kebab-case `id`. Once published it's immutable: display names can change for
corrections or translations, the ID can't. Schematic IDs belong to the
repository, so never copy GTFS parent or platform IDs into them.

- `sequences`, `cornerInsertions.stationId`, and `stationAliases` values use
  schematic IDs.
- The station index keeps the feed's value in `id` and links the schematic value
  in `schematicId`.
- Only the seed ingestion adapter may normalize feed names. It rejects ambiguous
  matches and keeps the canonical display name.
- A station grouping several feed stops (a bus terminal with stops on both
  sides, or a nearby stop joined by a `code:` alias) gets the schematic ID as its
  `stationIndex` `id`, with the union of stops as `platformIds`. A station
  matching exactly one stop keeps that stop's ID. Its card lists a trip calling
  at several of those stops within five minutes once, at the earliest call; a
  circuit's later pass through the station stays a separate departure.
- Join stops that share no name with a `code:<stop_code>` alias, which matches by
  code and never by name.
- Interchange references are `{ agencyId, stationId }` pairs. `stationName` is
  display text and may stand alone on a mapless or feed-only endpoint;
  actionable map endpoints need `stationId`.

When drawing from a PDF, review every ID by hand, especially punctuation,
directional suffixes, parentheses, ampersands, and duplicate names.

A schematic is a declared network, not a stop map. Add a bus station when the
schematic represents that bus network, with normal line membership, sequence,
and identity. Never add an isolated bus point just so an interchange can
navigate to it. Leave an off-network endpoint without a schematic ID; never
invent one or reuse a feed ID. Interchange seeding keeps its `feedStopIds`, so
its departures still appear in a peer agency's station card without map
navigation.

## Static topology options

`createAgencyProvider({ manifest, schematic })` wires topology, realtime,
snapshot, and stations directly from JSON. Set `staticTopology.source` to
`"nextbus"` or `"seed"`. Seed-managed agencies never try a NextBus crawl. A
NextBus agency names its slug in `staticTopology.agencySlug`, which may differ
from the repository ID.

**`routeIdField`.** Set it to `"short_name"` when the GTFS uses versioned route
IDs that differ from stable line designators. The seeder then uses
`route_short_name` as the canonical ID. Check `routes.txt` first: if
`route_id` and `route_short_name` match on every row, omit the field. Nothing
fails when you choose wrong. The schematic just drifts from the seeded catalog,
because every route id in `sequences`, `routeLineMap`, and
`popularSurfaceRoutes` matches against the folded id. The fold lives in
`src/infrastructure/gtfs/staticTopology.ts` and applies to manual seeds and
runtime refresh alike.

```json
"staticTopology": {
  "source": "seed",
  "routeIdField": "short_name",
  "feeds": [{ "url": "https://example.test/gtfs.zip", "cacheFileName": "agency.zip" }]
}
```

**`routeShortNames`** (top-level manifest field) maps canonical route IDs to
labels checked against the operator's current rider tools. It changes display
labels only; IDs and trip membership still follow `routeIdField`. Station and
departure chips show the label while interactions keep the canonical ID.
Include off-schematic routes, since they can serve a drawn station. Changing the
map invalidates the stored archive hash.

**`ignoreFeedRouteColors: true`** with `defaultColor` and `defaultTextColor`
replaces a placeholder `route_color` (such as `000000`) on every route.
`defaultColor` is also the agency brand colour, so use one the operator uses.

**`sourceAgencyIds`** selects raw `routes.txt` `agency_id` values from a shared
multi-operator archive. Selection happens before ID folding and limits the
seeded routes, trips, stops, and shapes. Realtime vehicles and departures then
join only the selected operator's trips; unknown trips stay unassigned. Alerts
keep published scope at shared facilities and exclude foreign-agency selectors,
including unattributed routes, stops, and trips outside deployed membership. An
unattributed selector for this agency's own route newer than the deployment is
dropped until the next seed and deploy; naming `agency_id` keeps it. Departures
resolve trips missing from the deployed index in D1; alerts never query D1. Seed
before verifying these paths.

**`stationTimetables`** on a feed builds its archive from an operator's station
boards instead of downloading a GTFS; see
[station timetables](realtime-feeds.md#station-timetables).

**`excludedRouteIds`** drops raw route IDs, with their trips and exclusive
stops, before folding. Use it for booking-only or non-service routes, and record
the rider-tool evidence for each one.

## Seeding

```sh
bun scripts/seed.ts --agency=<id> --db=sqlite
```

This downloads the official feed, seeds `data/transit.db`, and regenerates the
schematic's `stationIndex` when `stationService` is declared. Other targets:
`--db=d1` (local Miniflare D1), `--db=both` (both local targets, the default),
and `--db=remote` (the configured remote `DB_TRANSIT`). Pass a target
explicitly. The seeder derives route types from `modes`, builds canonical
shapes, and scopes writes by `agency_id`.

The seeder groups feed stops onto `sequences` stations. When a feed name doesn't
match a schematic name, add a `stationAliases` entry (`"feed name" → station id`),
or `"code:<stop_code>" → station id` for same-named stations. The same feed and
manifest always produce the same `stationIndex`. Follow the
[generated-data standards](../../CODING_STANDARDS.md#generated-station-data) for
field ownership.

All writes go through one keyed reconciler: manual SQLite, local D1, remote D1,
and automatic refresh. Only new, changed, or removed keys mutate rows. An
unchanged destination writes nothing, not even freshness metadata. Moving one
stop writes one stop row plus `seed_topology_meta` and `topology_meta`. Manual
seeds set `verifyDestination: true` and compare real rows despite matching
hashes, so they can repair corruption.

## Weekly refresh

- **Cloudflare** runs a portable external Bun job, scheduled daily at 04:00 UTC
  by Forgejo or another cron host. GTFS projection can't fit the Workers Free
  10 ms CPU budget, so Workers keep only the alert crons. See
  [portable refresh setup](../deployment/topology-refresh.md).
- **Self-hosting** runs its own `SurfaceTopologyScheduler` timer against local
  SQLite.
- Both drivers give each seed agency a stable weekday and a seven-day TTL. Fresh
  agencies skip; a failure doesn't stop the others and retries next week.
  Startup never refreshes everything or catches up missed runs.
- Refresh never populates an empty store. It logs `needs-seed` and stops. Use
  the seed command for the first population, urgent updates, and repairs. An
  unchanged check doesn't advance `topology_meta.last_sync`.

Refresh doesn't rewrite the compiled `stationIndex` or `interchanges.jsonc`.
When logs report moved stops, regenerate, review, commit, and deploy:

```sh
bun scripts/seed.ts --agency=<id> --db=sqlite
bun scripts/seed.ts --interchange-only
```

## Remote seeding

For first-time production topology, run
`bun scripts/seed.ts --agency=<id> --db=remote` after the agency is registered
and its static feed has been checked. It uses the configured `DB_TRANSIT`
binding; credentials and remote setup are in the deployment guide.

## Multiple feeds and versioned identifiers

Use a static feed's `idNamespace` when its IDs can collide with another feed
from the same agency. Declare the same namespace on its GTFS-RT vehicle,
trip-update, and alert sources. Core prefixes route, trip, stop, shape, and
vehicle identities before matching them. Public stop codes remain unchanged.

`stripIdPrefixPattern` removes a leading static board prefix before namespacing.
Patterns are anchored Unicode regular expressions. For example,
`^\p{L}+[0-9]{2}` handles letter month abbreviations followed by every two-digit
year. Calendar service IDs retain their board prefix, so two boards' calendars
cannot accidentally merge. `routeDirectionIds` supplies explicit direction IDs
for raw routes when the static feed has direction-specific routes but omits
`direction_id` from trips. `additionalRouteTypes` admits published extended GTFS
route types alongside the agency's declared modes.

## Delay-only live predictions

A GTFS-RT feed may publish live delays without absolute event times. Opt into
`predictionTimeSource: "static-with-delay"` on that trip feed. Manual SQLite
seeding then publishes `src/generated/gtfs-schedules.json` and immutable assets
under `public/generated/gtfs-schedules/`. Commit and deploy both together.
`bun run deploy:check` verifies completeness, hashes, byte limits, and scope.

Core joins an explicitly delayed live event to its trip, stop sequence, and
service calendar. Calendar exceptions and overlapping board generations remain
separate. GTFS times after midnight stay on their service day. Absolute live
times take priority; a trip's `start_time` never becomes a prediction by itself.
Missing trips, unknown stops, ambiguous calendars, and events without an explicit
live delay produce no invented departure. These assets use the same bounded
cache and read permits as alert identity assets and never query D1.

For feeds that sometimes put a public stop code in `stop_id`, declare
`stopIdAliases: "static-code"` on the affected realtime or alert source. Core
prefers an exact static stop ID, then an unambiguous public code. Unknown and
ambiguous codes keep their published identity. Resolve aliases before filtering
requested stops. A manual seed also publishes the necessary static scope index.

Automatic topology refresh does not publish these assets. Reseed and deploy to
admit new static trip IDs or the next timetable board.

## Vehicle-only services

An agency with live departures may also publish a fleet tracker for services
without stop predictions or static GTFS. Declare these supplemental services in
`staticTopology.vehicleOnlyRoutes` as `{ id, shortName, longName }`, using the
publisher's actual service identifiers. Their realtime vehicle feed must use the
same route IDs. They remain searchable and selectable in targeted mode.

Manual seeding and weekly refresh include these entries in `routes`, with no
fabricated stop, shape, trip or terminal rows. The declaration participates in
the seed hash, and a collision with a GTFS route fails the seed. This does not
admit a separate static-only agency or present timetable times as live arrivals.

## Source-native Samsara stations

A static feed with `samsaraStations: { timeZone }` reads a complete Strapi
station roster instead of downloading GTFS. Core builds a topology-only archive
with source station IDs, route names, station time zones, and published stop
order. It writes no service calendar and cannot manufacture scheduled service.
Schedule membership remains valid when the route relation is empty. An
unordered relation keeps stop membership without inventing a multi-stop path.
A record without coordinates, schedule, or routes is an unserved placeholder
and is excluded; missing coordinates on a serving station fail the seed.

Optional `samsaraStations.coordinateOverrides` maps source station IDs to
verified `{ lat, lon }` facility coordinates when upstream coordinates are wrong.
Record the authoritative facility source and check date in the PR.
`routeAliases` maps abbreviated schedule labels to verified source route names;
Core never infers an alias from a station having only one route relation. The same
overrides apply to manual seeding, the realtime station index, and automatic
topology refresh. The seeder rewrites the `samsara_boards.stations` map.
