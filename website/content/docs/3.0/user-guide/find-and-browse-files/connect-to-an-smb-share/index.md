+++
title = "Open Connections and Browse Folders"
+++

Choose an available SMB connection from the **Connection List** to open its files. Your browser accesses the share through the Sambee server; Companion is not required.

If no connection is available, add one if your account permits it or ask your administrator for access. Shared visibility does not grant permission to read or change the files. A read-only connection permits previews but not edits or transfers into it.

For bulk actions, see [Select Files and Folders](../select-files-and-folders/). To reach a deep folder quickly, use [directory navigation](../smart-navigation-and-the-quick-bar/).

## Keep Multiple Folders Open with Tabs

Each pane has its own folder tab bar above the breadcrumbs, working identically across SMB shares, local drives, and ZIP archives. You can open multiple folders—or duplicate tabs at the same folder—and switch between them without losing each tab's file selection, focused row, scroll position, or sort order.

- **Compact headers, All tabs menu, and close controls:** Tab headers show only the current folder or root name, and shrink to fit the pane without horizontal scrolling. Select the **All tabs** (`⌄`) button at the left of the tab bar (or hover over a tab) to inspect each tab's full connection and path, jump directly to hidden tabs when many are open, or close multiple tabs from one vertical list. Select **New tab** (`+`) to the right of the tabs to open another tab. Close any closable tab by middle-clicking it or selecting its close button (shown on hover with a mouse, or always visible on touch-friendly layouts and inside the **All tabs** menu).
- **Last-tab protection and recovery:** Each pane keeps at least one tab open. After closing a folder tab, select **Undo** in the notification or run **Undo Close Folder Tab** from command search (<kbd>Ctrl</kbd> + <kbd>P</kbd>) before the notice expires. Sambee restores your folder tabs automatically after you reload, reopen a closed browser window, restart the browser, or sign in again after your session expires. Signing out deletes your saved folder tabs in this browser.
- **Keyboard focus stays in the file list:** Tab headers and breadcrumbs don't take keyboard focus. While the file list owns focus, use <kbd>Left</kbd> and <kbd>Right</kbd> to switch tabs, and <kbd>Alt</kbd> + <kbd>Plus</kbd> / <kbd>Alt</kbd> + <kbd>Minus</kbd> (<kbd>Control</kbd> + <kbd>Plus</kbd> / <kbd>Control</kbd> + <kbd>Minus</kbd> on macOS) to open or close tabs. See [Keyboard Navigation and Shortcuts](../keyboard-navigation-and-shortcuts/) for all tab commands.

## Add a New Connection

Navigate to **Settings** > **Connections**, select **Add Connection**, and fill out the form.

Hints and tips:

- **Connection name:** This is the display name for the connection in Sambee's UI.
- **Path prefix:** If you specify a subdirectory in the share, Sambee's connection root will start in that subdirectory.
- **Visibility:** Connections can be for your account only or for all users on the Sambee server.
- **Access mode:** If you want to prevent modifications to the data on the share, set this to **read only**.
