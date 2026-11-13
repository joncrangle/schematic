import type { I18nContextValue } from "~/i18n/I18nContext";

// Checked by `bun run typecheck`; invalid calls must stay compile-time errors.
export function checkTranslationParameters(i18n: I18nContextValue): void {
  i18n.t("Language");
  i18n.t("Line {{name}}", { name: "A" });
  i18n.plural("More alerts", 2);
  i18n.plural("{{line}} at {{station}}", 2, { line: "A", station: "Central" });
  const unionKey: "Language" | "Line {{name}}" = Math.random() ? "Language" : "Line {{name}}";
  i18n.t(unionKey, { name: "A" });

  // @ts-expect-error A named message requires its parameters.
  i18n.t("Line {{name}}");
  // @ts-expect-error The message needs `name`, not `id`.
  i18n.t("Line {{name}}", { id: "A" });
  // @ts-expect-error A possible parameterized key still requires its values.
  i18n.t(unionKey);
  // @ts-expect-error Plural formatting supplies count, but no other values.
  i18n.plural("{{line}} at {{station}}", 2);
  // @ts-expect-error Every non-count parameter is required.
  i18n.plural("{{line}} at {{station}}", 2, { line: "A" });
}
