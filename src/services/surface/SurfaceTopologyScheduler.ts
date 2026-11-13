import { detectHostingTarget } from "~/infrastructure/env/hostingTarget";
import { logger } from "~/infrastructure/logging/logger";
import { refreshScheduledTopologies } from "./SurfaceTopologyRefresh";
import { nextTopologyRunAt } from "~/domain/surface/topologySchedule";
export { assignTopologyWeekdays, nextTopologyRunAt } from "~/domain/surface/topologySchedule";

/** UTC-aligned daily driver for self-hosting, with one cycle in flight. */
export function createSurfaceTopologyScheduler(
  options: {
    readonly now?: () => number;
    readonly run?: (scheduledTime: number, isCurrent: () => boolean) => Promise<unknown>;
  } = {},
) {
  const now = options.now ?? Date.now;
  const run = options.run ?? ((time, isCurrent) => refreshScheduledTopologies(time, {}, isCurrent));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let generation = 0,
    started = false;
  let inFlight: Promise<void> | undefined;
  const tick = (scheduledTime: number): Promise<void> => {
    if (inFlight) return inFlight;
    const current = generation;
    const promise = Promise.resolve()
      .then(() => run(scheduledTime, () => current === generation))
      .then(() => undefined);
    inFlight = promise;
    const clear = () => {
      if (inFlight === promise) inFlight = undefined;
    };
    void promise.then(clear, clear);
    return promise;
  };
  const arm = () => {
    const current = generation,
      at = nextTopologyRunAt(now());
    timer = setTimeout(() => {
      timer = undefined;
      if (!started || current !== generation) return;
      void tick(at)
        .catch((error) =>
          logger.error("SurfaceTopologyScheduler: daily cycle failed", { error: String(error) }),
        )
        .finally(() => {
          if (started && current === generation) arm();
        });
    }, at - now());
  };
  return {
    tick,
    start: (): boolean => {
      if (started) return false;
      started = true;
      generation++;
      arm();
      return true;
    },
    stop: (): void => {
      started = false;
      generation++;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    },
  };
}

const scheduler = createSurfaceTopologyScheduler();

/** Importing is inert. Never refresh every agency at startup. */
export function startSelfHostedSurfaceSync(): boolean {
  if (typeof window !== "undefined" || detectHostingTarget() !== "self-hosted") return false;
  return scheduler.start();
}
export function stopSelfHostedSurfaceSync(): void {
  scheduler.stop();
}
