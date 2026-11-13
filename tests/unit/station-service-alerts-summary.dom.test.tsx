// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from "vitest";
import { createSignal, flush } from "solid-js";
import { cleanup, render, screen } from "@solidjs/testing-library";
import { StationServiceAlertsSummary } from "~/components/map/StationServiceAlertsSummary";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";
import { en } from "~/i18n/en";
import { fr } from "~/i18n/fr";

afterEach(cleanup);

const alerts = [
  {
    id: "south-1",
    kind: "slow-service" as const,
    severity: "degraded" as const,
    lifecycle: "active" as const,
    scope: "station" as const,
    affectedLineIds: ["1"],
    affectedStations: [{ stationId: "college", stationName: "College" }],
    title: "Line 1 Yonge-University: slower southbound from Wellesley to College",
    startsAt: 0,
    updatedAt: 10,
  },
  {
    id: "south-2",
    kind: "slow-service" as const,
    severity: "degraded" as const,
    lifecycle: "active" as const,
    scope: "station" as const,
    affectedLineIds: ["1"],
    affectedStations: [{ stationId: "college", stationName: "College" }],
    title: "Line 1 Yonge-University: slower southbound from College to TMU",
    startsAt: 0,
    updatedAt: 20,
  },
  {
    id: "north-1",
    kind: "slow-service" as const,
    severity: "degraded" as const,
    lifecycle: "active" as const,
    scope: "station" as const,
    affectedLineIds: ["1"],
    affectedStations: [{ stationId: "college", stationName: "College" }],
    title: "Line 1 Yonge-University: slower northbound from TMU to College",
    startsAt: 0,
    updatedAt: 30,
  },
];

