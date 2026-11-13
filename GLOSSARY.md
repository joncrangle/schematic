# Schematic domain glossary

This document is the ubiquitous language and domain glossary for the Schematic project.

---

## Core domain concepts

### Transit modes

- **Rapid Transit & Rail**: Heavy rail, subway, light rail, and regional rail lines operated by transit agencies (e.g., TTC Lines 1, 2, 4, 5, 6; GO Transit rail corridors), plus intercity and corridor rail where an operator runs it (e.g., VIA Rail). A non-local operator participates in shared station boards. Regional operators take precedence in Automatic selection where their coverage overlaps.
- **Surface Transit**: Surface bus and streetcar/tram routes operated by transit agencies, classified into `streetcar`, `bus`, `rail`, and `express`.

### Shared alert vocabulary

Agency-agnostic product invariants owned by Core (`src/domain/severity.ts`, `src/agencies/types.ts`); every Agency maps its own classification onto them.

- **Severity ladder**: `normal` → `degraded` → `severe` (`SeveritySchema`). Agencies classify; Core owns ranking (`SEVERITY_RANK`) and canonical colors: green `#22c55e` (normal), amber `#f59e0b` (degraded), red `#ef4444` (severe).
- **AgencyAlert**: The Core-owned alert shape providers port upstream state into. It carries kind, severity, lifecycle, and structured attribution (`affectedLineIds`, `affectedRouteIds`, `affectedStations`, `fromStation`, `toStation`). Alert station references carry a schematic station ID plus canonical display text when mapped, or display text alone for mapless/feed-only references.
- **Alert interpretation rule**: A manifest-declared, source-independent predicate over structured feed effects, decoder-provided source fields, or operator text that maps an upstream alert to the shared `AlertKind`, `Severity`, and optional service-change vocabulary. Core evaluates the generic rule shape; no agency-specific parser or global operator dictionary is required.
- **Alert scope**: The operational breadth of an interpreted alert (`network`, `line`, `route`, `segment`, `station`, or `trip`, where every selector names trips only), kept separate from severity so a severe station or segment issue does not imply a network-wide shutdown.
- **Silent recovery**: A previously delivered severe incident disappears from a complete live snapshot while the subscriber's commute window is closed. Its ledger row becomes `cleared_silent` without a push, allowing a later recurrence to notify. `deliveredAt` retains the last accepted push time. Stale or unavailable snapshots cannot establish recovery.
- **AgencySnapshot**: The alert-centric, point-in-time service state a provider ports to Core: `{ agencyId, generatedAt, freshness, alerts }`. Core never stores line-level status; schematic-bearing agencies derive it from alert attribution via `deriveLineStatuses`. Mapless agencies emit alerts only.

### Status and visual semantics

- **Snapshot**: The aggregated, point-in-time health state of all lines derived from GTFS-RT alerts, agency slow zones (RSZ), and station accessibility advisories.
- **Normal service**: Green (`#22c55e`). All trips operating on schedule without severe delay.
- **Reduced speed zone (RSZ)**: Dashed amber (`#f59e0b`). A track speed restriction is active on a specific segment; vehicles run at reduced speed without halo or pulsing animation, slightly narrower than delay warnings so the two never read the same.
- **General delay**: Pulsing Amber (`#f59e0b`). An active operational delay along a line segment.
- **Service suspension**: Solid Red (`#ef4444`) with pulsing aura. Service is suspended or stations are bypassed.
- **Accessibility outage**: Informational badge for elevator/escalator outages at specific stations; it does not degrade line-level track status.
- **Failure semantics**: Failures throw end to end and surface honestly as STALE freshness or connection-error banners; empty results are legitimate results, never disguised errors.

---

## Surface transit and disruption concepts

### SurfaceAlert

A realtime service advisory parsed from GTFS-RT matching a specific surface route.

