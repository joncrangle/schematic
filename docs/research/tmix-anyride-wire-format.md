# Tmix AnyRide wire format

**Date captured:** Monday 2026-09-28, 11:10–11:20 EDT (weekday bus service hours)
**Tenant probed:** `https://milton.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api`
**Auth:** none. AnyRide is queried unauthenticated; no cookies or keys are involved.
**Status:** Verified against the live wire. Every field below was read from a real
populated response, not inferred from vendor docs.

Fixtures live in `tests/fixtures/realtime/tmix/` and are loaded through
`tests/fixtures/realtime/tmix-wire-fixtures.ts`. This document exists so the next
person does not have to re-probe during service hours — a capture is only
possible while buses are running.

> **Host note for future probes.** This machine has an `AutoConfigURL` proxy that
> refuses `milton.tmix.se` and `metrolinx.tmix.se`. Every PowerShell call needs
> `Invoke-WebRequest -NoProxy -UseBasicParsing`, or it fails in a way that looks
> like the endpoint is down.

---

## 1. Endpoint inventory

| Endpoint                                            | Method     | State on this tenant                                                                     |
| --------------------------------------------------- | ---------- | ---------------------------------------------------------------------------------------- |
| `GetCalls`                                          | POST, JSON | **Populated** during service hours. This is the only useful position-independent source. |
| `GetVehiclePosition?callId=`                        | GET, JSON  | **Populated.** The only live-position source that carries data.                          |
| `GetVehiclePositions?data=`                         | GET, JSON  | **Administratively disabled.** Always `[]`.                                              |
| `GetConfigOptions?profile=AnyRide&language=English` | GET, JSON  | Works; `"showVehicleLocations": false`.                                                  |

`GetLines`, `GetStopAreas`, and the autocomplete endpoints exist and respond, but
are out of scope: static topology comes from the GTFS feed instead.

---

## 2. `GetCalls` — the two-level group trap

```
POST {base}/GetCalls
Content-Type: application/json

{"query":{"fromStopAreaQuery":"MI2203"},"configuration":{"grouping":[]}}
```

> **Send `"grouping":[]`.** Milton and Simcoe LINX answer `"grouping":0` with
> HTTP 500. `[]` returns the two-level shape with one call per group (verified at
> `MI2203`: 14 groups / 14 calls; `MI2017`: 25 / 25), and
> `["Line","Destination1"]` also works. Tables and fixtures below that mention
> `grouping: 0` were captured before that body started failing; their shape is
> identical to the `[]` response.

Top-level keys: `isStopCancelled` (bool), `calls` (array), `messages` (array).

**`calls` is an array of GROUPS, not a flat list of calls.** Each group is
`{id, calls: [...]}`. Measured:

| Query                                         | groups | inner calls |
| --------------------------------------------- | ------ | ----------- |
| `MI2203`, `grouping: 0` (now HTTP 500)        | 9      | 9           |
| `MI2017`, `grouping: 0` (now HTTP 500)        | 19     | 19          |
| `MI2203`, `grouping: []` (2026-10-14)         | 14     | 14          |
| `MI2203`, `grouping: ["Line","Destination1"]` | 5      | 9           |

A one-level decoder reads the groups as if they were calls, finds no
`departure` on them, and yields **zero records while looking like it worked**.
This is the single most dangerous fact on the wire. The decoder flattens two
levels, and an entry with no nested `calls` array is treated as a bare call so
an ungrouped future response still decodes.

Group `id` under the real `rowGrouping` encodes its key:
`l:6000006/dest1:6000051` — the `lineId` and an internal destination id.

### Inner call record (complete)

```json
{
  "id": "2027026825",
  "key": "3",
  "lineId": 6000007,
  "routeId": 1004657,
  "journeyId": 1494143,
  "stopPointId": 6000663,
  "sequenceNumber": 0,
  "line": "8",
  "lineAppearance": { "background": "#41827C", "foreground": "#FFFFFF", "fontStyle": "regular" },
  "journey": "632",
  "destination": "WILLMOTT - MILTON GO",
  "subdestination": "",
  "departure": {
    "journeyType": "Ordinary",
    "forecastTime": "2026-09-28T11:02:00-04:00",
    "plannedTime": "2026-09-28T11:02:00-04:00",
    "quality": "realtime",
    "attributes": [],
    "designation": ""
  },
  "createdTime": "2026-09-28T11:02:15.1953101-04:00"
}
```

### What each id means — and which one carries the operator prefix

AnyRide is multi-tenant. The manifest's `operatorPrefix` (`"60"` for Milton) is
matched against exactly one field:

| Field         | Milton sample  | Type   | Carries the operator prefix?                 |
| ------------- | -------------- | ------ | -------------------------------------------- |
| `lineId`      | `6000007`      | number | **YES** — the `60` block is Milton's         |
| `routeId`     | `1004657`      | number | no — a system-wide Tmix route number, `10…`  |
| `line`        | `"8"`          | string | no — bare human label                        |
| `stopPointId` | `6000663`      | number | shares the shape, but identifies a stop area |
| `journeyId`   | `1494143`      | number | no                                           |
| `id`          | `"2027026825"` | string | no — the call id                             |

