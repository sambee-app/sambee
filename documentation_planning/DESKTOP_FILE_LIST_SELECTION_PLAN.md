# Desktop File List Mouse Selection Plan

## Goal

Make multi-selection discoverable and efficient with a mouse while preserving
Sambee's single-click-to-open behavior outside selection mode. Reuse the file
icon position for selection; do not add a selection column or a desktop Clear
button. Preserve the existing mobile and keyboard workflows.

## Interaction Contract

Selection mode is per pane and is active exactly when that pane has at least one
explicitly selected item. The selection count appears in that pane's existing
desktop status bar; it is an indicator, not a separate mode switch.

| Target | No explicit selection: open mode | One or more selected: selection mode |
| --- | --- | --- |
| File icon position | Select item and enter selection mode | Toggle item selection |
| Row body outside icon | Open item | Clear selection and exit mode; do not open item |
| Empty file-list space | No action | Clear selection and exit mode |
| Shift-click icon | Select item and enter selection mode | Select inclusive range from anchor |
| Ctrl/Cmd+Shift-click icon | Select item and enter selection mode | Add inclusive range to selection |
| Other pane | Activate that pane without clearing this pane's selection | Activate that pane without clearing this pane's selection |

- Only primary mouse clicks on selection icons change the selection while in
  selection mode. Modifier-clicking the row body does not toggle or extend it.
- In open mode, the file/folder icon remains visible by default. Hovering the
  icon area or focusing its control reveals an empty selection affordance.
  In selection mode, every row shows a checked or empty selection icon instead
  of the regular file/folder icon. Names and metadata do not shift.
- Deselecting the last item exits selection mode immediately. No confirmation
  is needed for clearing temporary selection. Escape also clears selection in
  the file-list keyboard context.
- Double-click has no special opening behavior in selection mode. After an exit
  click, opening a file requires a separate, deliberate click in open mode.
- Navigating via a breadcrumb clears that pane's selection as the location
  changes and still navigates. Sorting, starting or changing search, and
  changing a file-list filter clear selection and its anchor in the affected
  pane, then perform their normal actions. This applies whether invoked by
  mouse or keyboard; desktop sort and search controls live outside the pane.
- Scroll, right-click, incidental focus changes, and clicks in the other pane
  do not dismiss this pane's selection. Actions on the current selection must
  be exempt from dismissal and receive the selected items, not a focused-item
  fallback. Do not indiscriminately clear selection on pane click bubbling.
- While selected, show "N selected" in the left side of that pane's desktop
  status bar instead of its focused-file name, size, date, and link status.
  Keep the right-side total item count; restore focused-file details when
  selection ends. Fit both sides within the existing 32px bar in single- and
  dual-pane layouts without wrapping or overlap. Do not add a desktop Clear
  control, discard prompt, or duplicate bulk-action menu. Leave mobile's
  existing selection dock and Clear control unchanged.

## Range and State Rules

- Track the range anchor by item path within its pane, rather than by index.
  An unmodified icon or keyboard selection establishes a new anchor; extending
  a range does not move it. Resolve the anchor against the currently displayed
  order. Mouse and keyboard use the same selection set and anchor, so a user
  can select with Space or Insert, extend with Shift-click on an icon, and
  continue selecting by keyboard without losing state.
- Shift-click replaces the explicit selection with the inclusive displayed
  range; Ctrl/Cmd+Shift-click adds that range. If the anchor is no longer
  displayed, start a new range at the clicked item.
- Clear the anchor whenever selection is cleared or the pane changes location
  or connection. Sort, search, and filter changes clear both the selection and
  anchor instead of retaining a selection in a changed view. Preserve existing
  pruning of selected paths when entries disappear from a refreshed listing;
  a listing refresh is not itself a sort, search, or filter change.
- Preserve the distinction between keyboard focus and explicit selection.
  Focus alone must not show a checked icon. When selection exists, file
  operations use it; otherwise, existing focused-item fallback remains. A
  focused icon control must still allow list navigation. Space and Enter on
  that control toggle at most once and must not also invoke the list's
  shortcuts; Enter with focus on the list keeps its existing Open behavior.
  Do not add a Tab stop for every virtualized row.

