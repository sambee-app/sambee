+++
title = "What's New"
+++

## Tabs

Open multiple tabs for the locations you need most often and switch between them efficiently. Tabs are available in single-pane as well as in dual-pane mode and in all screen sizes, from phone to desktop. Tabs are restored automatically after a page reload, a browser restart, a browser tab reopen, or a new sign-in after session expiry. Keyboard shortcuts:

- New tab: <kbd>Alt+Plus</kbd>
- Close tab: <kbd>Alt+Minus</kbd>
- Navigate between tabs: <kbd>Arrow left</kbd> and <kbd>Arrow right</kbd>

## UI Translations

Sambee's UI (frontend and Companion) is now available in the following languages: English, Chinese (Simplified), Dutch, French, German, Italian, Korean, Japanese, Polish, Portuguese, Spanish, Swedish. To change the interface language, use **Settings** > **Appearance** > **Localization** > **Language**.

The localization preview in settings shows the resolved language and regional locale, including browser defaults. Language and regional settings changes now synchronize correctly to Companion.

Sambee opts out of automatic page translation in Chrome (translation may cause UI errors).

## System Health Monitoring

Sambee now shows the system health status in the top-right corner. In the built-in themes, the button background is blue for an unknown status, orange for a warning, and red for an error. When the status is OK, the button has no status color. Select the icon or use <kbd>Ctrl+P</kbd> and choose **Open System Health** to see details about the server, Sambee container, and connected storage.

## Quick Bar

### Live File System Search

Search for files and folders on SMB connections and local drives. Live search mode (<kbd>/</kbd>) starts a real-time search and displays matching files/folders in a results tab. Search can include ZIP members and works independently of directory indexing. Administrators can set scan time, result, and concurrency limits.

### Quick Navigation

Index-based directory navigation and recent file access have been combined into quick navigation (<kbd>Ctrl+K</kbd>), with scope and item-type controls.

### Improvements

- Directory navigation: Reopening search after 10 minutes of inactivity no longer triggers a full verification scan. The healthy verification interval defaults to 24 hours and is configurable in settings.
- The quick bar's mode (navigate/search/command) is now visualized with a pill button.
- Fixed result menu flickering while typing in directory navigation mode.

## Markdown Viewer

### Improvements

- Links in printed documents are now underlined and use the theme's link color instead of black.

## Security

- Updated all dependencies with known issues or vulnerabilities to fixed versions.

## Miscellaneous

- File list: The row height has been reduced on non-touch devices to increase information density.
- File list: Fixed keyboard focus issues. When you create a folder, focus moves to the new folder. When you open a folder, focus moves to its first item. When you go up one level, focus returns to the folder you just left.
- Companion settings sync: Pairing a new browser now moves Companion settings authority to that browser. When a browser is unpaired, authority moves to the most recently paired browser that remains. Companion repairs a missing or stale authority after restart, and browser tabs resume settings delivery automatically when they become the authority again.
