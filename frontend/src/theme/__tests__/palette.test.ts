import { createTheme, getContrastRatio } from "@mui/material/styles";
import { describe, expect, it } from "vitest";
import { resolveHealthIndicatorColors } from "../healthIndicatorColors";
import { getOverlaySurfaceTokens, resolveThemePalette } from "../palette";
import { getDefaultTheme } from "../themes";

describe("getOverlaySurfaceTokens", () => {
  it("derives dark dialog layers from the shared chrome surface", () => {
    expect(getOverlaySurfaceTokens("#1F262B", "dark")).toEqual({
      backdrop: "rgba(31, 38, 43, 0.92)",
      paper: "#382c0a",
      form: "color-mix(in srgb, black 12%, #382c0a)",
    });
  });

  it("preserves the supplied background for light dialog papers", () => {
    expect(getOverlaySurfaceTokens("#FBF9F4", "light")).toMatchObject({
      backdrop: undefined,
      paper: "#FBF9F4",
    });
  });
});

describe("resolveHealthIndicatorColors", () => {
  it.each([
    ["light", "#F4C430"],
    ["dark", "#382C0A"],
  ] as const)("keeps the built-in %s fills distinct and readable on hover", (mode, bar) => {
    const config = getDefaultTheme(mode);
    const palette = createTheme({ palette: { mode, ...resolveThemePalette(config) } }).palette;
    const colors = Object.values(resolveHealthIndicatorColors(config, palette));
    expect(new Set(colors.map(({ background }) => background)).size).toBe(3);
    for (const { background, hoverBackground, foreground } of colors) {
      expect(hoverBackground).not.toBe(background);
      for (const fill of [background, hoverBackground]) {
        expect(getContrastRatio(fill, bar)).toBeGreaterThanOrEqual(3);
        expect(getContrastRatio(foreground, fill)).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("corrects a custom fill that matches the toolbar and chooses a readable neutral icon", () => {
    const config = getDefaultTheme("dark");
    const bar = "#382C0A";
    const palette = createTheme({
      palette: { mode: "dark", appBar: { background: bar, text: "#574619" } },
    }).palette;
    const alert = config.components?.alert;
    if (!alert) throw new Error("Expected built-in dark alert colors");
    const colors = resolveHealthIndicatorColors(
      { ...config, components: { ...config.components, alert: { ...alert, warning: { ...alert.warning, icon: bar } } } },
      palette
    );
    const { background, hoverBackground, foreground } = colors.warning;
    for (const fill of [background, hoverBackground]) {
      expect(getContrastRatio(fill, bar)).toBeGreaterThanOrEqual(3);
      expect(getContrastRatio(foreground, fill)).toBeGreaterThanOrEqual(3);
    }
  });
});
