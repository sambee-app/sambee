import { alpha, decomposeColor, getContrastRatio, type Palette } from "@mui/material";
import { getDefaultTheme } from "./themes";
import type { ThemeConfig } from "./types";

const MIN_ICON_CONTRAST = 3;
const CONTRAST_BLEND_STEPS = 20;
const STATUS_ALERT_ROLES = { unknown: "info", warning: "warning", error: "error" } as const;

interface HealthIndicatorPaint {
  background: string;
  hoverBackground: string;
  foreground: string;
}

export type HealthIndicatorColors = Record<keyof typeof STATUS_ALERT_ROLES, HealthIndicatorPaint>;

/** Mix opaque RGB colors, or composite a translucent foreground over an opaque background. */
function blend(foreground: string, background: string, weight?: number): string {
  const { values: fg } = decomposeColor(foreground);
  const { values: bg } = decomposeColor(background);
  const opacity = weight ?? fg[3] ?? 1;
  return `rgb(${bg
    .slice(0, 3)
    .map((channel, i) => Math.round(channel + ((fg[i] ?? channel) - channel) * opacity))
    .join(", ")})`;
}

export function resolveHealthIndicatorColors(config: ThemeConfig, palette: Palette): HealthIndicatorColors {
  const toolbar = palette.appBar;
  const canvas = blend(palette.background.default, palette.common.white);
  const background = blend(toolbar?.background ?? palette.primary.main, canvas);
  const hoverOverlay = alpha(palette.action.active, palette.action.hoverOpacity);
  const buttonContrast = (color: string) =>
    Math.min(getContrastRatio(color, background), getContrastRatio(blend(hoverOverlay, color), background));
  const { black, white } = palette.common;
  // Choose the endpoint that gives the status fill the most contrast against the toolbar.
  const contrastTarget = buttonContrast(black) > buttonContrast(white) ? black : white;
  const defaults = getDefaultTheme(palette.mode).components?.alert;

  const resolve = (role: (typeof STATUS_ALERT_ROLES)[keyof typeof STATUS_ALERT_ROLES]): HealthIndicatorPaint => {
    const alert = config.components?.alert?.[role] ?? defaults?.[role];
    const seed = blend((palette.mode === "dark" ? alert?.icon : alert?.text) ?? palette[role].main, background);
    let fill = seed;
    for (let step = 1; step <= CONTRAST_BLEND_STEPS && buttonContrast(fill) < MIN_ICON_CONTRAST; step++) {
      fill = blend(contrastTarget, seed, step / CONTRAST_BLEND_STEPS);
    }

    const hoverBackground = blend(hoverOverlay, fill);
    const iconContrast = (color: string) => Math.min(getContrastRatio(color, fill), getContrastRatio(color, hoverBackground));
    return { background: fill, hoverBackground, foreground: iconContrast(black) > iconContrast(white) ? black : white };
  };

  return {
    unknown: resolve(STATUS_ALERT_ROLES.unknown),
    warning: resolve(STATUS_ALERT_ROLES.warning),
    error: resolve(STATUS_ALERT_ROLES.error),
  };
}
