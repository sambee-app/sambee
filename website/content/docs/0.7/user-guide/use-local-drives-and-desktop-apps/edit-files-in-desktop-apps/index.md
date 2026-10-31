+++
title = "Edit Files in Desktop Apps"
+++

Sambee can open files in installed desktop apps through its Companion helper. If the file is on a local drive, the desktop app can access it directly. In that case, Companion opens the app with the original file path.

For an SMB connection, Companion opens a temporary local copy. Your explicit upload returns changes to the original share; this is not automatic synchronization.

The remainder of this page describes the second case.

## Before You Begin

You need:

- Sambee Companion installed and running on your computer.
- A desktop app that can open the file type you want to edit.

Need Companion first? Start with [Install and Pair the Companion App](../../use-local-drives-and-desktop-apps/install-and-pair-the-companion-app/).

## Start the Editing Workflow

In Sambee, right-click the file and choose **Open in companion app**, or press <kbd>Ctrl</kbd> + <kbd>Enter</kbd>.

{{< admonition type="tip" >}}
Sambee hands the request to Companion through a `sambee://` link. When your browser asks whether to allow that link to open, choose **yes**.
{{< /admonition >}}

{{< admonition type="note" >}}
If your Sambee site is behind a proxy server, Companion may show a separate **Sambee Authentication** window before opening the file. Sign in there and then continue the desktop-editing workflow.
{{< /admonition >}}

Companion locks the SMB file for the session and shows **Done Editing** beside the installed app. You need write access to upload edits. For local-drive access, also complete [browser pairing](../install-and-pair-the-companion-app/).

## Choose an App to Open the File

The first time you open a file type, Companion may show an app picker listing the installed apps available for that file type. Choose an app from the list for that extension and optionally remember that choice for later. For app-selection help, use [Desktop App Picker](../../use-local-drives-and-desktop-apps/desktop-app-picker/).

## Finish the Editing Session

Closing the desktop app by itself does not upload the file and does not finish the session. Uploading is initiated in the **Done Editing** window.

- Changed file: use **Done Editing — Hold to Upload**.
- Unchanged file: use **Done Editing — Hold to Close**.
- Do not want to keep the local changes: use **Discard Changes — Hold**.

If the **Done Editing** window tells you that the session expired, authentication failed, the lock was lost, or recovery is required, reopen the file from Sambee instead of retrying the old desktop-editing session indefinitely. That starts a fresh authenticated edit session with a new server-side lock.

Preserve any unsent local work before reopening. See [File Locking and Conflict Resolution](../../view-and-edit-files/file-locking-and-conflict-resolution/) for recovery.