describe("StationServiceAlertsSummary", () => {
  it.each([
    ["an app-generated heading", "", "Dienst"],
    ["an operator-authored prefix", "Service: ", "Service"],
  ])("uses the catalog only for %s", async (_label, prefix, heading) => {
    const grouped = alerts.slice(0, 2).map((alert, index) => ({
      ...alert,
      title: `${prefix}Advisory ${index + 1}`,
      description: "Service: Track work.",
    }));
    render(() => (
      <UserPreferencesProvider
        storage={{ load: async () => DEFAULT_PREFERENCES, save: async () => {} }}
      >
        <I18nProvider loadDictionary={async () => ({ ...en, Service: "Dienst" })}>
          <StationServiceAlertsSummary alerts={grouped} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText(heading)).toBeDefined();
    screen.getByRole("button").click();
    flush();
    const detailTitles = prefix
      ? ["Service: Advisory 1", "Service: Advisory 2"]
      : ["Advisory 1", "Advisory 2"];
    for (const title of detailTitles) expect(screen.getByText(title)).toBeDefined();
    expect(screen.getAllByText("Service: Track work.")).toHaveLength(2);
  });

  it("collapses related station advisories and reveals their details on demand", () => {
    render(() => <StationServiceAlertsSummary alerts={alerts} />);

    expect(screen.getByText("Line 1 Yonge-University")).toBeDefined();
    expect(screen.getByText("3 advisories")).toBeDefined();
    expect(screen.getByText("[Both Directions]")).toBeDefined();
    expect(screen.queryByText(alerts[0]!.title)).toBeNull();

    screen.getByRole("button").click();
    flush();

    expect(screen.getByText("slower from Wellesley to College")).toBeDefined();
    expect(screen.getByText("slower from College to TMU")).toBeDefined();
    expect(screen.getByText("slower from TMU to College")).toBeDefined();
    expect(screen.queryByText(alerts[0]!.title)).toBeNull();
  });

  it("localizes grouped direction chips and the advisory count in collapsed and expanded rows", async () => {
    render(() => (
      <UserPreferencesProvider
        storage={{
          load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
          save: async () => {},
        }}
      >
        <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? fr : en)}>
          <StationServiceAlertsSummary alerts={alerts} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("3 avis")).toBeDefined();
    expect(screen.getByText("[Les deux directions]")).toBeDefined();

    screen.getByRole("button").click();
    flush();

    expect(screen.getAllByText("[Direction sud]")).toHaveLength(2);
    expect(screen.getByText("[Direction nord]")).toBeDefined();
    expect(screen.getByText("3 avis")).toBeDefined();
  });

  it("parses French southbound operator alerts without translating their prose", async () => {
    const frenchAlerts = [
      {
        ...alerts[0]!,
        id: "fr-south-1",
        title: "Ligne 1 : Retards en direction du sud près de Collège",
        description: "Retards en direction du sud près de Collège.",
      },
      {
        ...alerts[1]!,
        id: "fr-south-2",
        title: "Ligne 1 : Déviation vers le sud près de College",
        description: "Déviation vers le sud près de College.",
      },
    ];

    render(() => (
      <UserPreferencesProvider
        storage={{
          load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
          save: async () => {},
        }}
      >
        <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? fr : en)}>
          <StationServiceAlertsSummary alerts={frenchAlerts} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText("[Direction sud]")).toBeDefined();
    screen.getByRole("button").click();
    flush();

    expect(screen.getAllByText("[Direction sud]")).toHaveLength(3);
    expect(screen.getByText("Retards en direction du sud près de Collège.")).toBeDefined();
  });

  it("keeps a singleton accordion expanded across a refetch with fresh objects", () => {
    const initial = [
      {
        id: "single-1",
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        title: "Line 1: Delay at Union",
        description: "First advisory detail text.",
        startsAt: 0,
        updatedAt: 10,
      },
      {
        id: "single-2",
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        title: "Line 2: Delay at Bloor",
        description: "Second advisory detail text.",
        startsAt: 0,
        updatedAt: 10,
      },
    ];
    const [liveAlerts, setLiveAlerts] = createSignal(initial);
    render(() => <StationServiceAlertsSummary alerts={liveAlerts()} />);

    screen.getAllByRole("button")[0].click();
    flush();
    expect(screen.getByText("First advisory detail text.")).toBeDefined();

    // Refetch: fresh objects, same content, bumped fetch-clock stamp.
    setLiveAlerts((prev) => prev.map((alert) => ({ ...alert, updatedAt: 20 })));
    flush();

    expect(screen.getByText("First advisory detail text.")).toBeDefined();
    expect(screen.getAllByRole("button")[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("button")[1]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the untouched singleton expanded when a sibling advisory changes", () => {
    const initial = [
      {
        id: "single-1",
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        title: "Line 1: Delay at Union",
        description: "First advisory detail text.",
        startsAt: 0,
        updatedAt: 10,
      },
      {
        id: "single-2",
        kind: "delay" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        title: "Line 2: Delay at Bloor",
        description: "Second advisory detail text.",
        startsAt: 0,
        updatedAt: 10,
      },
    ];
    const [liveAlerts, setLiveAlerts] = createSignal(initial);
    render(() => <StationServiceAlertsSummary alerts={liveAlerts()} />);

    screen.getAllByRole("button")[0].click();
    flush();
    expect(screen.getByText("First advisory detail text.")).toBeDefined();

    setLiveAlerts((prev) =>
      prev.map((alert) =>
        alert.id === "single-2"
          ? { ...alert, title: "Line 2: Suspension at Bloor", updatedAt: 10 }
          : { ...alert, updatedAt: 10 },
      ),
    );
    flush();

    expect(screen.getByText("First advisory detail text.")).toBeDefined();
    expect(screen.getByText("Line 2: Suspension at Bloor")).toBeDefined();
  });

  it("keeps a multi-alert group expanded when member advisories change across refetch", () => {
    const initial = [
      {
        id: "group-1",
        kind: "slow-service" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "college", stationName: "College" }],
        title: "Line 1 Yonge-University: slower southbound from Wellesley to College",
        startsAt: 0,
        updatedAt: 10,
      },
      {
        id: "group-2",
        kind: "slow-service" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "college", stationName: "College" }],
        title: "Line 1 Yonge-University: slower northbound from TMU to College",
        startsAt: 0,
        updatedAt: 10,
      },
    ];
    const [liveAlerts, setLiveAlerts] = createSignal(initial);
    render(() => <StationServiceAlertsSummary alerts={liveAlerts()} />);

    const groupButton = screen.getByRole("button");
    groupButton.click();
    flush();
    expect(groupButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("slower from Wellesley to College")).toBeDefined();

    setLiveAlerts((prev) => [
      ...prev,
      {
        id: "group-3",
        kind: "slow-service" as const,
        severity: "degraded" as const,
        lifecycle: "active" as const,
        scope: "station" as const,
        affectedLineIds: ["1"],
        affectedStations: [{ stationId: "college", stationName: "College" }],
        title: "Line 1 Yonge-University: slower southbound from Bloor to Wellesley",
        startsAt: 0,
        updatedAt: 20,
      },
    ]);
    flush();

    const updatedButton = screen.getByRole("button");
    expect(updatedButton.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("slower from Bloor to Wellesley")).toBeDefined();
  });
});