- **Severe disruption**: Route suspension, line cancellation, or major detour bypassing significant route segments. Red badge and casing (`#ef4444`).
- **Degraded disruption**: Traffic congestion delay, minor short turn, or temporary stop relocation. Amber badge and casing (`#f59e0b`).
- **Directional scope**: Whether an alert applies to `[Eastbound]`, `[Westbound]`, `[Northbound]`, `[Southbound]`, or `[Both Directions]`.

### RouteAlertBanner

The interactive, collapsible UI component rendering active surface transit advisories:

- In **Nearby transit** cards: a compact warning badge on collapsed cards, and a prominent accordion banner above arrival countdowns when expanded.
- In **Targeted route mode**: mounted directly beneath the top `RouteControls` bar as a collapsible notification pill (`[⚠️ Detour Advisory +N more ▾]`).

### Targeted route mode

Full-screen interactive corridor view of an individual surface route:

- **Auto-framing**: Smooth 400ms cubic-bezier map zoom and pan framing the route polyline with 15% edge padding.
- **Ghosted network**: Network lines dimmed to 20% opacity.
- **Connecting interchange**: Interchange stations directly connected to the surface route highlighted with transfer badge pills.
- **Vehicle snapping**: Live vehicle GPS fixes projected to the nearest polyline centerline segment.

---

## Spatial geometry and realtime engine concepts

### MapGeometry

The shared math governing coordinate transforms across all map layers:

- **WGS84 projection**: Linear scale from GPS coordinates (`lat, lon`) to SVG canvas space (`x, y` in 2846x2140 design coordinates).
- **Viewport matrix**: Transform (`zoom`, `pan`) fitting canvas coordinates into dynamic container dimensions with edge padding.
- **Polyline snapping**: Vector projection finding the closest point and bearing on a polyline segment within a 60px snap threshold.
- **Popover clamping**: Bounding box arithmetic keeping popovers fully visible within screen margins and aligning arrow offsets to anchor points.

### Location source ladder

The single tiered precedence engine resolving the device position fix: dev-spoof, then GPS, then coarse-IP seed, then default, with underground grace and stale-hold timers inside the selection. One deep module owns tier registration, persistence of the dev spoof, and precedence rules (`effectiveFix(): {fix, source}`); UI consumes the resolved fix through thin Solid bindings and never reads individual tiers directly. EffectiveAgency consumes this for agency resolution, and re-exports its constants (`UNDERGROUND_TOLERANCE_MS`, `STORAGE_KEY_COORDS`, `STORAGE_KEY_GRANTED`, `isUndergroundCacheValid`) as the canonical adapter import.

### EffectiveAgency

The single deep module owning **Location ladder to agency selection to coveringIds**. It is the domain resolver (`src/domain/location/EffectiveAgency.ts`). Earlier logic lived in several places (`locationLadder.ts`, `agencyCoverage.ts`, `registry.ts`, `routes/index.tsx`, and assorted query and picker adapters). No caller recomputes coveringIds now.

