+++
title = "Docs Editor Tool"
+++

The docs editor CLI manages structural website docs changes safely and consistently. For ordinary copy edits inside an existing page, edit the Markdown file directly instead.

Preview is the default mode. Run a command once to inspect the plan, then rerun it with `--apply` when the preview matches what you want.

## Tool Location

The CLI lives at `website/scripts/docs-editor.py`.

Run it from the `website/` directory:

```bash
cd website
python3 scripts/docs-editor.py [global-options] <entity> <operation> [operation-options]
```

## Normal Workflow

Use the tool in this order:

1. run the command in preview mode first
2. review the planned metadata and file changes
3. rerun the command with `--apply` when the plan is correct
4. add `--yes` for destructive apply operations in non-interactive shells

After a successful apply, the tool runs docs validation automatically.

The human-readable preview now shows:

- the operation summary
- the key metadata for the operation
- the planned file and nav changes

## What the Tool Handles

The docs editor supports four entity types:

- versions
- books
- sections
- pages

Supported structural operations include:

- creating
- deleting
- materializing inherited landing content
- moving pages between sections
- renaming

The docs editor package also includes a standalone visualization report generator for the docs tree.

## Common Tasks

Use the built-in help when you know the action but not the exact flags:

```bash
cd website
python3 scripts/docs-editor.py --help
python3 scripts/docs-editor.py page create --help
```

Use these commands as a starting point for the most common workflows:

- add a new page
- materialize an inherited book landing page
- move a page to another section
- rename a page or section
- create a new docs version that inherits from the latest one

## Example: Create a New Version

This example:

- creates `0.8` as a new version
- adds it as to the end of the version list as the newest version (`--latest`)
- adds the status label `preview` (which is shown in the UI)

```bash
cd website
python3 scripts/docs-editor.py version create 0.8 \
  --latest \
  --status preview
```

Apply the same change:

```bash
cd website
python3 scripts/docs-editor.py --apply version create 0.8 \
  --latest \
  --status preview
```

## Example: Create a New Book

```bash
cd website
python3 scripts/docs-editor.py book create \
  --version 0.7 \
  --book tutorials \
  --title "Tutorials"
```

Apply the same change:

```bash
cd website
python3 scripts/docs-editor.py --apply book create \
  --version 0.7 \
  --book tutorials \
  --title "Tutorials"
```

## Example: Create a Structural-Only Section

This is useful when you want a navigation group without a section landing page.

```bash
cd website
python3 scripts/docs-editor.py section create \
  --version 0.7 \
  --book website-dev-guide \
  --section authoring-and-tooling \
  --title "Authoring And Tooling" \
  --position end \
  --structural-only
```

That creates the section directory and nav entry without `_index.md` or `_inherit.md`.

## Example: Create a New Page

```bash
cd website
python3 scripts/docs-editor.py page create \
  --version 0.7 \
  --book website-dev-guide \
  --section authoring-and-tooling \
  --page docs-editor-quickstart \
  --title "Docs Editor Quickstart"
```

Apply it:

```bash
cd website
python3 scripts/docs-editor.py --apply page create \
  --version 0.7 \
  --book website-dev-guide \
  --section authoring-and-tooling \
  --page docs-editor-quickstart \
  --title "Docs Editor Quickstart"
```

## Example: Rename a Page

```bash
cd website
python3 scripts/docs-editor.py page rename \
  --version 0.7 \
  --book website-dev-guide \
  --section docs-platform \
  --from website-and-docs-architecture-overview \
  --to website-and-docs-system-overview \
  --title "Website And Docs System Overview"
```

That preview is especially useful when a rename may propagate into inherited descendants, because the metadata section shows which later inherited versions will follow the rename.

## Convert an Inherited Page to Real Content

Sometimes a later version already has the page path and nav entry, but the page itself is still inherited through an empty `inherit.md` marker.

In that case, do not use `page create`. The page already exists structurally.

Use `page materialize`:

```bash
cd website
python3 scripts/docs-editor.py page materialize \
  --version 0.8 \
  --book website-dev-guide \
  --section docs-platform \
  --page website-and-docs-architecture-overview
```

Apply it:

```bash
cd website
python3 scripts/docs-editor.py --apply page materialize \
  --version 0.8 \
  --book website-dev-guide \
  --section docs-platform \
  --page website-and-docs-architecture-overview
```

That command:

- removes the empty `inherit.md` marker in that version
- copies the currently resolved inherited `index.md` content into the page directory
- lets you optionally replace the page title with `--title`

After that, edit the new `index.md` for the version-specific behavior.

