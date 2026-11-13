import { allProviders, getActiveAgency, getAgencyById } from "~/agencies";
import type { AgencyAlert, AgencySnapshot } from "~/agencies/types";
import { resolveAgencyStationReference } from "~/domain/stationAlerts";
import { getVapidConfig } from "~/infrastructure/env/ServerEnv";
import { logger } from "~/infrastructure/logging/logger";
import { createServerAgencyRuntime } from "~/services/AgencyRuntimeServer";
import { agencyTaskRunner } from "~/services/AgencyTaskRunner";
import type { EvaluationSummary } from "./AlertEvaluatorService";

/** Development-only alert simulation inputs. */
export interface SpoofAlertOverrides {
  readonly severity?: "normal" | "degraded" | "severe";
  readonly kind?:
    | "delay"
    | "slow-service"
    | "suspension"
    | "accessibility"
    | "upcoming"
    | "information";
  readonly lineId?: string;
  readonly stations?: readonly string[];
  readonly routeIds?: readonly string[];
  readonly title?: string;
  readonly description?: string;
}

/** Fabricate a fresh, fully specified snapshot for the development simulator. */
export function buildSpoofSnapshot(
  agencyId: string,
  now = Date.now(),
  overrides: SpoofAlertOverrides = {},
): AgencySnapshot {
  const severity = overrides.severity ?? "severe";
  const kind = overrides.kind ?? "suspension";
  const lineId = overrides.lineId ?? "2";
  const stations = overrides.stations ?? ["Castle Frank"];
  const affectedLineIds = lineId.length > 0 ? [lineId] : undefined;
  const provider = getAgencyById(agencyId);
  const affectedStations =
    stations.length > 0
      ? stations.map(
          (station) =>
            resolveAgencyStationReference(station, {
              stationIndex: provider?.schematic?.stationIndex,
              stationAliases: provider?.schematic?.stationAliases,
              schematicStations: provider?.schematic?.stations,
            }) ?? { stationName: station },
        )
      : undefined;
  const affectedRouteIds =
    overrides.routeIds && overrides.routeIds.length > 0 ? [...overrides.routeIds] : undefined;
  const stationLabel = stations.length > 0 ? stations.join(", ") : undefined;
  const title = overrides.title ?? `SPOOF: Line ${lineId} ${kind} at ${stationLabel} Station`;
  const description =
    overrides.description ??
    `Dev-simulated ${severity} alert${stationLabel ? ` affecting ${stationLabel}` : ""}. Safe to ignore.`;

  const alert: AgencyAlert = {
    id: `spoof-${agencyId}-${now}`,
    kind,
    severity,
    lifecycle: "active",
    affectedLineIds,
    affectedRouteIds,
    affectedStations,
    scope: affectedStations ? "station" : affectedLineIds ? "line" : "network",
    title,
    description,
    startsAt: now,
    updatedAt: now,
  };
  return { agencyId, generatedAt: now, freshness: "live", alerts: [alert] };
}

/** Run the real evaluation pipeline against a fabricated development snapshot. */
export async function runSpoofedAlertEvaluation(
  agencyId: string = getActiveAgency().manifest.id,
  overrides: SpoofAlertOverrides = {},
): Promise<EvaluationSummary> {
  const vapidKeys = getVapidConfig();
  if (!vapidKeys) {
    throw new Error("DevAlertSpoof: VAPID keys not configured, cannot simulate alert");
  }

  const provider = allProviders().find((candidate) => candidate.manifest.id === agencyId);
  if (!provider) throw new Error(`DevAlertSpoof: unknown agency "${agencyId}"`);

  const runtime = createServerAgencyRuntime(provider);
  if (!runtime.hasSnapshot) {
    throw new Error(`DevAlertSpoof: agency "${agencyId}" exposes no snapshot port`);
  }

  const summary = await agencyTaskRunner.evaluateSnapshot(
    provider,
    buildSpoofSnapshot(agencyId, Date.now(), overrides),
  );

  logger.info("DevAlertSpoof: spoofed alert dispatched", {
    agencyId,
    sent: summary.activePushesSent,
    evaluated: summary.activeAlertsEvaluated,
    checked: summary.subscriptionsChecked,
  });
  return summary;
}
