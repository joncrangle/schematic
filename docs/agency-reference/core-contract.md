# Core contract

Part of the [agency guide](../add-an-agency.md). This page covers what Core
expects from an Agency Module and what it does in return.

## Tiers

The codebase has three tiers (ADR-0007):

| Tier               | Home                                                          | Knows about agencies?                        |
| ------------------ | ------------------------------------------------------------- | -------------------------------------------- |
| **Core**           | `src/domain/`, `src/infrastructure/`, most of `src/services/` | Never names one                              |
| **Agency Modules** | `src/agencies/<scope>/<region>/<id>/`                         | JSON configuration only                      |
| **App Shell**      | `src/routes/`, `src/components/`, `src/context/`              | Reads agencies through the registry barrels  |

Two contracts bind a module:

1. The **provider contract** (`src/agencies/types.ts`). Every data shape is an
   Effect Schema validated at registration, and static types derive from those
   schemas, so they can't drift from wire validation.
2. The **conformance kit** (the `provider conformance kit` suite in
   `tests/unit/provider-registration.test.ts`). It checks every registered
   provider in one catalog-wide assertion. There is no opt-in to forget.

Product rules every agency inherits (vocabulary in `GLOSSARY.md`):

- **Severity ladder.** `normal → degraded → severe`. Agencies classify upstream
  state onto the ladder; Core owns ranking and colours.
- **Honesty.** Failures throw end to end and surface as STALE freshness or error
  banners. An empty result is a real result, never a disguised error.
- **Zero-login privacy (ADR-0002).** Nothing about a rider leaves the device
  except anonymous push mirrors.

## Module rules

- Core (`src/domain`, `src/lib`, `src/services`, `src/infrastructure`) may not
  deep-import an agency module. `.oxlintrc.json` `no-restricted-imports` and
  `tests/unit/domain-boundary.test.ts` both enforce this.
- Module directories hold no TypeScript.
  `tests/unit/agency-module-shape.test.ts` fails on any file other than the
  manifest and schematic, and on a directory the catalog never registered. An
  `.oxlintrc.json` override on `src/agencies/*.ts` stops the registry and
  provider factory importing a module. Generated map subdirectories and
  agency-specific runtime code are a review convention with no guard.
- The registry uses explicit JSON imports, because Workers can't rely on
  filesystem discovery.
- `src/agencies/agencyCatalog.ts` is the only registration list.
  `registry.ts` builds validated server providers from it and
  `browserRegistry.ts` projects browser-readable metadata from it. The browser
  projection must stay free of the server provider factory and runtime
  adapters. The client build trims feed, alert, and topology configuration out
  of each manifest (`browserManifest.ts`) and fails if anything other than
  `browserRegistry.ts` imports the catalog, so browser code reads agencies
  through `browserRegistry.ts`, never `~/agencies`.