## Convert an Inherited Book Landing Page to Real Content

Use `book materialize` when a version inherits a book landing page through `_inherit.md` and needs version-specific copy:

```bash
cd website
python3 scripts/docs-editor.py --apply book materialize \
  --version 0.9 \
  --book admin-guide
```

The command replaces `_inherit.md` with the currently resolved `_index.md` content. Use `--title` to replace its title while materializing.

## Move a Page Between Sections

Use `page move` to move a page within one book while preserving its body content:

```bash
cd website
python3 scripts/docs-editor.py page move \
  --version 0.9 \
  --book admin-guide \
  --from-section configuration \
  --to-section reference \
  --page configuration-key-reference \
  --to-page configuration-file-reference \
  --position start
```

The tool updates both page lists, creates real content at the destination, and removes the source directory. `--to-page` is optional and defaults to the source page slug. `--position` applies to the selected version's destination section.

Later inherited-only versions follow the move automatically. The tool refuses when the destination exists, a later version has authored source content, or a later version lacks the destination section. Update Markdown links and managed redirects separately.

## Convert Real Page Content Back to Inherited Content

If you no longer need a version-specific page override, you can convert the page back to an inherited marker.

Use `page inherit`:

```bash
cd website
python3 scripts/docs-editor.py page inherit \
  --version 0.8 \
  --book website-dev-guide \
  --section docs-platform \
  --page website-and-docs-architecture-overview
```

Apply it:

```bash
cd website
python3 scripts/docs-editor.py --apply --yes page inherit \
  --version 0.8 \
  --book website-dev-guide \
  --section docs-platform \
  --page website-and-docs-architecture-overview
```

This is destructive because it removes that version's real `index.md` and replaces it with `inherit.md`.

The command refuses when no earlier version provides real page content for the same path.

Manual fallback if you need finer control:

1. Identify the inherited source page you want to override.
1. Copy that page's current content into the later version as a starting point.
1. Replace the later version's empty `inherit.md` with a real `index.md`.
1. Edit the new `index.md` for the version-specific behavior.

This is still not a page-creation step. The page identity and nav structure already exist; `page materialize` only turns the inherited marker into authored page content in the selected version.

If a position selector fails, the CLI also reports the valid sibling slugs so you can retry without opening the nav file first.

## Safety Model

Moves, renames, and release transitions also use the shared
[migration decisions and HTTP alias rules](../../docs-platform/docs-runtime-and-route-resolution/#migration-decisions).
Preview includes aliases; apply saves them with content and navigation. Use
`version set-current <next-version>` for a checked current-version change.

The docs editor is deliberately conservative.

- preview is the default
- no files are written unless you pass `--apply`
- destructive operations require confirmation unless you pass `--yes`
- docs validation runs automatically after a successful apply

### Refusal Semantics

The tool refuses destructive operations when they would silently rewrite newer authored content.

Typical refusal case:

- an older version rename would force changes into a later version that already has real content at the affected path

In that case, the CLI exits non-zero, reports the refusal reason, and leaves the docs tree unchanged.

## Generate a Docs Structure Report

The docs editor package also includes a standalone report generator for exploring the docs tree across versions.

Use it when you want a repo-local HTML view of:

- books, sections, and pages in one expandable tree-table
- current-version metadata and version status labels
- inherited versus authored versus branched page states
- diff counts for branched pages relative to the earlier authored version
- per-page version comparison in the side panel

The wrapper script lives at `website/scripts/docs-report.py`.

For normal contributor workflow, prefer the repo helper:

```bash
cd /workspace
python3 scripts/update-docs-derived-artifacts.py
```

That helper centralizes the repo-local behavior around derived docs artifacts.

- the pre-commit hook calls it automatically when staged docs inputs can stale the committed report
- it stages the refreshed report for you in that hook-driven path
- the VS Code workspace task `Website: Refresh Docs Derived Artifacts` runs the same helper manually

Generate the report into the committed output path:

```bash
cd /workspace
python3 website/scripts/docs-report.py
```

That writes `website-meta/docs-reports/docs-structure-report.html`.

Use check mode in CI or before opening a pull request:

```bash
cd /workspace
python3 website/scripts/docs-report.py --check
```

That exits non-zero when the committed HTML report is stale.

## Detailed Reference

The full CLI reference now lives on a separate page so this overview can stay task-focused.

Use [Docs Editor Operation Reference](../docs-editor-operation-reference/) when you need:

- the full global option list
- forward-impact analysis rules
- content invariants preserved by the tool
- real-content stub and inherited-marker behavior
- preview output details
- per-entity create, delete, and rename reference behavior
