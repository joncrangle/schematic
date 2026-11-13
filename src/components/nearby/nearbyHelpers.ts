import { distanceDisplay } from "~/i18n/regionalFormatting";
import { englishMessageFormatter, type MessageFormatter } from "~/i18n/translate";

/** Digital grace timer with the rider's numbering system and two-digit seconds. */
export function formatClockCountdown(
  seconds: number,
  formatter: Pick<MessageFormatter, "formatNumber"> = englishMessageFormatter,
): string {
  const total = Math.max(0, Math.floor(seconds));
  const minutes = formatter.formatNumber(Math.floor(total / 60), { useGrouping: false });
  const remainder = formatter.formatNumber(total % 60, {
    useGrouping: false,
    minimumIntegerDigits: 2,
  });
  return `${minutes}:${remainder}`;
}

/**
 * Calculates remaining seconds until arrival, clamping past times to 0.
 */
export function calculateSecondsRemaining(
  arrivalTimeMs: number,
  nowMs: number = Date.now(),
): number {
  const diffMs = arrivalTimeMs - nowMs;
  if (diffMs <= 0) return 0;
  return Math.floor(diffMs / 1000);
}

/**
 * Formats epoch arrival timestamp into a user-facing ticker ("Due", "3 min", "11 min").
 */
export function formatCountdown(
  arrivalTimeMs: number,
  nowMs: number = Date.now(),
  formatter: MessageFormatter = englishMessageFormatter,
): string {
  const seconds = calculateSecondsRemaining(arrivalTimeMs, nowMs);
  if (seconds <= 60) {
    return formatter.t("Due");
  }
  const minutes = Math.round(seconds / 60);
  return formatter.plural("Minutes short", minutes);
}

/**
 * Formats distance ("110m away" or "1.2 km away").
 */
export function formatDistance(
  distanceMeters: number,
  formatter: MessageFormatter = englishMessageFormatter,
): string {
  return formatter.t("{{distance}} away", {
    distance: formatDistanceValue(distanceMeters, formatter),
  });
}

import { getAgencyById } from "~/agencies/browserRegistry";
import { contrastTextColorForLine } from "~/domain/lineColors";
import {
  DEFAULT_SURFACE_ROUTE_COLOR,
  SURFACE_MODE_COLORS,
  type SurfaceRouteType,
} from "~/domain/surface/types";

/**
 * Resolves agency badge style object dynamically from the agency manifest,
 * ensuring no individual agency colors or IDs are hardcoded in core.
 */
export function agencyBadgeStyle(agencyId: string): {
  "background-color": string;
  color: string;
  "border-color": string;
} {
  const provider = getAgencyById(agencyId);
  const color = provider?.brandColor ?? "#4b5563";
  const textColor = provider?.brandTextColor ?? contrastTextColorForLine(color);
  return {
    "background-color": color,
    color: textColor,
    "border-color": color,
  };
}

/**
 * Resolves route badge styling dynamically with full line/brand color support
 * from the route or agency topology without hardcoded agency logic in core.
 */
export function routeBadgeStyle(params: {
  agencyId?: string;
  routeColor?: string;
  routeTextColor?: string;
  routeId?: string;
  routeShortName?: string;
  routeLongName?: string;
  routeType?: string;
}): {
  "background-color": string;
  color: string;
} {
  const { agencyId = "", routeColor, routeTextColor, routeType } = params;

  if (routeColor) {
    const textColor = routeTextColor || contrastTextColorForLine(routeColor);
    return {
      "background-color": routeColor,
      color: textColor,
    };
  }

  if (agencyId) {
    const provider = getAgencyById(agencyId);
    if (provider?.brandColor) {
      const color = provider.brandColor;
      const textColor = provider.brandTextColor ?? contrastTextColorForLine(color);
      return {
        "background-color": color,
        color: textColor,
      };
    }
  }

  const modeColor = routeType ? SURFACE_MODE_COLORS[routeType as SurfaceRouteType] : undefined;
  const fallback = modeColor || DEFAULT_SURFACE_ROUTE_COLOR;
  return {
    "background-color": fallback,
    color: contrastTextColorForLine(fallback),
  };
}

/** Shared distance label for cards and search-radius copy; input remains metres. */
export function formatDistanceValue(
  distanceMeters: number,
  formatter: MessageFormatter = englishMessageFormatter,
): string {
  const display = distanceDisplay(distanceMeters, formatter.unitSystem?.() ?? "metric");
  const number = formatter.formatNumber(display.value, {
    useGrouping: false,
    minimumFractionDigits: display.fractionDigits,
    maximumFractionDigits: display.fractionDigits,
  });
  return `${number}${display.unit === "m" ? "" : " "}${display.unit}`;
}
