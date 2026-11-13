import { type Accessor, createSignal, onCleanup } from "solid-js";

/**
 * One ticking clock for every live label in the app.
 *
 * Feed freshness, arrival countdowns, and the location grace label all read
 * wall-clock time on a one-second cadence. Giving each reader its own
 * `setInterval` produced dozens of timers (one per arrival row) firing at
 * unrelated offsets, each triggering its own reactive flush. They share this
 * signal instead: one timer, one write per second, one flush.
 *
 * The timer runs only while at least one consumer is mounted, so an idle app
 * holds no interval. Reads outside a component (for example SSR) still resolve
 * to the current time; the timer itself is browser-only.
 */
const TICK_MS = 1000;

let clock: Accessor<number> | undefined;
let writeClock: ((value: number) => number) | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let consumers = 0;
let listening = false;

function readClock(): Accessor<number> {
  if (!clock) {
    const [read, write] = createSignal(Date.now(), { ownedWrite: true });
    clock = read;
    writeClock = write;
  }
  return clock;
}

const isHidden = (): boolean => document.visibilityState === "hidden";

function tick(): void {
  writeClock!(Date.now());
}

function startTimer(): void {
  if (timer !== undefined || isHidden()) return;
  timer = setInterval(tick, TICK_MS);
}

function stopTimer(): void {
  if (timer === undefined) return;
  clearInterval(timer);
  timer = undefined;
}

// A hidden tab renders nothing, so ticking only wakes the page and flushes
// reactive work nobody can see. Pause, then resync on return.
function handleVisibilityChange(): void {
  if (isHidden()) {
    stopTimer();
    return;
  }
  tick();
  startTimer();
}

function startClock(): void {
  if (typeof window === "undefined" || listening) return;
  listening = true;
  document.addEventListener("visibilitychange", handleVisibilityChange);
  startTimer();
}

function stopClock(): void {
  if (!listening) return;
  listening = false;
  document.removeEventListener("visibilitychange", handleVisibilityChange);
  stopTimer();
}

/** Reads the shared clock; pairs the interval with the calling owner's life. */
export function useAppClock(): Accessor<number> {
  const read = readClock();
  // The timer was idle before this mount, so resync instead of exposing a
  // timestamp left over from the last window of interest.
  if (consumers === 0) writeClock!(Date.now());
  consumers += 1;
  startClock();
  onCleanup(() => {
    consumers -= 1;
    if (consumers === 0) stopClock();
  });
  return read;
}
