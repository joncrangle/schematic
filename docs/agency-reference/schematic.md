# Schematic

Part of the [agency guide](../add-an-agency.md). A **Schematic** is declared
data: canvas size, coloured line polylines, station anchors, labels, badges, a
camera viewport, and geo-reference anchors from WGS84 to schematic space
(`SchematicSchema` in `src/agencies/types.ts`). The renderer
(`buildSchematicTopology`) knows nothing about agencies, so any valid schematic
gives a working map.

A schematic draws the network riders already recognize from the operator's
published map, with the same colours and trunk-and-branch shape. It is a
declared network, not a stop map. Admission requires one; start small and
orthogonal, covering the primary network. It doesn't need to be a full or
production-quality map before the agency loads.

The conformance kit checks structure: schema, line references, and status
derivation. It can't judge orientation, angles, label clearance, or whether a
station sits on its line. That review is on you, and it applies to existing
schematics whenever you touch them.

## Pick the reference

Before drawing, record the official reference in the issue or PR: its URL, its
edition or effective date, and whether it's a system map, rapid-transit diagram,
or route map. Then look at it closely.

Use the orientation riders know from that map. Check its compass, the direction
of the main corridors, and where the lake or river, downtown, campuses, and
transfer terminals sit. Some operators align their road grid with the page and
show north at an angle. A measured offset from true north doesn't justify
rotating their diagram. With no established operator diagram, start north-up.
State the reference and reason before any relayout that changes orientation.

The drawing is simplified and not to scale. Keep station order, branches, and
landmark relationships while making room for labels. Compare campuses and
similarly named hubs by station identity, since a shared name doesn't mean a
shared location. Layout fixes go in the agency's `stations`, `lines`, labels,
badges, and viewport, never in Core transforms. A visual relayout leaves the
feed-owned coordinates and platform IDs in `stationIndex` alone.

Include bus stations only when the schematic represents that bus network, on
declared lines and sequences. Never add an isolated bus point to a rail map just
to give an interchange a destination. Use a name-only interchange endpoint until
the bus network has real coverage.

## Networks without rail

An arterial bus network still benefits from a schematic. Drawing every local
route turns the canvas into a tangle, so pick 5 to 8 routes that form the
frequent spine. Start from the operator's current system map and use the GTFS
feed to confirm route IDs, service span, and terminal locations.

1. **Rapid corridors first.** Include every branded rapid or limited-stop
   corridor, counting each service or branch once. Don't add a parallel local
   just because it shares the corridor. If the rapid network alone exceeds
   eight lines, include all of it and explain why.
2. **Arterial trunks next.** Fill the remaining slots with frequent all-day
   routes that join major centres into legible cross-city corridors. Compare
   weekday and weekend service in the feed to separate all-day from peak-only;
   don't invent a frequency threshold.
3. **Intermodal links.** Add a route reaching a regional rail or intercity
   terminal if the chosen corridors don't already.
4. **Record the choice.** In the issue or PR, list each route's GTFS ID, public
   name, role (rapid, arterial, or intermodal), and verification source. Name
   the excluded groups: local feeders, school specials, seasonal and peak-only
   service.

Riders find the excluded routes through nearby cards, search, and targeted
route mode.

Stations on a bus schematic are transfer hubs, park-and-rides, campuses,
junctions, and terminals, never every curbside stop. They follow the same ID,
line, and sequence rules as any station. When names differ from the feed, add
aliases and reseed; don't hand-edit generated `stationIndex` fields.

## Station accessibility

`accessible` is a curated boolean on each station, not a feed property.

- Omitted means unknown. The pill has no wheelchair symbol and the popover says
  "Accessibility information unavailable".
- `true` for stations and major stops with level or ramp boarding, elevators, or
  AODA-compliant access. The pill gets the wheelchair symbol.
- `false` only when evidence shows the stop lacks accessible infrastructure. The
  popover says "No elevator access".

