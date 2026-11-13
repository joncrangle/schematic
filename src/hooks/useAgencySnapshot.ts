import { createMemo, type Accessor } from "solid-js";
import { useQuery } from "@tanstack/solid-query";
import * as Schema from "effect/Schema";
import type { AgencySnapshot } from "~/agencies/types";
import { AgencySnapshotSchema } from "~/agencies/types";
import { calculateFreshness, worseFreshness, type FreshnessInfo } from "~/domain/freshness";
import { DEFAULT_UI_LOCALE, type UiLocale } from "~/domain/locale";
import { useI18n } from "~/i18n/I18nContext";
import { queryClient } from "~/lib/queryClient";
import { useSettledQueryData } from "~/hooks/useSettledQueryData";
import { useAppClock } from "~/lib/appClock";

const TRANSIENT_FETCH_RETRY_DELAYS_MS = [100, 300] as const;

/**
 * Dev-server restarts can reject an in-flight RPC before an HTTP response
 * exists. Retry only that transport-level failure; HTTP/application failures
 * must still reach the query so the map reports stale evidence honestly.
 */
const fetchSnapshotRequest = async (input: RequestInfo | URL, init?: RequestInit) => {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await globalThis.fetch(input, init);
    } catch (error) {
      const delay = TRANSIENT_FETCH_RETRY_DELAYS_MS[attempt];
      if (delay === undefined || init?.signal?.aborted) throw error;
      await new Promise<void>((resolve) => setTimeout(resolve, delay));
    }
  }
};

/**
 * Stable snapshot fetch over the portable agency endpoint.
 *
 * Production path for the shell seam: the same `AgencySnapshot` JSON the
 * server function served, now reached through `GET /api/snapshot/:agencyId`
 * so a response cache can later sit in front of it. The shared typed
 * snapshot service (`~/services/SnapshotClient`) remains for internal
 * callers and tests. Non-2xx responses reject so the query surfaces real
 * errors; malformed payloads reject rather than rendering a fake all-clear.
 */
export async function fetchSnapshotViaHttp(
  agencyId: string,
  localeOrFetchFn:
    | UiLocale
    | ((input: RequestInfo | URL, init?: RequestInit) => Promise<Response>) = DEFAULT_UI_LOCALE,
  maybeFetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): Promise<AgencySnapshot> {
  const locale = typeof localeOrFetchFn === "string" ? localeOrFetchFn : DEFAULT_UI_LOCALE;
  const fetchFn =
    typeof localeOrFetchFn === "function"
      ? localeOrFetchFn
      : (maybeFetchFn ?? fetchSnapshotRequest);
  const response = await fetchFn(
    `/api/snapshot/${encodeURIComponent(agencyId)}?locale=${encodeURIComponent(locale)}`,
    {
      headers: { Accept: "application/json" },
    },
  );
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      `Snapshot request failed (${response.status})${detail ? `: ${detail.slice(0, 200)}` : ""}`,
    );
  }
  const json = (await response.json()) as unknown;
  return Schema.decodeUnknownSync(AgencySnapshotSchema)(json) as AgencySnapshot;
}

// A synchronous query seed keeps alerts from suspending the shell. It is not
// evidence of a successful fetch and must never produce a live all-clear.
const createInitialSnapshot = (): AgencySnapshot => ({
  agencyId: "",
  generatedAt: 0,
  freshness: "unavailable",
  alerts: [],
});

/**
 * Shell seam for the active agency's alert-centric snapshot (ADR-0007):
 * TanStack Query owns fetching/polling/caching; freshness merges client-side
 * aging with the server-shipped state (aging may degrade but never upgrade)
 * and a rejected poll forces STALE immediately.
 */
