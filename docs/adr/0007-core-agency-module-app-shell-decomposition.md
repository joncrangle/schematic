# Core / Agency-module / App-shell decomposition

Multi-agency support requires each agency to be self-contained: adding a city
means one new agency module and no Core edits. The codebase is split into three
tiers with a mechanical litmus test.

## Decision

**Litmus test**: _"Could this file serve any agency unchanged?"_

- **Core** — yes. Generic transit machinery: agency contract types and registry,
  format adapters (GTFS, GTFS-RT, NextBus, RSS, JSON, web parsers, Tmix AnyRide,
  `tsimobile`), snapshot serving, route tracking, `SurfaceDataStore` adapters,
  location resolution, preferences, alert interpretation, and the schematic
  rendering engine. Core lives in `src/domain`, `src/lib`, `src/services`,
  `src/infrastructure`, and `src/core`.
- **Agency module** — mentions or assumes one agency. A module is data only:
  `manifest.json` plus optional `schematic.json` under
  `src/agencies/<scope>/<region>/<agency_id>/`, entered in the
  [data catalog](../../src/agencies/agencyCatalog.ts). `createAgencyProvider`
  validates both files and builds the generic topology, realtime, snapshot, and
  station ports. Modules contain no TypeScript, selectors, parser code, or
  agency conditionals.
- **App shell** — wires both for this product: routes, context providers,
  service worker, navigation and settings chrome, and notification wiring.

**Dependency rule**: agency identity is data. Core uses plain `string` agency
IDs, never imports an agency module, and never names an agency. The app shell
may import both tiers. Server and browser registries project the catalog
independently.

**Enforcement**:

- [Oxlint](../../.oxlintrc.json) `no-restricted-imports` and
  [domain-boundary tests](../../tests/unit/domain-boundary.test.ts) bar Core
  directories from deep-importing agency modules. Removing either guard fails
  loudly.
- [Module-shape tests](../../tests/unit/agency-module-shape.test.ts) require
  each module directory to hold only its manifest and schematic and to be
  registered in the catalog. An Oxlint override on `src/agencies/*.ts` stops the
  registry and provider factory from importing a module.
- Generated map subdirectories and agency-specific runtime code are a review
  convention with no guard.

### Runtime wiring

Requests resolve a provider by bounds match (`getAgenciesForPoint`);
background work iterates `allProviders()`. Per-agency Effect layers build
lazily and are cached per isolate. Storage is described in
[ADR-0009](0009-two-database-storage-topology.md); `scope` and `jurisdiction`
group seed configurations and do not select database files.

[NearbyTransit](../../src/services/surface/NearbyTransit.ts) is the deep module
for surface transit: it owns stop selection, fetching, fusion, staleness, and
approaching-vehicle ETAs behind `TopologySource`, `RealtimeSource`, and
`SurfaceStoreWriter` adapters.

### Manifest-owned operational defaults

Bounds, `cityPresets`, `directionLiterals`, `staticTopology`, `realtime`, and
the optional `focus` point are manifest data. `focus` sets the geographic
centre for manual locations and nearby queries; fallback bounds use the union of
declared bounds. A schematic's `defaultViewportBounds` controls camera framing
separately.

### Alerts

The optional top-level `alerts` array selects Core adapters: `gtfs-rt`,
registered `json`, `rss`, or registered `web`. `realtime.feeds` holds only
vehicle, trip, and station-arrival feeds. RSS sources declare a maximum item age
or opt into `feed-presence` expiry; explicit end dates take precedence.

[fetchAgencyAlerts](../../src/infrastructure/realtime/fetchAgencyAlerts.ts)
applies declared auth, fetches every source, dispatches to the registered
decoder, deduplicates `GenericAlert` values, and passes them to
`interpretSnapshot`. A partial source failure marks the result stale; total
failure is an error; no configured source yields an unavailable empty snapshot.
Agencies without alerts expose an alert-availability capability, and the UI
says live alerts are unavailable.

