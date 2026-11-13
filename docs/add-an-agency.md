# Adding a transit agency

This is the workflow for adding an **Agency**. Read it top to bottom once, then
open the reference pages as each step needs them. It is also a spec. If adding
an agency forces you to write agency-specific runtime code in Core, Core has a
bug. File an issue instead of working around it.

> **The code invariant** (`GLOSSARY.md`, ADR-0007): _adding an Agency means
> adding exactly one Agency Module and exactly one entry to the shared data
> catalog._ A deployed surface agency also needs a manual initial seed into the
> shared `DB_TRANSIT` binding, and a regional interchange may need regenerated
> regional data. Those are deployment and relationship data, not module code.

## Reference pages

| Page                                                   | Covers                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------- |
| [Core contract](agency-reference/core-contract.md)     | Tiers, module rules, severity, the snapshot port, the conformance kit, what registration switches on |
| [Manifest](agency-reference/manifest.md)               | Fields, language and attribution, station service, bounds, route-to-line mapping, directions      |
| [Topology and seeding](agency-reference/topology.md)   | Station identity, static GTFS options, the seeder, weekly refresh, remote seeding                 |
| [Realtime feeds](agency-reference/realtime-feeds.md)   | Feed kinds, JSON departure boards, vendor adapters, feed quirks, `accept`, auth and secrets       |
| [Alert sources](agency-reference/alert-sources.md)     | Source types and parsers, interpretation rules, translations, daemon proxies, verification        |
| [Schematic](agency-reference/schematic.md)             | Choosing what to draw, cartography rules, accessibility, circuits and reversals, reseeding        |
| [Regional interchanges](agency-reference/interchanges.md) | Discovery, overrides, walking connections, badge placement, the regeneration workflow          |

## Admission criteria

Apply these directly when a request names one agency or a wave of agencies. A
new wave does not need a fresh decision session. Go back to the user only when a
candidate fails a hard requirement or when evidence contradicts one of these
rules.

**Rider expectation sets scope.** Show what a rider of that agency expects to
see. The operator's rider-facing tools are the reference: its system map, its
real-time app or departure board, and its advisories page. Name the tools you
used in the implementation issue.

- Show departures for every route the operator's real-time tool presents with
  live predictions, including on-demand and dynamic-dispatch routes. Omit
  services its tools don't present as departures, such as booking-only zones
  and specialized transit.
- Collapse duplicate upstream vehicle fixes when a rider sees one bus.
- Keep alert scope as published. A stop-level `NO_SERVICE` stays at its stops
  and never becomes a whole-route suspension.

**Hard requirements.** Defer an agency, with dated evidence, only when one fails.

- Fresh live departures arrive from a source Schematic can reach. Vehicle
  positions are optional, so an empty or missing position feed doesn't block
  admission when departure predictions are live. Static-only registration is
  never admitted. A static GTFS feed that downloads cleanly proves the
  transport works, not that the agency has live coverage. Defer it and record
  the missing live source.
- The operator does not explicitly refuse reuse.

Timetable-only coverage would need a separate `scheduled` capability with its
own schedule store and refresh pipeline. It is not an exception to the live
gate, and no agency is admitted that way today.

**Not admission blockers.**

