+++
title = "Find Files and Return to Recent Locations"
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

History is private to your account. See [File Browser Preferences](../../account-and-preferences/file-browser-preferences/#clear-personal-history) to clear it.

## Find Files with File Search

1. Press <kbd>/</kbd> when the file browser has keyboard focus.
1. Type part of a filename.
1. Review the separate Recent files and Current directory groups.
1. Select a file and press <kbd>Enter</kbd> to open it.

File Search searches names in the active directory's loaded files and your recent-file history. It is not a global file index and does not search contents. A file in both groups appears once in Recent files.

Use modifiers with <kbd>Enter</kbd> or a result click to choose how to open the selected file:

- <kbd>Ctrl</kbd> opens it in the associated native application.
- <kbd>Shift</kbd> opens the browser viewer picker.
- <kbd>Ctrl</kbd> + <kbd>Alt</kbd> opens the native application picker.

To remove only a selected item from Recent files, press <kbd>Shift</kbd> + <kbd>Delete</kbd>. This removes history metadata; it never deletes the underlying file.

If a recent remote file no longer exists, Sambee removes its stale history entry after confirming that state. For local drives, Companion distinguishes a missing or no-longer-regular file from an unavailable drive; confirmed stale targets are removed, while unavailable, unpaired, or temporarily failing local drives keep their history for a later retry.

## Locate and Run Any Command

For bulk actions, see [Select Files and Folders](../select-files-and-folders/).

1. Press <kbd>Ctrl</kbd> + <kbd>P</kbd> to open command mode.
1. Type part of a command name.
1. Choose the command to run.
