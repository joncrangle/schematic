/**
 * Shared DOM-interaction harnesses for "open lifecycle / no-backdrop"
 * regression suites (service sheet, settings popover).
 */

/**
 * Dispatches a bubbling "pointerdown" without relying on testing-library's
 * fireEvent (which needs a PointerEvent constructor). Falls back to a
 * MouseEvent typed as "pointerdown" so document-level listeners receive the
 * event regardless of happy-dom's PointerEvent support.
 */
export function firePointerDown(target: Element) {
  const win = window as unknown as { PointerEvent?: typeof PointerEvent };
  if (typeof win.PointerEvent === "function") {
    target.dispatchEvent(new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true }));
  } else {
    target.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, cancelable: true }));
  }
}

export interface BodyRemovalObserver {
  /** Drains queued-but-undelivered records and returns every node removed so far. */
  takeRemoved(): Node[];
  disconnect(): void;
}

/**
 * Observes document.body child-list mutations (subtree) and collects every
 * removed node. Use to pin that opening an overlay only ADDS its subtree and
 * never removes pre-existing UI.
 */
export function observeBodyRemovals(): BodyRemovalObserver {
  const removedNodes: Node[] = [];
  const observer = new MutationObserver((records) => {
    for (const record of records) {
      record.removedNodes.forEach((node) => removedNodes.push(node));
    }
  });
  observer.observe(document.body, { childList: true, subtree: true });

  return {
    takeRemoved(): Node[] {
      for (const record of observer.takeRecords()) {
        record.removedNodes.forEach((node) => removedNodes.push(node));
      }
      return Array.from(removedNodes);
    },
    disconnect(): void {
      observer.disconnect();
    },
  };
}

/** Whether `root` itself or any of its descendants appears in `removedList`. */
export function removedNodeOrDescendant(removedList: readonly Node[], root: Node): boolean {
  return removedList.some((node) => node === root || root.contains(node));
}
