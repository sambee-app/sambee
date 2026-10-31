+++
title = "Access Local Drives"
+++

Local-drive access is available after Sambee Companion is [installed and paired](../../use-local-drives-and-desktop-apps/install-and-pair-the-companion-app/).

## Before You Start

Local drives in the browser require all of the following:

- a desktop browser
- Sambee Companion installed and running on the same computer
- a completed trust approval for this browser

If any of those pieces is missing, continue with [Install and Pair the Companion App](../../use-local-drives-and-desktop-apps/install-and-pair-the-companion-app/).

## Explore Local Drives

When Companion is running and this browser is paired, local drives appear in the **Connection List** next to SMB connections (keyboard shortcut: <kbd>Ctrl</kbd> + <kbd>Down</kbd>).

The list reflects the drives and mounted volumes that the current desktop user can already access through the operating system. Typical examples include:

- **Disks**, e.g., `C:\`
- **Removable drives**, such as USB storage.
- **Mapped network drives**, e.g., SMB connections mounted by the operating system.
- **Virtual or cloud-backed drives**, e.g., from Google Drive, OneDrive, or Dropbox.

Sambee asks Companion for the current drive list when needed. You do not need to configure local drives manually in the browser.

## If Local Drives Do Not Appear

Open **Settings** > **Local Drives** and check the current status.

- If Companion is not running, start it and refresh the page.
- If the browser is not paired, pair this browser with Companion.
- If Local Drives reports that pairing needs repair, reapprove this browser so Sambee can store a fresh local browser secret.

For a step-by-step recovery checklist, continue with [Common User Problems](../../troubleshooting/common-user-problems/).
