import type { D1DatabaseBinding } from "~/infrastructure/storage/RuntimeBindings";

/**
 * Completes a partial D1DatabaseBinding fake with the member tests don't
 * exercise. Fakes then only spell out the behavior actually under test, and
 * future interface additions default here instead of at every call site.
 */
export function withNoopBatch(binding: Omit<D1DatabaseBinding, "batch">): D1DatabaseBinding {
  return { ...binding, batch: async () => ({}) };
}
