+++
title = "View and Edit Text Files"
+++

Edit supported text files directly in their existing storage. **Save** writes to the source file; read-only storage cannot be edited. Local files require [Companion access](../../use-local-drives-and-desktop-apps/access-local-drives/). See [Text File Support and Syntax Highlighting](../../reference/text-file-support-and-syntax-highlighting/) for formats and limits, or [Edit Markdown](../edit-markdown/) for rendered table editing.

## Saving and Locks

Files without write permission, files on read-only connections, ZIP members, and files above the configured editing limit stay read-only. You can still read or download them.

Editing requires a file lock. If editing is unavailable, close the other edit session, then use **Retry editing**. If the lock is lost, Sambee stops changes and retains your draft. If the saved file changed, choose **Use saved file** or **Keep my draft** when retrying. Keeping a draft does not save it; review it before Save. See [File Locking and Conflict Resolution](../file-locking-and-conflict-resolution/).

You can edit during an ordinary Save. Save writes the revision captured when it began; later edits remain unsaved. A failed save keeps your changes in the editor. Finish input-method composition before saving.

## Unsaved Changes and Recovery

The text editor closes directly to the file list. With unsaved changes, **Save** writes them before leaving, **Discard** leaves without saving, and **Cancel** keeps editing. A failed save keeps the editor open. Navigation does not undo saved changes or restore discarded edits.

If sign-in interrupts editing, eligible drafts can be stored in this browser tab. Recovery is not a substitute for saving. See [Recover Unsaved Edits](../recover-unsaved-edits/).

For an installed application instead, see [Edit Files in Desktop Apps](../../use-local-drives-and-desktop-apps/edit-files-in-desktop-apps/).

