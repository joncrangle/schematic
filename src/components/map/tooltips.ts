import type { StatusSegmentKind } from "~/core/map";
import { englishTranslator, type Translator } from "~/i18n/translate";
import type { TranslationKey } from "~/i18n/en";

/**
 * Tooltip text composition for the subway map, extracted verbatim from
 * StationMarker and StatusSegmentPath so tests can pin the user-facing
 * semantics at a public seam instead of mirroring component internals.
 */

export interface StationTooltipInput {
  name: string;
  lines: readonly string[];
  status?: "normal" | "degraded" | "severe" | "unavailable";
  accessibilityOutage?: boolean;
}

/** `${name} (${lines}), ${status}`, where severe > elevator outage > degraded > normal. */
export function formatStationTooltip(
  { name, lines, status = "normal", accessibilityOutage = false }: StationTooltipInput,
  t: Translator = englishTranslator,
): string {
  const statusText =
    status === "unavailable"
      ? t("Live alerts unavailable")
      : status === "severe"
        ? t("Severe disruption / service suspended")
        : accessibilityOutage
          ? t("Elevator out of service")
          : status === "degraded"
            ? t("Delays reported")
            : t("Normal service");
  const linesText = t(lines.length > 1 ? "Lines {{lines}}" : "Line {{lines}}", {
    lines: lines.join(", "),
  });
  return t("{{name}} ({{lines}}) — {{status}}", { name, lines: linesText, status: statusText });
}

export interface StationAriaInput {
  readonly name: string;
  readonly lines: readonly string[];
  readonly accessible?: boolean;
}

/** Localized station name, line membership, and accessibility description. */
export function formatStationAriaLabel(
  { name, lines, accessible }: StationAriaInput,
  t: Translator = englishTranslator,
): string {
  const lineLabel = t(lines.length > 1 ? "lines {{lines}}" : "line {{lines}}", {
    lines: lines.join(", "),
  });
  const accessibility =
    accessible === undefined
      ? t("accessibility information unavailable")
      : accessible
        ? t("wheelchair accessible")
        : t("no elevator access");
  return t("{{name}} station, {{lines}}, {{accessibility}}", {
    name,
    lines: lineLabel,
    accessibility,
  });
}

const SEGMENT_KIND_KEYS = {
  severe: "Service Suspension",
  delay: "General Delay",
  rsz: "Reduced Speed Zone",
  upcoming: "Upcoming Planned Closure",
} as const satisfies Record<StatusSegmentKind, TranslationKey>;

export interface SegmentTooltipInput {
  lineName: string;
  fromStation: string;
  toStation: string;
  kind: StatusSegmentKind;
  note?: string;
}

/**
 * `${line}: ${from} to ${to}, ${kindLabel}${note}`, suppressing the note
 * when it merely repeats the kind label (the server echoes kind as note).
 */
export function formatSegmentTooltip(
  { lineName, fromStation, toStation, kind, note }: SegmentTooltipInput,
  t: Translator = englishTranslator,
): string {
  const noteText = note && note !== kind ? t(" ({{note}})", { note }) : "";
  if (fromStation === toStation) {
    return t("{{line}}: {{scope}} — {{kind}}{{note}}", {
      line: lineName,
      scope: fromStation === lineName ? t("Route advisory") : fromStation,
      kind: t(SEGMENT_KIND_KEYS[kind]),
      note: noteText,
    });
  }
  return t("{{line}}: {{from}} to {{to}} — {{kind}}{{note}}", {
    line: lineName,
    from: fromStation,
    to: toStation,
    kind: t(SEGMENT_KIND_KEYS[kind]),
    note: noteText,
  });
}
