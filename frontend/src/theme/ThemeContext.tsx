import { alpha, createTheme, type Theme } from "@mui/material";
import { createContext, type ReactNode, useContext, useEffect, useMemo, useRef, useState } from "react";
import api, { type StoredTheme } from "../services/api";
import { authSession } from "../services/authSession";
import { refreshCurrentUserSettings, useCurrentUserSetting } from "../services/userSettingsStore";
import { COMPACT_LAYOUT_SIZE } from "./constants";
import {
  FORM_SURFACE_CSS_VARIABLE,
  getDarkChromeSurfaceColor,
  getOverlaySurfaceTokens,
  OVERLAY_SURFACE_CSS_VARIABLE,
  resolveThemePalette,
} from "./palette";
import { resolveSyntaxTheme } from "./resolveSyntaxTheme";
import { syntaxTokenStyles } from "./syntaxStyles";
import { builtInThemes, getDefaultTheme } from "./themes";
import type { ThemeConfig } from "./types";

//
// Theme context
//

// Styling constants
const FOCUS_OUTLINE_WIDTH_PX = 3;
const FOCUS_OUTLINE_OFFSET_PX = 0;
const SCROLLBAR_WIDTH_PX = 12;
const SCROLLBAR_THUMB_BORDER_RADIUS_PX = 8;
const SCROLLBAR_THUMB_MIN_HEIGHT_PX = 24;
const SCROLLBAR_THUMB_BORDER_PX = 3;
const POPUP_OVERLAY_Z_INDEX_OFFSET = 2;

interface ThemeContextValue {
  /** Current theme configuration */
  currentTheme: ThemeConfig;
  /** Material-UI theme object */
  muiTheme: Theme;
  /** All available themes */
  availableThemes: ThemeConfig[];
  storedThemes: StoredTheme[];
  siteDefaultId: string;
  isAdmin: boolean;
  refreshThemes: () => Promise<void>;
}

const ThemeContext = createContext<ThemeContextValue | undefined>(undefined);

//
// ThemeProvider
//

interface ThemeProviderProps {
  children: ReactNode;
}

/**
 * Theme provider that manages theme state and persistence
 */
