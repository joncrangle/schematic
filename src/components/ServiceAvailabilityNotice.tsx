import type { FreshnessState } from "~/agencies/types";
import { useI18n } from "~/i18n/I18nContext";
import { AlertIcon } from "./icons/AlertIcon";

export function ServiceAvailabilityNotice(props: {
  freshness?: FreshnessState;
  agencyName?: string;
}) {
  const { t } = useI18n();
  return (
    <div class="flex flex-col items-center justify-center px-6 py-10 text-center">
      <div class="mb-3 flex h-10 w-10 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground">
        <AlertIcon size={20} />
      </div>
      <p class="text-sm font-medium text-foreground">
        {props.freshness === "stale"
          ? t("Service alerts may be out of date")
          : t("Live alerts unavailable")}
      </p>
      <p class="mt-1 max-w-xs text-xs leading-relaxed text-muted-foreground">
        {t(
          "Live service updates aren't available for {{agency}} right now. Check their official website for current detours.",
          { agency: props.agencyName ?? "this transit agency" },
        )}
      </p>
    </div>
  );
}
