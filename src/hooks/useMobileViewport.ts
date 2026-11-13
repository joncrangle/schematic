import { createSignal, onSettled, type Accessor } from "solid-js";

const MOBILE_VIEWPORT_QUERY = "(max-width: 767px)";

function readMobileViewport(): boolean {
  return (
    typeof window !== "undefined" && window.matchMedia?.(MOBILE_VIEWPORT_QUERY).matches === true
  );
}

/** Tracks whether the current viewport uses the mobile map presentation. */
export function useMobileViewport(): Accessor<boolean> {
  const [isMobile, setIsMobile] = createSignal(readMobileViewport());

  onSettled(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;

    const mediaQuery = window.matchMedia(MOBILE_VIEWPORT_QUERY);
    setIsMobile(mediaQuery.matches);
    const listener = (event: MediaQueryListEvent) => setIsMobile(event.matches);
    mediaQuery.addEventListener("change", listener);
    return () => mediaQuery.removeEventListener("change", listener);
  });

  return isMobile;
}
