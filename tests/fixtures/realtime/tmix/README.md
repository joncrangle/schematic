# Tmix AnyRide wire fixtures

Recorded from the live Milton tenant (`https://milton.tmix.se/Tmix.Cap.Ti.Process.AnyRide/api`)
on **Monday 2026-09-28, 11:10–11:20 EDT**, inside weekday service hours. The field-level findings are written up in
`docs/research/tmix-anyride-wire-format.md`.

Nothing sensitive is present: these are public transit departure forecasts and
vehicle positions. No credentials, cookies, or operator secrets were involved —
AnyRide is queried unauthenticated.

## `GetCalls` — POST, JSON

| File                             | Capture                                                           | What it pins                                                                                                                                        |
| -------------------------------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls.populated.json`           | `MI2017`, `grouping: 0`, 19 calls across 9 lines                  | The two-level group shape, `lineId` as the operator-scoped field, empty `destination`, non-zero `sequenceNumber`, `routeId` NOT carrying the prefix |
| `calls.populated.grouped.json`   | `MI2203`, `grouping: ["Line","Destination1"]`, 5 groups / 9 calls | Milton's actual `rowGrouping`; group `id` encodes `l:<lineId>/dest1:<destinationId>`                                                                |
| `calls.populated.flat.json`      | `MI2203`, `grouping: 0`, 9 groups / 9 calls                       | One call per group at the same stop, so nested flattening is observable rather than assumed                                                         |
| `calls.populated.ungrouped.json` | `MI2203`, `grouping: []`, 2026-10-14, trimmed to 4 of 14 groups   | The request body the adapter sends now: one call per group, with `arrival`, `vehicleType`, and `occupancyPercent` present as `null`                 |
| `calls.empty.json`               | `calls: []`                                                       | The honest empty board (outside service hours) decodes to `[]`                                                                                      |

`grouping: 0` was the body used for the 2026-09-28 captures. It now returns HTTP 500
(verified 2026-10-14), so the adapter sends `grouping: []`, whose response has the
same shape. At `grouping: 0` Tmix returned **19 groups containing 19 inner calls**, not a
flat list. A one-level decoder reads the groups as calls and every record is
lost. Both levels are decoded.

## `GetVehiclePosition` — GET, singular

| File                               | Capture                                               | What it pins                                                                                                                          |
| ---------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `vehicle-positions.populated.json` | 9 sequential `?callId=…` reads for the `MI2203` calls | Exact epoch ms, **and `heading` present on 7 of 9 records and absent on 2** — the real intermittent-absence case, not a synthetic one |
| `vehicle-positions.empty.json`     | `[]`                                                  | The bulk endpoint's body, retained as the record of what that disabled endpoint returns                                               |

`vehicle-positions.populated.json` is an **array assembled from nine singular
responses**, not a body any endpoint returned. It is assembled that way because
there is no bulk position endpoint to capture from: see below.

## `GetVehiclePositions` (bulk) is administratively disabled

`vehicle-positions.empty.json` holds a literal `[]`, and it is a genuine capture,
not a placeholder. On this tenant:

- `GET /GetVehiclePositions?data=%7B%7D` → HTTP 200, body `[]` — on **every**
  parameter shape tried (empty `data`, per-line `data`, per-stop `data`).
- `GET /GetConfigOptions?profile=AnyRide&language=English` reports
  `"showVehicleLocations": false`.

The empty body is indistinguishable, downstream, from a healthy feed with no
buses running, so **no production code path exists for it**: there is no URL
builder and no request descriptor for the bulk endpoint anywhere under `src/`.
The finding itself lives in `docs/research/tmix-anyride-wire-format.md` §4.

## Loading these from a test

`tests/fixtures/realtime/tmix-wire-fixtures.ts` is the single loader
(`readFileSync` relative to `import.meta.dirname`). It lives outside the `tmix/`
directory so the JSON files above stay a pure capture set with no test code
among them.

## Second tenant (Simcoe County LINX), 2026-10-15

Captured at 09:19-09:21 EDT on a weekday from `https://nextlinx.simcoe.ca/Tmix.Cap.Ti.Process.AnyRide/api`.

| File                                     | What it pins                                                                                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `calls.linx.profile.json`                | `GetCalls` with the `anyride-profile-*` headers, trimmed to 3 calls: a real service message whose `affectedCalls` `["0"]` names a call by `key`    |
| `calls.linx.no-profile.json`             | The same stop without the headers: 1 call instead of about 10                                                                                      |
| `calls.linx.interlined.json`             | Assembled from four stops: calls of routes 6, 1 and 4 plus one unrelated route 4 call (a bus interlined across routes)                             |
| `vehicle-positions.linx.interlined.json` | The four singular `GetVehiclePosition` answers: the first three are byte-identical fixes, the fourth is a different bus; `heading` and `speed` set |
| `messages.contract.json`                 | Shared TypeScript and Rust contract for the message adapter. Synthetic, fictional ids; the Rust test is `matches_the_shared_parity_contract`       |
