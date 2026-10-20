# Shared Syntax Highlighting Plan

Status: Core implementation integrated; acceptance incomplete. The token-dense
browser publication gate fails. On 2026-10-20, option 3 (model-backed virtualized
preview) was approved, including the editor serialization and search performance
work. P1 has production-built code-only and streamed whole-Markdown prototypes
with focused model regressions. The retained-plain-text direction was subsequently approved,
including relaxation of strict viewport-only text DOM mounting. Its interaction
gate remains open. P2-P6 have not started.
Merge remains blocked on that work and acceptance verification; the provisional
block-size safeguard is not accepted as measured safe.

The performance addendum below is authoritative where it supersedes the original
main-thread, whole-preview publication, DOM-search, and non-virtualization rules.
The scope decision is resolved; the performance failure is not.

## Goal

Use the same language parsers and token colors for the text viewer, text editor,
Markdown viewer code blocks, and Markdown editor code blocks. Also highlight the
actual Markdown source lines in the regular Markdown editor, not only fenced
code. Keep the solution small, preserve existing interactions, and avoid
embedding editors in rendered Markdown.

Contain the dependency on CodeMirror behind a small application-owned highlighting
contract. A future editor replacement must not require changing static Markdown
rendering, token CSS, or preview/search ownership. This contains coupling; it does
not make the current implementation independent of CodeMirror packages or promise
identical token classification from a different engine.

## Original Implementation Baseline

This section describes the starting point before the core implementation, not
the current code. Current progress is marked in Implementation Sequence and
Acceptance Checks; measured evidence is in Implementation Verification Record.

- Text viewing and editing share `frontend/src/components/Viewer/TextCodeEditor.tsx`.
  Filename-based language lookup uses `@codemirror/language-data`; language support
  loads asynchronously. The shared extensions configure fallback highlighting,
  while `buildTextEditorTheme.ts` supplies custom keyword, string, and comment
  rules. CodeMirror's fallback applies only when no non-fallback highlighter is
  registered; it does not fill gaps in the custom rules.
- Markdown editing uses the same language registry for fenced code blocks, but
  disables default highlighting and supplies only a narrow custom token style.
- Markdown viewing uses synchronous `ReactMarkdown` with `rehype-highlight` and
  the Highlight.js GitHub stylesheet. Its language support and colors differ
  from CodeMirror's.
- Markdown viewer search applies highlights to rendered DOM text. Replacing
  token spans asynchronously must be coordinated with that search lifecycle.
- Themes already flow through `ThemeConfig`, `THEME_SCHEMA`, schema-derived
  `COLOR_ROLES`, `SambeeThemeProvider`, and the MUI theme. `ThemeEditorDialog`
  edits those roles with existing color controls and saves personal/site themes
  through the theme API. Import/export uses versioned theme definitions.
- Frontend import validation and backend `COLOR_SHAPE` validation currently
  require all exposed color roles. Adding syntax roles without a compatibility
  rule would break existing stored themes and imports. Syntax colors currently
  bypass that system: text editor keywords/strings use an accent, comments use
  derived text opacity, and rendered Markdown uses the Highlight.js stylesheet.
- `frontend/src/utils/domTextSearch.ts` currently drops whitespace-only text
  nodes. Syntax spans can isolate spaces between tokens, causing the search index
  to join words that are separated in the displayed source.

## Proposed Design

### Application-Owned Highlighting Boundary

Provide one concrete highlighting service with a small public contract. Keep its
public types free of CodeMirror and Lezer imports, including inferred return types.
Separate these responsibilities without introducing a framework:

- Application contract: language IDs, token categories, source ranges, and explicit
  plain-text fallback outcomes. No parser objects, syntax trees, editor extensions,
  HTML, DOM nodes, or engine-generated CSS classes cross this boundary.
- CodeMirror-backed implementation: language-description lookup, lazy loading,
  parsing, and conversion of Lezer tags into application token categories. Use
  public package exports only; do not copy grammars or access private internals.
- Presentation: map application categories to stable CSS classes and theme colors;
  convert prepared ranges into Markdown AST text nodes and spans.
- Native editor integration: obtain CodeMirror language extensions and build
  CodeMirror highlighting rules using the same internal language configuration and
  tag/category mapping. This is an explicitly CodeMirror-specific entry point,
  separate from the engine-neutral service.

Keep the contract and presentation modules independent of the backend at runtime.
Only the concrete service entry point selects the CodeMirror implementation; the
static Markdown renderer consumes prepared application data, not the backend.
Keep source files few and focused, following existing utility/module conventions.
Do not add provider registration, runtime engine selection, dependency-injection
infrastructure, a universal editor API, or a parallel language registry.

Use the following minimal data contract:

- Language IDs are opaque application strings, not CodeMirror objects or an
  exhaustive enum of every installed language. The backend normalizes registry
  names and preserves supported dialect distinctions; callers do not construct
  IDs or interpret their spelling. Resolution returns an ID or an explicit
  unknown/plain-text outcome without loading a grammar.
- Token categories form a small centrally defined vocabulary for code styling
  and Markdown source structure. They describe presentation, not a universal
  syntax tree or semantic analysis API.
- Each static token range has `from`, `to`, and one or more token categories.
  Offsets are UTF-16 code-unit offsets into the unchanged input; ranges are ordered,
  non-overlapping, non-empty, and within its bounds. Uncovered text stays neutral.
  Multiple categories allow intentional combinations without exposing Lezer tags.
- Static preparation accepts code-block requests in document order and, unless
  aborted, returns a settled result for each block: highlighted ranges or a
  plain-text reason such as unknown language, explicit plain text, block too large,
  nesting depth exceeded, loading failure, or parsing failure. Empty ranges are
  valid for successfully parsed neutral text. Parser handles, loading promises,
  and queue scheduling remain implementation details. There is no cumulative
  document-length or block-count cutoff.

Keep preparation free of React, live DOM, selection, and search state. Accept an
optional standard `AbortSignal` so the viewer can stop obsolete queued work while
retaining ownership of generation checks and publication. Aborting preparation
rejects that request with `AbortError`, without publishing a partial result or
cancelling shared grammar loads. Handle and log actual backend failures once with
language and operation context, without logging document text. Expected plain-text
outcomes and cancellation are not errors to log.

### Shared Language Resolution

Reuse the installed CodeMirror language descriptions inside the backend. Provide
separate, small lookup functions for filenames and Markdown fence labels that
return application language IDs, not descriptions. The native editor bridge uses
the same internal resolution/configuration to obtain language support. Preserve
lazy loading and reuse the descriptions' existing loading behavior rather than
building a second parser cache. Use the same grammar/dialect configuration for
native editing and static highlighting of a resolved language.

Fence labels remain case-insensitive. Do not infer languages from block contents.
Check currently supported Highlight.js aliases and explicitly map compatibility
aliases where needed. Do not treat arbitrary file extensions as fence aliases.

### Shared Token Styling

Define application token categories for keywords, strings, numbers, comments,
types, functions, operators, punctuation, and ordinary identifiers. Map categories
to stable application-owned token classes and define their colors once using
theme CSS variables. Keep categories, class names, and CSS independent of Lezer
and CodeMirror.

Inside the backend, maintain one tag/category mapping and use it both to build the
native CodeMirror `HighlightStyle` and to convert static highlighting into token
ranges. Preserve tag specificity, precedence, and intentional category combinations
in both paths; do not maintain two independently authored token rule sets. A
complete style covers supported tag families, not every character: untagged text
and whitespace remain unchanged and neutral.

Use the same classes and CSS in all editor and static Markdown surfaces. Install
the CSS at the viewer/editor surface level, independently of editor mounting, and
update variables on theme changes without reparsing code or replacing the preview.

Replace competing default/custom code highlighting rules. Scope the Markdown
source style to the outer Markdown language and the code style to embedded
languages; do not let generic string/link tags apply both styles to code. Verify
the scope behavior with actual nested syntax trees, including legacy parsers.

Keep background, border, wrapping, selection, and search styling independent of
syntax token styling. Support both application light and dark themes.

### Integration With Existing Themes And Theme Editor

Use the existing application theme as the sole source of syntax colors, not a
separate syntax-theme store, provider, selector, or light/dark stylesheet. The
data flow is:

`ThemeConfig` -> existing theme resolution -> MUI theme -> shared syntax CSS
variables -> application token classes in native editors and static Markdown.

Keep this theme integration in the presentation layer. Parsers and prepared token
ranges contain categories, never colors or a theme ID. Theme changes do not
invalidate language loading, parsing, prepared results, or preview revisions.

#### Minimal Editable Palette

Add `components.syntax` to `ThemeConfig` and `THEME_SCHEMA`, with one shared
palette for all four surfaces. Expose it through schema-derived `COLOR_ROLES`
under one new `Syntax` group in `ThemeEditorDialog`. Use eight foreground roles:
`keyword`, `string`, `number`, `comment`, `type`, `function`, `operator`, and
`punctuation`. Keep the application token-category vocabulary separate from these
color roles: several categories may intentionally share a role.

Ordinary identifiers and neutral source inherit the existing code foreground
(`components.markdownViewer.document.codeText` where already used), rather than
adding a second editable default-text role. Retain existing surface foregrounds
and backgrounds in their current owners; syntax colors do not redefine them.
Do not add per-language or per-viewer palettes, per-tag color controls, editable
font settings, or independent Markdown source color settings.

Define the Markdown-source category mapping once: heading text and structural
markers use `keyword`, destinations/link text use the existing link role, inline
code uses the existing code foreground, and emphasis/strong/strikethrough retain
inherited color with fixed italic/bold/strike treatment. Paragraphs remain neutral.
Keep source typography limited to those existing semantic treatments; no font-size,
line-height, or spacing changes. These rules apply to source, not rendered prose
or rendered inline-code styling. Embedded code uses only code categories.

#### Defaults, Validation, And Persistence

Define explicit syntax colors in both built-in themes, with readable contrast on
their existing code surfaces. The corresponding built-in light/dark syntax
palette is the single frontend fallback for legacy themes, selected by the
theme's mode. Do not derive syntax colors independently from UI accent colors or
duplicate fallback hex values in editors, viewers, or CSS.

Treat the new group as an additive optional group in persisted definitions:

- If `components.syntax` is entirely absent, resolve its eight defaults centrally
  before theme-editor draft validation, theme application, or export. Preserve all
  existing custom colors. Do not write themes merely because they were loaded.
- If the group is supplied, require every role and validate each value using the
  existing `#RRGGBB`/`#RRGGBBAA` rules. Reject partial groups, nulls, unknown keys,
  and invalid values rather than silently replacing them. Missing existing roles
  remain errors; this is not a general relaxation of theme validation.
- Update frontend import/validation and backend theme-model/API validation
  together. Backend `COLOR_SHAPE` handling must accept the absent legacy group
  and strictly validate a supplied group; it need not duplicate frontend fallback
  palettes. Existing stored definitions can remain unchanged until explicitly saved.
- Saving, copying, and exporting a resolved draft includes the full syntax group
  through the existing personal/site API and version-1 export envelope. Preserve
  permissions, identity handling, conflict versions, normalization, and errors.
  No database migration or separate syntax preferences are needed. Older clients
  may reject newly exported roles; do not claim backward import compatibility
  with older application releases. The updated app must import old exports.

Reuse one frontend resolver for applying themes and preparing editor/import
drafts, and test its idempotence and lack of mutation. Keep backend compatibility
limited to the same absence-versus-present rule rather than introducing another
theme resolution system.

#### CSS And Editor Behavior

Extend the existing typed MUI palette path (`ThemeContext.tsx` and
`mui-theme-extensions.d.ts`) with the resolved syntax palette. Install token class
rules once through the existing theme presentation infrastructure, and publish
their variables at the shared viewer/editor surface boundary using one helper.
Use local inherited variables so scoped themes and any existing draft previews
can coexist; do not imperatively write syntax colors onto `document.documentElement`.
Static Markdown must receive the rules and variables without mounting an editor.

CodeMirror token rules refer to application classes/CSS variables, not literal
theme colors; keep their tag mapping stable across theme changes. Remove the
competing accent/string/comment rules and Highlight.js token stylesheet. Changing
an active theme or saving updated colors must update computed token colors across
all four surfaces without reparsing, remounting editors, replacing preview/token
DOM, clearing search, moving scroll, or disturbing native selection. Surface
styling may update through its existing path independently.

Extend the existing color swatch/picker/hex-input rows and responsive form pattern
for the `Syntax` group; do not create a second settings dialog or add a new live
preview subsystem. Draft changes follow the current save/cancel workflow, without
applying unsaved colors globally. Invalid input focuses its existing field/group
and uses existing validation feedback. Check alpha colors against actual surface
backgrounds and preserve search/selection contrast; do not add a contrast engine
or silently adjust user-specified values.

### Markdown Source Highlighting

Within the native editor integration, use CodeMirror's existing Markdown parser
and Lezer tags; do not add a second Markdown parser or regex-based decorations
for editor highlighting. Map Markdown tags to application-owned source categories
and define a small companion style for headings and their markers, emphasis/strong text,
strikethrough, list and blockquote markers, links/images and destinations, inline
code, thematic breaks, and fenced-code delimiters/language labels. Keep ordinary
paragraph text neutral and distinguish Markdown structure without making source
lines look like rendered headings or changing their font size or line geometry.

