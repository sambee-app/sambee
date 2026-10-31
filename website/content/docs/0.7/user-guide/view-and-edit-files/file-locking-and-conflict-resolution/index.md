+++
title = "File Locking & Conflict Resolution"
+++

Sambee uses two protections that are easy to confuse:

- **Edit locks** stop a file from being edited simultaneously in two places.
- **Conflict resolution** happens later when Companion tries to upload a desktop-edited file back to the server and notices the server-side copy was changed, too.

## Edit Locks

Sambee uses edit locks on SMB connections to prevent other users from editing a file at the same time as you do.

### Markdown Editing

Sambee acquires an edit lock before it opens the Markdown editor. Sambee releases the lock when you leave the editor.

If the file is already locked by another user, Sambee does not enter edit mode. Instead, it keeps the file in the read-only viewer and shows an error explaining that the file is already locked for editing.

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
