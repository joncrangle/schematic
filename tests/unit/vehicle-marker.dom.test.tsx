// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, fireEvent, screen, cleanup } from "@solidjs/testing-library";
import type { LiveVehiclePosition } from "../../src/domain/surface/types";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { VehicleMarker } from "../../src/components/route/VehicleMarker";
import { VehicleGlyph } from "../../src/components/route/VehicleGlyph";
import { VehicleStatRows } from "../../src/components/route/VehicleStatRows";

const vehicle: LiveVehiclePosition = {
  vehicleId: "37d290f9-1542-4ab1-850c-e30e6484c",
  routeId: "97",
  directionId: 0,
  latitude: 43.7,
  longitude: -79.4,
  speed: 5.5,
  occupancyStatus: "FEW_SEATS_AVAILABLE",
  timestamp: 0,
};

function mountMarker(rect?: Partial<DOMRect>) {
  const utils = render(() => (
    <VehicleMarker vehicle={vehicle} routeShortName="1" routeType="bus" />
  ));
  const button = screen.getByRole("button");
  if (rect) {
    button.getBoundingClientRect = () =>
      ({
        left: 100,
        top: 400,
        right: 128,
        bottom: 428,
        width: 28,
        height: 28,
        x: 100,
        y: 400,
        toJSON: () => ({}),
        ...rect,
      }) as DOMRect;
  }
  return { ...utils, button };
}

import { flush } from "solid-js";

function openPanel() {
  flush();
  return screen.queryByRole("dialog", { name: "Bus 1 details" });
}

describe("VehicleMarker micro-popover", () => {
  it("portals the open popover outside the marker's DOM tree", () => {
    const { button, container, unmount } = mountMarker();

    expect(button.title).toBe("Bus 1");
    expect(button.getAttribute("aria-label")).toBe("Bus 1");
    fireEvent.click(button);

    const panel = openPanel();
    expect(panel).not.toBeNull();
    expect(panel!.textContent).toContain("Bus 1");
    expect(panel!.textContent).not.toContain(vehicle.vehicleId);
    expect(container.contains(panel!)).toBe(false);

    unmount();
    cleanup();
  });

  it("flips below the marker when there is no room above", () => {
    const { button, unmount } = mountMarker({ top: 40, bottom: 68, y: 40 });

    fireEvent.click(button);

    const panel = openPanel()!;
    expect(panel.style.top).toBe(`${40 + 28 + 8}px`);

    unmount();
    cleanup();
  });

  it("opens above the marker when there is room", () => {
    const { button, unmount } = mountMarker({ top: 400, bottom: 428, y: 400 });

    fireEvent.click(button);

    const panel = openPanel()!;
    expect(panel.style.top).toBe(`${400 - 8}px`);
    expect(panel.style.transform).toContain("-100%");

    unmount();
    cleanup();
  });

  it("localizes the vehicle label, details dialog, and occupancy in French", async () => {
    const frenchPreferences = { ...DEFAULT_PREFERENCES, locale: "fr-CA" as const };
    render(() => (
      <UserPreferencesProvider
        storage={{ load: async () => frenchPreferences, save: async () => {} }}
      >
        <I18nProvider>
          <VehicleMarker vehicle={vehicle} routeShortName="1" routeType="bus" />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    const button = await screen.findByRole("button", { name: "1 — Autobus" });
    expect(button.getAttribute("title")).toBe("1 — Autobus");
    fireEvent.click(button);

    const dialog = await screen.findByRole("dialog", { name: "Détails de 1 — Autobus" });
    expect(dialog.textContent).toContain("Quelques places assises disponibles");
  });

  it("dismisses on an outside pointerdown", async () => {
    const { button, unmount } = mountMarker();

    fireEvent.click(button);
    expect(openPanel()).not.toBeNull();

    fireEvent.pointerDown(document.body);
    expect(openPanel()).toBeNull();

    unmount();
    cleanup();
  });
});

describe("VehicleGlyph", () => {
  it("defaults to the bus glyph when no route type is given", () => {
    const { container, unmount } = render(() => <VehicleGlyph />);
    expect(container.querySelector("[data-mode='bus']")).not.toBeNull();
    unmount();
    cleanup();
  });
});

describe("VehicleStatRows", () => {
  it("renders speed and occupancy rows when values resolve", () => {
    const { container, unmount } = render(() => (
      <VehicleStatRows speed="23 km/h" occupancy="Few seats available" />
    ));
    expect(container.textContent).toContain("Speed");
    expect(container.textContent).toContain("23 km/h");
    expect(container.textContent).toContain("Occupancy");
    expect(container.textContent).toContain("Few seats available");
    unmount();
    cleanup();
  });

  it("omits rows whose value is missing", () => {
    const { container, unmount } = render(() => (
      <VehicleStatRows speed={null} occupancy={undefined} />
    ));
    expect(container.textContent).not.toContain("Speed");
    expect(container.textContent).not.toContain("Occupancy");
    unmount();
    cleanup();
  });
});
