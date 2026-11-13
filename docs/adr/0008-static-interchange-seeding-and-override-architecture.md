# Static Interchange Seeding and Override Architecture

We declare inter-agency transfer hubs through offline static seeding and explicit override files rather than dynamic runtime proximity discovery or hardcoding in Core. A seeding pipeline (`scripts/seed.ts`) discovers candidate transfer points across registered agencies via geographic proximity (<= 350m), regardless of the station names used by each agency, including bus endpoints when they use the same physical station, then resolves drawable endpoints to the structured `(agencyId, stationId)` identity and merges them with committed `interchanges.overrides.json` files to produce compile-time JSONC datasets, one per region (for example `src/agencies/ca/on/interchanges.jsonc`). This ensures zero runtime geo-computation in Core, preserves deterministic builds, and allows fine-tuned visual badge offsets, target-specific badge labels, out-of-system station aliases, and exclusions without risking data loss on automated regeneration.

## Status

Accepted

## Decision

### Regional artifacts

Each artifact region has one generated `interchanges.jsonc`. The region is the parent of an
agency's storage path, including national and international paths such as
`ca/nat` and `intl`. It is an ownership group, not a limit on which agencies
can connect.

Discovery and badge placement see all available seeded agencies together.
Compiling isolated regional agency lists would lose cross-border connections
and national operators' links to local networks. After compilation, each hub
belongs only to the artifact region of its first endpoint. Discovered endpoint
order is deterministic by agency ID; reviewed overrides can declare endpoint
order. Catalog order never chooses ownership.

A targeted seed updates its own artifact regions and regions whose previous or
new hubs contain the selected agencies. Missing required agency data preserves
the affected region's artifact without blocking unrelated regions. Overrides
are read from each region independently, with empty overrides when absent.
Regions without hubs need no artifact.

The runtime imports every artifact through the explicit
[interchange catalog](../../src/agencies/interchangeCatalog.ts), validates the
combined in-memory dataset, and performs no filesystem discovery. A contributor
registers a new artifact there after seeding. There is no merged generated file.

### Documented walking connections

The colocation rule is the default for automatic candidates. A reviewed regional
override may also represent a walking transfer between neighbouring facilities
when an operator or transport authority documents the connection. This keeps
prominent intercity connections visible without treating every nearby bus stop
as a transfer or inventing a shared station.

Retain both facilities' canonical station IDs and boarding stops. Record the
source, current serving routes, and pedestrian approach; feed-point proximity
alone is insufficient. A prominent peer station may be drawn as a separate node
with a dashed link labelled `walk`. The target endpoint's `walkingMarkers`
placements are keyed by the displaying agency. The node opens the peer's normal
station card under its actual agency and station identity; the separate agency
badge switches maps. These nodes remain visible
independently of agency badge preferences. They do not become stations, route
members, or boarding stops in the active agency's network.

Agency badges retain short provider names. The dashed link identifies the walk;
compact mode retains badge text, so longer walking labels undermine its size.
Both presentations use static regional overrides and shared rendering; neither
requires runtime proximity discovery or agency-specific code.

## Considered Options

- **Runtime Proximity Discovery**: Compute inter-agency transfer pairs dynamically at runtime in Core based on station coordinates and string distance. Rejected because runtime heuristics are brittle, introduce CPU overhead on app initialization, and risk diverging across platforms.
- **Agency Schematic Embedded Metadata**: Place outbound transfer links directly inside each agency's `schematic.json`. Rejected because bilateral relationships become duplicated and fragmented across separate agency files, making multi-peer hubs (like Union Station) difficult to keep synchronized.
- **Static Discovery with Compile-time Overrides (Chosen)**: Automated discovery in the GTFS seeding pipeline combined with a separate overrides file that compiles into a static regional dataset validated by Effect Schema.

## Consequences

- The app shell imports the static regional JSONC artifacts, validated at startup, keeping Core decoupled from agency specifics. It does not import or merge overrides files at runtime; edits take effect after `bun run seed:interchanges` regenerates the artifact.
- New agencies discover connections against all available seeded agency partitions.
  Compilation preserves the previous artifact when a required partition is absent.
- Unmatched roadside boarding stops attach geographically to their closest
  station within 350m. They cannot bridge separate stations into one hub.
  Multiple bays at a physical station retain all their boarding stop IDs.
  Augmented boards preserve the canonical station’s served platforms even
  when a platform lies outside the nearby-stop radius. Name-only ingestion
  checks the feed-owned station location to avoid merging distant namesakes.
  Drawable identity and boarding stop membership are independent, so a peer
  may provide both `stationId` and `feedStopIds`.
- Station indices retain feed-owned `departureRouteIds` separately from drawn
  `lines`. A simplified schematic cannot remove a serving departure route.
- Feed-only endpoints preserve their seeded boarding stops in `feedStopIds`.
  Station cards query these departures by the agency and hub identity without
  requiring a schematic station ID. Map badges still require a drawable peer
  station. The departures lookup reads the seeded agency topology and uses the
  same real-time decoder and trip boarding facts as schematic stations.
- Visual badge positioning offsets, target-specific badge labels, custom station aliases, and exclusions are safely isolated in `interchanges.overrides.json`. IDs are compared with agency scope; names remain display text and are used only by controlled seed ingestion.

## Override format

Regional overrides live beside each artifact, for example `src/agencies/ca/on/interchanges.overrides.json`. Specify `badgeOffsets` keyed by `agencyId` to customize placement independently for each agency's map (preventing visual collisions when switching maps). Positive `dx` moves right, negative `dx` moves left, positive `dy` moves down, and negative `dy` moves up. When an agency has no override, the seeder calculates a deterministic position against the static schematic before writing the artifact.

```json
{
  "hubs": [
    {
      "id": "ttc-go-union",
      "badgeOffsets": {
        "ttc": { "dx": 0, "dy": 24 },
        "go": { "dx": 30, "dy": 0 }
      }
    }
  ],
  "exclusions": [
    {
      "left": { "agencyId": "ttc", "stationName": "Finch West" },
      "right": { "agencyId": "go", "stationName": "Finch West" }
    }
  ]
}
```

An override replaces the reviewed endpoints and presentation of a discovered hub when its `id` matches or its endpoint pair matches. Newly discovered peer agencies remain in the hub; suppress false connections through explicit exclusions. Endpoint pairs compare `(agencyId, stationId)` when both IDs are present; name normalization is a controlled fallback for mapless data and must reject ambiguity.

### Exclusions (`left` and `right`)

The `exclusions` array suppresses false-positive transfer pairs discovered automatically by the seeding pipeline (e.g. stops from two agencies that share a name and sit within 350m, but are merely roadside bus stops rather than actual transfer terminals).

- `"left"` and `"right"` define the two agency endpoints in the prohibited connection.
- Matching is symmetric: defining `{ left: TTC, right: GO }` prevents that transfer pair regardless of endpoint order.
- When an exclusion matches, the auto-discovered connection between those two specific stations is discarded during compilation.
- A multi-agency hub remains grouped under its original ID; compiled `excludedPairs` metadata suppresses only the prohibited badge relationship.

Run the seeder after changing overrides so the committed compile-time artifact is regenerated:

```sh
bun run seed:interchanges
```
