import * as Schema from "effect/Schema";
import type { AgencySnapshot } from "~/agencies/types";
import { AgencySnapshotSchema } from "~/agencies/types";
import {
  createSnapshotCache,
  type SnapshotCache,
  type SnapshotCacheResult,
} from "~/infrastructure/realtime/snapshotCache";

import { getAgencyById } from "~/agencies";
import { createServerAgencyRuntime } from "~/services/AgencyRuntimeServer";
import { DEFAULT_UI_LOCALE, resolveContentLocale, type UiLocale } from "~/domain/locale";

export type SnapshotGetter = (locale: UiLocale) => Promise<AgencySnapshot>;

export class UnknownAgencyError extends Error {
  readonly agencyId: string;
  constructor(agencyId: string) {
    super(`Unknown agency "${agencyId}"`);
    this.name = "UnknownAgencyError";
    this.agencyId = agencyId;
  }
}

function validateSnapshot(snapshot: AgencySnapshot): AgencySnapshot {
  return Schema.decodeUnknownSync(AgencySnapshotSchema)(snapshot) as AgencySnapshot;
}

function providerSnapshotGetter(agencyId: string): SnapshotGetter {
  return async (locale) => {
    const provider = getAgencyById(agencyId);
    if (!provider) throw new UnknownAgencyError(agencyId);
    const snapshot = await createServerAgencyRuntime(provider, {
      locale,
    }).getSnapshot();
    return snapshot;
  };
}

// ---------------------------------------------------------------------------
// Per-agency snapshot port access. The cache stores only validated
// typed snapshot values plus receipt metadata; provider lookup stays at this
// composition boundary so the generic cache seam never names an agency.
// ---------------------------------------------------------------------------

// Module-level per-agency portable cache, process-local in-memory by default.
// Restarts empty it; replicas hold independent entries. No Redis/Valkey.
// ---------------------------------------------------------------------------

const cachesByAgencyLocale = new Map<string, SnapshotCache<AgencySnapshot>>();
const contextGettersByAgencyLocale = new Map<string, SnapshotGetter>();

function snapshotCacheKey(agencyId: string, locale: UiLocale): string {
  return `${agencyId}\u0000${locale}`;
}

function getSnapshotCache(agencyId: string, locale: UiLocale): SnapshotCache<AgencySnapshot> {
  const key = snapshotCacheKey(agencyId, locale);
  let cache = cachesByAgencyLocale.get(key);
  if (!cache) {
    cache = createSnapshotCache<AgencySnapshot>({
      label: `SnapshotClient:${agencyId}:${locale}`,
      refresh: async () => {
        const injected = contextGettersByAgencyLocale.get(key);
        return injected
          ? validateSnapshot(await injected(locale))
          : providerSnapshotGetter(agencyId)(locale);
      },
    });
    cachesByAgencyLocale.set(key, cache);
  }
  return cache;
}

/** Test-only reset: empty every per-agency entry (restarts do this in prod). */
export function resetSnapshotCachesForTests(): void {
  cachesByAgencyLocale.clear();
  contextGettersByAgencyLocale.clear();
}

/**
 * Shared typed snapshot service with cache metadata.
 *
 * Cold miss awaits one single-flight refresh and rejects on failure (never a
 * fabricated empty all-clear). Warm expiry joins one refresh so successful
 * callers receive the newly generated snapshot; a failed warm refresh retains
 * the cached value within the bounded stale-on-error grace period.
 */
export async function getCachedSnapshot(
  agencyId: string,
  getSnapshot?: SnapshotGetter,
  requestedLocale?: unknown,
): Promise<SnapshotCacheResult<AgencySnapshot>> {
  const agencyLocale = getAgencyById(agencyId)?.manifest.locale ?? DEFAULT_UI_LOCALE;
  const locale = resolveContentLocale(requestedLocale, agencyLocale);
  const key = snapshotCacheKey(agencyId, locale);
  if (getSnapshot) {
    contextGettersByAgencyLocale.set(key, getSnapshot);
  }
  return getSnapshotCache(agencyId, locale).get();
}