Apply this style in the regular Markdown editor and when a Markdown file is
opened in the text viewer/editor. Known fenced languages use the shared code
style; delimiters use the Markdown style. Unknown/unlabelled code contents must
not acquire prose highlighting. Preserve table editing, autocomplete, navigation,
selection, and source serialization; this is highlighting, not a rich-text rewrite.

### Static Markdown Highlighting

Replace `rehype-highlight` with a small engine-neutral Markdown adapter consuming
prepared application token ranges. The CodeMirror backend uses each resolved
language's public `support.language.parser`, `parser.parse`, and Lezer's
`highlightTree` internally. No editor instance is needed, including for legacy
stream languages that expose the common parser interface. Their token detail can
differ from native Lezer grammars; verify actual output rather than assuming it.

Do not rely on editor parse scheduling to settle embedded grammars. Markdown's
lazy fenced-code parser can return a skipping parser on a cold standalone parse;
loading the outer Markdown language alone does not make nested code ready. For
Markdown-labelled static blocks, discover nested fences with the configured
Markdown parser's public APIs and lazy fenced-code loading disabled, then resolve
and await their eligible grammars before the final highlighting parse. Use the
same fence resolver and grammar configuration as native editing, not another
Markdown parser or regex scan. Preparation must produce the same ranges whether
those grammars were already loaded by an editor or not.

Keep recursive Markdown-fence discovery bounded by a centrally defined initial
limit of four Markdown levels, counting the outer static block as level one.
Check the containing block's size and each nested Markdown level before loading
grammars solely for that work. Repeated discovery and final parses do not consume
a document-wide quota; the block-size safeguard and depth guard constrain this
work instead. Yield between nested discovery/preparation units as well as between
top-level blocks. If required nested preparation fails or exceeds a guard, return
the containing static block as plain text with the applicable loading/parsing,
block-size, or nesting-depth reason; other static blocks still settle independently.
Unknown, unlabelled, and explicit plain-text nested fences remain neutral without
triggering grammar loads. Never publish a successful partial result merely because
a skipping parser did not throw.

Collect fence labels and exact code text from the Markdown AST, not regexes.
Prepare grammar loads and token ranges asynchronously outside the synchronous
`ReactMarkdown` plugin path. Associate results with their exact block occurrence
and content generation, including repeated identical blocks. Settle all required
language loads and parsing results, including individual failures, and publish
one prepared result per content generation rather than updating the DOM once per
block. The synchronous adapter only slices original text at prepared ranges and
emits normal text nodes and classed spans inside existing `pre` and `code`
elements, never raw HTML or a CodeMirror instance per block. It must not parse,
load grammars, or import engine packages. Preserve source text, whitespace,
copying, and native selection.

Display plain text until preparation completes, then publish the single prepared
result through the existing viewer-owned commit path. Yielding preparation does
not introduce per-block DOM updates or viewport-driven highlighting. Longer
documents may take longer to acquire highlighting; their later eligible blocks
must not be skipped solely because earlier blocks consumed processing time or
source length. A failed grammar must not prevent other blocks highlighting.

Unlabelled, unknown, explicitly plain-text, failed, and oversized blocks remain
plain text. Catch and log actual loading/parsing failures without failing the
whole document. The service owns a centrally defined provisional safeguard of
100,000 UTF-16 code units per static block. Check it before loading grammars solely
for that block or parsing it; oversized blocks remain entirely plain text, not
truncated or partially highlighted. Do not enforce an aggregate document-size,
total-work, or block-count cutoff. The per-block value is an unmeasured starting
assumption, not an established safe threshold; retain, raise, or lower it based on
representative browser measurements before merging. Keep the nesting-depth guard
separate from the size safeguard.

Prepare eligible blocks sequentially in document order through a small yielding
queue inside the service, reusing the language descriptions' shared loads. Yield
to a browser task between blocks and nested preparation units, including when
grammars are already cached. Use `scheduler.yield()` where available with a
timer-task fallback in one helper; resolved promises or `queueMicrotask` alone do
not let input and rendering run. Do not add a scheduler framework, parallel parse
pool, or another grammar cache.

On document changes, entering edit mode, or unmounting, the viewer aborts the old
request and ignores any stale completion. Check cancellation before each queued
unit, after each yield, and after grammar-load waits so obsolete work does not
start another parse. Abort waiting promptly without cancelling the shared load;
its eventual rejection must still be handled. Generation checks remain the final
publication guard. A synchronous parse or token traversal already in progress
cannot be interrupted by this signal.

Parsing and token extraction remain on the main thread. Yielding reduces
uninterrupted work across blocks; it does not time-slice an individual parse,
bound final token DOM/search costs, or guarantee responsiveness for arbitrary
documents. Verify those costs explicitly. Workers, incremental publication, and
virtualization remain outside this change; do not claim unlimited-size support
or reintroduce a cumulative cutoff to hide a failed performance check.

### Preview Commit And Search Ownership

The Markdown viewer owns a content-generation identifier and a separate committed
preview revision. The service returns application data; the static adapter only
transforms that prepared content. Neither may manipulate live DOM, emit per-block
completion events, or manage search. Keep this lifecycle independent of the
CodeMirror backend so changing engines does not change preview ownership.

On publishing a prepared result, the viewer clears existing search markers and
invalidates saved match-element references, then replaces a keyed preview subtree
and increments its revision together. The key ensures React does not reconcile
token nodes whose text descendants were split or wrapped by DOM search. Reject
results whose content generation is no longer current. Defer a highlighting-only
replacement while a non-collapsed native selection intersects the preview, so
loading grammars does not destroy an in-progress text selection.

After the new subtree commits, a viewer-owned layout effect recomputes search
using the latest query and committed preview revision. Its cleanup clears markers
and references on that specific subtree. Do not capture the query when starting
grammar loads. Preserve the active logical match ordinal when still valid,
otherwise clamp it to the remaining matches; report zero when none remain.
Avoid automatic scrolling for a highlighting-only refresh when the active match
is unchanged. Preserve the viewer's scroll position during subtree replacement.

Fix `domTextSearch.ts` to index whitespace-only text nodes inside `pre` elements
exactly, including spaces, tabs, and newlines. Keep existing prose whitespace and
block-boundary behavior outside code blocks to avoid introducing matches from
layout indentation. Do not normalize code text or query-internal whitespace.
Retain the existing logical-match mapping across multiple text nodes so one
match can cover several token spans. In the same helper, replace the per-match
scan of every indexed segment with an ordered-segment walk. Matches and segments
are already ordered; advance through them without restarting, emitting only
actual overlaps. This keeps mapping work proportional to matches, segments, and
emitted slices rather than their product. Preserve the existing query semantics,
match IDs, and multi-node highlighting. These are targeted prerequisite fixes,
not a rewrite of viewer search.

Gate the layout-effect integration on a token-dense active-search browser check,
not only parser timing. Include a 54,000-code-unit fixture containing 6,000
repetitions of `let x=1;` followed by a newline, with tokens and intervening
whitespace in separate text nodes. Also test many individually eligible blocks
whose combined source exceeds the former 500,000-code-unit cutoff, and a block
near the provisional per-block safeguard. Measure preparation, preview commit,
search application, and clearing separately at desktop/mobile widths through the
approved demo connection, with both cold and cached grammars. Record timings and
confirm input is serviced between queued units and typing and next/previous
remain responsive after publication. Optimize the local helper and adjust the
per-block safeguard if measurements justify it. If aggregate DOM/search costs
still block input, document the failing case and resolve the scope decision before
merging; a yielding parse queue alone does not solve that problem. Use
deterministic traversal-count and queue-yield regressions rather than flaky
wall-clock assertions in unit tests.

### Future Editor Or Highlighting Engine Changes

Treat editor replacement and highlighting-engine replacement as separate choices:

- Replacing the editor may retain CodeMirror language packages for static
  highlighting. Replace the native editor integration, map the new editor's token
  output to application categories where feasible, and retain the static service,
  Markdown adapter, CSS, preparation queue, safeguards, and preview/search lifecycle.
- Replacing the static highlighting engine changes the service implementation:
  resolve the same application language IDs, return the same range/outcome
  contract, and keep the Markdown renderer and viewer unchanged. Preserve IDs and
  compatibility aliases where supported; report unsupported languages explicitly
  rather than silently selecting a different grammar.
- Removing CodeMirror entirely requires both changes and a dependency-consumer
  audit. Editor commands, autocomplete, tables, and other native integrations still
  need migration; the highlighting boundary does not abstract those features.

Equivalent colors across all four current surfaces are required because they use
the same parsers and tag mapping. A future engine may classify syntax differently
or expose less detail; assess those differences explicitly rather than promising
automatic exact parity. Do not force native editor parsing through the static
range API: editors need their own incremental parsing and language extensions.

Editor-independent use still loads some CodeMirror infrastructure through its
language packages. The boundary limits application coupling, not transitive bundle
dependencies. Preserve lazy loading, inspect the production bundle for accidental
eager grammar imports, and do not claim a dependency-free standalone parser layer.

## Scope And Non-Goals

- Keep existing viewer/editor components, routes, editing, saving, and recovery.
- Do not change Markdown serialization, source content, or file-type eligibility.
- Do not add language autodetection, a user-selectable theme system, or a worker
  framework as part of this change.
- Do not add viewport-driven highlighting, incremental per-block publication, or
  document virtualization. Use a yielding preparation queue without a cumulative
  document cutoff; this is not a guarantee of unlimited document-size support.
- Do not rewrite text viewer/editor search or replace static Markdown with editors.
  The static viewer's whitespace indexing and ordered-segment mapping fixes are
  explicitly in scope.
- Do not replace the editor or highlighting engine in this work. Add only the
  small highlighting boundary described above, not a generic editor abstraction
  or a second implementation for hypothetical future providers.
- Do not expose engine types through shared application APIs or move existing
  editor-specific behavior into the engine-neutral highlighting service.
- Extend the existing theme system and theme editor only; do not add independent
  syntax preferences, palette storage, per-language themes, or a new preview UI.
- Verify whether related user/developer documentation needs updates when the
  implementation and compatibility behavior are finalized.
- Remove Highlight.js dependencies only after checking for other consumers and
  following the repository's dependency-update workflow. No new parser dependency
  is expected; verify direct dependency declarations for imported Lezer APIs.

## Implementation Sequence

Status key: **Implemented** means the code exists with recorded focused checks,
not that every acceptance scenario passed. **Partial** identifies remaining
verification; **Blocked** identifies a failing gate. These statuses summarize
the recorded implementation run, not a new test run of subsequent code edits.

1. **Implemented; verification partial.** Define the application language/range/outcome contract, token categories, and
  independent category-to-class/CSS mapping. Add the concrete CodeMirror backend
  with internal language lookup and a shared tag/category mapping. Add focused
  tests for names, aliases, filenames, dialect configuration, token rules, and
  public API isolation. Keep native editor exports separate from neutral exports.
2. **Implemented; browser verification partial.** Add the shared syntax roles to theme types/schema, built-ins, resolution,
  import/export, typed MUI exposure, and existing theme-editor controls. Update
  backend theme validation for additive legacy compatibility. Validate old stored
  themes/imports, full-role round trips, and strict rejection of invalid groups
  before integrating consumers. Install shared CSS/variables through presentation.
3. **Implemented; cross-surface browser verification partial.** Integrate the native CodeMirror bridge into the text viewer/editor and Markdown
  editor. Add scoped Markdown source highlighting and test actual Markdown syntax
  trees, nested code, and light/dark styles without changing source layout or
  content. Reuse the internal token mapping, not a second set of style rules.
4. **Implemented; focused checks passed.** Repair code-block whitespace indexing and replace the all-segments-per-match
  scan with an ordered walk. Validate cross-token matches, bounded traversal
  counts, and unchanged prose-search behavior with focused DOM-search regressions.
5. **Implemented; performance gate blocked; publication design superseded by addendum.** Complete yielding static preparation behind the service contract, add the
  engine-neutral Markdown range adapter and safe plain-text fallbacks, and wire
  the viewer-owned revision/commit/search contract. Test range integrity, stale
  work, selection deferral, and pending query changes before dependency cleanup.
  Settle depth-guarded nested Markdown grammars explicitly and test cold/warm
  parity. Validate task yields, prompt cancellation, shared-load reuse, and
  eligibility independent of cumulative document length.
6. **Partial; performance gate blocked.** Validate parity, theme-editor workflows, and browser behavior; update applicable
  user/admin theme documentation and developer theme/highlighting documentation;
  remove unused Highlight.js integration and dependencies where appropriate.
  Check public exports/import boundaries and production lazy-loading behavior.
  Record token-dense and many-block active-search browser timings before
  finalizing the provisional per-block safeguard. Resolve any aggregate
  DOM/search performance blocker without silently reinstating a document cutoff.

Validate each implementation slice before moving to the next one. Tests may use
small prepared-data fixtures to prove renderer independence; do not build an
alternative production backend merely to demonstrate replaceability.

Remaining original work is not waived by the addendum: finish the alias/dialect
audit, nested loading/parsing and late-rejection cases, actual nested native
Markdown parity, isolated cold/cached runs, and the full theme/browser matrix.
Docs, dependency removal, and lazy-chunk inspection have recorded passing checks;
the final per-block safeguard and overall acceptance remain unapproved.

