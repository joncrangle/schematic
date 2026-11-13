# STO live departure investigation

Checked 2026-11-10, 13:56–13:59 UTC, during weekday service.

STO has fresh vehicle positions, but this investigation did not establish a
reachable source of live departure predictions. The official trip feeds were
empty, and the operator's Planibus departure board returned timetable rows
without real-time indicators. The experimental module wires the signed standard trip feed and rejects a header-only
response. Live departures remain unverified during this outage. This is a
live-service gap, not a demonstrated transport failure.

## Published contract and signed-feed evidence

The [STO developer page](https://www.sto.ca/affaires/espace-developpeurs-donnees-ouvertes/)
describes standard trip updates as tracked trips and custom updates as those
updates plus same-day schedule changes. It requires pairing realtime with static
GTFS. Its [API documentation, version 1.1](https://www.sto.ca/site/assets/files/1533/documentation_dev_gtfsrt.pdf),
pages 2–3, specifies:

- `https://gtfs.sto.ca/download.php`, query parameters `key`, `file`, and `hash`.
- `file=trip`, `alert`, or `vehicule`.
- Uppercase SHA-256 hex of the private secret followed by UTC `yyyyMMddTHHmmZ`.
- Optional `stream=standard` or `custom`, default standard. Custom applies to trip.

The supplied probe constructs that request correctly. Both credentials matched
the documented uppercase hexadecimal lengths. No secret values or signed URLs
were recorded here. Independent requests using Bun's environment loading gave:

| UTC time | Request | HTTP | Bytes | Decoded evidence |
| --- | --- | --- | --- | --- |
| 13:57:59 | trip, standard | 200 | 15 | Header only, no entities |
| 13:57:59 | trip, custom | 200 | 15 | Header only, no entities |
| 13:57:59 | vehicule, standard | 200 | 10,801 | 139 vehicle entities |
| 13:57:59 | alert, standard | 200 | 22,969 | Populated protobuf |
| 13:58:30 | trip, standard and custom | 200 | 15 each | Header only |
| 13:58:30 | trip, stream omitted | 200 | 15 | Header only |
| 13:58:30 | vehicule, standard | 200 | 10,751 | 138 vehicle entities |

The first standard trip header was GTFS-RT 2.0, FULL_DATASET, timestamp
`1794318995`, or 13:56:35 UTC. The later vehicle header was 13:57:26 UTC,
with vehicle fixes from 13:52:32 through 13:57:23 UTC. These are valid payloads,
not decoder failures. Responses declared `application/octet-stream`.

A deliberately invalid signature, retaining the same public key, also returned
HTTP 200 and a header-only trip payload. The equivalent vehicle control returned
a populated 10,751-byte payload. HTTP success therefore cannot establish that
the server enforced the signature. The observations do not distinguish an
account-specific trip restriction from an upstream trip-generation problem.
The rider-board evidence below makes a broader prediction outage plausible,
but does not prove its cause. There is no documented additional trip permission
or request parameter in the cited contract.

This investigation made 11 download-endpoint requests, with no polling loop.
Safe local evidence is in `/tmp/agency-wave/sto-research-*.pb` and decoded
`sto-research-vehicles*.txt`. Earlier supplied captures agree with the empty-trip
finding but were not used as a substitute for these independent requests.

## Planibus client trace and GTFS joins

The operator-linked [Planibus](https://www.planibus.sto.ca/hastinfo) exposes
Next Departures. Its actual index bundle calls these public paths under
`https://www.planibus.sto.ca/HastInfo/`:

1. `api/NextPassingTimesAPI/GetStopsRouteDirectionsAndLandmarksSuggestions`,
   GET with `queryString`, returns stop identifiers and descriptions.
2. `NextPassingTimes/RequestNextPassingTimes`, GET with
   `suggestionInputIdentifier=<stop>`, `suggestionInputType=Stop`,
   `stopInputIdentifier=` and `mustBeAccessible=false`, returns JSON
   `{ Error, Html }`.
3. The results bundle calls `NextPassingTimes/RefreshNextPassingTimes`, GET
   with `stopIdentifier`, `mustBeAccessible`, optional `selectedRouteKeys`,
   and `oneStopRouteAvailable`. The board advertises a 30-second refresh rate.

These are client-observed paths, not guessed endpoints. They required no login,
API credential, or private account access. Source paths without bundle version
queries are [index JavaScript](https://www.planibus.sto.ca/HastInfo/bundles/js/index)
and [results JavaScript](https://www.planibus.sto.ca/HastInfo/bundles/js/nextpassingtimesresults).
Downloaded versions and board captures are saved as `planibus-index.js`,
`sto-next-results.js`, `sto-next-board.html`, `sto-board-*.html`, and
`sto-refresh-4413.html` in `/tmp/agency-wave/`.

At 13:56–13:58 UTC, eight valid stop boards returned 48 departure rows in total.
Stops were `3579`, `4413`, `3941`, `3577`, `8080`, `8081`, `8083`, and `4000`.
All rows had `PredictedTimeIndicator EmptyPredictedTimeIndicator` and
`data-trip-vehicle="null"`. The board's own legend defines its prediction
indicator as real time. Four other stop probes returned explicit errors and
were excluded from the count.

Concrete joins against the operator's current
[static GTFS](https://contenu.sto.ca/GTFS/GTFS.zip), downloaded as `sto.zip`:

| Planibus stop and route key | Planibus trip key | Static join | Board evidence |
| --- | --- | --- | --- |
| `4413`, `71~~North` | `20261110_65031_63296652` | Stop `4413`, DAVIDSON/de CHARNY; trip `63296652`, route `71`, direction `0`, headsign Labrosse; stop sequence `26`, 09:04:00 | 13:57:29 UTC, 08:57 local: `7 min.`; refresh at 13:58:30: `6 min.`; empty prediction indicator both times |
| `8083`, `400~~South` | `20261110_65031_63296045` | Stop `8083`, Station de la CITÉ #2; trip `63296045`, route `400`, direction `1`, headsign Ottawa; stop sequence `5`, 09:00:00 | 13:57:47 UTC: `3 min.`; empty prediction indicator |

Planibus stop identifiers equal static `stop_id` and `stop_code` in these
examples. Route public numbers equal static route IDs. The final trip-key
component joins to static `trip_id`; do not treat the middle component as a
known GTFS field. Planibus's textual directions must not be copied as GTFS
numeric direction IDs. The captured vehicle feed also contains trip `63296652`
on route `71`, so this example involves an operating bus.

The future departures above establish working identity joins and timetable
coverage. They do not establish live predictions. In particular, a minutes
countdown can be computed from the static time and must not be accepted as
live evidence.

## What remains missing

A fresh future departure carrying a real-time indicator or a nonempty GTFS-RT
stop-time update is still missing. Before admission, repeat a bounded check
when predictions recover, or obtain first-party clarification about trip-feed
availability and account permissions. The current observations cannot prove
whether this is temporary, account-specific, or a wider upstream failure.
No alternate first-party live prediction source was established through the
operator's rider tool. Vehicle locations alone do not fill that gap.

## Implementation checks

The shared request transport now implements the documented minute signer with
Web Crypto. A fresh Core vehicle-only read at 14:20 UTC returned 97 vehicles.
Vehicle-only consumers do not fetch the trip feed. An opted-in header-only trip
response fails before stop filtering, so the station board reports unavailable
or retains stale predictions rather than treating schedules as live.

Cache-bypassed authenticated requests at 14:01 UTC returned the same 15-byte
standard and custom trip payloads. They declared `must-revalidate`, with no Age,
ETag or Last-Modified headers. A browser cache is not an established cause.

The machine alert feed omits current notices on the operator's advisory board.
The module reads that board and all eight linked detail pages. The complete
assembled snapshot reported live coverage, including Maloney Est and Plateau
stop closures. Closed-stop extraction excludes recommended and temporary stops.
The shared TypeScript and Rust parsers preserve the explicit Début/Fin fields
and the publication year used by yearless service dates.

## Topology, scope and regional connections

The manual seed downloaded the current archive again at implementation time.
It contains 1,857 served stops. All are inside the declared bounds, and the
coverage audit over 3,562 existing schematic hub points changed no existing
Automatic-selection winner. The separate Ottawa corridor box is deliberately
larger than OC Transpo's covering boxes, while compact Gatineau boxes resolve
STO's own hubs.

The six drawn corridors are Rapibus 100, 200, 400 and 800, Freeman 20, and
Aylmer–Ottawa 55. Their stop order is checked against current trips. The
[official network map](https://www.sto.ca/site/assets/files/2130/carte_reseau.pdf)
is the geographic reference, retrieved November 10. Local, school and peak
routes remain in the full seeded route catalog. Booking-only STO à la demande
is outside the fixed-route catalog.

The [operator's downtown routing page](https://www.sto.ca/horaires-et-trajets/parcours-au-centre-ville-dottawa/)
confirms Lyon and the Centre Rideau stop on Mackenzie King Bridge. The shared
Mackenzie King bus platforms are distinct from O-Train Rideau and the Waller
Street intercity stop; unverified walks are excluded. Tunney's Pasture is a
shared terminal in the current route feed and official map. The current
[FlixBus Gatineau stop page](https://www.flixbus.ca/bus/gatineau-qc) identifies
Station de la Cité at 459 boulevard de la Cité, matching the shared facility.
No isolated bus node was added to the OC Transpo schematic.

City presets use current GTFS rows 8081, 2051 and 1097. Platform membership is
seed-generated. Interchanges declare Lyon, Mackenzie King, Tunney's Pasture and
Station de la Cité. The generated placement audit's new FlixBus caption conflict
was fixed by placing that peer badge above the Gatineau caption.
