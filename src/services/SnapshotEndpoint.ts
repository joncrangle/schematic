import type { AgencySnapshot } from "~/agencies/types";
import {
  getCachedSnapshot,
  UnknownAgencyError,
  type SnapshotGetter,
} from "~/services/SnapshotClient";
import {
  endpointErrorMessage,
  headFromGet,
  isKnownAgency,
  noStoreJson,
  parseAgencyIdParam,
} from "~/services/apiEndpoint";
import { getAgencyById } from "~/agencies";
import { normalizeLocale, findSupportedLocale, type UiLocale } from "~/domain/locale";

/**
 * Stable agency-wide snapshot HTTP composition.
 *
 * Serves the `AgencySnapshot` JSON produced by the snapshot service through
 * `GET /api/snapshot/:agencyId` (plus HEAD with identical status/headers and
 * no body). Provider lookup and agency identity stay at this boundary; the
 * generic cache seam never names an agency.
 *
 * Successful responses carry a split browser/edge cache policy. Browsers
 * always revalidate (`max-age=0`). The edge stays fresh 15 seconds, serves
 * stale up to 15 seconds while revalidating, and serves stale up to 60
 * seconds on origin error. `s-maxage` would switch off both stale windows
 * (RFC 9111), so the edge half rides `cloudflare-cdn-cache-control`.
 * Errors (400/404/503) stay `no-store` and are never negatively cached.
 * No `X-Schematic-*` diagnostics. Frozen into an edge entry they would
 * contradict `CF-Cache-Status` on every later HIT.
 */

/** Browsers always revalidate; the edge owns freshness. */
export const SNAPSHOT_BROWSER_CACHE = "public, max-age=0";

/** Edge policy: 15s fresh / 15s stale-while-revalidate / 60s stale-if-error. */
export const SNAPSHOT_EDGE_CACHE =
  "public, max-age=15, stale-while-revalidate=15, stale-if-error=60";

/**
 * Core GET logic returning a Response. Unknown agencies are explicit 404s and
 * are never negatively cached; malformed ids are 400; cold refresh failures
 * are 503. All three errors are `no-store`. Successful 200 responses carry
 * the split browser/edge cache policy.
 */
export async function handleSnapshotGet(
  agencyIdRaw: unknown,
  getSnapshot?: SnapshotGetter,
  localeRaw?: unknown,
): Promise<Response> {
  let agencyId: string;
  try {
    agencyId = parseAgencyIdParam(agencyIdRaw);
  } catch (error) {
    return noStoreJson(400, { error: endpointErrorMessage(error, "Missing or invalid agencyId") });
  }

  if (!isKnownAgency(agencyId) && !getSnapshot) {
    return noStoreJson(404, { error: `Unknown agency "${agencyId}"` });
  }

  let locale: UiLocale;
  try {
    locale = parseSnapshotLocale(localeRaw, getAgencyById(agencyId)?.manifest.locale);
  } catch (error) {
    return noStoreJson(400, { error: endpointErrorMessage(error, "Missing or invalid locale") });
  }

  try {
    const result = await getCachedSnapshot(agencyId, getSnapshot, locale);
    const body: AgencySnapshot = result.value;
    return Response.json(body, {
      status: 200,
      headers: {
        "Cache-Control": SNAPSHOT_BROWSER_CACHE,
        "cloudflare-cdn-cache-control": SNAPSHOT_EDGE_CACHE,
        "Content-Language": locale,
      },
    });
  } catch (error) {
    if (error instanceof UnknownAgencyError) {
      return noStoreJson(404, { error: error.message });
    }
    return noStoreJson(503, { error: endpointErrorMessage(error, "Snapshot unavailable") });
  }
}

/** HEAD mirrors GET status/headers with no response body. */
export async function handleSnapshotHead(
  agencyIdRaw: unknown,
  getSnapshot?: SnapshotGetter,
  localeRaw?: unknown,
): Promise<Response> {
  return headFromGet(await handleSnapshotGet(agencyIdRaw, getSnapshot, localeRaw));
}

function parseSnapshotLocale(raw: unknown, agencyLocale?: string): UiLocale {
  const fallback = normalizeLocale(agencyLocale);
  if (raw === undefined) return fallback;
  if (typeof raw !== "string" || raw.trim().length === 0) {
    throw new Error("Missing or invalid locale");
  }

  const resolved = findSupportedLocale(raw);
  if (!resolved) throw new Error("Unsupported locale");
  return resolved;
}
