// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library";
import type { LiveVehiclePosition, RouteTrackingData, SurfaceStop } from "~/domain/surface/types";
import { LinearStopStrip } from "~/components/route/LinearStopStrip";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { I18nProvider } from "~/i18n/I18nContext";
import {
  formatOccupancyStatus,
  formatVehicleSpeed,
  formatStopsAwayText,
  getSurfaceModeMeta,
} from "~/components/route/routeTrackingHelpers";
import {
  englishMessageFormatter,
  translateFromDictionary,
  type MessageFormatter,
} from "~/i18n/translate";
import { en, type TranslationDictionary } from "~/i18n/en";

const stops: readonly SurfaceStop[] = [
  { id: "north", name: "North Station", lat: 43.7, lon: -79.4, wheelchair: 1, routes: ["1"] },
  { id: "south", name: "South Station", lat: 43.6, lon: -79.4, wheelchair: 1, routes: ["1"] },
];

const vehicle: LiveVehiclePosition = {
  vehicleId: "subway-1",
  routeId: "1",
  directionId: 0,
  latitude: 43.7,
  longitude: -79.4,
  timestamp: Date.now(),
};

const tracking: RouteTrackingData = {
  route: {
    id: "1",
    shortName: "1",
    longName: "Test Route",
    routeType: "bus",
    color: "#000000",
    textColor: "#ffffff",
  },
  shape: {
    id: "1-0",
    routeId: "1",
    directionId: 0,
    headsign: "North - Test Route to Terminal",
    polyline: "[]",
    minLat: 43.6,
    maxLat: 43.7,
    minLon: -79.4,
    maxLon: -79.4,
    pointCount: 2,
  },
  stops,
  vehicles: [vehicle, { ...vehicle, vehicleId: "bus-2", latitude: 43.6, directionId: 0 }],
  alerts: [],
  directionLabels: {
    0: { label: "Northbound", destination: "Terminal" },
    1: { label: "Southbound", destination: "Downtown" },
  },
};

afterEach(cleanup);

describe("LinearStopStrip subway presentation", () => {
  it("keeps subway strips static even when vehicle positions are supplied", () => {
    render(() => (
      <LinearStopStrip
        tracking={{ ...tracking, route: { ...tracking.route, routeType: "subway" } }}
        riderStop={{ id: "north" }}
      />
    ));

    expect(screen.getByText("Static line map")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Vehicle subway-1" })).toBeNull();
    expect(screen.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByTitle("North Station")).toBeDefined();
    expect(screen.getByTitle("South Station")).toBeDefined();
  });

  it("uses the route short name for the closest vehicle banner", () => {
    render(() => (
      <LinearStopStrip
        tracking={{
          ...tracking,
          vehicles: [
            { ...vehicle, vehicleId: "37d290f9-1542-4ab1-850c-e30e6484c", latitude: 43.6 },
          ],
        }}
        riderStop={{ id: "south" }}
      />
    ));

    expect(screen.getByText("Bus 1 · Arriving now")).toBeDefined();
  });

  it("renders the shared direction options and relays direction selection", () => {
    const onSelectDirection = vi.fn();
    render(() => (
      <LinearStopStrip
        tracking={tracking}
        riderStop={{ id: "south" }}
        onSelectDirection={onSelectDirection}
      />
    ));

    expect(screen.getByRole("button", { name: /Northbound.*Terminal/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Southbound.*Downtown/ })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: /Southbound.*Downtown/ }));
    expect(onSelectDirection).toHaveBeenCalledWith(1);
  });
});

