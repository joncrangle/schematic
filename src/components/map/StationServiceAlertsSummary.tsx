import { createMemo, createSignal, For, Show } from "solid-js";
import type { AgencyAlert } from "~/agencies/types";
import {
  classifySurfaceAlert,
  parseDirectionalScope,
  type DirectionalScope,
} from "~/domain/surface/surfaceAlerts";
import {
  getStationServiceAlertGroups,
  hasDistinctAlertDescription,
  type StationServiceAlertGroup,
} from "~/domain/stationAlerts";
import { AlertIcon } from "~/components/icons/AlertIcon";
import { AlertAccordionItem, surfaceAlertTone } from "~/components/route/RouteAlertBanner";
import { keyListById } from "~/lib/keyedList";
import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n/I18nContext";
import type { TranslationKey } from "~/i18n/en";

const DIRECTIONAL_CHIP_KEYS = {
  both: "Both Directions",
  eastbound: "Eastbound",
  westbound: "Westbound",
  northbound: "Northbound",
  southbound: "Southbound",
} satisfies Record<DirectionalScope, TranslationKey>;

export interface StationServiceAlertsSummaryProps {
  readonly alerts: readonly AgencyAlert[];
}

function mergeDirectionalScopes(alerts: readonly AgencyAlert[]): DirectionalScope {
  const scopes = new Set(alerts.map((alert) => parseDirectionalScope(alert)));
  if (scopes.has("both")) return "both";
  if (scopes.size <= 1) return [...scopes][0] ?? "both";
  return "both";
}

function summaryPrefix(group: StationServiceAlertGroup): string {
  const separator = group.representative.title.indexOf(":");
  return separator > 0 ? group.representative.title.slice(0, separator) : "Service";
}

function hasAuthoredSummaryPrefix(group: StationServiceAlertGroup): boolean {
  return group.representative.title.indexOf(":") > 0;
}

function stripSummaryPrefix(text: string, group: StationServiceAlertGroup): string {
  const value = text.trim();
  const prefix = summaryPrefix(group).trim();
  if (
    prefix === "Service" ||
    value.slice(0, prefix.length).toLowerCase() !== prefix.toLowerCase()
  ) {
    return value;
  }

  const remainder = value.slice(prefix.length).trimStart();
  return remainder.startsWith(":") ? remainder.slice(1).trim() : value;
}

function stripDirectionalRepeat(text: string, alert: AgencyAlert): string {
  const scope = parseDirectionalScope(alert);
  if (scope === "both") return text;

  const direction = scope.replace(/bound$/, "");
  const abbreviation = `${direction[0]}b`;
  return text
    .replace(new RegExp(`\\b${direction}\\s*bound\\b|\\b${abbreviation}\\b`, "i"), " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function detailText(text: string, group: StationServiceAlertGroup, alert: AgencyAlert): string {
  return stripDirectionalRepeat(stripSummaryPrefix(text, group), alert);
}

export function StationServiceAlertsSummary(props: StationServiceAlertsSummaryProps) {
  const { t } = useI18n();
  const groups = createMemo(() => getStationServiceAlertGroups(props.alerts));
  const [expandedKeys, setExpandedKeys] = createSignal<ReadonlySet<string>>(new Set());

  const isGroupExpanded = (group: StationServiceAlertGroup, groupId: string): boolean =>
    expandedKeys().has(groupId) || group.alerts.some((alert) => expandedKeys().has(alert.id));

  const toggleGroup = (group: StationServiceAlertGroup, groupId: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current);
      const currentlyExpanded = isGroupExpanded(group, groupId);
      if (currentlyExpanded) {
        next.delete(groupId);
        for (const alert of group.alerts) {
          next.delete(alert.id);
        }
      } else {
        next.add(groupId);
        for (const alert of group.alerts) {
          next.add(alert.id);
        }
      }
      return next;
    });
  };

  // Keyed by stable group id (sorted member ids) so a refetch delivering
  // fresh group objects for unchanged advisories patches rows in place
  // instead of remounting them. Singletons render through the same
  // parent-owned expandedKeys as multi-alert groups, so their accordion
  // no longer lives in a remountable child banner.
  const keyedGroups = createMemo(() => keyListById(groups(), stableGroupKey));

  return (
    <section aria-label={t("Station service alerts")} class="flex min-w-0 flex-col gap-1.5">
      <For each={keyedGroups().ids}>
        {(groupId) => {
          const group = () => keyedGroups().byId.get(groupId);
          return (
            <Show when={group()} fallback={null}>
              {(current) => {
                const isExpanded = () => isGroupExpanded(current(), groupId);
                return (
                  <Show
                    when={current().alerts.length === 1}
                    fallback={
                      <RelatedAlertGroup
                        group={current()}
                        expanded={isExpanded()}
                        onToggle={() => toggleGroup(current(), groupId)}
                      />
                    }
                  >
                    <AlertAccordionItem
                      alert={current().alerts[0]!}
                      isExpanded={isExpanded()}
                      onToggle={() => toggleGroup(current(), groupId)}
                    />
                  </Show>
                );
              }}
            </Show>
          );
        }}
      </For>
    </section>
  );
}

