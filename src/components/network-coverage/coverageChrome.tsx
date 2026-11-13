import type { PlainTranslationKey, Translator } from "~/i18n/translate";

/**
 * Small shared chrome for the coverage overlay.
 */
export function modeLabel(modes: readonly string[], t: Translator): string {
  if (modes.length === 0) return t("No mode");
  return modes.map((mode) => t(mode as PlainTranslationKey)).join(" · ");
}

export function CoverageCloseButton(props: {
  readonly onClose: () => void;
  readonly label: string;
}) {
  return (
    <button
      type="button"
      onClick={() => props.onClose()}
      aria-label={props.label}
      class="flex h-8 w-8 shrink-0 cursor-pointer items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground active:bg-accent"
    >
      <span aria-hidden="true" class="text-lg leading-none">
        ×
      </span>
    </button>
  );
}
