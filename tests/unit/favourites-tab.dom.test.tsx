vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { createSignal, Show } from "solid-js";
import { FavouritesTab } from "~/components/settings/FavouritesTab";
import { UserPreferencesProvider, useUserPreferences } from "~/context/UserPreferencesContext";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import { createMockAgencySession } from "../helpers/mockAgencySession";

/**
 * The catalog RPC is mocked so rejection semantics are observable in
 * unit tests without network access.
 */
const fetchAllRoutesCatalog = vi.hoisted(() => vi.fn());
const fetchRoutesMetadata = vi.hoisted(() => vi.fn());
vi.mock("~/services/surface/SurfaceClient", () => ({
  fetchAllRoutesCatalogViaHttp: fetchAllRoutesCatalog,
  fetchRoutesMetadata,
}));

beforeEach(() => {
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
  fetchAllRoutesCatalog.mockReset();
  fetchAllRoutesCatalog.mockResolvedValue([]);
  fetchRoutesMetadata.mockReset();
  fetchRoutesMetadata.mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  if (typeof window !== "undefined" && window.localStorage) {
    window.localStorage.clear();
  }
});

function createTestQueryClient() {
  return new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
}

function renderWithProviders(ui: () => any, client = createTestQueryClient(), agencyId = "sample") {
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      window.localStorage.clear();
    } catch {}
  }
  const session = createMockAgencySession({ agencyId });
  return render(() => (
    <QueryClientProvider client={client}>
      <UserPreferencesProvider>
        <AgencySessionProvider session={session}>{ui()}</AgencySessionProvider>
      </UserPreferencesProvider>
    </QueryClientProvider>
  ));
}

