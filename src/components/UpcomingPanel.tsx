import { createMemo, For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { CheckCircleIcon } from "./icons/CheckCircleIcon";
import { useUserPreferences } from "~/context/UserPreferencesContext";
import { useI18n } from "~/i18n/I18nContext";
import { compareByFavouriteLine, type UpcomingClosure } from "~/domain/serviceAlerts";
import { lineChipStyle } from "~/components/nearby/LineBadgeCircle";
import { keyListById } from "~/lib/keyedList";
import type { FreshnessState } from "~/agencies/types";
import { ServiceAvailabilityNotice } from "./ServiceAvailabilityNotice";

// Single definition home is the domain formatting module; re-exported here
// for existing panel consumers.
export type { UpcomingClosure };

export interface UpcomingPanelProps {
  agencyId: string;
  closures?: UpcomingClosure[];
  freshness?: FreshnessState;
  agencyName?: string;
}

export function UpcomingPanel(props: UpcomingPanelProps) {
  const userPrefs = useUserPreferences();
  const { t } = useI18n();

  const closures = createMemo(() => {
    const raw = props.closures || [];
    const byFavourite = compareByFavouriteLine(
      userPrefs.preferences.favouriteLines,
      props.agencyId,
    );

    return [...raw].sort((a, b) => {
      const favDiff = byFavourite(a, b);
      if (favDiff !== 0) return favDiff;
      const timeA = a.startsAt && a.startsAt > 0 ? a.startsAt : Infinity;
      const timeB = b.startsAt && b.startsAt > 0 ? b.startsAt : Infinity;
      return timeA - timeB;
    });
  });

  const keyedClosures = createMemo(() => keyListById(closures(), (c) => c.id));

  return (
    <Show
      when={closures().length > 0}
      fallback={
        <Show
          when={props.freshness !== "unavailable" && props.freshness !== "stale"}
          fallback={
            <ServiceAvailabilityNotice freshness={props.freshness} agencyName={props.agencyName} />
          }
        >
          <div class="flex flex-col items-center justify-center px-6 py-12 text-center">
            <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-live/20 bg-live/10 text-live">
              <CheckCircleIcon size={20} />
            </div>
            <p class="text-sm font-medium text-foreground">{t("No upcoming closures")}</p>
            <p class="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
              {t("No upcoming planned closures or scheduled maintenance at this time.")}
            </p>
          </div>
        </Show>
      }
    >
      <div class="flex flex-col gap-3.5 p-1">
        <For each={keyedClosures().ids}>
          {(closureId) => {
            const closure = () => keyedClosures().byId.get(closureId);

            return (
              <Show when={closure()}>
                {(item) => (
                  <div class={cn("rounded-xl border border-border bg-card p-3.5 shadow-md")}>
                    <div class="mb-2 flex flex-wrap items-center justify-between gap-2">
                      <Show
                        when={item().lineColor}
                        fallback={
                          <span class="rounded bg-muted px-2.5 py-0.5 text-xs font-bold text-muted-foreground">
                            {item().lineName}
                          </span>
                        }
                      >
                        <span
                          class={cn("rounded px-2.5 py-0.5 text-xs font-bold")}
                          style={lineChipStyle(item().lineColor)}
                        >
                          {item().lineName}
                        </span>
                      </Show>
                      <span class="text-xs font-medium text-muted-foreground bg-accent px-2.5 py-0.5 rounded border border-border">
                        {item().dateRange}
                      </span>
                    </div>

                    <h3 class="text-sm font-semibold text-white mb-1">{item().title}</h3>
                    <p class="text-xs font-medium text-muted-foreground mb-2">
                      {t("Affected section:")} <span class="text-foreground">{item().segment}</span>
                    </p>
                    <Show when={item().reason}>
                      <p class="text-xs text-muted-foreground leading-relaxed bg-muted p-2.5 rounded-lg border border-border">
                        {item().reason}
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
  );
}
