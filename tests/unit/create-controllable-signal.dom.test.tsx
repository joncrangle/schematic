// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { createControllableSignal } from "../../src/lib/createControllableSignal";

/**
 * Controlled/uncontrolled duality helper: the accessor wins whenever it
 * carries a defined value; otherwise the internal signal serves. Writes always
 * land on the internal signal so a cleared prop hands back the written state.
 */

function capture<T>(body: () => T) {
  return createRoot(() => {
    const captured = body();
    return () => captured;
  });
}

describe("createControllableSignal", () => {
  it("serves the fallback and applies writes when uncontrolled", () => {
    const read = capture(() => {
      const [value, setValue] = createControllableSignal(undefined, () => "fallback");
      return { value, setValue };
    });
    expect(read()!.value()).toBe("fallback");
    read()!.setValue("written");
    // Staged writes commit on the microtask; flush before asserting.
    flush();
    expect(read()!.value()).toBe("written");
  });

  it("supports the updater form of writes", () => {
    const read = capture(() => {
      const [value, setValue] = createControllableSignal(undefined, () => 10);
      setValue((prev) => prev + 5);
      return { value, setValue };
    });
    flush();
    expect(read()!.value()).toBe(15);
  });

  it("prefers a defined prop value over the internal signal", () => {
    const read = capture(() => {
      const [prop, setProp] = createSignal<string | undefined>("from-prop", { ownedWrite: true });
      const [value, setValue] = createControllableSignal(prop, () => "fallback");
      setValue("ignored-write");
      return {
        get value() {
          return value();
        },
        setProp,
      };
    });
    expect(read()!.value).toBe("from-prop");
  });

  it("falls back to the written internal state once the prop clears", () => {
    const read = capture(() => {
      const [prop, setProp] = createSignal<string | undefined>("from-prop", { ownedWrite: true });
      const [value, setValue] = createControllableSignal(prop, () => "fallback");
      setValue("written-under-control");
      return {
        get value() {
          return value();
        },
        setProp,
      };
    });
    read()!.setProp(undefined);
    flush();
    expect(read()!.value).toBe("written-under-control");
  });

  it("treats an explicit null prop as a defined controlled value", () => {
    const read = capture(() => {
      const [prop, setProp] = createSignal<string | null | undefined>(null, { ownedWrite: true });
      const [value, setValue] = createControllableSignal(prop, () => "fallback");
      setValue("ignored-write");
      return {
        get value() {
          return value();
        },
        setProp,
      };
    });
    expect(read()!.value).toBe(null);
    read()!.setProp("now-controlled");
    flush();
    expect(read()!.value).toBe("now-controlled");
  });

  it("evaluates the fallback lazily through its accessor", () => {
    let constructions = 0;
    const read = capture(() => {
      const [value] = createControllableSignal<number | undefined>(undefined, () => {
        constructions += 1;
        return 42;
      });
      return {
        get value() {
          return value();
        },
      };
    });
    expect(read()!.value).toBe(42);
    expect(constructions).toBe(1);
  });
});
