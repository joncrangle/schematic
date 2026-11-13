import type {
  AgencyAlert,
  AgencyStationReference,
  AgencyAlertTarget,
  EquipmentOutage,
} from "~/agencies/types";
import type { ServiceAlert, UpcomingClosure } from "~/domain/serviceAlerts";

function areArraysEqual<T>(
  prev: readonly T[],
  next: readonly T[],
  isEqual: (a: T, b: T) => boolean,
): boolean {
  if (prev === next) return true;
  if (prev.length !== next.length) return false;
  for (let i = 0; i < prev.length; i++) {
    if (!isEqual(prev[i], next[i])) return false;
  }
  return true;
}

function stringListEqual(a: readonly string[], b: readonly string[]): boolean {
  return areArraysEqual(a, b, (x, y) => x === y);
}

function stationRefEqual(
  a: AgencyStationReference | undefined,
  b: AgencyStationReference | undefined,
): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return (
    (a.stationId ?? undefined) === (b.stationId ?? undefined) && a.stationName === b.stationName
  );
}

function stationRefListEqual(
  a: readonly AgencyStationReference[],
  b: readonly AgencyStationReference[],
): boolean {
  return areArraysEqual(a, b, stationRefEqual);
}

function targetEqual(a: AgencyAlertTarget, b: AgencyAlertTarget): boolean {
  return (
    (a.routeId ?? undefined) === (b.routeId ?? undefined) && stationRefEqual(a.station, b.station)
  );
}

function targetListEqual(
  a: readonly AgencyAlertTarget[],
  b: readonly AgencyAlertTarget[],
): boolean {
  return areArraysEqual(a, b, targetEqual);
}

function outageEqual(a: EquipmentOutage, b: EquipmentOutage): boolean {
  return (
    a.id === b.id &&
    a.type === b.type &&
    a.equipment === b.equipment &&
    a.location === b.location &&
    a.rawText === b.rawText
  );
}

function outageListEqual(a: readonly EquipmentOutage[], b: readonly EquipmentOutage[]): boolean {
  return areArraysEqual(a, b, outageEqual);
}

/**
 * Rendered-relevance equality for one alert: every field that can reach the
 * UI except `updatedAt`. Decoders stamp `updatedAt` from the fetch clock when
 * the wire carries no timestamp (JSON `now`, RSS `publishedAt ?? now`,
 * GTFS-RT header time), so an `updatedAt`-only difference means the same
 * advisory was re-polled, not changed. Ignoring it keeps prior object
 * identity across refetches so Solid `<For>` (reference-diffed) preserves
 * accordion state; any real content change still breaks equality.
 */
export function isAgencyAlertContentEqual(a: AgencyAlert, b: AgencyAlert): boolean {
  if (a.id !== b.id) return false;
  if (a.title !== b.title) return false;
  if ((a.description ?? undefined) !== (b.description ?? undefined)) return false;
  if (a.kind !== b.kind) return false;
  if (a.severity !== b.severity) return false;
  if (a.lifecycle !== b.lifecycle) return false;
  if (a.scope !== b.scope) return false;
  if ((a.serviceChange ?? undefined) !== (b.serviceChange ?? undefined)) return false;
  if (a.startsAt !== b.startsAt) return false;
  if ((a.endsAt ?? undefined) !== (b.endsAt ?? undefined)) return false;
  if (!stringListEqual(a.affectedLineIds ?? [], b.affectedLineIds ?? [])) return false;
  if (!stringListEqual(a.affectedRouteIds ?? [], b.affectedRouteIds ?? [])) return false;
  if (!stationRefListEqual(a.affectedStations ?? [], b.affectedStations ?? [])) return false;
  if (!stationRefEqual(a.fromStation, b.fromStation)) return false;
  if (!stationRefEqual(a.toStation, b.toStation)) return false;
  if (!targetListEqual(a.targets ?? [], b.targets ?? [])) return false;
  if (!outageListEqual(a.equipmentOutages ?? [], b.equipmentOutages ?? [])) return false;
  return true;
}

export function areServiceAlertsEqual(
  prev: readonly ServiceAlert[],
  next: readonly ServiceAlert[],
): boolean {
  return areArraysEqual(
    prev,
    next,
    (a, b) =>
      a.id === b.id &&
      a.lineId === b.lineId &&
      a.scope === b.scope &&
      a.lineName === b.lineName &&
      a.lineColor === b.lineColor &&
      a.title === b.title &&
      a.description === b.description &&
      a.severity === b.severity &&
      a.kind === b.kind &&
      a.updatedAt === b.updatedAt &&
      a.updatedAtLabel === b.updatedAtLabel,
  );
}

export function areUpcomingClosuresEqual(
  prev: readonly UpcomingClosure[],
  next: readonly UpcomingClosure[],
): boolean {
  return areArraysEqual(
    prev,
    next,
    (a, b) =>
      a.id === b.id &&
      a.lineId === b.lineId &&
      a.lineName === b.lineName &&
      a.lineColor === b.lineColor &&
      a.dateRange === b.dateRange &&
      a.startsAt === b.startsAt &&
      a.endsAt === b.endsAt &&
      a.title === b.title &&
      a.segment === b.segment &&
      a.reason === b.reason,
  );
}

export function areAgencyAlertsEqual(
  prev: readonly AgencyAlert[],
  next: readonly AgencyAlert[],
): boolean {
  return areArraysEqual(prev, next, isAgencyAlertContentEqual);
}
