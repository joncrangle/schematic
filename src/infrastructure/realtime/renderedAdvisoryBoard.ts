import { PLACEHOLDER_ALERT_TITLE } from "~/domain/alerts/placeholderTitle";
import { stripHtml } from "./stripHtml";
import * as Schema from "effect/Schema";

const Text = Schema.NullOr(Schema.String);
const Notice = Schema.Struct({
  uniqueId: Schema.String,
  gtfsentityId: Schema.optional(Text),
  subject: Schema.optional(Text),
  effectText: Schema.optional(Text),
  alertDescriptions: Schema.Array(Schema.Struct({ text: Text })),
  alertHeaders: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ text: Text })))),
  alertEntityAffecteds: Schema.Array(
    Schema.Struct({
      routeId: Schema.optional(Text),
      stopId: Schema.optional(Text),
      tripId: Schema.optional(Text),
    }),
  ),
  alertPeriods: Schema.Array(Schema.Struct({ startDateTime: Text, endDateTime: Text })),
  renderedAlert: Schema.optional(
    Schema.Struct({
      message: Schema.Struct({ header: Schema.String, description: Schema.String }),
      effect: Schema.Struct({ token: Schema.String, displayText: Schema.String }),
    }),
  ),
});
// These tokens are machine labels, and a notice shared by routes carries one route's subject.
const GENERIC_EFFECT_TOKENS = new Set(["OTHER_EFFECT", "UNKNOWN_EFFECT"]);
const Board = Schema.Array(Schema.Union([Schema.Struct({ alerts: Schema.Array(Notice) }), Notice]));

function timestamp(value: string | null): string | undefined {
  if (value === null || value === "1970-01-01T00:00:00") return undefined;
  // This API serializes UTC instants without a zone suffix.
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/.test(value) ||
    !Number.isFinite(Date.parse(value.endsWith("Z") ? value : `${value}Z`)) ||
    new Date(Date.parse(value.endsWith("Z") ? value : `${value}Z`)).toISOString().slice(0, 19) !==
      value.slice(0, 19)
  ) {
    throw new Error("Invalid advisory period");
  }
  return value.endsWith("Z") ? value : `${value}Z`;
}

/** Reads the public data behind a rendered advisory board, including its entity guidance. */
export function normalizeRenderedAdvisoryBoard(payload: unknown) {
  const groups = Schema.decodeUnknownSync(Board)(payload);
  const alerts = groups
    .flatMap((group) => ("alerts" in group ? group.alerts : [group]))
    .flatMap((notice) => {
      const message = notice.renderedAlert?.message;
      let description =
        message?.description.trim() ||
        notice.alertDescriptions
          .map((item) => item.text?.trim())
          .filter(Boolean)
          .join("\n");
      const publishedTitle =
        message?.header.trim() ||
        notice.alertHeaders
          ?.map((item) => item.text?.trim())
          .filter(Boolean)
          .join("\n");
      const title =
        publishedTitle ||
        (notice.renderedAlert && GENERIC_EFFECT_TOKENS.has(notice.renderedAlert.effect.token)
          ? PLACEHOLDER_ALERT_TITLE
          : notice.renderedAlert?.effect.displayText.trim() ||
            notice.subject?.trim() ||
            "Transit advisory");
      const entities = notice.alertEntityAffecteds;
      // Scoped cancellations can publish only an effect caption, with no message body.
      if (
        !stripHtml(description).trim() &&
        notice.renderedAlert?.effect.token === "NO_SERVICE" &&
        entities.some(
          (entity) => entity.routeId?.trim() || entity.stopId?.trim() || entity.tripId?.trim(),
        )
      ) {
        description = notice.renderedAlert.effect.displayText.trim();
      }
      if (!stripHtml(description).trim() || !notice.uniqueId.trim())
        throw new Error("Unreadable advisory");
      const routes = [
        ...new Set(
          entities.flatMap((entity) => (entity.routeId?.trim() ? [entity.routeId.trim()] : [])),
        ),
      ];
      const targets = entities.flatMap((entity) => {
        const routeId = entity.routeId?.trim();
        const stopId = entity.stopId?.trim();
        return routeId || stopId
          ? [{ ...(routeId ? { routeId } : {}), ...(stopId ? { stopId } : {}) }]
          : [];
      });
      const tripIds = [
        ...new Set(
          entities.flatMap((entity) => (entity.tripId?.trim() ? [entity.tripId.trim()] : [])),
        ),
      ];
      const periods = notice.alertPeriods.length
        ? notice.alertPeriods
        : [{ startDateTime: null, endDateTime: null }];
      return periods.map((period) => {
        const start = timestamp(period.startDateTime);
        const end = timestamp(period.endDateTime);
        if (start && end && Date.parse(end) < Date.parse(start))
          throw new Error("Reversed advisory period");
        return {
          id: notice.gtfsentityId?.trim() || notice.uniqueId,
          title,
          description,
          routes,
          targets,
          tripIds,
          ...(notice.effectText ? { category: notice.effectText } : {}),
          tripScoped:
            entities.length > 0 && entities.every((entity) => Boolean(entity.tripId?.trim())),
          ...(notice.renderedAlert ? { effect: notice.renderedAlert.effect.token } : {}),
          activePeriod: { ...(start ? { start } : {}), ...(end ? { end } : {}) },
        };
      });
    });
  return { alerts, partial: false };
}
