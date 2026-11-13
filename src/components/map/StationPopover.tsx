import { createMemo, For, Show } from "solid-js";
import type { Accessor } from "solid-js";
import { cn } from "~/lib/utils";
import type { AgencyAlert, FreshnessState } from "~/agencies/types";
import {
  filterStationAlerts,
  getGroupedStationOutages,
  getStationOverallStatus,
  getUniqueServiceAlerts,
} from "~/domain/stationAlerts";
import { WheelchairIcon } from "~/components/icons/WheelchairIcon";
import { AlertIcon } from "~/components/icons/AlertIcon";
import { SEVERITY_RANK } from "~/domain/severity";
import { StarIcon } from "~/components/icons/StarIcon";
import { StationServiceAlertsSummary } from "./StationServiceAlertsSummary";
import { LineBadgeCircle } from "~/components/nearby/LineBadgeCircle";
import { EquipmentOutageCard } from "./EquipmentOutageCard";
import { BaseMapPopover } from "./popovers/BaseMapPopover";
import { StationDeparturesSection } from "~/components/nearby/StationDeparturesSection";
import type { StationEndpoint } from "~/hooks/useStationDepartures";
import type { LineInfo, Point, StationInfo } from "~/core/map";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { isFavouriteStation } from "~/domain/preferences/UserPreferences";
import { useI18n } from "~/i18n/I18nContext";

export interface StationPopoverProps {
  agencyId: string;
  name?: string;
  station: StationInfo;
  coords: Point | null | undefined;
  containerSize?: { width: number; height: number };
  hoveredLineId?: Accessor<string | null>;
  onHoverLine?: (lineId: string | null) => void;
  onToggleLine?: (lineId: string) => void;
  onClose: () => void;
  setRef: (element: HTMLDivElement) => void;
  alerts?: readonly AgencyAlert[];
  /** False when live alert evidence is unavailable or the operator has no source. */
  alertsAvailable?: boolean;
  /** Optional freshness evidence for a separately loaded peer agency. */
  alertsFreshness?: FreshnessState;
  /** The schematic's line table, for line-name/color lookups. */
  linesById: ReadonlyMap<string, LineInfo>;
  /**
   * Live departures to render above alerts: one labeled section per agency
   * serving the station (current agency first, hub siblings after). Omitted
   * when the agency has no departures source, the popover then reads exactly
   * as before.
   */
  departureSections?: readonly (StationEndpoint & { readonly header?: string })[];
}