- **Hybrid pure plus session**: pure `resolveEffectiveAgency(input): EffectiveAgencySnapshot` for tests and adapters; stateful `createAgencySession(deps): AgencySession` in `src/services/session/AgencySession.ts` owning the previous Automatic winner, subscriptions, and the ephemeral interchange stack (`temporaryAgencyId`, `temporaryOrigin`). It feeds `AgencySessionContext` so shells never thread `prev` separately and read `displayedAgency`, `baseAgency`, and `snapshot` from one place. No singleton. Each shell creates its own session (routes/index.tsx).
- **EffectiveAgencySnapshot**: `{ fix, source, status, automaticAgencyId, agencyId, declaredCoveringIds, coveringIds, stationCoveringIds }`. It echoes the ladder fix, source, and status, then adds the automatic winner, declared-bound coverage, resolved agency, and fan-out sets in one return.
- **Tier precedence and effectivePoint filter**: tier precedence lives in `locationLadder.selectPosition()` (dev-spoof, then GPS, then coarse-IP, then default); EffectiveAgency consumes `effectiveFix()` and owns only the `effectivePoint` filter. Without a fix, or with a default source, the point is undefined. Otherwise it is `{lat, lon}`. The store derives this from ladder state, pure callers pass `point` directly.
- **rankAgenciesForPoint internal seam**: smallest-bbox-wins ordering delegated internally via `toCoverageInputs()`; callers never import `agencyCoverage`.
- **Unresolved Automatic**: Automatic has no network when there is no usable location or declared coverage and no session winner eligible for retention. The rider sees a searchable network chooser with optional location access; no arbitrary agency schematic or live status appears.
- **Manual selection**: a network the rider chooses explicitly, saved with their preferences and restored across visits even without location. It is independent of Automatic's current winner.
- **Honest fan-out**: query coverage contains declared-bound matches only. A manual choice or retained display never adds coverage; no usable point means no fan-out.
- **Expired-hold**: `status === "expired"` without a dev-spoof source, or without a point, holds the previous Automatic winner within the session. A manual pin never supplies that winner. Dev-spoof always moves.
- **Honest coverage check**: `isPointCovered(point): boolean` answers declared-bounds containment without fallback, so picker and spoof badges stay honest outside every bound.
- **Manifest seam ownership**: `EffectiveAgency` owns `manifestFocus` and `manifestFallbackBounds`. Fallback bounds are the union of `manifest.bounds` entries (a private `unionOfBounds`, never a hardcoded Toronto viewport), so focus and fallback math lives with agency selection. `src/domain/location/EffectiveAgency.ts` is canonical.
- **Timer ownership**: expiry scheduling lives in `locationLadder` (`granted` or `stale` becomes `expired` after 180s underground grace). The browser adapter injects the scheduler. It runs only while the ladder has subscribers, and `dispose()` clears it; SSR and deterministic tests omit it. `AgencySession` owns no timer and only adapts ladder notifications.
- **Location request ordering**: the latest GPS request owns its callbacks. Clearing location or marking permission denied invalidates pending GPS requests. An initial browser permission snapshot cannot override a later request or reset. Ignored callbacks cannot restore coordinates, change status, or write persisted location.

### Protobuf bulk ingestion

Zero-dependency binary protobuf decoder ingesting GTFS-RT vehicle positions and trip updates over HTTP with ETag conditional caching.

---

## Multi-agency concepts

### Agency

An operating transit authority whose service appears in the app as a distinct, self-contained unit of data and identity (e.g., TTC, GO Transit, UP Express, Kingston Transit). Each Agency owns its own topology; nothing in one Agency's data may be assumed about another's.

### AgencyId

Plain `string` (`src/lib/location-source.ts: export type AgencyId = string`). Agency identity is data validated at the registry seam (`AgencyManifestSchema.id: Schema.String`), never a `"ttc" | "go"` union in core (ADR-0007). `getAgencyById(id: string)`, `getAgenciesForPoint(lat, lon)`, and `makeLiveNearbyTransitLayer(agencyId: string)` all take plain string.

### Temporary agency view

An ephemeral App Shell state created when a rider inspects another Agency from
an Interchange Badge. It names the Agency currently displayed by the shell without
changing the persistent Agency preference, whether that preference is Automatic or a
pinned Agency. The view survives location updates, is replaced by another interchange
navigation, when interchange navigation returns to the Agency from which the temporary
view began, or when the rider explicitly selects Automatic or an Agency in the picker,
or reloads the app. While temporary, the header Agency control names the displayed
Agency and acts as a one-click restore action for the saved picker setting; the picker
trigger returns after the temporary view is cleared.

### Manifest

`src/agencies/<scope>/<region>/<id>/manifest.json` — the per-agency operational source of truth. Core derives `focus`/`fallbackBounds` via `manifestFocus(manifest)` / `manifestFallbackBounds(manifest)` in `src/domain/location/EffectiveAgency.ts` and `cityPresets` via `manifest.cityPresets` / `directionLiterals` via `manifest.directionLiterals`; no hardcoded Toronto `CITY_PRESETS`/`focus`/`43.6`/`-79.5` literals remain in core. `fallbackBounds` is the union of `manifest.bounds` entries, threaded wherever live NextBus `latMin`/`latMax` are absent.

