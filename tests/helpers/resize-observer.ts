import { vi } from "vitest";

/**
 * Installs a ResizeObserver that delivers one initial measurement per observed
 * element, mirroring the browser: observing a container reports its current
 * size before paint. happy-dom's ResizeObserver is a no-op, so a viewport that
 * fits the camera from the observer's first entry would never become ready.
 */
export function stubInitialResizeObserver(width: number, height: number): void {
  vi.stubGlobal(
    "ResizeObserver",
    class implements ResizeObserver {
      private disconnected = false;
      constructor(private callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        queueMicrotask(() => {
          if (this.disconnected) return;
          const size = [{ inlineSize: width, blockSize: height }];
          this.callback(
            [
              {
                target,
                contentRect: new DOMRectReadOnly(0, 0, width, height),
                borderBoxSize: size,
                contentBoxSize: size,
                devicePixelContentBoxSize: size,
              },
            ],
            this,
          );
        });
      }
      unobserve(): void {}
      disconnect(): void {
        this.disconnected = true;
      }
    },
  );
}
