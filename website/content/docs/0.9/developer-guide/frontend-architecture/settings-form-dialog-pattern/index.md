+++
title = "Settings Form Dialog Pattern"
+++

Use this pattern for stateful settings editors that create or update configuration. It keeps the same form behavior across a phone drawer, a narrow dialog, and a desktop dialog while avoiding separate mobile and desktop forms.

The reference implementation is `frontend/src/components/Admin/ConnectionDialog.tsx`.

## When To Use It

Use the pattern when a dialog edits several related settings and needs validation, field descriptions, or more than one action.

Do not use it for a confirmation or destructive-action dialog. Those should continue to use `ResponsiveFormDialog` directly with focused content and actions.

## Dialog Categories

Use `ResponsiveFormDialog` as the shared shell for every ordinary application dialog. It provides the responsive Drawer and Dialog behavior, safe-area action area, dialog surface tokens, title and description relationships, close blocking, and focus restoration.

Small dialogs use traditional Cancel and confirmation actions; do not add a top-right close button.

Choose the content pattern that matches the job:

| Dialog type | Use | Examples |
|---|---|---|
| Multi-field editor | `ResponsiveFormDialog` with the settings form building blocks below. | Connections, users, OIDC configuration, copy or move. |
| One- or two-field editor | `ResponsiveFormDialog` with a single-column settings surface. Keep the floating MUI label at every width. | Create, rename, copy, and move. |
| Decision | `ResponsiveFormDialog` with compact content and actions. Do not add `SettingsFormSurface`. | Delete, overwrite conflict, application update, connection test result. |
| Picker | `ResponsiveFormDialog` with a listbox or selection grid. Keep the picker’s keyboard and selection semantics in the owning component. | Viewer and theme pickers. |
| Short workflow | `ResponsiveFormDialog` with state-specific body and actions. | Companion pairing. |
| Full-screen workspace | Keep the specialized full-screen viewer shell. Share only reusable behavior that does not interfere with the viewer’s focus, toolbar, or third-party integration. | Image, PDF, Markdown, and text viewers. |

The desktop settings overlay and mobile settings drawer are navigation containers, not form dialogs. Keep their information architecture separate while composing settings-form pages inside them.

For safety-critical decisions, focus the least destructive action after opening. For input workflows, focus the first input. Do not make a destructive action the default Enter action unless the user has already focused it.

## Shared Building Blocks

Import the structural primitives and control styles from `frontend/src/components/Settings/SettingsFormLayout.tsx`.

| Building block | Responsibility |
|---|---|
| `SettingsFormSurface` | Provides the muted, rounded background and shared interior padding. It darkens the default background by 4% in light mode and lightens it by 8% in dark mode. |
| `SettingsFormGroup` | Groups related rows and adds row dividers only at the desktop breakpoint. |
| `SettingsFormRow` | Uses one column below `md` and the two-column label/control grid at `md` and above. |
| `SettingsFormFieldLabel` | Renders a desktop label with its description or validation error. |
| `SettingsFormSection` | Separates groups with the standard settings heading, subdued divider, and spacing. |
| `SettingsSelectMenuItem` | Renders a select option with a label and supporting description. |
| `SettingsPasswordVisibilityToggle` | Renders the shared show/hide password adornment. The owning dialog keeps password visibility state and translated labels. |
| `settingsFormFieldControlSx` | Aligns a control to the desktop control column. |
| `settingsFormSelectControlSx` | Makes a desktop select content-width and right-aligned. |
| `settingsFormOutlinedControlSx` | Applies the shared outlined-field, focus, error, and floating-label treatment. |
| `settingsSelectSx` and `settingsSelectMenuProps` | Keep select values, icons, and options at the standard subdued text color. |

Keep field state, API calls, validation rules, translations, and the concrete MUI controls in the owning dialog. The shared layer owns layout and presentation; it must not become a schema-driven form engine.

## Responsive Contract

Multi-field settings editors have exactly two form layouts. One- and two-field operation dialogs stay single-column at every width so long names and paths retain the available width.

### Below `md`

Use one column in both responsive shells.

