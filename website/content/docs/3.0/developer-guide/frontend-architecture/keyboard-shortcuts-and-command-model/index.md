+++
title = "Keyboard Shortcuts and Command Model"
+++

Keyboard behavior in Sambee is a shared frontend system, not a pile of local `keydown` handlers.

The product depends on contributors keeping shortcuts, command labels, viewer controls, and file-browser focus behavior aligned.

## Core Pieces

These files define the keyboard and command model:

| Path | Responsibility |
|---|---|
| `frontend/src/config/keyboardShortcuts.ts` | single source of truth for shortcut definitions and display labels |
| `frontend/src/config/browserCommands.ts` | file-browser command registry for command-palette behavior |
| `frontend/src/hooks/useKeyboardShortcuts.ts` | shared hook, scope guard, and platform-aware modifier/label resolver |
| `frontend/src/utils/platform.ts` | single startup Apple-platform detector (`userAgentData.platform` with `navigator.platform` fallback and test override) |
| `frontend/src/pages/FileBrowser.tsx` | registers browser-level shortcuts and routes command actions |
| `frontend/src/pages/FileBrowser/FileBrowserPane.tsx` | handles strict file-list-focused folder-tab shortcuts (`Left`, `Right`, create, close) |
| `frontend/src/components/Viewer/` | consumes shared shortcut definitions for viewer behavior and tooltip labels |
| `frontend/src/components/Viewer/CodeMirrorFindReplacePopover.tsx` | shared compact find, match-option, and replacement controls for CodeMirror editors |

The system is intentionally split so shortcuts stay declarative while feature surfaces keep control of their own runtime behavior.

## Why the Registry Exists

Before the centralized model, shortcut keys, tooltip labels, and component handlers drifted apart easily.

The current approach preserves these rules:

- define shortcut keys and display intent once
- reuse the same definition across viewers and file-browser surfaces
- let components supply handlers without redefining labels and modifiers
- keep file-browser actions discoverable even when users do not know the shortcut

## Shortcut Definition Model

Shortcut definitions are grouped by scope, such as common viewer actions, PDF-specific actions, image-viewer actions, or browser actions.

Representative structure:

```typescript
export const COMMON_SHORTCUTS = {
  CLOSE: {
    id: "close",
    keys: "Escape",
    description: "Close",
    label: "Esc",
    allowInInput: true,
  },
  DOWNLOAD: {
    id: "download",
    keys: "s",
    description: "Download",
    label: "Ctrl+S",
    ctrl: true,
  },
} as const;
```

Common properties include:

- `id`: stable identifier
- `keys`: one key or multiple equivalent keys
- `description`: human-readable intent
- `label`: optional display label; omit it on platform-aware shortcuts so `formatShortcut` generates the platform-appropriate label
- `ctrl`, `shift`, `alt`: required modifiers
- `macControlForAlt`: optional flag that replaces `alt` with physical `Control` (excluding `Cmd`) on Apple platforms
- `allowInInput`: whether the shortcut still works while an input is focused
- `allowInInputWithin`: CSS selector scoping input-allowed shortcuts to a specific surface
- `priority`: ordering for overlapping shortcut candidates

## Platform-Aware Matching, Composition, and Generated Labels

`useKeyboardShortcuts.ts` resolves effective modifiers, key matching, and display labels through one shared helper (`resolveShortcutRules`) backed by `utils/platform.ts`, ensuring event matching, tooltips (`withShortcut`), command labels, and `KeyboardShortcutsHelp` never disagree:

