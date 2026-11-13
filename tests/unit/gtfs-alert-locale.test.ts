import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";
import type { UiLocale } from "~/domain/locale";
import {
  concatBuffers,
  encodeFeed,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

interface Translation {
  readonly text: string;
  readonly language?: string;
}

function translationMessage(translations: readonly Translation[]): Uint8Array {
  return concatBuffers(
    ...translations.map((translation) =>
      encodeMessage(
        1,
        concatBuffers(
          encodeString(1, translation.text),
          ...(translation.language ? [encodeString(2, translation.language)] : []),
        ),
      ),
    ),
  );
}

function feedBytes(
  format: "protobuf" | "json",
  translations: readonly Translation[],
  includeEffect = true,
): Uint8Array {
  if (format === "json") {
    return new TextEncoder().encode(
      JSON.stringify({
        header: { gtfs_realtime_version: "2.0", timestamp: 1_800_000_000 },
        entity: [
          {
            id: "multilingual-alert",
            alert: {
              ...(includeEffect ? { effect: "NO_SERVICE" } : {}),
              header_text: { translation: translations },
              description_text: {
                translation: translations.map((entry) => ({
                  ...entry,
                  text: `Description ${entry.text}`,
                })),
              },
            },
          },
        ],
      }),
    );
  }

  const alert = concatBuffers(
    ...(includeEffect ? [encodeVarintField(7, 1)] : []),
    encodeMessage(10, translationMessage(translations)),
    encodeMessage(
      11,
      translationMessage(
        translations.map((entry) => ({ ...entry, text: `Description ${entry.text}` })),
      ),
    ),
  );
  return encodeFeed(1_800_000_000, [
    encodeMessage(2, concatBuffers(encodeString(1, "multilingual-alert"), encodeMessage(5, alert))),
  ]);
}

async function snapshotFor(
  format: "protobuf" | "json",
  locale: UiLocale,
  translations: readonly Translation[],
  includeEffect = true,
  agencyLocale = "en-CA",
) {
  const bytes = feedBytes(format, translations, includeEffect);
  return Effect.runPromise(
    fetchAgencyAlerts({
      agencyId: "sample",
      sources: [{ type: "gtfs-rt", url: "https://example.test/alerts", format }],
      fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
      now: () => 1_800_000_000_000,
      timeZone: "America/Toronto",
      locale,
      manifest: { locale: agencyLocale, alertInterpretation: undefined },
    }),
  );
}

const completeTranslations: readonly Translation[] = [
  { text: "Texte français canadien", language: "fr-CA" },
  { text: "Texte français", language: "fr" },
  { text: "Canadian English", language: "en-CA" },
  { text: "English", language: "en" },
  { text: "Untagged text" },
];

describe.each(["protobuf", "json"] as const)("%s GTFS-RT translations", (format) => {
  it("retains the agency's preferred script before a broader language fallback", async () => {
    const snapshot = await snapshotFor(
      format,
      "en-CA",
      [
        { language: "zh-Hans-CN", text: "简体中文" },
        { language: "zh-Hant-HK", text: "繁體中文" },
      ],
      true,
      "zh-Hant-TW",
    );
    expect(snapshot.alerts[0]?.title).toBe("繁體中文");
  });

  it.each([
    ["fr-CA", completeTranslations, "Texte français canadien"],
    [
      "fr-CA",
      completeTranslations.filter((translation) => translation.language !== "fr-CA"),
      "Texte français",
    ],
    [
      "fr-CA",
      completeTranslations.filter((translation) => !translation.language?.startsWith("fr")),
      "Canadian English",
    ],
    [
      "fr-CA",
      completeTranslations.filter(
        (translation) =>
          translation.language !== "fr-CA" &&
          translation.language !== "fr" &&
          translation.language !== "en-CA",
      ),
      "English",
    ],
    ["fr-CA", [{ text: "Untagged text" }], "Untagged text"],
    ["fr-CA", [{ text: "Aviso del operador", language: "es" }], "Aviso del operador"],
  ] as const)("uses the shared fallback for locale %s", async (locale, translations, expected) => {
    const snapshot = await snapshotFor(format, locale, translations);

    expect(snapshot.alerts[0]).toMatchObject({
      title: expected,
      description: `Description ${expected}`,
      kind: "suspension",
      severity: "severe",
    });
  });

  it("keeps structured severe evidence when no rider-language translation is available", async () => {
    const snapshot = await snapshotFor(format, "en-CA", [
      { text: "Aucun service", language: "fr" },
    ]);

    expect(snapshot.alerts[0]).toMatchObject({
      title: "Aucun service",
      kind: "suspension",
      severity: "severe",
    });
  });

  it("classifies hidden-language safety wording when no structured effect is available", async () => {
    const snapshot = await snapshotFor(
      format,
      "en-CA",
      [
        { text: "Operator advisory", language: "en" },
        { text: "Aucun service", language: "fr" },
      ],
      false,
    );

    expect(snapshot.alerts[0]).toMatchObject({
      title: "Operator advisory",
      kind: "suspension",
      severity: "severe",
    });
  });
});
