// @vitest-environment happy-dom
import { countries } from "../helpers/coverage-countries";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library";
import { flush } from "solid-js";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";
import type { BrowserAgency } from "~/agencies/types";
import {
  buildCoverageAgencies,
  buildCoverageView,
  createProjection,
  COVERAGE_SOURCES,
} from "~/components/network-coverage/coverageModel";
import { NetworkCoverage } from "~/components/network-coverage/NetworkCoverage";
import { makeTestProvider } from "../helpers/agency-fixtures";

class FakeResizeObserver {
  private disconnected = false;
  private readonly emit: (width: number, height: number) => void;

  constructor(callback: ResizeObserverCallback) {
    this.emit = (width, height) => {
      callback(
        [
          {
            contentRect: {
              width,
              height,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              right: width,
              bottom: height,
            },
          } as unknown as ResizeObserverEntry,
        ],
        {} as ResizeObserver,
      );
      flush();
    };
  }

  observe(): void {
    queueMicrotask(() => {
      if (!this.disconnected) this.emit(1200, 800);
    });
  }

  unobserve(): void {}

  disconnect(): void {
    this.disconnected = true;
  }
}

function browserAgency(overrides: Parameters<typeof makeTestProvider>[0]): BrowserAgency {
  const provider = makeTestProvider(overrides);
  return { manifest: provider.manifest, brandColor: provider.manifest.brandColor };
}

const providers = [
  browserAgency({
    id: "active",
    name: "Active Transit",
    shortName: "AT",
    status: "active",
    scope: "regional",
    brandColor: "#123456",
    bounds: [{ minLat: 43, maxLat: 44, minLon: -80, maxLon: -79 }],
    modes: ["subway"],
  }),
  browserAgency({
    id: "experimental",
    name: "Experimental Transit",
    shortName: "ET",
    status: "experimental",
    scope: "regional",
    brandColor: "#654321",
    bounds: [{ minLat: 45, maxLat: 46, minLon: -76, maxLon: -75 }],
    modes: ["bus"],
    stationService: { routeType: "bus" },
  }),
];

function mapTitles(container: HTMLElement): string[] {
  return [...container.querySelectorAll("svg title")].map((title) => title.textContent ?? "");
}

const originalAnimate = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, "animate");

