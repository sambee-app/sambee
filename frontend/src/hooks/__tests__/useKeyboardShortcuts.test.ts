import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BROWSER_SHORTCUTS, CODEMIRROR_EDITOR_SHORTCUTS, MARKDOWN_EDITOR_SHORTCUTS } from "../../config/keyboardShortcuts";
import { requireTestValue } from "../../test/helpers/assertions";
import { setApplePlatformForTesting } from "../../utils/platform";
import type { KeyboardShortcut } from "../useKeyboardShortcuts";
import { formatShortcut, useKeyboardShortcuts, withShortcut } from "../useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  let mockHandler: (event?: KeyboardEvent) => void;

  beforeEach(() => {
    mockHandler = vi.fn();
    setApplePlatformForTesting(false);
    vi.clearAllMocks();
  });

  afterEach(() => {
    setApplePlatformForTesting(null);
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur();
    }

    document.body.innerHTML = "";
  });

  // Helper to simulate keyboard events
  const simulateKeyPress = (
    key: string,
    modifiers?: {
      ctrlKey?: boolean;
      shiftKey?: boolean;
      altKey?: boolean;
      metaKey?: boolean;
      keyCode?: number;
      isComposing?: boolean;
    }
  ) => {
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: modifiers?.ctrlKey ?? false,
      shiftKey: modifiers?.shiftKey ?? false,
      altKey: modifiers?.altKey ?? false,
      metaKey: modifiers?.metaKey ?? false,
      keyCode: modifiers?.keyCode ?? 0,
      isComposing: modifiers?.isComposing ?? false,
      bubbles: true,
      cancelable: true,
    });
    document.dispatchEvent(event);
    return event;
  };

  describe("Basic Functionality", () => {
    it("keeps icon activation local while allowing file-list navigation", () => {
      const list = document.createElement("div");
      list.tabIndex = 0;
      list.dataset["testid"] = "file-list-container";
      const icon = document.createElement("button");
      icon.dataset["fileSelectionIcon"] = "true";
      list.appendChild(icon);
      document.body.appendChild(list);
      const shortcuts: KeyboardShortcut[] = [
        { id: "navigate", keys: "ArrowDown", description: "Next item", handler: mockHandler },
        { id: "open", keys: "Enter", description: "Open item", handler: mockHandler },
        { id: "select", keys: " ", description: "Select item", handler: mockHandler },
      ];
      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      icon.focus();
      simulateKeyPress("Enter");
      simulateKeyPress(" ");
      expect(mockHandler).not.toHaveBeenCalled();

      simulateKeyPress("ArrowDown");
      expect(document.activeElement).toBe(list);
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should trigger handler on matching key press", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test shortcut",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a");

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should support multiple keys for same action", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "nav",
          keys: ["a", "b", "ArrowRight"],
          description: "Navigate",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      simulateKeyPress("a");
      expect(mockHandler).toHaveBeenCalledTimes(1);

      simulateKeyPress("b");
      expect(mockHandler).toHaveBeenCalledTimes(2);

      simulateKeyPress("ArrowRight");
      expect(mockHandler).toHaveBeenCalledTimes(3);
    });

    it("should pass KeyboardEvent to handler", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a");

      expect(mockHandler).toHaveBeenCalledWith(expect.any(KeyboardEvent));
      expect(requireTestValue((mockHandler as ReturnType<typeof vi.fn>).mock.calls[0])[0].key).toBe("a");
    });

    it("should not trigger handler when disabled", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
          enabled: false,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      const event = simulateKeyPress("a");

      expect(mockHandler).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("should handle a matching disabled shortcut when no enabled shortcut matches", () => {
      const onUnavailable = vi.fn(() => true);
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "disabled",
          keys: "a",
          description: "Disabled",
          handler: mockHandler,
          enabled: false,
          onUnavailable,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      const event = simulateKeyPress("a");

      expect(mockHandler).not.toHaveBeenCalled();
      expect(onUnavailable).toHaveBeenCalledWith(event);
      expect(event.defaultPrevented).toBe(true);
    });

    it("should not consume a disabled shortcut when unavailable handling returns false", () => {
      const onUnavailable = vi.fn(() => false);
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "disabled",
          keys: "a",
          description: "Disabled",
          handler: mockHandler,
          enabled: false,
          onUnavailable,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      const event = simulateKeyPress("a");

      expect(onUnavailable).toHaveBeenCalledWith(event);
      expect(event.defaultPrevented).toBe(false);
    });

    it("should prefer an enabled matching shortcut over unavailable handling", () => {
      const onUnavailable = vi.fn(() => true);
      const enabledHandler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "disabled",
          keys: "a",
          description: "Disabled",
          handler: mockHandler,
          enabled: false,
          onUnavailable,
          priority: 10,
        },
        {
          id: "enabled",
          keys: "a",
          description: "Enabled",
          handler: enabledHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a");

      expect(enabledHandler).toHaveBeenCalledTimes(1);
      expect(onUnavailable).not.toHaveBeenCalled();
    });

    it("should ignore repeat events for disabled shortcut handling", () => {
      const onUnavailable = vi.fn(() => true);
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "disabled",
          keys: "a",
          description: "Disabled",
          handler: mockHandler,
          enabled: false,
          onUnavailable,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      const event = new KeyboardEvent("keydown", { key: "a", bubbles: true, cancelable: true, repeat: true });
      document.dispatchEvent(event);

      expect(onUnavailable).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("should trigger handler when enabled is true", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
          enabled: true,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a");

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should allow a shortcut only within the configured interactive surface", () => {
      document.body.innerHTML =
        '<div><input data-quick-bar-input="true" id="quick-bar-input" /><div class="cm-editor"><div contenteditable="true" id="editor-focus"></div></div></div>';

      const quickBarInput = document.getElementById("quick-bar-input");
      const editorFocus = document.getElementById("editor-focus");

      if (!(quickBarInput instanceof HTMLInputElement) || !(editorFocus instanceof HTMLElement)) {
        throw new Error("Expected test focus targets");
      }

      const shortcuts: KeyboardShortcut[] = [
        {
          id: "focus-connection-selector",
          keys: "ArrowDown",
          description: "Open connection selector",
          ctrl: true,
          allowInInputWithin: '[data-quick-bar-input="true"]',
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      quickBarInput.focus();
      simulateKeyPress("ArrowDown", { ctrlKey: true });
      expect(mockHandler).toHaveBeenCalledTimes(1);

      editorFocus.focus();
      simulateKeyPress("ArrowDown", { ctrlKey: true });
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });
  });

  describe("Modifier Keys", () => {
    it("should handle Ctrl+Key on Windows/Linux", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "save",
          keys: "s",
          description: "Save",
          ctrl: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("s", { ctrlKey: true });

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should handle Cmd+Key on macOS", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "save",
          keys: "s",
          description: "Save",
          ctrl: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("s", { metaKey: true });

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should handle Shift+Key", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "rotate",
          keys: "R",
          description: "Rotate left",
          shift: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("R", { shiftKey: true });

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should handle Alt+Key", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "menu",
          keys: "F",
          description: "File menu",
          alt: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("F", { altKey: true });

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should handle multiple modifiers (Ctrl+Shift+Key)", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "redo",
          keys: "z",
          description: "Redo",
          ctrl: true,
          shift: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("z", { ctrlKey: true, shiftKey: true });

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should not trigger without required modifier", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "save",
          keys: "s",
          description: "Save",
          ctrl: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("s");

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("should not trigger with extra unexpected modifier", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a", { ctrlKey: true });

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe("Input Focus Handling", () => {
    let input: HTMLInputElement;
    let button: HTMLButtonElement;

    beforeEach(() => {
      input = document.createElement("input");
      button = document.createElement("button");
      button.type = "button";
      document.body.appendChild(input);
      document.body.appendChild(button);
    });

    afterEach(() => {
      document.body.removeChild(input);
      document.body.removeChild(button);
    });

    it("should block shortcut when input has focus by default", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      input.focus();
      simulateKeyPress("a");

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("should block unavailable shortcut handling when input has focus", () => {
      const onUnavailable = vi.fn(() => true);
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "disabled",
          keys: "a",
          description: "Disabled",
          handler: mockHandler,
          enabled: false,
          onUnavailable,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      input.focus();
      const event = simulateKeyPress("a");

      expect(onUnavailable).not.toHaveBeenCalled();
      expect(event.defaultPrevented).toBe(false);
    });

    it("should allow shortcut with allowInInput: true", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "Escape",
          description: "Close",
          allowInInput: true,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      input.focus();
      simulateKeyPress("Escape");

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should block shortcut when button has focus by default", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "toggle-selection",
          keys: " ",
          description: "Toggle selection",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      button.focus();
      simulateKeyPress(" ");

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("should work when input loses focus", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      input.focus();
      input.blur();
      simulateKeyPress("a");

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should respect custom input selector", () => {
      const textarea = document.createElement("textarea");
      document.body.appendChild(textarea);

      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() =>
        useKeyboardShortcuts({
          shortcuts,
          inputSelector: "textarea",
        })
      );

      // Should work in input (not matched by selector)
      input.focus();
      simulateKeyPress("a");
      expect(mockHandler).toHaveBeenCalledTimes(1);

      // Should be blocked in textarea (matched by selector)
      textarea.focus();
      simulateKeyPress("a");
      expect(mockHandler).toHaveBeenCalledTimes(1); // Still 1, not called again

      document.body.removeChild(textarea);
    });
  });

  describe("Priority System", () => {
    it("should execute higher priority shortcut first", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const shortcuts: KeyboardShortcut[] = [
        {
          id: "low",
          keys: "a",
          description: "Low priority",
          priority: 1,
          handler: handler1,
        },
        {
          id: "high",
          keys: "a",
          description: "High priority",
          priority: 10,
          handler: handler2,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a");

      expect(handler2).toHaveBeenCalledTimes(1);
      expect(handler1).not.toHaveBeenCalled();
    });

    it("should use registration order when priorities are equal", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const shortcuts: KeyboardShortcut[] = [
        {
          id: "first",
          keys: "a",
          description: "First",
          handler: handler1,
        },
        {
          id: "second",
          keys: "a",
          description: "Second",
          handler: handler2,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("a");

      expect(handler1).toHaveBeenCalledTimes(1);
      expect(handler2).not.toHaveBeenCalled();
    });
  });

  describe("Event Handling", () => {
    it("should call preventDefault on match", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      const event = new KeyboardEvent("keydown", {
        key: "a",
        bubbles: true,
        cancelable: true,
      });
      const preventDefaultSpy = vi.spyOn(event, "preventDefault");
      document.dispatchEvent(event);

      expect(preventDefaultSpy).toHaveBeenCalled();
    });

    it("should skip if event.defaultPrevented", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      const event = new KeyboardEvent("keydown", {
        key: "a",
        bubbles: true,
        cancelable: true,
      });
      event.preventDefault(); // Prevent before dispatching
      document.dispatchEvent(event);

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe("International Keyboard Support", () => {
    it("should ignore shift for printable characters (German keyboard)", () => {
      // On German keyboard, "/" requires Shift+7
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "search",
          keys: "/",
          description: "Focus search",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("/", { shiftKey: true });

      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should respect shift for non-printable keys", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "nav",
          keys: "ArrowRight",
          description: "Navigate",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("ArrowRight", { shiftKey: true });

      expect(mockHandler).not.toHaveBeenCalled();
    });

    it("should respect shift for multi-character keys", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "home",
          keys: "Home",
          description: "Go to first",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));
      simulateKeyPress("Home", { shiftKey: true });

      expect(mockHandler).not.toHaveBeenCalled();
    });
  });

  describe("Dynamic Updates", () => {
    it("should not register handlers while inactive", () => {
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      const { rerender } = renderHook(
        ({ active }) =>
          useKeyboardShortcuts({
            shortcuts,
            active,
          }),
        {
          initialProps: { active: false },
        }
      );

      simulateKeyPress("a");
      expect(mockHandler).not.toHaveBeenCalled();

      rerender({ active: true });
      simulateKeyPress("a");
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("should update when shortcuts change", () => {
      const handler1 = vi.fn();
      const handler2 = vi.fn();

      const shortcuts1: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test 1",
          handler: handler1,
        },
      ];

      const shortcuts2: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test 2",
          handler: handler2,
        },
      ];

      const { rerender } = renderHook(({ shortcuts }) => useKeyboardShortcuts({ shortcuts }), {
        initialProps: { shortcuts: shortcuts1 },
      });

      simulateKeyPress("a");
      expect(handler1).toHaveBeenCalledTimes(1);

      rerender({ shortcuts: shortcuts2 });
      simulateKeyPress("a");
      expect(handler2).toHaveBeenCalledTimes(1);
    });

    it("should update when enabled state changes", () => {
      let enabled = true;

      const { rerender } = renderHook(() =>
        useKeyboardShortcuts({
          shortcuts: [
            {
              id: "test",
              keys: "a",
              description: "Test",
              handler: mockHandler,
              enabled,
            },
          ],
        })
      );

      simulateKeyPress("a");
      expect(mockHandler).toHaveBeenCalledTimes(1);

      enabled = false;
      rerender();
      simulateKeyPress("a");
      expect(mockHandler).toHaveBeenCalledTimes(1); // Still 1, not called again
    });

    it("should cleanup event listeners on unmount", () => {
      const addEventListenerSpy = vi.spyOn(document, "addEventListener");
      const removeEventListenerSpy = vi.spyOn(document, "removeEventListener");

      const shortcuts: KeyboardShortcut[] = [
        {
          id: "test",
          keys: "a",
          description: "Test",
          handler: mockHandler,
        },
      ];

      const { unmount } = renderHook(() => useKeyboardShortcuts({ shortcuts }));

      expect(addEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true);

      unmount();

      expect(removeEventListenerSpy).toHaveBeenCalledWith("keydown", expect.any(Function), true);

      addEventListenerSpy.mockRestore();
      removeEventListenerSpy.mockRestore();
    });
  });

  describe("Platform-Aware Shortcut Matching", () => {
    it("matches Option+letter on macOS when Option alters event.key and keyCode is the letter code", () => {
      setApplePlatformForTesting(true);
      const shortcuts: KeyboardShortcut[] = [
        {
          ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WORD_WRAP,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      simulateKeyPress("Ω", { altKey: true, keyCode: "Z".charCodeAt(0) });
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("matches Control+Option+letter on macOS when Option alters event.key", () => {
      setApplePlatformForTesting(true);
      const shortcuts: KeyboardShortcut[] = [
        {
          ...MARKDOWN_EDITOR_SHORTCUTS.INSERT_TABLE,
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      simulateKeyPress("†", { ctrlKey: true, altKey: true, keyCode: "T".charCodeAt(0) });
      expect(mockHandler).toHaveBeenCalledTimes(1);
    });

    it("does not apply macOS keyCode fallback without Option, to punctuation/digits, or to non-alt shortcuts", () => {
      setApplePlatformForTesting(true);
      const plainLetterHandler = vi.fn();
      const punctuationHandler = vi.fn();
      const digitHandler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "plain-letter",
          keys: ["z", "Z"],
          description: "Plain letter",
          handler: plainLetterHandler,
        },
        {
          id: "alt-punctuation",
          keys: "-",
          alt: true,
          description: "Alt minus",
          handler: punctuationHandler,
        },
        {
          id: "alt-digit",
          keys: "1",
          alt: true,
          description: "Alt digit",
          handler: digitHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      // Without Option, keyCode fallback must not match a different event.key
      simulateKeyPress("Ω", { altKey: false, keyCode: "Z".charCodeAt(0) });
      // Punctuation and digits must not use keyCode fallback even when Option is held
      simulateKeyPress("–", { altKey: true, keyCode: "-".charCodeAt(0) });
      simulateKeyPress("¡", { altKey: true, keyCode: "1".charCodeAt(0) });

      expect(plainLetterHandler).not.toHaveBeenCalled();
      expect(punctuationHandler).not.toHaveBeenCalled();
      expect(digitHandler).not.toHaveBeenCalled();
    });

    it("matches macControlForAlt shortcuts on macOS with Control only, excluding Option and Cmd", () => {
      setApplePlatformForTesting(true);
      const newTabHandler = vi.fn();
      const closeTabHandler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "new-tab",
          keys: "+",
          alt: true,
          macControlForAlt: true,
          description: "New tab",
          handler: newTabHandler,
        },
        {
          id: "close-tab",
          keys: "-",
          alt: true,
          macControlForAlt: true,
          description: "Close tab",
          handler: closeTabHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      // Control+Plus (including Shift-produced + on US layout) and Control+Minus match
      simulateKeyPress("+", { ctrlKey: true, shiftKey: true });
      simulateKeyPress("+", { ctrlKey: true });
      simulateKeyPress("-", { ctrlKey: true });
      expect(newTabHandler).toHaveBeenCalledTimes(2);
      expect(closeTabHandler).toHaveBeenCalledTimes(1);

      // Option+Plus/Minus and Cmd+Plus/Minus must not match
      simulateKeyPress("+", { altKey: true });
      simulateKeyPress("±", { altKey: true, shiftKey: true });
      simulateKeyPress("-", { altKey: true });
      simulateKeyPress("+", { metaKey: true, shiftKey: true });
      simulateKeyPress("-", { metaKey: true });
      simulateKeyPress("+", { ctrlKey: true, metaKey: true });
      simulateKeyPress("+", { ctrlKey: true, altKey: true });

      expect(newTabHandler).toHaveBeenCalledTimes(2);
      expect(closeTabHandler).toHaveBeenCalledTimes(1);
    });

    it("matches macControlForAlt shortcuts on Windows/Linux with Alt+Plus and Alt+Minus by character", () => {
      setApplePlatformForTesting(false);
      const newTabHandler = vi.fn();
      const closeTabHandler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "new-tab",
          keys: "+",
          alt: true,
          macControlForAlt: true,
          description: "New tab",
          handler: newTabHandler,
        },
        {
          id: "close-tab",
          keys: "-",
          alt: true,
          macControlForAlt: true,
          description: "Close tab",
          handler: closeTabHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      // Shift-produced Plus (US layout) and unshifted/numpad Plus and Minus
      simulateKeyPress("+", { altKey: true, shiftKey: true });
      simulateKeyPress("+", { altKey: true });
      simulateKeyPress("-", { altKey: true });
      expect(newTabHandler).toHaveBeenCalledTimes(2);
      expect(closeTabHandler).toHaveBeenCalledTimes(1);

      // Control+Plus/Minus must not match on Windows/Linux
      simulateKeyPress("+", { ctrlKey: true });
      simulateKeyPress("-", { ctrlKey: true });
      expect(newTabHandler).toHaveBeenCalledTimes(2);
      expect(closeTabHandler).toHaveBeenCalledTimes(1);
    });

    it("does not trigger Alt-only shortcuts on Windows AltGraph (Ctrl+Alt) text entry", () => {
      setApplePlatformForTesting(false);
      const altLetterHandler = vi.fn();
      const newTabHandler = vi.fn();
      const shortcuts: KeyboardShortcut[] = [
        {
          ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WORD_WRAP,
          handler: altLetterHandler,
        },
        {
          id: "new-tab",
          keys: "+",
          alt: true,
          macControlForAlt: true,
          description: "New tab",
          handler: newTabHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      // German layout AltGraph + "+" produces "~", or AltGraph with Ctrl+Alt on any key
      simulateKeyPress("z", { ctrlKey: true, altKey: true });
      simulateKeyPress("+", { ctrlKey: true, altKey: true });
      simulateKeyPress("~", { ctrlKey: true, altKey: true });

      expect(altLetterHandler).not.toHaveBeenCalled();
      expect(newTabHandler).not.toHaveBeenCalled();
    });

    it.each([false, true])("ignores events with isComposing on all platforms (isApple: %s)", (isApple) => {
      setApplePlatformForTesting(isApple);
      const shortcuts: KeyboardShortcut[] = [
        {
          id: "escape",
          keys: "Escape",
          description: "Close",
          allowInInput: true,
          handler: mockHandler,
        },
        {
          id: "plain-key",
          keys: "a",
          description: "Plain key",
          handler: mockHandler,
        },
      ];

      renderHook(() => useKeyboardShortcuts({ shortcuts }));

      const escapeEvent = simulateKeyPress("Escape", { isComposing: true });
      const letterEvent = simulateKeyPress("a", { isComposing: true });

      expect(mockHandler).not.toHaveBeenCalled();
      expect(escapeEvent.defaultPrevented).toBe(false);
      expect(letterEvent.defaultPrevented).toBe(false);
    });
  });
});

describe("formatShortcut", () => {
  beforeEach(() => {
    setApplePlatformForTesting(false);
  });

  afterEach(() => {
    setApplePlatformForTesting(null);
  });

  it("should format single key", () => {
    const shortcut: KeyboardShortcut = {
      id: "test",
      keys: "a",
      description: "Test",
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("a");
  });

  it("should format array of keys with slash separator", () => {
    const shortcut: KeyboardShortcut = {
      id: "test",
      keys: ["a", "b"],
      description: "Test",
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("a / b");
  });

  it("should include Ctrl modifier", () => {
    const shortcut: KeyboardShortcut = {
      id: "save",
      keys: "s",
      description: "Save",
      ctrl: true,
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("Ctrl+s");
  });

  it("should include Shift modifier", () => {
    const shortcut: KeyboardShortcut = {
      id: "rotate",
      keys: "R",
      description: "Rotate",
      shift: true,
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("Shift+R");
  });

  it("should include Alt modifier", () => {
    const shortcut: KeyboardShortcut = {
      id: "menu",
      keys: "F",
      description: "Menu",
      alt: true,
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("Alt+F");
  });

  it("should include multiple modifiers", () => {
    const shortcut: KeyboardShortcut = {
      id: "redo",
      keys: "z",
      description: "Redo",
      ctrl: true,
      shift: true,
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("Ctrl+Shift+z");
  });

  it("should use custom label if provided", () => {
    const shortcut: KeyboardShortcut = {
      id: "save",
      keys: "s",
      description: "Save",
      label: "Ctrl+S",
      ctrl: true,
      handler: vi.fn(),
    };

    expect(formatShortcut(shortcut)).toBe("Ctrl+S");
  });

  it("should format special keys", () => {
    const shortcuts = [
      { keys: "ArrowRight", expected: "Right" },
      { keys: "ArrowLeft", expected: "Left" },
      { keys: "ArrowUp", expected: "Up" },
      { keys: "ArrowDown", expected: "Down" },
      { keys: "PageDown", expected: "Page Down" },
      { keys: "PageUp", expected: "Page Up" },
      { keys: "Escape", expected: "Esc" },
    ];

    for (const { keys, expected } of shortcuts) {
      const shortcut: KeyboardShortcut = {
        id: "test",
        keys,
        description: "Test",
        handler: vi.fn(),
      };
      expect(formatShortcut(shortcut)).toBe(expected);
    }
  });

  it("formats case alternatives as one upper-case letter and Plus/Minus as words", () => {
    expect(formatShortcut({ keys: ["c", "C"], alt: true })).toBe("Alt+C");
    expect(formatShortcut({ keys: "+", alt: true, macControlForAlt: true })).toBe("Alt+Plus");
    expect(formatShortcut({ keys: "-", alt: true, macControlForAlt: true })).toBe("Alt+Minus");
  });

  it("preserves Windows/Linux labels and generates Option/Control labels on macOS", () => {
    const affectedShortcuts = [
      { shortcut: CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_CASE_SENSITIVE, nonApple: "Alt+C", apple: "Option+C" },
      { shortcut: CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WHOLE_WORD, nonApple: "Alt+W", apple: "Option+W" },
      { shortcut: CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_REGULAR_EXPRESSION, nonApple: "Alt+R", apple: "Option+R" },
      { shortcut: CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WORD_WRAP, nonApple: "Alt+Z", apple: "Option+Z" },
      { shortcut: MARKDOWN_EDITOR_SHORTCUTS.INSERT_TABLE, nonApple: "Ctrl+Alt+T", apple: "Ctrl+Option+T" },
      { shortcut: MARKDOWN_EDITOR_SHORTCUTS.INSERT_THEMATIC_BREAK, nonApple: "Ctrl+Alt+H", apple: "Ctrl+Option+H" },
      { shortcut: BROWSER_SHORTCUTS.OPEN_LOCATION_IN_NEW_TAB, nonApple: "Ctrl+Alt+T", apple: "Ctrl+Option+T" },
      { shortcut: { keys: "+", alt: true, macControlForAlt: true }, nonApple: "Alt+Plus", apple: "Control+Plus" },
      { shortcut: { keys: "-", alt: true, macControlForAlt: true }, nonApple: "Alt+Minus", apple: "Control+Minus" },
    ];

    setApplePlatformForTesting(false);
    for (const { shortcut, nonApple } of affectedShortcuts) {
      expect(formatShortcut(shortcut)).toBe(nonApple);
    }

    setApplePlatformForTesting(true);
    for (const { shortcut, apple } of affectedShortcuts) {
      expect(formatShortcut(shortcut)).toBe(apple);
    }
  });
});

describe("withShortcut", () => {
  it("should combine description with formatted shortcut", () => {
    const shortcut = {
      id: "save",
      keys: "s",
      description: "Save",
      ctrl: true,
    };

    expect(withShortcut(shortcut)).toBe("Save (Ctrl+s)");
  });

  it("should work with custom label", () => {
    const shortcut = {
      id: "save",
      keys: "s",
      description: "Save document",
      label: "Ctrl+S",
      ctrl: true,
    };

    expect(withShortcut(shortcut)).toBe("Save document (Ctrl+S)");
  });
});
