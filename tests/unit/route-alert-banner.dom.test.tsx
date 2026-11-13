// @vitest-environment happy-dom
import { describe, expect, it, afterEach } from "vitest";
import { createSignal, flush } from "solid-js";
import { render, screen, cleanup } from "@solidjs/testing-library";
import { RouteAlertBanner, AlertAccordionItem } from "~/components/route/RouteAlertBanner";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";
import { en } from "~/i18n/en";
import { fr } from "~/i18n/fr";
import { makeAlert } from "../helpers/fixtures";

afterEach(cleanup);

describe("RouteAlertBanner presentation", () => {
  it("renders each alert's title with its directional chip", () => {
    render(() => (
      <>
        <AlertAccordionItem
          alert={makeAlert({ title: "510 Spadina: Eastbound detour" })}
          isExpanded={false}
          onToggle={() => {}}
        />
        <AlertAccordionItem
          alert={makeAlert({ title: "Both directions: Suspension" })}
          isExpanded={false}
          onToggle={() => {}}
        />
      </>
    ));
    expect(screen.getByText("510 Spadina: Eastbound detour")).toBeDefined();
    expect(screen.getByText("[Eastbound]")).toBeDefined();
    expect(screen.getByText("[Both Directions]")).toBeDefined();
  });

  it("localizes a French directional chip while preserving the operator title", async () => {
    const title = "Ligne 97 : Retards en direction du sud";
    const description = "Les retards continuent en direction du sud.";

    render(() => (
      <UserPreferencesProvider
        storage={{
          load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
          save: async () => {},
        }}
      >
        <I18nProvider loadDictionary={async (locale) => (locale === "fr-CA" ? fr : en)}>
          <RouteAlertBanner alerts={[makeAlert({ title, description })]} />
        </I18nProvider>
      </UserPreferencesProvider>
    ));

    expect(await screen.findByText(title)).toBeDefined();
    expect(screen.getByText("[Direction sud]")).toBeDefined();
    screen.getByRole("button").click();
    flush();
    expect(screen.getByText(description)).toBeDefined();
  });

  it("renders collapsed items truncated with descriptions hidden", () => {
    render(() => (
      <AlertAccordionItem
        alert={makeAlert({ title: "97 Yonge: Very long detour and delay title" })}
        isExpanded={false}
        onToggle={() => {}}
      />
    ));
    const titleEl = screen.getByText("97 Yonge: Very long detour and delay title");
    expect(titleEl).toBeDefined();
    expect(
      screen.queryByText("Expect 5-10 minute delays due to watermain work near St Clair."),
    ).toBeNull();
  });

  it("renders expanded items wrapped with descriptions visible", () => {
    render(() => (
      <AlertAccordionItem
        alert={makeAlert({ title: "97 Yonge: Very long detour and delay title" })}
        isExpanded={true}
        onToggle={() => {}}
      />
    ));
    const titleEl = screen.getByText("97 Yonge: Very long detour and delay title");
    expect(titleEl).toBeDefined();
    expect(
      screen.getByText("Expect 5-10 minute delays due to watermain work near St Clair."),
    ).toBeDefined();
  });

  it("calls onToggle when an item's button is clicked", () => {
    let called = false;
    render(() => (
      <AlertAccordionItem
        alert={makeAlert({ title: "97 Yonge: Delay" })}
        isExpanded={false}
        onToggle={() => {
          called = true;
        }}
      />
    ));
    screen.getByRole("button").click();
    expect(called).toBe(true);
  });

  it.each([
    ["missing", undefined],
    ["identical to the title", "97 Yonge: Delay"],
  ])(
    "never renders a duplicate title paragraph when the description is %s",
    (_label, description) => {
      render(() => (
        <AlertAccordionItem
          alert={makeAlert({ title: "97 Yonge: Delay", description })}
          isExpanded={true}
          onToggle={() => {}}
        />
      ));
      expect(screen.getAllByText("97 Yonge: Delay").length).toBe(1);
    },
  );
});

