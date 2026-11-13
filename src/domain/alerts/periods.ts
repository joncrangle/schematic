/** A half-open alert time window. Missing bounds mean unbounded time. */
export interface AlertPeriod {
  readonly startsAt?: number;
  readonly endsAt?: number;
}

/**
 * Applies GTFS-RT migration semantics: communication time controls alert
 * visibility, impact time is retained separately, and active_period is only a
 * fallback when neither newer field supplies a range.
 */
export function foldGtfsAlertPeriods(input: {
  readonly active: readonly AlertPeriod[];
  readonly communication: readonly AlertPeriod[];
  readonly impact: readonly AlertPeriod[];
}): { readonly activePeriods: AlertPeriod[]; readonly impactPeriods: AlertPeriod[] } {
  const active = foldAlertPeriods(input.active);
  const communication = foldAlertPeriods(input.communication);
  const impactPeriods = foldAlertPeriods(input.impact);
  return {
    activePeriods:
      communication.length > 0 ? communication : impactPeriods.length > 0 ? [] : active,
    impactPeriods,
  };
}

/**
 * Combines overlapping or adjacent windows while preserving every real gap.
 * GTFS-RT alerts may be active in several separate windows.
 */
export function foldAlertPeriods(periods: readonly AlertPeriod[]): AlertPeriod[] {
  const ordered = periods
    .filter(
      ({ startsAt, endsAt }) =>
        (startsAt === undefined || (Number.isFinite(startsAt) && startsAt >= 0)) &&
        (endsAt === undefined || (Number.isFinite(endsAt) && endsAt >= 0)) &&
        (startsAt === undefined || endsAt === undefined || endsAt > startsAt),
    )
    .map((period) => ({ ...period }))
    .sort((first, second) => (first.startsAt ?? -Infinity) - (second.startsAt ?? -Infinity));

  const folded: AlertPeriod[] = [];
  for (const next of ordered) {
    const current = folded.at(-1);
    if (
      !current ||
      (current.endsAt !== undefined &&
        next.startsAt !== undefined &&
        next.startsAt > current.endsAt)
    ) {
      folded.push(next);
      continue;
    }
    folded[folded.length - 1] = {
      startsAt: current.startsAt,
      endsAt:
        current.endsAt === undefined || next.endsAt === undefined
          ? undefined
          : Math.max(current.endsAt, next.endsAt),
    };
  }
  return folded;
}

/** Builds the legacy bounding fields without discarding expired inferred ends. */
export function summarizeAlertPeriods(
  periods: readonly AlertPeriod[],
  fallbackStart: number,
): { readonly startsAt: number; readonly endsAt?: number } {
  if (periods.length === 0) return { startsAt: fallbackStart };

  const startsAt = Math.min(
    ...periods.map(
      ({ startsAt: start, endsAt: end }) =>
        start ?? (end === undefined ? fallbackStart : Math.min(fallbackStart, end)),
    ),
  );
  if (periods.some(({ endsAt }) => endsAt === undefined)) return { startsAt };
  return { startsAt, endsAt: Math.max(...periods.map(({ endsAt }) => endsAt!)) };
}

export function periodsForAlert(alert: {
  readonly startsAt: number;
  readonly endsAt?: number;
  readonly activePeriods?: readonly AlertPeriod[];
}): readonly AlertPeriod[] {
  return alert.activePeriods?.length
    ? alert.activePeriods
    : [{ startsAt: alert.startsAt, endsAt: alert.endsAt }];
}

/**
 * Disjoint bounded windows are separate advisories even when their text and
 * location match. Open-ended windows can merge, while the folded ranges retain
 * any gap before that open window.
 */
export function alertWindowsCanMerge(
  first: {
    readonly startsAt: number;
    readonly endsAt?: number;
    readonly activePeriods?: readonly AlertPeriod[];
  },
  second: {
    readonly startsAt: number;
    readonly endsAt?: number;
    readonly activePeriods?: readonly AlertPeriod[];
  },
): boolean {
  const firstPeriods = periodsForAlert(first);
  const secondPeriods = periodsForAlert(second);
  if (
    firstPeriods.some(({ endsAt }) => endsAt === undefined) ||
    secondPeriods.some(({ endsAt }) => endsAt === undefined)
  ) {
    return true;
  }
  return firstPeriods.some((left) =>
    secondPeriods.some(
      (right) =>
        (left.endsAt === undefined ||
          right.startsAt === undefined ||
          right.startsAt <= left.endsAt) &&
        (right.endsAt === undefined ||
          left.startsAt === undefined ||
          left.startsAt <= right.endsAt),
    ),
  );
}

/** Returns the exact union after a merge, keeping disjoint gaps visible. */
export function mergeAlertPeriods(
  first: {
    readonly startsAt: number;
    readonly endsAt?: number;
    readonly activePeriods?: readonly AlertPeriod[];
  },
  second: {
    readonly startsAt: number;
    readonly endsAt?: number;
    readonly activePeriods?: readonly AlertPeriod[];
  },
): AlertPeriod[] {
  return foldAlertPeriods([...periodsForAlert(first), ...periodsForAlert(second)]);
}

/** Stable signature for period equality checks in interpretation. */
export function alertPeriodsSignature(periods: readonly AlertPeriod[]): string {
  return foldAlertPeriods(periods)
    .map(({ startsAt, endsAt }) => `${startsAt ?? "-inf"}:${endsAt ?? "+inf"}`)
    .join(",");
}
