import { DEFAULT_UI_LOCALE } from "./locale";
import type { AlertKind, AgencyAlert } from "~/agencies/types";
import type { Severity } from "~/domain/severity";
import type { FavouriteLineRef } from "~/domain/preferences/UserPreferences";
import { PLACEHOLDER_ALERT_TITLE } from "./alerts/placeholderTitle";
import { lineColorFor } from "./lineColors";

/** The only schematic slice alert presentation reads: line names and colours. */
interface LightLines {
  readonly lines: readonly { readonly id: string; readonly name: string; readonly color: string }[];
}

export interface ServiceAlert {
  id: string;
  lineId?: string;
  scope: "line" | "station" | "systemwide";
  lineName: string;
  lineColor?: string;
  title: string;
  description: string;
  severity: Severity;
  kind: AlertKind;
  updatedAt: number;
  updatedAtLabel: string;
}

export type AlertBucket = "delays" | "rsz" | "accessibility";

export function bucketForKind(kind: AlertKind): AlertBucket {
  if (kind === "accessibility") return "accessibility";
  if (kind === "slow-service") return "rsz";
  return "delays";
}

export interface UpcomingClosure {
  id: string;
  lineId?: string;
  lineName: string;
  lineColor?: string;
  dateRange: string;
  startsAt?: number;
  endsAt?: number;
  title: string;
  segment: string;
  reason?: string;
}

