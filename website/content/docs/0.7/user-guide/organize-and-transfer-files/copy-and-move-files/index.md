+++
title = "Copy and Move Files"
+++

Use [dual-pane mode](../../find-and-browse-files/dual-pane-mode/) on desktop to transfer files between folders. Select the source items in the active pane; the inactive pane is the destination. A focused row alone is not a selection. See [Select Files and Folders](../../find-and-browse-files/select-files-and-folders/).

Press **F5** to copy or **F6** to move the selected items. Copying works between SMB connections, local drives, and shares and drives. Local drives require [Companion](../../use-local-drives-and-desktop-apps/access-local-drives/), and the destination must be writable.

## Retained Sources and Partial Results

For a move across storage boundaries, Sambee creates the destination but retains the source when it cannot safely verify and delete it. Check both locations before deleting a retained source yourself.

A failed or cancelled batch can leave completed files in the destination. Do not assume that the whole operation was undone. Inspect source and destination before retrying. See [transfer recovery](../../troubleshooting/common-user-problems/#cannot-complete-a-transfer).

