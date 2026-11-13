# Add a country to the coverage map

The coverage map draws one landmass, province and state borders, agency
service areas, and national network stations on a single SVG camera. Panning
and pinching repaint that SVG every frame on phones, so geometry size and
rendering choices decide whether the map stays smooth.

## Add the geography

[generate-coverage-geography.ts](../scripts/generate-coverage-geography.ts)
builds both geography sets from configured sources:

- `COVERAGE_REGIONS` holds the drawn geometry. Use an `admin0` entry for the
  country outline and `admin1` entries for its first-level subdivisions. Their
  ids follow `<country>` and `<country>-<subdivision>`.
- `CLASSIFICATION_COUNTRIES` holds the more detailed outline that the header
  uses to name the country at the map centre.

Run `bun run coverage:geography`, then commit the regenerated files under
`src/components/network-coverage/generated`. The generator emits the drawn
country list, each country's subdivision regions, and every source's
attribution label and URL alongside the regions; the coverage UI, map label,
and footer attribution all derive from that metadata.

## Keep the geometry small

Every drawn point is processed on every camera frame.

- Start from the existing `simplifyTolerance` and `minPolygonArea` values.
  Detailed coastlines and island chains add points quickly.
- Admin-1 borders are visible from the opening camera on phones, and each
  region is one path.
- Polygons stored across the antimeridian stretch the projection. Drop them
  with `dropPolygonsEastOf`.
- The map uses one equirectangular projection fitted to all drawn countries.
  A distant country widens the opening frame for every rider; check the
  opening camera.

`bun run bench:coverage` prints the land and border point counts. Report them
in the pull request alongside the benchmark.

## Keep frames cheap

These rules come from measured regressions on Chromium and WebKit:

- **No per-zoom attribute writes on geometry.** Keep strokes screen-sized with
  `vector-effect="non-scaling-stroke"` and constant widths. Draw screen-sized
  dots as round-capped, zero-length path segments rather than circles with a
  zoom-scaled radius. The coverage DOM test fails when zooming rewrites map
  geometry.
- **Stroke long outlines through `outlineChunks`.** Browsers rasterize in
  tiles and restroke a whole path for every tile it touches. Short pieces let
  each tile skip outline it cannot see.
- **Do not chunk fills.** Clipping the land fill into pieces did not reduce
  raster time and multiplied paint work.
- **Do not rotate patterns.** WebKit repaints a `patternTransform` rotation
  very slowly. Draw diagonals inside an axis-aligned tile instead.
- **Prefer one path per layer or agency** over one element per feature.
  Element count drives style and paint work.

## Measure the change

Install the benchmark browsers once with
`bunx playwright-core install chromium webkit`. Then run
`bun run bench:coverage` on the base branch and on the change, and compare:

- **Chromium (Android proxy):** main-thread `taskMs` for pinches and `rasterMs`
  for pans. It runs with a 4x CPU throttle and software raster.
- **WebKit (iPhone proxy):** `avgFrameMs` and `framesOver40Ms`. Add
  `--dpr=5` to expose paint costs that still fit within 60 fps.

Before merging, check pans and pinches on a real phone against a production
build. See [testing on a phone](development.md#testing-on-a-phone-or-another-device).