## Implementation Sequence

1. In `frontend/src/pages/FileBrowser/useFileBrowserPane.ts`, add the per-pane
   path-based anchor and mouse selection/range handlers alongside the existing
   `selectItem`, `toggleItemSelection`, and `handleClearSelection`. Reuse their
  focus management; make keyboard selection commands update the same anchor.
  Ensure all exits and location changes reset it, and preserve existing
  refreshed-listing reconciliation.
2. In `frontend/src/components/FileBrowser/FileRow.tsx`, make the icon position
   an independently labeled, focusable selection control, separate from the
   row's open button. Its accessible name and checked state must identify the
   item and selection action. Enlarge the effective hit target around the
   existing 24px graphic without adding a column or moving the row contents.
  Coordinate native button keys with list shortcuts so a focused icon does
  not toggle twice, open a file on Enter, or break arrow navigation; avoid a
  Tab stop per row.
  Preserve unavailable-entry behavior and mobile long-press handling.
3. In `frontend/src/components/FileBrowser/FileList.tsx` and
   `frontend/src/pages/FileBrowser/FileBrowserPane.tsx`, pass the desktop icon
   selection handlers, derive selection-mode icon visuals for all rows, and
   handle row-body and empty-list dismissal. Scope dismissal to intentional
  primary clicks. Keep breadcrumbs and bulk actions working according to the
  interaction contract; do not rely on a catch-all pane bubbling handler.
4. Suppress further clicks in the same multi-click gesture when an icon toggle
   or row-body dismissal changes modes. A second click from that gesture must
   never turn into file activation. A later independent click opens normally.
5. In `frontend/src/pages/FileBrowser.tsx`, clear the affected pane's selection
  and anchor when the desktop sort or search is used, whether through a
  control or shortcut. Do the same for any file-list filter change. Keep
  selection intact for incidental focus changes and bulk-action invocation.
6. In `frontend/src/components/FileBrowser/StatusBar.tsx`, show the translated
  selected count in place of focused-file details while selection is active;
  retain the total item count and the existing details in open mode. Pass
  each pane's selected count from `frontend/src/pages/FileBrowser.tsx`, which
  already mounts one status bar per desktop pane. Reuse the current operation
  routing and keep explicit selection intact through a bulk-action click,
  particularly for actions with a focused-file fallback. Keep the mobile
  selection dock unchanged.
7. Update the file-browser interaction documentation to describe desktop mouse
   selection and the open/selection mode boundary, following the repository's
   documentation workflow.

## Verification

- Test open-mode row click, icon entry into selection mode, hover/focus icon
  affordance, icon-only toggling, row-body and empty-space exits, last-item
  deselection, and no opening on the dismissal click or its rapid second click.
- Test inclusive Shift ranges and additive Ctrl/Cmd+Shift ranges from both
  mouse and keyboard anchors, missing anchors, and virtualized off-screen rows.
  Test keyboard selection followed by mouse extension and vice versa.
- Test sorting, starting/changing search, and changing a filter by mouse and
  keyboard clear the affected selection and anchor while performing the
  requested action; refreshed-listing reconciliation remains intact. Test
  breadcrumb navigation and independent panes. Bulk actions must retain the
  complete selected set and never accidentally target the focused file.
- Test the existing desktop status bar shows focused-file details and total
  items in open mode, then translated selected count and total items in
  selection mode. Cover zero, one, and multiple selected items, long labels,
  dual-pane widths, and the unchanged mobile dock.
- Test accessible icon labels and checked state, focus versus selection,
  exactly one icon activation per keypress, Enter opening from the list but
  toggling on a focused icon, keyboard navigation and Escape exit, existing
  mobile long-press behavior, and touch input on desktop-sized layouts.
- Run focused frontend component and pane interaction tests, then frontend
  type-check and lint. Verify the documentation update under the docs workflow.
