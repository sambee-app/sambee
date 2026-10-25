+++
title = "Settings Forms and Actions"
+++

Use these conventions for settings pages and stateful settings editors. Pages share section, surface, and action styles. Editors keep the same form behavior across a phone drawer, a narrow dialog, and a desktop dialog without separate mobile and desktop forms.

The page reference is `frontend/src/pages/LocalDrivesSettings.tsx`; the dialog reference is `frontend/src/components/Admin/ConnectionDialog.tsx`.

## When To Use It

Use the page conventions for settings content and actions. Use the dialog pattern when an editor changes several related settings and needs validation, field descriptions, or more than one action.

Do not use the form pattern for a confirmation or destructive-action dialog. Those should continue to use `ResponsiveDialogShell` directly with focused content and actions.

## Settings Page Layout and Actions

`SettingsCategoryContent` loads each settings page on demand. Keep page implementations behind its lazy imports rather than importing them into the application shell. Its local loading and error boundaries leave settings navigation available while a page loads or fails. Permission checks run before an admin page renders or its module starts loading. Changing categories must keep navigation focus aligned and prevent a late module from replacing the newly selected page.

Once the selected page mounts, prefetch the other permitted pages during idle time through the shared `settingsPageLoaders` registry. The mobile category list starts the same prefetch before a page is selected. Deduplicate background loads, log failures without interrupting navigation, and allow failed loads to retry. Cancel scheduled callbacks when the owning view closes or changes. The desktop dialog resets initial focus for each opening and Strict Mode effect replay, keeping the selected category focused without taking focus away from a form or nested dialog during later updates.

Compose settings pages with `SettingsPage`, `SettingsSectionList`, and `SettingsGroup`. Use `FormSurface` for the subdued background of an action section, not an additional bordered card. For action sections, put the description or metadata on the left and controls on the right in a `FormRow`: the columns stack below `md` and share the row at `md` and above. Right-align actions on desktop, allow them to wrap, and keep result notices below the row. An informational section such as Local Drives' Current status can keep its own layout; don't force it into an action row.

Choose button styling by the action's role, not by whether its MUI variant is `outlined` or `contained`:

| Role | Treatment | Example |
|---|---|---|
| Regular or secondary | Neutral `settingsUtilityButtonSx`; on a grey `FormSurface`, use `settingsFormSurfaceUtilityButtonSx` so the overlay background shows through, as it does for dialog inputs. Keep the existing border, hover, and keyboard-focus treatment. | Account > Change password; Local Drives > Test Current Pairing. |
| Danger or alert | Red-tinted `settingsDestructiveButtonSx` for settings-page actions. Use the dialog action rules below for the confirmation. | Local Drives > Unpair This Browser. |
| Main or default | Prominent `settingsPrimaryButtonSx` for the main action on a grey settings-page surface and for the main action in a page footer or dialog. Avoid giving several routine actions the same emphasis. | Authentication > Configure OIDC; Local Drives > Pair This Browser. |

Add a relevant `@mui/icons-material` icon with `startIcon` to labeled outlined or contained settings-page action buttons that lack one. Leave text-only buttons, including buttons without an explicit outlined or contained variant, without icons. Adding an icon must not change the button's variant, colors, label, or behavior.

## User Directory Layout

User Management renders roles and statuses as ordinary text, with each simultaneous status on its own line. Summary counts and removable filters remain badges. Keep column headings and cell values readable: wrap headings, email addresses, usernames, provider names, and other long values without truncating their underlying text. Top-align row contents, and reserve space for sort icons and row actions.

Use the settings content container's width to choose between the desktop grid and stacked records, with a shared 40rem breakpoint for the table and its toolbar. Changing selected columns must not change the layout breakpoint. A narrow settings overlay must stack even on a wide screen. Preserve every selected field when stacking; don't introduce horizontal scrolling or silently hide columns. Show timestamps as a short localized date and time on separate lines, retaining the full timestamp in a tooltip and the original value in a semantic `time` element.

Place the desktop column chooser icon at the far-right end of the table header, above the row actions. In stacked layouts, place the Columns control at the toolbar's right edge. Keep the toolbar control available while the directory is loading or empty. Anchor the menu to the visible control, reposition it when the settings container resizes, and return focus to the visible control when it closes.