describe("RouteAlertBanner", () => {
  it("renders a labelled region listing every alert", () => {
    render(() => (
      <RouteAlertBanner
        alerts={[
          makeAlert({ id: "alert_yonge_delay", title: "97 Yonge: Construction delay" }),
          makeAlert({ id: "alert_carlton_short", title: "506 Carlton: Short turn" }),
        ]}
      />
    ));
    expect(screen.getByRole("region", { name: "Route service alerts" })).toBeDefined();
    expect(screen.getByText("97 Yonge: Construction delay")).toBeDefined();
    expect(screen.getByText("506 Carlton: Short turn")).toBeDefined();
  });

  it("keeps same-title alerts when their warning descriptions differ", () => {
    render(() => (
      <RouteAlertBanner
        alerts={[
          makeAlert({
            id: "alert_northbound",
            title: "Line 1: Reduced speed",
            description: "Northbound trains are moving slower.",
          }),
          makeAlert({
            id: "alert_southbound",
            title: "Line 1: Reduced speed",
            description: "Southbound trains are moving slower.",
          }),
        ]}
      />
    ));

    expect(screen.getAllByText("Line 1: Reduced speed")).toHaveLength(2);
  });

  it("sorts severe alerts before degraded ones in DOM order", () => {
    render(() => (
      <RouteAlertBanner
        alerts={[
          makeAlert({ id: "alert_yonge_sort", title: "97 Yonge: Delay" }),
          makeAlert({
            id: "alert_spadina_sort",
            title: "510 Spadina: Suspension",
            severity: "severe",
            kind: "suspension",
          }),
        ]}
      />
    ));
    const region = screen.getByRole("region", { name: "Route service alerts" });
    const severeEl = screen.getByText("510 Spadina: Suspension");
    const degradedEl = screen.getByText("97 Yonge: Delay");
    const children = Array.from(region.children);
    const severeIdx = children.findIndex((c) => c.contains(severeEl));
    const degradedIdx = children.findIndex((c) => c.contains(degradedEl));
    expect(severeIdx).toBeLessThan(degradedIdx);
  });

  it("initially renders every alert collapsed", () => {
    render(() => (
      <RouteAlertBanner
        alerts={[
          makeAlert({ id: "alert_yonge_collapsed", title: "97 Yonge: Delay" }),
          makeAlert({ id: "alert_carlton_collapsed", title: "506 Carlton: Delay" }),
        ]}
      />
    ));
    expect(
      screen.queryByText("Expect 5-10 minute delays due to watermain work near St Clair."),
    ).toBeNull();
    expect(
      screen.getAllByRole("button").map((button) => button.getAttribute("aria-expanded")),
    ).toEqual(["false", "false"]);
  });

  it("toggles alerts independently", () => {
    render(() => (
      <RouteAlertBanner
        alerts={[
          makeAlert({ id: "alert_yonge", title: "97 Yonge: Delay" }),
          makeAlert({ id: "alert_carlton", title: "506 Carlton: Delay" }),
        ]}
      />
    ));
    screen.getAllByRole("button")[0].click();
    flush();
    const descriptions = screen.getAllByText(
      "Expect 5-10 minute delays due to watermain work near St Clair.",
    );
    expect(descriptions.length).toBe(1);
  });

  it("keeps an expanded accordion open across a refetch with fresh objects", () => {
    const [liveAlerts, setLiveAlerts] = createSignal([
      makeAlert({
        id: "banner-1",
        title: "97 Yonge: Delay",
        description: "First banner detail text.",
        updatedAt: 10,
      }),
      makeAlert({
        id: "banner-2",
        title: "506 Carlton: Delay",
        description: "Second banner detail text.",
        updatedAt: 10,
      }),
    ]);
    render(() => <RouteAlertBanner alerts={liveAlerts()} />);

    screen.getAllByRole("button")[0].click();
    flush();
    expect(screen.getByText("First banner detail text.")).toBeDefined();

    // Refetch: fresh objects, same content, bumped fetch-clock stamp.
    setLiveAlerts((prev) => prev.map((alert) => ({ ...alert, updatedAt: 20 })));
    flush();

    expect(screen.getByText("First banner detail text.")).toBeDefined();
    expect(screen.getAllByRole("button")[0]!.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getAllByRole("button")[1]!.getAttribute("aria-expanded")).toBe("false");
  });

  it("keeps the untouched accordion expanded when a sibling alert changes", () => {
    const [liveAlerts, setLiveAlerts] = createSignal([
      makeAlert({
        id: "banner-1",
        title: "97 Yonge: Delay",
        description: "First banner detail text.",
        updatedAt: 10,
      }),
      makeAlert({
        id: "banner-2",
        title: "506 Carlton: Delay",
        description: "Second banner detail text.",
        updatedAt: 10,
      }),
    ]);
    render(() => <RouteAlertBanner alerts={liveAlerts()} />);

    screen.getAllByRole("button")[0].click();
    flush();
    expect(screen.getByText("First banner detail text.")).toBeDefined();

    setLiveAlerts((prev) =>
      prev.map((alert) =>
        alert.id === "banner-2"
          ? { ...alert, title: "506 Carlton: Detour", updatedAt: 10 }
          : { ...alert, updatedAt: 10 },
      ),
    );
    flush();

    expect(screen.getByText("First banner detail text.")).toBeDefined();
    expect(screen.getByText("506 Carlton: Detour")).toBeDefined();
  });
});