Evidence comes from the operator's accessible-stop register, an accessibility
plan with per-stop data, a stop-tier classification, a GIS layer with a
stop-level attribute, or a GTFS field with curb or level-boarding data. GTFS
`wheelchair_boarding` describes vehicle boarding assistance, not the stop, so it
can't settle the question alone. Nor can a fleet claim or a compliance statement.

## Circuits and reversals

They look alike on a map and behave differently. A **circuit** leaves a station
and comes back to it. A **reversal** arrives at a station and leaves the way it
came.

A circuit has no terminal, and every trip carries `direction_id=0`.

- Draw it closed: the polyline returns to its start. Straightening it misstates
  the service.
- Don't flag the hub `terminal`. The flag means end-of-line and is per station,
  so set it only when some line really ends there. Riders can disprove a fake
  terminal from the timetable.
- Give it no `cornerInsertions` entry. The closed polyline already turns back,
  and an entry distorts every status span crossing the hub.

Core ignores closed lines when inferring station-departure termini. Their first
and last listed stations don't set a boarding direction; explicit trip terminal
facts still apply.

A reversal needs a `cornerInsertions` entry:
`{ lineId, stationId, before, after }` (`SchematicCornerInsertionSchema`). The
status overlay renders a span as its own sub-path, and at a reversal it splices
that path from the incoming and outgoing legs given as `before` and `after`.
Validation checks only that the line exists and the station lists it. Set
`before` and `after` to the incoming and outgoing legs of the reversal.

An issue or PR records the feed version and service dates seen when it was
written. `direction_id`, route ids, and headsigns drift, so trust the feed you
downloaded over the record.

## Cartography rules

Riders must be able to find stations, follow corridors, and see connections.
That outranks any preferred pitch, angle, or label rotation. Keep the operator's
recognizable diagram and judge choices in the rendered map, especially where
several corridors meet.

**Octilinear only.** Every segment is horizontal, vertical, or 45°. No arbitrary
angles or curves in declared points; the renderer rounds vertices.

**Straight trunks.** Major corridors follow one axis suited to the map's
orientation. Don't force a north-south corridor vertical when the reference
draws it diagonal. Shared corridors keep one axis or constant parallel spacing.
Branch and rejoin with 45° diagonals instead of dips and zig-zags.

**Station pitch.** Keep about 80 to 120 coordinate units between consecutive
trunk stations so pills and labels don't collide. Each node sits on every
corridor in its `lines`, and each `sequences` entry passes its nodes in service
order. Check shared nodes, loops, and reversals by eye; valid IDs don't prove
placement.

**Labels.**

- Prefer horizontal labels. Use angled labels where they improve readability
  on dense corridors. Check real text bounds, not just rotation values. Badge
  contents stay upright.
- On horizontal corridors, alternate above and below (`anchor: "middle"`). On
  vertical spines, use left (`anchor: "end"`) or right (`anchor: "start"`).
  Termini point outward, away from the incoming line.
- Keep each label visibly attached to its own node. Start side labels 20 to 35
  schematic units from the node centre, using `anchor: "start"` on the right
  and `anchor: "end"` on the left. Start centred labels about 30 units above or
  below the node with `anchor: "middle"`. For example, a node at `(100, 100)`
  can use `{ "x": 125, "y": 100, "anchor": "start" }` on its right or
  `{ "x": 100, "y": 70, "anchor": "middle" }` above it. A tall interchange
  pill may need more vertical space.
- Measure the shortest gap between the marker's visible edge and the nearest
  edge of the text, accounting for `anchor`, rotation, and the enlarged pill.
  Aim for about 10 to 20 schematic units of clear space. A long centred label's
  anchor is not its nearest text edge. These are SVG map units, not screen pixels
  at the current zoom; do not push captions away to maintain a fixed pixel gap.
- Text must clear lines, badges, and other labels. If a nearby placement collides,
  try the other side of the node, a different anchor, or a local layout adjustment.
  Do not solve a collision by leaving the caption detached from its station.
  Reserve short `leader` lines for genuinely crowded locations and keep the
  caption close enough that its station is still obvious.

