import { createMemo, createSignal, For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { keyListById } from "~/lib/keyedList";
import type { AgencyAlert } from "~/agencies/types";
import {
  classifySurfaceAlert,
  parseDirectionalScope,
  sortSurfaceAlerts,
  toggleAlertId,
  type SurfaceAlertSeverityKind,
} from "~/domain/surface/surfaceAlerts";
import { hasDistinctAlertDescription } from "~/domain/stationAlerts";
import { AlertIcon } from "~/components/icons/AlertIcon";
import { useI18n } from "~/i18n/I18nContext";

/**
 * Tailwind class tones for the two surface alert severities.
 * Semantic colors: severe #ef4444 (red-500), degraded #f59e0b (amber-500).
 */
export interface SurfaceAlertTone {
  readonly iconText: string;
  readonly border: string;
  readonly bg: string;
  readonly accentText: string;
  readonly dotBg: string;
}

export function surfaceAlertTone(severity: SurfaceAlertSeverityKind): SurfaceAlertTone {
  return severity === "severe"
    ? {
        iconText: "text-destructive",
        border: "border-destructive/40",
        bg: "bg-destructive/6",
        accentText: "text-destructive",
        dotBg: "bg-destructive",
      }
    : {
        iconText: "text-warning",
        border: "border-warning/30",
        bg: "bg-warning/6",
        accentText: "text-warning-400",
        dotBg: "bg-warning",
      };
}

export interface AlertAccordionItemProps {
  readonly alert: AgencyAlert;
  readonly isExpanded: boolean;
  readonly onToggle: () => void;
}

/**
 * Single advisory row: severity icon + truncated single-line summary +
 * directional scope chip, with tap-to-expand accordion revealing the full
 * advisory description.
 */
export function AlertAccordionItem(props: AlertAccordionItemProps) {
  const { t } = useI18n();
  const presentation = createMemo(() => classifySurfaceAlert(props.alert));
  const tone = createMemo(() => surfaceAlertTone(presentation().severity));
  const chipLabel = createMemo(() => {
    const scope = parseDirectionalScope(props.alert);
    const label =
      scope === "both"
        ? t("Both Directions")
        : t(
            scope === "eastbound"
              ? "Eastbound"
              : scope === "westbound"
                ? "Westbound"
                : scope === "northbound"
                  ? "Northbound"
                  : "Southbound",
          );
    return `[${label}]`;
  });
  const descriptionId = () => `alert-desc-${props.alert.id}`;

  return (
    <div class={cn("rounded-xl border p-2.5", tone().border, tone().bg)}>
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.isExpanded ? "true" : "false"}
        aria-controls={
          props.isExpanded && hasDistinctAlertDescription(props.alert) ? descriptionId() : undefined
        }
        class="flex w-full cursor-pointer items-start justify-between gap-2 text-left"
      >
        <span class="flex min-w-0 items-start gap-1.5">
          <AlertIcon size={14} class={cn("mt-0.5 shrink-0", tone().iconText)} />
          <span class="min-w-0">
            <span
              class={cn(
                "block text-xs font-semibold text-foreground",
                props.isExpanded ? "wrap-break-word" : "truncate",
              )}
            >
              {props.alert.title}
            </span>
            <span class="mt-1 inline-flex items-center rounded-md border border-border bg-muted px-1 py-px text-[9.5px] font-bold tracking-wide text-muted-foreground">
              {chipLabel()}
            </span>
          </span>
        </span>
        <span class="shrink-0 text-[10px] text-muted-foreground" aria-hidden="true">
          {props.isExpanded ? "▲" : "▼"}
        </span>
      </button>

      <Show when={props.isExpanded && hasDistinctAlertDescription(props.alert)}>
        <p
          id={descriptionId()}
          class="mt-2 border-t border-white/5 pt-2 text-[11px] leading-relaxed text-muted-foreground wrap-break-word"
        >
          {props.alert.description}
        </p>
      </Show>
    </div>
  );
}

export interface RouteAlertBannerProps {
  readonly alerts: readonly AgencyAlert[];
  readonly ariaLabel?: string;
}

/**
 * Stacked, severity-aware banner of active surface route advisories.
 * Used in Nearby transit cards (expanded state) directly below the route
 * header and above arrival countdowns. Deduplicates similar service alerts.
 */
