+++
title = "Common User Problems"
+++

## Cannot Sign In

Use the sign-in method supplied by your administrator. If local password sign-in is unavailable, use your organization's identity provider. Ask your administrator to check your account and site authentication if sign-in fails repeatedly.

## Cannot See a Connection

Ask the connection owner or administrator to check visibility and your access. A shared connection does not grant file-server permissions. See [Open Connections and Browse Folders](../../find-and-browse-files/connect-to-an-smb-share/).

## Cannot Open a File

Check that the connection is available and the file still exists. If its viewer does not support the format, download the original or use an installed desktop app. See [Supported File Formats](../../reference/supported-file-formats/).

## Cannot Save

Check write access and close other edit sessions for that file. Preserve unsaved work before reloading or signing out. See [File Locking and Conflict Resolution](../../view-and-edit-files/file-locking-and-conflict-resolution/) and [View and Edit Text Files](../../view-and-edit-files/view-and-edit-text-files/).

## Cannot Complete a Transfer

Inspect both source and destination after failure or cancellation. Earlier completed items can remain. Do not repeat a move or delete a source until you know which copies are complete. Keep files whose status is uncertain and ask for help with the reported error. See [Copy and Move Files](../../organize-and-transfer-files/copy-and-move-files/).

## Cannot Share

If the browser or device cannot share an attachment, download it and use your device's file app. Sending a location link does not grant access. See [Share Files on Phones and Tablets](../../organize-and-transfer-files/share-files-on-phones-and-tablets/).

## Local Drives Are Not Available

Local drives in the browser require a desktop browser, Sambee Companion, and a working browser pairing.

Work through this checklist:

1. Confirm that you are using a desktop browser. Local-drive access is not available on iPhone, iPad, or Android browsers.
1. Confirm that Sambee Companion is installed and running on the same computer as the browser.
1. Open **Settings** > **Local Drives** and check the current status.
1. If Sambee shows **Waiting for approval**, finish or reject the request in the Companion pairing window.
1. If Sambee shows that this browser needs repair, start pairing again to restore the browser-side secret.
1. If you closed the pairing dialog earlier, start a new pairing request. Pending requests are cancelled when either side closes the pairing UI.

If you still need the full setup flow, continue with [Install and Pair the Companion App](../../use-local-drives-and-desktop-apps/install-and-pair-the-companion-app/) and [Access Local Drives](../../use-local-drives-and-desktop-apps/access-local-drives/).

## Open in Desktop App Does Nothing

This usually means Sambee Companion is not running, or the browser blocked the handoff to the helper app.

Check these first:

- Confirm that Sambee Companion is running on your computer.
- Allow the browser to open the `sambee://` link if the browser asks for permission.
- On Linux, confirm that the deep-link handler is registered with `xdg-mime query default x-scheme-handler/sambee`.

Start with [Install and Pair the Companion App](../../use-local-drives-and-desktop-apps/install-and-pair-the-companion-app/) if Companion may not be installed or running yet.

Normal desktop-editing workflow: [Edit Files in Desktop Apps](../../use-local-drives-and-desktop-apps/edit-files-in-desktop-apps/).

## Changes Do Not Upload Back after Editing

The Companion session may have been interrupted.

See: [File Locking & Conflict Resolution](../../view-and-edit-files/file-locking-and-conflict-resolution/).
