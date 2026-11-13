// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { createRoot, createSignal, flush } from "solid-js";
import { createKeyHandler, handleActionKey, useEscapeKey } from "~/lib/keyboard";

describe("Keyboard Utilities (src/lib/keyboard.ts)", () => {
  describe("createKeyHandler", () => {
    it("calls onEnter callback and prevents default/stops propagation by default", () => {
      const onEnter = vi.fn();
      const onEscape = vi.fn();
      const handler = createKeyHandler({ onEnter, onEscape });

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      const stopPropagationSpy = vi.spyOn(event, "stopPropagation");

      handler(event);

      expect(onEnter).toHaveBeenCalledWith(event);
      expect(onEscape).not.toHaveBeenCalled();
      expect(preventDefaultSpy).toHaveBeenCalled();
      expect(stopPropagationSpy).toHaveBeenCalled();
    });

    it("calls onEscape callback on Escape key", () => {
      const onEnter = vi.fn();
      const onEscape = vi.fn();
      const handler = createKeyHandler({ onEnter, onEscape });

      const event = new KeyboardEvent("keydown", {
        key: "Escape",
        bubbles: true,
        cancelable: true,
      });
      handler(event);

      expect(onEscape).toHaveBeenCalledWith(event);
      expect(onEnter).not.toHaveBeenCalled();
    });

    it("respects preventDefault: false and stopPropagation: false", () => {
      const onEnter = vi.fn();
      const handler = createKeyHandler({
        onEnter,
        preventDefault: false,
        stopPropagation: false,
      });

      const event = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      const stopPropagationSpy = vi.spyOn(event, "stopPropagation");

      handler(event);

      expect(onEnter).toHaveBeenCalled();
      expect(preventDefaultSpy).not.toHaveBeenCalled();
      expect(stopPropagationSpy).not.toHaveBeenCalled();
    });

    it("ignores unrelated keys", () => {
      const onEnter = vi.fn();
      const onEscape = vi.fn();
      const handler = createKeyHandler({ onEnter, onEscape });

      const event = new KeyboardEvent("keydown", { key: "Tab" });
      handler(event);

      expect(onEnter).not.toHaveBeenCalled();
      expect(onEscape).not.toHaveBeenCalled();
    });
  });

  describe("handleActionKey", () => {
    it("triggers action on Enter or Space", () => {
      const action = vi.fn();
      const handler = handleActionKey(action);

      handler(new KeyboardEvent("keydown", { key: "Enter" }));
      expect(action).toHaveBeenCalledTimes(1);

      handler(new KeyboardEvent("keydown", { key: " " }));
      expect(action).toHaveBeenCalledTimes(2);

      handler(new KeyboardEvent("keydown", { key: "ArrowDown" }));
      expect(action).toHaveBeenCalledTimes(2);
    });
  });

  describe("useEscapeKey", () => {
    it("invokes callback when Escape is pressed while active", () => {
      const onEscape = vi.fn();

      createRoot((dispose) => {
        useEscapeKey(onEscape, true);

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(onEscape).toHaveBeenCalledTimes(1);

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
        expect(onEscape).toHaveBeenCalledTimes(1);

        dispose();

        // After dispose, listener should be removed
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(onEscape).toHaveBeenCalledTimes(1);
      });
    });

    it("reacts to reactive boolean accessor", () => {
      const onEscape = vi.fn();

      createRoot((dispose) => {
        const [isOpen, setIsOpen] = createSignal(false, { ownedWrite: true });
        useEscapeKey(onEscape, isOpen);

        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(onEscape).not.toHaveBeenCalled();

        setIsOpen(true);
        flush();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(onEscape).toHaveBeenCalledTimes(1);

        setIsOpen(false);
        flush();
        window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
        expect(onEscape).toHaveBeenCalledTimes(1);

        dispose();
      });
    });
  });
});
