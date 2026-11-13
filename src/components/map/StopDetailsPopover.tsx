import { Show } from "solid-js";

import type { SurfaceStop } from "~/domain/surface/types";
import type { Point } from "~/core/map";

import { BaseMapPopover } from "./popovers/BaseMapPopover";
import { useI18n } from "~/i18n/I18nContext";

export interface StopDetailsPopoverProps {
  readonly stop: SurfaceStop;
  /** Whether this stop is the user's nearest stop (info chip). */
  readonly isNearest: boolean;
  /** Container coordinates of the selected stop; null suppresses render. */
  readonly coords: Point | null;
  readonly containerSize: { width: number; height: number };
  readonly onClose: () => void;
  readonly setRef: (element: HTMLDivElement) => void;
}

/**
 * Selected surface stop details: markup moved verbatim out of
 * NetworkMap so the canvas file stays a composition surface.
 */
export function StopDetailsPopover(props: StopDetailsPopoverProps) {
  const { t } = useI18n();
  return (
    <Show when={props.coords}>
      {(resolved) => (
        <BaseMapPopover
          coords={resolved()}
          containerSize={props.containerSize}
          topOffset={12}
          bottomOffset={12}
          onClose={props.onClose}
          setRef={props.setRef}
          ariaLabel={t("Stop {{name}}", { name: props.stop.name })}
          class="w-auto min-w-56 max-w-72 p-2.5"
        >
          <div class="flex items-start justify-between gap-2">
            <div class="min-w-0 flex-1">
              <div class="flex items-center gap-1.5 font-bold text-white text-xs">
                <span class="text-xs">🚏</span>
                <span class="truncate">{props.stop.name}</span>
              </div>
              <div class="text-[10px] text-muted-foreground mt-0.5 font-medium">
                {props.stop.code
                  ? t("Stop #{{code}}", { code: props.stop.code })
                  : t("ID: {{id}}", { id: props.stop.id })}
              </div>
              <Show when={props.isNearest}>
                <div class="mt-1.5 inline-flex items-center gap-1 px-1.5 py-0.5 rounded bg-info/15 text-info text-[10px] font-semibold">
                  <span>📍</span>
                  <span>{t("Nearest stop")}</span>
                </div>
              </Show>
              <Show when={props.stop.parentStation}>
                <div class="mt-1.5 text-[10.5px] text-warning-300/90 bg-warning/10 rounded px-1.5 py-0.5 font-medium">
                  <span>{t("Station:")} </span>
                  <span class="font-semibold text-warning-300">{props.stop.parentStation}</span>
                </div>
              </Show>
            </div>
            <button
              type="button"
              onClick={props.onClose}
              aria-label={t("Close stop details")}
              class="flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              <span aria-hidden="true" class="text-xs leading-none">
                ×
              </span>
            </button>
          </div>
        </BaseMapPopover>
      )}
    </Show>
  );
}