### Fallback bounds

The operational viewport bounding box derived as the union of an agency's declared `manifest.bounds` entries, threaded wherever live NextBus geometry is absent.
_Avoid_: Toronto viewport, hardcoded bounds

### Schematic

An agency-declared, hand-positioned drawing of its rapid-transit network: canvas size, line polylines with colors, station anchors with accessibility and terminal flags and label placements, badge circles, viewport framing (bounds and zoom limits), and geo-reference anchors for the coordinate projection. Declared in the provider contract (`Schematic` in `src/agencies/types.ts`); an agency without one gets a fallback card instead of a map.

### Schematic station ID

The stable, agency-local identity of a station drawn on a Schematic. It is an explicit lowercase kebab-case `id` such as `union` or `bloor-yonge`, and is independent of the display name, translations, abbreviations, and upstream feed IDs. Sequences, corner insertions, map selection, focus, and actionable interchange navigation use this ID. Across agencies, identity is always the structured pair `{ agencyId, stationId }`; bare IDs are never global.

The rider's locale controls app labels and selects available operator-language
content. Operator station names, direction termini, headsigns, and alert text
remain verbatim. A display name from another language does not change station
identity or create another station.

### UI locale

The rider's chosen language for app labels and available operator-language
content. It is independent of the rider's regional display conventions.

### Format locale

The app-label language combined with the rider's region for dates, times,
numbers, relative times, lists, plurals, and default units. The region comes
from the location-resolved country, then the displayed agency's country, browser
language hints, and finally Canada.

### Display preferences

The rider's date order, time format, and unit system choices. Each follows
regional conventions until the rider chooses an explicit override.

### Feed station ID

The upstream-owned station identity retained in `stationIndex.id` and platform IDs. A feed ID may change independently of the Schematic. The station-index ingestion adapter may normalize feed names to attach a feed entry to a Schematic Station ID and emits that link as `schematicId`; Core does not infer it from display names. Feed-owned `departureRouteIds` describe all boarding routes independently of the drawing's `lines`.

### Agency station reference

An alert-bound station value with `{ stationId?: SchematicStationId, stationName: string }`. `stationId` is the agency-local repository identity and is present only when the alert adapter can resolve a feed/platform ID or an unambiguous schematic name or alias. `stationName` is canonical presentation text. Core Map and station consumers use the ID when present and never reconstruct map identity from display names; name-only references remain explicit and conservative.

### SchematicTopology

The renderer-ready view model derived from a Schematic by `buildSchematicTopology`: station, line, and badge lists with computed interchange flags, aria labels, and smooth path strings, plus the bound MapGeometry engine and initial camera. Pure derivation with no agency knowledge, so any Schematic yields a working map.

### Interchange hub

A reviewed multi-agency connection between stations or stops, normally at the same physical station. An explicitly identified walking connection may also link neighbouring facilities when an operator or transport authority documents the transfer.
_Avoid_: Multi-station junction, transfer point

### Interchange endpoint

An agency-specific station or stop participating in an Interchange Hub, referencing the local agency ID and optional canonical Schematic Station ID. `stationName` remains display text for mapless/feed-only endpoints. An endpoint may provide a target-specific badge label when the provider's default short name is not the desired display text.
_Avoid_: Transfer stop, connection node

### Interchange badge

An optional interactive map marker identifying a connecting peer Agency at an Interchange Hub. Its presentation defaults to compact on mobile and full on desktop, with full, compact, or hidden user preferences; selecting it switches the active Agency view to the matching station node.
_Avoid_: agency chip, connection dot

### Core

The agency-agnostic transit machinery of the codebase: everything that could serve any Agency unchanged (generic feed decoding, snapshot serving through `SnapshotClient` SWR, `SurfaceDataStore` D1/Bun/memory adapters, geolocation and tiered-location state machine, preferences domain, schematic rendering through `buildSchematicTopology` plus `MapGeometry`). Core never names an Agency or deep-imports provider data. The registry and factory are its only agency-facing seam (enforced by `.oxlintrc.json` plus `tests/unit/domain-boundary.test.ts`).

