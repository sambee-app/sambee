import { createTheme, getContrastRatio } from "@mui/material/styles";
import { blend, decomposeColor } from "@mui/system/colorManipulator";
import { describe, expect, it } from "vitest";
import builtInThemeIds from "../../../../shared/built_in_theme_ids.json";
import { requireTestValue } from "../../test/helpers/assertions";
import { getSearchHighlightColors } from "../commonStyles";
import { resolveThemePalette } from "../palette";
import { builtInThemes, getDefaultTheme, getThemeById } from "../themes";

//
// themes.test.ts
//

describe("Theme System - themes.ts", () => {
  it.each(builtInThemes)("keeps all $id syntax roles readable on viewer and code backgrounds", (definition) => {
    const document = definition.components!.markdownViewer!;
    for (const foreground of Object.values(definition.components!.syntax!)) {
      for (const background of [document.viewerBackground, document.document!.blockBackground]) {
        expect(getContrastRatio(foreground, background)).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  it.each(builtInThemes)("keeps $id search text readable on viewer and code backgrounds", (definition) => {
    const theme = createTheme({ palette: { mode: definition.mode } });
    const document = definition.components!.markdownViewer!;
    const highlights = getSearchHighlightColors(theme, definition);
    for (const overlay of Object.values(highlights)) {
      const opacity = Number(decomposeColor(overlay).values[3]);
      for (const [foreground, background] of [
        [document.viewerText, document.viewerBackground],
        [document.document!.codeText, document.document!.blockBackground],
      ]) {
        expect(
          getContrastRatio(requireTestValue(foreground), blend(requireTestValue(background), overlay, opacity))
        ).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  describe("builtInThemes", () => {
    it("should have at least 2 built-in themes", () => {
      expect(builtInThemes.length).toBeGreaterThanOrEqual(2);
    });

    it("should have sambee-light as first theme", () => {
      expect(builtInThemes[0]!.id).toBe("sambee-light");
      expect(builtInThemes[0]!.mode).toBe("light");
    });

    it("should have sambee-dark as second theme", () => {
      expect(builtInThemes[1]!.id).toBe("sambee-dark");
      expect(builtInThemes[1]!.mode).toBe("dark");
    });

    it("should have unique IDs for all themes", () => {
      const ids = builtInThemes.map((t) => t.id);
      const uniqueIds = new Set(ids);
      expect(uniqueIds.size).toBe(ids.length);
    });

    it("matches the backend built-in theme ID manifest", () => {
      expect([...builtInThemes.map((theme) => theme.id)].sort()).toEqual([...builtInThemeIds].sort());
    });

    it("should have valid theme structure", () => {
      builtInThemes.forEach((theme) => {
        expect(theme).toHaveProperty("id");
        expect(theme).toHaveProperty("name");
        expect(theme).toHaveProperty("mode");
        expect(theme).toHaveProperty("primary");
        expect(theme.primary).toHaveProperty("main");
        expect(["light", "dark"]).toContain(theme.mode);
      });
    });

    it("should have non-empty names", () => {
      builtInThemes.forEach((theme) => {
        expect(theme.name.length).toBeGreaterThan(0);
      });
    });

    it("should have valid hex colors for primary.main", () => {
      const hexColorRegex = /^#[0-9A-F]{6}$/i;
      builtInThemes.forEach((theme) => {
        expect(theme.primary.main).toMatch(hexColorRegex);
      });
    });
  });

  describe("getThemeById", () => {
    it("should return sambee-light theme by ID", () => {
      const theme = getThemeById("sambee-light");
      expect(theme).toBeDefined();
      expect(theme?.id).toBe("sambee-light");
    });

    it("should return sambee-dark theme by ID", () => {
      const theme = getThemeById("sambee-dark");
      expect(theme).toBeDefined();
      expect(theme?.id).toBe("sambee-dark");
    });

    it("should return undefined for non-existent theme", () => {
      const theme = getThemeById("non-existent-theme");
      expect(theme).toBeUndefined();
    });

    it("should return undefined for empty string", () => {
      const theme = getThemeById("");
      expect(theme).toBeUndefined();
    });
  });

  describe("getDefaultTheme", () => {
    it("should return sambee-light when called without arguments", () => {
      const theme = getDefaultTheme();
      expect(theme.id).toBe("sambee-light");
      expect(theme.mode).toBe("light");
    });

    it("should return sambee-light when called with 'light'", () => {
      const theme = getDefaultTheme("light");
      expect(theme.id).toBe("sambee-light");
      expect(theme.mode).toBe("light");
    });

    it("should return sambee-dark when called with 'dark'", () => {
      const theme = getDefaultTheme("dark");
      expect(theme.id).toBe("sambee-dark");
      expect(theme.mode).toBe("dark");
    });

    it("should return a valid theme structure", () => {
      const theme = getDefaultTheme();
      expect(theme).toHaveProperty("id");
      expect(theme).toHaveProperty("name");
      expect(theme).toHaveProperty("mode");
      expect(theme).toHaveProperty("primary");
    });
  });

  describe("Theme color consistency", () => {
    it("sambee-dark should use a subdued primary control color", () => {
      const darkTheme = getThemeById("sambee-dark");
      expect(darkTheme?.primary.main).toBe("#D4A020");
      expect(darkTheme?.primary.light).toBe("#F4C430");
      expect(darkTheme?.primary.dark).toBe("#B8860B");
    });

    it("sambee-light should use golden yellow as primary", () => {
      const theme = getThemeById("sambee-light");
      expect(theme?.primary.main).toBe("#F4C430");
    });

    it("sambee-dark should reserve golden yellow for high-emphasis states", () => {
      const theme = getThemeById("sambee-dark");
      expect(theme?.primary.main).not.toBe(theme?.primary.light);
      expect(theme?.primary.light).toBe("#F4C430");
    });

    it("sambee-light should have action colors defined", () => {
      const theme = getThemeById("sambee-light");
      expect(theme?.action).toBeDefined();
      expect(theme?.action?.selected).toBeDefined();
    });

    it("sambee-dark should have action colors defined", () => {
      const theme = getThemeById("sambee-dark");
      expect(theme?.action).toBeDefined();
      expect(theme?.action?.selected).toBeDefined();
    });

    it("sambee themes should use selection colors matched to their primary roles", () => {
      const lightTheme = getThemeById("sambee-light");
      const darkTheme = getThemeById("sambee-dark");
      expect(lightTheme?.action?.selected).toBe("#F4C43029");
      expect(darkTheme?.action?.selected).toBe("#D4A02038");
    });

    it("derives focus from primary text for both built-in and custom themes", () => {
      const lightTheme = getDefaultTheme("light");
      const darkTheme = getDefaultTheme("dark");
      expect(resolveThemePalette(lightTheme).action.focus).toBe("rgba(31, 38, 43, 0.57)");
      expect(resolveThemePalette(darkTheme).action.focus).toBe("rgba(246, 241, 232, 0.94)");

      const customTheme = {
        ...lightTheme,
        text: { ...lightTheme.text, primary: "#123456" },
        action: { ...lightTheme.action, focus: "#FF0000" },
      };
      expect(resolveThemePalette(customTheme).action.focus).toBe("rgba(18, 52, 86, 0.57)");
    });
  });
});
