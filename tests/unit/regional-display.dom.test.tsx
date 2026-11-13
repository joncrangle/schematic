// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { afterEach, expect, it, vi } from "vitest";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { DEFAULT_PREFERENCES, type UserPreferences } from "~/domain/preferences/UserPreferences";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { FormattingCountryProvider, I18nProvider, useI18n } from "~/i18n/I18nContext";
import { NearbyEmptyState } from "~/components/nearby/NearbyEmptyState";
import { PreferencesTab } from "~/components/settings/PreferencesTab";
import { formatVehicleSpeed } from "~/components/route/routeTrackingHelpers";
import { toServiceAlerts, toUpcomingClosures } from "~/domain/serviceAlerts";
import { makeAgencyAlert } from "../helpers/fixtures";
import { en } from "~/i18n/en";
import { fr } from "~/i18n/fr";

vi.mock("~/agencies/agencyCatalog", async () => ({
  agencyCatalog: (await import("../helpers/agency-fixtures")).testAgencyCatalog,
}));
vi.mock("~/hooks/usePushAvailability", () => ({
  usePushAvailability: () => ({ isAvailable: () => false }),
}));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const date = new Date("2026-05-23T16:07:00Z");
function Probe() {
  const i18n = useI18n();
  return (
    <>
      <output data-testid="region">{i18n.formatLocale()}</output>
      <output data-testid="date">{i18n.formatDate(date, { timeZone: "UTC" })}</output>
      <output data-testid="time">{i18n.formatTime(date, { timeZone: "UTC" })}</output>
      <output data-testid="speed">{formatVehicleSpeed(10, i18n)}</output>
    </>
  );
}
function mount(preferences: UserPreferences = DEFAULT_PREFERENCES, country?: string) {
  const storage = createMemoryPreferencesStorage(preferences);
  render(() => (
    <UserPreferencesProvider storage={storage}>
      <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? fr : en)}>
        <FormattingCountryProvider country={country}>
          <PreferencesTab />
          <Probe />
          <NearbyEmptyState agencyId="sample" isDataUnavailable />
        </FormattingCountryProvider>
      </I18nProvider>
    </UserPreferencesProvider>
  ));
  return storage;
}

it.each([
  ["en-US", "en-CA", "5/23/2026", "4:07 PM"],
  ["en-CA", "en-CA", "2026-05-23", "4:07 p.m."],
  ["en-GB", "en-CA", "23/05/2026", "16:07"],
  ["fr-CA", "fr-CA", "2026-05-23", "16 h 07"],
] as const)(
  "uses %s regional conventions with %s chrome",
  async (browser, locale, expectedDate, time) => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue([browser]);
    mount({ ...DEFAULT_PREFERENCES, locale });
    await waitFor(() => expect(screen.getByTestId("date").textContent).toBe(expectedDate));
    expect(screen.getByTestId("time").textContent?.replace(/\s/g, " ")).toBe(time);
    expect(document.documentElement.lang).toBe(locale);
  },
);

it("persists display controls and updates distances, speeds, and date/time labels", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  const storage = mount({ ...DEFAULT_PREFERENCES, unitSystem: "metric" });
  await screen.findByRole("radio", { name: "Metric" });
  expect(screen.getByText(/No stops found within 1.5 km/)).toBeDefined();
  await fireEvent.click(screen.getByRole("radio", { name: "Day / month / year" }));
  await fireEvent.click(screen.getByRole("radio", { name: "24-hour" }));
  await fireEvent.click(screen.getByRole("radio", { name: "Imperial" }));
  await waitFor(() => expect(screen.getByTestId("speed").textContent).toBe("22 mph"));
  expect(screen.getByTestId("date").textContent).toBe("23/5/2026");
  expect(screen.getByTestId("time").textContent?.replace(/\s/g, " ")).toBe("16:07");
  expect(screen.getByText(/No stops found within 0.9 mi/)).toBeDefined();
  await waitFor(async () =>
    expect(await storage.load()).toMatchObject({
      dateOrder: "dmy",
      timeFormat: "24h",
      unitSystem: "imperial",
    }),
  );
});

it("updates agency-country fallback reactively when the browser has no region", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en"]);
  function RegionProbe() {
    const [country, setCountry] = createSignal("US");
    return (
      <FormattingCountryProvider country={country()}>
        <Probe />
        <button onClick={() => setCountry("GB")}>Change network</button>
      </FormattingCountryProvider>
    );
  }
  render(() => (
    <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
      <I18nProvider>
        <RegionProbe />
      </I18nProvider>
    </UserPreferencesProvider>
  ));
  await waitFor(() => expect(screen.getByTestId("region").textContent).toBe("en-US"));
  await fireEvent.click(screen.getByRole("button", { name: "Change network" }));
  await waitFor(() => expect(screen.getByTestId("region").textContent).toBe("en-GB"));
  expect(screen.getByTestId("time").textContent).toBe("16:07");
});

