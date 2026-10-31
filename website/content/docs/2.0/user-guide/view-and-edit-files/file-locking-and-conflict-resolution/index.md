+++
title = "File Locking & Conflict Resolution"
+++

Sambee uses two protections that are easy to confuse:

- **Edit locks** stop a file from being edited simultaneously in two places.
- **Conflict resolution** happens later when Companion tries to upload a desktop-edited file back to the server and notices the server-side copy was changed, too.

## Edit Locks

Sambee uses edit locks on SMB connections to prevent other users from editing a file at the same time as you do.

### Browser Editing

Sambee acquires an edit lock before you can edit Markdown or plain-text files. Sambee releases the lock when you leave the editor.

If another session already holds the lock, the file stays read-only. Use **Retry editing** once the other session has finished.

While you're editing, Sambee renews the lock every 30 seconds. Short interruptions retry silently without interrupting your work. After three consecutive renewal failures, a warning appears. It clears when renewal succeeds, and saving still checks the lock.

If the server confirms that the lock is no longer active or write permission has been denied, the editor immediately becomes read-only and keeps your draft. Use **Retry editing** to regain access. If the saved file changed in the meantime, Sambee asks how to resolve the difference before you continue.

### Desktop Editing

Companion acquires an edit lock before downloading the temporary local copy.

If another user already holds that lock, the desktop-editing workflow cannot start.

When you upload, discard changes, or finish an unchanged session, Companion releases that lock.

## Conflict Resolution after Desktop Editing

Before uploading, Companion checks whether the server copy changed after the local copy was downloaded.

If it did, the **Done Editing** window switches to a conflict resolution dialog.

The choices are:

- **Overwrite Server Version**: replace the current server copy with your edited version
- **Save as Copy**: upload your changes as a separate `(conflict copy)` file
- **Cancel**: go back without uploading yet

## If a Desktop Editing Session is Interrupted

If Companion is closed during an editing session, it shows an **Unsaved Files Found** recovery dialog the next time it starts.

The choices are:

- **Upload**: send the saved local edits back to the server
- **Discard**: throw the temporary copy away
- **Later**: keep the session for later recovery