- Below `sm`, `ResponsiveFormDialog` renders the form in a Drawer.
- From `sm` through `<md`, it renders the same form in a Dialog.
- Use normal-height MUI outlined controls.
- Keep MUI labels inside empty fields and floating in the outline after focus or entry.
- Keep descriptions and validation errors directly below their controls as MUI helper text.
- Use the grouped surface and section heading, but do not show individual field-row dividers.

### At `md` And Above For Multi-Field Editors

Use the two-column desktop layout.

- Put labels and descriptions in the left column.
- Put compact controls in the right column.
- Use the compact MUI `size="small"` variant only when a desktop field has an external label in the left column.
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

Describe what the selected action will do. State what will be copied, moved, replaced, skipped, or deleted and name the source item for a single-item operation, then present the affected value in a labelled read-only field. Keep notices tied to their current condition: a no-op destination notice must disappear as soon as a renamed target makes the operation valid, without changing the dialog's layout.

## Implementation Checklist

1. Start with `ResponsiveFormDialog` for the responsive Drawer and Dialog shell.
2. Wrap the fields in `SettingsFormSurface` and one or more `SettingsFormGroup` components.
3. Put every field in `SettingsFormRow`.
4. Use `SettingsFormFieldLabel` only for a multi-field editor at `md` or wider. Keep one- and two-field operation dialogs in a single column with floating MUI labels at every width.
5. Keep the below-`md` MUI `label`, `InputLabel`, and `FormHelperText` props in the concrete control. Use normal field height for inline-labelled one- or two-field operation dialogs; reserve helper-text space when a field can show a validation error.
6. Use `SettingsFormSection` between related groups instead of recreating section borders and title spacing locally.
7. Reuse the shared action styles when the dialog has split or responsive actions.
8. Render conditional fields or sections only when their state applies, while keeping each visible control in a `SettingsFormRow`.

For a non-form dialog, start with `ResponsiveFormDialog` and retain only the content, selection, workflow, and keyboard behavior specific to that dialog. Do not duplicate MUI `Dialog`, `Drawer`, sticky mobile actions, focus restoration, or dialog surface styling in the owning component.

## Accessibility And Validation

Associate desktop controls with their external labels and descriptions using `htmlFor`, `labelId`, and `aria-describedby` as appropriate. Preserve a description ID when an error replaces the description so the relationship remains valid.

After a failed save or test, focus the first invalid field. Do not remove normal MUI error states from controls; the desktop error text supplements them by making the issue readable in the label column.

Use field-level errors for validation that the dialog can determine before submitting. Reserve one helper-text line, then replace it with the active error so the form does not shift. Do not repeat a field-owned error in a form-level alert. Error text must explain the cause and the corrective action, not only name a failed rule.

Prefer a safe, valid default over presenting a predictable error when the dialog can infer the intended correction. For example, a one-item copy into its source directory should prefill an extension-aware name such as `report (copy).pdf`. Do not apply this pattern to a same-directory move: it is a rename operation, so the user must deliberately choose the new name.

Use a stable form-level alert only when no editable field owns the remedy, such as a multi-item copy whose destination directory is also its source directory. Use error severity when the state blocks confirmation. Keep API failures in this form-level feedback region as well, above the form surface so they do not disrupt a desktop field row.

## Testing And Review

For every dialog that adopts this pattern, cover all of the following:

- The mobile Drawer and the `sm` through `<md` Dialog use the same single-column form semantics.
- A populated narrow-screen field uses a floating MUI label, normal control height, and helper text below the field.
- A multi-field editor retains external labels, compact controls, and desktop-only row dividers at `md` and above.
- A one- or two-field operation dialog remains single-column and keeps floating labels at `md` and above.
- Errors, focus-first-invalid behavior, keyboard handling, and pending action states still work.
- The surface, controls, and helper text remain legible in both light and dark themes.

For every non-form dialog that adopts the shared shell, cover all of the following:

- The phone Drawer has reachable actions above safe-area insets and does not obscure content in a short viewport.
- Keyboard focus, Enter, Escape cancellation, and the dialog-specific safe default still work. Escape must always issue the dialog's cancellation request.
- Picker and workflow state remains usable with a keyboard.
- Dialog content and action states remain legible in light and dark themes.

Use a live browser check at a phone width and a desktop width in addition to focused tests. Check a short viewport as well so the fixed mobile actions do not obscure the final control.

