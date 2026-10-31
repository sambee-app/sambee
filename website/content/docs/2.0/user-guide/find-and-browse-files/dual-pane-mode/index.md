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

## Match Pane Locations

Use these commands to show the same connection and directory in both panes:

- Press <kbd>Ctrl</kbd> + <kbd>Left</kbd> to set the left pane to the right pane's location.
- Press <kbd>Ctrl</kbd> + <kbd>Right</kbd> to set the right pane to the left pane's location.

The direction selects the pane to change, regardless of which pane is active. The active pane and keyboard focus stay unchanged. These commands copy only the location, including archive subdirectories. They don't copy or move files, selections, or pane preferences. Both locations must finish loading first. If they already match, nothing changes. Use browser Back to restore the previous locations.

To open the active pane's location separately, press <kbd>Ctrl</kbd> + <kbd>Alt</kbd> + <kbd>T</kbd>. The new tab contains one pane. The original tab stays unchanged.

All three commands are also available through command search (<kbd>Ctrl</kbd> + <kbd>P</kbd>).

## Requirements

Use [Copy and Move Files](../../organize-and-transfer-files/copy-and-move-files/) for transfers, or [Work with ZIP Archives](../../organize-and-transfer-files/work-with-zip-archives/) for extraction.

- Dual-pane mode is currently a desktop-only feature (i.e., not available on mobile due to screen size limitations).