Observed Milton `lineId`s: `6000006, 6000007, 6000016, 6000017, 6000018,
6000023, 6000078, 6000080, 6000081`. Observed `routeId`s: `1003183, 1004654,
1004655, 1004657, 1004662, 1004663, 1004665, 1004667, 1004671, 1004673`.

> **The wire carries one operator field, not two.** It is tempting to frame the
> choice as "operator id vs. line id", as though the wire carried both. It carries
> one operator-scoped field, `lineId`, on the call. `routeId` and `line` are the
> tempting mistakes and both are silent: scoping on either against prefix `60`
> drops **100% of Milton's own calls** and surfaces as an empty board rather than
> an error. `stopPointId` shares the `60…` shape but is a stop, not a line.

### Field notes

- `line` is the value Core uses as `routeId` (matching the agency's route table
  and the manifest's `routeLineMap`): `"1" "2" "3" "4" "5" "6" "7" "8" "9A" "9B" "21"`.
- `destination` is the trip's terminal and is **empty on some lines** (observed
  empty for lines 1, 5, 6, 8 at MI2017). Not a capture artifact.
- `sequenceNumber` is a real journey position (16–48 at MI2017), not always 0.
- `departure.attributes` is `[]` on every call observed and nothing decodes it
  — see §7 for why that is deliberate.
- `lineId` maps one-to-one to (line, direction-ish) but is **not** Core's route
  id: `lineId` 6000006 → line `5`, while 6000007 → line `8`. It is a Tmix-internal
  id and must not leak into `routeId`.
- `stopPointId` is Tmix's internal stop-area id, **not** the GTFS stop id
  (`MI2203`). Predictions must be keyed to the stop that was _queried_.

### Timestamps

ISO 8601 with an explicit offset. **Not** .NET ticks, **not** epoch seconds.
Three forms in play, all handled by `Date.parse`:

| Field                         | Form                              | Example                             | Epoch ms      |
| ----------------------------- | --------------------------------- | ----------------------------------- | ------------- |
| `forecastTime`, `plannedTime` | `-04:00` offset, second precision | `2026-09-28T11:02:00-04:00`         | 1790607720000 |
| `createdTime`                 | 7 fractional digits               | `2026-09-28T11:02:15.1953101-04:00` | 1790607735195 |
| vehicle `timestamp`           | `Z`                               | `2026-09-28T15:06:54Z`              | 1790608014000 |

`+00:00` also appears. `Date.parse` resolves to epoch **milliseconds**, so
Tmix's sub-second digits are truncated to the precision the domain uses
(`1790607735195`, not `…51953101`). Nothing in the domain carries sub-ms time,
so the loss is not observable — but it is truncation, not preservation.

---

## 3. `GetVehiclePosition` — the only populated position source

```
GET {base}/GetVehiclePosition?callId=2027026825
```

```json
{
  "id": "2027026825",
  "classes": [],
  "timestamp": "2026-09-28T15:06:54Z",
  "heading": 216.7987060546875,
  "location": { "lat": 43.51272071711719, "lon": -79.85481346026063 }
}
```

- `heading` is **intermittently absent**. In the 9-record capture, 7 had it and
  2 did not — including vehicles that were demonstrably moving. Treat as
  optional; never emit `NaN`, and never default to `0` (which reads as "due
  north", a claim the feed never made).
- No route id, no line, no accessibility, no speed, no occupancy. All of those
  must come from the originating call.
- An unknown `callId` returns **HTTP 200 with the literal body `null`**. That is
  a successful request with no record, not a failure.

---

## 4. `GetVehiclePositions` (bulk) is disabled — do not build a decoder for it

```
GET {base}/GetVehiclePositions?data=%7B%7D
→ HTTP 200, body: []
```

Confirmed on **every** parameter shape tried (empty `data`, per-line `data`,
per-stop `data`), and `GetConfigOptions` reports `"showVehicleLocations": false`.

This is why `tests/fixtures/realtime/tmix/vehicle-positions.empty.json` and
`vehicle-positions.bulk.disabled.json` both legitimately hold `[]`. An
always-empty endpoint is indistinguishable downstream from a healthy feed with
no vehicles running, so wiring a decoder to it would convert a loud feed failure
into a silent false-green "no buses running" — the thing AGENTS.md rule G7 and
the "Live service requirement" section forbid. Positions come from the singular
endpoint, and the transport module documents why the bulk builder is retained
but never dispatched.

---

## 5. Non-record answers (both are traps)

| Situation         | Response                     | Why it breaks naive code                                                                          |
| ----------------- | ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Unknown stop area | **HTTP 204, zero-byte body** | `response.ok` is `true` for 204, so a `0`-byte buffer reaches the decoder and `JSON.parse` throws |
| Unknown `callId`  | HTTP 200, body `null`        | A valid status with no record; treating it as a failure drops a live fleet                        |

Both must decode to "nothing", not to an error. Reproduce the 204 with any
`MI####` that does not exist (e.g. `MI2201`, `MI1001`).

---

## 6. `directionId` does not exist on this wire

There is no direction, heading, or compass field anywhere in `GetCalls`, and
none in `GetVehiclePosition` beyond the vehicle's numeric `heading`. So
`directionId` is **inferred per seam**, never read:

- **Realtime seam** (`genericGtfsRealtimeSource`): `inferDirectionFromBearing`
  (`src/domain/surface/types.ts`) from the vehicle's `heading`. A vehicle with
  no heading falls to the helper's documented default of `0`. Departures have no
  bearing to infer from, so they carry `directionId: 0`.
- **Stations seam** (`genericStationsSource`): there is nothing to read.
  Milton's terminals are street names (`"MAIN - MILTON HOSPITAL"`,
  `"HARRISON - MILTON GO"`, `"ONTARIO SOUTH - MILTON GO"`), and none of the five
  captured terminal strings contains a `-bound` word, so the projection is a
  declared constant `0` rather than a guess.