## Acceptance Checks

Statuses below refer to recorded evidence. **Focused checks passed** does not
claim an exhaustive browser or type-export audit. **Partial** and **Blocked**
items must be closed explicitly; checks superseded by the addendum must be
replaced with its model/revision and bounded-rendering checks, not omitted.

- **Focused checks passed.** Public highlighting types and their transitive exports contain no CodeMirror
  or Lezer types. Static Markdown rendering imports only application data and
  presentation helpers, never engine packages or the native editor bridge. Use
  a focused import/type-boundary check following existing tooling conventions.
- **Focused checks passed.** Test the static Markdown adapter using hand-authored prepared ranges without
  loading a grammar or mounting an editor. The same viewer commit/search tests
  operate on prepared application data, not parser objects.
- **Focused checks passed.** Test ordered, non-overlapping, in-bounds UTF-16 ranges, category combinations,
  neutral gaps, empty output, repeated block association, and supplementary
  Unicode characters. Reconstruct text exactly from highlighted and neutral
  slices; require no engine-generated class names in prepared results.
- **Partial: native/static samples passed; full four-surface matrix pending.** Representative JavaScript/TypeScript, Python, SQL, shell, and legacy-mode
  examples receive equivalent token classes across all four surfaces. Compare
  actual emitted token ranges/classes, including tag precedence, and verify the
  same resolved grammar/dialect configuration in native and static paths.
- **Partial: nested guards/parity covered; isolated cold-load and failure matrix pending.** Markdown-labelled static blocks containing known fenced languages produce
  identical ranges in isolated cold-load and preloaded-editor cases. Cover nested
  Markdown, unknown/plain-text nested fences, nested loading/parsing failures,
  and the independent depth and block-size guards. Discovery and final parses do
  not consume a cumulative quota. Assert no grammar load or parse begins for work
  rejected by a guard, no skipping-parser result is published as success, and
  unrelated blocks still highlight.
- **Partial: focused source/scope checks passed; complete native nested-tree and geometry matrix pending.** Markdown source highlighting covers headings/markers, emphasis/strong,
  strikethrough, lists, blockquotes, links/images, inline code, thematic breaks,
  and fence delimiters/labels in both Markdown and text editor paths. Assert
  actual emitted classes, neutral paragraph text, unchanged line geometry, and
  isolation between Markdown styles and nested code styles.
- **Partial: resolution/fallback cases covered; complete alias and parsing-failure audit pending.** Filename resolution, fence aliases, unknown/unlabelled/plain-text blocks,
  language loading failure, parsing failure, and stale async completion are tested.
  Assert explicit fallback outcomes, independent block failure handling, and
  contextual failure logging without document text. Shared grammar loading must
  remain usable when one viewer discards a stale result.
- **Partial: light preview colors observed; full light/dark interaction matrix pending.** Light/dark colors remain readable; rendered Markdown prose and inline code do
  not change unexpectedly; syntax colors do not obscure search or selection.
  Opening Markdown preview without ever mounting an editor still loads token CSS;
  switching theme updates colors without reparsing or replacing code DOM.
- **Partial: schema/palette tests passed; custom computed colors across all surfaces pending.** Every built-in theme supplies all eight syntax roles. The schema, `COLOR_ROLES`,
  theme-editor group, frontend validation, and backend validation agree on role
  names. Custom role values, including alpha colors, reach the same computed
  token colors across all four surfaces; neutral identifiers inherit the existing
  code foreground. Markdown source roles follow the documented shared mapping.
- **Focused frontend/backend checks passed.** Legacy stored personal/site themes and version-1 imports lacking only the
  syntax group resolve mode defaults without mutation or automatic persistence.
  Complete syntax groups round-trip through save/copy/export/import and API
  reload. Partial/invalid/unknown syntax roles are rejected in frontend and backend;
  existing missing-role validation remains strict. Cover resolver idempotence.
- **Partial: dialog unit checks passed; desktop/mobile picker checks pending.** Theme-editor tests cover the Syntax group's controls, validation/focus,
  permissions, cancel, save, and copy through the existing dialog workflow.
  Browser-check the color picker and field layouts at desktop/mobile widths.
  Unsaved changes do not alter the active application theme.
- **Partial: variable-based implementation present; full identity/selection/scoped-theme browser checks pending.** Active theme switches and saved palette edits update token colors without new
  parse calls, changed preview revisions/token-node identity, or editor remounts.
  Preserve selection, active search matches, and scroll; verify independently
  scoped theme variables do not leak. Check custom palettes against actual light
  and dark code backgrounds, including translucent colors and search overlays.
- **Partial: text-preservation and selection-deferral tests passed; browser copy/selection matrix pending.** Code text and whitespace survive highlighting unchanged; copying includes no
  added text; native selection still works.
- **Partial: functional checks passed; navigation performance remediation pending.** Viewer search finds text within and across tokens, remains correct after grammar
  loading, and retains usable next/previous navigation.
- **Focused checks passed.** Search for `const x`, multi-space sequences, tabs, and line-spanning code text
  succeeds when whitespace lies in separate text nodes between token spans. Keep
  prose-search regressions for indentation and boundaries between blocks.
- **Blocked: deterministic traversal passed; browser responsiveness failed.** Token-dense search tests assert ordered traversal proportional to matches,
  segments, and emitted slices, including multi-node matches and clearing/reapply.
  Browser-check the 54,000-code-unit/6,000-match fixture, a block near the size
  safeguard, and many eligible blocks totalling more than 500,000 code units with
  search already active during grammar completion. Record preparation, commit,
  search, and clearing timings at desktop/mobile widths with cold/cached grammars;
  confirm task yields service input and post-commit typing and next/previous
  navigation remain responsive before accepting the per-block safeguard.
- **Partial: prepared-data race/selection checks passed; whole-subtree replacement superseded by addendum.** With search already active, grammar completion safely replaces the preview and
  recomputes matches exactly once for the committed revision using the latest
  query. Cover rapid document/query changes, closing/unmounting, entering edit
  mode, repeated search clearing, active-match preservation, scroll stability,
  and highlighting deferred until a native selection collapses.
- **Partial: guard/eligibility checks passed; safeguard measurement acceptance blocked.** Oversized blocks use plain text without loading their grammars solely for
  those blocks or parsing them. Test the per-block boundary at, below, and above
  the safeguard. Many individually eligible blocks totalling more than 500,000
  code units all highlight, including the last block; earlier oversized or failed
  blocks do not make later blocks ineligible. Depth limits remain independent.
- **Partial: controlled yield/cancellation checks passed; full real-input and late-failure matrix pending.** The preparation queue yields browser tasks between blocks and nested work
  units even with cached grammars, while publishing exactly one prepared result
  per completed content generation. Test the timer fallback as well as native
  yielding. Aborting during a yield or grammar wait promptly rejects the request
  without publishing, starting later parses, logging expected cancellation, or
  cancelling shared loads. A new request can reuse those loads successfully;
  late shared-load failures are handled. Test scheduling with controlled promises
  and timers, and verify real input servicing in the browser.
- **Recorded checks passed.** Production build retains lazy grammar loading and introduces no accidental
  eager import of all parsers. Declare directly imported Lezer packages as direct
  dependencies through the repository dependency-update workflow; do not rely on
  transitive installation or private package paths.
- **Partial: automated gates passed; browser acceptance incomplete and performance blocked.** Run relevant editor, viewer, DOM-search, and theme tests, frontend lint/build,
  backend theme API tests, and desktop/mobile browser checks through the approved
  demo connection.

## Implementation Verification Record

Measured on 2026-10-20 through `http://localhost:3000/browse/smb/demo` in the
development browser. Browser-only response interception supplied fixtures; no
stored demo file was changed. These are development-build observations, not
production performance guarantees.

The real viewer test opened search before releasing grammar preparation. Its
54,000 displayed code units contain 6,000 repetitions of `let x=1;` and a newline.
The Markdown AST excludes the final fence-adjacent newline from its code value;
the rendered code preserves all 54,000 units. Publication produced 30,000 token
spans and retained all 6,000 logical matches.

| Real Viewer Measurement | Desktop, 1543 px | Mobile, 390 px |
| --- | --- | --- |
| Preparation | 56.6 ms | 54.6 ms |
| Settled preparation to published preview/search | 1843.5 ms | 1916.2 ms |
| Search application/publication tail | 74.5 ms | 75.4 ms |
| High-priority task delayed during publication | 538.7 ms | 517.9 ms |

A separate synchronous renderer stress check measured the stages independently:

| Desktop Fixture | Preparation | Render/Commit | Search | Clearing |
| --- | --- | --- | --- | --- |
| 54,000 displayed units, cached grammar | 85.6 ms | 849.2 ms | 87.0 ms | 24.2 ms |
| Near safeguard, 99,999 displayed units | 91.6 ms | 1583.1 ms | 145.8 ms | 43.1 ms |
| 600 blocks, 546,600 AST code units total | 48.4 ms | 307.6 ms | 133.1 ms | 1.2 ms |

All 600 individually eligible blocks highlighted. This confirms eligibility
without an aggregate cutoff, not acceptable responsiveness for every document.
The initial dense synchronous sample took 78.5 ms preparation, 817.3 ms
render/commit, 80.7 ms search, and 15.7 ms clearing. A fully isolated network-cold
versus cached grammar matrix and the remaining theme/browser acceptance matrix
are not complete.

The browser gate **fails**: yielding grammar preparation does not prevent final
token DOM and active-search publication from blocking input. No aggregate cutoff
was restored, and the 100,000-unit safeguard was not lowered to hide the failing
54,000-unit required fixture. At measurement time, workers, incremental publication,
and virtualization were outside the agreed scope. The user subsequently approved
option 3 on 2026-10-20, as specified in the addendum. That approval resolves scope,
not the failed gate; implementation and new acceptance evidence are still required
before treating this work as complete or mergeable. The mobile column represents
a narrow viewport on the development host, not a physical-mobile CPU benchmark.

Functional verification includes real native/static token-class parity for
JavaScript, TypeScript, Python, SQL, and legacy shell; Markdown source scope and
nested-fence guards; deterministic queue yields and shared-load cancellation;
prepared-data-only rendering and import-boundary checks; code whitespace and
bounded segment traversal; preview selection deferral and stale results; active
match/scroll retention; and frontend/backend legacy syntax-palette compatibility.
The complete frontend suite passed: 160 files, 2,298 tests. Frontend lint and
production build passed, with grammar chunks still lazy and the build's warning
about chunks above 500 kB remaining. All 18 backend settings/theme tests passed,
as did backend lint, formatting, and mypy across 108 source files. Published
user/developer documentation was updated and docs content validation passed.

## Effort And Risk

| Work | Estimate |
| --- | --- |
| Application boundary, backend, code/Markdown styles, editor integration | 1-1.5 days |
| Existing theme/editor integration and legacy-definition compatibility | 0.5-1 day |
| Static adapter, whitespace fix, loading/search/selection integration | 1-1.5 days |
| Tests, browser checks, documentation, dependency cleanup | 1 day |
| Total | 3.5-5 engineering days |

The table above is the original estimate, not remaining effort or an estimate for
the approved performance expansion. Original parser/theme implementation risk is
low-to-moderate; overall delivery risk is now high until the performance prototype
passes. See the addendum for additional effort and risks. Reusing parsers through public
CodeMirror/Lezer APIs is low risk; copying grammars or relying on private internals
is not part of this design. The application-owned boundary limits the work needed
for a future change but does not eliminate the current dependency.

| Maintenance Area | Risk And Mitigation |
| --- | --- |
| Public parser/loading APIs | Low; keep usage inside the backend and use supported exports. |
| Grammar/tag updates | Low-to-moderate; representative token-output and parity tests catch classification and precedence changes. |
| Language names, aliases, and dialects | Moderate initially; preserve explicit compatibility mappings and test resolution/configuration. |
| Markdown and embedded/legacy languages | Moderate; explicitly settle depth-guarded nested grammars and test cold/warm parity, actual nested trees, and scope isolation. |
| Preparation scheduling and large documents | Moderate; yield between work units, abort obsolete requests, retain a measured per-block safeguard, and test many-block documents without a cumulative cutoff. Final DOM/search costs remain a separate risk. |
| Preview/search/selection lifecycle | Moderate and the main application maintenance burden; keep ownership independent of parsing, use ordered search mapping, and gate integration on token-dense and many-block browser checks. |
| Bundle dependencies and loading | Low-to-moderate; inspect production output and avoid eager grammar imports. |
| Theme definitions and theme editor | Moderate initially; preserve legacy absence defaults, strict supplied-role validation, and existing persistence workflows. |
| Future editor migration | Contained, not free; native editing integrations remain editor-specific and another engine may classify tokens differently. |

For CodeMirror/Lezer upgrades, run focused resolution, actual token-output,
Markdown-scope, and renderer contract tests alongside existing viewer/editor
checks. Review changed token output rather than blindly updating expected values.
Recheck queue yields, cancellation, and preview/search browser behavior when
loading, scheduling, or commit behavior changes.

The estimate includes the small application contract, shared theme roles and
legacy compatibility, whitespace repair, ordered search mapping, bounded nested
grammar preparation, a yielding queue with cancellation, explicit preview/search
lifecycle work, and boundary tests. It excludes an editor migration, workers,
virtualization, a second highlighting engine, or a generic provider framework.
Large-document DOM/search remediation beyond the local helper optimization is
not included; reassess scope and effort if browser checks expose that need.
Allow another day
if selection, DOM ownership, or scope-isolation checks expose additional
integration problems. Estimates assume no change to Markdown content or editing
architecture.

