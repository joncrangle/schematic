import { createMemo, createSignal, onSettled, Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";
import { useI18n } from "~/i18n/I18nContext";
import type { Point } from "~/core/map";
import { calculatePopoverPosition } from "./popoverPosition";
import { useEscapeKey } from "~/lib/keyboard";

export interface BaseMapPopoverProps {
  coords: Point | null | undefined;
  containerSize?: { width: number; height: number };
  topOffset?: number;
  bottomOffset?: number;
  padding?: number;
  hasArrow?: boolean;
  onClose: () => void;
  setRef?: (element: HTMLDivElement) => void;
  ariaLabel: string;
  class?: string;
  header?: JSX.Element;
  children: JSX.Element;
}

export function BaseMapPopover(props: BaseMapPopoverProps) {
  const { t } = useI18n();
  let popoverEl: HTMLDivElement | undefined;

  useEscapeKey(
    () => props.onClose(),
    () => Boolean(position()),
  );

  const [popoverSize, setPopoverSize] = createSignal<{ width: number; height: number }>({
    width: 288,
    height: 200,
  });

  const updatePopoverSize = () => {
    if (popoverEl) {
      const rect = popoverEl.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        setPopoverSize({ width: rect.width, height: rect.height });
      }
    }
  };

  onSettled(() => {
    if (popoverEl) {
      updatePopoverSize();

      if (typeof ResizeObserver !== "undefined") {
        const resizeObserver = new ResizeObserver(() => {
          updatePopoverSize();
        });
        resizeObserver.observe(popoverEl);

        return () => {
          resizeObserver.disconnect();
        };
      }
    }
  });

  const containerSize = () => {
    if (props.containerSize && props.containerSize.width > 0 && props.containerSize.height > 0) {
      return props.containerSize;
    }

    if (popoverEl?.parentElement) {
      const parentRect = popoverEl.parentElement.getBoundingClientRect();
      if (parentRect.width > 0 && parentRect.height > 0) {
        return { width: parentRect.width, height: parentRect.height };
      }
    }

    if (typeof window !== "undefined") {
      return { width: window.innerWidth, height: window.innerHeight };
    }

    return { width: 0, height: 0 };
  };

  const position = createMemo(() => {
    const coords = props.coords;
    if (!coords) {
      return null;
    }

    return calculatePopoverPosition(coords, popoverSize(), containerSize(), {
      topOffset: props.topOffset ?? 8,
      bottomOffset: props.bottomOffset ?? props.topOffset ?? 8,
      padding: props.padding ?? 12,
    });
  });

  return (
    <Show when={position()}>
      {(pos) => (
        <div
          // Measure in onSettled, not here: the element is still detached, and a
          // size write while Show builds this child rebuilds it in a loop.
          ref={(el) => {
            popoverEl = el;
            props.setRef?.(el);
          }}
          role="dialog"
          aria-modal="false"
          aria-label={props.ariaLabel}
          tabindex={-1}
          style={{
            left: `${pos().x}px`,
            top: `${pos().y}px`,
          }}
          class={cn(
            "absolute z-50 rounded-xl border border-border bg-card p-3 text-foreground shadow-2xl animate-in fade-in zoom-in-95 duration-150 flex flex-col pointer-events-auto touch-pan-y max-w-[calc(100%-24px)] max-h-[calc(100%-24px)] box-border",
            props.class,
          )}
          onWheel={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
          onTouchStart={(event) => event.stopPropagation()}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.stopPropagation();
              props.onClose();
            }
          }}
        >
          <Show when={props.header}>
            <div class="mb-2 flex items-center justify-between border-b border-border pb-2 shrink-0">
              <div class="min-w-0 flex-1">{props.header}</div>
              <button
                type="button"
                onClick={props.onClose}
                aria-label={t("Close {{name}}", { name: props.ariaLabel })}
                class="ml-2 flex h-5 w-5 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <span aria-hidden="true" class="text-xs leading-none">
                  ×
                </span>
              </button>
            </div>
          </Show>

          {props.children}

          <Show when={props.hasArrow}>
            <div
              aria-hidden="true"
              class={cn(
                "absolute h-3 w-3 -translate-x-1/2 rotate-45 border-border bg-card",
                pos().placement === "top"
                  ? "-bottom-1.5 border-b border-r"
                  : "-top-1.5 border-t border-l",
              )}
              style={{
                left: `${pos().arrowLeft}px`,
              }}
            />
          </Show>
        </div>
      )}
    </Show>
  );
}
