import * as Schema from "effect/Schema";
import { isUiLocale, type UiLocale } from "~/domain/locale";

/** Effect Schema validator shared by RPC and diagnostics boundaries. */
export const UiLocaleSchema = Schema.declare<UiLocale>(isUiLocale, {
  title: "UiLocale",
  description: "A locale supported by the Schematic interface.",
});