describe("LinearStopStrip direction switcher", () => {
  it("localizes generated defaults and preserves an operator label that matches English", async () => {
    const preferences = { ...DEFAULT_PREFERENCES, locale: "fr-CA" as const };
    const storage = { load: async () => preferences, save: async () => {} };

    const view = render(() => (
      <UserPreferencesProvider storage={storage}>
        <I18nProvider>
          <LinearStopStrip
            tracking={{
              ...tracking,
              shape: { ...tracking.shape, headsign: "" },
              directionLabels: undefined,
            }}
            riderStop={{ id: "north" }}
          />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Direction nord")).toBeDefined();
    expect(await screen.findByText("Direction sud")).toBeDefined();
    view.unmount();

    render(() => (
      <UserPreferencesProvider storage={storage}>
        <I18nProvider>
          <LinearStopStrip
            tracking={{
              ...tracking,
              directionLabels: {
                0: { label: "Northbound", destination: "Operator Terminal" },
                1: { label: "Southbound", destination: "Operator Terminal" },
              },
            }}
            riderStop={{ id: "north" }}
          />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("Northbound")).toBeDefined();
    expect(screen.queryByText("Direction nord")).toBeNull();
    expect(screen.getByRole("button", { name: /Northbound.*Operator Terminal/ })).toBeDefined();
  });

  it("shows the destination as the heading when the operator stated no bearing", () => {
    // A label is a compass word only when the operator stated one. GO headsigns
    // name a terminal and no bearing, so the label is empty. Rendering it
    // unconditionally left the button with a blank heading and the direction
    // unreadable, which is what a rider at Aldershot saw.
    render(() => (
      <LinearStopStrip
        tracking={{
          ...tracking,
          directionLabels: {
            0: { label: "", destination: "Aldershot GO" },
            1: { label: "", destination: "Union Station" },
          },
        }}
        riderStop={{ id: "north" }}
      />
    ));

    // The destination is the primary line, and the arrow still introduces it:
    // dropping the arrow because the label is empty would leave "Aldershot GO"
    // reading as a station name rather than a direction.
    expect(screen.getByText("→ Aldershot GO")).toBeDefined();
    expect(screen.getByText("→ Union Station")).toBeDefined();
  });

  it("keeps the compass heading above the destination when one was stated", () => {
    render(() => <LinearStopStrip tracking={tracking} riderStop={{ id: "north" }} />);

    expect(screen.getByText("Northbound")).toBeDefined();
    expect(screen.getByText("→ Terminal")).toBeDefined();
  });
});

describe("Live Vehicle Tracking Calculations & Formatting", () => {
  it("formats human-readable occupancy statuses", () => {
    expect(formatOccupancyStatus("EMPTY")).toBe("Empty");
    expect(formatOccupancyStatus("MANY_SEATS_AVAILABLE")).toBe("Many seats available");
    expect(formatOccupancyStatus("FEW_SEATS_AVAILABLE")).toBe("Few seats available");
    expect(formatOccupancyStatus("STANDING_ROOM_ONLY")).toBe("Standing room only");
    expect(formatOccupancyStatus("FULL")).toBe("Full");
    expect(formatOccupancyStatus(undefined)).toBeNull();
  });

  it("formats vehicle speed in km/h", () => {
    expect(formatVehicleSpeed(6.5)).toBe("23 km/h");
    expect(formatVehicleSpeed(0)).toBe("Stopped");
    expect(formatVehicleSpeed(undefined)).toBeNull();
  });

  it("formats stops-away banner text for various modes", () => {
    expect(formatStopsAwayText("8412", 2, 3, "bus")).toBe("Bus 8412 · 2 stops away · 3 min");
    expect(formatStopsAwayText("4412", 1, 1, "streetcar")).toBe(
      "Streetcar 4412 · 1 stop away · Due",
    );
    expect(formatStopsAwayText("4401", 0, undefined, "streetcar")).toBe(
      "Streetcar 4401 · Arriving now",
    );
  });

  it("lets dictionary templates reorder route, arrival, and optional time", () => {
    const reorderedDictionary: TranslationDictionary = {
      ...en,
      "Vehicle arrival summary": "{{arrival}} | {{route}}",
      "Vehicle arrival summary with time": "{{time}} | {{arrival}} | {{route}}",
    };
    const formatter: MessageFormatter = {
      ...englishMessageFormatter,
      t: (key, ...[params]) => translateFromDictionary(key, reorderedDictionary, params),
    };

    expect(formatStopsAwayText("8412", 2, 3, "bus", formatter)).toBe(
      "3 min | 2 stops away | Bus 8412",
    );
    expect(formatStopsAwayText("4401", 0, undefined, "streetcar", formatter)).toBe(
      "Arriving now | Streetcar 4401",
    );
  });
});

describe("getSurfaceModeMeta", () => {
  it.each([
    ["express", "Express"],
    ["streetcar", "Streetcar"],
    ["bus", "Bus"],
    ["rail", "Rail"],
  ] as const)("%s vehicles use the semantic mode label %s", (routeType, name) => {
    expect(getSurfaceModeMeta(routeType).name).toBe(name);
  });

  it("falls back to the bus mode when route type is unknown", () => {
    const meta = getSurfaceModeMeta(undefined);
    expect(meta.name).toBe("Bus");
  });
});
