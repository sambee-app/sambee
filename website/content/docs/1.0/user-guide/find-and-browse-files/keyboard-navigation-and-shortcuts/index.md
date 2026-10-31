+++
title = "Keyboard Navigation and Shortcuts"
+++

Keyboard navigation is a first-class part of Sambee.

## Keyboard-First Principles

- Focus matters: Shortcuts act on the item that currently has focus.
- The active pane matters: In dual-pane mode, many file browser commands target the currently active pane.
- Important actions stay discoverable: The same actions are also available through visible controls and the in-app shortcuts help.
- Safety still wins: Shortcuts that would be unsafe in text fields, dialogs, or incompatible states are intentionally blocked.

If you want the live in-app list, press <kbd>?</kbd> or <kbd>F1</kbd>. While editing Markdown or text, use <kbd>F1</kbd> so you can type question marks normally.

## File List and Main UI

Use these shortcuts when the main file list or browser shell has focus.

| Shortcut | What it does |
| --- | --- |
| <kbd>Up</kbd> / <kbd>Down</kbd> | Move to the previous or next row in the current file list |
| <kbd>Home</kbd> / <kbd>End</kbd> | Jump to the first or last visible item |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | Move up or down by a page in the current list |
| <kbd>Enter</kbd> | Open the focused file or enter the focused directory |
| <kbd>Backspace</kbd> | Go up to the parent directory |
| <kbd>Ctrl</kbd> + <kbd>Down</kbd> | Open the connection selector |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> | Open smart navigation |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>F</kbd> | Filter the current directory in the active pane |
| <kbd>Ctrl</kbd> + <kbd>P</kbd> | Open commands |
| <kbd>Ctrl</kbd> + <kbd>,</kbd> | Open settings |
| <kbd>?</kbd> / <kbd>F1</kbd> | Show keyboard shortcuts help |
| <kbd>Ctrl</kbd> + <kbd>R</kbd> | Refresh the current file list |
| <kbd>F2</kbd> | Rename the focused item |
| <kbd>Del</kbd> | Delete the focused item |
| <kbd>Ctrl</kbd> + <kbd>D</kbd> | Download the selected items, or the focused item if nothing is selected |
| <kbd>Ctrl</kbd> + <kbd>U</kbd> | Upload files to the current writable folder |
| <kbd>F7</kbd> | Create a new directory |
| <kbd>Shift</kbd> + <kbd>F7</kbd> | Create a new file |
| <kbd>Ctrl</kbd> + <kbd>Enter</kbd> | Open the focused file in the companion app |

When the focused item is a local shortcut or filesystem link, Sambee resolves its target before activating it. A directory target opens in its drive and directory, including a different local drive. A file target follows the same behavior as opening that file directly: <kbd>Enter</kbd> uses the selected viewer, while <kbd>Ctrl</kbd> + <kbd>Enter</kbd> opens it in the companion app. If the target is missing or inaccessible, Sambee shows an error instead of opening the link itself.

## Selection and Dual-Pane Workflows

These shortcuts matter most when you are working keyboard-first across one or two panes.

| Shortcut | What it does |
| --- | --- |
| <kbd>Ins</kbd> or <kbd>Space</kbd> | Toggle selection on the focused item and move down |
| <kbd>Shift</kbd> + <kbd>Up</kbd> / <kbd>Shift</kbd> + <kbd>Down</kbd> | Extend selection upward or downward |
| <kbd>Ctrl</kbd> + <kbd>A</kbd> | Select all items in the current list |
| <kbd>Ctrl</kbd> + <kbd>B</kbd> | Toggle dual-pane mode |
| <kbd>Ctrl</kbd> + <kbd>1</kbd> / <kbd>Ctrl</kbd> + <kbd>2</kbd> | Focus the left or right pane |
| <kbd>Tab</kbd> | Move focus to the other pane |
| <kbd>F5</kbd> / <kbd>F6</kbd> | Copy or move selected items to the other pane |

## Viewers

Viewers share a common keyboard model for closing, searching, paging, and visual controls.

