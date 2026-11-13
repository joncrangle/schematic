import type { ShellSessionFocus } from "~/lib/shellSession";

export interface NearbyFocusAdapter extends ShellSessionFocus {
  registerTriggerElement(element: HTMLButtonElement | undefined): void;
  registerCloseControl(element: HTMLButtonElement | undefined): void;
  registerFirstActionable(routeId: string, element: HTMLElement | undefined): void;
}

export const isSafeFocusTarget = (element: HTMLElement | undefined): element is HTMLElement => {
  if (!element || !element.isConnected || element.hidden) return false;
  if (element.getAttribute("aria-hidden") === "true") return false;
  if (element.closest('[aria-hidden="true"]')) return false;

  if (typeof window === "undefined" || typeof window.getComputedStyle !== "function") {
    return true;
  }
  const style = window.getComputedStyle(element);
  return style.display !== "none" && style.visibility !== "hidden";
};

export const focusSafely = (element: HTMLElement | undefined): boolean => {
  if (!isSafeFocusTarget(element)) return false;
  element.focus({ preventScroll: true });
  return typeof document === "undefined" || document.activeElement === element;
};

/** Nearby owns the DOM references involved in its focus handoff. */
export function createNearbyFocusAdapter(): NearbyFocusAdapter {
  let targetedInvoker: HTMLElement | undefined;
  const firstActionables = new Map<string, HTMLElement>();
  let closeControl: HTMLButtonElement | undefined;
  let trigger: HTMLButtonElement | undefined;

  const restoreFocusAfterTargetedExit = (expandedRouteId?: string | null) => {
    queueMicrotask(() => {
      if (focusSafely(targetedInvoker)) {
        targetedInvoker = undefined;
        return;
      }
      targetedInvoker = undefined;
      if (expandedRouteId && focusSafely(firstActionables.get(expandedRouteId))) return;
      if (focusSafely(closeControl)) return;
      focusSafely(trigger);
    });
  };

  return {
    captureTargetedInvoker: (element) => {
      targetedInvoker = element;
    },
    restoreFocusAfterTargetedExit,
    registerTriggerElement: (element) => {
      trigger = element;
    },
    registerCloseControl: (element) => {
      closeControl = element;
    },
    registerFirstActionable: (routeId, element) => {
      if (element) {
        firstActionables.set(routeId, element);
      } else {
        firstActionables.delete(routeId);
      }
    },
  };
}
