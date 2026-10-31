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

Text viewing/editing, Markdown source and rendered Markdown fences share the CodeMirror language registry and tag mapping in `codeMirrorHighlightingCore.ts`. `syntaxHighlighting.ts` defines application-owned language IDs, UTF-16 token ranges, categories and explicit results that indicate plain text. Native editors and the syntax worker reuse that implementation. Fence aliases resolve to existing lazy grammars, including `mssql` to MS SQL and `mariadb` to MariaDB SQL. A `.sql` filename continues to select standard SQL; unknown fence labels aren't guessed.

The live Markdown viewer collects exact code occurrences from ReactMarkdown's existing AST, without another collection parse or embedded editors. A dedicated cancellable worker prepares syntax sequentially with acknowledged source chunks of at most 16,384 UTF-16 units and result pages of at most 512 ranges. Blocks above 100,000 UTF-16 units stay plain text. Nested Markdown fences use the configured Markdown parser, up to four Markdown levels including the outer block. Unknown, unlabelled and explicit plain-text fences remain neutral. A nested grammar load failure, or a parser error during static fence startup or advancement, leaves only the failed fence plain while retaining enclosing Markdown structure and successful siblings. The static adapter doesn't mutate cached grammars or retry parsing; later fences and preparations can still succeed. Closing during a pending grammar load terminates the generation's worker; reopening starts a fresh preparation. Cancellation still propagates, and exceeding the nesting limit intentionally keeps the whole outer block plain without suppressing unrelated blocks. There's no aggregate document-length or block-count cutoff. The pre-app browser capability gate requires the Web Worker API; Worker-less app operation isn't supported. The helper's defensive main-thread fallback isn't a supported browser mode or a responsiveness guarantee.

Each preview generation owns cancellation and stale-result guards. After all requested blocks finish, the viewer paints at most 4,000 viewport syntax ranges through CSS Highlights. Vertical and horizontal clipping avoid publishing off-screen token ranges; scrolling, viewport resize, image loads and font readiness refresh presentation. Publication doesn't replace text nodes or insert token spans, preserving native text, whitespace, selection and the cached preview-search index. Missing highlight/visibility capabilities leave syntax plain instead of falling back to token DOM mutation. Disposal removes owned highlights, style, observers, listeners and queued frames. First visible syntax, complete preparation, memory and native interaction acceptance remain separate rollout gates; see [Viewer Architecture and Preview Contracts](../viewer-architecture-and-preview-contracts/).

The existing theme provider installs stable application token rules once. Viewer/editor surfaces publish locally inherited CSS variables from the resolved MUI syntax palette, so changing theme colors doesn't require reparsing code or replacing token DOM. Identifiers and neutral code inherit the existing code foreground. Markdown source headings and structural markers use `keyword`; links use the existing link role; inline code uses the existing code foreground. Emphasis, strong text, and strikethrough change only their corresponding semantic treatment, not source font sizes or line geometry. Embedded code uses code categories, not Markdown prose styling.

The shared mapping also preserves built-ins, properties and keys, booleans, null, regular expressions, escapes, and metadata/directives when the grammar supplies those tags. `TOKEN_COLOR_ROLES` maps these categories to the existing eight syntax colors: built-ins use `function`; properties and regular expressions use `type`; booleans, null, and metadata use `keyword`; escapes use `operator`. Editors and rendered fences share this mapping without another parse or a theme schema change. Built-in names aren't necessarily commands, and grammar classifications vary: PowerShell variables and bare words can both remain neutral identifiers. There are no language-specific classification overrides.

Search matches use the viewer text foreground instead of syntax colors so matched keywords remain readable against their highlight backgrounds. Source editors apply that foreground to the match and its nested tokens. Preview search inherits `--sambee-search-foreground` from its own viewer; syntax highlights have priority -1, ordinary search highlights 0, and the current match 1. The shared search-color helper preserves the configured hues and uses 30%/36% opacity for ordinary/current matches in light mode and 40%/44% in dark mode. Custom theme validation checks color format and completeness, not contrast; choose text, syntax and surface colors that remain readable after alpha blending.

Theme updates and lazy grammar completion preserve native selection, the active search match and both scroll axes on all four surfaces. Theme changes don't restart syntax preparation or renormalize unchanged Markdown. Late grammar completion can update editor token spans, while preview publication retains its original text nodes. These state guarantees don't establish scrolling performance, native clipboard behavior or close/navigation acceptance.

Replacing an editor doesn't require replacing static highlighting. Replacing the engine requires preserving the application's requirements for token ranges and highlighting results, aliases where supported, and viewer lifecycle. Classification parity with a different engine isn't automatic. Removing CodeMirror entirely also requires migrating native editor integrations such as commands, autocomplete, and tables.

## Verification

Run focused theme tests and the project checks after changing the palette, API, or editor:

```bash
cd frontend && npm run test -- src/theme/__tests__ src/pages/__tests__/PreferencesSettings.test.tsx
cd frontend && npm run build && npm run lint
cd backend && .venv/bin/python -m pytest tests/test_user_settings.py
```

Check the Appearance grid and editor on a phone and desktop in both built-in modes. Verify selection and saved-theme refresh after focus, color picker keyboard use and placement, alpha values and export, Cancel without applying the draft, and stale-save feedback.

For the production theme-dialog browser regressions, build the frontend first and keep the existing frontend/backend dev servers running. From `frontend/`, run:

```bash
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production syntax theme dialog' --workers=1
```

The suite serves built assets and intercepts theme APIs at `http://localhost:3000/browse/smb/demo`; it doesn't change stored themes. Chromium and Firefox cover save/cancel/copy, validation focus, personal/site/built-in permissions, alpha values, unchanged selection after copying, and rejected-save feedback at 1543x900 and 390x600. Narrow desktop viewports don't replace testing on a physical phone or with assistive technology.
