import { normalizeCardinalDirection } from "~/domain/surface/direction/cardinal";
import * as Schema from "effect/Schema";
import type { SourceAgencyScope } from "~/domain/surface/boarding";

const Epoch = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Text = Schema.Struct({ language: Schema.String, text: Schema.NullOr(Schema.String) });
const Selector = Schema.Struct({
  route_short_name: Schema.optional(Schema.String),
  stop_code: Schema.optional(Schema.String),
  direction_id: Schema.optional(Schema.String),
});
const Document = Schema.Struct({
  header: Schema.Struct({ timestamp: Epoch }),
  alerts: Schema.Array(
    Schema.Struct({
      active_periods: Schema.Struct({
        start: Schema.NullOr(Epoch),
        end: Schema.NullOr(Epoch),
      }),
      informed_entities: Schema.Array(Selector),
      header_texts: Schema.Array(Text),
      description_texts: Schema.Array(Text),
      cause: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
      effect: Schema.NullOr(Schema.Union([Schema.String, Schema.Number])),
    }),
  ),
});

type I3Alert = Schema.Schema.Type<typeof Document>["alerts"][number];

function selectorTokens(alert: I3Alert, field: "route_short_name" | "direction_id"): string[] {
  return [
    ...new Set(
      alert.informed_entities.flatMap((selector) => {
        const value = selector[field]?.trim();
        return value
          ? [
              field === "direction_id"
                ? (normalizeCardinalDirection(value) ?? value.toLowerCase())
                : value,
            ]
          : [];
      }),
    ),
  ];
}

/** Only a complete stop list covered for the same scope and period is redundant. */
function coveredStopSummary(
  alert: I3Alert,
  remainder: string,
  details: ReadonlyMap<string, readonly I3Alert[]>,
): boolean {
  const lines = remainder.trim().split(/\r?\n/u);
  const codes = lines.map((line) => /^([^\s()]+) \([^\r\n]+\)$/u.exec(line.trim())?.[1]);
  if (codes.some((code) => !code)) return false;
  if (
    alert.informed_entities.some((s) => s.stop_code?.trim() && !codes.includes(s.stop_code.trim()))
  )
    return false;
  const routes = selectorTokens(alert, "route_short_name");
  const directions = selectorTokens(alert, "direction_id");
  return codes.every((code) =>
    (routes.length ? routes : [""]).every((route) =>
      (directions.length ? directions : [""]).every((direction) =>
        (details.get(code!) ?? []).some((detail) => {
          const dr = selectorTokens(detail, "route_short_name"),
            dd = selectorTokens(detail, "direction_id");
          const p = detail.active_periods,
            s = alert.active_periods;
          return (
            (!dr.length || dr.includes(route)) &&
            (!dd.length || dd.includes(direction)) &&
            (p.start === null || (s.start !== null && p.start <= s.start)) &&
            (p.end === null || (s.end !== null && p.end >= s.end))
          );
        }),
      ),
    ),
  );
}