Validate the layout in a real browser with all columns enabled, long identifiers, multiple statuses, different regional formats, narrow containers, mobile widths, and zoom. Component tests don't measure text overlap or container-query behavior.

## Dialog Categories

Use `ResponsiveDialogShell` from `frontend/src/components/Dialog/ResponsiveDialogShell.tsx` as the shared shell for every ordinary application dialog. It provides responsive Drawer and Dialog behavior, safe-area actions, overlay/form surface tokens, title and description relationships, close blocking, and focus restoration.

Small dialogs use traditional Cancel and confirmation actions; do not add a top-right close button.

Choose the content pattern that matches the job:

| Dialog type | Use | Examples |
|---|---|---|
| Multi-field editor | `ResponsiveDialogShell` with the form building blocks below. | Connections, users, OIDC configuration, copy or move. |
| One- or two-field editor | `ResponsiveDialogShell` with a single-column form surface. Keep the floating MUI label at every width. | Create, rename, copy, and move. |
| Decision | `ResponsiveDialogShell` with compact content and actions. Do not add `FormSurface`. | Delete, overwrite conflict, application update, connection test result. |
| Picker | `ResponsiveDialogShell` with a listbox or selection grid. Keep the picker’s keyboard and selection semantics in the owning component. | Viewer and theme pickers. |
| Short workflow | `ResponsiveDialogShell` with state-specific body and actions. | Companion pairing. |
| Full-screen workspace | Keep the specialized full-screen viewer shell. Share only reusable behavior that does not interfere with the viewer’s focus, toolbar, or third-party integration. | Image, PDF, and Markdown viewers, and the text editor. |

The desktop settings overlay and mobile settings drawer are navigation containers, not form dialogs. Keep their information architecture separate while composing settings-form pages inside them.

## Keyboard Isolation

`ResponsiveDialogShell` establishes a keyboard shortcut scope automatically for both its Drawer and Dialog layouts. While it's open, `useKeyboardShortcuts` ignores background registrations and lets the innermost open dialog own shortcuts, including when a control portals outside the dialog. The shell also stops key events from bubbling into parent workspace handlers. Closing the dialog releases its scope; normal shortcut handling resumes when focus returns to the workspace.

Don't add dialog-specific flags to parent shortcut handlers to provide this isolation. Keep ordinary dialog keyboard behavior in the shell's `onKeyDown` or `onEscape` callbacks. If dialog content needs `useKeyboardShortcuts`, register it in a child component rendered inside the shell so it inherits the dialog's scope, not in the component that creates the shell. Existing focus trapping and interactive-control checks still apply.

Escape dismissal goes through MUI's modal close callback, preserving its top-modal and IME process-key checks. `onEscape`, when supplied, replaces the normal Escape close action and runs once, even when `disableClose` blocks ordinary closing. Use it for cancellation requests during pending operations. Close buttons and backdrop requests still use `onClose` and respect `disableClose`. Don't add document-level Escape listeners or duplicate Escape closing in `onKeyDown`; the shared shell owns that behavior.

## Dialog Action Buttons

Choose each action's treatment by what it does, including in decisions embedded inside full-screen viewers. Keep the viewer workspace shell and toolbars separate from its decision dialogs.

| Role | Treatment | Example |
|---|---|---|
| Destructive confirmation | MUI `variant="contained" color="error"`, as in the File delete dialog. Do not use the red-tinted settings-page `settingsDestructiveButtonSx` or introduce another red button style. | Delete, Discard unsaved changes, or Continue with overwrite selected. |
| Main non-destructive action | MUI `variant="contained"` in the theme's primary color. | Create directory, Save, Retry, or the sole Close action. |
| Secondary or alternate action | MUI `variant="outlined"` with the existing subdued utility fill and focus treatment. | Cancel, Later, Ignore, or Open without saving. |

An action's role can change with the selected option: a conflict dialog's Continue is destructive only when it will overwrite an existing item. When a decision offers both Save and Discard, distinguish the primary and destructive actions without changing what either one does. Do not restyle settings-page triggers when styling their confirmation dialogs.