it.each(["metric", "imperial"] as const)(
  "keeps slow and missing vehicle speeds semantic in %s units",
  async (unitSystem) => {
    function SpeedProbe() {
      const i18n = useI18n();
      return (
        <output>
          {JSON.stringify([
            formatVehicleSpeed(undefined, i18n),
            formatVehicleSpeed(0.5, i18n),
            formatVehicleSpeed(0.6, i18n),
          ])}
        </output>
      );
    }
    render(() => (
      <UserPreferencesProvider
        storage={createMemoryPreferencesStorage({ ...DEFAULT_PREFERENCES, unitSystem })}
      >
        <I18nProvider>
          <SpeedProbe />
        </I18nProvider>
      </UserPreferencesProvider>
    ));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe(
        JSON.stringify([null, "Stopped", unitSystem === "metric" ? "2 km/h" : "1 mph"]),
      ),
    );
  },
);

it("applies regional date and time overrides to actual alert presentation", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-GB"]);
  function AlertProbe() {
    const i18n = useI18n();
    const presentation = { formatDate: i18n.formatDate, formatTime: i18n.formatTime };
    const alert = makeAgencyAlert({ updatedAt: date.getTime(), startsAt: date.getTime() });
    return (
      <>
        <output data-testid="updated-at">
          {toServiceAlerts([alert], undefined, presentation)[0]?.updatedAtLabel}
        </output>
        <output data-testid="upcoming">
          {
            toUpcomingClosures([{ ...alert, lifecycle: "upcoming" }], undefined, presentation)[0]
              ?.dateRange
          }
        </output>
      </>
    );
  }
  render(() => (
    <UserPreferencesProvider
      storage={createMemoryPreferencesStorage({
        ...DEFAULT_PREFERENCES,
        dateOrder: "dmy",
        timeFormat: "24h",
      })}
    >
      <I18nProvider>
        <AlertProbe />
      </I18nProvider>
    </UserPreferencesProvider>
  ));
  const time = new Intl.DateTimeFormat("en-GB", {
    hour: "numeric",
    minute: "2-digit",
    hourCycle: "h23",
  }).format(date);
  await waitFor(() =>
    expect(screen.getByTestId("updated-at").textContent).toBe(
      new Intl.DateTimeFormat("en-GB", {
        hour: "2-digit",
        minute: "2-digit",
        hourCycle: "h23",
      }).format(date),
    ),
  );
  expect(screen.getByTestId("upcoming").textContent).toBe(`Starts 23 May, ${time}`);
});

it.each([
  ["en-CA", "Year / month / day", "12-hour", "Metric"],
  ["en-US", "Month / day / year", "12-hour", "Imperial"],
  ["en-GB", "Day / month / year", "24-hour", "Imperial"],
] as const)(
  "shows resolved %s defaults as actual choices",
  async (browser, dateOrder, timeFormat, units) => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue([browser]);
    mount();
    await waitFor(() =>
      expect((screen.getByRole("radio", { name: dateOrder }) as HTMLInputElement).checked).toBe(
        true,
      ),
    );
    expect((screen.getByRole("radio", { name: timeFormat }) as HTMLInputElement).checked).toBe(
      true,
    );
    expect((screen.getByRole("radio", { name: units }) as HTMLInputElement).checked).toBe(true);
    expect(screen.queryByText("Regional default")).toBeNull();
  },
);

it("resets format overrides to the selected regional choices without changing language", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-GB"]);
  const storage = mount({
    ...DEFAULT_PREFERENCES,
    dateOrder: "ymd",
    timeFormat: "12h",
    unitSystem: "metric",
    spelling: "american",
  });
  await screen.findByRole("button", { name: "Reset formats" });
  await fireEvent.click(screen.getByRole("button", { name: "Reset formats" }));
  await waitFor(async () =>
    expect(await storage.load()).toMatchObject({
      dateOrder: "locale",
      timeFormat: "locale",
      unitSystem: "locale",
      spelling: "locale",
      locale: "en-CA",
    }),
  );
  expect(
    (screen.getByRole("radio", { name: "Day / month / year" }) as HTMLInputElement).checked,
  ).toBe(true);
  expect((screen.getByRole("radio", { name: "24-hour" }) as HTMLInputElement).checked).toBe(true);
  expect((screen.getByRole("radio", { name: "Imperial" }) as HTMLInputElement).checked).toBe(true);
  expect(
    (screen.getByRole("button", { name: "Reset formats" }) as HTMLButtonElement).disabled,
  ).toBe(true);
});

