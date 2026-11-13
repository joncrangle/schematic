# Coding standards

Read the sections matching the change or review. Product and architecture
decisions live in [ADRs](docs/adr/); this file owns implementation and test rules.

## Solid reactivity

Use derived signals or event handlers for application state. Use `createEffect`
only for external side effects that read Solid's reactive state without writing
back into it. Keep component props reactive by reading them dynamically instead
of destructuring them. Memoize object literals recreated in reactive contexts.
Honor `prefers-reduced-motion` and `data-reduced-motion` in motion behavior.

For reactive queries, component initialization, or dependency
updates, read [Solid debugging](docs/agents/solid.md).

## Effect services and server boundaries

Use Effect for backend pipelines, feed fetchers, caching stores, and domain
services. Define service interfaces with `Context.Service<Tag, Shape>()("ServiceName")`,
provide them with `Layer.succeed` or `Layer.effect`, and model failures with
`Data.TaggedError("ErrorName")`. Bridge pipelines to server functions with
`Effect.runPromise`.

Keep the explicit single-route table in `src/router.tsx`. Declare RPC wrappers as plain
async functions with `"use server"`. Secret-touching implementations belong in
server-only `*Server.ts` modules behind the `server-only` boundary; shared
`*Client.ts` modules contain validators, types, and wrapper stubs. Validate every
argument inside the server body. Process static transit geometry and large GTFS
feeds on the server to keep them out of client bundles.

## Agencies and live service

Every registered agency must declare and support:

- `realtime.feeds` with live departure predictions through GTFS-RT,
  NextBus, or a Core-owned vendor adapter such as Consat AnyRide. Live vehicle
  positions are optional and should be declared when the operator publishes them.
- `stationService` with live station departures and arrival predictions backed
  by real-time feeds.
- `alerts` with live service alerts when the operator publishes them. When the
  operator publishes advisories on a channel Core cannot decode, including a
  rider-facing web page, implement the generic Core adapter with the agency.
  If the operator publishes no advisory channel, omit `alerts` so the
  application renders "Live alerts unavailable". An empty stub feed, including a zero-entity protobuf
  header, must not create a false green "all clear" status. This violates G7.
  Omit permanently expired alert feeds too. Standing tracking disclaimers belong
  in documentation, outside the service-alert severity rollup.

Static-only agencies are prohibited. Before registering an agency or opening
its PR, implement live departures. Empty or unavailable vehicle
positions do not block admission when departure predictions are live. If the
operator
publishes only static GTFS without public GTFS-RT feeds, implement the required
transport adapter in Core before authoring and registering the Agency Module. A
static feed that downloads successfully proves transport, not live coverage, so
it never passes this gate on its own. Timetable-only support would be a separate
`scheduled` capability backed by a schedule store, not a new admission path.

Read the [agency guide](docs/add-an-agency.md) for provider contracts and
onboarding.

## Generated station data

`scripts/seed.ts` owns feed-derived `platformIds`, `departureRouteIds`, `lines`, and coordinates in
`stationIndex`, and the regional `interchanges.jsonc`. Reseeding preserves curated
station `name`, `directionTermini`, and station identities while refreshing
feed-owned fields from current GTFS data.

To change station membership or map unmatched stops, edit `sequences`,
`stationAliases`, `interchanges.overrides.json`, or the feed, then run
`bun scripts/seed.ts --agency=<id> --db=sqlite` and commit the generated result.
Do not hand-edit these feed-owned fields.

## Parser parity

Alert parsers, scrapers, and decoders in `src/infrastructure/realtime/` have twin
implementations in `services/alert-feed-daemon/`. A change in either language
requires the equivalent change in the other. Keep behavior, output, periods,
route tokens, stop IDs, and GTFS-RT entities identical.

Before committing a parser, scraper, decoder, or shared-fixture change, update
and verify both implementations:

- TypeScript: `bun run test`, including parity suites such as
  `bun run test tests/unit/ghd-news-parity.test.ts`, `bun run typecheck`, and `oxlint src`.
- Rust: `cargo test --manifest-path services/alert-feed-daemon/Cargo.toml`,
  `cargo clippy --manifest-path services/alert-feed-daemon/Cargo.toml --all-targets -- -D warnings`,
  and `cargo fmt --check`.

Shared contracts such as `tests/fixtures/ghd-news/contract.json` must pass both
the TypeScript suite and corresponding Rust contract tests, including
`cargo test -p alert-feed-daemon test_matches_the_shared_parity_contract`.