Visual priority does not determine Enter behavior. For safety-critical decisions, focus the least destructive action on opening; for input workflows, focus the first input. Never make a destructive action the default Enter action unless the user has already focused it. Keep cancellation available and focused during cancellable pending operations. Use `ResponsiveDialogShell` for application confirmations rather than native `window.confirm`, whose buttons cannot follow these styles.

## Shared Building Blocks

Import reusable structural primitives and control styles from `frontend/src/components/Form/FormLayout.tsx`. Settings-only sections remain in `frontend/src/components/Settings/SettingsFormLayout.tsx`.

| Building block | Responsibility |
|---|---|
| `FormSurface` | Provides the shared form-surface background and interior padding. |
| `FormGroup` | Groups related rows and adds row dividers only at the desktop breakpoint. |
| `FormRow` | Uses one column below `md` and the two-column label/control grid at `md` and above. |
| `FormFieldLabel` | Renders a desktop label with its description or active error/warning. |
| `SettingsFormSection` | Separates groups with the standard settings heading, subdued divider, and spacing. |
| `SettingsSelectMenuItem` | Renders a select option with a label and supporting description. |
| `SettingsPasswordVisibilityToggle` | Renders the shared show/hide password adornment. The owning dialog keeps password visibility state and translated labels. |
| `formFieldControlSx` | Aligns a control to the desktop control column. |
| `formSelectControlSx` | Makes a desktop select content-width and right-aligned. |
| `formOutlinedControlSx` | Applies the shared outlined-field, focus, error, and floating-label treatment. |
| `formSelectSx` and `formSelectMenuProps` | Keep select values, icons, and options at the standard subdued text color. |

Keep field state, API calls, validation rules, translations, and the concrete MUI controls in the owning dialog. The shared layer owns layout and presentation; it must not become a schema-driven form engine.

## Responsive Contract

Multi-field settings editors have exactly two form layouts. One- and two-field operation dialogs stay single-column at every width so long names and paths retain the available width.

### Below `md`

Use one column in both responsive shells.

- Below `sm`, `ResponsiveDialogShell` renders the form in a Drawer.
- From `sm` through `<md`, it renders the same form in a Dialog.
- Use normal-height MUI outlined controls.
- Keep MUI labels inside empty fields and floating in the outline after focus or entry.
- Keep descriptions and validation errors directly below their controls as MUI helper text.
- Use the grouped surface and section heading, but do not show individual field-row dividers.

### At `md` And Above For Multi-Field Editors

Use the two-column desktop layout.

- Put labels and descriptions in the left column.
- Put compact controls in the right column.
- For text inputs and selects with an external label in the left column, use MUI `size="small"` and omit the control's `label` or `InputLabel`. The left-column label is the only visible label; associate it with the control so it remains accessible. Below `md`, restore the control's floating label and normal height.
- Replace the left-column description with the validation error instead of showing helper text below the input.
- Keep full-width text inputs within the control column.
- Use content-width, right-aligned selects when the selected option remains readable.
- For checkboxes and switches, use the external label and description on the left, with the control in the right column. Keep the control label and helper text next to the control below `md`.
- For boolean settings, use a `Switch` with a visible `On` or `Off` state label. Let Material UI apply its standard palette colors.
- For native `datetime-local` inputs, preserve the MUI shrunk input label below `md`; use the external desktop label at `md` and above.
- Show subdued dividers between rows in a group.

## Control Conventions

Apply `settingsSelectSx` and `settingsSelectMenuProps` to every settings `Select`. Use `SettingsSelectMenuItem` when an option needs a short explanation below its label.

Use `SettingsPasswordVisibilityToggle` as the end adornment for password fields. Keep its `visible` state, toggle handler, and localized show/hide labels in the owning dialog.

Use `DialogReadOnlyField` for a name, path, connection, or other value that a dialog shows without allowing the user to change it. Give the field a specific label such as `Destination directory` or `File to delete`; do not recreate a styled text pill. Keep the normal MUI field height when its label is inside the outlined field. Use a subdued read-only surface while keeping long values selectable.

