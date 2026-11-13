// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { StationPopover } from "~/components/map/StationPopover";
import { BaseMapPopover } from "~/components/map/popovers/BaseMapPopover";
import { makeStationSchematic } from "../helpers/agency-fixtures";
import type { AgencyAlert } from "~/agencies/types";
import { buildMapModel } from "~/core/map";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";

afterEach(cleanup);

const railSchematic = makeStationSchematic(["Sample Station", "Terminus"]);
const railMap = buildMapModel(railSchematic);
const station = (() => {
  const candidate = railMap.stationsById.get("sample-station");
  if (!candidate) throw new Error("Fixture must contain Sample Station");
  return candidate;
})();

const title = "Sample Station - Pedestrian Bridge South of Sample Station GO - Construction";
const description =
  "Until further notice, the pedestrian bridge over Main Avenue will be closed for repairs. Customers wishing to access to the path to the Sample Station GO, will have to cross the street at West Avenue and Main Avenue and proceed to the north stairway on Main Avenue. This will add an additional 10 minutes to your commute.";

function makeAccessibilityAlert(copy: { title: string; description?: string }): AgencyAlert {
  return {
    id: "go-old-cummer-bridge",
    kind: "accessibility",
    severity: "normal",
    lifecycle: "active",
    scope: "station",
    affectedStations: [{ stationId: "sample-station", stationName: "Sample Station" }],
    title: copy.title,
    description: copy.description,
    startsAt: 0,
    updatedAt: 0,
  };
}

function renderPopover(alert: AgencyAlert) {
  return render(() => (
    <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
      <StationPopover
        agencyId="sample"
        station={station}
        coords={{ x: 100, y: 100 }}
        containerSize={{ width: 320, height: 640 }}
        onClose={() => {}}
        setRef={() => {}}
        alerts={[alert]}
        linesById={railMap.linesById}
      />
    </UserPreferencesProvider>
  ));
}

describe("StationPopover accessibility alerts", () => {
  it("does not claim normal service or inaccessible facilities without operator information", () => {
    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
        <StationPopover
          agencyId="intercity"
          station={{ ...station, accessible: undefined }}
          coords={{ x: 100, y: 100 }}
          containerSize={{ width: 320, height: 640 }}
          onClose={() => {}}
          setRef={() => {}}
          alerts={[]}
          alertsAvailable={false}
          linesById={railMap.linesById}
        />
      </UserPreferencesProvider>
    ));
    expect(screen.getByText("Live alerts unavailable")).toBeDefined();
    expect(screen.getByText("Accessibility information unavailable")).toBeDefined();
    expect(screen.queryByText("Normal Service")).toBeNull();
    expect(screen.queryByText("No elevator access")).toBeNull();
  });

  it("translates the stale alert status in the station header", async () => {
    const preferences = { ...DEFAULT_PREFERENCES, locale: "fr-CA" as const };
    render(() => (
      <UserPreferencesProvider storage={createMemoryPreferencesStorage(preferences)}>
        <I18nProvider>
          <StationPopover
            agencyId="intercity"
            station={station}
            coords={{ x: 100, y: 100 }}
            containerSize={{ width: 320, height: 640 }}
            onClose={() => {}}
            setRef={() => {}}
            alerts={[]}
            alertsFreshness="stale"
            linesById={railMap.linesById}
          />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Les alertes de service sont peut-être périmées")).toBeDefined();
    expect(screen.queryByText("Service alerts may be out of date")).toBeNull();
  });
  it("makes a long station-access warning fully readable", () => {
    renderPopover(makeAccessibilityAlert({ title, description }));

    expect(screen.getByText(title)).toBeDefined();
    expect(screen.getByText(description)).toBeDefined();
  });

  it("does not repeat a description when it matches the title", () => {
    renderPopover(makeAccessibilityAlert({ title, description: title }));

    expect(screen.getAllByText(title)).toHaveLength(1);
  });
});

describe("BaseMapPopover Keyboard Behavior", () => {
  it("dismisses on Escape key when rendered with coordinates", () => {
    const onClose = vi.fn();

    render(() => (
      <BaseMapPopover
        coords={{ x: 200, y: 400 }}
        containerSize={{ width: 400, height: 800 }}
        onClose={onClose}
        ariaLabel="Station details"
      >
        <div>Content</div>
      </BaseMapPopover>
    ));

    expect(screen.getByRole("dialog", { name: "Station details" })).toBeDefined();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("does not trigger onClose on Escape when coords are null", () => {
    const onClose = vi.fn();

    render(() => (
      <BaseMapPopover
        coords={null}
        containerSize={{ width: 400, height: 800 }}
        onClose={onClose}
        ariaLabel="Station details"
      >
        <div>Content</div>
      </BaseMapPopover>
    ));

    expect(screen.queryByRole("dialog", { name: "Station details" })).toBeNull();

    window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    expect(onClose).not.toHaveBeenCalled();
  });
});
