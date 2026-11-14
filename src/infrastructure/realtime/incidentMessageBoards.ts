import * as Schema from "effect/Schema";
import { stripHtml } from "./stripHtml";

const Message = Schema.Struct({
  ebid: Schema.Union([Schema.String, Schema.Number]),
  messageid: Schema.Union([Schema.String, Schema.Number]),
  sentdate2: Schema.String,
  Subject: Schema.String,
  SentMessage: Schema.String,
  TemplateName: Schema.String,
  state: Schema.Literals(["Open", "Closed"]),
});
export function normalizeIncidentMessages(payload: unknown) {
  const messages = Schema.decodeUnknownSync(Schema.Array(Message))(payload);
  const latest = new Map<string, { message: (typeof messages)[number]; timestamp: number }>();
  for (const message of messages) {
    const match = /^\/Date\((\d+)\)\/$/.exec(message.sentdate2);
    const timestamp = match ? Number(match[1]) : NaN;
    if (
      !Number.isFinite(timestamp) ||
      !Number.isFinite(new Date(timestamp).getTime()) ||
      !message.TemplateName.trim() ||
      !message.Subject.trim() ||
      !message.SentMessage.trim()
    )
      throw new Error("Invalid incident message");
    // Equipment templates identify the same facility across separately issued outage/restoration incidents.
    const key = /\b(?:elevator|escalator)\b/i.test(message.TemplateName)
      ? `equipment:${message.TemplateName}`
      : `incident:${message.ebid}`;
    if ((latest.get(key)?.timestamp ?? -1) < timestamp) latest.set(key, { message, timestamp });
  }
  return {
    partial: false,
    alerts: [...latest.values()].flatMap(({ message, timestamp }) => {
      const equipment = /\b(?:elevator|escalator)\b/i.test(message.TemplateName);
      const stop = equipment
        ? /\b([A-Z]{2,3})\s*-\s*To(?:NY|NJ)\b/.exec(message.TemplateName)?.[1]
        : undefined;
      const routes = equipment
        ? []
        : [...new Set(message.SentMessage.match(/\b[A-Z]{2,}-[A-Z0-9]{2,}\b/g) ?? [])];
      const common = {
        id: String(message.messageid),
        title: message.Subject,
        description: message.SentMessage,
        posted_at: new Date(timestamp).toISOString(),
        routes,
        category: message.state,
        effect: "UNKNOWN_EFFECT",
        ...(stop ? { stops: [stop], stopScoped: true } : {}),
      };
      const clauses = equipment
        ? []
        : [
            ...message.SentMessage.matchAll(
              /\b([A-Z]{2,}-[A-Z0-9]{2,}(?:,\s*[A-Z]{2,}-[A-Z0-9]{2,})*)\s+([^.!?]+[.!?]?)/g,
            ),
          ].filter((m) =>
            /\b(?:resuming normal service|delays continue|delayed|suspended|no service)\b/i.test(
              m[2],
            ),
          );
      const sections =
        clauses.length < 2
          ? [common]
          : clauses.map((clause) => {
              let context = message.SentMessage;
              for (const part of clauses) context = context.replace(part[0], "");
              const routes = [...new Set(clause[1].match(/\b[A-Z]{2,}-[A-Z0-9]{2,}\b/g) ?? [])];
              return {
                ...common,
                id: `${common.id}:${routes.join(",")}`,
                title: clause[0].trim(),
                description: `${clause[0].trim()} ${context.trim()}`.trim(),
                routes,
              };
            });
      return sections.map((section) => ({
        ...section,
        ...(/\b(?:resuming normal service|back in service)\b/i.test(section.description) &&
        !/\b(?:delays continue|delayed|suspended|no service)\b/i.test(section.description)
          ? { reason: "restoration" }
          : {}),
      }));
    }),
  };
}

/** Read published accordion bodies without including linked pages or navigation copy. */
export function normalizeComponentNotices(payload: unknown) {
  const alerts: {
    id: string;
    title: string;
    description: string;
    stopName?: string;
    stopScoped?: boolean;
    effect: string;
  }[] = [];
  function walk(value: unknown): void {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("Invalid component model");
    const node = value as Record<string, unknown>;
    const children = node[":items"];
    if (typeof node.accordionLabel === "string") {
      if (
        typeof node.id !== "string" ||
        !node.id.trim() ||
        !children ||
        typeof children !== "object"
      )
        throw new Error("Incomplete accordion notice");
      const parts: string[] = [];
      function text(value: unknown): void {
        if (!value || typeof value !== "object") return;
        const record = value as Record<string, unknown>;
        if (typeof record.text === "string") parts.push(record.text);
        if (record[":items"] && typeof record[":items"] === "object")
          Object.keys(record[":items"])
            .sort()
            .forEach((key) => text((record[":items"] as Record<string, unknown>)[key]));
      }
      Object.keys(children)
        .sort()
        .forEach((key) => text((children as Record<string, unknown>)[key]));
      const description = stripHtml(parts.join(" "));
      const title = stripHtml(parts[0]?.split("</p>")[0] ?? "");
      const label = stripHtml(node.accordionLabel);
      if (!title || !description || !label) throw new Error("Empty accordion notice");
      alerts.push({
        id: node.id,
        title,
        description,
        ...(label === "All Stations" ? {} : { stopName: label, stopScoped: true }),
        effect: "UNKNOWN_EFFECT",
      });
    } else if (children && typeof children === "object" && !Array.isArray(children))
      Object.keys(children)
        .sort()
        .forEach((key) => walk((children as Record<string, unknown>)[key]));
  }
  walk(payload);
  if (!alerts.length) throw new Error("No recognized service notes");
  return { alerts, partial: false };
}

export function normalizeContentFragments(payload: unknown) {
  const feed = Schema.decodeUnknownSync(
    Schema.Struct({
      entities: Schema.Array(
        Schema.Struct({
          properties: Schema.Struct({
            name: Schema.String,
            elements: Schema.Struct({
              title: Schema.Struct({ value: Schema.String }),
              description: Schema.Struct({ value: Schema.String }),
            }),
            publicationStatus: Schema.optional(Schema.String),
          }),
        }),
      ),
      properties: Schema.Struct({
        "srn:paging": Schema.Struct({
          total: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
          offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
        }),
      }),
    }),
  )(payload);
  return {
    partial:
      feed.properties["srn:paging"].offset !== 0 ||
      feed.properties["srn:paging"].total !== feed.entities.length,
    alerts: feed.entities.flatMap(({ properties: p }) => {
      const title = stripHtml(p.elements.title.value),
        description = stripHtml(p.elements.description.value);
      if (!p.name.trim() || !title || !description) throw new Error("Incomplete service fragment");
      if (
        ["deactivate", "deactivated", "unpublish", "unpublished", "not_published"].includes(
          p.publicationStatus?.toLowerCase() ?? "",
        )
      )
        return [];
      return [{ id: p.name, title, description, effect: "UNKNOWN_EFFECT" }];
    }),
  };
}
