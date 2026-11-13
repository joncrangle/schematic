import { AlertDescription } from "~/components/AlertDescription";
import { createMemo, createSignal, For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { CheckCircleIcon } from "./icons/CheckCircleIcon";
import { ServiceAvailabilityNotice } from "./ServiceAvailabilityNotice";
import type { FreshnessState } from "~/agencies/types";

import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useI18n } from "~/i18n/I18nContext";
import { bucketForKind, compareByFavouriteLine, type ServiceAlert } from "~/domain/serviceAlerts";
import { SEVERITY_RANK } from "~/domain/severity";
import { lineChipStyle } from "~/components/nearby/LineBadgeCircle";
import { keyListById } from "~/lib/keyedList";

// Single definition home is the domain formatting module; re-exported here
// for existing panel consumers.
export type { ServiceAlert };

export interface AlertsPanelProps {
  agencyId: string;
  alerts?: ServiceAlert[];
  freshness?: FreshnessState;
  agencyName?: string;
}

// Keyed by DOMAIN severity, the invented info/warning vocabulary is gone.
const severityStyles = {
  normal: {
    label: "Normal",
    border: "border-info/20",
    dot: "bg-info",
  },
  degraded: {
    label: "Degraded",
    border: "border-warning/20",
    dot: "bg-warning-400",
  },
  severe: {
    label: "Severe",
    border: "border-destructive/20",
    dot: "bg-destructive",
  },
} as const;

export function AlertsPanel(props: AlertsPanelProps) {
  const userPrefs = useUserPreferences();
  const { t, formatNumber } = useI18n();

  const [showDelays, setShowDelays] = createSignal(true);
  const [showRsz, setShowRsz] = createSignal(false);
  const [showAccess, setShowAccess] = createSignal(false);

  // Buckets derive from the domain kind via one shared function.
  const delayAlerts = createMemo(() =>
    (props.alerts || []).filter((a) => bucketForKind(a.kind) === "delays"),
  );

  const rszAlerts = createMemo(() =>
    (props.alerts || []).filter((a) => bucketForKind(a.kind) === "rsz"),
  );

  const accessAlerts = createMemo(() =>
    (props.alerts || []).filter((a) => bucketForKind(a.kind) === "accessibility"),
  );

  const filteredAlerts = createMemo(() => {
    const list: ServiceAlert[] = [];
    if (showDelays()) list.push(...delayAlerts());
    if (showRsz()) list.push(...rszAlerts());
    if (showAccess()) list.push(...accessAlerts());

    const byFavourite = compareByFavouriteLine(
      userPrefs.preferences.favouriteLines,
      props.agencyId,
    );

    // Deliberate product policy: favourites first, then SEVERITY_RANK, then recency.
    return list.sort((a, b) => {
      const favDiff = byFavourite(a, b);
      if (favDiff !== 0) return favDiff;
      const rankDiff = SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity];
      if (rankDiff !== 0) return rankDiff;
      return b.updatedAt - a.updatedAt;
    });
  });

  const keyedAlerts = createMemo(() => keyListById(filteredAlerts(), (a) => a.id));

  return (
    <div class="flex flex-col h-full">
      {/* Category Toggle Bar */}
      <Show when={props.freshness !== "unavailable"}>
        <div class="mb-3 flex flex-wrap items-center gap-1.5 border-b border-border pb-2.5 shrink-0">
          <button
            type="button"
            onClick={() => setShowDelays(!showDelays())}
            aria-pressed={showDelays() ? "true" : "false"}
            class={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors border",
              showDelays()
                ? "border-warning/40 bg-warning/15 text-warning-300 font-semibold"
                : "border-border bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{t("Delays & Closures")}</span>
            <span class="rounded bg-black/40 px-1 py-0.2 text-[10px] font-mono">
              {formatNumber(delayAlerts().length)}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setShowRsz(!showRsz())}
            aria-pressed={showRsz() ? "true" : "false"}
            class={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors border",
              showRsz()
                ? "border-warning/40 bg-warning/15 text-warning-300 font-semibold"
                : "border-border bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{t("Slow Zones")}</span>
            <span class="rounded bg-black/40 px-1 py-0.2 text-[10px] font-mono">
              {formatNumber(rszAlerts().length)}
            </span>
          </button>

          <button
            type="button"
            onClick={() => setShowAccess(!showAccess())}
            aria-pressed={showAccess() ? "true" : "false"}
            class={cn(
              "flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors border",
              showAccess()
                ? "border-info/40 bg-info/15 text-info font-semibold"
                : "border-border bg-muted text-muted-foreground hover:text-foreground",
            )}
          >
            <span>{t("Accessibility")}</span>
            <span class="rounded bg-black/40 px-1 py-0.2 text-[10px] font-mono">
              {formatNumber(accessAlerts().length)}
            </span>
          </button>
        </div>
      </Show>

      <Show
        when={filteredAlerts().length > 0}
        fallback={
          <Show
            when={props.freshness !== "unavailable" && props.freshness !== "stale"}
            fallback={
              <ServiceAvailabilityNotice
                freshness={props.freshness}
                agencyName={props.agencyName}
              />
            }
          >
            <div class="flex flex-col items-center justify-center px-6 py-10 text-center">
              <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-live/20 bg-live/10 text-live">
                <CheckCircleIcon size={20} />
              </div>

              <p class="text-sm font-medium text-foreground">
                {t("No alerts in selected filters")}
              </p>
              <p class="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
                {t(
                  "Toggle on Slow Zones or Accessibility above to view active advisories and outages.",
                )}
              </p>
            </div>
          </Show>
        }
      >
        <div class="flex flex-col gap-2 overflow-y-auto">
          <For each={keyedAlerts().ids}>
            {(alertId) => {
              const alert = () => keyedAlerts().byId.get(alertId);

              return (
                <Show when={alert()}>
                  {(currentAlert) => {
                    const severity = () => severityStyles[currentAlert().severity];

                    return (
                      <article class={cn("rounded-xl border bg-card p-3", severity().border)}>
                        <div class="flex items-start gap-3">
                          <span
                            class={cn("mt-1.5 h-2 w-2 shrink-0 rounded-full", severity().dot)}
                            aria-label={t(severity().label as "Normal" | "Degraded" | "Severe")}
                          />

                          <div class="min-w-0 flex-1">
                            <div class="flex items-center justify-between gap-2">
                              <Show
                                when={currentAlert().lineColor}
                                fallback={
                                  <span class="inline-flex rounded-md bg-muted px-2 py-0.5 text-[11px] font-semibold text-muted-foreground">
                                    {currentAlert().lineName}
                                  </span>
                                }
                              >
                                <span
                                  class="inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold"
                                  style={lineChipStyle(currentAlert().lineColor)}
                                >
                                  {currentAlert().lineName}
                                </span>
                              </Show>

                              <time
                                class="shrink-0 text-[10px] text-muted-foreground/70"
                                datetime={new Date(currentAlert().updatedAt).toISOString()}
                              >
                                {currentAlert().updatedAtLabel}
                              </time>
                            </div>

                            <h2 class="mt-2 text-sm font-semibold leading-snug text-foreground">
                              {currentAlert().title}
                            </h2>

                            <Show
                              when={
                                currentAlert().description &&
                                currentAlert().description.trim().toLowerCase() !==
                                  currentAlert().title.trim().toLowerCase()
                              }
                            >
                              <p class="mt-1 whitespace-pre-line text-xs leading-relaxed text-muted-foreground">
                                <AlertDescription text={currentAlert().description} />
                              </p>
                            </Show>
                          </div>
                        </div>
                      </article>
                    );
                  }}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
