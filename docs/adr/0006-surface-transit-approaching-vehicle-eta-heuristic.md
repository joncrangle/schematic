# Surface Transit approaching-vehicle ETAs use a fixed per-stop heuristic

**Status:** Accepted

## Context

[Surface Transit](../../GLOSSARY.md) arrival countdowns must work wherever corridor facts exist, but no live prediction feed is assumed. The app therefore needs arrival estimates derivable from vehicle positions alone — identically server-side (filling empty prediction arrays in API payloads) and client-side (fallback when a card receives no arrivals).

## Decision

`deriveApproachingVehicleEtas` (`src/domain/surface/direction/eta.ts`) derives arrival timestamps (epoch ms) as a pure function of position facts:

- **Rider stop resolution** falls through by precedence: stop id match → stop code match → geographically nearest stop via `calculateHaversineMeters` (`~/domain/map/MapGeometry`). Unresolvable rider stop yields no arrivals.
- **Vehicle filtering**: when `directionId` is provided, only vehicles matching it are considered.
- **Corridor distance** is `stopsAway = riderIdx − vehicleIdx`, where each vehicle's index resolves by its own fallthrough: `currentStopSequence − 1` → `stopId` match → nearest-stop haversine.
- **Vehicles past the rider stop (`stopsAway < 0`) are excluded entirely.** Deliberate: on short-turn or loop corridors, an approaching-looking vehicle behind the boarding stop would produce a misleading estimate — arrivals vanish rather than degrade.
- **Timing heuristic**: `stopsAway === 0` arrives at `now + 30_000 ms` ("arriving"); every further stop adds a fixed `120_000 ms`. No timetable, traffic, or dwell-time inputs exist.
- Results sort ascending and cap at `maxResults` (default 3).

Because the derivation is pure and deterministic, one implementation serves both consumers: `NearbyTransit` fills empty prediction arrays server-side, and `RouteArrivalCard` derives countdowns client-side when live arrivals are absent (the same tracking facts position vehicles on `LinearStopStrip`). Rejected alternative: integrating a schedule-aware or live prediction feed — where an agency provides live predictions, they take precedence and this heuristic remains the fallback.

## Consequences

- Known limitation, recorded deliberately: the fixed 120 s-per-stop interval ignores scheduled timetables, traffic, and dwell times — a vehicle three stops away always reads ~6 minutes regardless of actual conditions.
- Short turns produce _no_ arrivals instead of degraded ones; the UI shows an empty state where a wrong-direction estimate would mislead.
- Server and client cannot drift apart: timing changes land in one place, and both hosts inherit them identically.
