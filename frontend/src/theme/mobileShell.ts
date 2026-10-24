import type { SxProps, Theme } from "@mui/material";
import { COMPACT_LAYOUT_SIZE, TOOLBAR_HEIGHT } from "./constants";

export const SAFE_AREA_INSET = {
  TOP: "env(safe-area-inset-top, 0px)",
  RIGHT: "env(safe-area-inset-right, 0px)",
  BOTTOM: "env(safe-area-inset-bottom, 0px)",
  LEFT: "env(safe-area-inset-left, 0px)",
} as const;

export const MOBILE_VIEWPORT_HEIGHT = "100dvh";

/**
 * Full-screen mobile shell that locks route-level chrome to the visual viewport.
 * This prevents iOS Safari and Chrome mobile browser UI changes from dragging
 * the entire app surface under hardware cutouts or browser chrome.
 */
export function getMobileViewportShellSx(lockToViewport = false) {
  return {
    display: "flex",
    flexDirection: "column",
    minHeight: { xs: MOBILE_VIEWPORT_HEIGHT, sm: "100vh" },
    height: { xs: MOBILE_VIEWPORT_HEIGHT, sm: "100vh" },
    width: "100%",
    minWidth: 0,
    overflow: "hidden",
    bgcolor: "background.default",
    overscrollBehaviorY: "none",
    ...(lockToViewport
      ? {
          position: { xs: "fixed", sm: "relative" },
          inset: { xs: 0 },
        }
      : {}),
  } satisfies SxProps<Theme>;
}

export const mobileSafeAreaAppBarSx: SxProps<Theme> = {
  flexShrink: 0,
  pt: { xs: SAFE_AREA_INSET.TOP, sm: 0 },
  pl: SAFE_AREA_INSET.LEFT,
  pr: SAFE_AREA_INSET.RIGHT,
  overscrollBehaviorY: "none",
};

export const mobileSafeAreaToolbarSx: SxProps<Theme> = {
  px: { xs: 1, sm: 2 },
  minHeight: {
    xs: `${TOOLBAR_HEIGHT.MOBILE_PX}px`,
    sm: `${TOOLBAR_HEIGHT.DESKTOP_PX}px`,
  },
};

export const mobileScrollableContentSx: SxProps<Theme> = {
  flex: 1,
  minHeight: 0,
  overflow: "auto",
  overscrollBehaviorY: "contain",
  WebkitOverflowScrolling: "touch",
};

export const mobileFullscreenDrawerPaperSx = {
  width: "100%",
  height: MOBILE_VIEWPORT_HEIGHT,
  maxHeight: MOBILE_VIEWPORT_HEIGHT,
  overflow: "hidden",
} satisfies SxProps<Theme>;

/** Compact typography policy for the main navigation drawer. */
export const mobileNavigationDrawerTypographySx = ((theme: Theme) => ({
  [theme.breakpoints.down("sm")]: {
    "& .MuiTypography-h6": {
      fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_TITLE_PX}px`,
    },
    "& .MuiListItemText-primary, & .MuiInputBase-input, & .MuiSelect-select": {
      fontSize: `${COMPACT_LAYOUT_SIZE.MENU_TEXT_PX}px`,
    },
  },
})) satisfies SxProps<Theme>;
