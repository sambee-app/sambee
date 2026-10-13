+++
title = "Smart Navigation and the Quick Bar"
+++

The quick bar provides fast navigation, File Search, and commands from one shared control.

The quick bar has multiple modes:

- Smart navigation with <kbd>Ctrl</kbd> + <kbd>K</kbd>
- File Search with <kbd>/</kbd>
- Command mode with <kbd>Ctrl</kbd> + <kbd>P</kbd>

## Jump to Any Directory with Smart Navigation

1. Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to open smart navigation.
1. Type part of a directory name.
1. Sambee lists matches across the current connection.
1. Choose a match to open that directory.

### Recent Directory History

Recent directories appear before cache-based directory matches, including when the search box is empty. Choose a recent directory to switch to its connection and open the saved location. A directory that is both recent and present in the active connection's cache is shown once in Recent directories.

To remove only the selected item from Recent directories, press <kbd>Shift</kbd> + <kbd>Delete</kbd>. This removes history metadata; it never deletes the underlying directory or its contents.

Sambee records a directory after it opens successfully. History is private to your account. You can clear your directory history from **Settings** > **File Browser** > **Directory Navigation**.

## Find Files with File Search

1. Press <kbd>/</kbd> when the file browser has keyboard focus.
1. Type part of a filename.
1. Review the separate Recent files and Current directory groups.
1. Select a file and press <kbd>Enter</kbd> to open it.

File Search doesn't build a global file index. It searches the files currently loaded in the active directory and your per-user recent-file history. A file that appears in both places is shown once in Recent files.

Use modifiers with <kbd>Enter</kbd> or a result click to choose how to open the selected file:

- <kbd>Ctrl</kbd> opens it in the associated native application.
- <kbd>Shift</kbd> opens the browser viewer picker.
- <kbd>Ctrl</kbd> + <kbd>Alt</kbd> opens the native application picker.

To remove only a selected item from Recent files, press <kbd>Shift</kbd> + <kbd>Delete</kbd>. This removes history metadata; it never deletes the underlying file.

Recent files are recorded when you attempt to open a regular file. History is private to your account and follows the configured retention and exclusion policy. The system verifies remote SMB targets and local Companion targets as regular files before keeping a history record.

The File Search settings show whether Sambee is using the built-in defaults or an administrator's saved system override. Administrators can reset an override to the built-in defaults. Lowering retention removes the oldest records immediately, and setting retention to zero clears history and prevents new records. Image, temporary, backup, and configured extension exclusions apply before a record is stored.

If a recent remote file no longer exists, Sambee removes its stale history entry after confirming that state. For local drives, Companion distinguishes a missing or no-longer-regular file from an unavailable drive; confirmed stale targets are removed, while unavailable, unpaired, or temporarily failing local drives keep their history for a later retry.

You can clear your own history from **Settings** > **File Browser** > **File Search**. Administrators can set retention, per-group result limits, and exclusion rules in **Settings** > **File Search**. Add each extension exclusion as one literal extension; Sambee normalizes it, such as `TMP` to `.tmp`, and lets you remove it from the exclusion list.

## Quick Bar Shortcut Hints

Choose when shortcut hints appear in **Settings** > **File Browser** > **Shortcut hints**:

- **Auto** shows hints on larger layouts and after you use a keyboard in the current compact-layout session.
- **Always** shows hints in every layout.
- **Never** hides the shortcut labels while keeping Quick Bar status information visible.

## Desktop Mouse Selection

On desktop with touch selection off, click a file or folder name to open it, or click its icon to select it. Once an item is selected, the icons become selection controls and the pane's status bar shows the selected count. Click more icons to add or remove items. <kbd>Shift</kbd>-click an icon to add a range from the last selected item without losing earlier selections. <kbd>Ctrl</kbd> or <kbd>Cmd</kbd> with <kbd>Shift</kbd> also adds a range. Keyboard selection and icon selection share the same range anchor.

Click a row outside its icon, click empty list space, or press <kbd>Escape</kbd> to clear selection. The click that clears selection doesn't open a file; click again to open it. Sorting or starting File Search clears that pane's selection. Each pane keeps its own selection when you switch panes. Bulk actions use the selected items, while a focused item alone is not a selection.

## Touch-Friendly File Selection

Choose when touch-friendly file selection is available in **Settings** > **File Browser** > **File selection**. This keeps the desktop layout and toolbar on larger devices while making row selection easier to use by touch.

- **Automatic** enables touch selection when the browser reports a coarse primary pointer, which is typical for a tablet.
- **Always on** enables touch selection in every larger layout.
- **Off** leaves touch selection disabled in larger layouts.

Phone layouts always provide touch selection. When touch selection is available, select an item from its More actions menu or touch and hold its row. Tap additional rows to add or remove them from the selection, then use the selection controls at the bottom of the pane for bulk actions.

## Locate and Run Any Command

1. Press <kbd>Ctrl</kbd> + <kbd>P</kbd> to open command mode.
1. Type part of a command name.
1. Choose the command to run.
