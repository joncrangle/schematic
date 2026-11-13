import { For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { useLiveCountdown } from "~/hooks/useLiveCountdown";
import { LineBadgeCircle } from "./LineBadgeCircle";
import type { GeneratedDirectionLabel } from "~/domain/surface/direction";
import { useI18n } from "~/i18n/I18nContext";
import { presentDirectionLabel } from "~/components/route/directionPresentation";

export interface DirectionArrivalsRowProps {
  readonly label?: string;
  readonly generatedLabel?: GeneratedDirectionLabel;
  readonly times: readonly number[];
  readonly lineId?: string;
  readonly agencyId?: string;
}

/**
 * One direction's departure cluster for nearby cards: a semantic direction
 * label followed by a compact single-line countdown cluster ("Due" / "N min"),
 * earliest first with the next departure highlighted. The label truncates to
 * yield space to the countdowns instead of widening a station card.
 *
 * Shared by StationArrivalCard and RouteArrivalCard so collapsed and
 * expanded presentations stay pixel-identical across both card kinds.
 */
export function DirectionArrivalsRow(props: DirectionArrivalsRowProps) {
  const { formatCountdown } = useLiveCountdown();
  const { t } = useI18n();

  return (
    <div
      data-testid="direction-arrivals-row"
      class="flex min-w-0 items-center gap-2 overflow-hidden"
    >
      <div class="flex min-w-0 items-center gap-1.5">
        <Show when={props.lineId}>
          <LineBadgeCircle lineIds={[props.lineId!]} agencyId={props.agencyId} />
        </Show>
        <Show when={props.label}>
          <span class="min-w-0 flex-1 truncate text-[10.5px] font-bold uppercase tracking-wide text-muted-foreground">
            {presentDirectionLabel(props.label ?? "", props.generatedLabel, t)}
          </span>
        </Show>
      </div>
      <div data-testid="arrival-times" class="flex shrink-0 items-center gap-1.5">
        <For each={props.times}>
          {(arrivalEpoch, index) => {
            const formatted = () => formatCountdown(arrivalEpoch);
            const isNext = () => index() === 0;

            return (
              <span
                class={cn(
                  "rounded-lg px-1.5 py-0.5 text-[11px] font-semibold whitespace-nowrap tabular-nums transition-colors",
                  isNext()
                    ? "border border-live/40 bg-live/15 text-live-400"
                    : "border border-border bg-accent text-white",
                )}
              >
                {formatted()}
              </span>
            );
          }}
        </For>
      </div>
    </div>
  );
}
