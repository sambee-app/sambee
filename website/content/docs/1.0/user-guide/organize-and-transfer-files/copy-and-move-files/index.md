+++
title = "Copy and Move Files"
+++

Use [dual-pane mode](../../find-and-browse-files/dual-pane-mode/) on desktop. Select source files or folders in the active pane; the inactive pane is the destination. A focused row alone is not a selection. See [Select Files and Folders](../../find-and-browse-files/select-files-and-folders/).

Press **F5** to copy or **F6** to move. Transfers work between SMB connections, local drives, and shares and drives. The destination must be writable; local drives require [Companion](../../use-local-drives-and-desktop-apps/access-local-drives/). Sambee completes the destination copy before removing the source during a move.

If a destination item exists, use **Target already exists** to skip it or choose a different name. To extract ZIP members instead, see [Work with ZIP Archives](../work-with-zip-archives/).

## Partial Moves and Cancellation

If Sambee creates the destination but cannot remove the original, it reports a partial move and keeps the original. Cancellation or failure does not undo earlier completed items. Review both locations before retrying or deleting a retained source. See [transfer recovery](../../troubleshooting/common-user-problems/#cannot-complete-a-transfer).

