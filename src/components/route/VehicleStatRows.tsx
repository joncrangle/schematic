import { Show } from "solid-js";
import { useI18n } from "~/i18n/I18nContext";

export interface VehicleStatRowsProps {
  readonly speed?: string | null;
  readonly occupancy?: string | null;
}

/**
 * Speed/occupancy stat rows shared by the vehicle popovers.
 */
export function VehicleStatRows(props: VehicleStatRowsProps) {
  const { t } = useI18n();
  return (
    <div class="mt-1 flex flex-col gap-0.5 text-[11px] text-muted-foreground">
      <Show when={props.speed}>
        <div class="flex items-center justify-between">
          <span>{t("Speed")}</span>
          <span class="text-foreground">{props.speed}</span>
        </div>
      </Show>

      <Show when={props.occupancy}>
        <div class="flex items-center justify-between">
          <span>{t("Occupancy")}</span>
          <span class="text-foreground">{props.occupancy}</span>
        </div>
      </Show>
    </div>
  );
}