/**
 * Order-independent group identity: within-group ordering derives from
 * `updatedAt` (fetch-clock stamped when the wire carries no timestamp), so
 * the join must not depend on it or an unchanged group would get a new key
 * on every poll and drop its expansion.
 */
function stableGroupKey(group: StationServiceAlertGroup): string {
  return group.alerts
    .map((alert) => alert.id)
    .sort()
    .join("|");
}

function RelatedAlertGroup(props: {
  readonly group: StationServiceAlertGroup;
  readonly expanded: boolean;
  readonly onToggle: () => void;
}) {
  const { t, plural } = useI18n();
  const presentation = () =>
    surfaceAlertTone(classifySurfaceAlert(props.group.representative).severity);
  const directionalChip = (scope: DirectionalScope) => `[${t(DIRECTIONAL_CHIP_KEYS[scope])}]`;
  const detailsId = () => `station-alert-details-${stableGroupKey(props.group)}`;
  const keyedAlerts = createMemo(() => keyListById(props.group.alerts, (alert) => alert.id));

  return (
    <div class={cn("min-w-0 rounded-xl border p-2.5", presentation().border, presentation().bg)}>
      <button
        type="button"
        onClick={props.onToggle}
        aria-expanded={props.expanded ? "true" : "false"}
        aria-controls={detailsId()}
        class="flex w-full cursor-pointer items-start justify-between gap-2 text-left"
      >
        <span class="flex min-w-0 items-start gap-1.5">
          <AlertIcon size={14} class={cn("mt-0.5 shrink-0", presentation().iconText)} />
          <span class="min-w-0">
            <span class="block truncate text-xs font-semibold text-foreground">
              {hasAuthoredSummaryPrefix(props.group) ? summaryPrefix(props.group) : t("Service")}
            </span>
            <span class="mt-1 flex min-w-0 flex-wrap items-center gap-1.5">
              <span class="inline-flex items-center rounded-md border border-border bg-muted px-1 py-px text-[9.5px] font-bold tracking-wide text-muted-foreground">
                {directionalChip(mergeDirectionalScopes(props.group.alerts))}
              </span>
              <span class="text-[9.5px] font-semibold text-muted-foreground">
                {plural("Station advisory count", props.group.alerts.length)}
              </span>
            </span>
          </span>
        </span>
        <span class="shrink-0 text-[10px] text-muted-foreground" aria-hidden="true">
          {props.expanded ? "▲" : "▼"}
        </span>
      </button>

      <Show when={props.expanded}>
        <div
          id={detailsId()}
          class="mt-2 ml-5 flex min-w-0 flex-col gap-1 border-t border-white/5 pt-2"
        >
          <For each={keyedAlerts().ids}>
            {(alertId) => {
              const alert = () => keyedAlerts().byId.get(alertId);
              return (
                <Show when={alert()} fallback={null}>
                  {(current) => (
                    <div class="flex min-w-0 flex-col gap-0.5 text-[10px] leading-tight">
                      <div class="flex min-w-0 items-start gap-1.5">
                        <span class="min-w-0 flex-1 wrap-break-word text-muted-foreground">
                          {detailText(current().title, props.group, current())}
                        </span>
                        <span class="inline-flex shrink-0 items-center rounded-md border border-border bg-muted px-1 py-px font-bold tracking-wide text-muted-foreground">
                          {directionalChip(parseDirectionalScope(current()))}
                        </span>
                      </div>
                      <Show when={hasDistinctAlertDescription(current())}>
                        <p class="wrap-break-word text-muted-foreground/80">
                          {detailText(current().description!, props.group, current())}
                        </p>
                      </Show>
                    </div>
                  )}
                </Show>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
}
