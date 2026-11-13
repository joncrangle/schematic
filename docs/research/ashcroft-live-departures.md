# Ashcroft live departures

Checked 2026-10-28. Outcome: **admit for implementation as experimental**.

The outstanding active-service capture gate is satisfied. The official operator 38 trip-update endpoint returned two current-service-day trips and 11 future arrival/departure events in each of two samples taken inside the 09:00–09:50 trip. Every published trip, route, stop and stop sequence joined exactly to the freshly downloaded static archive. The public data terms permit reuse. Vehicle positions are optional under the [admission criteria](../add-an-agency.md#admission-criteria).

This is an admission finding, not a completed agency launch or a reliability claim. All captured delays were zero and event times matched the timetable. The samples do not demonstrate a changing ETA or independently establish vehicle movement. BC Transit's previously established NextRide service, together with fresh prediction-bearing GTFS-RT during actual service, supports proceeding. A nonzero delay or additional capture pair is not a separate admission requirement.

## Sources and capture method

[BC Transit Open Data](https://www.bctransit.com/open-data/) publishes the operator's static, trip, vehicle and alert feeds. All four requests below used HTTPS with certificate validation and no credentials.

- [Static GTFS](https://bct.tmix.se/Tmix.Cap.TdExport.WebApi/gtfs/?operatorIds=38)
- [Trip updates](https://bct.tmix.se/gtfs-realtime/tripupdates.pb?operatorIds=38)
- [Vehicle positions](https://bct.tmix.se/gtfs-realtime/vehicleupdates.pb?operatorIds=38)
- [Alerts](https://bct.tmix.se/gtfs-realtime/alerts.pb?operatorIds=38)

The static archive was checked first, at 16:01:40 UTC. Realtime requests followed serially with at least one second between requests. Decoding used the repository schema, without a third-party substitute:

```sh
protoc --decode=transit_realtime.FeedMessage proto/gtfs-realtime.proto < capture.pb
```

Raw bytes, HTTP headers, UTC request metadata, decoded text, static tables, verified joins and SHA-256 hashes are preserved locally under `.state/ashcroft-live/2026-10-28/`. The existing `.state/` ignore rule covers this directory. These files are local evidence, not published repository artifacts. The excerpts and counts below make the conclusion reviewable without them. `SHA256-manifest.json` inventories the captures; `verified-joins.json` records every event and its static match.

## Current calendar and exact trip windows

The static request returned HTTP 200, 6,793 bytes, with Last-Modified `2026-10-28 15:10:47 GMT`. Archive SHA-256:

```text
ada36505ff28ccd6be20565650190752140c12914493c1c100f7cfd4cc1b3b0f
```

`agency.txt` declares `agency_id=0`, name `BCTransit`, timezone `America/Vancouver`, language `en`. The request selector `operatorIds=38` is not the GTFS agency ID. `feed_info.txt` declares version `202610280/20261027 21:00:00/20261028 04:00:00`, coverage 2026-10-28 through 2027-12-31, and publisher Consat Telematics AB.

There is no `calendar.txt`. `calendar_dates.txt` explicitly adds service `5704` on `20261028` with `exception_type=1`. All four static trips use that service and route `1-ASH`, short name `1`, long name `Ashcroft- Clinton`, type `3`. The archive contains four trips, 16 stop-time rows and five stops.

| Trip ID | Direction | First to last stop | America/Vancouver | UTC |
| --- | --- | --- | --- | --- |
| `2345366:8929154:8930159` | 0 | Ashcroft to Clinton | Oct 28 09:00–09:50 | Oct 28 16:00–16:50 |
| `2345368:8928724:8930159` | 1 | Clinton to Ashcroft | Oct 28 10:30–11:30 | Oct 28 17:30–18:30 |
| `2345367:8927733:8930324` | 0 | Ashcroft to Clinton | Oct 28 15:15–16:10 | Oct 28 22:15–23:10 |
| `2345369:8929974:8930324` | 1 | Clinton to Ashcroft | Oct 28 16:15–17:00 | Oct 28 23:15 to Oct 29 00:00 |

Both samples below fall inside the first trip, rather than a gap within the broad 09:00–17:00 service span. Vancouver was UTC−07:00 on this date. The official [route schedule](https://www.bctransit.com/ashcroft-cache-creek-clinton/schedules-and-maps/route-overview/?route=1) corroborates Wednesday/Friday service and these trip endpoints. Off-service empty captures from other days cannot establish lack of live service.

## Live trip evidence and exact joins

The first trip request began `2026-10-28T16:01:46.308118Z`. HTTP 200, 379 bytes, GTFS-RT version `1.0`, `FULL_DATASET`, header epoch `1793203300`, or 16:01:40 UTC. Header age at request was 6.31 seconds. It contained two trip updates, seven stop-time updates and 11 future events, including five departure events. Arrival and departure at the same stop count separately.

Both trip descriptors declare `start_date=20261028`, `schedule_relationship=SCHEDULED`, route `1-ASH`, and start time and direction matching static. `SCHEDULED` is the trip relationship, not evidence that the response lacks realtime stop events. Each published event includes an absolute epoch, `delay=0`, and `uncertainty=30`. There is no trip-update measurement timestamp or vehicle descriptor in this response.

Compact decoded excerpt from the currently running trip:

```text
trip {
  trip_id: "2345366:8929154:8930159"
  start_time: "09:00:00"
  start_date: "20261028"
  schedule_relationship: SCHEDULED
  route_id: "1-ASH"
  direction_id: 0
}
stop_time_update {
  stop_sequence: 2
  arrival { delay: 0 time: 1793203920 uncertainty: 30 }
  departure { delay: 0 time: 1793203920 uncertainty: 30 }
  stop_id: "158006"
  schedule_relationship: SCHEDULED
}
```

The running trip's exact static matches are:

| Stop sequence | Static and realtime stop ID | Static name | Arrival epoch / local time | Departure epoch / local time |
| --- | --- | --- | --- | --- |
| 2 | `158006` | Riverside Dr at Sage and Sands Dr | `1793203920` / 09:12 | `1793203920` / 09:12 |
| 3 | `158000` | Cache Creek | `1793204100` / 09:15 | `1793204400` / 09:20 |
| 4 | `158002` | Clinton | `1793206200` / 09:50 | Not supplied |

The earliest event was 613.69 seconds in the future at request time. The origin stop was absent from the running trip's updates, so implementation must accept a partial remaining-stop sequence.

The other entity joins trip `2345368:8928724:8930159`, direction 1, start 10:30. Its four static and realtime stops match exactly in order: `158002`, `158000`, `158006`, `158001`. It supplies Clinton departure 10:30, Cache Creek arrival 11:00 and departure 11:15, Riverside arrival/departure 11:18, and Ashcroft arrival 11:30. All six events were future events. No route or stop-ID normalization was needed for either trip.

A second request began `2026-10-28T16:02:55.437045Z`, returning HTTP 200 and 379 bytes. Header epoch `1793203370` was 16:02:50 UTC, age 5.44 seconds. The header advanced 70 seconds. Both entities, all seven stop-time joins and all 11 future events remained valid; the event epochs were unchanged. Automated local checks asserted trip-to-route identity, active service ID, each stop-sequence/stop-ID pair, and equality of reported delay with the event epoch minus its static scheduled instant.

The optional vehicle request at `16:01:47.419630Z` returned HTTP 200, 15 bytes, zero entities, header `1793203297`, age 10.42 seconds. This is a reachable, fresh empty sample. It does not establish that vehicle positions are never published and does not block departure admission. Check positions again during implementation and declare them if supplied.

## Alerts and existing decoder

The operator's [official alerts link](https://alerts.bctransit.com/ashcroft-cache-creek-clinton/) opens a JavaScript application. Its HTML alone does not prove an empty board. The public application bundle exposed the read-only endpoints below. Captures from 16:02:37 through 16:02:47 UTC returned HTTP 200.

[Transit-system metadata](https://alerts.bctransit.com/transitsystem) resolves Ashcroft to **alert-system ID 2**, title `Ashcroft - Cache Creek - Clinton`, active true, Health Connections active true. This ID differs from Tmix operator 38.

- [Route board](https://alerts.bctransit.com/routealert?id=2) returned one group for `routeId=1-ASH`, `routeShortName=1`, with `alerts: []`.
- [Stop board](https://alerts.bctransit.com/stopalertbysystem?transitid=2) returned `[]`.
- Manual boards returned `[]` for [Health Connections, type 1](https://alerts.bctransit.com/manualalert?transitId=2&alertTypeId=1), [handyDART, type 2](https://alerts.bctransit.com/manualalert?transitId=2&alertTypeId=2), [Information Services, type 3](https://alerts.bctransit.com/manualalert?transitId=2&alertTypeId=3), and [Bus Exchange, type 4](https://alerts.bctransit.com/manualalert?transitId=2&alertTypeId=4).

All six actual captured JSON responses passed the existing `normalizeVendorJsonAlerts(payload, "rendered-advisory-board")` decoder, each producing `alerts: []` and `partial: false`. The existing generic adapter supports these response shapes; this capture establishes no new Core adapter gap. Preserve the route, stop, information and exchange boards as required completeness sources, following the existing BC agency pattern. Include relevant Health Connections notices without implying that booking-only trips have live departures. Review handyDART scope, since system metadata says it is inactive.

The Tmix alert request at `16:01:48.670013Z` returned HTTP 200, 15 bytes, header `1793203291`, age 17.67 seconds, and zero entities, hence no active periods to inspect. This agrees with the board captures, which had no notices to reconcile. Do not wire a header-only feed as sole evidence of all-clear. Recheck periods, scope and cross-source reconciliation when nonempty alerts appear. [BC Transit's alert guidance](https://www.bctransit.com/customer-alert-system/) identifies the website, Transit App and Google Maps as rider channels.

## Rider scope, map and attribution

[BC Transit's 2024-11-21 NextRide announcement](https://www.bctransit.com/nextride-real-time-bus-location-technology-now-available2024-11-21/) establishes live bus locations and predicted stop arrivals for this system. It identifies Transit App, Google Maps and the BC Transit website as access tools. The [Village transit page](https://ashcroftbc.ca/service/bc-transit/) independently confirms these capabilities. Those establish rider expectations; the dated feed captures above establish reachable departure data.

The [current schedule/map page](https://www.bctransit.com/ashcroft-cache-creek-clinton/schedules-and-maps/) lists route 1 and links its system map and rider guide. Its separate next-bus widget is labelled as scheduled, so that label alone is not live evidence. The [official rider guide](https://www.bctransit.com/ashcroft-cache-creek-clinton/wp-content/uploads/sites/4/2026/02/13343_ASH_RG_spring-v1-APPROVED.pdf) is effective August 3, 2020, updated February 2026. It contains the network map on page 2, artwork code `10994-02072025`. A local PDF capture and rendered page were inspected. Use this edition as the schematic reference: one route linking Ashcroft, Riverside, Cache Creek and Clinton. Do not invent extra schematic lines to reach the guide's generic line-count suggestion.

The [on-request page](https://www.bctransit.com/ashcroft-cache-creek-clinton/schedules-and-maps/on-request/) also publishes booking-based Monday Kamloops and 100 Mile House trips and local request windows. The rider guide separately describes Health Connections. Operator 38's current static archive and observed trip feed cover route 1 only. Implementation should include every service that the live rider tools actually present as departures, including any request services proven there, but should not manufacture live departures from these booking timetables. Additional route-scope checks belong to implementation after this admission.

[Open Data terms](https://www.bctransit.com/open-data/terms-of-use/), fetched locally on 2026-10-28, permit use, reproduction and redistribution subject to conditions. Attribute BC Transit and link its source and terms. The terms restrict use of its marks and provide data without warranty; they do not explicitly refuse reuse. Feed publisher metadata additionally names Consat Telematics AB. No credentials were required.

## Bounds, presets and registered peers

Current static coordinates provide authoritative city presets:

| Stop ID | Name | Latitude | Longitude |
| --- | --- | --- | --- |
| `158001` | Ashcroft | 50.72513 | -121.27939 |
| `158000` | Cache Creek | 50.81107 | -121.32438 |
| `158002` | Clinton | 51.09333 | -121.58412 |
| `158006` | Riverside Dr at Sage and Sands Dr | 50.80192 | -121.32336 |
| `958000` | Ashcroft Garage | 50.71437 | -121.27924 |

Prefer separate tight bounds around these served clusters, including the feed's garage stop if seeded, rather than a large residential rectangle across the corridor. The total feed envelope is latitude 50.71437–51.09333, longitude -121.58412–-121.27924. Verify stop coverage and Automatic selection against existing agency hubs during implementation.

No supported registered-peer interchange was found. Registered BC peers in the shared catalog are TransLink, Victoria, Kelowna and BC Ferries; none shares the captured stops. Kamloops and 100 Mile House are mentioned in the operator's booking services but are not registered peers in this checkout, so add no placeholders.

VIA Rail is registered and its schematic includes Ashcroft `ASHN` at 50.730397, -121.26929. Its [official station page](https://www.viarail.ca/en/embedded/station/detail/ASHN) places the signpost on Caribou Road on the north side of the Thompson River, across from downtown. That is distinct from the bus's Safety Mart stop. Neither the checked bus sources nor that station page documents a transfer or walking connection. Do not create a same-name interchange from proximity alone. Reassess only with operator-supported connection evidence.

## Implementation handoff

Proceed with an experimental agency module using the proven operator 38 departure feed and exact static IDs. Keep the existing generic board decoder and completeness behavior, use the February 2026 rider guide for the small schematic, audit bounds, and verify both deployment runtimes. The current captures prove access from this research host, not Cloudflare egress. Recheck published vehicle positions and live rider route scope during implementation. The admission research preceded the implementation checks below.


## Implementation verification

Checked again on 2026-10-28 during the same morning trip.

- The module seeds four served stops and route `1-ASH` into SQLite and local Miniflare D1. The fifth archive stop, Ashcroft Garage, has no revenue stop-time rows and is not seeded. All five archive coordinates are within the declared boxes; all four seeded stops pass the coverage audit.
- Automatic selection remains unchanged at all 302 existing presets and 1,178 existing regional schematic station-index locations. All three new presets resolve to Ashcroft. No existing agency's bounds were changed.
- A later vehicle capture at 16:09:47 UTC contains vehicle `3131273219`, trip `2345366:8929154:8930159`, a fresh position near Ashcroft, and speed 13.58 m/s. Vehicle positions are declared along with trip updates. This supersedes the initial empty-position limitation.
- A temporary Cloudflare remote preview fetched all eight declared sources through Cloudflare's YYZ location at 16:12:48–16:13:03 UTC. Every request returned HTTP 200. The real `createAgencyProvider` station source and snapshot also ran remotely, returning future Riverside/Cache Creek/Clinton departures and a `live`, empty alert snapshot. The temporary preview uses no production storage and does not seed or deploy the production application.
- The self-hosted Bun provider returned future station and surface predictions, a vehicle position, and a live empty snapshot. Forcing the required route-advisory source to HTTP 503 changed the snapshot to `stale`, preserving failure honesty.
- The official boards remain empty. There were no current advisory cards to compare. The actual app's map and Riverside departure card were inspected at desktop and mobile sizes against the official guide. Unknown stop accessibility remains unknown.
- Two interchange recompilations produced zero changed rows and identical tracked regional artifacts. The placement report still lists 145 conflicts in existing hubs; this module introduces no interchange or placement changes.
- Offline checks pass: 4,012 unit tests, TypeScript, lint, formatting, generated attribution, generated alert identities, agency validation, documentation links and production build.

The Cloudflare capture also contains prediction-bearing `NEW` and `ADDED` updates for trip `2345366:8929154:8930159#131273219`, with the same route, start date/time, and stop sequence as the original morning trip. Those events have nonzero delays, unlike the first admission samples. A remaining original `SCHEDULED` update retains zero-delay calls. Exact duplicate added-trip instants collapse on station cards, while distinct original and added-trip instants remain separately visible. The wire data does not explicitly identify the original as cancelled or replaced. Do not claim every later trip ID joins static exactly, or silently strip the suffix to assert identity without a documented source rule.

The deployed production surface partition still requires its manual initial seed. Local SQLite, Miniflare D1, and Cloudflare remote-preview execution do not populate production D1.