export function SambeeThemeProvider({ children }: ThemeProviderProps) {
  const themeIdSetting = useCurrentUserSetting("appearance.theme_id");
  const [storedThemes, setStoredThemes] = useState<StoredTheme[]>([]);
  const [siteDefaultId, setSiteDefaultId] = useState(getDefaultTheme().id);
  const [isAdmin, setIsAdmin] = useState(false);
  const refreshSequence = useRef(0);
  const currentThemeId = themeIdSetting.confirmedValue ?? siteDefaultId;

  const refreshThemes = async () => {
    const sequence = ++refreshSequence.current;
    const epoch = authSession.getIdentity().epoch;
    const result = await api.getThemes();
    if (sequence !== refreshSequence.current || epoch !== authSession.getIdentity().epoch) return;
    setStoredThemes(result.themes);
    setSiteDefaultId(result.site_default_id);
    await refreshCurrentUserSettings();
  };

  useEffect(() => {
    let active = true;
    const refresh = () => {
      const sequence = ++refreshSequence.current;
      const epoch = authSession.getIdentity().epoch;
      void Promise.all([api.getThemes(), api.getCurrentUser()])
        .then(([result, user]) => {
          if (!active || sequence !== refreshSequence.current || epoch !== authSession.getIdentity().epoch) return;
          setStoredThemes(result.themes);
          setSiteDefaultId(result.site_default_id);
          setIsAdmin(user.role === "admin");
          void refreshCurrentUserSettings().catch(() => undefined);
        })
        .catch(() => undefined);
    };
    refresh();
    const onVisibility = () => {
      if (document.visibilityState === "visible") refresh();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", onVisibility);
    const unsubscribe = authSession.subscribeToIdentity(() => {
      refreshSequence.current += 1;
      setStoredThemes([]);
      setSiteDefaultId(getDefaultTheme().id);
      setIsAdmin(false);
      refresh();
    });
    return () => {
      active = false;
      unsubscribe();
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  // All available themes (built-in + custom)
  const availableThemes = useMemo(
    () => [...builtInThemes, ...storedThemes.map((stored) => resolveSyntaxTheme({ ...stored.definition, id: stored.id }))],
    [storedThemes]
  );

  // Current theme configuration
  const currentTheme = useMemo(
    () => availableThemes.find((theme) => theme.id === currentThemeId) ?? getDefaultTheme(),
    [availableThemes, currentThemeId]
  );

  // Material-UI theme object
  const muiTheme = useMemo(() => {
    const isDark = currentTheme.mode === "dark";
    const palette = resolveThemePalette(currentTheme);
    const { appBar, action, background, link, statusBar, text } = palette;
    const focusColor = action.focus;
    const dialogSurfaces = getOverlaySurfaceTokens(background.default, currentTheme.mode, currentTheme.background?.chrome);
    const menuBackground = isDark ? getDarkChromeSurfaceColor(currentTheme) : background.default;
    const alertColors = currentTheme.components?.alert;
    const getStandardAlertStyle = (severity: "info" | "success" | "warning" | "error") => {
      const alertColor = alertColors?.[severity];

      if (!alertColor) {
        return {};
      }

      return {
        "&&": {
          backgroundColor: alertColor.background,
          color: alertColor.text,
          "& .MuiAlert-icon": {
            color: alertColor.icon,
          },
        },
      };
    };

    // Scrollbar colors derived from theme
    const scrollbarThumb = alpha(text.primary, isDark ? 0.4 : 0.28);
    const scrollbarTrack = alpha(text.primary, isDark ? 0.12 : 0.08);

    const getButtonFocusOutline = (theme: Theme, color?: string) => {
      const outlineColor = color === "warning" ? theme.palette.warning.main : color === "error" ? theme.palette.error.main : focusColor;

      return {
        outline: `${FOCUS_OUTLINE_WIDTH_PX}px solid ${outlineColor}`,
        outlineOffset: `${FOCUS_OUTLINE_OFFSET_PX}px`,
      };
    };

    return createTheme({
      // Custom breakpoints: 768px is the mobile/desktop threshold
      breakpoints: {
        values: {
          xs: 0,
          sm: 768, // Mobile/desktop threshold (default: 600)
          md: 960,
          lg: 1280,
          xl: 1920,
        },
      },
      palette: {
        mode: currentTheme.mode,
        chrome: currentTheme.background?.chrome,
        primary: currentTheme.primary,
        background,
        text,
        action,
        appBar,
        statusBar,
        link,
        markdownDocument: currentTheme.components?.markdownViewer?.document,
        syntax: currentTheme.components?.syntax,
      },
      typography: {
        fontFamily: ["-apple-system", "BlinkMacSystemFont", '"Segoe UI"', "Roboto", '"Helvetica Neue"', "Arial", "sans-serif"].join(","),
      },
      components: {
        MuiCssBaseline: {
          styleOverrides: {
            ...syntaxTokenStyles,
            body: {
              scrollbarColor: `${scrollbarThumb} ${scrollbarTrack}`,
              "&::-webkit-scrollbar, & *::-webkit-scrollbar": {
                width: SCROLLBAR_WIDTH_PX,
                height: SCROLLBAR_WIDTH_PX,
              },
              "&::-webkit-scrollbar-thumb, & *::-webkit-scrollbar-thumb": {
                borderRadius: SCROLLBAR_THUMB_BORDER_RADIUS_PX,
                backgroundColor: scrollbarThumb,
                minHeight: SCROLLBAR_THUMB_MIN_HEIGHT_PX,
                border: `${SCROLLBAR_THUMB_BORDER_PX}px solid ${scrollbarTrack}`,
              },
              "&::-webkit-scrollbar-corner, & *::-webkit-scrollbar-corner": {
                backgroundColor: scrollbarTrack,
              },
            },
          },
        },
        MuiAppBar: {
          styleOverrides: {
            root: {
              backgroundColor: appBar.background,
              color: appBar.text,
              // Remove default dark mode overlay gradient
              backgroundImage: "none",
              // Ensure Select components inside AppBar inherit the text color
              "& .MuiSelect-select": { color: appBar.text },
              "& .MuiSelect-icon": { color: appBar.text },
              "& .MuiOutlinedInput-notchedOutline": { borderColor: appBar.text },
              // Focus outline for buttons inside AppBar
              "& .MuiButtonBase-root.Mui-focusVisible": {
                outline: `${FOCUS_OUTLINE_WIDTH_PX}px solid ${appBar.focus}`,
                outlineOffset: `${FOCUS_OUTLINE_OFFSET_PX}px`,
              },
            },
          },
        },
        MuiPaper: {
          styleOverrides: {
            root: {
              backgroundColor: background.default,
              backgroundImage: "none",
            },
          },
        },
        MuiDialog: {
          styleOverrides: {
            root: {
              "& .MuiBackdrop-root": {
                backgroundColor: dialogSurfaces.backdrop,
              },
            },
            paper: {
              backgroundColor: dialogSurfaces.paper,
              backgroundImage: "none",
              boxShadow: "none",
              [OVERLAY_SURFACE_CSS_VARIABLE]: dialogSurfaces.paper,
              [FORM_SURFACE_CSS_VARIABLE]: dialogSurfaces.form,
            },
          },
        },
        MuiDialogTitle: {
          styleOverrides: {
            root: ({ theme }) => ({
              [theme.breakpoints.down("sm")]: {
                fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_TITLE_PX}px`,
              },
            }),
          },
        },
        MuiDialogContent: {
          styleOverrides: {
            root: ({ theme }) => ({
              [theme.breakpoints.down("sm")]: {
                fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_BODY_PX}px`,
                "& .MuiTypography-body1, & .MuiTypography-body2, & .MuiDialogContentText-root": {
                  fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_BODY_PX}px`,
                },
                "& .MuiInputLabel-root": {
                  fontSize: `${COMPACT_LAYOUT_SIZE.DIALOG_FORM_LABEL_PX}px`,
                },
              },
            }),
          },
        },
        MuiLink: {
          defaultProps: {
            underline: "none",
          },
          styleOverrides: {
            root: {
              color: link.main,
              "&:hover": {
                color: link.hover,
              },
              "&.Mui-focusVisible": {
                outline: "none",
                textDecoration: "underline",
                textDecorationThickness: "2px",
                textUnderlineOffset: "3px",
                textDecorationColor: focusColor,
              },
            },
          },
        },
        MuiMenu: {
          styleOverrides: {
            root: ({ theme }) => ({
              zIndex: theme.zIndex.modal + POPUP_OVERLAY_Z_INDEX_OFFSET,
            }),
            paper: {
              backgroundColor: menuBackground,
            },
          },
        },
        MuiPopover: {
          styleOverrides: {
            root: ({ theme }) => ({
              zIndex: theme.zIndex.modal + POPUP_OVERLAY_Z_INDEX_OFFSET,
            }),
          },
        },
        MuiPopper: {
          styleOverrides: {
            root: ({ theme }) => ({
              zIndex: `${theme.zIndex.modal + POPUP_OVERLAY_Z_INDEX_OFFSET} !important`,
            }),
          },
        },
        MuiMenuItem: {
          styleOverrides: {
            root: ({ theme }) => ({
              [theme.breakpoints.down("sm")]: {
                fontSize: `${COMPACT_LAYOUT_SIZE.MENU_TEXT_PX}px`,
                "& .MuiListItemText-primary, & .MuiTypography-root": {
                  fontSize: `${COMPACT_LAYOUT_SIZE.MENU_TEXT_PX}px`,
                },
                "& .MuiSvgIcon-root": {
                  fontSize: `${COMPACT_LAYOUT_SIZE.MENU_ICON_PX}px`,
                },
              },
              "&:hover": {
                backgroundColor: action.selected,
              },
              "&.Mui-focusVisible": {
                backgroundColor: action.selected,
              },
              "&.Mui-selected": {
                fontWeight: 600,
                backgroundColor: action.selected,
                "&:hover": {
                  backgroundColor: action.selected,
                },
                "&.Mui-focusVisible": {
                  backgroundColor: action.selected,
                },
              },
            }),
          },
        },
        MuiListItemIcon: {
          styleOverrides: {
            root: {
              color: "inherit",
            },
          },
        },
        MuiAlert: {
          styleOverrides: {
            standard: ({ ownerState }) =>
              ownerState.severity === "info" ||
              ownerState.severity === "success" ||
              ownerState.severity === "warning" ||
              ownerState.severity === "error"
                ? getStandardAlertStyle(ownerState.severity)
                : {},
          },
        },
        // Focus styles for Button - clean outline ring (keyboard nav only)
        MuiButton: {
          defaultProps: {
            disableFocusRipple: true,
          },
          styleOverrides: {
            root: ({ ownerState, theme }) => ({
              textTransform: "none",
              "&.Mui-focusVisible": getButtonFocusOutline(theme, ownerState.color),
            }),
            // Text/outlined buttons retain their semantic color when focused.
            text: {
              "&.Mui-focusVisible": {
                backgroundColor: "transparent",
              },
            },
            outlined: {
              "&.Mui-focusVisible": {
                backgroundColor: "transparent",
              },
            },
          },
        },
        // Focus styles for IconButton - clean outline ring (keyboard nav only)
        MuiIconButton: {
          defaultProps: {
            disableFocusRipple: true,
          },
          styleOverrides: {
            root: {
              "&.Mui-focusVisible": {
                outline: `${FOCUS_OUTLINE_WIDTH_PX}px solid ${focusColor}`,
                outlineOffset: `${FOCUS_OUTLINE_OFFSET_PX}px`,
              },
            },
          },
        },
        // Keep form labels readable when focused (don't use primary yellow color)
        MuiInputLabel: {
          styleOverrides: {
            root: {
              "&.Mui-focused": {
                color: text.primary,
              },
            },
          },
        },
        // Keep helper text readable when input is focused
        MuiFormHelperText: {
          styleOverrides: {
            root: {
              color: text.secondary,
              marginTop: 8,
              marginLeft: 0,
              marginRight: 0,
            },
          },
        },
        // Align dialog action buttons with dialog content padding
        MuiDialogActions: {
          styleOverrides: {
            root: {
              padding: "16px 24px",
            },
          },
        },
      },
    });
  }, [currentTheme]);

  // Update meta theme-color when theme changes
  useEffect(() => {
    const metaThemeColor = document.querySelector('meta[name="theme-color"]');
    if (metaThemeColor) {
      metaThemeColor.setAttribute("content", currentTheme.primary.main);
    }
  }, [currentTheme.primary.main]);

  const value: ThemeContextValue = {
    currentTheme,
    muiTheme,
    availableThemes,
    storedThemes,
    siteDefaultId,
    isAdmin,
    refreshThemes,
  };

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

//
// useTheme hook
//

/**
 * Hook to access theme context
 */
export function useSambeeTheme() {
  const context = useContext(ThemeContext);
  if (!context) {
    throw new Error("useSambeeTheme must be used within SambeeThemeProvider");
  }
  return context;
}