- `scope` and `jurisdiction` set the canonical path and seed location. See
  [scope and jurisdiction](manifest.md#scope-and-jurisdiction).

## Severity and alert shapes

- **Severity.** Classify every condition onto `normal / degraded / severe`
  (`~/domain/severity`). Prefer the upstream structured effect. Use a manifest
  `alertInterpretation.rules` entry when you need a source-specific field or
  truly unstructured prose. Core owns `SEVERITY_RANK` and colours, so never put
  hex values in a module.
- **Alerts.** Core ports advisories into `AgencyAlert`: `kind` (`delay`,
  `slow-service`, `suspension`, `accessibility`, `upcoming`, `information`),
  `lifecycle`, `scope`, optional `serviceChange`, structured attribution
  (`affectedLineIds`, `affectedRouteIds`, `targets`, `affectedStations`), and
  copy. Line status and alert filtering read the structured attribution.
- **Alert station identity.** An alert station reference carries an optional
  schematic `stationId` beside its display name. A known map station carries
  both. A mapless, feed-only, unknown, or ambiguous reference is name-only. The
  adapter resolves feed and platform IDs, and schematic names or aliases only
  when they're unambiguous. Map and station consumers use IDs when present and
  never infer identity from names.
- **`between X and Y` fallback.** For feeds with no structured station
  endpoints, Core reads `between X and Y` prose against exact names and aliases
  in the schematic. Structured references always win. Don't extend this with
  agency vocabulary.
- **Line status** is never stored. Core derives it with
  `deriveLineStatuses(alerts, declaredLineIds)` (`~/domain/interpretSnapshot`),
  so `affectedLineIds` must use schematic line ids.
- **Accessibility.** `normalizeWheelchairBoarding`
  (`~/domain/surface/accessibility`) maps GTFS `wheelchair_boarding` codes to
  booleans.

Reference: `src/domain/interpretSnapshot.ts`, `src/agencies/createAgencyProvider.ts`.

## Snapshot port

Core builds the `AgencySnapshot` (`{ agencyId, generatedAt, sourceUpdatedAt?,
freshness, alerts }`) from the manifest's `alerts` array. Don't write a provider
snapshot or parser. `createAgencyProvider` injects fetch, clock, secrets,
timezone, station index, and interpretation policy into the shared alert module.

- `generatedAt` is when Core received the feed and built the snapshot. It is the
  freshness clock.
- `sourceUpdatedAt` is the upstream header timestamp, kept for diagnostics.
- An unchanged payload stays fresh. A rejected poll is stale.

The module fetches every source, dispatches each to its adapter, deduplicates,
derives lifecycle and severity, and marks a partial result stale. "Partial"
includes a source read only in part: the `web` adapter fetches each page
separately, so one bad page loses that page's advisories and flags the feed
`partial`. If every source fails, the request fails. With no alert source, Core
returns an unavailable empty snapshot.

Mapless agencies use this snapshot as their whole product. Map-bearing bus
agencies derive line status for their drawn lines the same way rail agencies do.

Reference: `src/infrastructure/realtime/fetchAgencyAlerts.ts`.

## Conformance kit

`tests/unit/provider-registration.test.ts` runs these checks against every
registered provider, offline, with no per-agency wiring.
`tests/unit/agency-registry.test.ts` checks that the server and browser
projections keep the catalog's IDs and order.

| Check                    | Catches                                                                                                     |
| ------------------------ | ----------------------------------------------------------------------------------------------------------- |
| `contract-validation`    | Any schema-invalid manifest, feed, or schematic region (mirrors the boot-time refusal)                      |
| `unique-agency-id`       | Duplicate registrations                                                                                     |
| `schematic-compiles`     | A malformed schematic, stations on undeclared lines, renderer divergence (map-bearing agencies only)        |
| `snapshot-port`          | Missing `snapshot.get`                                                                                      |
| `stations-source-port`   | `stationService` declared but no `createStationsSource`                                                     |
| `severity-mapping-total` | Lines that can't derive a status from ladder-alert fixtures                                                 |

A green run means the agency is structurally integrated. Parsing correctness and
severity choices are still yours to test through public seams with fakes.

The kit checks coordinate shape and bounds. It can't prove a `cityPresets` point
sits at the named facility, or that `popularSurfaceRoutes` matches the seed.
Check both by hand and record the evidence in the PR, not the manifest.

## What registration switches on

- **Boot-time validation.** `validateProvider` decodes every contract region.
  A malformed provider stops dev, CI, and production startup.
- **Automatic agency resolution.** Regional coverage wins first, then the
  smallest covering box. A saved picker pin overrides Automatic. With no covered
  location, Automatic stays unresolved unless it can keep the previous session's
  winner, and the shell shows a network chooser. See `resolveEffectiveAgency`
  in `src/domain/location/EffectiveAgency.ts` and `createAgencySession` in
  `src/services/session/AgencySession.ts`. `EffectiveAgencySnapshot`
  (`coveringIds`, `stationCoveringIds`) is the only source of fan-out.
- **Storage.** The binding ladder tries wrangler, then vite-dev/Miniflare, then
  `DATA_DIR` for Bun/Node, then refuses loudly.
- **Alert evaluation and push.** On Workers, `ProductionScheduler` evaluates
  JSON and GTFS-RT sources every minute and web/RSS sources every fifteen
  minutes. Self-hosting evaluates everything every minute. Incomplete snapshots
  suppress pushes and recovery notices.
- **Topology refresh.** After a manual seed, seed-managed agencies get a weekly
  staggered refresh. See [weekly refresh](topology.md#weekly-refresh).
- **Surface queries.** Arrivals and vehicles keyed `agencyId:routeId:stopId`,
  with the last good result re-served on upstream failure.
- **Stations panel.** With `stationService` and a station index, the shared
  adapter serves nearby and saved stations.
- **Map rendering**, the **picker**, favourites, and attribution display.
