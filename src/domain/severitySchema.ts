import * as Schema from "effect/Schema";

export const SeveritySchema = Schema.Union([
  Schema.Literal("normal"),
  Schema.Literal("degraded"),
  Schema.Literal("severe"),
]);

export type Severity = Schema.Schema.Type<typeof SeveritySchema>;
