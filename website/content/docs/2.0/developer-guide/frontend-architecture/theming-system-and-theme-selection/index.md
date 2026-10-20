+++
title = "Theming System and Theme Selection"
+++

Sambee has two built-in themes (`sambee-light` and `sambee-dark`), user-owned themes, and administrator-managed site themes. Built-in IDs stay stable across upgrades, so updating their palettes doesn't change anyone's selection.

## Theme Data

| Path | Responsibility |
|---|---|
| `frontend/src/theme/types.ts` | Palette types and editor field labels |
| `frontend/src/theme/themes.ts` | Built-in definitions with stable IDs |
| `frontend/src/theme/themeDefinition.ts` | Editable color catalog, hex checks, and versioned import/export |
| `frontend/src/theme/resolveSyntaxTheme.ts` | Non-mutating legacy syntax defaults and strict supplied-palette validation |
| `frontend/src/theme/syntaxStyles.ts` | Shared token classes and locally inherited syntax variables |
| `frontend/src/theme/palette.ts` | Shared effective palette for the app |
| `frontend/src/theme/viewerStyles.ts` | Viewer and Markdown document surfaces |
| `frontend/src/theme/ThemeContext.tsx` | Registry refresh and Material UI theme |
| `frontend/src/pages/PreferencesSettings.tsx` | Selection grid and selected-theme actions |
| `frontend/src/components/Settings/ThemeEditorDialog.tsx` | Responsive theme editor |
| `backend/app/api/themes.py` | Validated theme operations and site default |

Each editable theme has its own server row with a globally unique ID, scope, owner (for user themes), and version. Built-in definitions remain in frontend code. A new theme ID is assigned by the server; an ID in an imported file does not claim or replace a stored theme.

Colors use `#RRGGBB` or `#RRGGBBAA`; the server normalizes valid hex to uppercase. The role catalog includes primary, backgrounds, text, selection, links, viewer surfaces, Markdown document surfaces, syntax, search highlights, and alerts. File-type icons aren't theme roles. Derived colors such as scrollbar shades, focus rings, and `background.paper` compatibility aren't editor fields. Keyboard focus rings follow the theme's primary text color: 57% opacity in light mode and 94% in dark mode. Changing that text color changes the focus color too, including in copied themes; legacy saved focus colors are ignored. Choose primary text that remains readable against the theme's surfaces.

Every existing editable role remains required. The additive `components.syntax` group has eight roles: `keyword`, `string`, `number`, `comment`, `type`, `function`, `operator`, and `punctuation`. If the entire group is absent from a stored definition or version-1 import, the frontend resolves the matching built-in light/dark palette without mutating or saving the original. A supplied group must contain exactly all eight valid colors; partial groups, nulls, unknown keys, and invalid colors are rejected by both frontend and backend. Save, copy, and export include the resolved group through the existing API and version-1 envelope. No database migration or separate syntax preferences are needed. Older application releases may reject these newer exports.

## Selection And Defaults

`SambeeThemeProvider` combines built-ins with the current user's themes and shared site themes from `GET /api/themes`. The per-user selection is saved separately through `appearance.theme_id` in `PUT /api/auth/me/settings`. The backend reports whether that value is an explicit override.

A user without an override follows the site default (initially `sambee-light`). A user who explicitly chooses `sambee-light` keeps that ID even if an administrator changes the site default. The selected ID points at a theme definition, never at a frozen copy of a built-in. The provider refreshes shared themes, the default, and user settings on initial load, tab focus, visibility return, and local writes. It discards out-of-date responses when the account changes.

Appearance settings display Your themes, Site themes, then Built-in themes. Clicking a tile or selecting its radio applies the theme and creates an explicit user override, even when it already matches the site default. Moving focus between radios doesn't change the applied theme or the target of Copy, Edit, Delete, and Set as default. The Default chip is distinct from the selected radio. Copy keeps writable themes in their group and copies read-only themes into Your themes without applying the copy. Editing read-only themes permits inspection and Save copy, but not Save. Only an administrator can save or delete site themes or make a built-in or site theme the default.

## Editing And Persistence

The editor uses a responsive dialog with collapsible color groups. A swatch opens an alpha-aware picker and each color has an editable hex field. Invalid text stays in the field without changing the valid draft. Changes in the editor aren't applied to the app until Save succeeds; Cancel discards the draft. Import replaces only the draft after validating a versioned JSON definition, and Export writes the same format.