**Colours and badges.**

- Use official colours from GTFS `route_color` or brand guidelines, with clear
  contrast between parallel and crossing lines.
- Badge `textColor` is `#FFFFFF` or `#000000`, whichever passes WCAG AA against
  the badge `color`.
- Put route badges beside the line, offset perpendicular from a clear stretch.
  Never centre one on a line. Start the badge centre 30 to 35 schematic units
  from its own line: for a horizontal segment at `y: 100`, try `y: 130` at a
  clear point along that segment; for a vertical segment at `x: 100`, try
  `x: 130`. Offset diagonals along their perpendicular, not both axes by the
  full distance.
- Allow about 8 to 12 units between the enlarged badge's outer edge and the
  widest line stroke. Check the circle at its 1.25 hover/focus scale, not just
  its centre. Keep it clear of station pills, captions, peer badges, and other
  route badges. These distances are SVG map units, not screen pixels.
- A badge must clearly identify its own route. On parallel or crossing routes,
  choose a nearby unshared stretch where it is closest to the intended line.
  If the first position collides, slide it along that line or try the opposite
  side. Do not detach it from its corridor to find empty space.
- At termini, also set the badge back along the corridor, clear of the terminal
  marker and label. Existing drawings are examples, not exceptions.

## Authoring order

1. Pick the canvas size and lay out `lines` with ordered `points`.
2. Place `stations`, each listing its `lines`; set `terminal` and `accessible`.
3. Add `sequences`, the ordered station IDs per line used for topology and
   status spans.
4. Fill `viewport` (initial framing and zoom limits) and `geoProjection` (two
   lon→x and two lat→y anchors).
5. Place labels beside their nodes, then check text edges against pills and
   surrounding routes using the label rules above. Add `cornerInsertions` only
   for true reversals.
6. Place route badges and check the enlarged circle against every nearby path,
   pill, and label.

## Inspect the render

Open the actual map in a browser at desktop and mobile sizes in `bun run dev`
before opening a PR. An overview or a screenshot of only the centre is not a
complete visual check. Zoom until captions are readable, then pan across every
branch and endpoint. Inspect each interchange in both full and compact modes.
After moving a caption or badge, reload and inspect the changed region again.
Coordinate checks and static SVG renders supplement this browser pass. Check:

- No label overlaps another label, marker, badge, or line.
- A necessary leader is short, meets the marker's outer edge, and stays behind
  enlarged markers. It never crosses through the node's centre.
- Each label is close enough to identify its node without tracing across empty
  space or confusing it with a neighbouring station. Check at the initial zoom
  and at a readable zoom on mobile, including long and rotated captions.
- Every route badge, at hover and focus size, clears all lines, pills, labels,
  and badges, and sits close enough to identify its own route without guessing.
- Intersections and divergences are clean 45° or 90° angles.
- The map sits balanced in `viewport.bounds` and matches the reference's
  landmark relationships.
- Full and compact interchange badges stay legible beside route badges, including
  enlarged pills at major hubs.

## Reseeding after changes

1. When membership, sequences, aliases, or feed mappings change, reseed:
   `bun scripts/seed.ts --agency=<id> --db=sqlite`. A change to coordinates,
   labels, badges, or viewport alone needs no reseed. Recheck `geoProjection`
   anchors when the canvas or orientation changes; they're an approximate
   projection, not a stand-in for authored positions.
2. Recompile interchanges with `bun scripts/seed.ts --interchange-only`. First
   review the changed agency's manual `badgeOffsets` and remove stale ones so
   automatic placement can recalculate, keeping other agencies' offsets.
   Automatic placement doesn't override manual offsets, and its score ignores
   route badges and enlarged pills, so inspect full and compact modes. See
   [regional interchanges](interchanges.md#regeneration-workflow). Never
   hand-edit `interchanges.jsonc`.
3. Check that `cityPresets` sit on their physical stations, near 0 m away.
4. Run the pre-flight checks from
   [step 9 of the guide](../add-an-agency.md#9-register-and-check).