## Tests

Develop behavior changes in vertical slices: write a failing test through a
public seam, implement the minimal change, then verify. Add coverage only for behaviors
introduced or changed.

### Behavior and assertions

- Each test proves one behavior through an exported function, service, RPC
  handler, or rendered interaction. Exercise production code rather than
  rebuilding its logic in the test.
- Use `it.each` for variants of the same behavior. One suite owns each behavior;
  consolidate helper-versus-wiring duplicates into one observable assertion.
- Every passing case must assert unconditionally. Declare optional dependencies
  with `describe.skipIf` instead of returning silently or guarding assertions.
- Assert semantic output, such as "Normal Service", rather than palette classes,
  documentation prose, package/workflow text, configuration constants, or
  library internals.
- Remove a test when its deletion does not change what the suite catches. Audit
  an inherited bloated section before extending it: give every case a keep,
  merge, or delete verdict. Treat regression guards and wire-format fixtures as
  untouchable during that audit,
  and record the rationale on the tracking issue in one `test:` commit.

### Agency-independent coverage

Use small fictional agencies, authored feeds, and schematic geometry. Start
with [agency fixtures](tests/helpers/agency-fixtures.ts) and override only the
settings the case needs.

- Unit and integration behavior tests must survive removal or configuration
  changes of any production agency. Keep production agency JSON imports and
  individual agency-ID lookups out of them. For registry adapters, replace
  `agencyCatalog` with the fixture helper's `testAgencyCatalog`.
- Catalog checks may validate all registered modules without naming an agency,
  fixing membership, or requiring a provider count. Validate agency onboarding
  with `bun run agency:check`, rather than a per-agency suite.
- Supply configurable rules explicitly. Test mapping with fictional route/stop
  IDs and geometry instead of production tokens, anchors, URLs, or licence text.
- Offline vendor captures may retain operator text needed by a shared parser or
  cross-language contract. Supply parser options explicitly; those tests must
  not load the production module, contact feeds, or require seeded data.
- Reduce regressions to their relevant feed shape or configuration rule. Retain
  distinct shared behavior with synthetic fixtures when removing agency
  assertions; remove assertions that only freeze agency configuration.

### Environments and completion

Keep unit tests offline and database-free; seeded SQLite and live feeds belong
in opt-in integration tests. Stub network requests at the boundary. When a
component interaction starts a background request, return a local fixture
unless that request is the behavior under test. Service and hook tests own
request and cache behavior.

Use `*.dom.test.ts` or `*.dom.test.tsx` with the
`@vitest-environment happy-dom` directive for DOM or Solid rendering tests.
Keep this convention synchronized with `vitest.config.ts` so only DOM suites
load a browser environment. Use `@solidjs/testing-library` for rendering and
query helpers. Read [local test commands](docs/development.md#tests) to run the
suites and diagnose reactive-runtime failures.

Before finishing any test change, inspect imports, helper defaults, mocks, and
registry lookups for individual-agency dependencies. Run affected suites, the
full unit suite, and any changed integration or [parser parity](#parser-parity)
suites.

## Data attribution and credentials

Keep source names, URLs, and licence or required acknowledgements in agency
manifest `attribution` fields. Record the operator's published licence when one
exists. Otherwise attribute on a best-effort basis to the operator's official
data or transit page, and state in the licence field that no explicit terms
were found. An unconfirmed licence does not block admission; an explicit
refusal of reuse does. After agency registration, name, or attribution changes, run
`bun run attribution:generate` and include the regenerated
[data-source list](docs/data-attribution.md). Keep proprietary transit data,
private credentials, and private emails out of source control.

## Comments and issue references

Do not reference issue or pull request numbers in source, config, comments,
docs, fixtures, or commit messages; they rot and the repo must stand alone.
State the reason or constraint directly. Keep comments to one brief line that
says why, matching the surrounding file. Issue links belong only in pull
request descriptions.

## Commits and pull requests

Run `bun format` before every commit. Use
[Conventional Commits](https://www.conventionalcommits.org/).
Preserve the existing SSH remotes and push URLs.

Before opening a pull request, pass formatting, lint, generated attribution,
the full unit suite, TypeScript compilation, and the production build using
the scripts in [package.json](package.json). Parser changes additionally require the [parity checks](#parser-parity).
