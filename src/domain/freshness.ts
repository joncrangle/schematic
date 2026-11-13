import type { FreshnessState } from "~/agencies/types";

export interface FreshnessInfo {
  readonly state: FreshnessState;
  readonly ageSeconds: number;
  readonly formattedText: string;
  readonly shortText: string;
}

export interface FreshnessPresentation {
  readonly justNow?: string;
  readonly updated?: (age: number, unit: "minute" | "second") => string;
  readonly shortJustNow?: string;
  readonly shortUpdated?: (age: number, unit: "minute" | "second") => string;
}

const AGE_RANK: Record<"live" | "recent" | "stale", number> = {
  live: 0,
  recent: 1,
  stale: 2,
};

/**
 * Shared freshness ladder: ≤60s live, <180s recent, then
 * stale. `unavailable` outranks everything.
 */
export function calculateFreshness(
  now: number,
  fetchedAt?: number,
  isStale = false,
  presentation: FreshnessPresentation = {},
): FreshnessInfo {
  const justNow = presentation.justNow ?? "Updated just now";
  const updated =
    presentation.updated ??
    ((age: number, unit: "minute" | "second") =>
      `Updated ${age}${unit === "minute" ? "m" : "s"} ago`);
  const shortJustNow = presentation.shortJustNow ?? "just now";
  const shortUpdated =
    presentation.shortUpdated ??
    ((age: number, unit: "minute" | "second") => `${age}${unit[0]} ago`);
  if (!fetchedAt) {
    return {
      state: "unavailable",
      ageSeconds: 0,
      formattedText: justNow,
      shortText: shortJustNow,
    };
  }

  const ageMs = Math.max(0, now - fetchedAt);
  const ageSeconds = Math.floor(ageMs / 1000);

  let state: Exclude<FreshnessState, "unavailable"> = "live";
  if (isStale || ageSeconds >= 180) {
    state = "stale";
  } else if (ageSeconds >= 60) {
    state = "recent";
  }

  let formattedText = justNow;
  let shortText = shortJustNow;
  if (ageSeconds >= 60) {
    const minutes = Math.floor(ageSeconds / 60);
    formattedText = updated(minutes, "minute");
    shortText = shortUpdated(minutes, "minute");
  } else if (ageSeconds >= 5) {
    formattedText = updated(ageSeconds, "second");
    shortText = shortUpdated(ageSeconds, "second");
  }

  return {
    state,
    ageSeconds,
    formattedText,
    shortText,
  };
}

/**
 * Merges two freshness signals into the more degraded one: client-side aging
 * may degrade a server-shipped state over time but never upgrades it.
 */
export function worseFreshness(a: FreshnessState, b: FreshnessState): FreshnessState {
  if (a === "unavailable" || b === "unavailable") return "unavailable";
  return AGE_RANK[a] >= AGE_RANK[b] ? a : b;
}
