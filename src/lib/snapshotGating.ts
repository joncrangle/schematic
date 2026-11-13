import { createSignal, onSettled, type Accessor } from "solid-js";

export interface SnapshotGateOptions {
  readonly delayMs?: number;
  readonly isComplete?: () => boolean;
}

export function useSnapshotGating(options: SnapshotGateOptions = {}): Accessor<boolean> {
  const [enabled, setEnabled] = createSignal(false);
  const delayMs = options.delayMs ?? 1000;

  onSettled(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const enableAfterLoad = () => {
      timer = setTimeout(() => setEnabled(true), delayMs);
    };

    const isComplete =
      options.isComplete ??
      (() => typeof document !== "undefined" && document.readyState === "complete");

    if (isComplete()) {
      enableAfterLoad();
    } else if (typeof window !== "undefined") {
      window.addEventListener("load", enableAfterLoad, { once: true });
    }

    return () => {
      if (timer !== undefined) clearTimeout(timer);
      if (typeof window !== "undefined") {
        window.removeEventListener("load", enableAfterLoad);
      }
    };
  });

  return enabled;
}
