+++
title = "Copy and Move Files"
+++

Use [dual-pane mode](../../find-and-browse-files/dual-pane-mode/) on desktop. Select source files or folders in the active pane; the inactive pane is the destination. A focused row alone is not a selection. See [Select Files and Folders](../../find-and-browse-files/select-files-and-folders/).

Press **F5** to copy or **F6** to move. Transfers work between SMB connections, local drives, and shares and drives. The destination must be writable; local drives require [Companion](../../use-local-drives-and-desktop-apps/access-local-drives/). Sambee completes the destination copy before removing the source during a move. For ZIP members, use [extraction](../work-with-zip-archives/#extract-selected-members); members cannot be moved.

## Existing Destination Items

In **Target already exists**, skip, overwrite, overwrite only if the source is newer, or choose another name. You can apply a choice to remaining conflicts. Same-name directories are merged without deleting destination-only entries. A file cannot replace a directory or the reverse.

## Partial Moves and Cancellation

For moves between SMB connections, the destination file is complete before source deletion. An authorized overwrite does not first delete the visible destination. Another writer can prevent a move from starting.

- Cancellation before destination publication leaves both locations unchanged for that file.
- Cancellation after publication but before source deletion retains the destination and reports the retained source.
- Rejected source deletion retains the confirmed destination and reports the retained source.
- If deletion or final close cannot be confirmed, Sambee reports uncertainty. Cancellation after deletion starts does not guarantee that the source remains.

Directories can be partially moved. Earlier completed files and replacements are not rolled back. An uncertain item stops the remaining batch; a retained-source warning can allow later items to continue. Each selected directory uses the destination parent captured when the confirmation opened.

Inspect both locations before retrying. Do not assume an uncertain source was retained. The completed dialog offers **Close**, not a repeat of the batch. If source validation fails after a copy was published, the destination remains and the failure is reported. See [transfer recovery](../../troubleshooting/common-user-problems/#cannot-complete-a-transfer).

