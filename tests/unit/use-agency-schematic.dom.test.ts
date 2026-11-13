// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { agencySchematicLoaders } from "virtual:agency-schematics";
import { useAgencySchematic } from "~/hooks/useAgencySchematic";
import { peekSchematic } from "~/services/schematic/SchematicLoader";

const [first, second] = Object.keys(agencySchematicLoaders);
const retryId = "retry-test-agency";

describe("useAgencySchematic", () => {
  it("is undefined until the lazy chunk resolves, then serves the cached schematic", async () => {
    const [id, setId] = createSignal<string | undefined>(first);
    await createRoot(async (dispose) => {
      const schematic = useAgencySchematic(id);
      expect(schematic()).toBeUndefined();

      await vi.waitFor(() => {
        flush();
        expect(schematic()).toBeDefined();
      });
      expect(schematic()).toBe(peekSchematic(first!));

      // Switching to another agency never reports the previous agency's map.
      setId(second);
      flush();
      expect(schematic()).toBeUndefined();
      await vi.waitFor(() => {
        flush();
        expect(schematic()).toBe(peekSchematic(second!));
      });

      // Returning to a loaded agency is immediate.
      setId(first);
      flush();
      expect(schematic()).toBe(peekSchematic(first!));
      dispose();
    });
  });

  it("retries a failed chunk import after a backoff", async () => {
    vi.useFakeTimers();
    const real = agencySchematicLoaders[first!]!;
    let calls = 0;
    const loaders = agencySchematicLoaders as Record<string, () => Promise<unknown>>;
    loaders[retryId] = () => (++calls === 1 ? Promise.reject(new Error("offline")) : real());
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await createRoot(async (dispose) => {
        const schematic = useAgencySchematic(() => retryId);
        await vi.advanceTimersByTimeAsync(0);
        flush();
        expect(schematic()).toBeUndefined();
        expect(calls).toBe(1);

        await vi.advanceTimersByTimeAsync(1_000);
        flush();
        expect(calls).toBe(2);
        await vi.waitFor(() => {
          flush();
          expect(schematic()).toBeDefined();
        });
        dispose();
      });
    } finally {
      delete loaders[retryId];
      warn.mockRestore();
      vi.useRealTimers();
    }
  });

  it("stays undefined for an agency without a schematic", async () => {
    await createRoot(async (dispose) => {
      const schematic = useAgencySchematic(() => "mapless-agency");
      await new Promise((resolve) => setTimeout(resolve, 0));
      flush();
      expect(schematic()).toBeUndefined();
      dispose();
    });
  });
});
