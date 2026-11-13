// @vitest-environment happy-dom
import { render, screen } from "@solidjs/testing-library";
import { describe, expect, it } from "vitest";
import { AlertDescription } from "~/components/AlertDescription";

describe("alert descriptions", () => {
  it("renders a usable operator map link and keeps untrusted markup as text", () => {
    render(() => <AlertDescription text={'Detour: [Clockwise map](https://example.test/map.pdf). <script>alert(1)</script> [unsafe](javascript:alert(1))'} />);
    expect(screen.getByRole("link", {name: "Clockwise map"}).getAttribute("href")).toBe("https://example.test/map.pdf");
    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.getByText(/<script>alert/).textContent).toContain("[unsafe](javascript:alert(1))");
  });
});