describe("NetworkCoverage", () => {
  beforeEach(() => {
    vi.stubGlobal("ResizeObserver", FakeResizeObserver);
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      () =>
        ({
          width: 1200,
          height: 800,
          left: 0,
          top: 0,
          right: 1200,
          bottom: 800,
          x: 0,
          y: 0,
          toJSON: () => ({}),
        }) as DOMRect,
    );
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    if (originalAnimate)
      Object.defineProperty(HTMLDialogElement.prototype, "animate", originalAnimate);
    else Reflect.deleteProperty(HTMLDialogElement.prototype, "animate");
  });

  it("localizes the map and focused country in French", async () => {
    render(() => (
      <UserPreferencesProvider
        storage={{
          load: async () => ({ ...DEFAULT_PREFERENCES, locale: "fr-CA" }),
          save: async () => {},
        }}
      >
        <I18nProvider>
          <NetworkCoverage
            countries={countries}
            providers={[
              browserAgency({
                id: "french-local",
                jurisdiction: { country: "us" },
                bounds: [{ minLat: 40.74, maxLat: 40.76, minLon: -74, maxLon: -73.98 }],
              }),
            ]}
            currentAgencyId={undefined}
            onClose={() => {}}
          />
        </I18nProvider>
      </UserPreferencesProvider>
    ));
    expect(
      await screen.findByRole("group", {
        name: "Carte de la zone de desserte",
      }),
    ).toBeTruthy();
    expect(await screen.findByText("États-Unis")).toBeTruthy();
  });

  it("filters agencies while a status label is hovered", () => {
    const { container } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));

    fireEvent.pointerEnter(screen.getByRole("button", { name: "active" }));
    flush();

    expect(mapTitles(container)).toContain("Active Transit");
    expect(mapTitles(container)).not.toContain("Experimental Transit");

    fireEvent.pointerLeave(screen.getByRole("button", { name: "active" }));
    flush();

    expect(mapTitles(container)).toContain("Experimental Transit");
  });

  it("toggles the coverage clouds with a switch", () => {
    const { container } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));
    const toggle = screen.getByRole("switch");

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelectorAll("svg title")).toHaveLength(4);

    fireEvent.click(toggle);
    flush();

    expect(toggle.getAttribute("aria-checked")).toBe("false");
    expect(container.querySelectorAll("svg title")).toHaveLength(2);
  });

  it("outlines every zone with one halo and redraws no map geometry on zoom", () => {
    const { container } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={[
          browserAgency({
            id: "zoned",
            name: "Zoned Transit",
            bounds: [
              { minLat: 43, maxLat: 43.2, minLon: -80, maxLon: -79.8 },
              { minLat: 43.5, maxLat: 43.7, minLon: -79.5, maxLon: -79.3 },
              { minLat: 44, maxLat: 44.2, minLon: -79, maxLon: -78.8 },
            ],
          }),
          browserAgency({
            id: "rail",
            name: "Rail Network",
            scope: "national",
            bounds: [
              { minLat: 43.6, maxLat: 43.7, minLon: -79.4, maxLon: -79.3 },
              { minLat: 45.4, maxLat: 45.5, minLon: -75.7, maxLon: -75.6 },
            ],
          }),
        ]}
        currentAgencyId={undefined}
        onClose={() => {}}
      />
    ));
    const cloud = [...container.querySelectorAll("svg title")].find(
      (title) =>
        title.textContent === "Zoned Transit" && title.parentElement?.querySelector("path"),
    )!.parentElement!;
    const halo = cloud.querySelector("path");
    expect(halo?.getAttribute("d")?.match(/M/g)).toHaveLength(3);

    const camera = container.querySelector("svg g[transform]")!;
    const shapes = [...camera.querySelectorAll("path, circle, g")].filter(
      (shape) => !shape.closest("pattern"),
    );
    const geometry = (shape: Element) =>
      ["d", "r", "stroke-width"].map((name) => shape.getAttribute(name)).join("|");
    const before = shapes.map(geometry);
    expect(camera.querySelectorAll('path[stroke-width="3"]')).toHaveLength(2);

    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    flush();

    // Only the hatch tile and label text track the zoom.
    expect(
      shapes.filter((shape, index) => !shape.isConnected || geometry(shape) !== before[index]),
    ).toEqual([]);
  });

  it("rests inactive coverage halos only while a gesture moves the camera", async () => {
    const { container } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId={undefined}
        onClose={() => {}}
      />
    ));
    const haloVisibility = (name: string) =>
      [...container.querySelectorAll("svg title")]
        .find((title) => title.textContent === name && title.parentElement?.querySelector("path"))!
        .parentElement!.querySelector("path")!
        .getAttribute("visibility");
    const canvas = screen.getByRole("group", {
      name: "Service area map",
    }).parentElement!;
    const touch = (type: "pointerDown" | "pointerMove" | "pointerUp", id: number, x: number) =>
      fireEvent[type](canvas, { pointerId: id, pointerType: "touch", clientX: x, clientY: 400 });
    const nextFrame = async () => {
      await new Promise((resolve) => requestAnimationFrame(resolve));
      flush();
    };
    fireEvent.click(screen.getByRole("button", { name: "Active Transit" }));
    flush();

    touch("pointerDown", 1, 600);
    touch("pointerUp", 1, 600);
    flush();
    expect(haloVisibility("Experimental Transit")).toBe("visible");

    touch("pointerDown", 1, 600);
    touch("pointerMove", 1, 660);
    await nextFrame();
    expect(haloVisibility("Experimental Transit")).toBe("hidden");
    expect(haloVisibility("Active Transit")).toBe("visible");

    touch("pointerDown", 2, 760);
    flush();
    expect(haloVisibility("Experimental Transit")).toBe("hidden");

    touch("pointerUp", 2, 760);
    touch("pointerUp", 1, 660);
    flush();
    expect(haloVisibility("Experimental Transit")).toBe("visible");
  });

  it("opens as a native modal and restores the trigger focus on close", () => {
    const trigger = document.createElement("button");
    document.body.append(trigger);
    trigger.focus();
    const { unmount } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));
    const dialog = screen.getByRole("dialog") as HTMLDialogElement;
    expect(dialog.open).toBe(true);
    expect(dialog.contains(document.activeElement)).toBe(true);
    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("lets keyboard users select an agency and read its details", () => {
    render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));
    const marker = screen.getByRole("button", { name: "Experimental Transit" });
    fireEvent.keyDown(marker, { key: "Enter" });
    flush();
    expect(marker.getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("Experimental Transit", { selector: "span" })).toBeTruthy();
  });

  it("clears the agency details when a touch selection is toggled off", () => {
    render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));
    const marker = screen.getByRole("button", { name: "Experimental Transit" });

    fireEvent.pointerEnter(marker, { pointerType: "touch" });
    fireEvent.click(marker);
    flush();
    expect(screen.getByText("Experimental Transit", { selector: "span" })).toBeTruthy();

    fireEvent.click(marker);
    flush();
    expect(marker.getAttribute("aria-pressed")).toBe("false");
    expect(screen.queryByText("Experimental Transit", { selector: "span" })).toBeNull();
  });

  it("updates country counts on pan while retaining the network layer", async () => {
    const networks = [
      browserAgency({
        id: "local",
        jurisdiction: { country: "ca" },
        bounds: [{ minLat: 43.7, maxLat: 43.9, minLon: -79.5, maxLon: -79.3 }],
      }),
      browserAgency({
        id: "national",
        name: "National Network",
        scope: "national",
        jurisdiction: { country: "us" },
        bounds: [{ minLat: 40.7, maxLat: 40.8, minLon: -74.1, maxLon: -74 }],
      }),
      browserAgency({
        id: "second-national",
        name: "Second National Network",
        scope: "national",
        jurisdiction: { country: "us" },
        bounds: [{ minLat: 40.7, maxLat: 40.8, minLon: -74.1, maxLon: -74 }],
      }),
      browserAgency({
        id: "international",
        name: "International Network",
        scope: "international",
        jurisdiction: { country: "ca" },
        bounds: [
          { minLat: 43.6, maxLat: 43.8, minLon: -79.5, maxLon: -79.3 },
          { minLat: 40.7, maxLat: 40.8, minLon: -74.1, maxLon: -74 },
        ],
      }),
    ];
    const { container } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={networks}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));
    const header = within(container.querySelector("header")!);
    await waitFor(() => expect(header.getByText("Canada")).toBeTruthy());
    expect(header.getByText("Regional").previousElementSibling?.textContent).toBe("1");
    expect(header.queryByText("National")).toBeNull();
    const svg = screen.getByRole("group", {
      name: "Service area map",
    });
    const canvas = svg.parentElement!;
    const projection = createProjection(
      buildCoverageView(buildCoverageAgencies(networks, "active", countries)).bounds,
      1200,
      800,
      18,
    );
    const panTo = async (lon: number, lat: number) => {
      const transform = svg.querySelector("g[transform]")!.getAttribute("transform")!;
      const values = transform.match(/-?[\d.]+/g)!.map(Number);
      const point = projection.project(lon, lat);
      const dx = 600 - (point.x * values[2] + values[0]);
      const dy = 400 - (point.y * values[2] + values[1]);
      fireEvent.pointerDown(canvas, {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 600,
        clientY: 400,
      });
      fireEvent.pointerMove(canvas, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 600 + dx,
        clientY: 400 + dy,
      });
      await new Promise((resolve) => requestAnimationFrame(resolve));
      fireEvent.pointerUp(canvas, {
        pointerId: 1,
        pointerType: "mouse",
        clientX: 600 + dx,
        clientY: 400 + dy,
      });
      flush();
    };
    await panTo(-74.05, 40.75);
    expect(header.getByText("United States")).toBeTruthy();
    expect(header.getByText("National").previousElementSibling?.textContent).toBe("2");
    expect(header.getByText("International").previousElementSibling?.textContent).toBe("1");
    expect(header.getByText("National")).toBeTruthy();
    expect(header.queryByText("Regional")).toBeNull();
    expect(header.getByText("International")).toBeTruthy();
    expect(screen.getByRole("button", { name: "National Network" })).toBeTruthy();
    await panTo(-99, 19);
    expect(header.getByText("-")).toBeTruthy();
    expect(header.queryByText("National")).toBeNull();
    expect(header.queryByText("International")).toBeNull();
    await panTo(-79.4, 43.7);
    expect(header.getByText("Regional")).toBeTruthy();
  });

  it("waits for the exit animation before closing, even after repeated requests", async () => {
    let finishExit!: () => void;
    const exitFinished = new Promise<void>((resolve) => {
      finishExit = resolve;
    });
    const cancel = vi.fn();
    const animate = vi
      .fn()
      .mockReturnValueOnce({ finished: Promise.resolve(), cancel })
      .mockReturnValueOnce({ finished: exitFinished, cancel });
    Object.defineProperty(HTMLDialogElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const onClose = vi.fn();
    const { unmount } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={onClose}
        prefersReducedMotion={() => false}
      />
    ));
    expect(animate).toHaveBeenCalledTimes(1);
    const close = screen.getByRole("button", { name: "Close coverage map" });
    fireEvent.click(close);
    fireEvent.click(close);
    expect(animate).toHaveBeenCalledTimes(2);
    expect(onClose).not.toHaveBeenCalled();
    finishExit();
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    unmount();
  });

  it("opens and closes immediately when reduced motion is enabled", () => {
    const animate = vi.fn();
    Object.defineProperty(HTMLDialogElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    const onClose = vi.fn();
    const { unmount } = render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={onClose}
        prefersReducedMotion={() => true}
      />
    ));
    fireEvent.click(screen.getByRole("button", { name: "Close coverage map" }));
    expect(onClose).toHaveBeenCalledOnce();
    expect(animate).not.toHaveBeenCalled();
    unmount();
  });

  it("closes when the native dialog is cancelled", () => {
    const onClose = vi.fn();
    render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={onClose}
        prefersReducedMotion={() => true}
      />
    ));

    fireEvent(screen.getByRole("dialog"), new Event("cancel", { cancelable: true }));

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("attributes the generated geography sources in the footer", () => {
    render(() => (
      <NetworkCoverage
        countries={countries}
        providers={providers}
        currentAgencyId="active"
        onClose={() => {}}
      />
    ));
    const sources = [...screen.getByRole("dialog").querySelectorAll("a")].filter((link) =>
      COVERAGE_SOURCES.some((source) => source.url === link.getAttribute("href")),
    );
    const labels = sources.map((link) => link.textContent);
    expect(labels).toEqual(COVERAGE_SOURCES.map((source) => source.label));
    expect(sources.every((link) => link.getAttribute("rel")?.includes("noreferrer"))).toBe(true);
  });
});
