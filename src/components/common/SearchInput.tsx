import { Show } from "solid-js";
import type { JSX } from "@solidjs/web";
import { cn } from "~/lib/utils";
import { createKeyHandler } from "~/lib/keyboard";
import { useI18n } from "~/i18n/I18nContext";

export interface SearchInputProps {
  readonly value: string;
  readonly onInput: (value: string) => void;
  readonly onEnter?: () => void;
  readonly onEscape?: () => void;
  readonly onClear?: () => void;
  readonly placeholder?: string;
  readonly ariaLabel?: string;
  readonly clearAriaLabel?: string;
  readonly class?: string;
  readonly inputClass?: string;
  readonly autoFocus?: boolean;
  readonly ref?: (el: HTMLInputElement) => void;
}

/**
 * Reusable search input with integrated clear button and Enter/Escape keyboard handling.
 */
export function SearchInput(props: SearchInputProps): JSX.Element {
  const { t } = useI18n();
  const clear = () => {
    if (props.onClear) {
      props.onClear();
    } else {
      props.onInput("");
    }
  };

  const handleKeyDown = createKeyHandler({
    onEscape: () => {
      if (props.onEscape) {
        props.onEscape();
      } else if (props.value) {
        clear();
      }
    },
    onEnter: () => {
      props.onEnter?.();
    },
  });

  return (
    <div class={cn("relative flex items-center", props.class)}>
      <input
        ref={props.ref}
        type="text"
        value={props.value}
        onInput={(e) => props.onInput(e.currentTarget.value)}
        onKeyDown={handleKeyDown}
        placeholder={props.placeholder}
        aria-label={props.ariaLabel}
        autofocus={props.autoFocus}
        class={cn(
          "w-full rounded-lg border border-border bg-card px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground outline-none focus:border-info focus:ring-1 focus:ring-info",
          props.inputClass,
        )}
      />
      <Show when={props.value.length > 0}>
        <button
          type="button"
          onClick={clear}
          aria-label={props.clearAriaLabel ?? t("Clear search")}
          class="absolute right-2.5 flex h-4 w-4 cursor-pointer items-center justify-center rounded text-xs text-muted-foreground transition-colors hover:text-foreground active:text-foreground"
        >
          ✕
        </button>
      </Show>
    </div>
  );
}
