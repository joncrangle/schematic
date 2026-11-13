# Regional interchanges

Part of the [agency guide](../add-an-agency.md). Interchanges are regional
data, not module files. They join any modes that share a physical station,
including a bus terminal and a subway or rail station, and reviewed walking
connections between neighbouring facilities.

## Where the data lives

Each artifact sits in the parent of an agency's `scopePath`:
`src/agencies/ca/on/interchanges.jsonc`, `src/agencies/ca/nat/interchanges.jsonc`,
or `src/agencies/intl/interchanges.jsonc`. Discovery covers every seeded agency
across these groups.

- Each hub is written once, in its first endpoint's region.
- Discovered endpoints sort by agency ID; override endpoints keep their order.
- National and international scope doesn't limit the peers or countries in a hub.

After the first seed creates an artifact, add its JSONC import and region entry
to [interchangeCatalog.ts](../../src/agencies/interchangeCatalog.ts). Never
register a region without an artifact. The browser loads that catalog directly;
there is no merged generated file.

The browser reads only the generated `interchanges.jsonc`. Editing
`interchanges.overrides.json` does nothing until you regenerate.

## Discovery and overrides

Geographic discovery pairs nearby cross-agency stations automatically.
Exceptions and visual fixes go in the region's `interchanges.overrides.json`,
such as `src/agencies/ca/on/interchanges.overrides.json`. A region without one
uses an empty set.

```json
{
  "id": "ttc-go-union",
  "endpoints": [
    { "agencyId": "ttc", "stationId": "union", "stationName": "Union" },
    { "agencyId": "go", "stationId": "union", "stationName": "Union", "badgeLabel": "GO" }
  ],
  "badgeOffsets": {
    "ttc": { "dx": 8, "dy": -24 },
    "go": { "dx": 30, "dy": 0 }
  }
}
```

**Endpoints.** An endpoint needs `stationId` when that agency's schematic draws
the location and the badge should navigate there. A connection outside the
drawn network stays a name-only endpoint. Never borrow a nearby station's ID or
a feed ID to make it navigable; adding bus coverage is a schematic decision.
`badgeLabel` on the target endpoint overrides the manifest short name.

**Exclusions.** Discovery also pairs stops that are merely close. A pair with no
operator-documented transfer goes in the `exclusions` array as a `left`/`right`
pair. Discovery groups stops by name, so a station with several stop names needs
one exclusion per name. A name-only endpoint whose name repeats within the agency
declares `feedStopIds`. The seeder rejects ambiguous names and `feedStopIds` that
match nothing, so stale entries fail loudly.

**Isolated stations.** When no stop near a station is a documented transfer,
list it once in `isolated` instead of excluding each nearby stop in turn:
excluding one stop only lets discovery pair the next. Name the station as an
exclusion endpoint would. It joins no discovered hub, though an override hub can
still declare it.

**Names.** Normalization strips English and French direction and platform
suffixes, keeps non-Latin letters, and never translates. Use overrides and
schematic aliases for real naming differences. Light rail, subway, and rail
stations can form interchanges without a drawn schematic; unrelated roadside bus
stops can't.

## Badge placement

`badgeOffsets` moves an agency's whole peer-badge row on its own map, in
schematic units. Positive `dx` is right, positive `dy` is down, so the example
moves the TTC row 8 right and 24 up. Without an offset, the seeder picks a
deterministic spot scored against labels, stations, routes, map bounds, and
other rows.

Keep badges short, normally the provider's short name. Don't add station names
or `walk` to badges; the dashed link shows a walk. Compact mode drops the icon
and arrow but keeps the label. Never rename a bus stop as the rail station or
imply a bus enters the rail terminal.

Keep authored offsets near their node. A multi-agency row may need a vertical
layout to stay close to a walking station in both full and compact modes.
Authored positions stay fixed and conflicts are reported. Automatic rows move
only when a nearby spot reduces conflicts, and an unchanged reseed never moves
rows.

## Walking connections

A walking connection joins neighbouring facilities when an operator or
transport authority explicitly documents the transfer. Proximity alone doesn't
count. Record the source and check the entrances, pedestrian approach, and
current serving routes. Use a regional override that keeps each facility's real
identity and boarding stops.

For a prominent neighbouring station, prefer a separate peer node with a dashed
link. Declare `walkingMarkers` on the target endpoint, keyed by the agency whose
map displays it:

```json
{
  "agencyId": "regional",
  "stationId": "central",
  "stationName": "Central",
  "walkingMarkers": {
    "local": { "dx": -40, "dy": 40, "label": "Regional Central" }
  }
}
```

Read it as: on the `local` map, draw Regional Central 40 units left and 40 down
from `local`'s own station. The label names the target, not the map's station.

- Selecting the node opens the peer's real station card. A short badge beside it
  switches to the peer map; position it with `badgeOffsets`.
- The node stays visible with full, compact, or hidden badges. It belongs to
  regional data, not the local station index, lines, or sequences.
- Each map opts in separately. Keep an ordinary badge where a peer node would
  need misleading distance or would hide the local network.
- For reciprocal nodes, check both maps. Labels swap, and each placement keeps
  the facilities' real relative orientation.
- Keep the peer close enough to read as a nearby transfer. Compare with the
  spacing of adjacent stations; a long connector implies a long walk. Use the
  shortest clear placement.
- The drawing shows a connection, not wayfinding or a measured distance.

A node outside the map, or farther than the nearby-transfer limit, falls back to
an ordinary badge on that map. The report names the suppressed opt-in, and the
planner drops its peer offset and restores a prior ordinary position if there is
one. Identities, boarding stops, and the other map's opt-in stay intact. Fix or
remove the marker before rollout.

The offline planner models drawable targets, short labels, mode grouping, row
sizes, and walking geometry in both full and compact modes. It reserves space
for station nodes, rotated captions, leaders, routes, enlarged route badges,
walking links, and other rows. Font widths and smoothed route ink are estimates,
so a clean report still needs a visual check.

## Regeneration workflow

```sh
bun run seed:interchanges
```

This compiles from existing agency databases (the same as
`bun scripts/seed.ts --interchange-only`) and skips selection prompts. It writes
`data/interchange-placement-report.json`, which is local and not committed. The
command prints every changed row with previous and next offsets, authored or
automatic, and the report lists unresolved obstacles and walking fallbacks.

A region whose required agency is missing locally keeps its existing artifact
while other regions compile. A targeted agency seed updates its own regions and
any region whose old or new hubs include it, which covers a national operator
across several regions.

1. Edit the schematic or overrides, then run `bun run seed:interchanges`. Reseed
   GTFS first if membership or serving facilities changed.
2. Review every changed row, including knock-on moves on other agencies' maps.
   Check the station, peer node, nearby captions, route ink, and route badges.
3. Inspect desktop and mobile with full and compact badges. For a walking
   opt-in, also hide badges, click the node to confirm its station card, and
   use its badge to confirm agency switching.
4. Fix conflicts in the schematic or overrides and regenerate. If the estimated
   envelopes flag something that looks clear, record the hub, map, obstacle, and
   reason in the audit note. Keep an ordinary badge when a walking node can't
   fit. Never edit `interchanges.jsonc` by hand.
5. Run the command again with no edits. Expect zero changed rows and an
   identical artifact. The second run overwrites the report, so keep the first
   one while reviewing. Confirm endpoint identities and boarding stops didn't
   change.
6. Commit the inputs and regenerated artifact together, with evidence and any
   reviewed exceptions in the PR.
