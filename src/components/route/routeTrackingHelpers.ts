import type { OccupancyStatus, SurfaceRouteType } from "~/domain/surface/types";
import { BusIcon, StreetcarIcon, ExpressIcon, RailIcon } from "~/components/icons/TransitIcons";
import { englishMessageFormatter, type MessageFormatter } from "~/i18n/translate";

export function getSurfaceModeMeta(
  routeType: SurfaceRouteType = "bus",
  formatter: MessageFormatter = englishMessageFormatter,
): {
  icon: typeof BusIcon;
  name: string;
  badgeBg: string;
  badgeText: string;
  /** Canonical icon tint, express rides the warning accent everywhere. */
  iconClass: string;
} {
  if (routeType === "streetcar") {
    return {
      icon: StreetcarIcon,
      name: formatter.t("streetcar"),
      badgeBg: "bg-[#64748B]",
      badgeText: "text-white",
      iconClass: "text-white",
    };
  }
  if (routeType === "express") {
    return {
      icon: ExpressIcon,
      name: formatter.t("express"),
      badgeBg: "bg-live",
      badgeText: "text-white",
      iconClass: "text-warning-400",
    };
  }
  if (routeType === "rail") {
    return {
      icon: RailIcon,
      name: formatter.t("rail"),
      badgeBg: "bg-[#00853F]",
      badgeText: "text-white",
      iconClass: "text-white",
    };
  }
  return {
    icon: BusIcon,
    name: formatter.t("bus"),
    badgeBg: "bg-accent border border-destructive/60",
    badgeText: "text-white",
    iconClass: "text-white",
  };
}

/**
 * Translates GTFS-RT OccupancyStatus enum into human-friendly strings.
 */
export function formatOccupancyStatus(
  status?: OccupancyStatus | string,
  formatter: MessageFormatter = englishMessageFormatter,
): string | null {
  if (!status) return null;

  switch (status) {
    case "EMPTY":
      return formatter.t("Empty");
    case "MANY_SEATS_AVAILABLE":
      return formatter.t("Many seats available");
    case "FEW_SEATS_AVAILABLE":
      return formatter.t("Few seats available");
    case "STANDING_ROOM_ONLY":
      return formatter.t("Standing room only");
    case "CRUSHED_STANDING_ROOM_ONLY":
      return formatter.t("Crowded");
    case "FULL":
      return formatter.t("Full");
    case "NOT_ACCEPTING_PASSENGERS":
      return formatter.t("Not in service");
    default:
      return null;
  }
}

/**
 * Formats metric feed velocity in the rider's distance units.
 */
export function formatVehicleSpeed(
  speedMps?: number,
  formatter: MessageFormatter = englishMessageFormatter,
): string | null {
  if (speedMps === undefined || speedMps === null) return null;
  if (speedMps <= 0.5) return formatter.t("Stopped");
  const imperial = formatter.unitSystem?.() === "imperial";
  const speed = Math.round(speedMps * (imperial ? 3.6 / 1.609344 : 3.6));
  return formatter.t(imperial ? "{{speed}} mph" : "{{speed}} km/h", {
    speed: formatter.formatNumber(speed, { useGrouping: false }),
  });
}

/** Formats the semantic public label for a surface route vehicle. */
export function formatSurfaceVehicleLabel(
  routeShortName: string | undefined,
  routeType: SurfaceRouteType = "bus",
  formatter: MessageFormatter = englishMessageFormatter,
): string {
  const routeName = routeShortName?.trim();
  const modeName = getSurfaceModeMeta(routeType, formatter).name;
  return routeName
    ? formatter.t("{{mode}} {{route}}", { mode: modeName, route: routeName })
    : modeName;
}

/** Formats stops-away banner copy using the public route label. */
export function formatStopsAwayText(
  routeShortName: string,
  stopsAway: number,
  minutesAway?: number,
  routeType: SurfaceRouteType = "bus",
  formatter: MessageFormatter = englishMessageFormatter,
): string {
  const publicLabel = formatSurfaceVehicleLabel(routeShortName, routeType, formatter);

  let distanceDesc = "";
  if (stopsAway === 0) {
    distanceDesc = formatter.t("Arriving now");
  } else if (stopsAway === 1) {
    distanceDesc = formatter.plural("Stops away", stopsAway);
  } else if (stopsAway > 1) {
    distanceDesc = formatter.plural("Stops away", stopsAway);
  } else {
    distanceDesc = formatter.t("Departed");
  }

  const timeDesc =
    minutesAway !== undefined
      ? minutesAway <= 1
        ? formatter.t("Due")
        : formatter.plural("Minutes short", minutesAway)
      : "";

  return timeDesc
    ? formatter.t("Vehicle arrival summary with time", {
        route: publicLabel,
        arrival: distanceDesc,
        time: timeDesc,
      })
    : formatter.t("Vehicle arrival summary", {
        route: publicLabel,
        arrival: distanceDesc,
      });
}
