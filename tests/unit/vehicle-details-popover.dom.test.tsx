// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import type { LiveVehiclePosition } from "~/domain/surface/types";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import { VehicleDetailsPopover } from "~/components/map/VehicleDetailsPopover";

const vehicle: LiveVehiclePosition = {
  vehicleId: "37d290f9-1542-4ab1-850c-e30e6484c",
  routeId: "1",
  directionId: 0,
  latitude: 43.7,
  longitude: -79.4,
  speed: 5.5,
  occupancyStatus: "FEW_SEATS_AVAILABLE",
  timestamp: 0,
};

afterEach(cleanup);

describe("VehicleDetailsPopover", () => {
  it("uses the public route label and keeps the operational vehicle ID out of the popover", () => {
    render(() => (
      <VehicleDetailsPopover
        vehicle={vehicle}
        routeShortName="1"
        routeType="bus"
        coords={{ x: 100, y: 100 }}
        containerSize={{ width: 800, height: 600 }}
        onClose={vi.fn()}
        setRef={vi.fn()}
      />
    ));

    const dialog = screen.getByRole("dialog", { name: "Bus 1 details" });
    expect(dialog.textContent).toContain("Bus 1");
    expect(dialog.textContent).not.toContain(vehicle.vehicleId);
  });

  it("localizes the dialog name, service state, and vehicle details", async () => {
    const preferences = { ...DEFAULT_PREFERENCES, locale: "fr-CA" as const };
    render(() => (
      <UserPreferencesProvider storage={{ load: async () => preferences, save: async () => {} }}>
        <I18nProvider>
          <VehicleDetailsPopover
            vehicle={vehicle}
            routeShortName="1"
            routeType="bus"
            coords={{ x: 100, y: 100 }}
            containerSize={{ width: 800, height: 600 }}
            onClose={vi.fn()}
            setRef={vi.fn()}
          />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    const dialog = await screen.findByRole("dialog", { name: "Détails de 1 — Autobus" });
    expect(dialog.textContent).toContain("En service");
    expect(dialog.textContent).toContain("Vitesse");
    expect(dialog.textContent).toContain("Quelques places assises disponibles");
    expect(dialog.textContent).not.toContain(vehicle.vehicleId);
  });
});
