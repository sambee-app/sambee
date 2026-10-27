+++
title = "Dual-Pane Mode"
+++

Sambee's dual-pane mode shows the contents of two directories next to each other. This layout was popularized by Norton Commander and later Total Commander. It makes it easier to move or copy files between directories and to compare two directories visually.

## Work in Dual-Pane Mode

To switch between single-pane and dual-pane mode:

- Press <kbd>Ctrl</kbd> + <kbd>B</kbd> to switch from single-pane to dual-pane mode and back.

To move focus between the left and right panes:

- Use <kbd>Tab</kbd> to move the input focus between the left and right pane.
- Press <kbd>Ctrl</kbd> + <kbd>1</kbd> to focus the left pane.
- Press <kbd>Ctrl</kbd> + <kbd>2</kbd> to focus the right pane.

To copy or move files and directories:

- Press <kbd>F5</kbd> to copy the currently selected items in the active pane to the location in the inactive pane.
- Press <kbd>F6</kbd> to move instead of copying.

{{< admonition type="note" >}}
You can copy and move files and directories between different SMB connections, different local drives, and SMB connections and local drives. Sambee completes the destination copy before it removes the original during a move.
{{< /admonition >}}

While a copy or move is in progress, the dialog shows its progress. Select Cancel to stop an active transfer. If a destination file already exists, use the Target already exists dialog to skip it, overwrite it, overwrite it only when the source is newer, or choose a different name. Apply the choice to remaining conflicts when appropriate. Directories with the same name are merged without removing destination-only entries. A file can't replace a directory or vice versa.

### Partial Moves and Cancellation

Transfers between SMB connections publish a complete destination file before removing the source. An authorized overwrite replaces the destination atomically, without first deleting the visible file. During a move, Sambee protects the opened source from concurrent writes and renames; an incompatible open writer can prevent the transfer from starting.

- Cancelling before publication leaves both locations unchanged for that file.
- Cancelling after publication but before source deletion keeps the destination and reports that the source was retained.
- A rejected source deletion also keeps the destination and reports the retained source.
- If a deletion acknowledgement or final close is lost, Sambee reports uncertainty about the source while retaining the confirmed destination. Cancellation after deletion has started can't guarantee that the source remains.

Sambee refreshes both panes after a batch. A directory can be partially moved even when its overall result is cancelled, failed, or uncertain. Earlier completed files and confirmed replacements aren't rolled back. An uncertain child stops the remaining batch; a retained-source warning can allow later items to continue. Each selected directory keeps the destination parent captured when the confirmation dialog opened.

After a partial or uncertain move, inspect both locations before starting another operation. Don't assume the source was retained when its deletion couldn't be confirmed. The completed dialog offers Close rather than repeating the batch. If source validation fails after a copy was published, the destination remains and Sambee reports the validation failure.

## Match Pane Locations

Use these commands to show the same connection and directory in both panes:

- Press <kbd>Ctrl</kbd> + <kbd>Left</kbd> to set the left pane to the right pane's location.
- Press <kbd>Ctrl</kbd> + <kbd>Right</kbd> to set the right pane to the left pane's location.

The direction selects the pane to change, regardless of which pane is active. The active pane and keyboard focus stay unchanged. These commands copy only the location, including archive subdirectories. They don't copy or move files, selections, or pane preferences. Both locations must finish loading first. If they already match, nothing changes. Use browser Back to restore the previous locations.

To open the active pane's location separately, press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd>. The new tab contains one pane. The original tab stays unchanged.

All three commands are also available through command search (<kbd>Ctrl</kbd> + <kbd>P</kbd>).

## Extract Selected ZIP Members

When the active pane shows a ZIP archive, select the files or directories to extract and press <kbd>F5</kbd>. Sambee extracts the selected members into the physical location in the inactive pane. Selecting a directory extracts all of its contents, including empty directories.

Archive members can't be moved. <kbd>F6</kbd> stays unavailable in a ZIP archive pane and doesn't modify the archive.

## Requirements

- Dual-pane mode is currently a desktop-only feature (i.e., not available on mobile due to screen size limitations).