Decoders preserve protocol effects, labelled source fields, and informed-entity
relationships. `interpretSnapshot` maps that evidence to the shared vocabulary
using `BASELINE_ALERT_RULES` and optional manifest `alertInterpretation.rules`,
which match normalized effects, exact source fields, or text only when no
structured equivalent exists. Unknown prose stays informational. Resolution
keywords that also describe ongoing disruptions (`cleared`, `lifted`,
`has ended`) are not resolution terms, so ambiguous text fails toward showing
the disruption rather than a false all-clear.

### Station identity

Schematic stations have stable, agency-local, lowercase kebab-case IDs that are
reviewed and immutable once published. Display names are presentation data.
Feed GTFS IDs stay in `stationIndex.id`, with an optional
`stationIndex.schematicId` link. Map selection, sequences, corners, and
interchange navigation use station IDs; cross-agency references use the pair
`(agencyId, stationId)`. Interpreted alerts carry `AgencyStationReference`
values that include a schematic ID whenever one resolves unambiguously and stay
name-only otherwise. Core never matches display names to topology stations.

### Agency selection

[EffectiveAgency](../../src/domain/location/EffectiveAgency.ts) ranks covering
agencies by the tightest covering bound. Automatic prefers a regional or
omitted-scope agency and falls back to the first ranked national or
international agency only when no local agency covers the rider. Non-local
agencies still contribute departures to shared nearby station cards.

Without a covered location, or a previous Automatic winner held for the session,
Automatic is unresolved:

- The shell shows "Choose your transit network" with searchable networks,
  favourites first, and an optional "Use my location" action. Location access
  is requested only on the rider's action. A fix outside every declared bound
  shows the same chooser with a not-found message.
- A saved manual selection
  ([ADR-0002](0002-client-preferences-and-store-architecture.md)) is restored
  after hydration; an invalid saved ID returns to Automatic. Unresolved state or
  a held winner is never persisted as a manual choice.
- The unresolved shell renders no schematic, live status, or network panels and
  issues no snapshot requests. Choosing a network supplies no synthetic position
  or extra nearby coverage.
- `EffectiveAgencySnapshot.agencyId` and `automaticAgencyId` can be undefined;
  consumers handle that before loading network data.

Changing the displayed network, by Automatic, manual choice, or interchange
navigation, ends targeted route mode and releases its tracking subscriptions.
Route data is scoped to agency and route identity, released subscribers receive
no late arrivals, and changing direction clears stop and vehicle selections.
Targeted mode can always be dismissed, including before its first response.
Until an agency's first snapshot arrives its live status is unavailable; another
agency's cached snapshot is not live evidence. A failed refresh keeps and ages
the last successful snapshot.

Nearby and saved station cards show rail and subway services only; surface
departures appear in nearby route cards. Map station lookup merges all services.

### National rail

Intercity rail is in scope. A national operator appears as an interchange
endpoint and as a schematic the rider opens deliberately. VIA Rail uses the Core
`tsimobile` adapter: the module declares its endpoint, polling interval, and
generated `gtfsIndex`, and the seeder joins `stop_code` and `trip_short_name` to
GTFS stops, routes, directions, and headsigns, failing on ambiguous joins.
Vehicle and station consumers share one validated document per polling
interval. Fixes older than fifteen minutes are excluded, departures use only
future departure estimates, and boards state that only tracked trains appear.
No schedule time is shown as a live prediction. Unknown station accessibility
stays unknown.

VIA's schematic is a north-up geographic adaptation of its published network
map, so live fixes stay aligned with the existing projection.

## Considered options

- Full reorganisation into `src/core/`, `src/agencies/`, `src/app/`: churn
  without behaviour change; rejected.
- A shared UI package for generic-feeling components: not needed; rejected.
- Lint-only enforcement: lint config drifts silently, so it is paired with CI
  tests.
