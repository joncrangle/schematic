import * as Schema from "effect/Schema";
const id = Schema.Union([Schema.String, Schema.Number]);
const alertsSchema = Schema.Array(
  Schema.Struct({
    id,
    effect: Schema.String,
    contents: Schema.Array(
      Schema.Struct({ lang: Schema.String, header: Schema.String, description: Schema.String }),
    ),
    periods: Schema.Array(
      Schema.Struct({ is_active: Schema.Boolean, start: Schema.String, end: Schema.String }),
    ),
    targets: Schema.Array(
      Schema.Struct({
        route: Schema.optional(Schema.NullOr(Schema.Struct({ real_route_id: id }))),
        stops: Schema.optional(Schema.Array(Schema.Struct({ real_stop_id: id }))),
        trip: Schema.optional(Schema.NullOr(Schema.Struct({ real_trip_id: id }))),
      }),
    ),
  }),
);
/** Preserve published route/stop pairs and each impact window without widening stop closures. */
export function normalizeHubupAlerts(payload: unknown) {
  const rows = Schema.decodeUnknownSync(alertsSchema)(payload);
  const alerts = rows.flatMap((row) => {
    const content = row.contents.find((c) => c.lang === "fr") ?? row.contents[0];
    if (!content?.header.trim() || !row.periods.length)
      throw new Error("Incomplete Hubup advisory");
    const targets = row.targets.flatMap((t) => {
      const routeId = t.route ? String(t.route.real_route_id) : undefined;
      const tripId = t.trip ? String(t.trip.real_trip_id) : undefined;
      return t.stops?.length
        ? t.stops.map((s) => ({
            ...(routeId ? { routeId } : {}),
            ...(tripId ? { tripId } : {}),
            stopId: String(s.real_stop_id),
          }))
        : routeId || tripId
          ? [{ ...(routeId ? { routeId } : {}), ...(tripId ? { tripId } : {}) }]
          : [];
    });
    if (row.targets.length && !targets.length) throw new Error("Unknown Hubup advisory target");
    return row.periods.flatMap((period, i) => {
      if (!period.is_active) return [];
      if (!period.start || !period.end || period.end <= period.start)
        throw new Error("Invalid Hubup advisory period");
      return [
        {
          id: `${row.id}:${i}`,
          title: content.header,
          description: content.description,
          effect: row.effect,
          targets,
          activePeriod: { start: period.start, end: period.end },
        },
      ];
    });
  });
  return { alerts, partial: false };
}
