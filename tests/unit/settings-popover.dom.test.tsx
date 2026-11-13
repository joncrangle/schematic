// @vitest-environment happy-dom
vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return {
    agencyCatalog: testAgencyCatalog.map((entry) =>
      entry.manifest.id === "regional"
        ? {
            ...entry,
            manifest: {
              ...entry.manifest,
              attribution: {
                name: "Regional Open Data",
                url: "https://regional.example.test/data",
                license: "Example Regional Licence",
              },
            },
          }
        : entry,
    ),
  };
});
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { createSignal, flush } from "solid-js";
import { render, screen, cleanup, fireEvent, within } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { I18nProvider } from "~/i18n/I18nContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import { createMockAgencySession } from "../helpers/mockAgencySession";
import { SettingsPopover } from "~/components/settings/SettingsPopover";
import { installMemoryLocalStorage } from "../helpers/local-storage";
import {
  firePointerDown,
  observeBodyRemovals,
  removedNodeOrDescendant,
} from "../helpers/dom-lifecycle-harness";

function enableMockPush(qc: QueryClient) {
  Object.defineProperty(window.navigator, "serviceWorker", {
    value: {
      getRegistration: vi.fn().mockResolvedValue(null),
      register: vi.fn().mockResolvedValue(undefined),
      ready: Promise.resolve({
        active: { postMessage: vi.fn() },
        pushManager: { getSubscription: vi.fn().mockResolvedValue(null) },
      }),
      controller: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    },
    configurable: true,
    writable: true,
  });
  (window as unknown as Record<string, unknown>).PushManager = class {};
  (window as unknown as Record<string, unknown>).Notification = {
    permission: "default",
    requestPermission: vi.fn().mockResolvedValue("granted"),
  };
  qc.setQueryData(["vapid-public-key"], {
    configured: true,
    publicKey: "BMOCK_PUBLIC_KEY",
  });
}

