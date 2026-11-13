// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flush } from "solid-js";
import { cleanup, render } from "@solidjs/testing-library";
import { useAppClock } from "~/lib/appClock";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe("useAppClock", () => {
  it("drives every consumer from one interval and releases it when they unmount", () => {
    vi.useFakeTimers();
    const setIntervalSpy = vi.spyOn(globalThis, "setInterval");
    const clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");

    function Clock(props: { label: string }) {
      const now = useAppClock();
      return <output data-testid={props.label}>{String(now())}</output>;
    }

    const view = render(() => (
      <>
        <Clock label="first" />
        <Clock label="second" />
        <Clock label="third" />
      </>
    ));

    // Every live label shares the single app interval.
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);

    const before = Number(view.getByTestId("first").textContent);
    vi.advanceTimersByTime(1_000);
    flush();
    const ticked = Number(view.getByTestId("first").textContent);
    expect(ticked).toBe(before + 1_000);
    expect(view.getByTestId("second").textContent).toBe(String(ticked));
    expect(view.getByTestId("third").textContent).toBe(String(ticked));

    cleanup();
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);

    // Idle again: no interval survives, so nothing is scheduled or cleared.
    vi.advanceTimersByTime(5_000);
    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });

  it("stops ticking while the page is hidden and resyncs when it returns", () => {
    vi.useFakeTimers();
    function Clock() {
      const now = useAppClock();
      return <output data-testid="clock">{String(now())}</output>;
    }
    const view = render(() => <Clock />);
    const visibility = vi.spyOn(document, "visibilityState", "get");

    visibility.mockReturnValue("hidden");
    document.dispatchEvent(new Event("visibilitychange"));
    const frozen = view.getByTestId("clock").textContent;
    vi.advanceTimersByTime(30_000);
    flush();
    expect(view.getByTestId("clock").textContent).toBe(frozen);

    visibility.mockReturnValue("visible");
    document.dispatchEvent(new Event("visibilitychange"));
    flush();
    expect(Number(view.getByTestId("clock").textContent)).toBe(Number(frozen) + 30_000);
    vi.advanceTimersByTime(1_000);
    flush();
    expect(Number(view.getByTestId("clock").textContent)).toBe(Number(frozen) + 31_000);

    visibility.mockRestore();
  });
});
