import type { AgencyAlert } from "~/agencies/types";

const normalized = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();

const routeKey = (alert: AgencyAlert) => [...(alert.affectedRouteIds ?? [])].sort().join("|");
const locationKeys = (text: string) =>
  new Set(
    [
      ...text.matchAll(
        /\b(?:near|back to|from|at|to|of)\s+(?:the\s+)?([A-Z][A-Za-z0-9'-]+(?:\s+[A-Z][A-Za-z0-9'-]+){0,2})/gu,
      ),
    ]
      .map((match) =>
        normalized(match[1]!)
          .replace(/\bhighschool\b/gu, "high school")
          .replace(/\b(?:transit|hub|stop|terminal|field)\b/gu, " ")
          .replace(/\s+/gu, " ")
          .trim(),
      )
      .filter(Boolean),
  );

/** Match explicit paired notices by route, impact window, cause and publication chronology. */
export function reconcilePublishedRestorations(
  alerts: readonly AgencyAlert[],
  now: number,
): readonly AgencyAlert[] {
  return alerts.map((alert) => {
    const alertRoutes = alert.affectedRouteIds;
    const relocationText = `${alert.title} ${alert.description ?? ""}`;
    const isRelocation =
      /\b(?:relocat\w*|temporary (?:stop|hub)|alternate (?:stop|terminal)|temporarily stopping)\b/iu.test(
        relocationText,
      );
    if (!alertRoutes?.length || (alert.kind !== "suspension" && !isRelocation)) return alert;
    const restoration = alerts
      .filter((candidate) => {
        const explicitHubRestore =
          isRelocation &&
          /\b(?:moved back|move back|returned to|back to|resumed at)\b/iu.test(
            `${candidate.title} ${candidate.description ?? ""}`,
          );
        if (explicitHubRestore && alert.endsAt === undefined) {
          const oldPlaces = locationKeys(`${alert.title} ${alert.description ?? ""}`);
          const newPlaces = locationKeys(`${candidate.title} ${candidate.description ?? ""}`);
          if (
            candidate.updatedAt > alert.updatedAt &&
            candidate.updatedAt <= now &&
            [...oldPlaces].some((place) => newPlaces.has(place)) &&
            alertRoutes.every((routeId) => candidate.affectedRouteIds?.includes(routeId)) &&
            normalized(
              candidate.affectedStations?.map((station) => station.stationName).join(" ") ?? "",
            ) ===
              normalized(
                alert.affectedStations?.map((station) => station.stationName).join(" ") ?? "",
              )
          )
            return true;
        }
        if (!/^(.+?)\s+cancellation\s*[|:]/iu.test(alert.title)) return false;
        const cancelled = /^(.+?)\s+cancellation\s*[|:]/iu.exec(alert.title);
        if (!cancelled) return false;
        const restored = /^(.+?)\s+operational\s*[|:]/iu.exec(candidate.title);
        const reason = /\b(?:as|because)\s+(?:the\s+)?(.+?)\s+(?:have|has) been resolved\b/iu.exec(
          candidate.description ?? "",
        )?.[1];
        if (
          candidate.severity !== "normal" ||
          !restored ||
          !reason ||
          normalized(restored[1]) !== normalized(cancelled[1])
        )
          return false;
        if (!normalized(alert.description ?? "").includes(`due to ${normalized(reason)}`))
          return false;
        if (candidate.updatedAt <= alert.updatedAt || candidate.updatedAt > now) return false;
        if (candidate.startsAt !== alert.startsAt || candidate.endsAt !== alert.endsAt)
          return false;
        return routeKey(candidate) === routeKey(alert);
      })
      .sort((a, b) => a.updatedAt - b.updatedAt)[0];
    if (!restoration) return alert;
    const endsAt = Math.min(alert.endsAt ?? Infinity, restoration.updatedAt);
    const clip = (periods: AgencyAlert["activePeriods"]) =>
      periods
        ?.map((p) => ({ ...p, endsAt: Math.min(p.endsAt ?? Infinity, endsAt) }))
        .filter((p) => p.startsAt === undefined || p.endsAt > p.startsAt);
    return {
      ...alert,
      endsAt,
      activePeriods: clip(alert.activePeriods),
      impactPeriods: clip(alert.impactPeriods),
      lifecycle: now >= endsAt ? "expired" : alert.lifecycle,
    };
  });
}
