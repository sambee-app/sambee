+++
title = "Find Files and Return to Recent Locations"
+++

The quick bar provides fast navigation, File Search, and commands from one shared control.

The quick bar has multiple modes:

- Smart navigation with <kbd>Ctrl</kbd> + <kbd>K</kbd>
- File Search with <kbd>/</kbd>
- Command mode with <kbd>Ctrl</kbd> + <kbd>P</kbd>

## Jump to Any Directory with Smart Navigation

Press <kbd>Ctrl</kbd> + <kbd>K</kbd> to search indexed directory paths, recent files and folders, and files in the open folder. For example, `image` matches `image.png` in the open folder even if you have never opened the file.

Use the scope control to search the current connection, the current folder and its subfolders, or subfolders only. Use the item-type control to show files, folders, or both. These controls also apply to recent history. Inside a ZIP, folder scope starts at the physical folder that contains the ZIP.

Press <kbd>Escape</kbd> to clear the search term and return to the file list. If an options menu is open, the first press closes only the menu.

**Subfolders only** excludes files directly in the open folder. To find other files outside the open folder or search inside ZIP files, use File Search (<kbd>/</kbd>).

Results can be incomplete while Sambee scans folders. During a scan, the status shows directories found or directories checked. An interrupted scan keeps committed progress for its next attempt. If a folder is missing from search, browse to it directly.

Status messages identify the connection. **Not all directories could be indexed** means some eligible folders could not be read or validated; available results remain usable. When additional information is available, the message ends with a **details** link. The dialog shows affected locations, reasons, and corrective actions, or specific request-error details. The link is outside keyboard navigation so focus stays in the quick bar.

Directory details are a limited sample from the current running source, not a full error history. They can be unavailable after a restart until another scan collects them. A location marked **Containing directory** has an affected entry whose name is unavailable. Check the listed permissions or names when applicable. Junctions, symbolic links, and other redirected descendants are ignored: they do not appear in the dialog or cause an incomplete-index warning.

If directory search is temporarily unavailable, the quick bar keeps recent history and results already shown for the same search. It checks for recovery while open. A paused status does not mean that a scan is still running. Restore source access if the message reports a connection problem; direct browsing can remain available while search recovers.

Directory search can stay up to date while the quick bar is closed. After a restart or a break in monitoring, results can remain unverified while background checks run. Missing removable media keeps its saved index; insert or mount the volume again to resume search. SMB search includes ordinary folders inside the configured share and folder, including server-mounted storage. Local search does not cross into other mounts. Redirects and reparse points are excluded.

### Recent Files and Folders

With an empty search box, Quick navigation shows recent files and folders together, newest first, in the current connection and scope. These remain available while directory search loads.

To remove the selected item from history, press <kbd>Shift</kbd> + <kbd>Delete</kbd>. This does not delete the file or folder.

Use <kbd>Ctrl</kbd> + <kbd>Enter</kbd> to open a selected file in its associated native application, <kbd>Shift</kbd> + <kbd>Enter</kbd> to choose a browser viewer, or <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>Enter</kbd> to choose a native application. The same modifiers work with a click.

History is private to your account. See [File Browser Preferences](../../account-and-preferences/file-browser-preferences/#clear-personal-history) to clear it.

### Missing or Inaccessible Folders

Recently visited folders can show their saved listing at once. If that listing needs an update, Sambee keeps it visible while a progress bar shows the pending request. Use Refresh when you need a new listing immediately.

If a folder cannot be opened and has no usable saved listing, Sambee keeps your current location. If the open folder, a saved folder being checked, or a directly linked folder no longer exists, Sambee tries an accessible parent instead. Follow the displayed recovery action if access fails.

Confirmed missing folders are removed from recent history. Temporary connection or permission problems keep the history entry for another attempt.

## Find Files with File Search

Press <kbd>/</kbd> when the file browser has keyboard focus. Enter a name and press <kbd>Enter</kbd> to start a live search in a new results tab. The search reads the current folder and its subfolders by default. It searches names, not file contents, and does not depend on the directory index.

Plain text matches part of a name. Use `*` for any number of characters or `?` for one character to match a whole name. A backslash escapes `*`, `?`, or another backslash. Search ignores case by default.

Search options appear below the quick bar when the search box has focus. Use <kbd>↑</kbd> and <kbd>↓</kbd> to move through the options and <kbd>Space</kbd> to change one. Press <kbd>Escape</kbd> to close the options without clearing the search term. Press <kbd>Escape</kbd> again to clear the term and return to the file list. To reopen the options, press an up or down arrow key in the search box or click the box.

ZIP search is off by default because reading each ZIP adds work and can add network requests. Turn it on to search members of ZIPs found in the selected folder scope. Very large ZIPs are skipped. A search started inside an open ZIP searches from the current ZIP folder, even when ZIP discovery is off. Nested ZIPs are not opened. Encrypted members and members with unsupported compression can appear in results, but cannot be opened.

Results appear as the scan progresses. A yellow bar above the list shows activity during longer searches. The row above the list shows the search term and the path where you started the search, including the ZIP and its internal folder when applicable. To tell matches with the same name apart, check their parent paths. These paths are relative to the starting folder. A blank location means the match is directly in that folder.

Press <kbd>Enter</kbd> to open the focused result without waiting for the scan to finish. In the image viewer, use Left Arrow and Right Arrow to browse matching images on the same connection or within the same ZIP. The viewer uses the results available when it opens. To include newer matches, close the viewer and open an image again.

Folders open in a normal tab. Quick navigation from a results tab also opens the target folder in a new tab, so the results stay available. You can download a supported selection, but other changes are disabled in results tabs. Results tabs close when you reload or close the page. Close the results tab to stop its scan.

The default time limit is 60 seconds. A scan can stop at an administrator-defined time or result limit, or report folders and ZIPs it could not read. A notice reports these conditions, and the status area keeps the scan status and result count. Existing results remain available, but they might not be complete. Narrow the scope or query and search again.

Local-drive live search is not available on macOS. Browse the local folder directly instead.

## Locate and Run Any Command

For bulk actions, see [Select Files and Folders](../select-files-and-folders/).

1. Press <kbd>Ctrl</kbd> + <kbd>P</kbd> to open command mode.
1. Type part of a command name.
1. Choose the command to run.
