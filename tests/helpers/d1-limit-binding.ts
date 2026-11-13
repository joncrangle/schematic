import type { D1DatabaseBinding, D1PreparedStatement } from "~/infrastructure/storage/RuntimeBindings";

export const D1_MAX_BOUND_PARAMETERS = 100;

/** Adds Cloudflare D1's per-query binding limit to a real SQL test binding. */
export function withD1ParameterLimit(db: D1DatabaseBinding): {
  readonly db: D1DatabaseBinding;
  readonly getMaxBoundCount: () => number;
} {
  let maxBoundCount = 0;
  const limited: D1DatabaseBinding = {
    prepare: (query) => {
      const inner = db.prepare(query);
      const statement: D1PreparedStatement = {
        bind: (...values) => {
          maxBoundCount = Math.max(maxBoundCount, values.length);
          if (values.length > D1_MAX_BOUND_PARAMETERS) {
            throw new Error(
              `D1 query bound ${values.length} parameters; limit is ${D1_MAX_BOUND_PARAMETERS}`,
            );
          }
          return inner.bind(...values);
        },
        first: (column) => inner.first(column),
        run: () => inner.run(),
        all: () => inner.all(),
      };
      return statement;
    },
    exec: (query) => db.exec(query),
    batch: (statements) => db.batch(statements),
  };
  return { db: limited, getMaxBoundCount: () => maxBoundCount };
}