- **macOS `Option` + ASCII letter fallback:** On macOS, holding `Option` alters `event.key` (for example `Option+Z` produces `Ω`). `matchesKeyboardShortcut` checks `event.key` first; on Apple platforms only, when `Option` is required and held and `event.key` does not match, ASCII-letter shortcut keys fall back to comparing `event.keyCode` against the letter's upper-case code (`65`–`90`), which follows the active keyboard layout (preserving layouts such as German `Z`/`Y`). Never use `keyCode` fallbacks for punctuation or digits, and keep Windows `AltGraph` (`Ctrl+Alt`) excluded from `Alt`-only shortcuts.
- **`macControlForAlt` for folder-tab bindings:** Folder-tab create and close shortcuts (`PANE_SHORTCUTS.NEW_TAB` and `CLOSE_TAB`) set `alt: true, macControlForAlt: true` on `+` and `-`. On Windows and Linux they match `Alt+Plus` and `Alt+Minus` by character (supporting Shift-produced `+` and numeric-keypad `+`/`-`). On macOS they require physical `Control` without `Cmd` or `Option` (`Control+Plus` and `Control+Minus`), avoiding browser `Cmd` zoom shortcuts and macOS punctuation remapping.
- **IME composition guard:** Both `useKeyboardShortcuts` and `isEventInKeyboardShortcutScope` ignore events with `event.isComposing === true`, including `Escape` presses that cancel active IME composition.
- **Generated labels:** When `label` is omitted, `formatShortcut` renders `"Option"` instead of `"Alt"` on Apple platforms and `"Control"` when `macControlForAlt` is active, collapses case-alternative pairs such as `["c", "C"]` to `"C"`, and formats `+` and `-` as `"Plus"` and `"Minus"`.

## Using the Shared Hook

Feature components bind runtime behavior through `useKeyboardShortcuts` instead of duplicating event parsing logic.

Typical usage:

```typescript
useKeyboardShortcuts({
  shortcuts: [
    {
      ...COMMON_SHORTCUTS.CLOSE,
      handler: onClose,
    },
    {
      ...COMMON_SHORTCUTS.DOWNLOAD,
      handler: handleDownload,
    },
    {
      ...PDF_SHORTCUTS.SEARCH,
      handler: handleOpenSearch,
    },
  ],
});
```

That split keeps the registry declarative and keeps feature logic in the feature component.

## Labels and Tooltip Reuse

Viewer controls and similar UI surfaces should reuse the same shortcut definition instead of duplicating string formatting.

The shared formatter can turn a shortcut definition into a tooltip label such as `Download (Ctrl+S)`.

That matters because a changed shortcut should update viewer behavior and visible affordances together.

## Browser Commands Versus Raw Shortcuts

The file browser uses both shortcut definitions and a command registry.

- shortcut definitions remain centralized in `keyboardShortcuts.ts`
- discoverable browser actions live in `browserCommands.ts`
- command definitions point back to shortcut identifiers when a keyboard binding exists

This lets Sambee expose browser actions through the quick bar even when the user does not know the shortcut.

Each browser command definition includes concepts such as:

- a stable `id`
- a user-facing `title`
- a `category` for command grouping
- linked shortcut identifiers
- `isEnabled(context)` for context-aware availability
- `run(context)` for execution
- `selectionFocusTarget` for post-selection focus behavior

## Quick-Bar Modes

The file browser quick bar supports three dropdown-backed provider modes:

- `Ctrl+K`: open smart directory navigation (`navigate` mode)
- `/`: open File Search across loaded current-directory entries and recent files (`file-search` mode)
- `Ctrl+P`: open command mode (`commands` mode)
- typing `>` as the first character in smart navigation switches into command mode

The quick bar captures the pane that opened it. In dual-pane mode, the target pane stays fixed even if the other pane becomes active before selection.

## Current Browser-Level and File-List Shortcuts

Current browser-level shortcuts include:

- `Ctrl+K`: open smart navigation
- `/`: open File Search
- `Ctrl+P`: show commands
- `Ctrl+Down`: open the connection selector
- `Ctrl+,`: open settings
- `?` or `F1`: show keyboard shortcuts help
- `Backspace`: go up one directory
- `Ctrl+Alt+T` (`Ctrl+Option+T` on macOS): open the active pane's location in a new browser tab
- `Ctrl+Left` / `Ctrl+Right`: match left or right pane location
- `Ctrl+R`: refresh file list
- `F2`: rename focused item
- `Delete`: delete focused item
- `Ctrl+D` / `Ctrl+U`: download selected items or upload files
- `F7` / `Shift+F7`: create new directory or file
- `Alt+F5` / `Alt+F9`: create or extract ZIP archive
- `Ctrl+Enter` / `Shift+Enter` / `Ctrl+Alt+Enter`: open in native app, Sambee viewer picker, or native app picker
- `Ctrl+B`: toggle dual-pane view
- `Tab`: switch active pane
- `F5` / `F6`: copy or move to the other pane