### NearbyTransit

The single deep module owning surface proximity for one agency: selection, fetch, fuse, then stale (`src/services/surface/NearbyTransit.ts`). It exposes `getNearbyTransit(req)`, `getSavedTransit(req)`, and `getRouteTracking(req)` with `agencyId` as request data. Each request builds its own live layer via `manifestFocus` and `manifestFallbackBounds`, and never reads a global active agency mid-flight. Internal seams only: `TopologySource`, `RealtimeSource`, and `SurfaceStoreWriter` adapters, with private `fuse` and `stale`. Arrival assembly keeps one direction-label delegation, one staleness fold (`feedDegraded`, `predictionsStale`, or `snapshotFailed`), and the only server call site for approaching-vehicle ETAs. Covering fan-out (`coveringIds` and `stationCoveringIds`) comes solely from EffectiveAgency. NearbyTransit and its `useNearbyQueries` adapter never recompute bbox mapping. The shell passes precomputed overrides from the EffectiveAgency snapshot.

### Agency module

A data-only provider declaration: an explicitly cataloged `manifest.json` plus optional `schematic.json` under its scope hierarchy. Generic core providers own feed decoding, topology, snapshots, and station ports; adding an Agency means adding its declaration and one `agencyCatalog.ts` entry, with no separate server/browser registration lists or agency-specific TypeScript runtime.

### AgencySession

The app shell's single deep session owner (`src/services/session/AgencySession.ts` with thin `src/context/AgencySessionContext.tsx`). It holds the `LocationLadder` subscription, preference-driven selection, coverage ranking, unresolved Automatic, and ephemeral interchange navigation stack. `displayedAgency` derives reactively (temporary if active, else `baseAgency`); `navigateToInterchange(focus)` records the origin and sets the temporary view, clearing it when navigating back to the origin; `selectAgency(selection)` and `clearTemporaryView()` clear the ephemeral view. Shell and all consumers use `useAgencySession()` as the single source of truth.

### App shell

The product composition layer wiring Core machinery to one or more Agency Modules for this application: routing, navigation chrome, service worker, and notification product wiring. The shell creates `createAgencySession` once and provides it via `AgencySessionProvider`.

---

## Product and UX invariants

1. **Scannability and glanceability**:
   - The primary map communicates the existence, severity, and approximate affected portion of a disruption within seconds before reading textual detail.
   - Status color hierarchy is strictly preserved: Green (Normal Service), dashed Amber `#f59e0b` (Reduced Speed Zones), thick solid pulsing Amber (Delays), and Red `#ef4444` with pulsing aura (Severe Disruptions / Suspensions / Station Bypasses).
   - Station accessibility indicators (wheelchair strike-through `#f87171`) and popover equipment outage cards reflect elevator/escalator issues without altering ordinary track severity.

2. **Clean network-dominant status display**:
   - Once a network is selected or resolved, the default screen is the interactive schematic network map. Unresolved Automatic presents the network chooser.
   - Surface transit routes or live vehicles never appear on the default map unless the rider explicitly selects them in Targeted route mode.
   - No generic transit-app clutter: no trip planning, directions, fare calculation, ads, or social feeds.

3. **Zero-login and privacy-first architecture**:
   - No user accounts, passwords, or backend user profiles.
   - User preferences and watchlist favorites reside exclusively on-device in versioned LocalStorage, with one exception: an anonymous, endpoint-keyed copy of favorites and commute schedules is mirrored server-side solely to evaluate push notifications (never geolocation; never tied to any identity).
   - Geolocation coordinates are processed purely in-memory for client-side proximity distance calculations and are **never logged**, written to persistent databases, or sent to third-party analytics.
   - Web Push notifications use anonymous VAPID subscription keys.