Write the dialog description as the outcome of the selected action. State what will be copied, moved, replaced, skipped, or deleted and name the source item for a single-item operation, then present the affected value in a labelled read-only field. Keep notices tied to their current condition: a no-op destination notice must disappear as soon as a renamed target makes the operation valid, without changing the dialog's layout.

## Operation Context

Operation dialogs show their subject and destination independently of translated prose. This lets a translated description use its natural word order and keeps a long identifier from making the dialog hard to scan.

Use `DialogOperationContext` for passive operation metadata. Each entry has a translated label and a value with either the `fileName` or `path` kind. The component renders a vertical definition list, so every filename and path occupies its own line and does not share that line with explanatory text.

`OverwriteConflictDialog` is the deliberate exception. Its compact Existing item and Incoming item metadata grids remain intact because they support side-by-side conflict comparison. Use `DialogIdentifierDisplay` for each Path value in those grids, but do not replace the grids with `DialogOperationContext`.

Use `DialogIdentifierDisplay` inside this context rather than truncating an identifier locally. It keeps the full value in the accessible name, applies bidi isolation with `bdi` and `dir="auto"`, and abbreviates only the visual value when the available width requires it. A shortened value has a hover-only tooltip with its full value. Do not make the identifier focusable and do not reveal the tooltip on focus or touch.

File-name shortening preserves the extension where possible. Path shortening preserves useful leading and trailing segments. Both use grapheme-aware boundaries, so combining characters and emoji sequences are never split. Breadcrumb segment labels must use `truncateTextByGrapheme` from `utils/pathDisplay` for the same reason.

Use outcome-only translation strings for the dialog description. Do not interpolate filenames or paths into `Trans` text. For example, a single-item copy describes copying the item to the destination directory, then context rows identify `Source item` and `Destination directory`.

## Feedback And Persistence

Render feedback only while it is active. Field errors and warnings belong to their control; use normal MUI helper text below `md`, and pass `FieldFeedback` to `FormFieldLabel` at `md` and above so it replaces the left-column description. Error feedback uses the normal MUI error state. Warning text starts with `Warning:` and uses the warning color. Do not reserve blank helper-text space, clip feedback to one line, or use a tooltip as the only way to read it.

Use `DialogNotice` and `DialogNoticeRegion` from `frontend/src/components/Dialog/` for non-field notices. A contextual condition known when the dialog opens belongs in the shell's `contextualNotice` slot, after its description and before the body. A result caused by an action belongs in the `actionNotice` slot immediately above the actions. Idle notices render no alert. An error alert uses the default dynamic `role="alert"`; a non-urgent warning uses `role="status"`. Do not move focus to an alert.

Ordinary settings persist a valid committed value immediately. Selects, toggles, and checkboxes commit on change. Text and numeric fields commit on blur or Enter after local validation succeeds. Keep invalid candidates locally and associate their error with the field. Each field has at most one in-flight request; disable every representation of that field while it is pending, but do not queue, debounce, batch, or serialize unrelated fields. Show a `role="status"` saving indicator only while active, then a brief saved indicator. A failed write remains a readable field error until editing or a later success resolves it.

Every settings update uses exactly one discriminated `{ field, value }` request and receives the matching canonical pair. Apply a response only to its matching field. Complete settings state is read through `GET`; routine settings pages have no Save, reset, dirty-state, or success-alert workflow. File Search and SMB policy fields are independent persisted keys; the backend validates correlated aggregates transactionally. SMB policy writes retain their full post-commit runtime refresh lifecycle, while its read-chunk-size update does not trigger that lifecycle.

`userSettingsStore` is the sole frontend boundary for `/auth/me/settings`. Components use its field selectors and `useCurrentUserSetting()` hook, retain only local drafts/previews, and never store server-backed user settings in local storage. The store hydrates for identity changes, rejects stale requests, allows one write per field, and refreshes other tabs from invalidation-only BroadcastChannel messages.

During a cancellable operation, keep its cancellation action enabled unless the owner is already processing the cancellation request. Move focus to that action when the pending state starts. Keep the primary action disabled while the operation is active. Archive progress must report only data actually provided by the operation: archive creation shows an indeterminate status, and extraction may show its processed-member count without inventing byte totals or an item total.

## Implementation Checklist