- **Licence.** An unconfirmed licence never excludes an agency. Attribute on a
  best-effort basis; see [data attribution](../CODING_STANDARDS.md#data-attribution-and-credentials).
- **Credentials.** Keyed sources work through declared feed auth and deployment
  secrets.
- **Transport.** Accept an officially published HTTP-only endpoint, fetched
  server-side. Never disable TLS validation. When an upstream blocks Cloudflare
  egress, add its parser to the alert-feed daemon and proxy it (see
  [proxy-backed alert sources](agency-reference/alert-sources.md#proxy-backed-alert-sources)).
- **Alerts.** Never show a false all-clear. When the operator publishes
  advisories on a channel Core can't decode, including a rider-facing web page,
  that agency's implementation issue builds the generic Core adapter. Reconcile
  the machine feed against the advisories page. When the page has current
  advisories the feed lacks, decode the page too.
- **Missing Core adapters.** A generic transport or alert adapter gap belongs in
  the implementation issue of the agency that needs it, proven against that
  agency's live source. Don't file it as a follow-up.

**Launch shape.**

- Register as `experimental`.
- Ship a small schematic of the primary network drawn from the operator's
  system map (see [Schematic](agency-reference/schematic.md)). ADR-0007 keeps
  the schematic optional in the module contract. Admission requires one.
- Follow the [bounds rules](agency-reference/manifest.md#service-area-bounds).
  Pass the stop-coverage audit and confirm no existing agency loses Automatic
  selection at its own hubs.
- Declare every [regional interchange](agency-reference/interchanges.md) with an
  already registered agency in the same change, whether it's a shared physical
  station or an operator-documented walking connection. Don't file interchange
  follow-ups. Ignore partners that aren't registered and add no placeholder
  endpoints.

**Implementation issue contents.** Each agency gets one issue created from the
[Add an agency template](../.github/ISSUE_TEMPLATE/add-agency.md)
(`gh issue create --template "Add an agency"`). It records only what a fresh
session needs to implement:

1. Verified source URLs with check times and observed evidence.
2. Attribution, or the best-effort attribution and why no explicit terms apply.
3. Alert channels, and any Core adapter the issue owns.
4. The operator's rider-facing tools used as the scope reference.
5. The bounds plan.
6. Interchanges with registered agencies.
7. The schematic reference, with its URL and edition.
8. `experimental` status.

**Done when** live departures and any published vehicle positions work on
Cloudflare and self-hosted runtimes (through the daemon when Cloudflare is
blocked), alerts can't show a false all-clear, the stop-coverage audit passes
with existing hubs unchanged, and the interchanges and schematic are in place.

**Wave workflow.** Verify each candidate's live sources in a dated tracking
issue, then create implementation issues for every candidate that meets the
hard requirements. Report deferred candidates with their evidence.

Give the real deferral reason. An agency whose static feed works and whose
real-time endpoint returns nothing useful is a live-service deferral ("no live
vehicles or departures"). It is not a transport failure or a source-access
problem.

## Workflow

### 1. Gather sources

Before writing code, collect:

1. The `agency_id` used by the realtime feeds, and the NextBus slug if one exists.
2. GTFS-RT vehicle and trip URLs, plus every alert channel: GTFS-RT, JSON,
   RSS/Atom, or the advisories web page. Note each auth style (`none`,
   `query_param`, `header`, or `custom`).
3. Service-area bounding boxes.
4. Modes: `subway`, `rail`, `streetcar`, `bus`, or `express`.
5. Attribution: source name, URL, and licence.
6. The operator's system map, with its URL and edition.
7. Authoritative coordinates for common operator locations (`cityPresets`), from
   the current `stops.txt` or a facility source, with the check date.

Then confirm the feeds are actually live. Inspect `active_period` on alert
entities as well as their count. A non-empty feed can hold only expired alerts,
and the snapshot then looks fresh while Core derives nothing. Before concluding
an operator has no live alert channel, read its rider-facing advisories page.
See the [live-service standards](../CODING_STANDARDS.md#agencies-and-live-service).

Local development needs no Cloudflare account. `vite dev` uses a Miniflare
`DB_TRANSIT` binding, and self-hosted Bun/Node uses `DATA_DIR/transit.db`.

### 2. Scaffold the module

```
src/agencies/<scope>/<region>/<id>/
├── manifest.json     # identity, bounds, feeds, alerts, interpretation rules
└── schematic.json    # the drawn network (omit for mapless agencies)
```

Nothing else goes in the directory, and no TypeScript. Tests and lint enforce
this; see [module rules](agency-reference/core-contract.md#module-rules). A new
`region` also needs its name in `src/i18n/en.ts`, `src/i18n/fr.ts`, and
`src/i18n/jurisdictions.ts`.

### 3. Write the manifest

Start from the [manifest reference](agency-reference/manifest.md). Every agency
must declare live realtime feeds and `stationService`. Decide `scope`,
`jurisdiction`, and `bounds` first, because they set the directory path and
Automatic selection.

### 4. Seed static topology

Set `staticTopology.source` to `"seed"`, then run:

```sh
bun scripts/seed.ts --agency=<id> --db=sqlite
```

Check `routes.txt` before choosing `routeIdField`, and audit stop coverage
against your bounds once the seed lands. See
[topology and seeding](agency-reference/topology.md).

### 5. Wire realtime feeds

Declare vehicle and trip feeds in `realtime.feeds`. Core owns decoding. Check
[realtime feeds](agency-reference/realtime-feeds.md) for the opt-in quirk
settings (duplicate fixes, cancelled trips, static directions) and only declare
one after a live capture shows the problem.

### 6. Wire alert sources

Declare every alert channel in `alerts`. Run each source through its registered
decoder using a live capture, then verify the assembled snapshot and rendered
alert status on both runtimes. A complete successful read must report `live`,
including an empty board verified against the operator's rider-facing tool.
Confirm the operator enables and polls that board, and reconcile it with the
advisories page before accepting its empty state. Reserve `stale` for failed or
incomplete reads; an agency with no supported advisory channel reports
`unavailable`. Check these states in the app, not just the upstream HTTP status
or decoded alert count, and record the observed freshness in the PR.
See [alert sources](agency-reference/alert-sources.md#verify-a-source-before-you-wire-it).

### 7. Draw the schematic

Draw 5 to 8 lines of the primary network from the operator's map. Follow the
[schematic reference](agency-reference/schematic.md) and inspect the rendered
map at desktop and mobile sizes.

Place station labels close to their own nodes. For a node at `(100, 100)`, start
with one of these horizontal-text placements:

| Position | `label.x` | `label.y` | `label.anchor` |
| -------- | --------- | --------- | -------------- |
| Right    | 125       | 100       | `"start"`      |
| Left     | 75        | 100       | `"end"`        |
| Above    | 100       | 70        | `"middle"`     |
| Below    | 100       | 130       | `"middle"`     |

Aim for 10 to 20 schematic units between the nearest text edge and the marker's
visible edge. Allow for the enlarged pill at interchanges; a tall pill needs more
vertical clearance. Measure SVG map units, not pixels at the current zoom. For
rotated or centred text, check the actual text edges rather than just its anchor.
Keep text clear of routes, badges, and other labels. If it collides, try another
side or anchor, then adjust the local layout. Use a short leader when a crowded caption needs a diagonal offset. Its station
end must meet the marker's visible outer edge, including a pill's rounded corner;
it must not run into the centre. Keep any necessary leader short;
do not push a caption away from its station to clear an obstacle.

Place route badges beside a clear, unshared stretch of their own line. Start
their centres 30 to 35 schematic units perpendicular to the line, leaving about
8 to 12 units between the enlarged circle and the widest line stroke. For a
horizontal line at `y: 100`, try a badge at `y: 130`. Slide a colliding badge
along its line or try the other side; do not move it far away from the route.
Check its 1.25 hover/focus size against nearby captions, nodes, and badges.

Verify the actual browser render at readable zoom. Pan through every branch and
endpoint; an overview or central screenshot does not cover the whole map. Check
full and compact interchange badges, then reload and recheck any region you edit.

### 8. Declare interchanges

Reseed, run `bun run seed:interchanges`, add exclusions and overrides, and
regenerate until a second run changes nothing. See
[regional interchanges](agency-reference/interchanges.md#regeneration-workflow).

### 9. Register and check

Add the JSON imports and one entry to `src/agencies/agencyCatalog.ts`:

```ts
import manifest from "./ca/on/sample-transit/manifest.json";
import schematic from "./ca/on/sample-transit/schematic.json";

export const agencyCatalog = [
  { manifest, schematic }, // mapless agencies: { manifest }
];
```

`registry.ts` and `browserRegistry.ts` project that catalog. Never edit them to
register an agency. An agency missing from the catalog fails silently: no test
checks catalog-to-filesystem parity, so the module just doesn't appear. Only a
targeted `agency:check` catches it.

The alphabetical option check in `tests/unit/spoof-drawer.dom.test.tsx` uses
fictional agency fixtures. Keep that suite independent of production agency
membership; verify the real registration with `agency:check`.

Then run:

```sh
bun run agency:check -- <id>
bun run typecheck
bun run lint
bun format
bun run test
```

`agency:check` is network-free. It validates the contract, compiles the
schematic, checks required ports and both catalog projections, and exits
non-zero with `agency is not registered` for an unknown id. A new agency can
break assertions elsewhere, so the full unit suite is part of this step.
`lint` and `format` cover `src` only, so match the style of `tests/` and
`scripts/` by hand.

## Checklist

Trace the agency (or review someone else's) through each line. A gap found
here becomes an issue, not a caveat.

- [ ] **Scaffold.** The module directory holds only `manifest.json` and an
      optional `schematic.json`.
- [ ] **Manifest.** Unique `id`. Bounds cover every seeded stop without
      covering neighbours' residential stops, and no existing agency loses its
      own hubs. Modes, attribution, and `status: "experimental"` are right.
      `stationService` and live realtime feeds are declared. `cityPresets`
      points are verified against current stop data with the date and source
      in the PR. `popularSurfaceRoutes`, when the agency has a surface catalog,
      lists canonical IDs present in the seed. Every drawn line covering several
      feed routes has a `routeLineMap` entry, with `lineIds` declared.
- [ ] **Topology.** The seed populates `data/transit.db` and the agency's route
      and stop rows exist. `--db=remote` runs only when you mean to seed
      production.
- [ ] **Feeds.** Every URL, auth, and format validates. Protobuf decodes through
      the Core decoder. Operator quirks live in manifest settings, not code.
- [ ] **Alerts.** Each `web`/`rss` source was decoded from a live capture before
      it was declared and returned current alerts, or a recognized empty-state
      marker covered by a fixture. Rendered cards keep published scope and
      periods. Interpretation lives in manifest rules.
- [ ] **Severity.** Every alert sits on the ladder, suspension-class events are
      `severe`, structured attribution is populated, and the module has no hex
      colours.
- [ ] **Schematic.** It compiles, every station sits on its drawn lines,
      sequences follow service order, and the official reference and edition
      are recorded. Orientation, colours, and trunk shape match that reference.
      Labels stay close to their own nodes and clear the enlarged markers.
      Labels and badges were inspected at mobile and desktop sizes. Circuits are
      drawn closed with no `terminal` flag and no `cornerInsertions`; only true
      reversals carry `cornerInsertions`.
- [ ] **Snapshot.** Healthy complete reads, including verified empty boards,
      produce `live` in the snapshot and rendered alert status on both runtimes.
      A forced upstream failure produces `stale` or an error, never an empty
      list posing as live. Agencies with no supported advisory channel show
      `unavailable`.
- [ ] **Registry.** One catalog entry, both registry projections contain the agency,
      and Automatic selection follows regional preference and bounds ranking.
- [ ] **Interchanges.** Every registered partner is declared, and a second
      `seed:interchanges` run changes nothing.
- [ ] **Tests.** `agency:check` and the full suite pass. New shared parser or
      classification behaviour is tested with fictional fixtures, following
      [testing standards](../CODING_STANDARDS.md#agency-independent-coverage).
      Agency additions add no agency-specific tests.

## Out of scope

- **Agency-local interchange declarations.** Cross-agency transfers belong in
  regional override files and compiled data (ADR-0008), not in a module.
- **Agency switching UX.** The picker's roadmap is separate.
- **Core changes.** If a step made you edit Core for this agency alone, stop and
  file an issue naming the step. That is the drift this guide exists to catch.
