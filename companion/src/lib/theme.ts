/**
 * Companion theme system.
 *
 * Maps a subset of the Sambee web app's ThemeConfig to CSS custom properties.
 * The theme travels with the deep-link URI (base64-encoded JSON) so the
 * companion always matches the user's chosen web-app theme.
 *
 * Flow:
 *   1. Web app encodes CompanionTheme as base64 JSON in the sambee:// URI
 *   2. Rust URI parser extracts the optional `theme` param (opaque string)
 *   3. Rust emits "apply-theme" event to the companion webview windows
 *   4. This module decodes the payload and sets CSS custom properties on :root
 */

import { log } from "./logger";

// ─────────────────────────────────────────────────────────────────────────────
// Companion theme type — the subset of ThemeConfig the companion needs
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal theme data passed from the web app to the companion.
 *
 * This is intentionally a subset of the full `ThemeConfig` from
 * `frontend/src/theme/types.ts`. Only the tokens used by the companion
 * CSS are included, keeping the URI compact.
 */
export interface CompanionTheme {
  /** "light" or "dark" */
  mode: "light" | "dark";

  primary: {
    main: string;
    light?: string;
    dark?: string;
    contrastText?: string;
  };

  background?: {
    default?: string;
    paper?: string;
  };

  text?: {
    primary?: string;
    secondary?: string;
  };

  action?: {
    hover?: string;
    selected?: string;
    focus?: string;
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Built-in defaults — match the Sambee web app's default themes
// ─────────────────────────────────────────────────────────────────────────────

/** Sambee Light theme defaults for the companion. */
const SAMBEE_LIGHT: CompanionTheme = {
  mode: "light",
  primary: {
    main: "#F4C430",
    light: "#F6E58D",
    dark: "#D4A020",
    contrastText: "#1F262B",
  },
  background: {
    default: "#FBF9F4",
    paper: "#FFFFFF",
  },
  text: {
    primary: "#1F262B",
    secondary: "#1F262BB3",
  },
  action: {
    hover: "#F4C43014",
    selected: "#F4C43029",
    focus: "#F4C430",
  },
};

/** Sambee Dark theme defaults for the companion. */
const SAMBEE_DARK: CompanionTheme = {
  mode: "dark",
  primary: {
    main: "#F4C430",
    light: "#F6E58D",
    dark: "#D4A020",
    contrastText: "#1F262B",
  },
  background: {
    default: "#1F262B",
    paper: "#2A3239",
  },
  text: {
    primary: "#F6F1E8",
    secondary: "#F6F1E8B3",
  },
  action: {
    hover: "#F4C43014",
    selected: "#F4C43029",
    focus: "#F4C430",
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Derived colors — computed from theme tokens
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Compute all CSS custom property values from a CompanionTheme.
 *
 * This is the single source of truth for the variable-name ↔ token mapping.
 */
function themeToVariables(theme: CompanionTheme): Record<string, string> {
  const isDark = theme.mode === "dark";

  return {
    // Core palette
    "--primary-main": theme.primary.main,
    "--primary-light": theme.primary.light ?? theme.primary.main,
    "--primary-dark": theme.primary.dark ?? theme.primary.main,
    "--primary-contrast": theme.primary.contrastText ?? "#1F262B",

    // Backgrounds
    "--bg-default": theme.background?.default ?? (isDark ? "#1F262B" : "#FBF9F4"),
    "--bg-paper": theme.background?.paper ?? (isDark ? "#2A3239" : "#FFFFFF"),

    // Text
    "--text-primary": theme.text?.primary ?? (isDark ? "#F6F1E8" : "#1F262B"),
    "--text-secondary": theme.text?.secondary ?? (isDark ? "#F6F1E8B3" : "#1F262BB3"),

    // Actions
    "--action-hover": theme.action?.hover ?? `${theme.primary.main}14`,
    "--action-selected": theme.action?.selected ?? `${theme.primary.main}29`,
    "--action-focus": theme.action?.focus ?? theme.primary.main,

    // Semantic aliases used directly by companion CSS
    "--accent-color": theme.primary.main,
    "--accent-light": theme.primary.light ?? theme.primary.main,
    "--accent-dark": theme.primary.dark ?? theme.primary.main,
    "--text-color": theme.text?.primary ?? (isDark ? "#F6F1E8" : "#1F262B"),
    "--muted-color": theme.text?.secondary ?? (isDark ? "#F6F1E8B3" : "#1F262BB3"),
    "--bg-color": theme.background?.default ?? (isDark ? "#1F262B" : "#FBF9F4"),

    // UI chrome — borders, tracks, surfaces derived from mode
    "--border-color": isDark ? "#374151" : "#D1D5DB",
    "--border-color-light": isDark ? "#4B5563" : "#E5E7EB",
    "--control-outline": isDark ? "#CBD5E1" : "#4B5563",
    "--track-color": isDark ? "#374151" : "#E5E7EB",
    "--surface-hover": isDark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.04)",
    "--surface-selected": isDark ? `${theme.primary.main}1A` : `${theme.primary.main}14`,
    "--btn-bg": isDark ? "#374151" : "#F3F4F6",
    "--btn-bg-hover": isDark ? "#4B5563" : "#E5E7EB",

    // Danger / error
    "--danger-color": isDark ? "#EF4444" : "#DC2626",
    "--danger-bg": isDark ? "#450A0A" : "#FEF2F2",
    "--danger-border": isDark ? "#7F1D1D" : "#FECACA",
    "--danger-text": isDark ? "#FCA5A5" : "#991B1B",

    // Success
    "--success-color": isDark ? "#22C55E" : "#16A34A",
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Public API
// ─────────────────────────────────────────────────────────────────────────────

//
// applyTheme
//
/**
 * Apply a CompanionTheme by setting CSS custom properties on `:root`.
 *
 * Also sets `data-theme="light|dark"` on the `<html>` element so CSS
 * can use attribute selectors as an alternative to `prefers-color-scheme`.
 */
export function applyTheme(theme: CompanionTheme): void {
  const vars = themeToVariables(theme);
  const root = document.documentElement;

  for (const [prop, value] of Object.entries(vars)) {
    root.style.setProperty(prop, value);
  }

  root.setAttribute("data-theme", theme.mode);
}

//
// applyThemeFromBase64
//
/**
 * Decode a base64-encoded JSON CompanionTheme and apply it.
 *
 * Returns `true` if the theme was applied successfully, `false` on any
 * decode/parse error (in which case the fallback theme is applied instead).
 */
export function applyThemeFromBase64(encoded: string): boolean {
  try {
    const json = atob(encoded);
    const theme: CompanionTheme = JSON.parse(json);

    if (!theme.mode || !theme.primary?.main) {
      log.warn("Invalid companion theme data, applying fallback");
      applyFallbackTheme();
      return false;
    }

    applyTheme(theme);
    return true;
  } catch (e) {
    log.warn("Failed to decode companion theme, applying fallback:", e);
    applyFallbackTheme();
    return false;
  }
}

//
// applyFallbackTheme
//
/**
 * Apply the appropriate built-in Sambee theme based on the OS preference.
 *
 * Used on startup before any deep-link theme arrives, or when decoding fails.
 */
export function applyFallbackTheme(): void {
  const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
  applyTheme(prefersDark ? SAMBEE_DARK : SAMBEE_LIGHT);
}

//
// getDefaultTheme
//
/**
 * Get the built-in default CompanionTheme for the given mode.
 */
export function getDefaultTheme(mode: "light" | "dark"): CompanionTheme {
  return mode === "dark" ? { ...SAMBEE_DARK } : { ...SAMBEE_LIGHT };
}
