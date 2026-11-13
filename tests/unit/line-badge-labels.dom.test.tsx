// @vitest-environment happy-dom
import { cleanup, fireEvent, render } from "@solidjs/testing-library";
import { afterEach, expect, it, vi } from "vitest";
import { LineBadgeCircle } from "~/components/nearby/LineBadgeCircle";

vi.mock("~/agencies/browserRegistry", () => ({
  getAgencyById: () => ({
    manifest: { routeShortNames: { "route-main": "A", "route-local": "7" } },
    light: { lines: [{ id: "route-main", name: "Telephone", color: "#FFCC00" }] },
  }),
}));

afterEach(cleanup);

it("presents public route labels while keeping canonical IDs for interactions", () => {
  const toggle = vi.fn();
  const view = render(() => (
    <LineBadgeCircle agencyId="example" lineIds={["route-main"]} onToggleLine={toggle} />
  ));
  const badge = view.getByRole("button", { name: "Telephone" });
  expect(badge.textContent).toBe("A");
  fireEvent.click(badge);
  expect(toggle).toHaveBeenCalledWith("route-main");
});

it("labels off-schematic routes and preserves the fallback for unknown IDs", () => {
  const view = render(() => (
    <LineBadgeCircle agencyId="example" lineIds={["route-local", "unknown"]} />
  ));
  expect(view.getByRole("img", { name: "Line 7" }).textContent).toBe("7");
  expect(view.getByRole("img", { name: "Line unknown" }).textContent).toBe("unknown");
});
