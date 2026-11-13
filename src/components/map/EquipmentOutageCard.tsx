import { For, Show } from "solid-js";
import { cn } from "~/lib/utils";
import { AlertIcon } from "~/components/icons/AlertIcon";
import type { EquipmentOutage } from "~/domain/stationAlerts";
import { useI18n } from "~/i18n/I18nContext";

export interface EquipmentOutageCardProps {
  title: string;
  items: readonly EquipmentOutage[];
  class?: string;
}

export function EquipmentOutageCard(props: EquipmentOutageCardProps) {
  const { formatNumber, t } = useI18n();

  return (
    <Show when={props.items.length > 0}>
      <Show
        when={props.items.length > 1}
        fallback={
          <div
            class={cn(
              "mt-1 flex items-start gap-1.5 rounded bg-warning/10 p-1.5 border border-warning/25 text-warning-300",
              props.class,
            )}
          >
            <AlertIcon size={12} class="mt-0.5 text-warning-400" />
            <span class="text-[10px] leading-tight">{props.items[0]?.rawText}</span>
          </div>
        }
      >
        <div
          class={cn(
            "mt-1 flex flex-col gap-1 rounded bg-warning/10 p-2 border border-warning/25 text-warning-300",
            props.class,
          )}
        >
          <div class="flex items-center gap-1.5 font-semibold text-warning-300 text-[11px]">
            <AlertIcon size={13} class="text-warning-400" />
            <span>
              {t("Equipment outage group heading", {
                title: props.title,
                count: formatNumber(props.items.length),
              })}
            </span>
          </div>
          <ul class="flex flex-col gap-1 pl-4 list-disc text-[10px] leading-tight text-warning-300/90">
            <For each={props.items}>
              {(item) => (
                <li>
                  <span class="font-medium text-warning-300">{item.equipment}</span>
                  {item.location ? `: ${item.location}` : ""}
                </li>
              )}
            </For>
          </ul>
        </div>
      </Show>
    </Show>
  );
}
