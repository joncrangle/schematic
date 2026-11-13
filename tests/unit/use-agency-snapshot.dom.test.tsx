vi.mock("~/agencies/agencyCatalog", async () => {
  const { testAgencyCatalog } = await import("../helpers/agency-fixtures");
  return { agencyCatalog: testAgencyCatalog };
});
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { cleanup, render, waitFor } from "@solidjs/testing-library";

/**
 * Core agency snapshot hook: polling freshness semantics at the shell seam.
 * A rejected poll must force the freshness badge STALE immediately while the
 * last good snapshot keeps aging underneath — never a fresh-looking all-clear.
 * The server-shipped freshness state acts as a ceiling: client-side
 * aging may degrade it over time but never upgrades it. Production fetches go
 * through the stable portable endpoint `GET /api/snapshot/:agencyId`.
 */

import { fetchSnapshotViaHttp, useAgencySnapshot } from "~/hooks/useAgencySnapshot";
import { queryClient } from "~/lib/queryClient";
import { installMemoryLocalStorage } from "../helpers/local-storage";
import type { AgencySnapshot } from "~/agencies/types";
import type { UiLocale } from "~/domain/locale";

const POLL_MS = 25;

const goodSnapshot = (overrides: Partial<AgencySnapshot> = {}): AgencySnapshot => ({
  agencyId: "sample",
  generatedAt: Date.now(),
  freshness: "live",
  alerts: [],
  ...overrides,
});

const jsonResponse = (snapshot: AgencySnapshot) => Response.json(snapshot);

function stubSnapshotFetch(
  impl: (agencyId: string, locale: string) => AgencySnapshot | Promise<AgencySnapshot>,
) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), "http://localhost");
    const agencyId = decodeURIComponent(url.pathname.split("/").pop() ?? "sample");
    return jsonResponse(await impl(agencyId, url.searchParams.get("locale") ?? "en-CA"));
  });
}

function mountSnapshotHook(pollInterval = POLL_MS) {
  let api!: ReturnType<typeof useAgencySnapshot>;
  render(() => {
    api = useAgencySnapshot("sample", pollInterval);
    return null;
  });
  return api;
}

beforeEach(() => {
  installMemoryLocalStorage();
  queryClient.clear();
  vi.stubGlobal(
    "fetch",
    stubSnapshotFetch((id) => goodSnapshot({ agencyId: id })),
  );
});

afterEach(() => {
  cleanup();
  queryClient.cancelQueries();
  queryClient.clear();
  vi.unstubAllGlobals();
});

describe("fetchSnapshotViaHttp stable endpoint", () => {
  it("requests the portable snapshot URL for the agency", async () => {
    const transport = stubSnapshotFetch((agencyId) => goodSnapshot({ agencyId }));
    vi.stubGlobal("fetch", transport);

    const snapshot = await fetchSnapshotViaHttp("sample", transport as unknown as typeof fetch);

    expect(snapshot.agencyId).toBe("sample");
    expect(transport).toHaveBeenCalledOnce();
    expect(String(transport.mock.calls[0]?.[0])).toBe("/api/snapshot/sample?locale=en-CA");
  });

  it("rejects non-2xx responses instead of rendering a fake all-clear", async () => {
    const transport = vi.fn(
      async () => new Response(JSON.stringify({ error: "down" }), { status: 503 }),
    );
    vi.stubGlobal("fetch", transport);

    await expect(
      fetchSnapshotViaHttp("sample", transport as unknown as typeof fetch),
    ).rejects.toThrow(/503/);
  });
});

