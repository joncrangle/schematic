import { parseWallClock } from "./wallClock";

type RecordValue = Record<string, unknown>;
function object(value: unknown): RecordValue {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid notice object");
  return value as RecordValue;
}
function array(value: unknown): unknown[] {
  if (!Array.isArray(value)) throw new Error("Invalid notice collection");
  return value;
}
function text(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("Invalid notice text");
  return value;
}
function optionalText(value: unknown): string | undefined {
  return value == null ? undefined : text(value);
}
function relation(value: RecordValue, key: string): RecordValue[] {
  return array(object(object(value.relationships)[key]).data).map(object);
}
function wallTime(value: unknown): string {
  const result = text(value).replace(" ", "T") + "Z";
  parseWallClock(result.slice(0, -1).replace("T", " "), "UTC");
  return result;
}

function publicationTime(value: string): number {
  if (
    !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d{1,3})?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/.test(
      value,
    )
  )
    throw new Error("Invalid publication timestamp");
  parseWallClock(value.slice(0, 19).replace("T", " "), "UTC");
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) throw new Error("Invalid publication timestamp");
  return epoch;
}

/** Bucketed closures retain their route/stop pairs and each published active window. */
export function normalizeBucketedTransitAlerts(payload: unknown) {
  const board = object(payload);
  const alerts = ["cancelled_stops", "cancelled_trips", "significant_delays", "other"].flatMap(
    (bucket) =>
      array(board[bucket]).flatMap((entry) => {
        const item = object(entry);
        const tripIds: string[] = [];
        const targets = array(item.entities).flatMap((entry) => {
          const entity = object(entry);
          const routeId = optionalText(entity.route_id),
            stopId = optionalText(entity.stop_id);
          const tripId = optionalText(entity.trip_id);
          if (tripId) tripIds.push(tripId);
          if (!routeId && !stopId && !tripId) throw new Error("Notice entity has no scope");
          return routeId || stopId
            ? [{ ...(routeId ? { routeId } : {}), ...(stopId ? { stopId } : {}) }]
            : [];
        });
        if (!targets.length && !tripIds.length) throw new Error("Transit notice has no entities");
        const periods = array(item.periods);
        if (!periods.length) throw new Error("Transit notice has no periods");
        return periods.map((entry, index) => {
          const period = object(entry),
            start = wallTime(period.start);
          let end = period.end == null ? undefined : wallTime(period.end);
          // Some boards express an overnight window with the same calendar date.
          if (end && end < start && end.slice(0, 10) === start.slice(0, 10))
            end = new Date(Date.parse(end) + 86400000).toISOString().replace(".000Z", "Z");
          if (end && end < start) throw new Error("Reversed notice period");
          return {
            id: `${text(item.id)}:${index}`,
            title: text(item.headline),
            description: text(item.description),
            effect: text(item.effect),
            routes: [...new Set(targets.flatMap((t) => (t.routeId ? [t.routeId] : [])))],
            stops: [...new Set(targets.flatMap((t) => (t.stopId ? [t.stopId] : [])))],
            targets,
            stopScoped: targets.length > 0 && targets.every((t) => Boolean(t.stopId)),
            ...(tripIds.length ? { tripIds: [...new Set(tripIds)], tripScoped: true } : {}),
            activePeriod: { start, ...(end ? { end } : {}) },
          };
        });
      }),
  );
  return { alerts, partial: false };
}

/** Resolves a complete Drupal notice document without widening stop notices to routes. */
export function normalizeJsonApiTransitNotices(payload: unknown) {
  const board = object(payload),
    data = array(board.data).map(object);
  const included = new Map(
    array(board.included ?? (data.length === 0 ? [] : undefined)).map((entry) => {
      const item = object(entry);
      return [`${text(item.type)}:${text(item.id)}`, item] as const;
    }),
  );
  const resolve = (ref: RecordValue) => {
    const item = included.get(`${text(ref.type)}:${text(ref.id)}`);
    if (!item) throw new Error("Incomplete notice relationships");
    return item;
  };
  const alerts = data.map((item) => {
    const attributes = object(item.attributes);
    const title = text(attributes.title);
    if (typeof attributes.general !== "boolean") throw new Error("Invalid notice scope");
    const stops: string[] = [],
      descriptions: string[] = [];
    const alternatives: { id: string; name: string }[] = [];
    const descriptionOf = (item: RecordValue) => {
      const a = item.attributes == null ? {} : object(item.attributes);
      const value = a.description;
      if (typeof value === "string" && value.trim()) descriptions.push(value);
      else if (value && typeof value === "object") {
        const body = object(value).value;
        if (typeof body === "string" && body.trim()) descriptions.push(body);
      }
    };
    const targets = relation(item, "parcours").flatMap((ref) => {
      const paragraph = resolve(ref);
      descriptionOf(paragraph);
      const closed = relation(paragraph, "arrets").flatMap((ref) => {
        const block = resolve(ref);
        descriptionOf(block);
        for (const ref of relation(block, "arrets_suggeres")) {
          const a = object(resolve(ref).attributes),
            code = text(a.name);
          alternatives.push({
            id: code,
            name: typeof a.name_stop === "string" ? a.name_stop : code,
          });
        }
        return relation(block, "arrets_non_desservis").map((ref) => {
          const a = object(resolve(ref).attributes),
            code = text(a.name);
          return { code, name: typeof a.name_stop === "string" ? a.name_stop : code };
        });
      });
      for (const stop of closed) if (!stops.includes(stop.name)) stops.push(stop.name);
      return relation(paragraph, "routes").flatMap((ref) => {
        const route = object(resolve(ref).attributes),
          routeId = text(route.name),
          direction = text(route.code_direction);
        if (direction !== "0" && direction !== "1") throw new Error("Invalid notice direction");
        const target = { routeId, directionId: Number(direction) };
        return closed.length
          ? closed.map((stop) => ({ ...target, stopCode: stop.code, stopId: stop.name }))
          : [target];
      });
    });
    if (!attributes.general && !targets.length) throw new Error("Notice has no scope");
    const start = optionalText(attributes.date_notice_start),
      end = optionalText(attributes.date_notice_end);
    if (
      (start && !Number.isFinite(publicationTime(start))) ||
      (end && !Number.isFinite(publicationTime(end))) ||
      (start && end && publicationTime(end) < publicationTime(start))
    )
      throw new Error("Invalid notice period");
    const body = attributes.body == null ? undefined : optionalText(object(attributes.body).value);
    const subtitle = typeof attributes.subtitle === "string" ? attributes.subtitle.trim() : "";
    return {
      id: text(item.id),
      title,
      description: [subtitle, body, ...descriptions].filter(Boolean).join("\n\n") || title,
      ...(alternatives.length ? { alternate_stops: alternatives } : {}),
      routes: [...new Set(targets.map((t) => t.routeId))],
      stops,
      targets,
      stopScoped: stops.length > 0,
      affectsAllRoutes: attributes.general,
      activePeriod: { ...(start ? { start } : {}), ...(end ? { end } : {}) },
    };
  });
  const count = object(board.meta).count;
  if (typeof count !== "number" || count < 0) throw new Error("Missing notice count");
  const links = board.links == null ? {} : object(board.links);
  return { alerts, partial: count !== data.length || links.next != null };
}
