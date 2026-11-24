import { createContext, useContext, useId, useLayoutEffect } from "react";
import { isApplePlatform } from "../utils/platform";

export const KeyboardShortcutScopeContext = createContext<string | null>(null);
export const KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE = "data-keyboard-shortcut-scope";
const activeShortcutScopes = new Map<string, string | null>();

export function useKeyboardShortcutScope(open: boolean): string {
  const scope = useId();
  const parent = useContext(KeyboardShortcutScopeContext);
  useLayoutEffect(() => {
    if (!open) return;
    activeShortcutScopes.set(scope, parent);
    return () => {
      activeShortcutScopes.delete(scope);
    };
  }, [open, scope, parent]);
  return scope;
}

function getActiveKeyboardShortcutScope(): string | null {
  const parentScopes = new Set(activeShortcutScopes.values());
  return [...activeShortcutScopes.keys()].findLast((scope) => !parentScopes.has(scope)) ?? null;
}

function getKeyboardShortcutScope(target: EventTarget | null): string | null {
  return target instanceof Element
    ? (target.closest(`[${KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE}]`)?.getAttribute(KEYBOARD_SHORTCUT_SCOPE_ATTRIBUTE) ?? null)
    : null;
}

/**
 * Checks whether a keyboard event belongs to the given shortcut scope and is not
 * intercepted by a nested modal/dialog scope or an active IME composition.
 */
export function isEventInKeyboardShortcutScope(event: KeyboardEvent, scope: string | null): boolean {
  if (event.defaultPrevented || event.isComposing) {
    return false;
  }
  const activeScope = getActiveKeyboardShortcutScope();
  if (activeScope !== null && activeScope !== scope) {
    return false;
  }
  return (getKeyboardShortcutScope(event.target) ?? getKeyboardShortcutScope(document.activeElement) ?? activeScope) === scope;
}

const INTERACTIVE_SHORTCUT_BLOCK_SELECTOR = [
  "button",
  "select",
  "a[href]",
  '[role="button"]',
  '[role="menuitem"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
  '[contenteditable="true"]',
].join(", ");

function hasInteractiveFocus(activeElement: Element | null, inputSelector: string): boolean {
  if (!activeElement) {
    return false;
  }

  return activeElement.matches(`${inputSelector}, ${INTERACTIVE_SHORTCUT_BLOCK_SELECTOR}`);
}

/**
 * Keyboard shortcut configuration
 */
export type ShortcutHelpGroup = "general" | "search" | "navigation" | "selection" | "fileActions" | "editing" | "view" | "panes";

export interface KeyboardShortcut {
  /** Unique identifier for the shortcut */
  id: string;
  /** Key(s) that trigger the shortcut (can be array for multiple keys) */
  keys: string | string[];
  /** Description shown in tooltips and help */
  description: string;
  /** Display label for tooltip (e.g., "Ctrl+S") - auto-generated if not provided */
  label?: string;
  /** Help dialog grouping used to render shortcuts in a stable, user-facing order */
  helpGroup?: ShortcutHelpGroup;
  /** Handler function to execute */
  handler: (event?: KeyboardEvent) => void;
  /** Handles a matching disabled shortcut and reports whether it consumed the event */
  onUnavailable?: (event: KeyboardEvent) => boolean;
  /** Requires Ctrl/Cmd modifier key */
  ctrl?: boolean;
  /** Requires Shift modifier key */
  shift?: boolean;
  /** Requires Alt/Option modifier key */
  alt?: boolean;
  /** Replaces Alt with physical Control (without Cmd) on Apple platforms */
  macControlForAlt?: boolean;
  /** Allow when input field has focus (default: false) */
  allowInInput?: boolean;
  /** Allow when focus is inside the given interactive input surface */
  allowInInputWithin?: string;
  /** Custom condition to enable/disable shortcut */
  enabled?: boolean;
  /** Priority for overlapping shortcuts (higher = checked first, default: 0) */
  priority?: number;
}

/**
 * Configuration for keyboard shortcut hook
 */
export interface UseKeyboardShortcutsConfig {
  /** Array of keyboard shortcuts */
  shortcuts: KeyboardShortcut[];
  /** Selector for input elements to check focus (default: 'input, textarea') */
  inputSelector?: string;
  /** Temporarily suspend all shortcut handling without changing the shortcut list */
  active?: boolean;
}

const ASCII_LETTER_PATTERN = /^[a-zA-Z]$/;

interface ResolvedShortcutRules {
  /** Accepts Ctrl or Meta (standard cross-platform Ctrl/Cmd behavior) */
  ctrlOrMeta: boolean;
  /** Requires physical Control without Meta (macOS Control-for-Alt replacement) */
  controlOnly: boolean;
  /** Requires Shift */
  shift: boolean;
  /** Requires Alt/Option */
  alt: boolean;
  /** Allows matching ASCII-letter keys via event.keyCode when Option alters event.key on macOS */
  allowMacOptionLetterFallback: boolean;
  /** Display labels for required modifiers in canonical order */
  modifierLabels: string[];
  /** Normalized array of main keys */
  keys: string[];
}