## Addendum: Responsive Editing And Virtualized Preview

### Decision And Scope

Approved on 2026-10-20: implement option 3, a model-backed virtualized Markdown
preview, retaining CodeMirror for source editing. Editing, scrolling, document
switching, and search navigation take priority over highlighting, counting, and
recovery snapshot preparation. P1 implementation has started with an isolated
code-only prototype; no additional work item below is complete, and the live
viewer/editor paths have not been migrated.

This addendum supersedes the original bans on virtualization, viewport-driven
presentation, and workers for this performance work. It also supersedes the
whole-document keyed preview replacement and synchronous layout-effect search
rebuild. A coherent result generation remains required, but it must not require
mounting all token DOM in one commit. Off-screen content remains eligible for
highlighting and searchable; not mounting it is not a cumulative content cutoff.

Keep the existing application-owned highlighting contract, language resolution,
token mapping, theme compatibility, routes, saving, recovery, and source fidelity.
Do not embed a CodeMirror instance in each rendered code block, replace the editor,
or introduce a generic worker/provider framework. Public neutral data contracts
must remain free of engine objects and DOM nodes. The worker transport is an
internal execution detail, not a second highlighting engine or parser registry.

### Evidence And Design Basis

The recorded dense fixture demonstrates a final DOM/publication failure, not just
slow parsing. A worker alone cannot fix it. Three further costs are verified in
the current code, but their individual latency contributions are not yet measured:

- `SourceTextEditor.tsx` calls `viewUpdate.state.doc.toString()` on each document
  change, feeding full strings into parent/editor normalization and state paths.
- `codeMirrorFindReplace.ts` enumerates the search cursor to compute exact count
  and active ordinal whenever its metrics are requested.
- `domTextSearch.ts` loops through every match to activate the current one, even
  when next/previous changes only the old and new active match.

Established implementations support separating the complete model from its view:

