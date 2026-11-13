import { AsyncLocalStorage } from "node:async_hooks";
import { createInvocationBudget, type InvocationBudget } from "~/infrastructure/http/InvocationIo";
import type { D1DatabaseBinding, D1PreparedStatement } from "./RuntimeBindings";

/**
 * Most queries one HTTP request may issue against the transit database.
 * Request reads are set-based (json_each lookups behind an in-memory topology
 * cache): a cold departures request including schema bootstrap measured 17.
 */
export const REQUEST_QUERY_BUDGET = 100;

const requestBudget = new AsyncLocalStorage<InvocationBudget>();

/** Runs `fn` with a fresh per-request query budget visible to accounted bindings. */
export function runWithRequestQueryBudget<T>(
  fn: () => T,
  budget: InvocationBudget = createInvocationBudget(REQUEST_QUERY_BUDGET),
): T {
  return requestBudget.run(budget, fn);
}

/** Charges `count` queries, then runs them; exhaustion rejects like any query failure. */
function charged<T>(count: number, run: () => Promise<T>): Promise<T> {
  try {
    const budget = requestBudget.getStore();
    for (let index = 0; index < count; index += 1) budget?.consume();
  } catch (error) {
    return Promise.reject(error);
  }
  return run();
}

function countStatements(sql: string): number {
  return Math.max(1, sql.split(";").filter((statement) => statement.trim()).length);
}

// One wrapper per binding keeps identity-keyed schema bootstrap shared.
const accountedBindings = new WeakMap<D1DatabaseBinding, D1DatabaseBinding>();

/**
 * Charges every query to the active request's budget. Outside a request
 * (crons, seeding, topology refresh) queries are not charged.
 */
export function accountRequestQueries(binding: D1DatabaseBinding): D1DatabaseBinding {
  const existing = accountedBindings.get(binding);
  if (existing) return existing;
  const accounted = wrapBinding(binding);
  accountedBindings.set(binding, accounted);
  return accounted;
}

function wrapBinding(binding: D1DatabaseBinding): D1DatabaseBinding {
  const underlying = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement => {
    const accounted: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      first: (column) => charged(1, () => statement.first(column)),
      all: () => charged(1, () => statement.all()),
      run: () => charged(1, () => statement.run()),
    };
    underlying.set(accounted, statement);
    return accounted;
  };
  return {
    prepare: (query) => wrap(binding.prepare(query)),
    exec: (query) => charged(countStatements(query), () => binding.exec(query)),
    batch: (statements) =>
      charged(statements.length, () =>
        binding.batch(statements.map((statement) => underlying.get(statement) ?? statement)),
      ),
  };
}