describe("FavouritesTab Management Component", () => {
  it("renders empty states when no stations or routes are favourited", () => {
    renderWithProviders(() => <FavouritesTab />);

    expect(screen.getByText("Lines & Stations")).toBeDefined();
    expect(screen.getByText("Lines")).toBeDefined();
    expect(screen.getByText("Stations")).toBeDefined();
    expect(screen.getByText("Surface Routes")).toBeDefined();
    expect(
      screen.getByText("No favourite stations yet — star one from its station popover on the map."),
    ).toBeDefined();
    expect(screen.getByText("Popular Routes")).toBeDefined();
  });

  it("renders favourite subway lines with toggleable selection", async () => {
    renderWithProviders(() => <FavouritesTab />);

    const line1Button = screen.getByRole("button", { name: /Line 1/ });
    expect(line1Button.getAttribute("aria-pressed")).toBe("false");
    await fireEvent.click(line1Button);
    expect(line1Button.getAttribute("aria-pressed")).toBe("true");
  });

  it("renders favourite stations list and removes station on click", async () => {
    function TestWrapper() {
      const { toggleFavouriteStation } = useUserPreferences();

      return (
        <div>
          <button
            type="button"
            data-testid="add-station"
            onClick={() => toggleFavouriteStation("sample", "Hub")}
          >
            Add
          </button>
          <FavouritesTab />
        </div>
      );
    }

    renderWithProviders(() => <TestWrapper />);

    // Add station
    const addBtn = screen.getByTestId("add-station");
    await fireEvent.click(addBtn);

    // Verify station is rendered
    expect(screen.getByText("Hub")).toBeDefined();

    // Find and click remove button
    const removeBtn = screen.getByLabelText("Remove Hub from favourites");
    expect(removeBtn).toBeDefined();

    await fireEvent.click(removeBtn);

    // Verify empty state returns
    expect(
      screen.getByText("No favourite stations yet — star one from its station popover on the map."),
    ).toBeDefined();
  });

  it("retains popular surface route pills during initial onboarding session", async () => {
    renderWithProviders(() => <FavouritesTab />);

    // Allow hydration load to settle
    await new Promise((r) => setTimeout(r, 20));

    // Popular Routes is visible on initial empty session
    expect(screen.getByText("Popular Routes")).toBeDefined();

    // Click 10 from popular routes
    const kingChip = screen.getByRole("button", { name: "10" });
    await fireEvent.click(kingChip);

    expect(screen.getByRole("button", { name: /Remove .*10.* from favourites/i })).toBeDefined();
    expect(screen.getByText("Popular Routes")).toBeDefined();
    expect(kingChip.getAttribute("aria-pressed")).toBe("true");

    const queenChip = screen.getByRole("button", { name: "20" });
    await fireEvent.click(queenChip);
    expect(screen.getByRole("button", { name: /Remove .*20.* from favourites/i })).toBeDefined();
    expect(queenChip.getAttribute("aria-pressed")).toBe("true");
  });

  it("completes full lifecycle: onboarding selection, session close, and reopening with saved favourites", async () => {
    function LifecycleTest() {
      const [isOpen, setIsOpen] = createSignal(true);
      return (
        <div>
          <button type="button" data-testid="close-btn" onClick={() => setIsOpen(false)}>
            Close
          </button>
          <button type="button" data-testid="open-btn" onClick={() => setIsOpen(true)}>
            Open
          </button>
          <Show when={isOpen()}>
            <FavouritesTab />
          </Show>
        </div>
      );
    }

    renderWithProviders(() => <LifecycleTest />);

    // Allow hydration load to settle
    await new Promise((r) => setTimeout(r, 20));

    // Seed a favourite via onboarding selection — the retained-pills test
    // already proves session-1 behavior, so this test starts at the
    // close/reopen transition.
    const kingChip = screen.getByRole("button", { name: "10" });
    await fireEvent.click(kingChip);

    // Close settings session
    await fireEvent.click(screen.getByTestId("close-btn"));
    expect(screen.queryByText("Popular Routes")).toBeNull();

    // Reopen settings session with existing favourites
    await fireEvent.click(screen.getByTestId("open-btn"));

    // Active favourites list retains 10
    expect(screen.getByLabelText(/Remove .*10.* from favourites/i)).toBeDefined();
    // Popular routes section is now cleanly hidden in session 2
    expect(screen.queryByText("Popular Routes")).toBeNull();
  });

  it("requests saved route metadata in batches the server accepts", async () => {
    const saved = Array.from({ length: 150 }, (_, index) => `saved-${index}`);
    function SavedRoutes() {
      const { toggleFavouriteSurfaceRoute } = useUserPreferences();
      const [ready, setReady] = createSignal(false);
      return (
        <div>
          <button
            type="button"
            data-testid="seed-btn"
            onClick={() => {
              for (const routeId of saved) toggleFavouriteSurfaceRoute("sample", routeId);
              setReady(true);
            }}
          >
            Seed
          </button>
          <Show when={ready()}>
            <FavouritesTab />
          </Show>
        </div>
      );
    }

    renderWithProviders(() => <SavedRoutes />);
    await fireEvent.click(screen.getByTestId("seed-btn"));

    await waitFor(() => {
      const batches = fetchRoutesMetadata.mock.calls.map(
        ([input]) => (input as { routeIds: readonly string[] }).routeIds,
      );
      expect(batches.flat()).toEqual(expect.arrayContaining(saved));
      expect(Math.max(...batches.map((batch) => batch.length))).toBeLessThanOrEqual(100);
    });
  });

  it("filters routes by number or corridor name and allows direct favouriting from search results", async () => {
    const testQueryClient = createTestQueryClient();
    testQueryClient.setQueryData(
      ["routes-catalog", "sample"],
      [
        { id: "10", shortName: "10", longName: "King", routeType: "streetcar" },
        { id: "20", shortName: "20", longName: "Queen", routeType: "streetcar" },
        { id: "32", shortName: "32", longName: "Eglinton West", routeType: "bus" },
        { id: "29", shortName: "29", longName: "Dufferin", routeType: "bus" },
        { id: "900", shortName: "900", longName: "Airport Express", routeType: "express" },
      ],
    );

    renderWithProviders(() => <FavouritesTab />, testQueryClient);

    // Allow hydration load to settle
    await new Promise((r) => setTimeout(r, 20));

    const searchInput = screen.getByPlaceholderText(
      "Search routes by number or name...",
    ) as HTMLInputElement;
    expect(searchInput).toBeDefined();

    // Type "Eglinton"
    await fireEvent.input(searchInput, { target: { value: "Eglinton" } });

    // Matching section appears with route 32
    expect(screen.getByText("Matching Routes (1)")).toBeDefined();
    expect(screen.getByText("32 Eglinton West")).toBeDefined();

    // Add route 32 to favourites from search results
    const addBtn = screen.getByRole("button", { name: "Add 32 Eglinton West to favourites" });
    await fireEvent.click(addBtn);

    // Button updates to Saved
    expect(
      screen.getByRole("button", { name: "Remove 32 Eglinton West from favourites" }),
    ).toBeDefined();

    // Clear search
    const clearBtn = screen.getByLabelText("Clear route search");
    await fireEvent.click(clearBtn);

    // Route 32 now appears in the main Favourites List
    expect(screen.getByLabelText(/Remove .*32.* from favourites/i)).toBeDefined();
  });

  it("supports Enter to toggle top search match and Escape to clear search input", async () => {
    const testQueryClient = createTestQueryClient();
    testQueryClient.setQueryData(
      ["routes-catalog", "sample"],
      [
        { id: "29", shortName: "29", longName: "Dufferin", routeType: "bus" },
        { id: "929", shortName: "929", longName: "Dufferin Express", routeType: "express" },
      ],
    );

    renderWithProviders(() => <FavouritesTab />, testQueryClient);

    // Allow hydration load to settle
    await new Promise((r) => setTimeout(r, 20));

    const searchInput = screen.getByPlaceholderText(
      "Search routes by number or name...",
    ) as HTMLInputElement;

    // Type "Dufferin"
    await fireEvent.input(searchInput, { target: { value: "Dufferin" } });
    expect(screen.getByText("Matching Routes (2)")).toBeDefined();

    // Press Enter to select top match (29 Dufferin)
    await fireEvent.keyDown(searchInput, { key: "Enter" });

    // 29 is now favourited
    expect(
      screen.getByRole("button", { name: "Remove 29 Dufferin from favourites" }),
    ).toBeDefined();

    // Press Escape to clear search input
    await fireEvent.keyDown(searchInput, { key: "Escape" });
    expect(searchInput.value).toBe("");
    expect(screen.queryByText("Matching Routes (2)")).toBeNull();
  });

  it("sources Popular Routes from the active agency manifest, not another agency", async () => {
    // The second fixture declares its own popular routes, and must not show an unrelated id
    // like 10.
    renderWithProviders(() => <FavouritesTab />, createTestQueryClient(), "local");

    await new Promise((r) => setTimeout(r, 20));

    expect(screen.getByText("Popular Routes")).toBeDefined();
    expect(screen.queryByText("10")).toBeNull();
  });

  it("renders a genuine error state when the route catalog rejects — never the empty message", async () => {
    fetchAllRoutesCatalog.mockRejectedValue(new Error("catalog down"));

    renderWithProviders(() => <FavouritesTab />);

    const searchInput = screen.getByPlaceholderText(
      "Search routes by number or name...",
    ) as HTMLInputElement;
    await fireEvent.input(searchInput, { target: { value: "Eglinton" } });

    // Shared client retries once (~1s backoff) before the error lands.
    await waitFor(
      () => expect(screen.getByText(/couldn't load the route catalog/i)).toBeDefined(),
      { timeout: 5000 },
    );

    // A rejection must never masquerade as a no-results answer.
    expect(screen.queryByText(/No routes found matching/)).toBeNull();

    // Recovery: catalog comes back → retry repopulates results.
    fetchAllRoutesCatalog.mockResolvedValue([
      { id: "32", shortName: "32", longName: "Eglinton West", routeType: "bus" },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /retry/i }));
    await waitFor(() => expect(screen.getByText("Matching Routes (1)")).toBeDefined(), {
      timeout: 5000,
    });
  });
});
