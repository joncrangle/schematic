// @vitest-environment happy-dom
import { cleanup, render, screen } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { makeTestProvider } from "../helpers/agency-fixtures";
import { OpenDataAttribution } from "~/components/legal/OpenDataAttribution";

vi.mock("~/i18n/I18nContext", () => ({
  useI18n: () => ({ t: (key: string) => key, displayLocale: () => "en-CA" }),
}));
vi.mock("~/agencies/browserRegistry", () => ({ getAgencyById: vi.fn() }));
import { getAgencyById } from "~/agencies/browserRegistry";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

it.each(["card", "footer"] as const)(
  "renders a required acknowledgement verbatim in the %s",
  (variant) => {
    const statement = "Contains information licensed under the Sample Open Data Terms of Use.";
    vi.mocked(getAgencyById).mockReturnValue(
      makeTestProvider({
        attribution: {
          name: "Sample Open Data",
          url: "https://example.test/license",
          license: statement,
          licenseIsStatement: true,
        },
      }),
    );
    render(() => <OpenDataAttribution agencyId="sample" variant={variant} />);
    const link = screen.getByRole("link", { name: statement });
    expect(link.parentElement!.textContent!.trim()).toBe(statement);
  },
);

it.each(["card", "footer"] as const)(
  "adds the licence prefix after a locale overrides a statement with a title in the %s",
  (variant) => {
    vi.mocked(getAgencyById).mockReturnValue(
      makeTestProvider({
        attribution: {
          name: "Sample Open Data",
          url: "https://example.test/license",
          license: "Sample acknowledgement.",
          licenseIsStatement: true,
          translations: { "en-CA": { license: "Sample Licence", licenseIsStatement: false } },
        },
      }),
    );
    render(() => <OpenDataAttribution agencyId="sample" variant={variant} />);
    const link = screen.getByRole("link", { name: "Sample Licence" });
    expect(link.parentElement!.textContent!.trim()).toBe(
      `Contains information licensed under the Sample Licence${variant === "card" ? "." : ""}`,
    );
  },
);