export function StationPopover(props: StationPopoverProps) {
  const userPrefs = useUserPreferences();
  const { t } = useI18n();

  const stationName = () => props.name || props.station.name;

  const isFavourited = () =>
    isFavouriteStation(userPrefs.preferences, props.agencyId, stationName());

  const relevantAlerts = () =>
    filterStationAlerts(props.alerts, props.station.id, stationName(), props.station.lines);

  const uniqueServiceAlerts = createMemo(() => {
    const alerts = getUniqueServiceAlerts(relevantAlerts());
    return [...alerts].sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]);
  });

  const groupedAccessibilityOutages = () => getGroupedStationOutages(relevantAlerts());

  const overallStatus = () =>
    props.alertsAvailable === false
      ? { text: "Live alerts unavailable", color: "text-muted-foreground" }
      : props.alertsFreshness === "stale" && uniqueServiceAlerts().length === 0
        ? { text: "Service alerts may be out of date", color: "text-warning-400" }
        : getStationOverallStatus(uniqueServiceAlerts(), props.station.lines, props.station.id);

  const overallStatusLabel = () => {
    const status = overallStatus().text;
    switch (status) {
      case "Normal Service":
        return t("Normal Service");
      case "No Service":
        return t("No Service");
      case "Service Delay":
        return t("Service Delay");
      case "Reduced Speed Zone":
        return t("Reduced Speed Zone");
      case "Live alerts unavailable":
        return t("Live alerts unavailable");
      case "Service alerts may be out of date":
        return t("Service alerts may be out of date");
      default:
        return t("Status unavailable");
    }
  };

  return (
    <BaseMapPopover
      coords={props.coords}
      containerSize={props.containerSize}
      topOffset={8}
      bottomOffset={8}
      onClose={props.onClose}
      setRef={props.setRef}
      ariaLabel={t("{{name}} station details", { name: stationName() })}
      class="w-72 max-h-105"
      header={
        <div class="flex items-center justify-between gap-2">
          <div class="min-w-0 flex-1">
            <div class="flex flex-col items-start gap-1 min-w-0">
              <h3 class="max-w-full text-sm font-bold text-white truncate">{stationName()}</h3>
              <Show when={props.station.lines.length > 0}>
                <LineBadgeCircle
                  lineIds={props.station.lines}
                  agencyId={props.agencyId}
                  hoveredLineId={props.hoveredLineId}
                  onHoverLine={props.onHoverLine}
                  onToggleLine={props.onToggleLine}
                />
              </Show>
            </div>
            <p class={cn("text-[11px] font-semibold", overallStatus().color)}>
              {overallStatusLabel()}
            </p>
          </div>
          <button
            type="button"
            onClick={() => userPrefs.toggleFavouriteStation(props.agencyId, stationName())}
            aria-label={
              isFavourited()
                ? t("Remove {{name}} from favourites", { name: stationName() })
                : t("Add {{name}} to favourites", { name: stationName() })
            }
            class={cn(
              "flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-lg transition-colors",
              isFavourited()
                ? "text-warning-400 bg-warning-400/10 hover:bg-warning-400/20"
                : "text-muted-foreground hover:bg-accent hover:text-foreground",
            )}
          >
            <StarIcon size={16} filled={isFavourited()} />
          </button>
        </div>
      }
    >
      {/* Scrollable Content Container. overscroll-contain stops scroll
          chaining at this container so a swipe down at the top cannot escape
          to the page and trigger the browser's native pull-to-refresh (page
          reload). Same guard as SettingsPopover and NearbyFloatingPill. The
          wider right padding keeps row content clear of the scrollbar gutter
          whenever one is present. */}
      <div
        data-testid="station-popover-content"
        class="min-w-0 overflow-x-hidden overflow-y-auto overscroll-contain touch-pan-y pr-2 flex flex-col gap-2.5"
      >
        <Show when={props.alertsFreshness === "stale" && uniqueServiceAlerts().length > 0}>
          <p class="text-[11px] text-warning-400">{t("Service alerts may be out of date")}</p>
        </Show>
        {/* Live departures, one labeled section per serving agency */}
        <Show when={(props.departureSections?.length ?? 0) > 0}>
          <div class="flex flex-col gap-2.5">
            <For each={props.departureSections ?? []}>
              {(section) => (
                <StationDeparturesSection
                  agencyId={section.agencyId}
                  stationId={section.stationId}
                  header={section.header}
                />
              )}
            </For>
          </div>
        </Show>

        {/* Unique Service Alerts (Severity-sorted, accordion-expandable) */}
        <Show when={uniqueServiceAlerts().length > 0}>
          <div class="border-t border-border pt-2">
            <StationServiceAlertsSummary alerts={uniqueServiceAlerts()} />
          </div>
        </Show>

        {/* Accessibility Status & Outages */}
        <div class="flex flex-col gap-1.5 border-t border-border pt-2 text-[11px]">
          <Show
            when={props.station.accessible}
            fallback={
              <span
                class={
                  props.station.accessible === false
                    ? "font-medium text-destructive"
                    : "text-muted-foreground"
                }
              >
                {props.station.accessible === false
                  ? t("No elevator access")
                  : t("Accessibility information unavailable")}
              </span>
            }
          >
            <div class="flex items-center gap-1.5 font-medium text-accessible">
              <span class="flex h-4 w-4 shrink-0 items-center justify-center rounded border border-white bg-accessible">
                <WheelchairIcon class="h-3 w-3" />
              </span>

              <span>{t("Accessible station")}</span>
            </div>
          </Show>

          {/* Grouped Escalators Outages */}
          <EquipmentOutageCard
            title={t("Escalators Out of Service")}
            items={groupedAccessibilityOutages().escalators}
          />

          {/* Grouped Elevators Outages */}
          <EquipmentOutageCard
            title={t("Elevators Out of Service")}
            items={groupedAccessibilityOutages().elevators}
          />

          {/* Other Accessibility Outages */}
          <Show when={groupedAccessibilityOutages().others.length > 0}>
            <For each={groupedAccessibilityOutages().others}>
              {(outage) => (
                <div class="mt-1 flex min-w-0 items-start gap-1.5 rounded bg-warning/10 p-1.5 border border-warning/25 text-warning-300">
                  <AlertIcon size={12} class="mt-0.5 text-warning-400" />
                  <div class="min-w-0 flex-1 text-[10px] leading-tight wrap-break-word">
                    <div class="font-medium">{outage.title}</div>
                    <Show when={outage.description && outage.description !== outage.title}>
                      <div class="mt-1">{outage.description}</div>
                    </Show>
                  </div>
                </div>
              )}
            </For>
          </Show>
        </div>
      </div>
    </BaseMapPopover>
  );
}