- [CodeMirror's viewport architecture](https://codemirror.net/docs/guide/#viewport)
  renders visible content plus a margin and tracks heights outside the viewport.
  Its [huge-document example](https://codemirror.net/examples/million/) explicitly
  budgets parsing work and allows highlighting to catch up.
- [PDF.js's rendering guidance](https://github.com/mozilla/pdf.js/wiki/Frequently-Asked-Questions#i-want-to-render-all-100-pages-in-a-document-at-a-high-resolution-is-it-a-good-idea)
  recommends rendering only visible pages. This is a bounded-rendering precedent,
  not a claim that PDF page virtualization directly solves Markdown layout.
- [Monaco's worker architecture](https://github.com/microsoft/monaco-editor/blob/main/README.md#faq)
  moves heavy language computation off the UI thread. It does not move DOM work
  there; its documented lack of mobile support also argues against replacing the
  current editor merely to obtain workers.

These are architectural precedents, not performance guarantees for this app.
Production measurements and the interaction prototype must validate our design.

### Additional Work Items

| ID | Work | Current Status | Additional Effort |
| --- | --- | --- | --- |
| P1 | Production baseline, supported envelope, virtualizer evaluation, interaction prototype | Partial: code and whole-Markdown/search prototypes measured; interaction gate open | 2 days |
| P2 | Transaction-based editor updates and explicit snapshot/flush boundaries | Not started | 2-3 days |
| P3 | Model-backed search, asynchronous metrics, bounded active-match updates | Not started | 2-3 days |
| P4 | Virtualized preview, large-unit subdivision, navigation and selection integration | Not started | 4-7 days |
| P5 | Worker preparation/search execution, cancellation, bounded result delivery | Not started | 2-4 days |
| P6 | Regression coverage, production/device acceptance, remaining original checks and docs | Not started | 3-6 days |
| Total | One experienced engineer; prototype included, not extra | P1 started; rollout blocked | 15-25 engineering days |

Estimates are preliminary, additional to work already performed, and include
testing and documentation. P1 is a go/no-go gate, not a promise to complete every
selection/accessibility requirement in two days. Re-estimate after it; unresolved
interaction or large-structure behavior blocks rollout rather than silently
reducing functionality or weakening the performance requirement.

### P1: Baseline And Prototype Gate

Measure production-build editing, initial opening, highlighted publication,
scrolling, search typing/counting, next/previous, and switching documents through
the approved demo connection. Separate preparation, serialization, normalization,
result transfer, render/commit, layout, search, and clearing costs. Retain the
existing dense, near-safeguard, and many-block fixtures, and add long lines, large
paragraphs/tables, nested Markdown, and rapid edit/search/navigation cases.

Select an established virtualizer using measured variable-height and scrolling
behavior; follow the dependency workflow before changing dependencies. Prototype
wrapped code, changing viewport widths, image/font height changes, scroll anchoring,
search jumps into unmounted content, and selection across virtualization boundaries.
Agree and record reference devices, browser versions, maximum tested source and
structure sizes, and memory expectations. No arbitrary-size responsiveness claim.

The gate requires a credible design for native selection, cross-block copying,
Select All, keyboard focus, screen-reader reading, hash links, browser find, and
printing. Off-screen DOM removal changes these behaviors. Do not silently replace
browser find or restrict selection to mounted content. Any unavoidable behavior
change requires explicit approval before implementation proceeds beyond the gate.

P1 must also establish a feasible shutdown/recovery contract for P2 and regex
execution containment for P3, including navigation, decorations, and replacement.
Record completion/progress budgets and maximum recovery checkpoint lag alongside
the interaction budgets in P6. These are gate outputs, not details to defer until
rollout testing.

### P2: Keep Whole-Document Work Out Of Keystrokes

Keep the CodeMirror document and transactions authoritative during editing.
Change the existing editor/caller boundary to consume changes or document
revisions without materializing the whole string on each keystroke. Update all
affected callers; merely debouncing a callback after `toString()` is insufficient.
Retain existing incremental editor parsing and viewport rendering.

Create immutable, revision-associated snapshots at deliberate save, recovery,
preview-transition, and other serialization boundaries. Coalesce background
snapshots; measure and bound their main-thread work too. Incremental processing or
worker transfer must not recreate full-document copying on every transaction.
Avoid full-document Markdown/table normalization in the immediate edit path;
preserve unchanged-source and canonical serialization behavior at flush boundaries.

Bind each queued snapshot and recovery write to its captured user identity and
authentication epoch, connection/path, editor type, editor-session generation,
document revision, and draft-clear generation. Derive its storage destination
from that captured identity, never from whichever account or editor is current
when asynchronous work completes. Validate write authority at persistence commit;
account changes, superseded editor sessions, and draft clearing invalidate stale
writes, including writes already in flight. A revision number alone is not unique
across accounts or reopened editor sessions. Preserve the awaited transition
flush below while its captured session still has write authority.

Separate flushing pending editor changes, serializing a revision, saving the file,
and persisting recovery data. Save, download/share of drafts where applicable,
preview transitions, and recovery must consume the latest edits, including IME
and nested table edits, rather than a stale debounced snapshot. A recovery
checkpoint does not mark the file saved; clear dirty state only for the revision
acknowledged by a successful file save or an explicit discard. Handle
snapshot/worker failures without losing the live document.

Distinguish awaitable application transitions from non-awaitable page lifecycle
events, and define controlled transitions by intent. When preserving unsaved edits
across navigation or reauthentication, await latest-revision recovery persistence
before destroying the editor or redirecting, subject to the explicit failure
policy below. Clean exits and successfully saved revisions do not require a
redundant recovery write. Honor explicit discard and existing recovery-clearing
semantics without creating a new checkpoint for discarded edits. Clearing a draft
must invalidate queued writes so a late snapshot cannot recreate it.

Define outcomes for missing user identity, the existing 2 MiB draft limit,
unavailable storage, and flush timeout/failure. Preserve the live document while
the user chooses retry, cancellation, or an explicit informed proceed-without-
recovery option where applicable. Do not silently lose edits or indefinitely
trap navigation or reauthentication behind an impossible recovery write. Record
any policy change at P1; successful file saves and explicit discards must remain
usable when recovery storage is unavailable.

Do not rely on promises, workers, or timers completing after `pagehide`, tab
freeze, or page termination. Specify how revisioned checkpoints and, if needed,
bounded pending changes preserve recoverable edits within the agreed checkpoint
lag, including the last changes before suspension. Define any unavoidable
loss window and recovery-storage limits explicitly; changing existing recovery
guarantees requires approval at P1. Verify that persistence acknowledgement
means the revision is stored, not merely queued, and that late snapshot completion
cannot overwrite a newer checkpoint.

### P3: Search Positions Independent Of DOM

Index rendered searchable text into a model with explicit mappings to document
blocks and text offsets. Preserve current rendered-prose boundaries, case/query
semantics, exact code whitespace, and matches crossing token or block fragments.
Do not search raw Markdown as a substitute: markup, destinations, and rendered
text differ. Keep source-editor search semantics in its existing owner.

For CodeMirror, decouple immediate find navigation from exact match counting and
ordinal calculation. Cache metrics by document revision and complete query/options
identity; compute or update them incrementally or in cancellable background work.
Selection-only changes must not force a full recount. Do not replace the existing
scan with another synchronous full scan on each edit. Pending counts must not be
presented as exact or block next/previous; settled counts remain exact. Preserve
regex, whole-word, case, replace-one/all, undo, and zero-length-match behavior.
Prevent pathological regex computation from monopolizing the UI thread.

Bound source-editor active-range lookup and passive decoration updates separately
from count/ordinal computation. `buildCodeMirrorSearchHighlights.ts` currently
enumerates all matches in `resolveCurrentSearchRange()` on selection and viewport
changes, even for literal queries. Replace that independent full-document walk
with indexed or bounded lookup; build visible decorations only for the viewport
and necessary active range. Selection-only and viewport-only updates must not
traverse the complete document or match set, even while exact metrics are pending.
Apply this requirement to both text and Markdown editor paths.

Contain regex execution across every source-search path: counting, next/previous,
visible-match decorations, replace-one, and replace-all. Moving only metrics to
a worker leaves synchronous native search commands exposed. A single regex
execution can block before a yield or cancellation check; P1 must demonstrate a
bounded execution or tested worker termination/restart strategy for these paths.
Navigation must remain independent of exact counts while reporting pending work
honestly. Define timeout/cancellation feedback and preserve document/query revision
checks, replacement expansion, and replace-all undo semantics; cancelled or stale
replacement computation must not apply partial edits.

For the preview, store logical matches independently of mounted nodes. Decorate
visible matches only; next/previous updates only the old/new active decorations,
not every result. Maintain an index for locating a match without scanning all
results. Mount and measure an off-screen destination, then scroll/focus it without
waiting for highlighting or a document-wide recount. Discard stale query/revision
results and release decorations when their mounted fragment is disposed.

### P4: Bound Rendering Within Large Structures

Maintain a document model with stable block/fragment identities, rendered-text
mappings, source provenance where needed, and prepared application token ranges.
Parse Markdown once per required generation rather than reparsing the full source
through ReactMarkdown for each highlight or window update. Preserve existing GFM,
table-cell line breaks, link safety, whitespace, and copy behavior.

Following the retained-text direction approved on 2026-10-20, keep lightweight
plain-text fragments in the DOM for native browser interactions; restrict expensive
syntax/search presentation and layout to the viewport plus measured overscan.
Publish retained text in bounded tasks, report partial versus complete publication
honestly, and measure whole-document DOM/memory growth within the supported
envelope. Do not claim constant DOM size or restore full token-span publication.
Use measured heights and bounded caches; invalidation must account for
wrapping, width, images, fonts, and theme geometry. A Markdown-block virtualizer
alone is insufficient: subdivide oversized code blocks, tables, paragraphs, and
long-line rendering units without changing content or breaking semantic structure.
The prototype must establish the subdivision strategy, including horizontal work
for exceptionally long lines, rather than assuming fixed-height lines everywhere.

Preserve logical selection, active match, focus, and scroll anchors across window
changes and asynchronous preparation. Never reconcile externally mutated search
nodes as React-owned token text. The viewer still owns content generations and
publication; the renderer/highlighting service must not own navigation or search.
Theme changes update local CSS variables without reparsing, resetting the model,
or rebuilding unchanged mounted token content.

### P5: Background Computation Without Unbounded Commits

Use a small dedicated worker execution boundary for expensive document preparation
and search where needed to meet the measured budgets. Reuse the current backend
and shared configuration; test lazy grammar loading and nested readiness in that
environment. Do not send live CodeMirror views, engine trees, or DOM through the
application contract. Native editor parsing remains CodeMirror-owned.

Tag requests/results with document generation, revision, and query identity where
applicable. Cancel obsolete work promptly, release old buffers/models, handle
worker startup/crashes and grammar errors, and prevent obsolete tasks from delaying
current interaction. A queued abort message cannot interrupt a running synchronous
worker parse; define bounded units or a tested terminate/restart strategy and its
grammar-load consequences. Do not claim AbortSignal alone preempts computation.

Bound result decoding, indexing, cache retention, and mounted publication as well
as worker CPU. Sending one huge result back can still block the UI. Use coherent
revisioned data and bounded delivery/application; do not require mounting the
whole document to acknowledge preparation completion. Unsupported worker execution
must produce an explicit safe fallback or supported-environment error, not silently
restore the known blocking path. Workers alone are not acceptance evidence.

### P6: Acceptance And Rollout

These are proposed engineering budgets to finalize in P1, not results already met:

- Input-to-visible-response p95 below 50 ms on the agreed reference devices for
  typing, cursor movement, and search navigation within the supported envelope.
- No application-controlled task blocking interaction above 50 ms in the agreed
  fixtures; target smaller rendering slices to leave room for browser work.
- Scrolling meets the reference refresh-rate frame budget, with recorded dropped
  frames, while preparation, counting, snapshotting, and result delivery run.
- Document switching and edit activation remain responsive while obsolete work is
  pending; full-document completion may be asynchronous, but stale content must
  not be presented as current or prevent navigation.
- P1 establishes measured limits for time to usable document content, settled exact
  search counts, and completed highlighting within the supported envelope. Define
  when each measurement starts, how superseded work is excluded, and progress or
  failure feedback when a limit cannot be met. Responsive input alone is not a pass.
- P1 establishes a maximum recovery checkpoint lag, measured from an edit to
  acknowledged recovery storage, and verifies the lifecycle policy in P2. Test
  sustained editing, scrolling, and searching as well as idle periods; background
  work must make bounded progress rather than depend on the user becoming idle.

Measure production builds with cold/cached grammars, desktop widths, and physical
mid-range mobile hardware. A narrow desktop viewport is a layout check, not a
mobile performance result. Run browser tests only through the approved demo
connection; record physical-device results separately when device access exists.
If a reference device is unavailable, mark that acceptance item unverified.

Add deterministic regressions for no per-keystroke full-document serialization,
no selection-only full match recount, and bounded source-editor active-range
lookup and decoration traversal on selection-only and viewport-only updates,
including literal queries with metrics pending. Verify bounded active-match
updates independent of total matches and mounted-node/work bounds as total
document size grows.
Test snapshot flush correctness, undo/redo, IME, nested table edits, replace-all,
late worker results/failures, cancellation, width changes, huge single structures,
copy/selection, accessibility, find, printing, anchors, and recovery.
Include immediate reauthentication after an edit, suspension with a pending
checkpoint, recovery-storage failure, out-of-order snapshot completion, and
pathological regexes during navigation, decoration, and replacement. Verify
completion/progress budgets under sustained interaction, not only input latency.
Cover clean exits, save-then-navigate, explicit discard, cleared-draft write
invalidation, and recovery failure outcomes for missing identity, oversized drafts,
unavailable storage, and timeout. Verify that recovery failure does not block a
successful file save or explicit discard, and that checkpoints never clear dirty
state for unsaved revisions.

Test account switching and sign-out/sign-in with pending snapshots, closing and
reopening the same document with reused revision numbers, and clearing then
recreating its draft while an older write is pending. Assert that stale work
cannot write under another account, overwrite a new editor session's checkpoint,
or recreate a cleared draft, including when persistence completes out of order.

Rerun the original contract, parser parity, theme compatibility, and remaining
browser checks. Replace obsolete whole-preview/DOM-mark assumptions with tests of
coherent model generations and bounded fragment publication. Retain the original
failing measurements as the baseline and record comparable production results;
do not treat a development-to-production build speedup as architectural proof.
Finalize the parsing safeguard based on worker/resource measurements separately
from rendering limits. No cumulative highlighting cutoff may hide a failed case.

Update applicable user/developer docs when behavior is implemented. Rollout remains
blocked until interaction preservation and the agreed budgets pass; this planning
update does not authorize marking the current implementation complete.

### P1 Prototype Verification Record (2026-10-20)

Implemented an isolated code-only prototype using the already installed TanStack
virtualizer. It is not imported by the live viewer. No dependencies, recovery
policies, search semantics, or end-user behavior were changed. The neutral
`markdownCodePreviewModel.ts` retains exact UTF-16 text/token offsets, divides
ordinary code into rows of at most 16 source lines and 2,048 code units, indexes
overlapping token ranges in one ordered pass, and locates fragments by binary
search. The row sizes are prototype configuration, not accepted resource limits.
Oversized individual lines are explicitly flagged, not truncated or claimed safe.

Run from the repository root:

```sh
SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
```

The harness bundles production React, the current highlighting service and shared
syntax styling, and the prototype with Vite. Playwright response interception at
`http://localhost:3000/browse/smb/demo` serves this isolated harness and its assets;
it does not open or change a stored demo file. With the environment flag, it
retains `report.json` and desktop/mobile screenshots in a reported temporary
directory. Without the flag, temporary assets are removed. Browser failures and
incorrect model counts/mounted bounds fail the command. A successful command
verifies those assertions, **not** the P1 interaction gate or latency budgets.

Chromium 156.0.8078.4, on the development host, at widths 1543 and 390 pixels:

| Code-only fixture | Source units | Model matches | Full-render spans | Initially virtualized spans / rows |
| --- | --- | --- | --- | --- |
| Dense, 6,000 repetitions | 54,000 | 6,000 | 42,000 | 560 / 5 |
| Near safeguard | 99,999 | 11,111 | 77,777 | 560 / 5 |
| 600 eligible blocks | 545,400 | 60,600 | 424,200 | 560 / 5 |

All model matches remained addressable. Last/first/middle match jumps and viewport
width changes passed mounted-destination assertions. Navigation uses indexed block
and row positions, not a full block/match scan. The harness tests a fresh page
with an uninitialized grammar and a subsequent cached-grammar load separately;
these are not independently verified network-cold or physical-mobile runs.

In the recorded run, initial virtual load-to-two-animation-frames ranged from
45.0-71.1 ms for the dense fixture, 62.1-71.2 ms near the safeguard, and
207.0-243.4 ms for many blocks. This includes preparation/indexing/publication and
is not an input-latency measurement. No >50 ms long tasks were observed during
these virtual loads in that run; full-render comparisons had 153-1,780 ms tasks.
A subsequent run recorded a 51 ms task during a fresh near-safeguard virtual
load: the interaction-task budget is not accepted, even for these code fixtures.
Results are from this code-only harness, not the original ReactMarkdown viewer:
they do not replace the failing original baseline or establish a safe safeguard.

**Interaction gate remains open.** Native Select All selected approximately
1,200 code units rather than the full model, demonstrating the expected
off-screen-DOM regression. No model-based copy/find workaround was silently
installed. Selection/copy across windows, native browser find, accessibility,
printing, hash links, focus, wrapped long lines, large prose/tables, image/font
height changes, live editing/switching, recovery shutdown, and regex termination
remain unresolved or unverified. Supported-envelope, reference-device, progress,
and recovery-lag budgets are not yet agreed. P2-P5 integration must not be treated
as authorized by a passed P1 gate. Continue the interaction prototype before
rolling virtualization into the live preview; no behavior changes are approved
by these measurements.

Focused verification: six deterministic model regressions (text fidelity,
Unicode/CRLF, crossing tokens, ordered traversal bounds, oversized-line reporting,
invalid ranges), plus adjacent neutral renderer/highlighting checks: 32 tests
passed. The model passed standalone strict TypeScript with indexed-access checks.
The normal production build passed with its existing >500 kB chunk warning.
A broader standalone strict check of the prototype reaches existing diagnostics
in unchanged app dependencies and is not claimed as a clean strict-app gate.

### P1 Retained-Text Interaction Candidate (2026-10-20)

The isolated prototype now also evaluates a **retained-text** mode. On 2026-10-20,
the user approved pursuing this recommended direction and relaxing P4's strict
viewport-only DOM requirement. This approves the architecture direction, not a
passed P1 gate or a live viewer implementation. It retains one ordinary text node per
fragment, uses `content-visibility: auto` and intrinsic-height estimates to defer
off-screen layout, and paints only nearby syntax/search ranges with the browser
CSS Highlight API. It reuses prepared application ranges and the existing syntax
presentation rules. No duplicate hidden document, clipboard override, browser-find
replacement, parser, or dependency was added. Unsupported CSS Highlight execution
fails the prototype explicitly; it does not mount all token spans as a fallback.

The default proof compares full rendering, true virtualization, and retained text.
For a focused candidate run:

```sh
SAMBEE_PREVIEW_PROOF_MODES=retained-text SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
```

The report records which modes ran. On Chromium 156 at widths 1543 and 390,
fresh-page and cached-grammar loads passed exact DOM-text and native Select All
comparisons against an unfragmented native `pre` baseline for all three original
code fixtures. Comparing with a browser baseline is intentional: Chromium omits
the last `pre` newline from `Selection.toString()`, even without fragmentation.
The model/DOM still retains that newline exactly.

Additional browser assertions passed for selection and text-node identity across
scrolling and syntax-variable changes; custom computed keyword color; off-screen
search jumps and hash navigation; wrapped Unicode/tab text; complete unclipped
print-media layout; off-screen-target presence in the Chromium accessibility
snapshot; and releasing old text and all owned highlight sets on replacement.
The print check is not a print-dialog/PDF-output test, the accessibility snapshot
is not assistive-technology testing, and no clipboard integration was claimed.

The native `window.find()` engine found and selected an off-screen unique target.
It did not scroll the target into view in either the candidate or a comparison
with containment disabled. The harness reports native browser-find reveal as
**unverified**, not passed; testing the browser's actual Find UI is still needed.

Retained text mounted 375, 695, and 4,200 plain-text fragments for the dense,
near-safeguard, and many-block fixtures respectively, with zero token spans.
Visible highlight work passed the existing 40-row/4,000-range probe bounds during
last/first/middle navigation. These are probe bounds, not accepted resource limits.
Unlike true virtualization, its text DOM and initial mounting work grow with the
whole document. One candidate run recorded a 366 ms many-block refresh task and
another a 52 ms near-safeguard task; later faster runs do not waive these failures.

**Approved direction; acceptance still required:** retain lightweight off-screen
text DOM rather than strict DOM virtualization. This supersedes P4's viewport-only
mounting requirement for text; expensive syntax/search presentation and layout
must remain viewport-bounded. Measure document-wide text mounting, memory, and
resource limits explicitly. CSS Highlights still require an explicit
browser-support/presentation assessment. This candidate has not passed
P1's full performance, large-structure, browser/device, interaction, memory, regex,
or recovery gates. Do not mark P1 complete or begin a live replacement on the
basis of these code-only checks. No native interaction changes, fallback to
blocking token DOM, or arbitrary-size responsiveness claims are approved.
User/developer product docs remain unchanged because no shipped behavior has
changed.

### P1 Batched Retained-Text Publication (2026-10-20)

Continued the approved retained-text prototype by replacing its single React
commit of all text fragments with append-only DOM batches, currently capped at
64 rows per browser task. React owns the empty surface, while the prototype owns
its text descendants and cleans them up on disposal. Existing text nodes are not
reconciled or replaced when later batches append. This is still code-only proof
tooling, not an integrated Markdown renderer or an accepted batch-size limit.

Intersection observation is registered as rows are appended. Completion resolves
only after all rows are published; report fields distinguish first content,
publication progress, batch count, and full completion. Superseding a load aborts
its preparation signal, rejects its pending publication with `AbortError`, and
prevents obsolete tasks from appending. Disposal cancels the scheduled publication
task, disconnects observation, and releases text/highlight references.

The focused retained-text proof passed twelve fixture loads (three fixtures,
fresh/cached grammars, both widths). The dense fixture used six publication
batches, the near-safeguard fixture eleven, and the 4,200-row many-block fixture
66, with no batch exceeding the configured cap. All text and matches remained
eligible. In the recorded run, many-block completion-to-two-animation-frames
including preparation took 571.6-597.6 ms; no >50 ms long task was observed during
these fixture loads. These measurements do not waive previous failures, establish
device budgets, or prove time bounds for unusually large individual fragments.

New browser assertions passed at both widths:

- Actual keyboard input was serviced before many-block publication completed.
- Native selection retained its text, anchor/focus nodes, and first text-node
  identity while additional publication tasks appended rows.
- Superseding a partially published document rejected the old load with
  `AbortError`, detached its text, and retained only the new document after frames.
- Immediate supersession during preparation aborted the old request; the next
  request reused the highlighting service and completed successfully.
- Publication batch/progress counts were checked independently of wall-clock
  performance, and `load()` returned only after every row was mounted.
- A search jump into unpublished text explicitly reported pending instead of
  claiming a visible active match, then scrolled and highlighted the destination
  when its publication batch arrived.

Existing exact native Select All, visible-only highlighting, search jumps,
theme-variable, hash, print-layout, accessibility snapshot, and cleanup assertions
remain in the harness. The 32 focused fragment/neutral-renderer/highlighting tests
passed. Modified proof tooling passed lint and reported no direct strict type
diagnostics; the broader standalone check still reaches 49 diagnostics in
unchanged transitive app dependencies.

At this stage, navigation into not-yet-published text had a tested pending/reveal
contract but still waited for document-order publication; the priority-publication
work below supersedes that limitation. No priority-navigation latency budget has
been established. The
first text is also still published after highlighting preparation, not independently
of it. Whole-Markdown semantics, browser-native
Find UI, physical-mobile/cross-browser performance, memory limits, huge structures,
worker/regex containment, recovery shutdown, and agreed completion/progress budgets
are not established by this slice. No live viewer/editor behavior was changed.

### P1 Priority Publication And Cross-Browser Probe (2026-10-20)

The retained-text prototype now gives the most recent search destination and up
to three neighboring fragments on either side priority within the next capped
publication task. It inserts fragments at their source-ordered positions rather
than appending them out of order or building the entire preceding DOM. Previously
published text nodes remain intact. Background publication skips existing rows;
all content still settles without a cumulative cutoff. Publication counters count
actual inserted rows, including priority work, and retain the 64-row task cap.

While publication continues, the prototype compensates for preceding insertions
when the active destination intersects the viewport, then restores native scroll
anchoring at completion. Rapid search jumps replace the pending priority window;
only the latest destination owns navigation. This is still isolated code-only
prototype work, not an integrated Markdown viewer.

Chromium retained-text checks passed at both widths for early destination reveal,
rapid-jump latest-target ownership, text-node/native-selection stability at the
destination while preceding content arrives, continued keyboard servicing,
supersession, final exact source order/text, and destination visibility after
completion. In a recorded probe, the destination was visible with 1,152 of 4,200
rows published; seven rows had been published with priority. This demonstrates
early reveal, not an accepted input-to-response p95 or physical-device budget.
The complete Chromium comparison passed all 36 fixture loads and interaction
assertions. The 32 focused model/neutral-renderer/highlighting tests also passed.
Proof tooling lint passed with no direct prototype strict type diagnostics;
49 diagnostics remain in unchanged transitive app files under the broader check.

The same harness can now select Firefox without changing fixtures or the approved
demo route:

```sh
SAMBEE_PREVIEW_PROOF_BROWSER=firefox SAMBEE_PREVIEW_PROOF_MODES=retained-text SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
```

**Historical cross-browser blocker (superseded for the tested fixtures by the
semantic-fragment work below):** Firefox 157.0 failed native Select All on the
first desktop dense fixture. The DOM preserves all 54,000 code units, but native
selection returns only 435, versus 54,000 from the unfragmented native `pre`
baseline. A diagnostic comparison with `content-visibility` disabled selects
54,374 units, demonstrating extra inter-fragment separators as well as the
contained off-screen selection problem. Disabling containment is therefore not
an accepted fix and would also require fresh layout/performance evidence.
The test fails with a nonzero exit; no clipboard override, selection replacement,
browser restriction, or unbounded token/layout fallback was installed.

With artifact retention enabled, failed proofs now save browser identity,
native-selection comparisons, and the assertion in `report.json`, as well as
retaining build assets. Browser long-task observation is explicitly reported as
unavailable when unsupported, rather than treating missing measurements as zero
tasks. The failed Firefox run is not claimed as a completed Firefox performance
matrix; native Find UI and the remaining browser/device checks remain open.

At this point P1 remained blocked on native interaction compatibility, whole-Markdown semantics,
large-structure and memory limits, first-content/completion budgets, worker/regex
containment, recovery policy, and reference-device verification. The first text
still waits for highlighting preparation. No live viewer/editor behavior or
product documentation changed; the approved retained-text direction is retained,
but this specific DOM/containment strategy is not accepted for rollout.

### P1 Semantic Fragment Compatibility (2026-10-20)

The retained-text prototype now creates one native `pre` per original code block,
with one inline-block plain-text `span` per fragment inside it. The outer block
preserves source semantics; the fragment wrappers no longer insert the native
selection separators caused by separate `pre` elements. It still paints syntax
and search with CSS Highlights rather than creating token spans, and retains
capped publication, indexed search positions, priority insertion, cancellation,
and selection-stable text nodes.

The prototype deliberately replaces `content-visibility: auto` with ordinary
`contain: layout style` on the fragments. This fixes Firefox's off-screen native
selection omission in the tested fixtures, but **does not preserve the previous
off-screen layout deferral or establish viewport-bounded layout work**. It is a
measured experimental layout change, not an approved performance fallback or live
renderer. P4's layout/resource requirements remain open; do not deploy merely
because native selection now passes.

The proof now targets stable fragment indices rather than assuming a fragment is
a `pre`. It counts plain fragment spans honestly and separately reports zero
token spans. An added fixture covers tabs, multiple spaces, CRLF, blank lines,
supplementary Unicode, multiple source blocks, and an unterminated final line.
Native Select All and exact DOM text are compared with unfragmented native blocks;
matching font size, line height, wrapping, and width additionally require equal
total layout height. This catches visual line/separator changes independently of
text preservation.

Recorded verification on the development host:

- Chromium 156 passed all 48 expanded fixture loads (four fixtures, three modes,
  fresh/cached grammars, two widths) and interaction assertions.
- Firefox 157 passed all 16 retained-text loads and interaction assertions at
  widths 1543 and 390. The earlier native-selection failure is fixed for these
  fixtures without a clipboard override or replacing native selection/find.
- Both retained-text runs cover exact native Select All and equal-height layout,
  pending/priority jumps, destination and first-node selection stability during
  publication, input servicing, supersession, theme-variable updates, hash
  navigation, print-media layout, accessibility snapshots, and cleanup.
- All 32 focused model/neutral-renderer/highlighting regressions passed. Tooling
  lint passed with no direct prototype strict type diagnostics; the broader
  standalone check still reaches 49 unchanged transitive app diagnostics.

Firefox still cannot report Long Tasks through this API. The harness now records
a separate portable timer-task servicing probe: maximum time between successive
probe callbacks during preparation/publication. This includes timer clamping,
scheduling priority, and browser/host delays; it is **not** a Long Task duration or
an input-to-paint measurement. A Firefox run recorded 326-363 ms maximum gaps for
many-block loads, with completion-to-two-animation-frames around 832-1,465 ms.
Near-safeguard gaps were 55-68 ms. These results leave performance acceptance open;
an unavailable Long Tasks metric must not be treated as zero blocking. Preparation
already yields using the current scheduler/timer helper, so the gap does not alone
identify a single uninterrupted parser or DOM task.

The old failure evidence remains above. Remaining work includes measuring and
bounding layout/initial content work, background preparation/regex containment,
whole-Markdown and huge-structure semantics, memory limits, real native Find UI,
physical-device/reference budgets, and recovery policy. Print layout is not a
PDF/print-dialog test, and an accessibility snapshot is not assistive-technology
verification. No live viewer/editor or product-documentation behavior changed.

### P1 Worker Preparation Comparison (2026-10-20)

The isolated code-only prototype adds an opt-in `retained-text-worker` mode.
It runs the existing highlighting service, neutral fragment indexing, and the
fixture's literal `let x` match indexing in a dedicated module worker. It does
not introduce another grammar registry or parser. The existing main-thread mode
remains available for a same-build comparison; neither mode is a live viewer.

Result messages contain at most 512 records in total across syntax ranges,
fragments, and matches. The worker waits for a main-thread acknowledgement before
sending the next chunk. The client reports chunk count, largest chunk, assembly
time, preparation wall time, and execution mode. Successful jobs reuse the worker
and its grammar cache. Cancellation terminates the obsolete worker rather than
queuing an abort behind a synchronous parse; the next job starts a fresh worker.
Startup, crash-event, and decode-event failures reject explicitly and terminate
failed workers where one exists. There is no automatic main-thread fallback.
A 30-second no-progress watchdog is a prototype diagnostic, not an agreed
acceptance budget or a verified recovery policy.

The proof build gives the parser's logging import a worker-specific diagnostic
bridge. Structured parser failures are forwarded to the existing main-thread
logger; the worker does not import browser authentication/tracing initialization
or receive fake `window`/`document` globals. This adapter currently belongs to the
isolated proof build and is not a production worker-integration contract.

Verification on the development host includes:

- Chromium 156: 32 same-build main-thread/worker fixture loads across four
  fixtures, fresh/cached grammars, and widths 1543 and 390, plus both modes'
  publication, native-selection, geometry, priority-jump, cancellation, theme,
  hash, print-media, accessibility-snapshot, and cleanup assertions.
- Firefox 157: 16 worker fixture loads and interaction assertions. The worker
  failure probes explicitly exercise unavailable workers, constructor failure,
  injected crash/decode events, observed termination, preserved previous text,
  and a successful subsequent worker load. These are injected event tests, not
  evidence of recovering from every operating-system or browser worker failure.
- All 32 existing focused model/neutral-renderer/highlighting tests pass. Focused
  tooling lint passes. The standalone strict check has no direct prototype/model
  diagnostics, but still reaches 49 existing transitive application diagnostics.

In the Chromium comparison, many-block timer-service gaps were approximately
187-217 ms on the main thread versus 14-19 ms with worker preparation. Completion
to two animation frames was slower with the worker: approximately 864-932 ms
versus 645-684 ms. No main-thread Long Task was observed in that run, including
the main-thread comparison; timer-service gaps are not Long Task durations or
input-to-paint measurements. Firefox still reports Long Tasks as unavailable.
Its worker run included cached many-block timer gaps of 160-169 ms and completion
around 1.7 seconds. This is evidence for continuing the worker investigation,
not performance acceptance or a claim that all stalls are parsing stalls.

At this checkpoint the source request was one whole-array structured clone;
the source-transfer work below replaces that request. Other limitations remain:
the 512-record cap is not a byte/memory bound, whole-document model and match
arrays are retained, and some combined metadata/text assembly still runs
on the main thread. First usable text still waits for all preparation and result
delivery. The literal fixture search is not general Markdown search or bounded
regex execution. Off-screen layout is still ordinary retained-text layout, not
viewport-bounded layout. Whole Markdown, huge structures, physical devices,
memory limits, actual native Find UI/assistive technology, watchdog behavior,
resource shutdown, and the recovery contract remain open. P1 is still incomplete;
P2-P6 have not started. No live viewer/editor or product documentation changed.

### P1 Bounded Source Transfer (2026-10-20)

Worker input now uses a metadata-only start message followed by source chunks
of at most 16,384 UTF-16 code units. The client sends the next chunk only after
the worker acknowledges the preceding sequence number. The worker validates
sequence, block order, size, and completion before accepting the run request.
It joins source parts before parsing, so transfer boundaries are not parser,
fragment, or search boundaries. Empty blocks receive explicit final chunks;
an empty document needs no source messages. Existing result delivery remains
capped at 512 records with one unacknowledged result chunk at a time.

The browser proof now asserts exact source-unit totals, expected source-message
counts, and the largest source payload. A prototype-only inspection hook compares
the complete neutral syntax ranges, fragment indexes, and match indexes against
main-thread preparation. The fixture deliberately splits a supplementary Unicode
surrogate pair, the literal search query, and CRLF across source messages; it also
covers empty blocks and an empty document. The cancellation probe observes an
actual source post before superseding the job, requires exactly one source chunk
at cancellation, and verifies termination, preserved previous text on failure,
and successful later worker preparation.

Chromium 156 and Firefox 157 each passed 16 worker fixture loads at widths 1543
and 390, plus boundary parity and the retained-text interaction/recovery probes.
All 32 focused unit tests passed; focused lint and direct diagnostics passed.
The strict check still reaches 49 existing transitive application diagnostics.
The existing production-build chunk-size warning is unchanged.

This removes the whole-document input-message bottleneck, not aggregate memory
or first-content limits. The worker still retains complete source blocks and
prepared data, reconstructs whole blocks, and begins preparation only after all
source has arrived. Chunk size is measured in UTF-16 units, not serialized bytes.
At this checkpoint first text still waited for preparation and result delivery;
the source-first experiment below addresses that dependency in a separate mode.
No lower document
cutoff, silent fallback, or live viewer/editor migration was introduced. In the
latest runs, Chromium many-block completion was approximately 907-940 ms;
Firefox cached runs still showed 160-166 ms timer gaps and completion around
1.75 seconds. Performance, layout, memory, general search/regex, recovery policy,
and whole-Markdown acceptance remain open. P1 remains incomplete and P2-P6 have
not started; shipped behavior and product documentation are unchanged.

### P1 Source-First Worker Publication (2026-10-20)

The opt-in `retained-text-worker-progressive` prototype publishes a plain-text
fragment model before awaiting worker preparation. It reuses the same bounded
row-publication path and worker transport as the earlier candidates. When syntax
ranges and literal matches arrive, it updates the fixture and schedules CSS
Highlight painting without rerendering or replacing the existing text nodes.
The worker-before-publication mode remains available as a comparison; the live
Markdown viewer/editor is unchanged.

Publication and preparation are now separate states. Metrics report
`preparationComplete`, `preparationError`, and `searchComplete` independently of
`publicationComplete`. Search jumps while preparation is pending reject with an
explicit pending-preparation error rather than treating the temporary empty
match array as exact results. A preparation failure rejects the load, retains
the explicitly requested plain source, and leaves preparation/search incomplete
with an error; it is not silently reported as successful highlighting. New loads
abort obsolete work, and stale completions cannot upgrade a newer generation.

The proof holds the worker's run message until explicitly released. It verifies
source publication across animation frames and real keyboard input while
preparation remains pending. Releasing the worker must preserve the selected
text node, anchor/focus, exact source, and complete match count while applying
syntax. Additional probes cover worker failure after source publication,
supersession of pending preparation, and an injected obsolete completion.
First publication is timed separately from initial source-model indexing and
worker preparation; the load promise still waits for preparation and complete
publication.

Verification on the development host:

- Chromium 156 passed 80 fixture loads across all five render modes, four
  fixtures, fresh/cached grammars, and widths 1543 and 390, plus the existing
  modes' lifecycle tests and the source-first interaction/failure probes.
- Firefox 157 passed 16 source-first fixture loads and the pending-preparation,
  input, selection, failure, supersession, native-selection, geometry, theme,
  hash, print-media, accessibility-snapshot, and cleanup assertions.
- All 32 focused unit tests passed. Focused lint and direct diagnostics passed;
  the standalone strict check still reaches 49 existing transitive application
  diagnostics. The existing production-build chunk-size warning is unchanged.

For the many-block fixture, Chromium's first DOM publication was approximately
3-9 ms in source-first mode versus 461-526 ms in worker-before-publication mode
in the same run. Initial source indexing was 1.3-1.7 ms. Source-first completion
to two animation frames was approximately 734-1,085 ms, with 17-26 ms timer gaps.
Firefox first publication was 3-39 ms, source indexing 1-2 ms, completion
840-901 ms, and timer gaps 10-39 ms. These are development-host observations,
not agreed budgets, physical-device measurements, input-to-paint latency, or
proof that every unpaused load paints before preparation completes. First DOM
publication is not a first-paint timestamp; the deterministic paused-worker test
establishes that source display and input no longer depend on parser completion.
Firefox Long Tasks remain unavailable, not zero.

At this checkpoint initial plain-model indexing still scanned the whole document
synchronously; the cooperative indexing work below addresses that scan. Remaining
limits are substantial: it constructs whole-document metadata/text, and
syntax upgrades retain complete prepared arrays. Ordinary off-screen layout,
DOM/memory growth, huge lines and structures, general search/regex execution,
native Find UI/assistive technology, reference-device budgets, resource shutdown,
and the production recovery policy remain open. This mode does not establish
viewport-bounded layout, an accepted fallback policy, or whole-Markdown support.
P1 remains incomplete; P2-P6 have not started. Product documentation and shipped
viewer/editor behavior are unchanged.

### P1 Cooperative Source Indexing (2026-10-20)

The fragment builder now shares one deterministic sequence of indexing steps
between its existing synchronous API and a cooperative asynchronous API. The
synchronous API drains those steps without scheduling; its output and public
signature remain unchanged. The asynchronous API accepts an injected task yield
and abort signal, checks cancellation before reading data and after each yield,
and rejects scheduling errors without returning partial models.

Indexing checkpoints limit newline-search windows to 16,384 UTF-16 code units
and checkpoint counted scan/range/fragment operations at 512. Oversized lines
are scanned across windows rather than using an uninterruptible whole-line
newline search; they are still preserved and flagged, not truncated or claimed
safe for DOM layout. Source-first mode uses the cooperative API and also yields
between batches of at most 16 small source blocks or 16,384 accumulated units.
This keeps many tiny or empty blocks from bypassing scheduling merely because
each individual model fits below a checkpoint. The existing scheduling helper
is reused; no new scheduler dependency or document cutoff was introduced.

The proof reports `sourceIndexingYields`. `sourceIndexingMs` now includes elapsed
time waiting at cooperative yields, not just indexing CPU time. A browser probe
supersedes a dense single-block load during initial indexing, requires its
`AbortError`, and observes that only the replacement generation submits a worker
job. This complements the existing worker-transfer and prepared-result
supersession checks.

All 37 focused tests pass, including five added model tests for exact parity,
single-oversized-line cancellation, pre-aborted and range-validation cancellation,
independent expected fragments/token indexes around scan-window boundaries, and
scheduling-failure propagation. Chromium 156 passed 80 loads across all five
render modes and existing interaction probes. Firefox 157 passed 16 source-first
loads plus pending/input/selection/failure/supersession checks. Focused lint and
direct diagnostics pass; 49 existing transitive strict type errors and the
existing build chunk-size warning remain.

For the many-block fixture both engines recorded 37 indexing yields. Chromium
indexing elapsed time was approximately 3-4 ms and first DOM publication 5-10 ms;
Firefox recorded 4-8 ms and 6-51 ms respectively. These are development-host
observations, not budgets or first-paint/input-to-paint measurements. Completion
still varied: a Chromium load reached approximately 1.87 seconds with a 212 ms
timer-service gap. Firefox completion was approximately 881-958 ms with 10-45 ms
timer gaps; Long Tasks remain unavailable there. Overall responsiveness is not
accepted merely because indexing can yield and abort.

The entire plain model is still assembled before first publication. Whole-model
metadata/text construction, result assembly, retained DOM/layout, aggregate
memory, huge structures, general search/regex, native Find UI/assistive technology,
reference devices, shutdown, and production recovery policy remain open. This is
not streaming source publication or a measured hard time bound on every UI task.
P1 remains incomplete and P2-P6 have not started. No live viewer/editor migration
or product-documentation change was made.

### P1 Streamed Whole-Markdown Prototype (2026-10-20)

The isolated prototype now accepts a complete Markdown document, not just an
array of code blocks. A dedicated worker uses the existing remark/GFM and
table-cell line-break transforms plus the directly declared `remark-rehype`
dependency. It streams source-ordered semantic element, attribute, and text
records, then prepares fenced/indented code through the shared highlighting
service. The plain semantic document can publish before syntax preparation
finishes. No live viewer/editor path imports this renderer.

Document messages contain at most 64 records; individual text and attribute
values contain at most 2,048 UTF-16 units. The client acknowledges only after
consuming a batch and yielding. Input retains the existing acknowledged
16,384-unit source chunks. These are transport/publication limits, not aggregate
memory or hard per-task time limits. The worker still constructs a complete
Markdown tree before emitting records.

The consumer creates native headings, lists, links, tables, checkboxes, images,
footnotes, and code blocks. Raw HTML is escaped as text, unsafe URLs use
ReactMarkdown's public URL transform, and structural table whitespace matches
the canonical renderer. Code keeps stable plain-text fragment nodes; visible
syntax uses CSS Highlights with an explicit 4,000-range decoration limit and a
reported limited state. No content or match count is silently truncated.

Repeated document loads now clear owned DOM and highlights; cancellation before
the React host mounts rejects rather than stranding its promise. Worker decode
failure preserves published partial text and reports failure without a
main-thread fallback. Explicit prototype shutdown aborts pending work, disconnects
observers, cancels painting, detaches text, and terminates the cached worker.
This tested mechanism does not establish a production recovery policy or prove
garbage collection and memory ceilings.

Run the whole-document proof on the approved demo connection with:

```sh
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_PREVIEW_PROOF_BROWSER=firefox SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
```

Chromium 156 and Firefox 157 each passed 18 fixture loads at widths 1543 and 390:
mixed Markdown, empty documents, unknown-language fallback, image sizing, Unicode
chunk boundaries, 6,000 code lines, large paragraphs, an 800-row table, and a
60,000-character code line. Assertions compare exact DOM text, native Select All,
semantic structure, and equal-height layout with canonical ReactMarkdown,
including after resizing. Interaction probes cover native footnotes, print-media
layout, accessibility snapshots, theme variables, keyboard input and stable
selection during publication, immediate/partial supersession, actual-worker
decode failure, retry, and shutdown. All 80 existing Chromium code-mode loads and
38 focused unit tests also pass. Touched-file lint and direct prototype/model
types pass; 49 existing transitive strict errors and the build chunk warning
remain.

In the recorded development-host runs, document completion through two animation
frames ranged from 20-131 ms in Chromium and 24-249 ms in Firefox. Maximum timer
service gaps were 27 ms and 10 ms respectively. Chromium observed no Long Tasks
in these fixture loads; Firefox cannot report that metric. Pipeline wall time
includes parse, publication acknowledgement/yield waits, and syntax preparation;
it is not parser CPU time. First-content statistics measure DOM publication,
not first paint. These are fixture observations, not accepted budgets.

At this checkpoint whole-Markdown application search was unsupported; the search
prototype below supersedes that limitation. Headless native
`window.find` selects the off-screen target in both renderers but does not reveal
it in either, so actual browser Find UI remains unverified. Accessibility
snapshots do not replace assistive-technology testing. Arbitrary-structure and
off-screen layout costs, aggregate memory, regex containment, reference devices,
completion/recovery policy, and production integration remain unresolved. P1 is
still incomplete, P2-P6 have not started, and rollout remains blocked. Product
documentation is unchanged because shipped behavior has not changed.

### P1 Whole-Markdown Search And Regex Containment (2026-10-20)

The whole-document prototype now exposes asynchronous literal/regex search,
case-sensitive and whole-word options, exact counts, and ordinal navigation.
It reuses CodeMirror's public `SearchQuery` matcher rather than defining new
regex semantics. A shared incremental rendered-text index keeps significant
inline spaces, inserts block separators, and maps source-ordered text records to
stable DOM nodes. Inline formatting, code fragment/message boundaries, and
supplementary Unicode do not split searchable terms. This is not a shipped
viewer search replacement, and the live DOM-search behavior is unchanged.

Search has its own dedicated module worker so aborting a query does not cancel
document publication. The source uses acknowledged 16,384-unit messages. The
worker builds and caches its rendered-text representation once per session;
ordinary subsequent queries reuse it. It retains only one 64-match window,
counts every match, and reports acknowledged progress every 512 matches. Windows
outside the cache are obtained by rescanning the cached text, not by retaining
an unbounded match array. Thus navigation remains exact beyond the window but
does not have constant-time or accepted latency guarantees. The whole text and
main-thread node index still grow with document size; this is not an aggregate
memory ceiling.

Only the active match gets a CSS Highlight range. Navigation uses indexed node
lookup rather than a DOM-wide scan, preserves native selection, and reports
pending if its destination text has not been published. Publication resolves and
reveals that destination later; there is no claim of priority whole-Markdown
publication or a maximum reveal delay. Starting a newer query/navigation aborts
obsolete work. Invalid regexes, worker errors, and timeouts remain explicit
failures with unknown counts, never fabricated zero results or a main-thread
regex fallback.

An experimental main-thread two-second no-progress deadline terminates a stalled
search worker, including a synchronous catastrophic regex. A retry rebuilds the
worker index while retaining the readable document. This prototype setting also
covers initial worker indexing; it is not an approved product timeout or a
promise that valid queries on arbitrary-size documents will complete. New-query
cancellation currently terminates an in-flight worker and loses its cached index.
Shutdown rejects active searches with `AbortError`, clears the search source and
DOM mappings, removes owned highlights, and terminates both worker types. Source
ownership belongs to the disposable session, not the mounted React callback.

Chromium 156 and Firefox 157 pass the existing 18-load whole-document matrices
plus search probes at both widths. The search fixture verifies 1,200 exact
matches while retaining at most 64, last/previous/first navigation, cached-index
reuse, inline/block/Unicode/zero-width regex cases, options, unchanged native
selection, invalid-query recovery, query supersession, and active-search
shutdown. An actual `(a+)+$` search over a failing 128-character run is terminated
by the deadline while real keyboard input is serviced; a subsequent literal
search succeeds without replacing the document. A separate paused-publication
probe verifies an exact match in unpublished text transitions from pending to
visible after publication resumes. All 39 focused unit regressions pass.

Still open: actual browser Find UI/assistive technology, arbitrary-structure
layout and aggregate memory bounds, physical/reference devices and agreed
input/completion/search budgets, full replacement semantics and production
recovery policy, and live integration. The original editor-search replacement
and source snapshot work is not implemented by these rendered-document probes.
P1 remains incomplete and P2-P6 production work has not started. No product
documentation changes are needed because shipped behavior is unchanged.

### P1 Viewport-Paged Syntax And Resource Observations (2026-10-20)

Whole-Markdown syntax preparation no longer streams and retains every syntax
range on the main thread. Complete prepared ranges stay in the preparation
worker, indexed by code-block ID. After preparation, the renderer requests only
overlapping ranges for nearby text parts, with binary range lookup and at most
64 records per page. There is one in-flight page and one main-thread viewport
cache, capped at 4,000 ranges. New windows replace the old cache; obsolete scroll
responses are discarded. The limit is an explicit experimental decoration
budget, not a document cutoff or an accepted application memory budget.

Viewport candidate work inspects at most 40 fragments and selects at most 40
text parts per paint. Within an oversized fragment, binary geometry lookup skips
parts above the viewport instead of reading every part's rectangle. Probe count
still depends on fragment size logarithmically, and browser layout itself is
not bounded by this algorithm. Syntax windows refresh on scrolling, container
resize, image load, and font completion. A capped/failed syntax window is reported
independently of complete readable source. Native text nodes are never replaced
to apply syntax.

Syntax sessions validate page bounds, isolate generations, handle post-load
worker crash/decode/timeout failures, and remove handlers when disposed. A tested
decode failure clears cached decoration while retaining the exact text and node
identity; the next document recreates the worker. Shutdown additionally releases
the syntax session, observers, font/load listeners, pending paint, and fallback
metadata. Main-thread viewport errors do not trigger a full-document fallback.

Chromium 156 and Firefox 157 pass the 18-load whole-document matrices and search
probes at both widths with this transport. The dense fixture has 30,000 prepared
ranges in the worker, while the observed main-thread cache peaks at 240 at both
widths, below its independent 4,000-range cap. Page replies contain at most 64
records. Scrolling to the final code lines requests new pages, paints visible
keywords, and preserves the first text node and native selection. The recorded
bottom-window paint used six geometry probes; this observation is not a universal
per-frame time bound. All 80 existing Chromium code-mode loads and 40 focused
unit regressions pass. Focused lint and direct prototype/model type checks pass;
49 existing transitive app errors and the build chunk warning remain.

The Chromium proof also runs six load/search/last-match/shutdown cycles per width
and records CDP main-renderer heap/DOM counters after explicit garbage collection.
Each recorded cycle has zero owned document children, zero owned highlight sets,
and zero live tracked workers after shutdown. DOM counters stay at one document,
116 nodes, and 176 listeners across the six samples at both widths. Used renderer
heap grows by approximately 12.4 KB from the first to last sample, from roughly
6.15 MB to 6.17 MB. These are raw observations with harness/browser overhead and
warm-up, not a leak-proof threshold. Worker heaps, native/process memory, peak
allocation, and physical devices are excluded. Firefox explicitly reports these
CDP measurements as unavailable rather than zero.

This closes unbounded main-thread syntax-range retention, not the whole resource
gate. Worker syntax arrays, retained text DOM, element/node indexes, whole-tree
parsing, and ordinary off-screen layout still scale with source/structure size.
There is no approved aggregate memory or latency ceiling. Reference-device
selection, accepted budgets and support envelope, real browser Find UI and
assistive-technology verification, production recovery/replacement contracts,
and live integration remain open. P1 is incomplete and P2-P6 production work has
not started. Shipped behavior and product documentation are unchanged.

### Provisional Development-Host Envelope And Budgets (2026-10-20)

The user approved development-host evidence provisionally, requested a measured
budget proposal, and then approved the host-only targets below. This does not
approve physical-device support, P1 completion, or rollout. The measured host reports an
Intel Core Ultra 9 285, 12 logical CPUs, approximately 31 GiB RAM, and a WSL2 Linux
kernel inside the Debian development container. Container resource allocation
and host scheduling are not certified hardware characteristics. Browsers are
Chromium 156 and Firefox 157; widths are 1543 and 390.

The opt-in scaling probe runs three fresh-worker trials per fixture/width: 54
trials per browser across three sizes each of dense code, paragraphs, and tables.
It records completion through two animation frames, first-query/index creation,
a changed query on the cached index, last-match navigation through two frames,
timer-service gaps, source/structure counts, and loaded renderer memory where
available. Failures remain explicit report entries and support blockers; an
exploratory run finishing does not mean all sizes passed.

```sh
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_PREVIEW_PROOF_SCALE=1 SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_PREVIEW_PROOF_SCALE=1 SAMBEE_PREVIEW_PROOF_BROWSER=firefox SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
```

**Approved provisional fixture envelope:** up to 24,000 code lines across four 6,000-line
blocks (216,086 UTF-16 source units), 4,000 short formatted paragraphs (144,014
units), or 2,400 two-column table rows (77,021 units), tested separately. These
are representative fixture bounds, not a guarantee for arbitrary structures,
combined worst cases, long URLs, fonts/images, or all documents below a byte cap.
No source cutoff or feature reduction is introduced.

The final observed maxima within those selected sizes, aggregated across both
widths and three trials, were:

| Browser | Completion | First Search/Index | Changed Warm Query | Last-Match Navigation | Timer-Service Gap |
| --- | --- | --- | --- | --- | --- |
| Chromium 156 | 624 ms | 299 ms | 15 ms | 37 ms | 42 ms |
| Firefox 157 | 1,032 ms | 784 ms | 15 ms | 34 ms | 16 ms |

These are sample maxima, not p95 statistics or measured physical input-to-paint
latency. Timer-service gaps are not Long Task durations; Firefox's Long Tasks
metric remains unavailable. The selected Chromium loaded-renderer JS heap
snapshots reached approximately 32.2 MiB, including accumulated harness/browser
overhead, without measuring peak allocation or worker/native/process memory.

**Approved provisional host-only targets:**

| Metric | Approved Host Target | Scope |
| --- | --- | --- |
| Document completion | At most 1,500 ms | Load call through two frames, selected fixture envelope |
| First exact search | At most 1,000 ms | Includes worker startup and rendered-text index creation |
| Changed warm-index query | At most 100 ms | Exact count; not a repeated cached-result lookup |
| Last-match navigation | At most 100 ms | Includes requesting another match window and two frames |
| Maximum timer-service gap | At most 50 ms | Scheduling responsiveness proxy, not input-to-paint acceptance |
| Loaded renderer JS heap snapshot | At most 64 MiB | Chromium only; not a total/peak-memory limit |
| Post-shutdown heap growth | At most 1 MiB across six warmed cycles | Explicit-GC main-renderer samples; zero owned DOM/highlights/live workers |

The existing 4,000-range viewport syntax and 64-match caches remain algorithmic
caps. A total renderer-plus-workers/native peak-memory budget cannot be justified
from these counters and remains open. Actual input-to-paint measurement also
remains required before replacing the scheduling proxy with a user-experience
acceptance claim.

The larger probes expose real exclusions: 72,000 code lines produced an observed
Chromium timer gap above 50 ms. The 8,000-paragraph probes showed additional
completion/indexing growth but are not claimed as budget failures. At 4,800
table rows, Chromium loads reached several
seconds with valid-query deadlines failing intermittently, and all six Firefox
trials failed. Those cases are not accepted by selecting smaller bounds; they
remain scaling issues and the failures stay in the reports. Budget changes and a wider
support envelope require further work and explicit approval, not a longer
watchdog or a silent document truncation.

An opt-in strict gate selects the approved sizes, requires exactly three trials
per fixture and width, checks finite timing values and the scoped Chromium
heap/shutdown limits, and exits nonzero on failure. Missing trials or unavailable
required Chromium measurements cannot silently pass. Exploratory scaling without
the strict flag continues to report larger-size failures separately.

```sh
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_PREVIEW_PROOF_SCALE=1 SAMBEE_PREVIEW_PROOF_BUDGETS=1 SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_PREVIEW_PROOF_SCALE=1 SAMBEE_PREVIEW_PROOF_BUDGETS=1 SAMBEE_PREVIEW_PROOF_BROWSER=firefox SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs
```

Both engines passed all 18 selected-size strict trials plus the ordinary
whole-document/search/native-interaction and shutdown checks in the recorded
runs. Budget boundary, over-budget, and missing-trial validation also passed.
This closes the provisional host-only budget decision and adds a reproducible
gate; it does not pass P1 or close the larger-size failures, total/peak-memory,
physical-device, native Find/assistive-technology, or production integration gates.

### P1 Upstream Table-Parser Fix Evaluation (2026-10-20)

The user approved evaluating the upstream fix first, with `markdown-it` as the
fallback if that evaluation disappoints. Profiling identified the repeated edit-list
scan in `micromark-extension-gfm-table` 2.1.1 as the table parsing bottleneck.
The frontend lockfile now resolves 2.1.2, whose upstream fix indexes edits with a
`Map`. No parser adapter, feature cutoff, watchdog, or rendering policy changed.

Both full scaling runs completed all 54 trials without explicit failures, including
all six 4,800-row trials per browser. The ordinary whole-document parity, native
selection, search, cancellation, recovery, and shutdown assertions also passed.
Applying `documentHostBudgetFailures` to each saved report returned no failures
for the approved fixture envelope and scoped resource checks. These exploratory
runs did not enable the strict-size filter; the same budget checker was applied
afterward to the selected-size measurements in each full report.

The observed maxima across six 4,800-row trials per browser were:

| Browser | Document Completion | First Exact Search/Index | Changed Warm Query | Last-Match Navigation | Timer-Service Gap |
| --- | --- | --- | --- | --- | --- |
| Chromium 156 | 4,769.4 ms | 297.2 ms | 5.7 ms | 34.3 ms | 51.6 ms |
| Firefox 157 | 985 ms | 512 ms | 9 ms | 34 ms | 39 ms |

The valid-query parser deadlines no longer fail in these samples. Chromium still
has substantial large-table publication cost: first content arrived within 259 ms,
but completion included 751 acknowledged batches and 24,007 retained elements.
These counters do not isolate layout, transport, or publication scheduling costs.
The Chromium 4,800-row timer gap and several 72,000-code-line gaps still exceeded
50 ms. Neither larger size is promoted into the approved envelope.

Retain the current parser: the measured parsing improvement does not justify a
`markdown-it` migration at this point. P1 remains incomplete; large-structure
publication, total/peak memory, physical devices, native Find/accessibility, and
production integration remain open. This evaluation does not ship the prototype.
Existing Markdown viewer/editor/table/search/syntax tests passed: 163 tests in
eight files. Evidence is retained at `/tmp/sambee-preview-proof-QCbnnc` (Chromium)
and `/tmp/sambee-preview-proof-3Bb192` (Firefox); these are temporary local artifacts,
not durable CI evidence. No end-user documentation changes are needed for this
internal dependency fix and prototype evaluation.

### P1 Frame-Paced Publication (2026-10-20)

The follow-up remains isolated to the prototype. A Chromium profile of a
4,800-row table measured approximately 44 ms in batch handling, versus 1.24 seconds
of layout over 171 passes during a 3.5-second load. Removing the extra task yield
alone did not resolve the delay. The retained semantic DOM is still necessary for
the approved native-text interaction direction; no content is dropped or hidden.

The prototype now separates publication from syntax-page bounds: structural
publication uses at most 512 records, code fragments use a 128-record flush
threshold, and syntax pages remain capped at 64 ranges. Descendants are assembled
in bounded per-batch document fragments before attachment. Original code blocks
use layout/style containment, without `content-visibility` or size containment.
Empty decoration work is skipped, and unchanged viewport/token combinations do
not rewrite CSS Highlight collections.

Publication acknowledges at most two batches before waiting for an animation
frame. The wait is abortable and releases on a hidden-page transition; already
hidden pages use task yielding instead. Tests now deterministically pause a
partial publication, accept input, publish another batch, preserve native
selection, and cancel. A visibility-transition regression verifies completion
without waiting indefinitely for background animation frames.

Unpaced bursts still produced intermittent scheduling failures, retained in
the exploratory reports. One-batch-per-frame pacing removed those gaps but
regressed Firefox's approved paragraph completion target to 1,501-1,505 ms in a
strict run. Two-batch pacing passed the unchanged strict targets; neither the
latency budgets nor watchdogs were relaxed.

Final full scaling runs each completed 54 trials without explicit failures and
without timer-service gaps above 50 ms. Maxima across both widths and three trials:

| Browser / Fixture | Completion | First Search/Index | Changed Warm Query | Last-Match Navigation | Timer-Service Gap |
| --- | --- | --- | --- | --- | --- |
| Chromium / 4,800 table rows | 1,664 ms | 309 ms | 6.1 ms | 32 ms | 40.4 ms |
| Firefox / 4,800 table rows | 1,233 ms | 389 ms | 10 ms | 33 ms | 34 ms |
| Chromium / 72,000 code lines | 1,061.7 ms | 284.7 ms | 36.4 ms | 68.3 ms | 13 ms |
| Firefox / 72,000 code lines | 1,472 ms | 501 ms | 49 ms | 56 ms | 15 ms |

Evidence: `/tmp/sambee-preview-proof-aW1A53` (Chromium full),
`/tmp/sambee-preview-proof-O1pjrN` (Firefox full),
`/tmp/sambee-preview-proof-ltQnGg` (Chromium strict), and
`/tmp/sambee-preview-proof-cjSO7Q` (Firefox strict). Each strict run passed all
18 approved-size trials and the ordinary semantic, native-interaction, search,
failure/recovery, cancellation, and shutdown checks. The 163 existing Markdown
tests also passed; touched files have no editor diagnostics.

These samples improve the previously recorded large-table load and code scheduling
issues, but do not promote larger fixtures into the approved envelope: Chromium's
4,800-row completion still exceeds the 1,500 ms target used for selected sizes.
The snapshots do not establish total/peak memory or physical input-to-paint bounds.
Physical-device testing, native Find UI/assistive technology, the production
recovery contract, and live integration remain required. P1 is not complete;
P2-P6 have not started. No end-user documentation changes are needed for the
unshipped prototype.

### Additional Risks

| Area | Risk | Mitigation |
| --- | --- | --- |
| Variable-height Markdown and large structures | High | Prototype subdivision, measurement, wrapping, and scroll anchoring before migration. |
| Selection, accessibility, browser find, print | High | Explicit behavior gate; tested model/DOM mapping; no silent feature regression. |
| Snapshot and save/recovery boundaries | High correctness risk | Revisioned snapshots, explicit flush, IME/table and failure regressions. |
| Search semantics and exact counts | Moderate-high | Preserve existing query behavior; pending/exact distinction; revision caches and deterministic scan-count tests. |
| Worker cancellation, transfer, and memory | Moderate-high | Bounded units/delivery, tested restart/failure handling, resource cleanup and memory profiling. |
| Existing highlighting/theme contract | Low-moderate | Retain neutral ranges and palette rules; rerun parity and compatibility tests. |

Overall integration risk is high until P1 passes. Bounded rendering offers the
strongest long-term scaling design of the evaluated options, but neither it nor
workers guarantee arbitrary-size performance. Scope approval is complete; library
selection, the tested support envelope, and interaction/performance acceptance
remain open implementation gates.
