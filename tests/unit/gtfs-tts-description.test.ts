import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { fetchAgencyAlerts } from "~/infrastructure/realtime/fetchAgencyAlerts";
import {
  concatBuffers,
  encodeFeed,
  encodeMessage,
  encodeString,
  encodeVarintField,
} from "../helpers/gtfs-rt-binary";

const translated = (text: string) => encodeMessage(1, encodeString(1, text));
const alert = concatBuffers(
  encodeVarintField(7, 4),
  encodeMessage(10, translated("Detour")),
  encodeMessage(11, translated("CMS template")),
  encodeMessage(13, translated("Use the temporary stop on Main Street.")),
);
const binary = encodeFeed(1700000000, [
  encodeMessage(2, concatBuffers(encodeString(1, "alert"), encodeMessage(5, alert))),
]);
const json = new TextEncoder().encode(
  JSON.stringify({
    header: { gtfs_realtime_version: "2.0", timestamp: 1700000000 },
    entity: [
      {
        id: "alert",
        alert: {
          effect: "DETOUR",
          header_text: { translation: [{ text: "Detour" }] },
          description_text: { translation: [{ text: "CMS template" }] },
          tts_description_text: {
            translation: [{ text: "Use the temporary stop on Main Street." }],
          },
        },
      },
    ],
  }),
);

describe.each([
  ["protobuf", binary],
  ["json", json],
] as const)("%s alert descriptions", (format, bytes) => {
  it.each([
    [undefined, "CMS template"],
    ["tts_description_text", "Use the temporary stop on Main Street."],
  ] as const)(
    "selects the declared source field %s through the alert pipeline",
    async (descriptionField, expected) => {
      const snapshot = await Effect.runPromise(
        fetchAgencyAlerts({
          agencyId: "sample",
          timeZone: "America/Toronto",
          now: () => 1700000000000,
          sources: [
            { type: "gtfs-rt", url: "https://example.test/alerts", format, descriptionField },
          ],
          fetch: (async () => new Response(new Uint8Array(bytes))) as typeof fetch,
        }),
      );
      expect(snapshot.alerts[0].description).toBe(expected);
    },
  );
});