/** i3 publishes selector dimensions separately; combine them without widening stop scope. */
export function normalizeI3ServiceStatus(
  payload: unknown,
  policy: {
    readonly excludedDescriptionPrefixes?: readonly string[];
    readonly redundantSummaryPrefixes?: readonly string[];
  } = {},
) {
  const document = Schema.decodeUnknownSync(Document)(payload);
  const excluded = (policy.excludedDescriptionPrefixes ?? []).map((prefix) =>
    prefix.trim().toLowerCase(),
  );
  const summaries = (policy.redundantSummaryPrefixes ?? []).map((prefix) =>
    prefix.trim().toLowerCase(),
  );
  const details = new Map<string, I3Alert[]>();
  for (const alert of document.alerts) {
    if (
      alert.description_texts.some(
        (t) =>
          t.text && summaries.some((prefix) => t.text!.trim().toLowerCase().startsWith(prefix)),
      )
    )
      continue;
    for (const selector of alert.informed_entities) {
      const code = selector.stop_code?.trim();
      if (code) {
        const entries = details.get(code) ?? [];
        entries.push(alert);
        details.set(code, entries);
      }
    }
  }
  return {
    header: { gtfs_realtime_version: "2.0", timestamp: document.header.timestamp },
    entity: document.alerts.flatMap((alert) => {
      const routes = [
        ...new Set(
          alert.informed_entities.flatMap((s) =>
            s.route_short_name?.trim() ? [s.route_short_name.trim()] : [],
          ),
        ),
      ];
      const stops = [
        ...new Set(
          alert.informed_entities.flatMap((s) => (s.stop_code?.trim() ? [s.stop_code.trim()] : [])),
        ),
      ];
      const directions = [
        ...new Set(
          alert.informed_entities.flatMap((s) => {
            const word = s.direction_id?.trim().toLowerCase();
            if (!word) return [];
            if (word === "0" || word === "1") return [word];
            const cardinal = normalizeCardinalDirection(word);
            if (cardinal) return [cardinal];
            throw new Error("Unrecognized i3 direction");
          }),
        ),
      ];
      if (!routes.length && !stops.length) throw new Error("i3 alert has no route or stop scope");
      if (![...alert.header_texts, ...alert.description_texts].some((t) => t.text?.trim()))
        throw new Error("i3 alert has no text");
      const { start, end } = alert.active_periods;
      if (start !== null && end !== null && end < start)
        throw new Error("Invalid i3 active period");
      const descriptions = alert.description_texts.flatMap((t) =>
        t.text?.trim() ? [t.text.trim()] : [],
      );
      if (
        descriptions.length &&
        descriptions.every(
          (text) =>
            (stops.length > 0 &&
              excluded.some((prefix) => text.toLowerCase().startsWith(prefix))) ||
            summaries.some(
              (prefix) =>
                text.toLowerCase().startsWith(prefix) &&
                coveredStopSummary(alert, text.slice(prefix.length), details),
            ),
        )
      )
        return [];
      return [
        {
          alert: {
            active_period: [{ start, end }],
            informed_entity: (routes.length ? routes : [undefined]).flatMap((route_id) =>
              (stops.length ? stops : [undefined]).flatMap((stop_id) =>
                (directions.length ? directions : [undefined]).map((direction_id) => ({
                  route_id,
                  stop_id,
                  direction_id,
                })),
              ),
            ),
            header_text: { translation: alert.header_texts },
            description_text: { translation: alert.description_texts },
            cause: alert.cause,
            effect: alert.effect,
          },
        },
      ];
    }),
  };
}

/** Unknown tokens retain their dimension and cannot accidentally match a canonical line. */
export function resolveI3Identities(
  document: ReturnType<typeof normalizeI3ServiceStatus>,
  scope: SourceAgencyScope,
) {
  if (!scope.routesByShortName || !scope.stopsByCode)
    throw new Error("i3 alerts require seeded identity indexes");
  return {
    ...document,
    entity: document.entity.map((entity) => ({
      alert: {
        ...entity.alert,
        informed_entity: entity.alert.informed_entity.flatMap((s) => {
          const routes =
            s.route_id === undefined
              ? [undefined]
              : (scope.routesByShortName!.get(s.route_id) ?? [`route-short:${s.route_id}`]);
          const stops =
            s.stop_id === undefined
              ? [undefined]
              : [...new Set(scope.stopsByCode!.get(s.stop_id) ?? [`stop-code:${s.stop_id}`])];
          return routes.flatMap((route_id) =>
            stops.map((stop_id) => {
              const direction_id =
                s.direction_id === "0" || s.direction_id === "1"
                  ? Number(s.direction_id)
                  : route_id && s.direction_id
                    ? scope.directionsByRoute?.get(`${route_id}|${s.direction_id}`)
                    : undefined;
              return {
                route_id,
                stop_id,
                direction_id,
                direction_text:
                  s.direction_id && direction_id === undefined ? s.direction_id : undefined,
              };
            }),
          );
        }),
      },
    })),
  };
}
