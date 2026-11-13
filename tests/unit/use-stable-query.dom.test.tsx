// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@solidjs/testing-library";
import { createSignal, flush, OBSERVE } from "solid-js";
import { attribution } from "solid-js/attribution";
import { useStableQuery } from "~/hooks/useStableQuery";
import { queryClient } from "~/lib/queryClient";

afterEach(() => {
  cleanup();
  queryClient.clear();
});

it("does not relay or abandon disabled query projections when location changes", async () => {
  const stopAttribution = attribution.enable({ log: false });
  const diagnostics = OBSERVE!.diagnostics.capture();
  const [longitude, setLongitude] = createSignal(1);
  const [enabled, setEnabled] = createSignal(false);
  const fetchItems = vi.fn(async (_longitude: number) => [{ id: "stop" }]);
  render(() => {
    const result = useStableQuery<{ id: string }>(() => {
      const currentLongitude = longitude();
      return {
        queryKey: ["example-saved-stops", currentLongitude],
        queryFn: () => fetchItems(currentLongitude),
        enabled: enabled(),
        getKey: (item) => item.id,
        isEqual: (a, b) => a.id === b.id,
      };
    });
    return (
      <div>
        {longitude()}:{result.query.fetchStatus}:{result.items().length}
      </div>
    );
  });
  try {
    for (let longitude = 2; longitude <= 7; longitude++) {
      setLongitude(longitude);
      flush();
      await Promise.resolve();
    }
    expect(fetchItems).not.toHaveBeenCalled();
    expect(
      diagnostics.events.filter(
        (event) => event.code === "ABANDONED_FLIGHTS" || event.code === "EFFECT_RELAY_TEAR",
      ),
    ).toEqual([]);
    setEnabled(true);
    flush();
    await waitFor(() => expect(fetchItems).toHaveBeenCalledExactlyOnceWith(7));
  } finally {
    diagnostics.stop();
    stopAttribution();
  }
});

it("keeps settled list identity across equivalent inputs and identical refetches", async () => {
  const [revision, setRevision] = createSignal(0);
  const fetchItems = vi.fn(async () => [{ id: "stop", label: "Example stop" }]);
  let result!: ReturnType<typeof useStableQuery<{ id: string; label: string }>>;
  render(() => {
    result = useStableQuery(() => {
      revision();
      return {
        queryKey: ["example-stops", { lat: 1, lon: 2 }],
        queryFn: fetchItems,
        getKey: (item) => item.id,
        isEqual: (a, b) => a.id === b.id && a.label === b.label,
      };
    });
    return (
      <div>
        {result
          .items()
          .map((item) => item.label)
          .join(", ")}
      </div>
    );
  });
  await waitFor(() => expect(result.items()).toHaveLength(1));
  const initial = result.items();
  for (let revision = 1; revision <= 6; revision++) {
    setRevision(revision);
    flush();
  }
  expect(result.items()).toBe(initial);
  await result.query.refetch();
  flush();
  expect(result.items()).toBe(initial);
  expect(fetchItems).toHaveBeenCalledTimes(2);
});
