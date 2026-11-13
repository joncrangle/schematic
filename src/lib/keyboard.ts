import { onCleanup, type Accessor } from "solid-js";

export interface KeyActionHandlers {
  readonly onEnter?: (e: KeyboardEvent) => void;
  readonly onEscape?: (e: KeyboardEvent) => void;
  readonly onSpace?: (e: KeyboardEvent) => void;
  readonly preventDefault?: boolean;
  readonly stopPropagation?: boolean;
}

/**
 * Creates an event handler for inputs or interactive elements
 * that cleanly maps Enter, Escape, Space to callbacks with standard bubbling isolation.
 */
export function createKeyHandler(handlers: KeyActionHandlers) {
  return (e: KeyboardEvent) => {
    const isEnter = e.key === "Enter" || e.code === "Enter" || e.keyCode === 13;
    const isEscape = e.key === "Escape" || e.code === "Escape" || e.keyCode === 27;
    const isSpace = e.key === " " || e.code === "Space" || e.keyCode === 32;

    if (isEnter && handlers.onEnter) {
      if (handlers.preventDefault ?? true) e.preventDefault();
      if (handlers.stopPropagation ?? true) e.stopPropagation();
      handlers.onEnter(e);
    } else if (isEscape && handlers.onEscape) {
      if (handlers.preventDefault ?? true) e.preventDefault();
      if (handlers.stopPropagation ?? true) e.stopPropagation();
      handlers.onEscape(e);
    } else if (isSpace && handlers.onSpace) {
      if (handlers.preventDefault ?? true) e.preventDefault();
      if (handlers.stopPropagation ?? true) e.stopPropagation();
      handlers.onSpace(e);
    }
  };
}

/**
 * Standard WAI-ARIA trigger for custom clickable elements (Enter or Space).
 */
export function handleActionKey(action: () => void) {
  return createKeyHandler({ onEnter: action, onSpace: action });
}

/**
 * Declarative Escape key listener attached to window with automatic lifecycle cleanup.
 */
export function useEscapeKey(onEscape: () => void, isEnabled: Accessor<boolean> | boolean = true) {
  if (typeof window === "undefined") return;

  const handler = (e: KeyboardEvent) => {
    const active = typeof isEnabled === "function" ? isEnabled() : isEnabled;
    if (active && (e.key === "Escape" || e.code === "Escape" || e.keyCode === 27)) {
      onEscape();
    }
  };

  window.addEventListener("keydown", handler);
  onCleanup(() => window.removeEventListener("keydown", handler));
}
