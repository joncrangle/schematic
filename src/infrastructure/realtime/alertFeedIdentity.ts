import type { GenericAlert } from "~/agencies/types";
import { namespaceFeedId } from "../gtfs/feedIdentity";

/** Source identity policy applies equally to JSON and protobuf representations. */
export function applyAlertFeedIdentity(
  alert: GenericAlert,
  options: {
    idNamespace?: string;
    stopAliases?: ReadonlyMap<string, string>;
    ignoredStopIds?: readonly string[];
  },
): GenericAlert {
  const id = (value: string) => namespaceFeedId(value, options.idNamespace);
  const ignored = new Set((options.ignoredStopIds ?? []).map(id));
  const stop = (value: string | undefined) =>
    value === undefined
      ? undefined
      : ignored.has(id(value))
        ? undefined
        : (options.stopAliases?.get(id(value)) ?? id(value));
  return {
    ...alert,
    id: id(alert.id),
    ...(alert.routeIds ? { routeIds: alert.routeIds.map(id) } : {}),
    ...(alert.tripIds ? { tripIds: alert.tripIds.map(id) } : {}),
    ...(alert.affectedStations
      ? {
          affectedStations: alert.affectedStations
            .map(stop)
            .filter((value): value is string => value !== undefined),
        }
      : {}),
    ...(alert.targets
      ? {
          targets: alert.targets.map((target) => ({
            ...target,
            ...(target.routeId ? { routeId: id(target.routeId) } : {}),
            stopId: stop(target.stopId),
          })),
        }
      : {}),
  };
}
