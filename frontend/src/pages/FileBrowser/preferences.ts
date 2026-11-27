import { useEffect, useState } from "react";
import { commitCurrentUserSetting, getConfirmedCurrentUserSetting, useCurrentUserSetting } from "../../services/userSettingsStore";
import type { PaneMode } from "./types";

export const QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY = "quick-nav-include-dot-directories";
export const QUICK_BAR_SHORTCUT_HINT_VISIBILITY_STORAGE_KEY = "quick-bar-shortcut-hint-visibility";

const ENABLED_STORAGE_VALUE = "true";
const DEFAULT_TEXT_EDITOR_MAX_FILE_SIZE_BYTES = 52_428_800;
const QUICK_BAR_KEYBOARD_EVIDENCE_SESSION_STORAGE_KEY = "quick-bar-keyboard-evidence";
const KEYBOARD_MODIFIER_KEYS = new Set(["Alt", "AltGraph", "CapsLock", "Control", "Meta", "NumLock", "ScrollLock", "Shift"]);

export function useTextEditorWordWrapPreference(fallbackValue: boolean): [boolean, (value: boolean) => void] {
  const setting = useCurrentUserSetting("text_editor.word_wrap_enabled");
  const [candidate, setCandidate] = useState<boolean | null>(null);
  const confirmedValue = setting.confirmedValue ?? fallbackValue;

  useEffect(() => {
    if (!setting.pending) setCandidate(null);
  }, [setting.pending]);

  return [
    candidate ?? confirmedValue,
    (value) => {
      if (setting.pending) return;
      setCandidate(value);
      setting.clearError();
      void setting
        .commit(value)
        .then(() => setCandidate(null))
        .catch(() => undefined);
    },
  ];
}

export type QuickBarShortcutHintVisibility = "auto" | "always" | "never";
export type TouchFriendlyFileSelection = "auto" | "always" | "never";

export function useTouchFriendlyFileSelectionPreference(): [TouchFriendlyFileSelection, (value: TouchFriendlyFileSelection) => void] {
  const setting = useCurrentUserSetting("browser.touch_friendly_file_selection");
  return [setting.confirmedValue ?? "auto", (value) => void setting.commit(value).catch(() => undefined)];
}

export function shouldUseTouchSelectionControls(
  preference: TouchFriendlyFileSelection,
  useCompactLayout: boolean,
  hasCoarsePrimaryPointer: boolean
): boolean {
  return useCompactLayout || preference === "always" || (preference === "auto" && hasCoarsePrimaryPointer);
}

/**
 * Resolves whether pane tab headers should use touch-sized targets and always-visible close overlays.
 * Uses input-capability signals and the user's touch-friendly preference rather than viewport width alone,
 * preferring always-visible close controls on mixed-input devices that support touch.
 */
export function shouldUseTouchTabControls({
  preference,
  hasCoarseAnyPointer,
  hasHoverNone,
  maxTouchPoints = typeof navigator === "undefined" ? 0 : (navigator.maxTouchPoints ?? 0),
}: {
  preference: TouchFriendlyFileSelection;
  hasCoarseAnyPointer: boolean;
  hasHoverNone: boolean;
  maxTouchPoints?: number;
}): boolean {
  if (preference === "always") {
    return true;
  }
  if (preference === "never") {
    return false;
  }
  return hasCoarseAnyPointer || hasHoverNone || maxTouchPoints > 0;
}

export function isQuickBarKeyboardEvidenceEvent(event: Pick<KeyboardEvent, "isComposing" | "isTrusted" | "key">): boolean {
  return event.isTrusted && !event.isComposing && !KEYBOARD_MODIFIER_KEYS.has(event.key);
}

function normalizeSelectedConnectionId(connectionId: string | null | undefined): string | null {
  const normalized = connectionId?.trim();
  return normalized ? normalized : null;
}

export function useQuickBarShortcutHintVisibilityPreference(): [
  QuickBarShortcutHintVisibility,
  (value: QuickBarShortcutHintVisibility) => void,
] {
  const setting = useCurrentUserSetting("browser.quick_bar_shortcut_hint_visibility");
  return [setting.confirmedValue ?? "auto", (value) => void setting.commit(value).catch(() => undefined)];
}

export function useQuickBarKeyboardHints(visibility: QuickBarShortcutHintVisibility, useCompactLayout: boolean): boolean {
  const [hasKeyboardEvidence, setHasKeyboardEvidence] = useState(() => {
    return sessionStorage.getItem(QUICK_BAR_KEYBOARD_EVIDENCE_SESSION_STORAGE_KEY) === ENABLED_STORAGE_VALUE;
  });

  useEffect(() => {
    if (visibility !== "auto" || !useCompactLayout || hasKeyboardEvidence) {
      return;
    }

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isQuickBarKeyboardEvidenceEvent(event)) {
        return;
      }

      sessionStorage.setItem(QUICK_BAR_KEYBOARD_EVIDENCE_SESSION_STORAGE_KEY, ENABLED_STORAGE_VALUE);
      setHasKeyboardEvidence(true);
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [hasKeyboardEvidence, useCompactLayout, visibility]);

  return visibility === "always" || (visibility === "auto" && (!useCompactLayout || hasKeyboardEvidence));
}

export function readFileBrowserPaneModePreference(): PaneMode {
  return getConfirmedCurrentUserSetting("browser.pane_mode") ?? "single";
}

export function setFileBrowserPaneModePreference(paneMode: PaneMode): void {
  if (readFileBrowserPaneModePreference() !== paneMode) {
    void commitCurrentUserSetting({ field: "browser.pane_mode", value: paneMode }).catch(() => undefined);
  }
}

export function writeFileBrowserPaneModePreference(paneMode: PaneMode): void {
  setFileBrowserPaneModePreference(paneMode);
}

export function readSelectedConnectionIdPreference(): string | null {
  return normalizeSelectedConnectionId(getConfirmedCurrentUserSetting("browser.selected_connection_id"));
}

export function setSelectedConnectionIdPreference(connectionId: string | null): void {
  const normalizedConnectionId = normalizeSelectedConnectionId(connectionId);
  if (readSelectedConnectionIdPreference() !== normalizedConnectionId) {
    void commitCurrentUserSetting({ field: "browser.selected_connection_id", value: normalizedConnectionId }).catch(() => undefined);
  }
}

export function writeSelectedConnectionIdPreference(connectionId: string | null): void {
  const normalizedConnectionId = normalizeSelectedConnectionId(connectionId);
  const currentConnectionId = readSelectedConnectionIdPreference();

  if (currentConnectionId !== normalizedConnectionId) setSelectedConnectionIdPreference(normalizedConnectionId);
}

export function useQuickNavIncludeDotDirectoriesPreference(): [boolean, (enabled: boolean) => void] {
  const setting = useCurrentUserSetting("browser.quick_nav_include_dot_directories");
  return [setting.confirmedValue ?? false, (enabled) => void setting.commit(enabled).catch(() => undefined)];
}

export function useTextEditorMaxFileSizeBytesPreference(): [number, (maxFileSizeBytes: number) => void] {
  const setting = useCurrentUserSetting("text_editor.max_file_size_bytes");
  return [
    setting.confirmedValue ?? DEFAULT_TEXT_EDITOR_MAX_FILE_SIZE_BYTES,
    (maxFileSizeBytes) => void setting.commit(maxFileSizeBytes).catch(() => undefined),
  ];
}