function isAsciiLetter(key: string): boolean {
  return ASCII_LETTER_PATTERN.test(key);
}

/**
 * Resolves platform-aware modifier requirements, display labels, and key-matching rules
 * from a single helper so matching, tooltips, and help tables always agree.
 */
function resolveShortcutRules(
  shortcut: Pick<KeyboardShortcut, "keys" | "ctrl" | "shift" | "alt" | "macControlForAlt">
): ResolvedShortcutRules {
  const isApple = isApplePlatform();
  const keys = Array.isArray(shortcut.keys) ? shortcut.keys : [shortcut.keys];
  const useMacControlForAlt = isApple && Boolean(shortcut.alt) && Boolean(shortcut.macControlForAlt) && !shortcut.ctrl;
  const ctrlOrMeta = Boolean(shortcut.ctrl);
  const controlOnly = useMacControlForAlt;
  const shift = Boolean(shortcut.shift);
  const alt = Boolean(shortcut.alt) && !useMacControlForAlt;
  const modifierLabels: string[] = [];

  if (ctrlOrMeta) {
    modifierLabels.push("Ctrl");
  } else if (controlOnly) {
    modifierLabels.push("Control");
  }
  if (shift) {
    modifierLabels.push("Shift");
  }
  if (alt) {
    modifierLabels.push(isApple ? "Option" : "Alt");
  }

  return {
    ctrlOrMeta,
    controlOnly,
    shift,
    alt,
    allowMacOptionLetterFallback: isApple && alt,
    modifierLabels,
    keys,
  };
}

function matchesShortcutKey(event: KeyboardEvent, rules: ResolvedShortcutRules): boolean {
  if (rules.keys.some((key) => event.key === key)) {
    return true;
  }

  if (!rules.allowMacOptionLetterFallback || !event.altKey) {
    return false;
  }

  return rules.keys.some((key) => isAsciiLetter(key) && event.keyCode === key.toUpperCase().charCodeAt(0));
}

/**
 * Checks whether a KeyboardEvent satisfies a shortcut definition's key and modifier rules.
 */
export function matchesKeyboardShortcut(
  event: KeyboardEvent,
  shortcut: Pick<KeyboardShortcut, "keys" | "ctrl" | "shift" | "alt" | "macControlForAlt">
): boolean {
  if (event.isComposing) {
    return false;
  }
  const rules = resolveShortcutRules(shortcut);

  if (rules.ctrlOrMeta && !(event.ctrlKey || event.metaKey)) return false;
  if (rules.controlOnly && (!event.ctrlKey || event.metaKey)) return false;
  if (rules.shift && !event.shiftKey) return false;
  if (rules.alt && !event.altKey) return false;

  if (!matchesShortcutKey(event, rules)) return false;

  const isPrintableChar = rules.keys.some((key) => key.length === 1);
  if (!rules.ctrlOrMeta && !rules.controlOnly && (event.ctrlKey || event.metaKey)) return false;
  if (!rules.shift && event.shiftKey && !isPrintableChar) return false;
  if (!rules.alt && event.altKey) return false;

  return true;
}

/**
 * Collapses case-alternative ASCII letter pairs (such as `["c", "C"]`) into a single
 * upper-case letter while preserving non-paired keys and single-key definitions.
 */
function collapseCaseAlternativeKeys(keys: readonly string[]): string[] {
  const seenLetters = new Map<string, Set<string>>();
  for (const key of keys) {
    if (isAsciiLetter(key)) {
      const upper = key.toUpperCase();
      let variants = seenLetters.get(upper);
      if (!variants) {
        variants = new Set();
        seenLetters.set(upper, variants);
      }
      variants.add(key);
    }
  }

  const emittedCollapsedLetters = new Set<string>();
  const collapsed: string[] = [];
  for (const key of keys) {
    if (isAsciiLetter(key)) {
      const upper = key.toUpperCase();
      if ((seenLetters.get(upper)?.size ?? 0) > 1) {
        if (!emittedCollapsedLetters.has(upper)) {
          emittedCollapsedLetters.add(upper);
          collapsed.push(upper);
        }
        continue;
      }
    }
    collapsed.push(key);
  }
  return collapsed;
}

/**
 * Format key for display (capitalize, handle special keys)
 */
const formatKey = (key: string): string => {
  const specialKeys: Record<string, string> = {
    ArrowRight: "Right",
    ArrowLeft: "Left",
    ArrowUp: "Up",
    ArrowDown: "Down",
    PageDown: "Page Down",
    PageUp: "Page Up",
    Escape: "Esc",
    "+": "Plus",
    "-": "Minus",
  };

  return specialKeys[key] || key;
};

