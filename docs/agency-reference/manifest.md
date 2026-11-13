# Manifest

Part of the [agency guide](../add-an-agency.md). `manifest.json` declares an
`AgencyManifestConfig` (schema: `AgencyManifestConfigSchema` in
`src/agencies/types.ts`). The inline example below shows the module shape.

A malformed value for any present field fails at boot, in dev, CI, and
production alike. Optional fields stay optional: leaving one out never fails
boot.

## Example

```json
{
  "id": "go",
  "name": "GO Transit",
  "locale": "en-CA",
  "timezone": "America/Toronto",
  "bounds": [{ "minLat": 43.0, "maxLat": 44.6, "minLon": -80.6, "maxLon": -75.8 }],
  "modes": ["rail", "bus"],
  "stationService": { "routeType": "rail" },
  "attribution": {
    "name": "Metrolinx Open Data",
    "url": "https://www.metrolinx.com/en/about-us/open-data",
    "license": "<license id>"
  },
  "status": "experimental",
  "scope": "regional",
  "jurisdiction": { "country": "ca", "region": "on" },
  "staticTopology": {
    "source": "seed",
    "feeds": [
      {
        "name": "GO Transit",
        "url": "https://assets.metrolinx.com/raw/upload/Documents/Metrolinx/Open%20Data/GO-GTFS.zip"
      }
    ],
    "defaultColor": "#00853F",
    "defaultTextColor": "#FFFFFF"
  },
  "realtime": {
    "feeds": [
      { "kind": "vehicle_positions", "url": "…", "format": "protobuf", "pollIntervalSeconds": 15 },
      { "kind": "trip_updates", "url": "…", "format": "protobuf", "pollIntervalSeconds": 15 }
    ]
  }
}
```

