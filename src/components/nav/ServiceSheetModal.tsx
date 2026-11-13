import { For, Match, onSettled, Show, Switch } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";
import { AlertsPanel, type ServiceAlert } from "../AlertsPanel";
import { UpcomingPanel, type UpcomingClosure } from "../UpcomingPanel";
import { OpenDataAttribution } from "../legal/OpenDataAttribution";
import { useEscapeKey } from "~/lib/keyboard";

import type { SheetTab } from "~/lib/shellSession";

export interface SheetTabItem {
  id: SheetTab;
  label: string;
  count?: number;
}

import type { FreshnessState } from "~/agencies/types";
import { useI18n } from "~/i18n/I18nContext";

export interface ServiceSheetModalProps {
  agencyId: string;
  activeSheet: SheetTab | null;
  onToggleSheet: (tab: SheetTab | null) => void;
  setPanelRef?: (element: HTMLDivElement) => void;
  tabs: SheetTabItem[];
  alerts?: ServiceAlert[];
  upcomingClosures?: UpcomingClosure[];
  freshness?: FreshnessState;
  agencyName?: string;
  /**
   * Live handle on the BottomPillNav trigger container. Pointerdowns inside
   * it belong to the tab buttons' own click-toggle and must never also count
   * as an "outside" press that closes the sheet (that would flicker
   * close-then-reopen). An accessor so the ref is read at listener time,
   * after the nav has mounted.
   */
  readonly navContainer?: () => HTMLElement | undefined;
}

export const SERVICE_PANEL_ID = "service-information-panel";

// Keep both bodies in the service-sheet chunk. The sheet is interaction-owned,
// but its first open must commit the selected content with the dialog; lazy
// bodies leave an empty panel during the first post-refresh resolution.

export function ServiceSheetModal(props: ServiceSheetModalProps): JSX.Element {
  return (
    <Show when={props.activeSheet !== null}>
      <ServiceSheetDialog
        activeSheet={props.activeSheet}
        agencyId={props.agencyId}
        onToggleSheet={props.onToggleSheet}
        setPanelRef={props.setPanelRef}
        tabs={props.tabs}
        alerts={props.alerts}
        upcomingClosures={props.upcomingClosures}
        freshness={props.freshness}
        agencyName={props.agencyName}
        navContainer={props.navContainer}
      />
    </Show>
  );
}

function ServiceSheetDialog(props: ServiceSheetModalProps): JSX.Element {
  const { t } = useI18n();
  let panelRef: HTMLDivElement | undefined;

  useEscapeKey(() => props.onToggleSheet(null));

  // Outside-pointerdown close, replaces the removed full-viewport backdrop
  // (which forced a whole-page composite on every open). The dialog component
  // only mounts while a sheet is open, so the listener's lifetime is
  // mount-driven: attached in onSettled, removed in onCleanup. A pointerdown
  // closes only when it lands outside BOTH the panel (gestures inside must
  // not close) and the nav trigger container (the tab buttons' own onClick
  // owns the toggle, closing here would flicker close-then-reopen on every
  // trigger press).
  onSettled(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef?.contains(target)) return;
      if (props.navContainer?.()?.contains(target)) return;
      props.onToggleSheet(null);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  });

  return (
    <div
      ref={(el) => {
        panelRef = el;
        props.setPanelRef?.(el);
      }}
      id={SERVICE_PANEL_ID}
      role="dialog"
      aria-modal="false"
      aria-label={t("Service information")}
      class="fixed bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+3.5rem)] left-1/2 -translate-x-1/2 z-30 flex h-[min(55vh,480px)] w-[min(480px,95vw)] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl animate-in fade-in slide-in-from-bottom-2 duration-200 pointer-events-auto"
      onWheel={(event) => event.stopPropagation()}
      onPointerDown={(event) => event.stopPropagation()}
      onTouchStart={(event) => event.stopPropagation()}
    >
      {/* Header with compact segmented tab pills and close button */}
      <div class="flex h-12 shrink-0 items-center justify-between border-b border-border px-4">
        <div
          role="tablist"
          aria-label={t("Service information")}
          class="inline-flex items-center rounded-xl bg-background p-1 border border-border/80"
        >
          <For each={props.tabs} keyed={(tab) => tab.id}>
            {(tab) => (
              <button
                type="button"
                role="tab"
                aria-selected={props.activeSheet === tab().id ? "true" : "false"}
                onClick={() => props.onToggleSheet(tab().id)}
                class={cn(
                  "flex cursor-pointer items-center gap-1.5 rounded-lg px-3 py-1 text-xs font-semibold transition-all",
                  props.activeSheet === tab().id
                    ? "bg-accent text-foreground shadow-sm"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <span>{tab().label}</span>

                <Show when={(tab().count ?? 0) > 0}>
                  <span
                    class={cn(
                      "rounded-full px-1.5 text-[9px] font-bold leading-4",
                      tab().id === "alerts" ? "bg-warning text-black" : "bg-accent text-foreground",
                    )}
                  >
                    {tab().count}
                  </span>
                </Show>
              </button>
            )}
          </For>
        </div>

        <button
          type="button"
          onClick={() => props.onToggleSheet(null)}
          aria-label={t("Close service information")}
          class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
        >
          <span aria-hidden="true" class="text-lg leading-none">
            ×
          </span>
        </button>
      </div>

      {/* overscroll-contain stops scroll chaining at this container so a swipe
          past the list edge can never reach the page scroller and trigger the
          browser's native pull-to-refresh (page reload). */}
      <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain p-3">
        <Switch>
          <Match when={props.activeSheet === "alerts"}>
            <AlertsPanel
              agencyId={props.agencyId}
              alerts={props.alerts}
              freshness={props.freshness}
              agencyName={props.agencyName}
            />
          </Match>
          <Match when={props.activeSheet === "upcoming"}>
            <UpcomingPanel
              agencyId={props.agencyId}
              closures={props.upcomingClosures}
              freshness={props.freshness}
              agencyName={props.agencyName}
            />
          </Match>
        </Switch>
      </div>

      {/* Footer Attribution */}
      <OpenDataAttribution agencyId={props.agencyId} variant="footer" />
    </div>
  );
}
