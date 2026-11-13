import type { JSX } from "@solidjs/web";
import { For } from "solid-js";
import { cn } from "~/lib/utils";

export interface SelectOption {
  readonly value: string;
  readonly label: string;
}

export interface SelectProps {
  readonly id?: string;
  readonly ariaLabel: string;
  readonly describedBy?: string;
  readonly value: string;
  readonly options: readonly SelectOption[];
  readonly onChange: (value: string) => void;
  readonly class?: string;
}

export function Select(props: SelectProps): JSX.Element {
  return (
    <div class={cn("relative min-w-0", props.class)}>
      <select
        id={props.id}
        aria-label={props.ariaLabel}
        aria-describedby={props.describedBy}
        value={props.value}
        onChange={(event) => props.onChange(event.currentTarget.value)}
        class={cn(
          "h-9 w-full cursor-pointer appearance-none",
          "rounded-md border border-border",
          "bg-background py-2 pr-9 pl-3",
          "text-sm font-medium text-foreground",
          "shadow-xs outline-none",
          "transition-[border-color,box-shadow] duration-150",
          "hover:border-muted-foreground/50",
          "focus-visible:border-info",
          "focus-visible:ring-2 focus-visible:ring-info/20",
          "disabled:cursor-not-allowed disabled:opacity-50",
        )}
      >
        <For each={props.options}>
          {(option) => (
            <option value={option.value} class="bg-background py-2 text-foreground">
              {option.label}
            </option>
          )}
        </For>
      </select>

      <svg
        aria-hidden="true"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.75"
        stroke-linecap="round"
        stroke-linejoin="round"
        class={cn(
          "pointer-events-none absolute top-1/2 right-3",
          "size-4 -translate-y-1/2",
          "text-muted-foreground",
        )}
      >
        <path d="m7 10 5 5 5-5" />
      </svg>
    </div>
  );
}