`staticTopology.source` defaults to `"nextbus"`. Without `"source": "seed"`, the
feed declaration above fails validation. Static topology options are in
[topology and seeding](topology.md#static-topology-options), feeds in
[realtime feeds](realtime-feeds.md), and alerts in [alert sources](alert-sources.md).

## Fields

- **`name`** is the rider-facing agency or network name, rather than a city-only label.
- **`serviceArea`** is an optional city or region description shown beneath the
  name in the agency picker and included in search. Declare it for new agencies,
  including when the city also appears in the name. Use a region for networks
  serving several cities. This display text does not affect coverage or Automatic
  selection; `bounds` and `jurisdiction` retain those roles.
- **`serviceAreaTranslations`** optionally maps locale tags to translated service
  area descriptions. The picker checks the rider's locale, then its base language,
  then `serviceArea`. Search matches the default and translated descriptions,
  ignoring case and accents. Keep proper place names unchanged.

- **`id`** must be unique across providers. It becomes the preference key, the
  `DB_TRANSIT` partition key, and the snapshot's `agencyId`.
- **`status`** is `"active"` or `"experimental"`. Both can be picked manually
  and resolved automatically. Automatic selection never uses status or
  registration order to guess a network when location is unresolved. Some
  legacy operational utilities still default to the first active provider.
- **`cityPresets`** are spoof-panel locations. Ask whether a developer would
  ever spoof a position at a common or central operator location. If yes, the
  presets are required work; if no, omit them. Use WGS84 decimal degrees, check
  each point against the current `stops.txt` row or an authoritative facility
  source, and record the date and source in the PR. Don't use municipal
  centroids or nearby landmarks. A preset outside every `bounds` box fails boot.
  Keep raw stop IDs and evidence in the PR, not the manifest.
- **`popularSurfaceRoutes`** is required when the agency seeds a surface route
  catalog and omitted when it doesn't. List canonical route IDs from the seeded
  catalog for the largest and most useful onboarding routes. Never invent one.
- **`routeInterpretation`** sets route types and direction inference. See
  [route types and directions](#route-types-and-directions).
- **`directionLiterals`** renames the direction words on station cards. Declare
  it only when the operator's vocabulary differs from the built-in English.
  `north` → `Northbound` changes nothing, because that's already the fallback.
  Add `outbound`/`inbound` for a rail operator that uses them. Copy operator
  terms verbatim; a rider's language preference never renames them.
- **`proximity`** overrides the shared nearby radius and bucket. Use it only when
  the service pattern needs different values.
- **`routeShortNames`** maps canonical route IDs to public labels when the feed's
  labels are missing, stale, or differ from public designators. See
  [static topology options](topology.md#static-topology-options).

Core and the App Shell read `cityPresets` and `popularSurfaceRoutes` directly.
Never add agency-specific Core code to supply them.

## Scope and jurisdiction

`scope` is `regional`, `national`, or `international`. `jurisdiction` holds
`country`, an optional `region`, and optional coverage. Together they set the
directory path and seed location.

- A regional agency takes precedence over non-regional ones in Automatic
  selection at shared locations. Omitting `scope` means regional.
- A `national` agency with a `region` lives under that region (`ca/on/<id>`).
  Without one it uses `ca/nat/<id>`.
- A new `country` needs nothing: `Intl.DisplayNames` names it in the rider's
  language. A new `region` needs its name in `src/i18n/en.ts` and
  `src/i18n/fr.ts`, plus a row in `src/i18n/jurisdictions.ts`, because no `Intl`
  API names subdivisions. An undeclared region shows its uppercased code.

## Language and operator content

`locale` is the agency's default BCP-47 locale, such as `en-CA` or `fr-CA`. The
rider's language preference controls app chrome and picks among translations
the operator publishes. It never translates station names, headsigns, direction
termini, or operator prose. Keep schematic station IDs stable when display names
vary by language.

Declare `language` on an alert source whose content has a known language, and
use a `languageGroup` for translated copies of one board. See
[translated sources](alert-sources.md#translated-sources). An untagged
multilingual GTFS-RT source keeps its translations; Core picks the requested
regional tag, then its base language, the agency default, English, and finally
an untagged value.

### Attribution

`attribution` holds the default `name`, `url`, and `license`, plus one
`translations` entry per language the operator publishes. Core matches the rider
locale tag, then its base language, and keeps the default for any missing
variant or field. Omit `translations` for a single-language operator.

When `license` is a required acknowledgement rather than a licence title, set
`licenseIsStatement: true`. The attribution card and footer then render it
verbatim with no "Licence" prefix. A translated title can set the flag back to
`false`.

```json
"attribution": {
  "name": "OC Transpo / City of Ottawa open data",
  "url": "https://www.octranspo.com/en/plan-your-trip/travel-tools/developers/dev-terms/",
  "license": "Contains information licensed under the City of Ottawa Open Data Terms of Use.",
  "licenseIsStatement": true,
  "translations": {
    "fr": {
      "name": "Données ouvertes d'OC Transpo / Ville d'Ottawa",
      "url": "https://www.octranspo.com/fr/planifiez/outils-dinformation/developpeurs/conditions-developpeurs/",
      "license": "Conditions d'utilisation des données ouvertes de la Ville d'Ottawa",
      "licenseIsStatement": false
    }
  }
}
```

## Station service

Every agency must serve live station departures. Declare
`stationService.routeType` (`"subway"`, `"rail"`, or `"bus"`) and list the same
mode in `modes`. The provider wires the shared adapter and takes line names from
the schematic. If the feed can't supply live arrivals, build the generic Core
adapter before registering. A schematic alone doesn't meet this requirement.

- `splitByLine: true` gives a station one card per line (as GO does). The
  default is one combined card.
- An agency running more than one mode into the same station, as GRT does with
  ION light rail and its bus terminals, declares an array. It must be non-empty
  with unique route types. Don't use an array to give one mode two cards; that's
  what `splitByLine` is for.

```json
"stationService": [
  { "routeType": "rail" },
  { "routeType": "bus", "splitByLine": true }
]
```

Arrivals come from `station_trip_updates` when declared, otherwise from
`trip_updates`. See [realtime feeds](realtime-feeds.md).

## Service area bounds

Automatic selection calls `rankAgenciesForPoint` in
`src/domain/agencyCoverage.ts`. It collects every agency with a box containing
the point, computes each box's area `(maxLat - minLat) * (maxLon - minLon)`, and
picks the smallest. An agency with several boxes competes with its tightest
covering box. That lets a compact city agency beat a large regional one, and it
means a sloppy box causes quiet resolution bugs.

**Keep the core box separate from corridors.** Never stretch the main box to
reach an airport, a commuter station, or a terminal in another city. A larger
box can lose to a neighbour inside your own downtown. Put the main service area
in one box and give routes that leave town their own narrow boxes.

**Don't undercut the host city at its hubs.** A tiny box around a stop in a
neighbouring city wins there: an area of 0.0001 beats the host's 0.015 inside
the host's downtown. Keep external boxes wide enough that the host stays
smaller, and give host cities a dedicated core box around their transfer hubs.

**Step boxes along diagonal borders.** One rectangle over a diagonal road either
drops local stops or spills into the next municipality. Use contiguous stepped
boxes so resolution flips at the real boundary.

**Audit stop coverage.** After seeding, query `data/transit.db` and confirm
every stop for your `agency_id` falls inside a box. A dropped stop gets the
wrong agency. Check that border boxes don't cover a neighbour's residential
stops.

**Put the municipal box first.** This is for readers only. Resolution uses the
tightest box, `manifestFallbackBounds` uses the union, and `manifestFocus` uses
its centre unless `focus` is set, so order changes nothing at runtime.

### Non-local agencies

A national or intercity operator breaks the smallest-box rule both ways. One
country-wide box never wins Automatic, which is right, but every rider inside it
fetches the agency for nearby queries. One box per station wins outright at each
station, because a station-sized box beats any regional operator.

Author these agencies as many station-sized boxes and set `scope` to `national`
or `international`. A box containing the rider still adds the agency to
coverage, so its departures appear in shared station cards, while local
operators win Automatic. The winner is the first covering regional agency, or
the first ranked entry when every covering agency is non-local.

Hundreds of station boxes still union to the whole country, so set `focus` to a
lat/lon point to replace the derived centre. For a drawn map, also set schematic
`defaultViewportBounds`, or a manual pick opens on empty geography.
`fallbackBounds` keeps deriving from the union, which suits a single national
static feed.

## Route types and directions

### Mapping feed routes to schematic lines

`routeInterpretation.routeTypeRules` maps a feed route id to a mode and has no
slot for a line id. `alertInterpretation.routeLineMap` maps a feed route id to a
schematic line id, which lands on alerts as `affectedLineIds`.

Declare `routeLineMap` whenever one drawn line covers several feed routes. An
operator running `12A` and `12B` on one corridor drawn as line `12` declares:

```json
"alertInterpretation": {
  "lineIds": ["3", "7", "12", "24"],
  "routeLineMap": { "12A": "12", "12B": "12" }
}
```

- A route id that is already a line id needs no entry.
- Every other id needs one, and a suffixed family needs every branch. An
  unmapped id attributes to no line, silently, so a half-written map leaves half
  a route's alerts lineless.
- Keys can be route ids, short names, or branch-suffixed ids.
- With `routeIdField: "short_name"`, station departures map each raw realtime
  `route_id` to its canonical route through this map. Declare every raw id,
  even beside `routeIdNormalization.aliases`, which covers alerts only. A
  missing key leaves station cards empty while the feed is live.
- Always declare `lineIds` beside the map. It's an allowlist: Core drops a mapped
  value outside it, so a typo can't invent a line, and a value naming an undrawn
  line is dropped on purpose.
- Attribution is opt-in. Without `lineIds` or `routeLineMap`, no alert carries a
  line, because a bus numbered `3` is not rail line `3` somewhere else in the app.

Declare `routeTypeRules` only when route types vary within the agency. An
all-bus agency derives its type from `modes`.

An operator that uses a fixed far-future alert retirement sentinel declares
`alertInterpretation.openEndedEndTimestamp` in epoch milliseconds. Core removes
that exact expiry from alert visibility and impact windows. Other dates remain
as published.

### Direction inference

Skip `directionInference` when headsigns already state a bearing; the feed's
words outrank any axis guess. Declare it when headsigns name only terminals and
the route type's default axis is wrong. The axis can vary per route.

For `north-south`, Core maps northbound to direction `0` and southbound to `1`.
Set `invertNorthSouth` when authoritative feed data uses the opposite IDs. It
flips inferred IDs, station direction resolution, and fallback pairs; IDs
already in the feed stay as published. TTC sets it because its Routes and
Schedules GTFS uses `0` for southbound on routes 510 and 511 (checked
2026-10-16 against the
[TTC Routes and Schedules dataset](https://open.toronto.ca/dataset/ttc-routes-and-schedules/)).

### How Core labels a direction

A direction index carries no bearing, so Core never makes a label from one. The
label comes from the most direct source available:

1. **A leading compass word in the headsign** (`North to Steeles Ave`,
   `East - 504 King to Broadview`), shown in the agency's `directionLiterals`
   wording. A compass word elsewhere (`51 HEREFORD EAST`, `East Mall`) is part
   of a destination.
2. **The route's shape.** A shape runs first point to last in the direction of
   travel, so the bearing between its endpoints is the operator's own geometry.
   It is the net direction, so a route that doubles back is labelled for where
   it ends up.
3. **A terminal-only headsign** with no usable shape shows as `→ Fairway Station`.
4. **Nothing.** An empty headsign with no shape gets no label and the row shows
   times only. Core won't substitute a canonical word for an axis the operator
   never named.

A station card row that would show times only names the trip's own end
instead. It uses the drawn station holding the trip's last stop, such as
`→ Saint-Jérôme`. Failing that, it uses the trip's scheduled `trip_headsign`
from the seeded `route_trip_headsigns` table. A headsign that repeats the route
number, states only a direction (`Sud`), or is a bare number names nothing and
leaves the row times only. All-capitals headsigns are title-cased. Rows the
feed already names, or that carry a direction word, are unchanged.

Seeding groups trips by `direction_id`, so a row is one way to travel. A route
with three northbound variants is one northbound row with the next times, not
three rows under three arrows. When a route's trips state no `direction_id`,
trips whose shape runs opposite to the route's dominant bearing become direction
1, so a route run both ways under one name still gets a row each way. Loops and
trips without a shape stay in direction 0.

Realtime departures join `trip_id` against the seeded `route_direction_trips`
table, which works even for feeds with no `direction_id`. The table holds one
row per direction group with its trip ids, because D1 bills a write per index
entry: the per-trip form cost 386k writes across eleven agencies against 1.4k.
Large groups split across rows numbered by `part`. A trip that matches no group,
with no direction on the wire, collapses into one row instead of repeating under
every terminal.

Audit the feed before seeding. Two `direction_id` values per route is normal.
One means the operator states no direction, so every label comes from geometry
or is empty.

```sh
unzip -p gtfs.zip trips.txt | awk -F, 'NR>1{print $1, $4}' | sort -u | awk '{c[$1]++} END{for(k in c) print k, c[k]}' | sort -n
```