/**
 * Format shortcut for display in tooltips
 */
export const formatShortcut = (
  shortcut: Pick<KeyboardShortcut, "keys" | "label" | "ctrl" | "shift" | "alt" | "macControlForAlt">
): string => {
  // Use provided label if available
  if (shortcut.label) return shortcut.label;

  const rules = resolveShortcutRules(shortcut);
  const formattedMainKeys = collapseCaseAlternativeKeys(rules.keys).map(formatKey).join(" / ");

  return [...rules.modifierLabels, formattedMainKeys].join("+");
};

/**
 * Get tooltip text with keyboard shortcut
 * Accepts a partial shortcut definition (handler not required for tooltip display)
 */
export const withShortcut = (shortcut: Omit<KeyboardShortcut, "handler" | "enabled">): string => {
  return `${shortcut.description} (${formatShortcut(shortcut)})`;
};

/**
 * Custom hook for managing keyboard shortcuts
 *
 * Features:
 * - Automatic modifier key handling (Ctrl/Cmd, Shift, Alt)
 * - Interactive control awareness (shortcuts disabled in focused controls by default)
 * - Conditional enabling/disabling of shortcuts
 * - Priority system for overlapping shortcuts (higher priority checked first)
 * - Multiple key alternatives (e.g., ArrowRight or 'd' for same action)
 *
 * @example
 * ```tsx
 * useKeyboardShortcuts({
 *   shortcuts: [
 *     {
 *       id: 'save',
 *       keys: 's',
 *       description: 'Save',
 *       ctrl: true,
 *       handler: handleSave,
 *     },
 *     {
 *       id: 'next-page',
 *       keys: ['ArrowRight', 'd', 'D'],
 *       description: 'Next page',
 *       handler: handleNextPage,
 *       enabled: currentPage < totalPages,
 *     },
 *     {
 *       id: 'escape',
 *       keys: 'Escape',
 *       description: 'Close',
 *       handler: handleContextualClose,
 *       priority: 10, // Higher priority for context-aware behavior
 *       allowInInput: true,
 *     },
 *   ],
 * });
 * ```
 */
export const useKeyboardShortcuts = ({ shortcuts, inputSelector = "input, textarea", active = true }: UseKeyboardShortcutsConfig): void => {
  const scope = useContext(KeyboardShortcutScopeContext);

  useLayoutEffect(() => {
    if (!active) {
      return;
    }

    // Sort shortcuts by priority (higher first) for correct processing order
    const sortedShortcuts = [...shortcuts].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));

    const handleKeyDown = (event: KeyboardEvent) => {
      if (!isEventInKeyboardShortcutScope(event, scope)) return;

      // Check if any interactive control has focus
      let activeElement = document.activeElement;
      if (
        activeElement instanceof Element &&
        activeElement.matches('[data-file-selection-icon="true"]') &&
        ["ArrowUp", "ArrowDown", "Home", "End", "PageUp", "PageDown"].includes(event.key)
      ) {
        const list = activeElement.closest('[data-testid="file-list-container"]');
        if (list instanceof HTMLElement) list.focus({ preventScroll: true });
        activeElement = document.activeElement;
      }
      const interactiveHasFocus = hasInteractiveFocus(activeElement, inputSelector);

      const matchesShortcut = (shortcut: KeyboardShortcut): boolean => {
        // Skip if an interactive control has focus and shortcut doesn't explicitly allow it
        if (interactiveHasFocus && !shortcut.allowInInput) {
          const isAllowedInputSurface =
            shortcut.allowInInputWithin && activeElement instanceof Element
              ? activeElement.matches(shortcut.allowInInputWithin) || activeElement.closest(shortcut.allowInInputWithin)
              : false;

          if (!isAllowedInputSurface) return false;
        }

        return matchesKeyboardShortcut(event, shortcut);
      };

      for (const shortcut of sortedShortcuts) {
        if (shortcut.enabled === false || !matchesShortcut(shortcut)) {
          continue;
        }

        event.preventDefault();
        shortcut.handler(event);
        return;
      }

      if (event.repeat) {
        return;
      }

      for (const shortcut of sortedShortcuts) {
        if (shortcut.enabled !== false || !shortcut.onUnavailable || !matchesShortcut(shortcut)) {
          continue;
        }

        if (shortcut.onUnavailable(event)) {
          event.preventDefault();
        }
        return;
      }
    };

    // Use capture phase so shortcuts always fire before other document-level
    // keydown handlers (e.g. useFocusTrap) regardless of registration order.
    document.addEventListener("keydown", handleKeyDown, true);
    return () => {
      document.removeEventListener("keydown", handleKeyDown, true);
    };
  }, [active, shortcuts, inputSelector, scope]);
};