1. Start with `ResponsiveDialogShell` for the responsive Drawer and Dialog shell.
2. Wrap the fields in `FormSurface` and one or more `FormGroup` components.
3. Put every field in `FormRow`.
4. Use `FormFieldLabel` only for a multi-field editor at `md` or wider. Keep one- and two-field operation dialogs in a single column with floating MUI labels at every width.
5. Keep the below-`md` MUI `label`, `InputLabel`, and active `FormHelperText` props in the concrete control. Use normal field height for inline-labelled one- or two-field operation dialogs; do not reserve helper-text space.
6. Use `SettingsFormSection` between related groups instead of recreating section borders and title spacing locally.
7. Reuse the shared action styles when the dialog has split or responsive actions.
8. Render conditional fields or sections only when their state applies, while keeping each visible control in a `FormRow`.

For a non-form dialog, start with `ResponsiveDialogShell` and retain only the content, selection, workflow, and keyboard behavior specific to that dialog. Do not duplicate MUI `Dialog`, `Drawer`, sticky mobile actions, focus restoration, or dialog surface styling in the owning component.

## Accessibility And Validation

Associate desktop controls with their external labels and descriptions using `htmlFor`, `labelId`, and `aria-describedby` as appropriate. Preserve a description ID when an error replaces the description so the relationship remains valid.

After a failed save or test, focus the first invalid field. Do not remove normal MUI error states from controls; the desktop error text supplements them by making the issue readable in the label column.

Use field-level errors for validation that the dialog can determine before submitting. Do not repeat a field-owned error in a form-level alert. Error text must explain the cause and the corrective action, not only name a failed rule. Bounded reflow when feedback appears is expected and preferred to hidden space.

Prefer a safe, valid default over presenting a predictable error when the dialog can infer the intended correction. For example, a one-item copy into its source directory should prefill an extension-aware name such as `report (copy).pdf`. Do not apply this pattern to a same-directory move: it is a rename operation, so the user must deliberately choose the new name.

Use a stable form-level alert only when no editable field owns the remedy, such as a multi-item copy whose destination directory is also its source directory. Use error severity when the state blocks confirmation. Keep API failures in this form-level feedback region as well, above the form surface so they do not disrupt a desktop field row.

## Testing And Review

For settings-page action sections, check the one-column layout below `md` and the two-column description/action layout at `md` and above. Check neutral-button contrast against grey form surfaces in light and dark themes, including hover and keyboard focus. Check that added icons do not change accessible names or cause button labels to overflow at phone widths. Keep informational sections readable without imposing the action-row grid, and verify that notices remain below the row.

For dialog actions, check contained error and primary buttons and outlined secondary buttons in light and dark themes, including hover and keyboard focus. Verify that option-dependent destructive actions change treatment without changing their safe initial focus or Enter behavior.

For every dialog that adopts this pattern, cover all of the following:

- The mobile Drawer and the `sm` through `<md` Dialog use the same single-column form semantics.
- A populated narrow-screen field uses a floating MUI label, normal control height, and helper text below the field.
- A multi-field editor retains external labels, compact controls, and desktop-only row dividers at `md` and above.
- A one- or two-field operation dialog remains single-column and keeps floating labels at `md` and above.
- Errors, focus-first-invalid behavior, keyboard handling, and pending action states still work.
- The surface, controls, and helper text remain legible in both light and dark themes.
- Long filenames and paths remain one line at phone, tablet, and desktop widths; shortened values expose the complete identifier only on hover.
- Identifier rendering remains correct for mixed left-to-right and right-to-left text, including after the available width changes.
- A cancellable pending workflow focuses its cancellation action and does not submit a duplicate request.

For every non-form dialog that adopts the shared shell, cover all of the following:

- The phone Drawer has reachable actions above safe-area insets and does not obscure content in a short viewport.
- Keyboard focus, Enter, Escape cancellation, and the dialog-specific safe default still work. Escape must always issue the dialog's cancellation request.
- Picker and workflow state remains usable with a keyboard.
- Dialog content and action states remain legible in light and dark themes.

Use a live browser check at a phone width and a desktop width in addition to focused tests. Check a short viewport as well so the fixed mobile actions do not obscure the final control.
