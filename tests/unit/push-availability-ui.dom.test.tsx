// @vitest-environment happy-dom
import { describe, expect, it, afterEach, beforeEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@solidjs/testing-library";
import { QueryClient, QueryClientProvider } from "@tanstack/solid-query";
import { UserPreferencesProvider } from "~/context/UserPreferencesContext";
import { PreferencesTab } from "~/components/settings/PreferencesTab";
import { I18nProvider } from "~/i18n/I18nContext";
import { createMemoryPreferencesStorage } from "~/infrastructure/storage/PreferencesStorage";
import { DEFAULT_PREFERENCES } from "~/domain/preferences/UserPreferences";
import { SettingsPopover } from "~/components/settings/SettingsPopover";
import { AgencySessionProvider } from "~/context/AgencySessionContext";
import { createMockAgencySession } from "../helpers/mockAgencySession";
import { CommuteScheduleTab } from "~/components/settings/CommuteScheduleTab";

const { triggerTestPushMock } = vi.hoisted(() => ({
  triggerTestPushMock: vi.fn(),
}));

vi.mock("~/services/notifications/NotificationClient", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("~/services/notifications/NotificationClient")>();
  return {
    ...actual,
    triggerTestPush: triggerTestPushMock,
  };
});

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  triggerTestPushMock.mockReset();
});

function createTestQueryClient() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  // FavouritesTab stays mounted while its tab is hidden; settings tests only
  // exercise push/preferences UI, so seed the unrelated catalog query instead
  // of leaving a browser request alive for happy-dom's window teardown.
  queryClient.setQueryData(["routes-catalog", "ttc"], []);
  return queryClient;
}

function mockBrowserPushSupported() {
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
}

function mockBrowserPushUnsupported() {
  delete (window.navigator as unknown as Record<string, unknown>).serviceWorker;
  delete (window as unknown as Record<string, unknown>).PushManager;
  delete (window as unknown as Record<string, unknown>).Notification;
}

const unavailabilityCauses = [
  {
    cause: "the browser does not support Web Push",
    browserSupported: false,
    vapid: { configured: true, publicKey: "BMOCK_PUBLIC_KEY" },
  },
  {
    cause: "server VAPID keys are unconfigured",
    browserSupported: true,
    vapid: { configured: false, publicKey: null, error: "VAPID keys not configured on server" },
  },
] as const;