export function RouteAlertBanner(props: RouteAlertBannerProps) {
  const { t } = useI18n();
  const [expandedIds, setExpandedIds] = createSignal<ReadonlySet<string>>(new Set());

  // Filter out any non-service alerts and deduplicate similar service alerts
  const serviceAlerts = createMemo(() => {
    const service = props.alerts.filter((a) => a.kind !== "accessibility");
    const seen = new Set<string>();
    const uniqueService: AgencyAlert[] = [];
    for (const alert of sortSurfaceAlerts(service)) {
      const key = `${alert.title.trim().toLowerCase()}|${alert.description?.trim().toLowerCase() ?? ""}`;
      if (!seen.has(key)) {
        seen.add(key);
        uniqueService.push(alert);
      }
    }
    return uniqueService;
  });

  const toggleAlert = (alertId: string) => {
    setExpandedIds((prev) => toggleAlertId(prev, alertId));
  };

  // Keyed by stable alert id so a refetch delivering fresh objects for
  // unchanged advisories patches content in place instead of remounting
  // every accordion row (which would drop expandedIds).
  const keyedAlerts = createMemo(() => keyListById(serviceAlerts(), (alert) => alert.id));

  return (
    <section
      aria-label={props.ariaLabel ?? t("Route service alerts")}
      class="flex flex-col gap-1.5"
    >
      <For each={keyedAlerts().ids}>
        {(alertId) => {
          const alert = () => keyedAlerts().byId.get(alertId);
          return (
            <Show when={alert()} fallback={null}>
              {(current) => (
                <AlertAccordionItem
                  alert={current()}
                  isExpanded={expandedIds().has(alertId)}
                  onToggle={() => toggleAlert(alertId)}
                />
              )}
            </Show>
          );
        }}
      </For>
    </section>
  );
}

export interface RouteDisruptionPillProps {
  readonly alerts: readonly AgencyAlert[];
  readonly panelId?: string;
}

/**
 * Collapsible disruption notification pill for Targeted Route Mode.
 * Mounts directly beneath the top RouteControls bar as
 * `[⚠️ Detour Advisory +N more ▾]`; tapping toggles an overlay card listing
 * all concurrent route alerts sorted by severity, each with its own
 * expand/collapse accordion. The overlay stays within the fixed top control
 * column (height-capped, scrollable) so it never obstructs map zoom/pan.
 */
export function RouteDisruptionPill(props: RouteDisruptionPillProps) {
  const { t, plural } = useI18n();
  const [isOpen, setIsOpen] = createSignal(false);
  const [expandedIds, setExpandedIds] = createSignal<ReadonlySet<string>>(new Set());

  const sortedAlerts = createMemo(() => sortSurfaceAlerts(props.alerts));
  const mostCritical = createMemo(() => sortedAlerts()[0]);
  const presentation = createMemo(() =>
    mostCritical() ? classifySurfaceAlert(mostCritical()!) : null,
  );
  const tone = createMemo(() =>
    presentation() ? surfaceAlertTone(presentation()!.severity) : null,
  );
  const overflowCount = () => Math.max(0, sortedAlerts().length - 1);
  const panelId = () => props.panelId ?? "route-disruption-alerts-panel";

  const togglePillAlert = (alertId: string) => {
    setExpandedIds((prev) => toggleAlertId(prev, alertId));
  };

  // Same stable-id keying as the banner: fresh poll objects patch in place.
  const keyedSortedAlerts = createMemo(() => keyListById(sortedAlerts(), (alert) => alert.id));

  return (
    <Show when={sortedAlerts().length > 0 && presentation() && tone()}>
      <div class="pointer-events-auto flex w-full flex-col items-center gap-2">
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          aria-expanded={isOpen() ? "true" : "false"}
          aria-controls={panelId()}
          class={cn(
            "inline-flex cursor-pointer items-center gap-1.5 rounded-full border bg-card/85 px-3 py-1.5 text-[11px] font-semibold shadow-md backdrop-blur-sm transition-colors hover:bg-accent active:scale-95",
            tone()?.border,
            tone()?.iconText,
          )}
        >
          <span class={cn("h-1.5 w-1.5 rounded-full", tone()?.dotBg)} aria-hidden="true" />
          <span aria-hidden="true">⚠️</span>
          <span>
            {t("{{label}} Advisory", {
              label: t(presentation()?.label === "Detour" ? "Detour" : "Delay"),
            })}
          </span>
          <Show when={overflowCount() > 0}>
            <span class="text-muted-foreground">{plural("More alerts", overflowCount())}</span>
          </Show>
          <span aria-hidden="true">{isOpen() ? "▴" : "▾"}</span>
        </button>

        <Show when={isOpen()}>
          <div
            id={panelId()}
            role="region"
            aria-label={t("Route service alert details")}
            class="flex max-h-[40vh] w-full flex-col gap-1.5 overflow-y-auto rounded-2xl border border-border bg-card/95 p-2 shadow-2xl backdrop-blur-md"
          >
            <For each={keyedSortedAlerts().ids}>
              {(alertId) => {
                const alert = () => keyedSortedAlerts().byId.get(alertId);
                return (
                  <Show when={alert()} fallback={null}>
                    {(current) => (
                      <AlertAccordionItem
                        alert={current()}
                        isExpanded={expandedIds().has(alertId)}
                        onToggle={() => togglePillAlert(alertId)}
                      />
                    )}
                  </Show>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </Show>
  );
}
