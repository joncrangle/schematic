# Solid debugging

Read this when changing reactive queries, component initialization, or the Solid
dependency graph. [package.json](../../package.json), the lockfile, and installed
package source determine the versions in this checkout.

## Pending queries and cached cards

The TanStack Solid adapter's `data` projection can suspend during a refresh even
when settled cache exists. Reading every query's async projection in one memo
can hold the entire Nearby transition while one request is pending.

[useSettledQueryData](../../src/hooks/useSettledQueryData.ts) subscribes to cache
settlement events and reads the exact requested cache identity. Receipt timestamps
alone cannot detect two updates in the same millisecond. [useStableQuery](../../src/hooks/useStableQuery.ts)
uses this seam, and [useNearbyQueries](../../src/hooks/useNearbyQueries.ts)
keeps result groups independent. The panel owns loading/error presentation.
Preserve disabled-query gating, stable card identities, and cached reopening.
Use the [panel regressions](../../tests/unit/nearby-stations-panel.dom.test.tsx)
and [query suite](../../tests/unit/use-nearby-queries.dom.test.tsx) before changing
this boundary. A pending request must not hide available results from another.

## Writes during initialization

`REACTIVE_WRITE_IN_OWNED_SCOPE` is raised when code, such as a test helper,
mutates preferences synchronously in a component body. Seed through injected
storage or an event after rendering. The canonical panel test uses a microtask.

Moving that write to `onSettled` still fails because `setPreference` calls
`flush()`, which would be re-entrant during settlement. Follow the full call
chain before selecting a lifecycle phase. Keep application state changes in
event handlers or derived state; external side effects are the reason to use
`createEffect`.

`[birpc] function "toJSON" not found` errors after that failure are secondary
to the halted reactive runtime. Inspect the first owned-scope error
before debugging the test runner's later noise.

## Dependency changes

Compare both direct versions and the resolved graph in the lockfile. A direct
Solid version can stay fixed while signals or compiler dependencies change.
Reduce a failing case before changing packages one at a time.

Run the existing format, lint, typecheck, unit-test, agency, and build checks
from [package.json](../../package.json). Include `bun run build` locally: a
dependency mismatch between TanStack packages can pass tests and still fail the
build when one package imports an export another has removed.
