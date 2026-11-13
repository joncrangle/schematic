import { describe, expect, it } from "vitest";
import { extractStrongTitle, stripHtml } from "~/infrastructure/realtime/stripHtml";

describe("stripHtml (Core GTFS-RT alert text)", () => {
  it("strips tags and decodes a GRT-style detour body", () => {
    expect(
      stripHtml(
        "<strong>Emergency detour on Route 6</strong> <br />Emergency detour on Route 6 Bridge-Courtland. <br />Closed stop: 4051. <br />Use alternate stop: 4038.",
      ),
    ).toBe(
      "Emergency detour on Route 6\nEmergency detour on Route 6 Bridge-Courtland.\nClosed stop: 4051.\nUse alternate stop: 4038.",
    );
  });

  it("leaves plain-text descriptions untouched apart from whitespace", () => {
    expect(stripHtml("  Track work  between stations. ")).toBe("Track work between stations.");
  });

  it("decodes entities after stripping tags", () => {
    expect(stripHtml("<p>Victoria &amp; Frederick &#8211; detour</p>")).toBe(
      "Victoria & Frederick – detour",
    );
  });

  it("lifts the first strong run as the title when the header is absent", () => {
    expect(
      extractStrongTitle("<strong>Emergency detour on Route 6</strong> <br />Body text here."),
    ).toBe("Emergency detour on Route 6");
  });

  it("yields no title when no strong run exists", () => {
    expect(extractStrongTitle("Plain body without markup.")).toBeUndefined();
  });

  it("does not lift a title from stylesheet or script contents", () => {
    expect(
      extractStrongTitle(
        '<script>const text = "<strong>Hidden title</strong>";</script><strong>Rider title</strong>',
      ),
    ).toBe("Rider title");
  });

  it("strips inner markup and decodes entities inside the strong run", () => {
    expect(extractStrongTitle("<strong>Detour <em>Route 6</em> &amp; more</strong>")).toBe(
      "Detour Route 6 & more",
    );
  });
});