describe("Push Availability Conditional UI Rendering", () => {
  it.each(unavailabilityCauses)(
    "hides the Commute Push Notifications card and Web Push callout in PreferencesTab when $cause",
    ({ browserSupported, vapid }) => {
      if (browserSupported) {
        mockBrowserPushSupported();
      } else {
        mockBrowserPushUnsupported();
      }
      const qc = createTestQueryClient();
      qc.setQueryData(["vapid-public-key"], vapid);

      render(() => (
        <QueryClientProvider client={qc}>
          <UserPreferencesProvider>
            <PreferencesTab />
          </UserPreferencesProvider>
        </QueryClientProvider>
      ));

      expect(screen.getByText("Reduce Motion")).toBeDefined();
      expect(screen.getByText("Reduced Speed Zones")).toBeDefined();
      expect(screen.queryByText("Commute Push Notifications")).toBeNull();
      expect(screen.queryByText(/System Web Push:/)).toBeNull();
    },
  );

  it.each(unavailabilityCauses)(
    "hides the Commute tab button and panel in SettingsPopover when $cause",
    ({ browserSupported, vapid }) => {
      if (browserSupported) {
        mockBrowserPushSupported();
      } else {
        mockBrowserPushUnsupported();
      }
      const qc = createTestQueryClient();
      qc.setQueryData(["vapid-public-key"], vapid);

      render(() => (
        <QueryClientProvider client={qc}>
          <UserPreferencesProvider>
            <AgencySessionProvider session={createMockAgencySession({ agencyId: "ttc" })}>
              <SettingsPopover isOpen={true} onClose={() => {}} />
            </AgencySessionProvider>
          </UserPreferencesProvider>
        </QueryClientProvider>
      ));

      expect(screen.getByRole("tab", { name: /Preferences/i })).toBeDefined();
      expect(screen.getByRole("tab", { name: /Favourites/i })).toBeDefined();
      expect(screen.queryByRole("tab", { name: /Commute/i })).toBeNull();
      expect(screen.queryByRole("tabpanel", { name: "Commute schedule" })).toBeNull();
    },
  );

  it("renders a fallback message when CommuteScheduleTab is mounted without push support", () => {
    mockBrowserPushUnsupported();
    const qc = createTestQueryClient();
    qc.setQueryData(["vapid-public-key"], {
      configured: true,
      publicKey: "BMOCK_PUBLIC_KEY",
    });

    render(() => (
      <QueryClientProvider client={qc}>
        <UserPreferencesProvider>
          <CommuteScheduleTab />
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    expect(
      screen.getByText(
        /Push notifications are not supported by this browser or server VAPID keys are unconfigured/i,
      ),
    ).toBeDefined();
  });

  it("renders the Commute Push Notifications card and Web Push callout when push is fully available", () => {
    mockBrowserPushSupported();
    const qc = createTestQueryClient();
    qc.setQueryData(["vapid-public-key"], {
      configured: true,
      publicKey: "BMOCK_PUBLIC_KEY",
    });

    render(() => (
      <QueryClientProvider client={qc}>
        <UserPreferencesProvider>
          <PreferencesTab />
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    expect(screen.getByText("Reduce Motion")).toBeDefined();
    expect(screen.getByText("Reduced Speed Zones")).toBeDefined();
    expect(screen.getByText("Commute Push Notifications")).toBeDefined();
    expect(screen.getByText(/System Web Push:/)).toBeDefined();
    expect(screen.getByRole("switch", { name: "Push notifications toggle" })).toBeDefined();
  });

  it("selects the interchange agency badge visibility preference", async () => {
    mockBrowserPushUnsupported();
    const qc = createTestQueryClient();
    qc.setQueryData(["vapid-public-key"], {
      configured: false,
      publicKey: null,
    });

    render(() => (
      <QueryClientProvider client={qc}>
        <UserPreferencesProvider>
          <PreferencesTab />
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    expect(screen.getByText("Interchange Agency Badges")).toBeDefined();
    const compact = screen.getByRole("radio", { name: "Compact" });
    const hidden = screen.getByRole("radio", { name: "Hidden" });
    const full = screen.getByRole("radio", { name: "Full" });
    expect((full as HTMLInputElement).checked).toBe(true);
    expect((compact as HTMLInputElement).checked).toBe(false);
    expect((hidden as HTMLInputElement).checked).toBe(false);

    await fireEvent.click(compact);

    expect((screen.getByRole("radio", { name: "Full" }) as HTMLInputElement).checked).toBe(false);
    expect((screen.getByRole("radio", { name: "Compact" }) as HTMLInputElement).checked).toBe(true);
  });

  it("renders the Commute tab and switches to it when push is fully available", async () => {
    mockBrowserPushSupported();
    const qc = createTestQueryClient();
    qc.setQueryData(["vapid-public-key"], {
      configured: true,
      publicKey: "BMOCK_PUBLIC_KEY",
    });

    render(() => (
      <QueryClientProvider client={qc}>
        <UserPreferencesProvider>
          <AgencySessionProvider session={createMockAgencySession({ agencyId: "ttc" })}>
            <SettingsPopover isOpen={true} onClose={() => {}} />
          </AgencySessionProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));

    const commuteTabBtn = screen.getByRole("tab", { name: /Commute/i });
    await fireEvent.click(commuteTabBtn);

    expect(screen.getByRole("tabpanel", { name: "Commute schedule" })).toBeDefined();
    expect(screen.getByText("Add Custom Commute Window")).toBeDefined();
  });
});

describe("PreferencesTab dev test-push trigger UI", () => {
  beforeEach(() => {
    mockBrowserPushSupported();
  });

  function renderPreferencesTab() {
    const qc = createTestQueryClient();
    qc.setQueryData(["vapid-public-key"], {
      configured: true,
      publicKey: "BMOCK_PUBLIC_KEY",
    });

    return render(() => (
      <QueryClientProvider client={qc}>
        <UserPreferencesProvider>
          <PreferencesTab />
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));
  }

  function renderPreferencesTabWithI18n() {
    const qc = createTestQueryClient();
    qc.setQueryData(["vapid-public-key"], {
      configured: true,
      publicKey: "BMOCK_PUBLIC_KEY",
    });

    return render(() => (
      <QueryClientProvider client={qc}>
        <UserPreferencesProvider storage={createMemoryPreferencesStorage(DEFAULT_PREFERENCES)}>
          <I18nProvider>
            <PreferencesTab />
          </I18nProvider>
        </UserPreferencesProvider>
      </QueryClientProvider>
    ));
  }

  it("hides the dev test-push section when import.meta.env.DEV is false", () => {
    vi.stubEnv("DEV", false);
    renderPreferencesTab();

    expect(screen.getByText("Commute Push Notifications")).toBeDefined();
    expect(screen.queryByText("Dev test push")).toBeNull();
    expect(screen.queryByRole("button", { name: /Send test notification/i })).toBeNull();
  });

  it("shows the dev test-push section in development", () => {
    renderPreferencesTab();

    expect(screen.getByText("Commute Push Notifications")).toBeDefined();
    expect(screen.getByText("Dev test push")).toBeDefined();
    expect(screen.getByRole("button", { name: /Send test notification/i })).toBeDefined();
  });

  it("invokes the server fn with custom title and body and shows sent feedback", async () => {
    triggerTestPushMock.mockResolvedValue({
      ok: true,
      total: 1,
      sent: 1,
      failed: 0,
      expiredSubscriptionsPruned: 0,
    });

    renderPreferencesTab();

    const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
    const bodyInput = screen.getByLabelText("Body") as HTMLInputElement;
    await fireEvent.input(titleInput, { target: { value: "hello pipeline" } });
    await fireEvent.input(bodyInput, { target: { value: "custom body text" } });
    await fireEvent.click(screen.getByRole("button", { name: /Send test notification/i }));

    await waitFor(() => {
      expect(screen.getByText(/Sent to 1 device/)).toBeDefined();
    });

    expect(triggerTestPushMock).toHaveBeenCalledTimes(1);
    expect(triggerTestPushMock).toHaveBeenCalledWith({
      title: "hello pipeline",
      body: "custom body text",
    });
  });

  it("preserves the sent-count and stale-subscription feedback wording", async () => {
    triggerTestPushMock.mockResolvedValue({
      ok: true,
      total: 2,
      sent: 2,
      failed: 0,
      expiredSubscriptionsPruned: 1,
    });

    renderPreferencesTab();
    await fireEvent.click(screen.getByRole("button", { name: /Send test notification/i }));

    await waitFor(() => {
      expect(
        screen.getByText("✅ Sent to 2 device(s) (1 stale subscription removed)."),
      ).toBeDefined();
    });
  });

  it("retranslates visible test-push feedback after switching the app language", async () => {
    triggerTestPushMock.mockResolvedValue({
      ok: true,
      total: 2,
      sent: 2,
      failed: 0,
      expiredSubscriptionsPruned: 1,
    });

    renderPreferencesTabWithI18n();
    const language = await screen.findByRole("combobox", { name: "Language" });
    const titleInput = screen.getByLabelText("Title") as HTMLInputElement;
    await fireEvent.input(titleInput, { target: { value: "retain this draft" } });
    await fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));

    await screen.findByText("✅ Sent to 2 device(s) (1 stale subscription removed).");
    await fireEvent.change(language, { target: { value: "fr-CA" } });

    expect(
      await screen.findByText(
        "✅ Envoyé à 2 appareil(s) (1 abonnement périmé supprimé).",
      ),
    ).toBeDefined();
    expect(screen.queryByText("✅ Sent to 2 device(s) (1 stale subscription removed).")).toBeNull();
    expect((screen.getByLabelText("Titre") as HTMLInputElement).value).toBe("retain this draft");
  });

  it("preserves the server rejection reason in test-push feedback", async () => {
    triggerTestPushMock.mockRejectedValue(new Error("RPC exploded"));

    renderPreferencesTab();

    await fireEvent.click(screen.getByRole("button", { name: /Send test notification/i }));

    await waitFor(() => {
      expect(screen.getByText("RPC exploded")).toBeDefined();
    });
  });

  it("retranslates known test-push errors after switching the app language", async () => {
    triggerTestPushMock.mockRejectedValue(new Error("Test notification failed."));

    renderPreferencesTabWithI18n();
    const language = await screen.findByRole("combobox", { name: "Language" });
    await fireEvent.click(screen.getByRole("button", { name: "Send test notification" }));
    await screen.findByText("Test notification failed.");
    await fireEvent.change(language, { target: { value: "fr-CA" } });

    expect(await screen.findByText("L’envoi de la notification de test a échoué.")).toBeDefined();
    expect(screen.queryByText("Test notification failed.")).toBeNull();
  });
});
