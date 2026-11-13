import { createMemo, createSignal, onCleanup, untrack } from "solid-js";
import { loadSchematic, peekSchematic } from "~/services/schematic/SchematicLoader";
import type { Schematic } from "~/agencies/types";

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * Reactive handle on one agency's lazily loaded schematic. The accessor is
 * undefined until the chunk resolves, then stays populated from the shared
 * cache (switching back to a loaded agency never flickers). The import starts
 * during component setup, before effects run, and again whenever the id
 * changes. A failed import (flaky network, a deploy that rotated chunk
 * hashes) retries with capped backoff so the map never stays blank.
 */
export function useAgencySchematic(
  agencyId: () => string | undefined,
): () => Schematic | undefined {
  const [loadedVersion, setLoadedVersion] = createSignal(0);
  const requested = new Set<string>();
  const attempts = new Map<string, number>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  onCleanup(() => clearTimeout(retryTimer));
  const request = (id: string | undefined) => {
    if (!id || requested.has(id) || peekSchematic(id)) return;
    requested.add(id);
    loadSchematic(id).then(
      () => setLoadedVersion((version) => version + 1),
      (error: unknown) => {
        const attempt = (attempts.get(id) ?? 0) + 1;
        attempts.set(id, attempt);
        console.warn(`Schematic for "${id}" failed to load`, error);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(
          () => {
            requested.delete(id);
            setLoadedVersion((version) => version + 1);
          },
          Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS),
        );
      },
    );
  };
  request(untrack(agencyId));
  // Requesting from the derivation is idempotent (loads are cached and
  // de-duplicated) and keeps the repository's no-createEffect rule.
  return createMemo(() => {
    loadedVersion();
    const id = agencyId();
    request(id);
    return id ? peekSchematic(id) : undefined;
  });
}
