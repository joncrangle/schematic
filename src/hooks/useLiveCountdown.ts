import { formatCountdown, calculateSecondsRemaining } from "~/components/nearby/nearbyHelpers";
import { useI18n } from "~/i18n/I18nContext";
import { useAppClock } from "~/lib/appClock";

export function useLiveCountdown() {
  const formatter = useI18n();
  const now = useAppClock();

  return {
    now,
    formatCountdown: (arrivalTimeMs: number) => formatCountdown(arrivalTimeMs, now(), formatter),
    getSecondsRemaining: (arrivalTimeMs: number) => calculateSecondsRemaining(arrivalTimeMs, now()),
  };
}
