import { createMemo, For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import type { ServiceAlert } from "./AlertsPanel";
import type { UpcomingClosure } from "./UpcomingPanel";
import { SERVICE_PANEL_ID, ServiceSheetModal, type SheetTabItem } from "./nav/ServiceSheetModal";
import type { SheetTab } from "~/lib/shellSession";

import type { FreshnessState } from "~/agencies/types";
import { useI18n } from "~/i18n/I18nContext";

export interface BottomPillNavProps {
  agencyId: string;
  activeSheet: SheetTab | null;
  onToggleSheet: (tab: SheetTab | null) => void;
  alertCount?: number;
  upcomingCount?: number;
  alerts?: ServiceAlert[];
  upcomingClosures?: UpcomingClosure[];
  freshness?: FreshnessState;
  agencyName?: string;
}

export function BottomPillNav(props: BottomPillNavProps) {
  const { t } = useI18n();
  const alertCount = () => props.alertCount ?? props.alerts?.length ?? 0;
  const upcomingCount = () => props.upcomingCount ?? props.upcomingClosures?.length ?? 0;

  // Trigger container handed to ServiceSheetModal so its outside-pointerdown
  // close can exclude presses on these tab buttons (their onClick owns the
  // toggle; closing on pointerdown would flicker close-then-reopen).
  let navRef: HTMLElement | undefined;

  const tabs = createMemo<SheetTabItem[]>(() => [
    {
      id: "alerts",
      label: t("Alerts"),
      count: alertCount(),
    },
    {
      id: "upcoming",
      label: t("Upcoming"),
      count: upcomingCount(),
    },
  ]);

  const toggleTab = (tab: SheetTab) => {
    props.onToggleSheet(props.activeSheet === tab ? null : tab);
  };

  return (
    <>
      <ServiceSheetModal
        activeSheet={props.activeSheet}
        agencyId={props.agencyId}
        onToggleSheet={props.onToggleSheet}
        tabs={tabs()}
        alerts={props.alerts}
        upcomingClosures={props.upcomingClosures}
        freshness={props.freshness}
        agencyName={props.agencyName}
        navContainer={() => navRef}
      />

      <nav
        ref={(el) => (navRef = el)}
        aria-label={t("Service information")}
        class="fixed bottom-[max(0.875rem,env(safe-area-inset-bottom,0.875rem))] left-1/2 z-40 flex -translate-x-1/2 gap-1 whitespace-nowrap rounded-full border border-border bg-card p-1 shadow-xl"
      >
        <For each={tabs()} keyed={(tab) => tab.id}>
          {(tab) => (
            <button
              type="button"
              onClick={() => toggleTab(tab().id)}
              aria-expanded={props.activeSheet === tab().id ? "true" : "false"}
              aria-controls={SERVICE_PANEL_ID}
              class={cn(
                "flex cursor-pointer items-center gap-1.5 rounded-full px-3.5 py-2 text-xs font-medium text-foreground transition-colors",
                props.activeSheet === tab().id ? "bg-accent" : "bg-transparent hover:bg-accent",
              )}
            >
              <span
                aria-hidden="true"
                class={cn(
                  "h-2 w-2 rounded-full",
                  tab().id === "alerts"
                    ? props.freshness === "unavailable"
                      ? "bg-muted-foreground"
                      : alertCount() > 0
                        ? "bg-warning-400"
                        : "bg-live"
                    : "bg-muted-foreground",
                )}
              />
              <span>{tab().label}</span>

              <Show when={(tab().count ?? 0) > 0}>
                <span
                  class={cn(
                    "min-w-4 rounded-full px-1 text-center text-[9px] font-bold leading-4",
                    tab().id === "alerts" ? "bg-warning text-black" : "bg-accent text-foreground",
                  )}
                >
                  {tab().count}
                </span>
              </Show>
            </button>
          )}
        </For>
      </nav>
    </>
  );
}
