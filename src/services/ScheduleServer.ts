import "server-only";
import catalog from "~/generated/gtfs-schedules.json";
import { createStaticScheduleResolver } from "~/infrastructure/gtfs/schedules/resolve";
import { staticAssetCache } from "./StaticAssetServer";

let resolve: ReturnType<typeof createStaticScheduleResolver> | undefined;

export function getScheduledStopTimes(agencyId: string, timezone: string, now: () => number) {
  if (!Object.hasOwn(catalog.agencies, agencyId)) return undefined;
  resolve ??= createStaticScheduleResolver({ catalog, cache: staticAssetCache });
  return resolve(agencyId, timezone, now);
}
