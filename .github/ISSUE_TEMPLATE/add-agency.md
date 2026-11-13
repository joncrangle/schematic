---
name: Add an agency
about: Implementation handoff for one transit agency under the standing admission criteria
title: "Add <Agency> as an experimental <mode> agency"
labels: ["enhancement", "ready-for-agent"]
---

<!--
Fill every section so an agent in a fresh session can implement without
re-researching. The rules live in docs/add-an-agency.md#admission-criteria;
do not restate them here. Record facts, URLs, IDs, and traps only.
-->

Part of #<map or wave issue>. Follow [the agency guide](../blob/master/docs/add-an-agency.md) and its [admission criteria](../blob/master/docs/add-an-agency.md#admission-criteria).

## Sources

Checked <YYYY-MM-DD HH:MM UTC>. Re-verify before writing the manifest.

| Kind | URL | Auth | Evidence at check time |
| --- | --- | --- | --- |
| Static GTFS | | | `agency_id`, routes/stops/trips, date range, timezone |
| Vehicles | | | status, header age, entities, ID alignment with static |
| Trip updates / departures | | | status, header age, future predictions, ID alignment |

Static and realtime quirks that would trap an implementer:

-

## Attribution

<!-- Published licence, or best-effort attribution and why no explicit terms apply. -->

## Alerts

| Channel | URL | Declare? | Current advisories seen |
| --- | --- | --- | --- |
| | | | |

Core adapter this issue owns, if any:

-

## Rider reference

<!-- The operator tools that set scope. Note routes included or excluded from departures and why. -->

- System map:
- Real-time tool:
- Advisories page:

## Bounds

<!-- Municipal core box, corridor boxes, and registered agencies whose boxes could conflict. -->

## Interchanges

<!-- Shared stations or operator-documented walks with registered agencies only, with stop IDs on both sides. Write "None" if none. -->

## Schematic

Reference: <URL, edition or effective date, orientation>

| Line | route_id | Public name | Termini |
| --- | --- | --- | --- |
| | | | |

## Done when

- [ ] Registered as `experimental`.
- [ ] Live vehicles and departures verified on Cloudflare and self-hosted runtimes, through the daemon proxy if Cloudflare egress is blocked.
- [ ] Alerts cannot produce a false all-clear.
- [ ] Stop-coverage audit passes; existing agencies keep Automatic selection at their hubs.
- [ ] Interchanges and schematic in place.
- [ ] Pre-PR checks from `CODING_STANDARDS.md#commits-and-pull-requests` pass, plus parser parity when a parser changed.

## Known limitations

-
