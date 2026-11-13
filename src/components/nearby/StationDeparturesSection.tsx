import { createMemo, For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { DirectionArrivalsRow } from "./DirectionArrivalsRow";
import { LineBadgeCircle } from "./LineBadgeCircle";
import { useStationDepartures } from "~/hooks/useStationDepartures";
import type { StationDepartureGroup } from "~/services/StationsClient";
import { useI18n } from "~/i18n/I18nContext";

export interface StationDeparturesSectionProps {
  readonly agencyId: string;
  readonly stationId: string;
  /** Nearby cards restrict the shared station response to their train lines. */
  readonly lineIds?: readonly string[];
  /**
   * Section header, used for the agency label in multi-agency popovers.
   * Rows render without a header when omitted (panel-card fallback).
   */
  readonly header?: string;
}

/**
 * One station's live departures, owned by a single departures subscription.
 * Mounting subscribes (open), unmounting releases (close); a hover prefetch
 * warms the same entry so the first paint usually reads from cache.
 *
 * Rows are the shared `DirectionArrivalsRow` the panel cards render, so
 * popover and panel stay pixel-identical. Reads the query defensively: the
 * adapter throws out of pending or empty error reads, and cached data must
 * keep rendering through background failures.
 */
export function StationDeparturesSection(props: StationDeparturesSectionProps) {
  const { t, locale } = useI18n();
  const query = useStationDepartures(
    () => ({
      agencyId: props.agencyId,
      stationId: props.stationId,
    }),
    () => true,
    locale,
  );

  const groups = createMemo<readonly StationDepartureGroup[] | undefined>(() => {
    if (query.isPending || query.isLoading || query.isPlaceholderData) return undefined;
    try {
      const response = query.data;
      const data =
        props.lineIds && response
          ? response
              .map((group) => ({
                ...group,
                lineIds: group.lineIds.filter((line) => props.lineIds!.includes(line)),
                arrivals: group.arrivals.filter((row) =>
                  row.lineId
                    ? props.lineIds!.includes(row.lineId)
                    : group.lineIds.length > 0 &&
                      group.lineIds.every((line) => props.lineIds!.includes(line)),
                ),
              }))
              .filter((group) => group.lineIds.length > 0)
          : response;
      if (data) {
        const hasKnownArrivals = data.some((group) =>
          group.arrivals.some((row) => row.times.length > 0),
        );
        // An empty cached result is not useful last-known data. While it is
        // being refreshed, keep the pending message up instead of claiming
        // there are no active departures before this request settles.
        if (query.isFetching && !hasKnownArrivals) return undefined;
        return data;
      }
    } catch (error) {
      if (!(error instanceof Error)) throw error;
    }
    return query.error ? [] : undefined;
  });

  const hasKnownArrivals = () =>
    groups()?.some((group) => group.arrivals.some((row) => row.times.length > 0)) ?? false;
  const isStale = () => groups()?.some((group) => group.arrivalsStale === true) ?? false;
  const livePredictionsOnly = () => groups()?.some((group) => group.livePredictionsOnly) ?? false;

  return (
    <div data-testid="station-departures-section" class="flex flex-col gap-1.5">
      <Show when={props.header || (isStale() && hasKnownArrivals())}>
        <div class="flex items-center justify-between gap-2">
          <Show when={props.header}>
            <span class="truncate text-[11px] font-bold uppercase tracking-wide text-muted-foreground">
              {props.header}
            </span>
          </Show>
          <Show when={isStale() && hasKnownArrivals()}>
            <span
              role="status"
              aria-label={t("Showing last known arrivals; live feed unavailable")}
              class={cn(
                "inline-flex shrink-0 items-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold",
                "border-warning/30 bg-warning/6 text-warning-400",
              )}
            >
              {t("Last known")}
            </span>
          </Show>
        </div>
      </Show>

      <Show
        when={groups() !== undefined}
        fallback={
          <span class="text-[11px] italic text-muted-foreground">{t("Loading departures…")}</span>
        }
      >
        <Show
          when={hasKnownArrivals()}
          fallback={
            <span
              role={isStale() || query.error ? "status" : undefined}
              class="text-[11px] italic text-muted-foreground"
            >
              {isStale() || query.error
                ? t("Live departures unavailable")
                : livePredictionsOnly()
                  ? t("No live predictions available")
                  : t("No active departures")}
            </span>
          }
        >
          <For each={groups() ?? []}>
            {(group) => {
              const showGroupHeader = () => (groups()?.length ?? 0) > 1;

              return (
                <>
                  <Show when={showGroupHeader()}>
                    <div class="flex items-center gap-1.5 pt-0.5">
                      <LineBadgeCircle lineIds={group.lineIds} agencyId={props.agencyId} />
                      <Show when={group.lineName}>
                        <span class="truncate text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
                          {group.lineName}
                        </span>
                      </Show>
                    </div>
                  </Show>
                  <For each={group.arrivals}>
                    {(row) => (
                      <DirectionArrivalsRow
                        label={row.label}
                        generatedLabel={row.generatedLabel}
                        times={row.times}
                        lineId={
                          showGroupHeader() &&
                          group.lineIds.length === 1 &&
                          (!row.lineId || row.lineId === group.lineIds[0])
                            ? undefined
                            : row.lineId
                        }
                        agencyId={props.agencyId}
                      />
                    )}
                  </For>
                </>
              );
            }}
          </For>
        </Show>
      </Show>
      <Show when={livePredictionsOnly()}>
        <span class="text-[11px] text-muted-foreground">
          {t(
            "Only tracked departures appear. Check the operator's timetable for scheduled service.",
          )}
        </span>
      </Show>
    </div>
  );
}
