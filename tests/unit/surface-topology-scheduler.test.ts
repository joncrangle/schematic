import { afterEach, expect, it, vi } from "vitest";
import {
  assignTopologyWeekdays,
  createSurfaceTopologyScheduler,
  nextTopologyRunAt,
} from "~/services/surface/SurfaceTopologyScheduler";

afterEach(() => vi.useRealTimers());

it.each([1, 6, 7, 9, 20])(
  "assigns %i agencies deterministically with balanced weekdays",
  (count) => {
    const ids = Array.from({ length: count }, (_, i) => `agency-${i}`);
    const schedule = assignTopologyWeekdays(ids);
    expect(assignTopologyWeekdays([...ids].reverse())).toEqual(schedule);
    const loads = Array.from(
      { length: 7 },
      (_, day) => [...schedule.values()].filter((value) => value === day).length,
    );
    expect(Math.max(...loads) - Math.min(...loads)).toBeLessThanOrEqual(1);
    expect(new Set(schedule.values()).size).toBe(Math.min(count, 7));
  },
);

it("starts idempotently without a startup refresh and shares the in-flight cycle", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-09-29T03:59:00Z"));
  let release!: () => void;
  const run = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const scheduler = createSurfaceTopologyScheduler({ run });
  expect(scheduler.start()).toBe(true);
  expect(scheduler.start()).toBe(false);
  expect(run).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(run).toHaveBeenCalledTimes(1);
  const one = scheduler.tick(Date.now()),
    two = scheduler.tick(Date.now());
  expect(one).toBe(two);
  scheduler.stop();
  release();
  await one;
  await vi.advanceTimersByTimeAsync(8 * 86400_000);
  expect(run).toHaveBeenCalledTimes(1);
});

it("uses the next daily 04:00 UTC opportunity, even after that time today", () => {
  expect(new Date(nextTopologyRunAt(Date.parse("2026-09-29T04:00:00Z"))).toISOString()).toBe(
    "2026-09-30T04:00:00.000Z",
  );
});