| Shortcut | What it does |
| --- | --- |
| <kbd>Esc</kbd> | Close the viewer |
| <kbd>D</kbd> | Download the current file |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> | Search inside supported viewers |
| <kbd>F3</kbd> / <kbd>Shift</kbd> + <kbd>F3</kbd> | Jump to the next or previous search result |
| <kbd>Home</kbd> / <kbd>End</kbd> | Jump to the first or last page or item |
| <kbd>Page Up</kbd> / <kbd>Page Down</kbd> | Move to the previous or next page |
| <kbd>Left</kbd> / <kbd>Right</kbd> | Move to the previous or next page or item |
| <kbd>+</kbd> / <kbd>-</kbd> | Zoom in or out |
| <kbd>0</kbd> | Reset zoom |
| <kbd>R</kbd> / <kbd>Shift</kbd> + <kbd>R</kbd> | Rotate right or left |
| <kbd>F</kbd> | Toggle fullscreen |
| <kbd>?</kbd> / <kbd>F1</kbd> | Show keyboard shortcuts help |

Some viewer shortcuts depend on the file type. For example, search applies to searchable viewers, and page navigation applies to paged or gallery-style viewers.

## Markdown Editor

Markdown files build on the shared viewer shortcuts and add editor-specific formatting actions.

| Shortcut | What it does |
| --- | --- |
| <kbd>E</kbd> | Switch a Markdown file from viewing to editing |
| <kbd>Ctrl</kbd> + <kbd>S</kbd> | Save the current Markdown file |
| <kbd>Ctrl</kbd> + <kbd>B</kbd> | Toggle bold text |
| <kbd>Ctrl</kbd> + <kbd>I</kbd> | Toggle italic text |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> | Search in the current Markdown content |
| <kbd>Ctrl</kbd> + <kbd>H</kbd> | Open find and replace for the current Markdown content |
| <kbd>F3</kbd> / <kbd>Shift</kbd> + <kbd>F3</kbd> | Jump to the next or previous search result |
| <kbd>Enter</kbd> in the Replace field | Replace the current match |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Enter</kbd> in the Replace field | Replace all matches |
| <kbd>Alt</kbd> + <kbd>C</kbd> | Toggle case-sensitive matching while the find panel is open |
| <kbd>Alt</kbd> + <kbd>W</kbd> | Toggle whole-word matching while the find panel is open |
| <kbd>Alt</kbd> + <kbd>R</kbd> | Toggle regular-expression matching while the find panel is open |
| <kbd>Alt</kbd> + <kbd>Z</kbd> | Toggle word wrap |
| <kbd>F1</kbd> | Show Text editor shortcuts |
| <kbd>Ctrl</kbd> + <kbd>K</kbd> | Create a link |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd> | Insert a table |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>H</kbd> | Insert a thematic break |
| <kbd>Ctrl</kbd> + <kbd>E</kbd> | Apply inline code |
| <kbd>Ctrl</kbd> + <kbd>Shift</kbd> + <kbd>E</kbd> | Insert a code block |
| <kbd>F1</kbd> | Show Markdown editor shortcuts |
| <kbd>Esc</kbd> | Close the Markdown viewer |

Find and replace opens as a compact panel in the upper-right of the viewer, with a small margin below the toolbar. It shows the current match and total result count. Use the visible previous, next, replace, and replace-all controls after entering a search. The fields display `Search (⇅ for history)` and `Replace (⇅ for history)` until you type; each keeps up to ten recent values locally, available with <kbd>Up</kbd> and <kbd>Down</kbd>. Invalid regular expressions are reported without changing the document.

## Text Editor

Text files use the same CodeMirror find controls as the Markdown editor. Find is available while viewing or editing a supported text file; replace is available while editing.

| Shortcut | What it does |
| --- | --- |
| <kbd>Ctrl</kbd> + <kbd>F</kbd> | Search in the current text content |
| <kbd>Ctrl</kbd> + <kbd>H</kbd> | Open find and replace while editing |
| <kbd>F3</kbd> / <kbd>Shift</kbd> + <kbd>F3</kbd> | Jump to the next or previous search result |
| <kbd>Enter</kbd> in the Replace field | Replace the current match |
| <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Enter</kbd> in the Replace field | Replace all matches |
| <kbd>Alt</kbd> + <kbd>C</kbd> | Toggle case-sensitive matching while the find panel is open |
| <kbd>Alt</kbd> + <kbd>W</kbd> | Toggle whole-word matching while the find panel is open |
| <kbd>Alt</kbd> + <kbd>R</kbd> | Toggle regular-expression matching while the find panel is open |
| <kbd>Alt</kbd> + <kbd>Z</kbd> | Toggle word wrap |

## When to Use the Built-In Shortcut Help

This page summarizes the most useful keyboard shortcuts by UI area.

Use the built-in shortcuts help when you want the live in-app list for your current screen, or when you want a quick reminder without leaving the file browser.