describe("useAgencySnapshot freshness semantics", () => {
  it("updates elapsed text without invalidating unchanged freshness state", () => {
    vi.useFakeTimers();
    try {
      queryClient.setQueryData(
        ["snapshot", "sample", "en-CA"],
        goodSnapshot({ generatedAt: Date.now() - 5_000 }),
      );
      const readState = vi.fn((state: string) => state);
      const view = render(() => {
        const api = useAgencySnapshot("sample", 60_000, () => false);
        return (
          <button aria-label={readState(api.freshness().state)}>{api.freshness().shortText}</button>
        );
      });
      const button = view.getByRole("button", { name: "live" });
      readState.mockClear();
      vi.advanceTimersByTime(1_000);
      flush();
      expect(button.textContent).toBe("6s ago");
      expect(readState).not.toHaveBeenCalled();

      vi.advanceTimersByTime(54_000);
      flush();
      expect(button.getAttribute("aria-label")).toBe("recent");
      expect(readState).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });
  it("observes a snapshot replacement even when both receipts share one timestamp", async () => {
    const clock = vi.spyOn(Date, "now").mockReturnValue(1_800_000_000_000);
    try {
      const api = mountSnapshotHook(60_000);
      await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
      queryClient.setQueryData(
        ["snapshot", "sample", "en-CA"],
        goodSnapshot({ freshness: "stale" }),
      );
      flush();
      expect(api.snapshot()?.freshness).toBe("stale");
      expect(api.freshness().state).toBe("stale");
    } finally {
      clock.mockRestore();
    }
  });

  it("clears agency evidence and stops requests when Automatic becomes unresolved", async () => {
    const { createSignal } = await import("solid-js");
    const [agency, setAgency] = createSignal<string | undefined>("sample");
    const transport = stubSnapshotFetch((agencyId) => goodSnapshot({ agencyId }));
    vi.stubGlobal("fetch", transport);
    let api!: ReturnType<typeof useAgencySnapshot>;
    render(() => {
      api = useAgencySnapshot(agency, 60_000);
      return null;
    });
    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
    transport.mockClear();
    setAgency(undefined);
    flush();
    expect(api.snapshot()).toBeUndefined();
    expect(api.freshness().state).toBe("unavailable");
    api.refresh();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport).not.toHaveBeenCalled();
  });

  it.each(["fresh visit", "agency switch"])(
    "shows unavailable status during a %s until that agency's response arrives",
    async (transition) => {
      const { createSignal } = await import("solid-js");
      const [agency, setAgency] = createSignal("sample");
      let resolve!: (snapshot: AgencySnapshot) => void;
      vi.stubGlobal(
        "fetch",
        stubSnapshotFetch((id) => {
          if (transition === "agency switch" && id === "sample") return goodSnapshot();
          return new Promise<AgencySnapshot>((done) => {
            resolve = done;
          });
        }),
      );
      let api!: ReturnType<typeof useAgencySnapshot>;
      render(() => {
        api = useAgencySnapshot(agency, 60_000);
        return null;
      });
      if (transition === "agency switch") {
        await waitFor(() => {
          if (api.snapshot()?.agencyId !== "sample") throw new Error("sample snapshot pending");
        });
        setAgency("regional");
        flush();
      }
      expect(api.snapshot()).toBeUndefined();
      expect(api.freshness().state).toBe("unavailable");
      await waitFor(() => expect(resolve).toBeTypeOf("function"));
      resolve(goodSnapshot({ agencyId: agency() }));
      await waitFor(() => expect(api.snapshot()?.agencyId).toBe(agency()));
      expect(api.freshness().state).toBe("live");
    },
  );

  it("does not fetch until the caller enables the agency snapshot", async () => {
    const { createSignal } = await import("solid-js");
    const [enabled, setEnabled] = createSignal(false);
    const transport = stubSnapshotFetch(() => goodSnapshot());
    vi.stubGlobal("fetch", transport);

    let api!: ReturnType<typeof useAgencySnapshot>;
    render(() => {
      api = useAgencySnapshot("sample", POLL_MS, enabled);
      return null;
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(transport).not.toHaveBeenCalled();

    setEnabled(true);
    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
    expect(transport).toHaveBeenCalled();
  });

  it("retries a transient transport failure before surfacing the snapshot error", async () => {
    let attempts = 0;
    const transport = vi.fn(async (input: RequestInfo | URL) => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      expect(String(input)).toBe("/api/snapshot/sample?locale=en-CA");
      return jsonResponse(goodSnapshot());
    });
    vi.stubGlobal("fetch", transport);

    // Keep the retry assertion separate from the short polling cadence used by
    // the freshness tests; otherwise a scheduled third poll can race the
    // assertion after the transport retry has already succeeded.
    const api = mountSnapshotHook(60_000);

    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
    // Transient transport failure retries inside the fetch layer: at least
    // the failed attempt plus the retry reach the transport.
    expect(transport.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(api.error()).toBeNull();
  });

  it("forces freshness STALE immediately on poll rejection while retaining the last snapshot, then recovers to live", async () => {
    const transport = stubSnapshotFetch(() => goodSnapshot());
    vi.stubGlobal("fetch", transport);
    const api = mountSnapshotHook();

    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
    expect(api.freshness().state).toBe("live");

    // Feed outage: the endpoint now rejects every poll.
    transport.mockImplementation(async () => new Response("outage", { status: 503 }));

    // Stale immediately once the failed poll settles — not after the
    // 3-minute natural aging window.
    await waitFor(() => expect(api.freshness().state).toBe("stale"), { timeout: 5000 });
    expect(api.error()).toContain("503");
    // Last good snapshot retained (no fabricated reset).
    expect(api.snapshot()?.agencyId).toBe("sample");

    // Recovery: the port comes back → live again.
    transport.mockImplementation(async () => jsonResponse(goodSnapshot()));
    await waitFor(() => expect(api.freshness().state).toBe("live"), { timeout: 5000 });
    expect(api.error()).toBeNull();
  });

  it("never upgrades a degraded server-shipped freshness state", async () => {
    // Server says stale even though generatedAt is brand-new.
    vi.stubGlobal(
      "fetch",
      stubSnapshotFetch(() => goodSnapshot({ freshness: "stale" })),
    );
    const api = mountSnapshotHook();

    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
    expect(api.freshness().state).toBe("stale");
  });

  it("uses the successful fetch timestamp and preserves compact English age text", async () => {
    const fetchedAt = Date.now() - 120_000;
    vi.stubGlobal(
      "fetch",
      stubSnapshotFetch(() =>
        goodSnapshot({ generatedAt: fetchedAt, sourceUpdatedAt: fetchedAt - 120_000 }),
      ),
    );
    const api = mountSnapshotHook();

    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));
    expect(api.freshness().state).toBe("recent");
    expect(api.freshness().formattedText).toBe("Updated 2 minutes ago");
    expect(api.freshness().shortText).toBe("2m ago");
  });

  it("reactively refetches and switches snapshot data when agency changes", async () => {
    vi.stubGlobal(
      "fetch",
      stubSnapshotFetch((id) => goodSnapshot({ agencyId: id })),
    );

    const { createSignal } = await import("solid-js");
    const [agency, setAgency] = createSignal("sample");
    let api!: ReturnType<typeof useAgencySnapshot>;
    render(() => {
      api = useAgencySnapshot(agency, POLL_MS);
      return null;
    });

    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("sample"));

    setAgency("regional");
    flush();
    // Query placeholderData may still contain TTC while GO is loading, but the
    // hook seam must not expose evidence for the wrong agency.
    expect(api.snapshot()?.agencyId).not.toBe("sample");
    await waitFor(() => expect(api.snapshot()?.agencyId).toBe("regional"));
  });

  it("does not expose the previous language snapshot while the requested locale is pending", async () => {
    const { createSignal } = await import("solid-js");
    const [locale, setLocale] = createSignal<UiLocale>("en-CA");
    const englishSnapshot = goodSnapshot({
      alerts: [
        {
          id: "translated-alert",
          kind: "information",
          severity: "degraded",
          lifecycle: "active",
          scope: "network",
          title: "English alert title",
          description: "English alert body",
          startsAt: 1,
          updatedAt: 1,
        },
      ],
    });
    const frenchSnapshot = goodSnapshot({
      alerts: [
        {
          id: "translated-alert",
          kind: "information",
          severity: "degraded",
          lifecycle: "active",
          scope: "network",
          title: "Titre français",
          description: "Texte français",
          startsAt: 1,
          updatedAt: 1,
        },
      ],
    });
    let resolveFrench!: (snapshot: AgencySnapshot) => void;
    const transport = stubSnapshotFetch((id, requestedLocale) => {
      if (requestedLocale === "fr-CA") {
        return new Promise<AgencySnapshot>((resolve) => {
          resolveFrench = resolve;
        });
      }
      return { ...englishSnapshot, agencyId: id };
    });
    vi.stubGlobal("fetch", transport);

    let api!: ReturnType<typeof useAgencySnapshot>;
    render(() => {
      api = useAgencySnapshot("sample", 60_000, undefined, locale);
      return null;
    });

    await waitFor(() => expect(api.snapshot()?.alerts[0]?.title).toBe("English alert title"));
    setLocale("fr-CA");
    await waitFor(() => {
      expect(transport.mock.calls.some(([input]) => String(input).endsWith("?locale=fr-CA"))).toBe(
        true,
      );
    });

    expect(api.snapshot()?.alerts[0]?.title).not.toBe("English alert title");
    expect(api.freshness().state).toBe("unavailable");
    await waitFor(() => expect(resolveFrench).toBeTypeOf("function"));
    resolveFrench({ ...frenchSnapshot, agencyId: "sample" });
    await waitFor(() => expect(api.snapshot()?.alerts[0]?.title).toBe("Titre français"));
  });
});
