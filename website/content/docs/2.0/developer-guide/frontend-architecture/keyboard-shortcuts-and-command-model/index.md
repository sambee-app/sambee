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
| `frontend/src/hooks/useKeyboardShortcuts.ts` | shared hook that binds shortcut definitions to runtime handlers |
| `frontend/src/pages/FileBrowser.tsx` | registers browser-level shortcuts and routes command actions |
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
- `label`: optional display label; if omitted, it can be generated from the config
- `ctrl`, `shift`, `alt`: required modifiers
- `allowInInput`: whether the shortcut still works while an input is focused
- `priority`: ordering for overlapping shortcut candidates

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

The file browser quick bar is not just a text filter. It supports multiple modes with different intent.

- `Ctrl+K`: open the smart navigation surface
- `Ctrl+Alt+F`: open pane-local current-directory filter mode
- `Ctrl+P`: open command mode directly
- typing `>` as the first character switches the quick bar into command mode

Smart navigation and command mode are dropdown-backed provider modes. Filter mode deliberately is not.

- `smart` mode uses the search provider composition that merges directory navigation and command escape-hatch behavior
- `commands` mode uses the browser command registry directly
- `filter` mode uses the same input shell, but as a controlled pane-local filter box with dropdown rendering disabled

The quick bar captures the pane that opened it. In dual-pane mode, the active quick-bar pane stays fixed even if the other pane becomes active before selection.

That capture rule matters especially for filter mode, because the filter text belongs to the pane state, not to the shared quick-bar component.

### Current-Directory Filter Mode

`Ctrl+Alt+F` is now a real current-directory filter workflow, not a smart-navigation alias.

The implemented contract is:

- the active pane opens the quick bar in `filter` mode
- the quick bar shows that pane's `currentDirectoryFilter` as a controlled value
- typing filters the pane's visible file list immediately
- no dropdown results are shown in this mode
- `ArrowDown` hands focus from the input into the pane's file list
- `Escape` clears the filter first, then returns focus to the file list when the input is already empty

The filter state is pane-local and scoped to the current `connectionId + path`.

- switching between `smart`, `commands`, and `filter` modes does not clear the current directory filter
- navigating to a different directory clears the filter for the new scope
- changing the pane's connection also clears the filter for the new scope
- the status bar remains the persistent reminder that a filter is active even when the quick bar is in another mode

## Current Browser-Level Shortcuts

Current browser-level shortcuts include:

- `Ctrl+K`: open smart navigation
- `Ctrl+Alt+F`: focus current-directory filter mode for the active pane
- `Ctrl+P`: show commands
- `Ctrl+,`: open settings
- `?` or `F1`: show keyboard shortcuts help
- `Backspace`: go up one directory
- `Ctrl+R`: refresh file list
- `F2`: rename focused item
- `Delete`: delete focused item
- `F7`: create new directory
- `Shift+F7`: create new file
- `Ctrl+Enter`: open focused file in the companion app
- `Ctrl+B`: toggle dual-pane view
- `Tab`: switch active pane
- `F5`: copy to the other pane
- `F6`: move to the other pane

`browser.focusLeftPane` and `browser.focusRightPane` remain available through command search without keyboard bindings. Do not register `Ctrl+1`, `Ctrl+2`, or their Meta equivalents for pane focus. These keys remain available to the browser. The right-pane command also opens dual-pane mode when only one pane is visible.

When changing these, treat the behavior as product-level interaction design rather than local implementation detail.

## Focus and Interaction Rules

Shortcut work often breaks focus behavior before it breaks functionality. Keep these rules intact:

- opening the quick bar focuses its input immediately
- selecting a navigation result returns focus to the relevant file list
- selecting commands that switch quick-bar modes keeps focus inside the quick bar
- `ArrowDown` from current-directory filter mode moves focus into the filtered file list
- current-directory filter mode does not open a dropdown for local matches
- `Escape` in filter mode clears the active filter before it hands focus back to the file list
- commands that open dialogs or settings do not force focus back to the file list
- pane-switching shortcuts do not fire while the quick-bar input is focused
- shortcuts that should work during text entry must explicitly opt in with `allowInInput`
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