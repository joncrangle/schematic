import { describe, expect, it } from "vitest";
import { resolveServiceArea } from "~/i18n/agencyServiceArea";

describe("service area descriptions", () => {
  it.each([
    ["fr-CA", "Grand Port"],
    ["fr-FR", "Grand Port"],
    ["en-CA", "Greater Harbour"],
    ["de", "Greater Harbour"],
  ])("uses a configured translation or the default for %s", (locale, expected) => {
    expect(
      resolveServiceArea(
        {
          serviceArea: "Greater Harbour",
          serviceAreaTranslations: { fr: "Grand Port" },
        },
        locale,
      ),
    ).toBe(expected);
  });

  it("omits the description when none is configured", () => {
    expect(resolveServiceArea({}, "fr-CA")).toBeUndefined();
  });
});