it("defaults to metric for a Canadian network even with an en-US browser language", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  mount(DEFAULT_PREFERENCES, "CA");
  await waitFor(() =>
    expect({
      selectedMetric: (screen.getByRole("radio", { name: "Metric" }) as HTMLInputElement).checked,
      speed: screen.getByTestId("speed").textContent,
    }).toEqual({ selectedMetric: true, speed: "36 km/h" }),
  );
});

it.each([
  ["an en-US browser", "en-US", undefined, "American", /Save favorite routes/],
  ["an en-US browser on a Canadian network", "en-US", "CA", "Canadian", /Save favourite routes/],
  ["an en-GB browser", "en-GB", undefined, "Canadian", /Save favourite routes/],
  ["an en-CA browser on a US network", "en-CA", "US", "American", /Save favorite routes/],
] as const)("spells English like units for %s", async (_, browser, country, choice, copy) => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue([browser]);
  mount(DEFAULT_PREFERENCES, country);
  expect(await screen.findByText(copy)).toBeDefined();
  expect((screen.getByRole("radio", { name: choice }) as HTMLInputElement).checked).toBe(true);
});

it("lets an inner network region replace an outer one's spelling as it changes", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  const [country, setCountry] = createSignal("US");
  render(() => (
    <UserPreferencesProvider storage={createMemoryPreferencesStorage()}>
      <I18nProvider>
        <FormattingCountryProvider country="US">
          <FormattingCountryProvider country={country()}>
            <NearbyEmptyState agencyId="sample" isDataUnavailable />
          </FormattingCountryProvider>
        </FormattingCountryProvider>
      </I18nProvider>
    </UserPreferencesProvider>
  ));
  expect(await screen.findByText(/Save favorite routes/)).toBeDefined();
  setCountry("CA");
  expect(await screen.findByText(/Save favourite routes/)).toBeDefined();
});

it("keeps a chosen spelling over the network's region", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  const storage = mount(DEFAULT_PREFERENCES, "US");
  await fireEvent.click(await screen.findByRole("radio", { name: "Canadian" }));
  expect(await screen.findByText(/Save favourite routes/)).toBeDefined();
  await waitFor(async () => expect((await storage.load()).spelling).toBe("canadian"));
});

it("leaves French chrome unchanged by an American spelling choice", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["fr-CA"]);
  mount({ ...DEFAULT_PREFERENCES, locale: "fr-CA", spelling: "american" }, "US");
  expect(await screen.findByText(/Enregistrez des lignes favorites/)).toBeDefined();
  expect(screen.queryByRole("radio", { name: "Américaine" })).toBeNull();
});

it("preserves explicit imperial units in Canada while using Canadian regional defaults", async () => {
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
  mount({ ...DEFAULT_PREFERENCES, unitSystem: "imperial" }, "CA");
  await waitFor(() => expect(screen.getByTestId("region").textContent).toBe("en-CA"));
  expect((screen.getByRole("radio", { name: "Imperial" }) as HTMLInputElement).checked).toBe(true);
  expect(screen.getByTestId("speed").textContent).toBe("22 mph");
});

it.each([
  ["Metric", "unitSystem", "metric"],
  ["12-hour", "timeFormat", "12h"],
  ["Year / month / day", "dateOrder", "ymd"],
] as const)(
  "pins the already-selected %s choice across country changes and reloads",
  async (label, key, value) => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
    const storage = createMemoryPreferencesStorage();
    function Harness() {
      const [country, setCountry] = createSignal("CA");
      return (
        <UserPreferencesProvider storage={storage}>
          <I18nProvider>
            <FormattingCountryProvider country={country()}>
              <PreferencesTab />
              <button onClick={() => setCountry("GB")}>Move country</button>
            </FormattingCountryProvider>
          </I18nProvider>
        </UserPreferencesProvider>
      );
    }
    const first = render(() => <Harness />);
    const choice = await screen.findByRole("radio", { name: label });
    expect((choice as HTMLInputElement).checked).toBe(true);
    await fireEvent.click(choice);
    await waitFor(async () => expect((await storage.load())[key]).toBe(value));
    await fireEvent.click(screen.getByRole("button", { name: "Move country" }));
    expect((screen.getByRole("radio", { name: label }) as HTMLInputElement).checked).toBe(true);
    first.unmount();
    render(() => (
      <UserPreferencesProvider storage={storage}>
        <I18nProvider>
          <FormattingCountryProvider country="GB">
            <PreferencesTab />
          </FormattingCountryProvider>
        </I18nProvider>
      </UserPreferencesProvider>
    ));
    await waitFor(() =>
      expect((screen.getByRole("radio", { name: label }) as HTMLInputElement).checked).toBe(true),
    );
  },
);
