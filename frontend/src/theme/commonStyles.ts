import type { SxProps, Theme } from "@mui/material";
import { alpha } from "@mui/material";
import type { ThemeConfig } from "./types";

/**
 * Common reusable style patterns for consistent UI
 */

/** Focus ring width to match FOCUS_OUTLINE_WIDTH_PX from theme constants */
const FOCUS_RING_WIDTH = 3;
const CONTAINED_BUTTON_FOCUS_INNER_RING_WIDTH = 1;
const SEARCH_HIGHLIGHT_OPACITY = {
  light: { other: 0.3, current: 0.36 },
  dark: { other: 0.4, current: 0.44 },
};

export function getControlAccentColor(theme: Theme): string {
  return theme.palette.mode === "dark" ? theme.palette.primary.main : (theme.palette.primary.dark ?? theme.palette.primary.main);
}

export function getFocusAccentColor(theme: Theme): string {
  return theme.palette.action.focus ?? getControlAccentColor(theme);
}

export function getElevatedButtonFocusRing(theme: Theme, color?: "warning" | "error"): string {
  const focusColor = color ? theme.palette[color].main : getFocusAccentColor(theme);
  const ringColor = alpha(focusColor, theme.palette.mode === "dark" ? 0.38 : 0.24);

  return `0 0 0 ${FOCUS_RING_WIDTH}px ${ringColor}`;
}

export function getContainedButtonFocusVisibleBoxShadow(theme: Theme, shadowIndex = 3): string {
  return `${theme.shadows[shadowIndex]}, 0 0 0 ${CONTAINED_BUTTON_FOCUS_INNER_RING_WIDTH}px ${getFocusAccentColor(theme)}`;
}

export function getPillButtonFocusVisibleBoxShadow(theme: Theme): string {
  return `0 0 0 ${FOCUS_RING_WIDTH - 1}px ${getFocusAccentColor(theme)}`;
}

export interface SecondaryToolbarSurfaceColors {
  stripBackground: string;
  popupBackground: string;
  textColor: string;
  borderColor: string;
  pillBackground: string;
  groupedBackground: string;
  activeBackground: string;
  hoverBackground: string;
  separatorColor: string;
  shadow: string;
}

export interface SearchHighlightColors {
  currentMatch: string;
  otherMatches: string;
}

export function getSecondaryToolbarSelectedBackground(theme: Theme, themeConfig?: ThemeConfig): string {
  return (
    themeConfig?.components?.markdownViewer?.secondaryToolbarSelected ??
    themeConfig?.action?.selectedDarker ??
    themeConfig?.action?.selected ??
    theme.palette.action.selected
  );
}

export function getSearchHighlightColors(theme: Theme, themeConfig?: ThemeConfig): SearchHighlightColors {
  const otherMatchesBase =
    themeConfig?.components?.search?.otherMatch ?? theme.palette.warning.main ?? theme.palette.primary.dark ?? theme.palette.primary.main;
  const currentMatchBase = themeConfig?.components?.search?.currentMatch ?? theme.palette.info.main ?? theme.palette.primary.main;
  const opacity = SEARCH_HIGHLIGHT_OPACITY[theme.palette.mode];

  return {
    otherMatches: alpha(otherMatchesBase, opacity.other),
    currentMatch: alpha(currentMatchBase, opacity.current),
  };
}

export function getSecondaryToolbarSurfaceColors(
  theme: Theme,
  overrides?: Partial<Pick<SecondaryToolbarSurfaceColors, "pillBackground" | "activeBackground" | "hoverBackground">>
): SecondaryToolbarSurfaceColors {
  const textColor = theme.palette.text.secondary;
  const pillBackground = overrides?.pillBackground ?? theme.palette.action.selected;
  const activeBackground = overrides?.activeBackground ?? overrides?.pillBackground ?? alpha(textColor, 0.12);
  const hoverBackground = overrides?.hoverBackground ?? activeBackground;

  return {
    stripBackground: theme.palette.background.default,
    popupBackground: theme.palette.background.default,
    textColor,
    borderColor: theme.palette.divider,
    pillBackground,
    groupedBackground: alpha(textColor, 0.06),
    activeBackground,
    hoverBackground,
    separatorColor: alpha(textColor, 0.06),
    shadow: theme.shadows[2],
  };
}

