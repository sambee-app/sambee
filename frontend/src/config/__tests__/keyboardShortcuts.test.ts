import { describe, expect, it } from "vitest";
import { BROWSER_SHORTCUTS, COMMON_SHORTCUTS, COPY_MOVE_SHORTCUTS, PANE_SHORTCUTS, VIEWER_SHORTCUTS } from "../keyboardShortcuts";

describe("Keyboard Shortcuts Configuration", () => {
  describe("COMMON_SHORTCUTS", () => {
    it("should have all required fields", () => {
      for (const [key, shortcut] of Object.entries(COMMON_SHORTCUTS)) {
        expect(shortcut.id, `${key} missing id`).toBeDefined();
        expect(shortcut.keys, `${key} missing keys`).toBeDefined();
        expect(shortcut.description, `${key} missing description`).toBeDefined();
        expect(shortcut.label, `${key} missing label`).toBeDefined();
        expect(shortcut.helpGroup, `${key} missing helpGroup`).toBeDefined();
      }
    });

    it("should have unique IDs", () => {
      const ids = Object.values(COMMON_SHORTCUTS).map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should have valid key values", () => {
      const validKeys = [
        "Enter",
        "Escape",
        "d",
        "e",
        "s",
        "S",
        "r",
        "R",
        "f",
        "F3",
        "Home",
        "End",
        "PageDown",
        "PageUp",
        "ArrowRight",
        "ArrowLeft",
      ];

      for (const shortcut of Object.values(COMMON_SHORTCUTS)) {
        const keys = Array.isArray(shortcut.keys) ? shortcut.keys : [shortcut.keys];
        for (const key of keys) {
          expect(validKeys.includes(key), `Invalid key: ${key} in shortcut ${shortcut.id}`).toBe(true);
        }
      }
    });
  });

  describe("VIEWER_SHORTCUTS", () => {
    it("should have all required fields", () => {
      for (const [key, shortcut] of Object.entries(VIEWER_SHORTCUTS)) {
        expect(shortcut.id, `${key} missing id`).toBeDefined();
        expect(shortcut.keys, `${key} missing keys`).toBeDefined();
        expect(shortcut.description, `${key} missing description`).toBeDefined();
        expect(shortcut.label, `${key} missing label`).toBeDefined();
        expect(shortcut.helpGroup, `${key} missing helpGroup`).toBeDefined();
      }
    });

    it("should have unique IDs", () => {
      const ids = Object.values(VIEWER_SHORTCUTS).map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });
  });

  describe("BROWSER_SHORTCUTS", () => {
    it("should have all required fields", () => {
      for (const [key, shortcut] of Object.entries(BROWSER_SHORTCUTS)) {
        expect(shortcut.id, `${key} missing id`).toBeDefined();
        expect(shortcut.keys, `${key} missing keys`).toBeDefined();
        expect(shortcut.description, `${key} missing description`).toBeDefined();
        expect(shortcut.label, `${key} missing label`).toBeDefined();
        expect(shortcut.helpGroup, `${key} missing helpGroup`).toBeDefined();
      }
    });

    it("should have unique IDs", () => {
      const ids = Object.values(BROWSER_SHORTCUTS).map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should require ctrl modifier for connection selector focus", () => {
      expect(BROWSER_SHORTCUTS.FOCUS_CONNECTION_SELECTOR.ctrl).toBe(true);
      expect(BROWSER_SHORTCUTS.FOCUS_CONNECTION_SELECTOR.keys).toBe("ArrowDown");
      expect(BROWSER_SHORTCUTS.FOCUS_CONNECTION_SELECTOR.allowInInputWithin).toBe('[data-quick-bar-input="true"]');
    });

    it("registers upload and download as file actions", () => {
      expect(BROWSER_SHORTCUTS.UPLOAD).toMatchObject({ keys: "u", ctrl: true, label: "Ctrl+U", helpGroup: "fileActions" });
      expect(BROWSER_SHORTCUTS.DOWNLOAD).toMatchObject({ keys: "d", ctrl: true, label: "Ctrl+D", helpGroup: "fileActions" });
    });
  });

  describe("PANE_SHORTCUTS", () => {
    it("should have all required fields", () => {
      for (const [key, shortcut] of Object.entries(PANE_SHORTCUTS)) {
        expect(shortcut.id, `${key} missing id`).toBeDefined();
        expect(shortcut.keys, `${key} missing keys`).toBeDefined();
        expect(shortcut.description, `${key} missing description`).toBeDefined();
        expect(shortcut.label, `${key} missing label`).toBeDefined();
        expect(shortcut.helpGroup, `${key} missing helpGroup`).toBeDefined();
      }
    });

    it("should have unique IDs", () => {
      const ids = Object.values(PANE_SHORTCUTS).map((s) => s.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("should require ctrl modifier for pane focus shortcuts", () => {
      expect(PANE_SHORTCUTS.TOGGLE_DUAL_PANE.ctrl).toBe(true);
      expect(PANE_SHORTCUTS.FOCUS_LEFT_PANE.ctrl).toBe(true);
      expect(PANE_SHORTCUTS.FOCUS_RIGHT_PANE.ctrl).toBe(true);
    });

    it("should not require ctrl for tab pane switch", () => {
      expect(PANE_SHORTCUTS.SWITCH_PANE).not.toHaveProperty("ctrl");
    });
  });

  describe("COPY_MOVE_SHORTCUTS", () => {
    it("groups dual-pane copy and move under file actions", () => {
      expect(COPY_MOVE_SHORTCUTS.COPY_TO_OTHER_PANE.helpGroup).toBe("fileActions");
      expect(COPY_MOVE_SHORTCUTS.MOVE_TO_OTHER_PANE.helpGroup).toBe("fileActions");
      expect(COPY_MOVE_SHORTCUTS.COPY_TO_OTHER_PANE.description).toContain("two-pane mode");
      expect(COPY_MOVE_SHORTCUTS.MOVE_TO_OTHER_PANE.description).toContain("two-pane mode");
    });
  });

  describe("Global ID Uniqueness", () => {
    it("should have no duplicate IDs across all categories", () => {
      const allIds = [
        ...Object.values(COMMON_SHORTCUTS).map((s) => s.id),
        ...Object.values(VIEWER_SHORTCUTS).map((s) => s.id),
        ...Object.values(BROWSER_SHORTCUTS).map((s) => s.id),
        ...Object.values(PANE_SHORTCUTS).map((s) => s.id),
      ];

      const uniqueIds = new Set(allIds);
      expect(uniqueIds.size).toBe(allIds.length);
    });
  });
});
