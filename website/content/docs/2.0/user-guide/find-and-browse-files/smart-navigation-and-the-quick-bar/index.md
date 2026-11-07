+++
title = "Find Files and Return to Recent Locations"
+++

The quick bar provides fast navigation, File Search, and commands from one shared control.

The quick bar has multiple modes:

- Smart navigation with <kbd>Ctrl</kbd> + <kbd>K</kbd>
- File Search with <kbd>/</kbd>
- Command mode with <kbd>Ctrl</kbd> + <kbd>P</kbd>

## Jump to Any Directory with Smart Navigation

Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to search directory paths across the current connection and your recent locations. For example, `annual reports` finds paths containing either term, with matches for both terms ranked first.

Results can be incomplete while Sambee scans folders. During a scan, the status shows directories found or directories checked. An interrupted scan keeps committed progress for its next attempt. If a folder is missing from search, browse to it directly.

Status messages identify the connection. **Not all directories could be indexed** means some eligible folders could not be read or validated; available results remain usable. When additional information is available, the message ends with a **details** link. The dialog shows affected locations, reasons, and corrective actions, or specific request-error details. The link is outside keyboard navigation so focus stays in the quick bar.

Directory details are a limited sample from the current running source, not a full error history. They can be unavailable after a restart until another scan collects them. A location marked **Containing directory** has an affected entry whose name is unavailable. Check the listed permissions or names when applicable. Junctions, symbolic links, and other redirected descendants are ignored: they do not appear in the dialog or cause an incomplete-index warning.

If directory search is temporarily unavailable, the quick bar keeps recent history and results already shown for the same search. It checks for recovery while open. A paused status does not mean that a scan is still running. Restore source access if the message reports a connection problem; direct browsing can remain available while search recovers.

Directory indexes are reused after a restart. Results can remain unverified while background checks run. Missing removable media keeps its saved index; insert or mount the volume again to resume search. SMB search includes ordinary folders inside the configured share and folder, including server-mounted storage. Local search does not cross into other mounts. Redirects and reparse points are excluded.

### Recent Directory History

With an empty search box, Recent directories shows your saved locations across connections. These remain available while directory search loads.

To remove only the selected item from Recent directories, press <kbd>Shift</kbd> + <kbd>Delete</kbd>. This removes history metadata; it never deletes the underlying directory or its contents.

History is private to your account. See [File Browser Preferences](../../account-and-preferences/file-browser-preferences/#clear-personal-history) to clear it.

### Missing or Inaccessible Folders

If a folder cannot be opened, Sambee keeps your current location. If the open folder or a directly linked folder no longer exists, Sambee tries an accessible parent instead. Follow the displayed recovery action if access fails.

Confirmed missing folders are removed from recent history. Temporary connection or permission problems keep the history entry for another attempt.

## Find Files with File Search

Press <kbd>/</kbd> when the file browser has keyboard focus to search loaded filenames in the active directory and your recent-file history. It does not search all files or file contents. Files matching more search terms rank first.

Use modifiers with <kbd>Enter</kbd> or a result click to choose how to open the selected file:

- <kbd>Ctrl</kbd> opens it in the associated native application.
- <kbd>Shift</kbd> opens the browser viewer picker.
- <kbd>Ctrl</kbd> + <kbd>Alt</kbd> opens the native application picker.

To remove only a selected item from Recent files, press <kbd>Shift</kbd> + <kbd>Delete</kbd>. This removes history metadata; it never deletes the underlying file.

Confirmed missing files are removed from recent history. Temporary access problems keep the entry for another attempt. If a native application does not open the file, check Companion or the application for an error.

## Locate and Run Any Command

For bulk actions, see [Select Files and Folders](../select-files-and-folders/).

1. Press <kbd>Ctrl</kbd> + <kbd>P</kbd> to open command mode.
1. Type part of a command name.
1. Choose the command to run.