`POST /api/themes` creates a theme. Save copy opens a destination menu with Your themes for everyone and Site themes for administrators. It always creates a new theme in the chosen group without changing the applied selection. If its name already exists in that group, the editor adds ` (copy)` or a numbered copy suffix. Save updates only the opened theme in its existing group and cannot create a copy. `PUT /api/themes/{id}` and `DELETE /api/themes/{id}?version=...` require the version read by the client; a stale version returns HTTP 409. The server checks ownership, admin permissions, names, IDs, and palette completeness before committing. Bulk writes to `appearance.custom_themes` are no longer supported. Legacy syntax compatibility is limited to an entirely absent syntax group; it doesn't repair incomplete older definitions.

Deleting a theme clears explicit selections referencing it. If it was the site default, that setting is cleared too; users without an override then fall back to Sambee light. An explicit selection of another theme is unaffected.

## Component Guidance

Prefer the effective colors in `resolveThemePalette` and the MUI palette to hard-coded surfaces. `background.default` is the normal application surface; `background.paper` resolves to the same value for MUI compatibility. Dark chrome and dialogs use the editable `background.chrome` role. Markdown code, tables, blockquotes, and heading borders use the built-in theme's explicit document colors.

Viewer toolbar foreground variants, scrollbars, and subdued states can still derive opacity-adjusted values from their source color. Keep fixed colors for assets and file-type icons separate from the editor palette.

## Shared Syntax Highlighting

Text viewing/editing and Markdown source/fenced code use the same CodeMirror language descriptions and tag mapping as rendered Markdown code blocks. `syntaxHighlighting.ts` defines application-owned language IDs, UTF-16 token ranges, categories, and explicit plain-text outcomes. `highlightingService.ts` selects the implementation in `codeMirrorHighlighting.ts`; only that implementation and its native editor bridge import engine APIs. `markdownSyntax.ts` collects exact code occurrences from the Markdown AST and renders prepared ranges as text and classed spans, without parsing a grammar or mounting an editor.

The implementation lazily loads grammars and prepares blocks sequentially, yielding browser tasks between blocks and nested discovery units. Static blocks above 100,000 UTF-16 code units stay entirely plain text. Nested Markdown fences are discovered with the configured Markdown parser and settled before the final parse, up to four Markdown levels including the outer block. Unknown, unlabelled, and explicit plain-text fences remain neutral. Loading or parsing failures affect only their containing block. There's no aggregate document-length or block-count cutoff. Preparation and final DOM/search work still run on the main thread; the queue doesn't interrupt an individual parse or promise responsiveness for arbitrary document sizes.

The viewer owns cancellation, content generations, and committed preview revisions. It publishes one keyed subtree per completed preparation, defers a highlighting-only commit while native text selection intersects the preview, and rebuilds active search against the latest query. Ordered search mapping preserves code whitespace and logical matches across token nodes. Syntax preparation doesn't own DOM, search, scroll, or selection state.

The existing theme provider installs stable application token rules once. Viewer/editor surfaces publish locally inherited CSS variables from the resolved MUI syntax palette, so changing theme colors doesn't require reparsing code or replacing token DOM. Identifiers and neutral code inherit the existing code foreground. Markdown source headings and structural markers use `keyword`; links use the existing link role; inline code uses the existing code foreground. Emphasis, strong text, and strikethrough change only their corresponding semantic treatment, not source font sizes or line geometry. Embedded code uses code categories, not Markdown prose styling.

Replacing an editor doesn't require replacing static highlighting. Replacing the engine requires preserving the application range/outcome contract, aliases where supported, and viewer lifecycle. Classification parity with a different engine isn't automatic. Removing CodeMirror entirely also requires migrating native editor integrations such as commands, autocomplete, and tables.

## Verification

Run focused theme tests and the project checks after changing the palette, API, or editor:

```bash
cd frontend && npm run test -- src/theme/__tests__ src/pages/__tests__/PreferencesSettings.test.tsx
cd frontend && npm run build && npm run lint
cd backend && .venv/bin/python -m pytest tests/test_user_settings.py
```

Check the Appearance grid and editor on a phone and desktop in both built-in modes. Verify selection and saved-theme refresh after focus, color picker keyboard use and placement, alpha values and export, Cancel without applying the draft, and stale-save feedback.