### File-List Surface Contract for Folder-Tab Shortcuts

Plain `Left` and `Right` (`PANE_SHORTCUTS.PREVIOUS_TAB` and `NEXT_TAB`) and folder-tab lifecycle bindings (`NEW_TAB`: `Alt+Plus` / `Control+Plus`; `CLOSE_TAB`: `Alt+Minus` / `Control+Minus`) are handled on the active `file-list-container` surface (`FileBrowserPane.tsx`) rather than as unrestricted document-level arrow shortcuts:

- They require `document.activeElement === listContainerEl` and `event.target === event.currentTarget`, checked alongside `isEventInKeyboardShortcutScope` before calling `preventDefault()`. Focus inside a nested row button, checkbox, menu, text input, viewer, or portalled dialog never triggers them.
- `file-list-container` remains mounted and focusable across populated, empty, loading, and failed directory states so keyboard users can always switch or close tabs.
- `Left` and `Right` wrap at ends and allow key repeat for traversal; `NEW_TAB`, `CLOSE_TAB`, and Undo ignore repeated keydown events.
- Tab-bar and breadcrumb buttons remain non-focusable (`tabIndex={-1}` with pointer focus prevention and committed file-list focus restoration), while `browser.newTab`, `browser.closeTab`, `browser.undoCloseTab`, `browser.previousTab`, and `browser.nextTab` expose every tab action in command mode.

`browser.focusLeftPane` and `browser.focusRightPane` remain available through command search without keyboard bindings. Do not register `Ctrl+1`, `Ctrl+2`, or their Meta equivalents for pane focus. These keys remain available to the browser. The right-pane command also opens dual-pane mode when only one pane is visible.

When changing these, treat the behavior as product-level interaction design rather than local implementation detail.

## Focus and Interaction Rules

Shortcut work often breaks focus behavior before it breaks functionality. Keep these rules intact:

- opening the quick bar focuses its input immediately
- selecting a navigation or command result returns focus to the relevant file list unless `selectionFocusTarget` specifies `"quick-bar"` or `"none"`
- commands that open dialogs or settings do not force focus back to the file list
- pane-switching and folder-tab shortcuts do not fire while the quick-bar input or any nested control is focused
- shortcuts that should work during text entry must explicitly opt in with `allowInInput` or `allowInInputWithin`
- shortcuts should be disabled when dialog state or viewer state would make them unsafe

## Context-Aware Shortcut Handling

When one key needs different behavior depending on state, prefer one context-aware handler over overlapping registrations.

For example, `Escape` may close a search panel when that panel is open, but close the viewer when it is not.

That pattern is better than registering multiple conflicting `Escape` shortcuts because:

- one shortcut definition stays authoritative
- behavior remains explicit in the component state logic
- conflicts are easier to reason about and test

### Priority as an Escape Hatch

In rare cases, multiple handlers for one key are unavoidable. The system supports a `priority` field so higher-priority candidates are evaluated first.

Use that sparingly. A context-aware handler is usually easier to understand and maintain than several competing registrations.

## Adding New Shortcuts Safely

When you add a shortcut, keep the workflow centralized.

1. define the shortcut in `config/keyboardShortcuts.ts`
1. bind it through `useKeyboardShortcuts` in the feature component
1. reuse the same definition for tooltip or help-surface labels
1. test both the runtime behavior and the visible affordance

Typical sequence:

```typescript
export const PDF_SHORTCUTS = {
  PRINT: {
    id: "print",
    keys: "p",
    description: "Print",
    label: "Ctrl+P",
    ctrl: true,
  },
} as const;
```

```typescript
useKeyboardShortcuts({
  shortcuts: [
    {
      ...PDF_SHORTCUTS.PRINT,
      handler: handlePrint,
    },
  ],
});
```

```typescript
title={withShortcut(PDF_SHORTCUTS.PRINT)}
```

Do not add one-off tooltip strings or imperative event parsing when the shortcut belongs in the shared system.