**Consequence for the station board, and why it is not a bug.** `directionId: 0`
renders as the compass word `Northbound`. For a bus the operator described as
`"YATES - MILTON GO"` that is a specific claim the feed never made, so every
Tmix arrival is marked `ArrivalPrediction.directionInferred` and the display
layer prefers the agency headsign. A board row reads `→ YATES - MILTON GO`, not
`Northbound`.

This is _not_ the same as "always show the headsign". For a feed that establishes
a real direction (every GTFS-RT agency — TTC, GO, Miway, Brampton, Burlington,
Hamilton, Kingston, YRT) the direction word is a true statement and continues to
outrank the headsign unless buckets collide or the mode is rail. The mark is
what keeps the two cases apart, and only Tmix's decoder sets it.

Note `"ONTARIO SOUTH"` contains a compass word as a _street name_. A decoder
that scanned `destination` for a bare `south` would mislabel it; nothing does,
which is also why no compass-word channel survived on the projection.

## 7. Accessibility: documented by the vendor, never observed here

`departure.attributes` is documented by AnyRide to carry `"wheelchair"` for an
accessible vehicle. It was `[]` on **every** call seen — all 37 occurrences
across the captured fixtures, and a sweep of roughly 4,000 stop ids spanning
MI1xxx–MI4xxx on 2026-09-28.

**No decoder reads it and no domain field exists for it.** An earlier draft of
this adapter added `LiveVehiclePosition.wheelchairAccessible` mapped from
`"wheelchair"`; it was removed on review because the value had never been seen
on the wire, nothing in `src/` read the field, and a test pinning it passed
identically whatever the real attribute vocabulary turned out to be — it
certified a feature rather than a fact. Milton's fleet is low-floor, so the
attribute may simply never be populated for this tenant.

If accessibility is wanted for Tmix, the honest order is: capture a populated
`attributes` value first, then add the field with a reader. A future capture
should sweep at a stop and time where an accessible vehicle is actually
assigned, since the value is evidently not emitted on every fleet.

---

## 8. What was deliberately not built

Deliberately out of scope: static `GetLines` / `GetStopAreas` / autocomplete,
authentication, sub-second polling, and alert endpoints. Tmix publishes no
authoritative alerts channel, so Milton's `alerts` stays pointed at the town's
own rider-alert page rather than a stub feed that would fake an all-clear.

## 9. Operational notes for the next capture

- Service hours: the board is populated roughly 06:00–20:00 EDT on weekdays.
  Outside that, `calls` is `[]` and positions are `null`.
- A capture needs a real stop with departures. `MI2203` (Milton GO) and `MI2017`
  (Main at Court) both carry 9–19 calls mid-morning; many `MI####` ids 204.
- Adding a new agency on AnyRide means re-deriving its `lineId` block for
  `operatorPrefix` and confirming `GetConfigOptions.showVehicleLocations` for
  that tenant. The prefix is the only thing keeping other municipalities' buses
  off the map.

## 10. Request budget

The adapter's cost per refresh is `stop queries × feeds` +
`vehicle queries × feeds`, and only the singular position endpoint carries
records, so a vehicle refresh is always a fan-out of one request per bus. That
makes the total subrequest count the number that matters, not either phase
alone — a per-phase cap is not a per-invocation cap.

`TMIX_MAX_SUBREQUESTS = 40` is the ceiling, under the Workers Free limit of 50
per invocation, and it is split evenly between the two phases and across
declared feeds by `tmixWorkPlan`:

| feeds | stop `GetCalls` | vehicle `GetVehiclePosition` | total |
| ----- | --------------- | ---------------------------- | ----- |
| 1     | 20              | 20                           | 40    |
| 2     | 10              | 10                           | 40    |

Stops are truncated before vehicles, because a stop query is what discovers
call ids: with no stop query there is no vehicle work regardless of the
allowance. Truncation is logged with the count dropped, since a partial map and
a quiet network look identical to a rider.

The heaviest caller is the proximity panel, which names up to 3 stops per route
across every route in range. For Milton's 11-line table that is roughly 30
distinct stop ids, well over the 20-stop allowance — so the common case _is_ a
truncation, logged, rather than a silent overrun.