export function formatUpcomingDateRange(
  startsAt?: number,
  endsAt?: number,
  presentation: ServiceAlertPresentation = {},
): string {
  if (!startsAt || startsAt <= 0)
    return presentation.plannedServiceAdjustment ?? "Planned Service Adjustment";
  const formatDate =
    presentation.formatDate ??
    ((value: Date | number, options?: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(presentation.locale ?? DEFAULT_UI_LOCALE, options).format(value));
  const formatTime = presentation.formatTime ?? formatDate;
  const startDate = new Date(startsAt);
  const timeOptions = { hour: "numeric", minute: "2-digit" } as const;
  const dateOptions = { month: "short", day: "numeric" } as const;
  const start = `${formatDate(startDate, dateOptions)}, ${formatTime(startDate, timeOptions)}`;
  if (!endsAt || endsAt <= 0) return presentation.starts?.(start) ?? `Starts ${start}`;
  const endDate = new Date(endsAt);
  const end = `${formatDate(endDate, dateOptions)}, ${formatTime(endDate, timeOptions)}`;
  return startDate.toDateString() === endDate.toDateString()
    ? `${start} – ${formatTime(endDate, timeOptions)}`
    : `${start} – ${end}`;
}

export interface ServiceAlertPresentation {
  readonly locale?: string;
  readonly formatDate?: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly formatTime?: (value: Date | number, options?: Intl.DateTimeFormatOptions) => string;
  readonly line?: (lineId: string) => string;
  readonly accessibility?: string;
  readonly systemwide?: string;
  readonly affectedStops?: string;
  readonly stopClosure?: string;
  readonly serviceAlert?: string;
  readonly plannedWork?: string;
  readonly plannedServiceAdjustment?: string;
  readonly network?: string;
  readonly segment?: (from: string, to: string) => string;
  readonly starts?: (formattedStart: string) => string;
}

export function compareByFavouriteLine(
  favourites: readonly FavouriteLineRef[],
  agencyId: string,
): (a: { lineId?: string }, b: { lineId?: string }) => number {
  const favouriteSet = new Set(
    favourites.filter((ref) => ref.agencyId === agencyId).map((ref) => ref.lineId),
  );
  return (a, b) =>
    Number(b.lineId !== undefined && favouriteSet.has(b.lineId)) -
    Number(a.lineId !== undefined && favouriteSet.has(a.lineId));
}

function lineIdForAlert(alert: AgencyAlert): string | undefined {
  // Equipment outages are station-scoped even when the operator includes a
  // comma-separated list of every connecting route. That list is coverage
  // metadata, not a genuine line attribution for the alert heading.
  if (alert.kind === "accessibility") return undefined;
  return alert.affectedLineIds?.[0] ?? alert.affectedRouteIds?.[0];
}

function isSubwayScopedAlert(alert: AgencyAlert): boolean {
  return (alert.affectedLineIds?.length ?? 0) > 0 || (alert.affectedRouteIds?.length ?? 0) === 0;
}

function cleanAlertTitle(title: string | undefined): string {
  return (title || "")
    .trim()
    .replace(/^[\s\-–—:]+/, "")
    .trim();
}

function uniqueAlerts(
  alerts: readonly AgencyAlert[],
  signatureFor: (alert: AgencyAlert) => string,
): readonly AgencyAlert[] {
  const seenIds = new Set<string>();
  const seenSignatures = new Set<string>();
  return alerts.filter((alert) => {
    const signature = signatureFor(alert);
    if (seenIds.has(alert.id) || seenSignatures.has(signature)) return false;
    seenIds.add(alert.id);
    seenSignatures.add(signature);
    return true;
  });
}

const lineDetails = (
  lineId: string | undefined,
  schematic: LightLines | undefined,
  fallbackName: string,
) => {
  const line = lineId ? schematic?.lines.find((candidate) => candidate.id === lineId) : undefined;
  return {
    lineName: line?.name ?? fallbackName,
    lineColor: line?.color ?? (lineId ? lineColorFor(lineId, schematic?.lines) : undefined),
  };
};

export function toServiceAlerts(
  alerts: readonly AgencyAlert[],
  schematic?: LightLines,
  presentation: ServiceAlertPresentation = {},
): ServiceAlert[] {
  const activeAlerts = alerts.filter(
    (alert) =>
      alert.lifecycle === "active" &&
      alert.kind !== "upcoming" &&
      (alert.kind !== "slow-service" || isSubwayScopedAlert(alert)),
  );
  return uniqueAlerts(activeAlerts, (alert) => {
    const lineId = lineIdForAlert(alert);
    const title = cleanAlertTitle(alert.title);
    const description = (alert.description || alert.title || "").trim();
    const stationKey = (station: AgencyAlert["fromStation"]) =>
      station?.stationId ?? station?.stationName ?? "";
    return JSON.stringify([
      lineId,
      alert.kind,
      alert.severity,
      title.toLowerCase(),
      description.toLowerCase(),
      alert.scope,
      [...(alert.affectedLineIds ?? [])].sort(),
      [...(alert.affectedRouteIds ?? [])].sort(),
      (alert.affectedStations ?? []).map(stationKey).sort(),
      (alert.targets ?? [])
        .map((target) => `${target.routeId ?? ""}:${stationKey(target.station)}`)
        .sort(),
      stationKey(alert.fromStation),
      stationKey(alert.toStation),
      alert.startsAt,
      alert.endsAt,
      alert.activePeriods,
      alert.impactPeriods,
    ]);
  }).map((alert) => {
    const lineId = lineIdForAlert(alert);
    const placeholder =
      cleanAlertTitle(alert.title).toLowerCase() === PLACEHOLDER_ALERT_TITLE.toLowerCase();
    const title = placeholder
      ? alert.scope === "station" && alert.kind === "suspension"
        ? (presentation.stopClosure ?? "Stop closure")
        : (presentation.serviceAlert ?? "Service alert")
      : cleanAlertTitle(alert.title);
    const description =
      (alert.description || (placeholder ? "" : alert.title) || "").trim() ||
      (alert.scope === "station"
        ? (alert.affectedStations ?? []).map((station) => station.stationName).join(", ")
        : "");
    return {
      id: alert.id,
      lineId,
      scope: lineId ? "line" : alert.scope === "station" ? "station" : "systemwide",
      ...lineDetails(
        lineId,
        schematic,
        alert.affectedLineIds?.length
          ? (presentation.line?.(lineId!) ?? lineId!)
          : alert.kind === "accessibility"
            ? (presentation.accessibility ?? "Accessibility")
            : alert.affectedRouteIds?.length
              ? lineId!
              : alert.scope === "station"
                ? (presentation.affectedStops ?? "Affected stops")
                : (presentation.systemwide ?? "Systemwide"),
      ),
      title,
      description,
      severity: alert.severity,
      kind: alert.kind,
      updatedAt: alert.updatedAt,
      updatedAtLabel: (
        presentation.formatTime ??
        ((value, options) =>
          new Intl.DateTimeFormat(presentation.locale ?? DEFAULT_UI_LOCALE, options).format(value))
      )(alert.updatedAt, {
        hour: "2-digit",
        minute: "2-digit",
      }),
    };
  });
}

export function toUpcomingClosures(
  alerts: readonly AgencyAlert[],
  schematic?: LightLines,
  presentation: ServiceAlertPresentation = {},
): UpcomingClosure[] {
  const upcomingAlerts = alerts.filter(
    (alert) =>
      alert.lifecycle !== "expired" &&
      (alert.lifecycle === "upcoming" || alert.kind === "upcoming") &&
      isSubwayScopedAlert(alert),
  );
  return uniqueAlerts(upcomingAlerts, (alert) => {
    const lineId = lineIdForAlert(alert);
    const from = alert.fromStation?.stationName;
    const to = alert.toStation?.stationName;
    const segment =
      from && to
        ? (presentation.segment?.(from, to) ?? `${from} to ${to}`)
        : (from ?? presentation.network ?? "Transit Network");
    const title = cleanAlertTitle(alert.title);
    const signature = `${lineId ?? ""}|${title.toLowerCase()}|${segment.toLowerCase()}|${alert.startsAt ?? 0}|${alert.endsAt ?? 0}`;
    return signature;
  })
    .map((alert) => {
      const lineId = lineIdForAlert(alert);
      const from = alert.fromStation?.stationName;
      const to = alert.toStation?.stationName;
      const segment =
        from && to
          ? (presentation.segment?.(from, to) ?? `${from} to ${to}`)
          : (from ?? presentation.network ?? "Transit Network");
      const title = cleanAlertTitle(alert.title);
      return {
        id: alert.id,
        lineId,
        ...lineDetails(
          lineId,
          schematic,
          lineId
            ? (presentation.line?.(lineId) ?? lineId)
            : (presentation.plannedWork ?? "Planned Work"),
        ),
        dateRange: formatUpcomingDateRange(alert.startsAt, alert.endsAt, presentation),
        startsAt: alert.startsAt,
        endsAt: alert.endsAt,
        title,
        segment,
        reason:
          alert.description && alert.description.trim().toLowerCase() !== title.toLowerCase()
            ? alert.description.trim()
            : undefined,
      };
    })
    .sort(
      (a, b) =>
        (a.startsAt && a.startsAt > 0 ? a.startsAt : Infinity) -
        (b.startsAt && b.startsAt > 0 ? b.startsAt : Infinity),
    );
}