export function getSecondaryActionStripStyle(theme: Theme) {
  const colors = getSecondaryToolbarSurfaceColors(theme);

  return {
    px: 2,
    py: 0.5,
    bgcolor: colors.stripBackground,
    color: colors.textColor,
    borderBottom: 1,
    borderColor: colors.borderColor,
    boxShadow: theme.shadows[2],
    position: "relative",
    zIndex: 1,
  };
}

export const secondaryActionStripSx = ((theme: Theme) => getSecondaryActionStripStyle(theme)) satisfies SxProps<Theme>;

export function getSecondaryToolbarMenuPaperStyle(theme: Theme) {
  const colors = getSecondaryToolbarSurfaceColors(theme);

  return {
    bgcolor: colors.popupBackground,
    color: colors.textColor,
    border: 1,
    borderColor: colors.borderColor,
    boxShadow: colors.shadow,
  };
}

export const secondaryToolbarMenuPaperSx: SxProps<Theme> = (theme) => getSecondaryToolbarMenuPaperStyle(theme);

/**
 * pillButtonStyle
 *
 * Pill-style button with subtle border and background.
 * Used for control buttons like selectors, menus, and toggles.
 * Provides clear visual affordance while maintaining a flat, elegant aesthetic.
 *
 * On focus, transforms the border to the focus color with increased visual weight
 * using box-shadow (avoids layout shift from changing border width).
 */
export const pillButtonStyle: SxProps<Theme> = {
  border: 1,
  borderColor: (theme) => getSecondaryToolbarSurfaceColors(theme).borderColor,
  borderRadius: 3,
  bgcolor: (theme) => getSecondaryToolbarSurfaceColors(theme).pillBackground,
  color: (theme) => getSecondaryToolbarSurfaceColors(theme).textColor,
  minHeight: 44,
  px: 2,
  whiteSpace: "nowrap",
  flexShrink: 0,
  textTransform: "none",
  "&:focus": {
    outline: "none",
  },
  "&:hover": {
    bgcolor: (theme) => getSecondaryToolbarSurfaceColors(theme).pillBackground,
  },
  "&&.Mui-focusVisible": {
    outline: "none",
    bgcolor: (theme) => getSecondaryToolbarSurfaceColors(theme).pillBackground,
    borderColor: "primary.main",
    boxShadow: (theme) => getPillButtonFocusVisibleBoxShadow(theme),
  },
};

export const secondaryStripButtonSx: SxProps<Theme> = {
  ...pillButtonStyle,
  minHeight: 28,
  minWidth: 0,
  px: 2,
  py: 0.5,
  borderRadius: 2,
};

export const secondaryStripButtonContentSx: SxProps<Theme> = {
  display: "flex",
  alignItems: "center",
  gap: 0.5,
};

export const secondaryStripButtonLabelSx: SxProps<Theme> = {
  fontSize: "0.875rem",
  fontWeight: 500,
  lineHeight: 1,
};

export const secondaryStripButtonIconSx: SxProps<Theme> = {
  display: "flex",
  fontSize: "1.25rem",
};

export const toolbarIconButtonSx: SxProps<Theme> = {
  minWidth: 44,
  minHeight: 44,
  "&:focus": {
    outline: "none",
  },
  "&.Mui-focusVisible": {
    outline: "none",
    boxShadow: (theme) => getPillButtonFocusVisibleBoxShadow(theme),
  },
  "& .MuiSvgIcon-root": {
    fontSize: "1.5rem",
  },
};

export const fileOperationsToolbarSx: SxProps<Theme> = (theme) => ({
  px: 0.5,
  height: 44,
  boxSizing: "border-box",
  display: "flex",
  alignItems: "center",
  borderTop: 1,
  borderColor: theme.palette.divider,
  bgcolor: theme.palette.background.default,
});

export const fileOperationsToolbarButtonSx: SxProps<Theme> = {
  minHeight: 36,
  minWidth: 0,
  px: 1.5,
  flexShrink: 0,
  color: (theme) => theme.palette.text.secondary,
  textTransform: "none",
  whiteSpace: "nowrap",
  "&:hover": {
    bgcolor: (theme) => theme.palette.action.selected,
  },
  "&.Mui-disabled": {
    color: (theme) => theme.palette.action.disabled,
  },
};

export const fileOperationsToolbarOverflowButtonSx: SxProps<Theme> = {
  minWidth: 44,
  minHeight: 36,
  p: 1,
  flexShrink: 0,
  color: (theme) => theme.palette.text.secondary,
  "&:hover": {
    bgcolor: (theme) => theme.palette.action.selected,
  },
  "&.Mui-disabled": {
    color: (theme) => theme.palette.action.disabled,
  },
};