// Preferences hydrate asynchronously from localStorage (UserPreferencesContext
// onMount → Effect.runPromise). Without a per-test storage reset, a rename
// persisted by an earlier test re-enters mid-test through that hydration and
// swaps schedule labels under the running assertions — a race that only fires
// when the event loop interleaves differently (CI). A fresh stub per test
// keeps hydrated data identical to the initial store, so reconcile() can
// never churn mounted cards.
beforeEach(() => {
  installMemoryLocalStorage();
  vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-CA"]);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function createTestQueryClient() {
  const qc = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  enableMockPush(qc);
  // FavouritesTab is mounted even when its panel is hidden. Catalog contents
  // are outside these lifecycle tests, so avoid an unrelated live browser
  // request that would be aborted when happy-dom tears down the window.
  qc.setQueryData(["routes-catalog", "sample"], []);
  return qc;
}

describe("SettingsPopover Component Stability", () => {
  it("localizes built-in commute labels without translating rider-authored labels", async () => {
    const testQueryClient = createTestQueryClient();
    const storage = createMemoryPreferencesStorage({
      ...DEFAULT_PREFERENCES,
      locale: "fr-CA",
      commuteSchedules: [
        ...DEFAULT_PREFERENCES.commuteSchedules,
        {
          id: "custom_schedule",
          label: "Mon horaire personnalisé",
          enabled: true,
          days: [1, 2, 3, 4, 5],
          start: "12:00",
          end: "14:00",
        },
      ],
    });

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider storage={storage}>
          <I18nProvider>
            <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
              <SettingsPopover isOpen={true} onClose={() => {}} />
            </AgencySessionProvider>
          </I18nProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    const commuteTab = await screen.findByRole("tab", { name: /Trajets réguliers/ });
    await fireEvent.click(commuteTab);
    expect(await screen.findByText("Trajet du matin")).toBeDefined();
    expect(screen.getByText("Trajet du soir")).toBeDefined();
    expect(screen.getByText("Mon horaire personnalisé")).toBeDefined();
    expect(screen.queryByText("Morning Commute")).toBeNull();
    const timeSummary = `${new Intl.DateTimeFormat("fr-CA", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(2024, 0, 1, 7, 30))} – ${new Intl.DateTimeFormat("fr-CA", {
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(2024, 0, 1, 9, 30))}`;
    expect(screen.getByText(timeSummary)).toBeDefined();
    expect((await storage.load()).commuteSchedules[0]?.start).toBe("07:30");
  });

  it("renders when isOpen is true and hides when isOpen is false", () => {
    const testQueryClient = createTestQueryClient();

    const { unmount } = render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover isOpen={true} onClose={() => {}} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    expect(screen.getByRole("dialog", { name: "Settings and Preferences" })).toBeDefined();
    expect(screen.getByText("Preferences")).toBeDefined();
    expect(screen.getByText("Favourites")).toBeDefined();
    expect(screen.getByText("Commute")).toBeDefined();

    unmount();

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover isOpen={false} onClose={() => {}} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    expect(screen.queryByRole("dialog", { name: "Settings and Preferences" })).toBeNull();
  });

  it("maintains all tab container DOM nodes and toggles visibility on tab switch", async () => {
    const testQueryClient = createTestQueryClient();

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover isOpen={true} onClose={() => {}} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    // Initially Preferences tab is active
    expect(screen.getByText("Reduce Motion")).toBeDefined();

    // Click Favourites tab
    const favTabBtn = screen.getByRole("tab", { name: /Favourites/i });
    await fireEvent.click(favTabBtn);

    // Favourites tab content is now visible without remounting parent
    expect(screen.getByText("Lines & Stations")).toBeDefined();

    // Click Commute tab
    const commuteTabBtn = screen.getByRole("tab", { name: /Commute/i });
    await fireEvent.click(commuteTabBtn);

    // Commute tab content is visible
    expect(screen.getByText("Add Custom Commute Window")).toBeDefined();
    const time = (hour: number) =>
      new Intl.DateTimeFormat("en-CA", { hour: "2-digit", minute: "2-digit" }).format(
        new Date(2024, 0, 1, hour, 30),
      );
    expect(screen.getByText(`${time(7)} – ${time(9)}`)).toBeDefined();

    // All three tabs remain in DOM simultaneously (no unmount flash)
    expect(screen.getByText("Reduce Motion")).toBeDefined();
    expect(screen.getByText("Lines & Stations")).toBeDefined();
    expect(screen.getByText("Add Custom Commute Window")).toBeDefined();
  });

  it("invokes onClose when Escape key is pressed", () => {
    const testQueryClient = createTestQueryClient();
    let closed = false;

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover
              isOpen={true}
              onClose={() => {
                closed = true;
              }}
            />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closed).toBe(true);
  });

  it("supports inline editing of commute schedule names with Enter or Save button", async () => {
    const testQueryClient = createTestQueryClient();

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover isOpen={true} onClose={() => {}} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    // Switch to Commute tab
    const commuteTabBtn = screen.getByRole("tab", { name: /Commute/i });
    await fireEvent.click(commuteTabBtn);

    // Initial label is present
    expect(screen.getByText("Morning Commute")).toBeDefined();

    // Click edit button for Morning Commute
    const editBtn = screen.getByRole("button", { name: "Edit Morning Commute name" });
    await fireEvent.click(editBtn);

    // Input is displayed
    const input = screen.getByRole("textbox", {
      name: "Edit name for Morning Commute",
    }) as HTMLInputElement;
    expect(input.value).toBe("Morning Commute");

    // Change value and press Enter
    await fireEvent.input(input, { target: { value: "Gym Commute" } });
    await fireEvent.keyDown(input, { key: "Enter" });

    // Header updates to the new name
    expect(screen.getByText("Gym Commute")).toBeDefined();
    expect(screen.queryByText("Morning Commute")).toBeNull();
  });

  it("cancels inline editing when Escape key is pressed or Cancel button is clicked without closing popover", async () => {
    const testQueryClient = createTestQueryClient();
    let popoverClosed = false;

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover
              isOpen={true}
              onClose={() => {
                popoverClosed = true;
              }}
            />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    const commuteTabBtn = screen.getByRole("tab", { name: /Commute/i });
    await fireEvent.click(commuteTabBtn);

    const editBtn = screen.getByRole("button", { name: "Edit Evening Commute name" });
    await fireEvent.click(editBtn);

    const input = screen.getByRole("textbox", {
      name: "Edit name for Evening Commute",
    }) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "Temporary Name" } });

    // Press Escape on input
    await fireEvent.keyDown(input, { key: "Escape" });

    // Remains Evening Commute and popover remains open
    expect(screen.getByText("Evening Commute")).toBeDefined();
    expect(screen.queryByText("Temporary Name")).toBeNull();
    expect(popoverClosed).toBe(false);
  });

  it("gracefully reverts to previous name if empty or whitespace-only name is entered", async () => {
    const testQueryClient = createTestQueryClient();

    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover isOpen={true} onClose={() => {}} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    const commuteTabBtn = screen.getByRole("tab", { name: /Commute/i });
    await fireEvent.click(commuteTabBtn);

    const editBtn = screen.getByRole("button", { name: "Edit Morning Commute name" });
    await fireEvent.click(editBtn);

    const input = screen.getByRole("textbox", {
      name: "Edit name for Morning Commute",
    }) as HTMLInputElement;
    await fireEvent.input(input, { target: { value: "   " } });

    // Click save button
    const saveBtn = screen.getByRole("button", { name: "Save schedule name" });
    await fireEvent.click(saveBtn);

    // Reverted to Morning Commute
    expect(screen.getByText("Morning Commute")).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Regression guards for the settings-open page flash: the old full-viewport
// backdrop (`fixed inset-0 ... bg-black/40`) forced a whole-page composite on
// first open. These pin its removal and the outside-pointerdown replacement.
// ---------------------------------------------------------------------------

describe("SettingsPopover Open Lifecycle (no-backdrop regression guards)", () => {
  /**
   * Mirrors the app structure from src/routes/index.tsx: the trigger button is
   * a sibling of <SettingsPopover> (not part of it), so "outside" can be
   * defined as anything that is neither the dialog panel nor the trigger.
   * The trigger element is handed to the popover via the same callback-ref +
   * accessor prop the route uses — the component never resolves its trigger
   * by aria-label string lookup.
   */
  function renderSettingsHarness() {
    const testQueryClient = createTestQueryClient();

    const Harness = () => {
      const [isOpen, setIsOpen] = createSignal(false);
      let settingsTriggerEl: HTMLButtonElement | undefined;
      return (
        <QueryClientProvider client={testQueryClient}>
          <UserPreferencesProvider>
            <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
              <header data-testid="app-header">
                <span>Schematic</span>
              </header>
              <main data-testid="app-main">
                <button
                  ref={(el) => {
                    settingsTriggerEl = el;
                  }}
                  type="button"
                  aria-label="Open Settings"
                  onClick={() => setIsOpen((prev) => !prev)}
                >
                  ⚙
                </button>
                <SettingsPopover
                  isOpen={isOpen()}
                  onClose={() => setIsOpen(false)}
                  triggerEl={() => settingsTriggerEl}
                />
              </main>
            </AgencySessionProvider>
          </UserPreferencesProvider>
        </QueryClientProvider>
      );
    };

    const { container } = render(() => <Harness />);
    const trigger = screen.getByRole("button", { name: "Open Settings" });
    return { trigger, container };
  }

  it("mounts no viewport-covering backdrop when opened", async () => {
    const { trigger } = renderSettingsHarness();

    await fireEvent.click(trigger);
    expect(screen.getByRole("dialog", { name: "Settings and Preferences" })).toBeDefined();

    // THE red-flag selector for the reported flash: any element whose classes
    // include both `fixed` and `inset-0` spans the whole viewport and forces a
    // full-page composite. Opening must mount no such element.
    const insetCandidates = Array.from(
      document.body.querySelectorAll<HTMLElement>('[class*="inset-0"]'),
    );
    const viewportCovering = insetCandidates.filter((el) => el.classList.contains("fixed"));
    expect(viewportCovering.map((el) => el.className)).toEqual([]);
  });

  it("closes on outside pointerdown while pointerdowns inside the panel or on the trigger keep it open", async () => {
    const { trigger, container } = renderSettingsHarness();
    const dialog = () => screen.queryByRole("dialog", { name: "Settings and Preferences" });

    await fireEvent.click(trigger);
    expect(dialog()).not.toBeNull();

    // Outside: an element that is neither the dialog panel nor the trigger.
    const outsideArea = document.createElement("div");
    outsideArea.setAttribute("data-testid", "outside-area");
    container.appendChild(outsideArea);
    firePointerDown(outsideArea);
    // The close write is staged: drain before asserting the dialog unmounted.
    flush();
    expect(dialog()).toBeNull();

    // Reopen for the stay-open contracts.
    await fireEvent.click(trigger);
    flush();
    expect(dialog()).not.toBeNull();

    // Inside the panel: must not close.
    firePointerDown(screen.getByRole("dialog", { name: "Settings and Preferences" }));
    expect(dialog()).not.toBeNull();

    // On the trigger: the document-level listener must ignore it so the
    // button's own onClick performs exactly one toggle (no close-then-reopen).
    firePointerDown(trigger);
    expect(dialog()).not.toBeNull();
    await fireEvent.click(trigger);
    expect(dialog()).toBeNull();
  });

  it("only adds the settings subtree on open and never removes pre-existing UI", async () => {
    const { trigger } = renderSettingsHarness();
    const header = screen.getByTestId("app-header");
    const main = screen.getByTestId("app-main");

    const removals = observeBodyRemovals();

    try {
      await fireEvent.click(trigger);

      const removedList = removals.takeRemoved();

      // Opening must only ADD the settings subtree — never remove or redraw
      // any UI that existed before the click.
      expect(removedNodeOrDescendant(removedList, header)).toBe(false);
      expect(removedNodeOrDescendant(removedList, main)).toBe(false);

      // Sanity: the open actually mounted the dialog subtree.
      expect(screen.getByRole("dialog", { name: "Settings and Preferences" })).toBeDefined();
    } finally {
      removals.disconnect();
    }
  });
});

describe("Preferences attribution follows the displayed agency", () => {
  function renderPreferencesWithAgency(agencyId?: string) {
    const testQueryClient = createTestQueryClient();
    render(() => (
      <QueryClientProvider client={testQueryClient}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "sample" })}>
            <SettingsPopover isOpen={true} onClose={() => {}} agencyId={agencyId} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));
  }

  it("shows the passed agency attribution instead of the static active provider", () => {
    renderPreferencesWithAgency("regional");

    const dialog = screen.getByRole("dialog", { name: "Settings and Preferences" });
    const link = within(dialog).getByRole("link", { name: "Example Regional Licence" });
    expect(link.getAttribute("href")).toBe("https://regional.example.test/data");
    expect(within(dialog).queryByRole("link", { name: "CC0" })).toBeNull();
  });

  it("falls back to the active provider when no agency is passed", () => {
    renderPreferencesWithAgency(undefined);

    const dialog = screen.getByRole("dialog", { name: "Settings and Preferences" });
    expect(within(dialog).getByRole("link", { name: "CC0" }).getAttribute("href")).toBe(
      "https://example.test/data",
    );
  });
});
