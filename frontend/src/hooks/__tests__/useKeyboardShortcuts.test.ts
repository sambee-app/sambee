import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { requireTestValue } from "../../test/helpers/assertions";
import type { KeyboardShortcut } from "../useKeyboardShortcuts";
import { formatShortcut, useKeyboardShortcuts, withShortcut } from "../useKeyboardShortcuts";

describe("useKeyboardShortcuts", () => {
  let mockHandler: (event?: KeyboardEvent) => void;

  beforeEach(() => {
    mockHandler = vi.fn();
    vi.clearAllMocks();
  });

  afterEach(() => {
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
    }
  ) => {
    const event = new KeyboardEvent("keydown", {
      key,
      ctrlKey: modifiers?.ctrlKey ?? false,
      shiftKey: modifiers?.shiftKey ?? false,
      altKey: modifiers?.altKey ?? false,
      metaKey: modifiers?.metaKey ?? false,
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
});

describe("formatShortcut", () => {
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
