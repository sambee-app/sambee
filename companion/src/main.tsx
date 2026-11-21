import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { render } from "preact";
import { App } from "./App";
import { DoneEditingWindow } from "./components/DoneEditingWindow";
import { PairingWindow } from "./components/PairingWindow";
import { PreviewHome } from "./components/PreviewHome";
import { applyCompanionLocalization, type CompanionLocalizationState, clearCompanionLocalization } from "./i18n";
import { applyFallbackTheme, applyThemeFromBase64 } from "./lib/theme";
import { scheduleUpdateCheck } from "./lib/updateCheck";
import { COMPANION_PREVIEWS } from "./previews";
import "./styles/global.css";

/**
 * Entry point — routes to the appropriate component based on the window's
 * URL path. The main window loads "/", the dedicated pairing window loads
 * "/pairing", and "Done Editing" secondary windows load "/done-editing"
 * (set by the Rust `WebviewUrl::App` call).
 *
 * Applies a fallback theme immediately (based on OS light/dark preference),
 * then listens for "apply-theme" events from the Rust backend to switch to
 * the user's actual Sambee theme (delivered as base64-encoded JSON).
 */

// Apply a sensible default theme before the first paint.
applyFallbackTheme();

const path = window.location.pathname;
const isBrowserPreviewRuntime = !("__TAURI_INTERNALS__" in window);
const activePreview = isBrowserPreviewRuntime ? (COMPANION_PREVIEWS.find((preview) => preview.path === path) ?? null) : null;
const isPreviewHome = isBrowserPreviewRuntime && path === "/";
const isPreviewRoute = activePreview !== null;

// Block browser-style reload shortcuts so the companion behaves like a native app.
const preventReloadShortcut = (event: KeyboardEvent) => {
  const isReloadShortcut = event.key === "F5" || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "r");
  if (!isReloadShortcut) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
};

if (!isBrowserPreviewRuntime) {
  window.addEventListener("keydown", preventReloadShortcut, true);
}

if (!isBrowserPreviewRuntime) {
  listen<string>("apply-theme", (event) => {
    applyThemeFromBase64(event.payload);
  });

  const hydrateLocalization = async () => {
    let updateReceived = false;
    await listen<CompanionLocalizationState>("localization-updated", (event) => {
      updateReceived = true;
      void applyCompanionLocalization(event.payload).catch((error) => {
        console.warn("Could not apply synced Companion localization", error);
      });
    });
    const state = await invoke<CompanionLocalizationState | null>("get_synced_localization");
    if (!updateReceived) {
      if (state) await applyCompanionLocalization(state);
      else await clearCompanionLocalization();
    }
  };
  void hydrateLocalization().catch((error) => {
    console.warn("Could not read synced Companion localization; keeping the last applied language", error);
  });
}

const root = document.getElementById("app");
if (root) {
  if (isPreviewRoute && activePreview) {
    const PreviewComponent = activePreview.component;
    render(<PreviewComponent />, root);
  } else if (isPreviewHome) {
    render(<PreviewHome previews={COMPANION_PREVIEWS} />, root);
  } else if (path === "/done-editing") {
    render(<DoneEditingWindow />, root);
  } else if (path === "/pairing") {
    render(<PairingWindow />, root);
  } else {
    render(<App />, root);
    // Check for updates shortly after main UI renders
    scheduleUpdateCheck();
  }
}