export function useAgencySnapshot(
  agencyId: Accessor<string | undefined> | string,
  pollIntervalMs = 30_000,
  maybeEnabled?: Accessor<boolean>,
  locale: Accessor<UiLocale> = () => DEFAULT_UI_LOCALE,
) {
  const getAgencyId = typeof agencyId === "function" ? agencyId : () => agencyId;
  const i18n = useI18n();

  // 1. Application-level clock, shared across every live label (1s cadence).
  const now = useAppClock();

  // 2. Failure semantics: a rejected poll propagates (no
  // catch-to-fake snapshot); placeholderData keeps the last good snapshot
  // aging naturally while the freshness memo forces STALE on query.error.
  const query = useQuery(
    () => {
      const id = getAgencyId();
      const currentLocale = locale();
      const enabled = Boolean(id) && (maybeEnabled?.() ?? true);
      const queryKey = ["snapshot", id, currentLocale] as const;
      return {
        queryKey,
        queryFn: () => fetchSnapshotViaHttp(id!, currentLocale, fetchSnapshotRequest),
        enabled,
        // Alerts are supporting evidence, not a hydration dependency. A
        // failed feed should wait for the next poll instead of immediately
        // issuing a second slow server-function request during startup.
        retry: false,
        staleTime: 0,
        refetchInterval: pollIntervalMs,
        initialData: createInitialSnapshot,
      };
    },
    () => queryClient,
  );

  // Solid Query's async data projection can retain the previous key's result
  // during a locale change. Read the synchronously settled entry for the
  // requested identity instead, so an old-language alert cannot leak into the
  // UI while its localized snapshot is still loading.
  const settledSnapshot = useSettledQueryData<AgencySnapshot>(() => {
    const id = getAgencyId();
    return id ? ["snapshot", id, locale()] : undefined;
  });
  const currentSnapshot = createMemo(() => {
    const id = getAgencyId();
    if (!id) return undefined;
    const snap = settledSnapshot();
    return snap?.agencyId === id ? snap : undefined;
  });

  const freshnessData = createMemo(() => {
    const snap = currentSnapshot();
    if (!snap)
      return {
        state: "unavailable" as const,
        formattedText: i18n.t("Unavailable"),
        shortText: i18n.t("Unavailable"),
        ageSeconds: 0,
      };
    // generatedAt is the local successful-receipt clock. sourceUpdatedAt is
    // retained for diagnostics and must not age a healthy quiet feed into
    // stale solely because the operator has not changed its payload.
    const aged = calculateFreshness(now(), snap.generatedAt, false, {
      justNow: i18n.t("Updated just now"),
      updated: (age, unit) =>
        i18n.t("Updated {{time}}", { time: i18n.formatRelativeTime(-age, unit) }),
      shortJustNow: i18n.t("just now"),
      shortUpdated: (age, unit) =>
        i18n.t(unit === "minute" ? "{{count}}m ago" : "{{count}}s ago", {
          count: i18n.formatNumber(age),
        }),
    });
    const state = worseFreshness(aged.state, snap.freshness);
    if (!query.error) return { ...aged, state };
    // A failed poll is never a fresh all-clear: force STALE immediately.
    return { ...aged, state: worseFreshness(state, "stale") };
  });

  // Age changes each second; status and labels do not always change with it.
  // Keep those subscriptions independent so a ticking label does not rerun
  // every map marker and service-button binding that only reads the status.
  const freshnessState = createMemo(() => freshnessData().state);
  const formattedText = createMemo(() => freshnessData().formattedText);
  const shortText = createMemo(() => freshnessData().shortText);
  const freshnessInfo: FreshnessInfo = {
    get state() {
      return freshnessState();
    },
    get formattedText() {
      return formattedText();
    },
    get shortText() {
      return shortText();
    },
    get ageSeconds() {
      return freshnessData().ageSeconds;
    },
  };
  const freshness = () => freshnessInfo;

  const refresh = () => {
    const id = getAgencyId();
    if (id) {
      const currentLocale = locale();
      queryClient.refetchQueries({
        queryKey: ["snapshot", id, currentLocale],
      });
    }
  };

  return {
    snapshot: currentSnapshot,
    freshness,
    isLoading: () => query.isLoading,
    error: () => (query.error ? String(query.error) : null),
    refresh,
  };
}
