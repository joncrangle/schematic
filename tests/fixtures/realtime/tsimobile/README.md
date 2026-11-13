# Network train document capture

`daytime.json` is an unmodified response from
<https://tsimobile.viarail.ca/data/allData.json>, captured during the
2026-10-07 00:35 UTC session. Its train fixes include 00:34:30 and
00:34:40 UTC. Tests freeze the clock at 00:35 UTC instead of contacting VIA.

`gtfs-index.json` is generated from the official archive at
<https://www.viarail.ca/sites/all/files/gtfs/viarail.zip>, downloaded in the same
session, using `buildTsimobileGtfsIndex`. It is adapter input, not a production
agency module. Refresh it with the generator when replacing the capture.

Captured operator identifiers are confined to wire-format regressions. Shared
filtering and station-departure tests use authored fictional routes, station
codes and geometry.

The response has numeric train keys and service-date suffixes, completed
instances retained beside active multi-day trains, and optional GPS blocks.
Stops carry their own timezone and ISO offsets. Top-level stop estimates can
refer to arrival rather than boarding; tests use nested departure estimates.
Missing times include `&mdash;` and nested null estimates. Delay severity is
`goo`, `med`, or `bad`. Speed is kilometres per hour.

This capture does not establish an empty-object quiet-feed contract, so `{}` is a decode
failure. A valid document containing only completed trains produces no live
vehicles or predictions. Tests derive quiet and failure cases from this capture;
they do not describe those mutations as observed responses.

The adapter ignores per-train advisory prose for network service status. Live
departures only cover tracked trains, and future schedules without a departure
estimate never become live rows. Five-minute polling, cache sharing, retries for
torn reads, and cooldown after failures belong to Core.

The static map's published topology reference is VIA's
[2024 annual report](https://media.viarail.ca/sites/default/files/publications/VIA-Rail_Annual-Report_2024.pdf),
network map on page 12. The app draws the current GTFS route geography, opens on
the Windsor–Québec corridor, and allows panning across the national network.

The authored city presets use the official GTFS coordinates for Toronto,
Ottawa, Montréal, Vancouver, and Québec, verified in the 2026-10-07 capture
session. The initial popular route catalog picks the Montréal–Toronto and
Ottawa–Toronto corridors, the Canadian, and the Ocean for onboarding; their
canonical IDs come from the same archive. This is a usefulness selection,
not a ridership ranking.
