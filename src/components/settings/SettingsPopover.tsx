import { createSignal, onSettled, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { PreferencesTab } from "./PreferencesTab";
import { FavouritesTab } from "./FavouritesTab";
import { CommuteScheduleTab } from "./CommuteScheduleTab";
import { CogIcon } from "~/components/icons/CogIcon";
import { useEscapeKey } from "~/lib/keyboard";
import { usePushAvailability } from "~/hooks/usePushAvailability";
import { useI18n } from "~/i18n/I18nContext";

export type SettingsTab = "preferences" | "favourites" | "commute";

export interface SettingsPopoverProps {
  readonly isOpen: boolean;
  readonly onClose: () => void;
  /**
   * Accessor for the trigger button rendered by the owner (routes/index.tsx),
   * read at listener time like ServiceSheetModal's navContainer. Element
   * identity comes from the owner's callback ref, never an aria-label
   * string lookup. Optional so standalone renderings without a trigger stay
   * valid: an undefined accessor simply skips the trigger exclusion.
   */
  readonly triggerEl?: () => HTMLElement | undefined;
  readonly agencyId?: string;
}

export function SettingsPopover(props: SettingsPopoverProps) {
  return (
    <Show when={props.isOpen}>
      <SettingsPopoverDialog
        onClose={props.onClose}
        triggerEl={props.triggerEl}
        agencyId={props.agencyId}
      />
    </Show>
  );
}

function SettingsPopoverDialog(props: {
  readonly onClose: () => void;
  readonly triggerEl?: () => HTMLElement | undefined;
  readonly agencyId?: string;
}) {
  const { t } = useI18n();
  const [activeTab, setActiveTab] = createSignal<SettingsTab>("preferences");
  const { isAvailable } = usePushAvailability();
  let panelRef: HTMLDivElement | undefined;

  const effectiveActiveTab = () =>
    activeTab() === "commute" && !isAvailable() ? "preferences" : activeTab();

  useEscapeKey(
    () => props.onClose(),
    () => true,
  );

  // Outside-pointerdown close, replaces the removed full-viewport backdrop
  // (which forced a whole-page composite on every open). The dialog component
  // only mounts while open, so the listener's lifetime is mount-driven:
  // attached in onSettled, removed in onCleanup. A pointerdown closes only when
  // it lands outside BOTH the panel (editing gestures inside must not close)
  // and the trigger button (its own onClick owns the toggle, closing here
  // would flicker close-then-reopen on every trigger press). The trigger is
  // the owner-threaded element ref, read at event time.
  onSettled(() => {
    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef?.contains(target)) return;
      if (props.triggerEl?.()?.contains(target)) return;
      props.onClose();
    };
    document.addEventListener("pointerdown", handlePointerDown);
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  });

  return (
    <>
      {/* Top Anchored Popover Container */}
      <div
        ref={(el) => {
          panelRef = el;
        }}
        role="dialog"
        aria-label={t("Settings and Preferences")}
        class={cn(
          "fixed z-50 flex flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-2xl transition-all animate-in fade-in zoom-in-95 duration-150",
          // Mobile (< md): Centered frame between header and bottom nav —
          // mirrors NearbyFloatingPill's popover geometry
          "top-16 bottom-[calc(max(0.875rem,env(safe-area-inset-bottom,0.875rem))+3.5rem)] left-1/2 -translate-x-1/2 w-[min(480px,95vw)] max-h-[calc(100dvh-8rem)]",
          // Non-mobile (>= md): Docked top-right sheet with strict height limit
          "md:top-4 md:right-4 md:bottom-auto md:left-auto md:translate-x-0 md:mx-0 md:w-full md:max-w-sm md:max-h-[calc(100dvh-2rem)]",
        )}
      >
        {/* Header */}
        <div class="flex items-center justify-between border-b border-border bg-card px-4 py-3">
          <div class="flex items-center gap-2">
            <CogIcon size={16} class="text-muted-foreground" />
            <h2 class="text-sm font-bold text-white">{t("Settings & Preferences")}</h2>
          </div>
          <button
            type="button"
            onClick={() => props.onClose()}
            aria-label={t("Close settings")}
            class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
          >
            <span aria-hidden="true" class="text-lg leading-none">
              ×
            </span>
          </button>
        </div>

        {/* Tab Segmented Control */}
        <div
          role="tablist"
          aria-label={t("Settings tabs")}
          class="mx-3 mt-3 mb-2 flex rounded-xl border border-border bg-card p-1"
        >
          <button
            type="button"
            role="tab"
            aria-selected={effectiveActiveTab() === "preferences" ? "true" : "false"}
            onClick={() => setActiveTab("preferences")}
            class={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-all ${
              effectiveActiveTab() === "preferences"
                ? "bg-accent text-white shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <CogIcon
              size={13}
              class={
                effectiveActiveTab() === "preferences" ? "text-white" : "text-muted-foreground"
              }
            />
            <span>{t("Preferences")}</span>
          </button>

          <button
            type="button"
            role="tab"
            aria-selected={effectiveActiveTab() === "favourites" ? "true" : "false"}
            onClick={() => setActiveTab("favourites")}
            class={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-all ${
              effectiveActiveTab() === "favourites"
                ? "bg-accent text-white shadow-xs"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <span>⭐</span>
            <span>{t("Favourites")}</span>
          </button>

          <Show when={isAvailable()}>
            <button
              type="button"
              role="tab"
              aria-selected={effectiveActiveTab() === "commute" ? "true" : "false"}
              onClick={() => setActiveTab("commute")}
              class={`flex flex-1 cursor-pointer items-center justify-center gap-1.5 rounded-lg py-1.5 text-xs font-semibold transition-all ${
                effectiveActiveTab() === "commute"
                  ? "bg-accent text-white shadow-xs"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              <span>⏰</span>
              <span>{t("Commute")}</span>
            </button>
          </Show>
        </div>

        {/* Scrollable Body. overscroll-contain stops scroll chaining at
            this container so a swipe past the top or bottom edge never
            reaches the page scroller and triggers the browser's native
            pull-to-refresh (page reload). Same guard as NearbyFloatingPill. */}
        <div
          class="flex-1 overflow-y-auto overscroll-contain touch-pan-y p-3"
          onWheel={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
        >
          <div
            role="tabpanel"
            aria-label={t("Preferences")}
            class={effectiveActiveTab() === "preferences" ? "block" : "hidden"}
          >
            <PreferencesTab agencyId={props.agencyId} />
          </div>
          <div
            role="tabpanel"
            aria-label={t("Favourites")}
            class={effectiveActiveTab() === "favourites" ? "block" : "hidden"}
          >
            <FavouritesTab />
          </div>
          <Show when={isAvailable()}>
            <div
              role="tabpanel"
              aria-label={t("Commute schedule")}
              class={effectiveActiveTab() === "commute" ? "block" : "hidden"}
            >
              <CommuteScheduleTab />
            </div>
          </Show>
        </div>
      </div>
    </>
  );
}
