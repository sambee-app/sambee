# Shared Syntax Highlighting Plan

Status: Proposed; implementation not started.

## Goal

Use the same language parsers and token colors for the text viewer, text editor,
Markdown viewer code blocks, and Markdown editor code blocks. Also highlight the
actual Markdown source lines in the regular Markdown editor, not only fenced
code. Keep the solution small, preserve existing interactions, and avoid
embedding editors in rendered Markdown.

## Current Implementation

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
- `frontend/src/utils/domTextSearch.ts` currently drops whitespace-only text
  nodes. Syntax spans can isolate spaces between tokens, causing the search index
  to join words that are separated in the displayed source.

## Proposed Design

### Shared Language Resolution

Reuse the installed CodeMirror language descriptions. Provide separate, small
lookup functions for filenames and Markdown fence labels, returning descriptions
from the same registry. Preserve lazy loading and reuse the descriptions' existing
loading behavior rather than building a second parser cache.

Fence labels remain case-insensitive. Do not infer languages from block contents.
Check currently supported Highlight.js aliases and explicitly map compatibility
aliases where needed. Do not treat arbitrary file extensions as fence aliases.

### Shared Token Styling

Define one complete, theme-aware `HighlightStyle` for keywords, strings, numbers,
comments, types, functions, operators, punctuation, and ordinary identifiers.
Map tags to stable application-owned token classes and define their colors once
using theme CSS variables. Use the same classes and CSS in all CodeMirror
surfaces and static Markdown highlighting. Install the CSS at the viewer/editor
surface level, independently of editor mounting, and update variables on theme
changes without reparsing code or replacing the preview.

Replace competing default/custom code highlighting rules. Scope the Markdown
source style to the outer Markdown language and the code style to embedded
languages; do not let generic string/link tags apply both styles to code. Verify
the scope behavior with actual nested syntax trees, including legacy parsers.

Keep background, border, wrapping, selection, and search styling independent of
syntax token styling. Support both application light and dark themes.

### Markdown Source Highlighting

Use CodeMirror's existing Markdown parser and Lezer tags; do not add a second
Markdown parser or regex-based decorations for editor highlighting. Define a
small companion style for headings and their markers, emphasis/strong text,
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

Replace `rehype-highlight` with a small adapter using each resolved language's
parser and Lezer's `highlightTree`. Produce normal text nodes and classed spans
inside existing `pre` and `code` elements, never raw HTML or a CodeMirror instance
per block. Preserve source text, whitespace, copying, and native selection.

Prepare required grammars asynchronously outside the synchronous `ReactMarkdown`
plugin path, then apply highlighting synchronously using loaded grammars. Collect
fence labels from the Markdown AST, not regexes. Settle all required language
loads, including individual failures, and publish one prepared result per content
generation rather than updating the DOM once per block. Display plain text until
preparation completes. Ignore stale results after document changes, entering edit
mode, or unmounting; a failed grammar must not prevent other blocks highlighting.

Unlabelled, unknown, explicitly plain-text, failed, and oversized blocks remain
plain text. Catch and log actual loading/parsing failures without failing the
whole document. Use centrally defined initial static budgets of 100,000 UTF-16
code units per block and 500,000 cumulatively per document. Count eligible source
in document order before loading grammars or parsing; over-budget blocks stay
plain text. Verify these initial limits against representative browser fixtures
and adjust before merging if necessary. They bound parser input, not execution
time; no hard latency guarantee or worker infrastructure is implied.

### Preview Commit And Search Ownership

The Markdown viewer owns a content-generation identifier and a separate committed
preview revision. The static adapter only transforms prepared content; it must
not manipulate live DOM, emit per-block completion events, or manage search.

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
match can cover several token spans. This is a targeted prerequisite fix, not
a rewrite of viewer search.

## Scope And Non-Goals

- Keep existing viewer/editor components, routes, editing, saving, and recovery.
- Do not change Markdown serialization, source content, or file-type eligibility.
- Do not add language autodetection, a user-selectable theme system, or a worker
  framework as part of this change.
- Do not rewrite text viewer/editor search or replace static Markdown with editors.
- Verify whether related user/developer documentation needs updates when the
  implementation and compatibility behavior are finalized.
- Remove Highlight.js dependencies only after checking for other consumers and
  following the repository's dependency-update workflow. No new parser dependency
  is expected; verify direct dependency declarations for imported Lezer APIs.

## Implementation Sequence

1. Extract shared language lookup and the complete highlighting definition. Add
   focused tests for names, aliases, filenames, and token rules.
2. Integrate the shared definition into the text viewer/editor and Markdown editor.
  Add scoped Markdown source highlighting and test actual Markdown syntax trees,
  nested code, and light/dark styles without changing source layout or content.
3. Repair code-block whitespace indexing with focused DOM-search regressions.
  Validate that prose search retains its existing behavior.
4. Add the static adapter, bounded grammar preparation, safe plain-text fallbacks,
  and the viewer-owned revision/commit/search contract. Test stale work, selection
  deferral, and pending query changes before integrating dependency cleanup.
5. Validate parity and browser behavior, update applicable documentation, and
   remove unused Highlight.js integration and dependencies where appropriate.

Validate each implementation slice before moving to the next one.

## Acceptance Checks

- Representative JavaScript/TypeScript, Python, SQL, shell, and legacy-mode
  examples receive equivalent token classes across all four surfaces.
- Markdown source highlighting covers headings/markers, emphasis/strong,
  strikethrough, lists, blockquotes, links/images, inline code, thematic breaks,
  and fence delimiters/labels in both Markdown and text editor paths. Assert
  actual emitted classes, neutral paragraph text, unchanged line geometry, and
  isolation between Markdown styles and nested code styles.
- Filename resolution, fence aliases, unknown/unlabelled/plain-text blocks,
  language loading failure, parsing failure, and stale async completion are tested.
- Light/dark colors remain readable; rendered Markdown prose and inline code do
  not change unexpectedly; syntax colors do not obscure search or selection.
  Opening Markdown preview without ever mounting an editor still loads token CSS;
  switching theme updates colors without reparsing or replacing code DOM.
- Code text and whitespace survive highlighting unchanged; copying includes no
  added text; native selection still works.
- Viewer search finds text within and across tokens, remains correct after grammar
  loading, and retains usable next/previous navigation.
- Search for `const x`, multi-space sequences, tabs, and line-spanning code text
  succeeds when whitespace lies in separate text nodes between token spans. Keep
  prose-search regressions for indentation and boundaries between blocks.
- With search already active, grammar completion safely replaces the preview and
  recomputes matches exactly once for the committed revision using the latest
  query. Cover rapid document/query changes, closing/unmounting, entering edit
  mode, repeated search clearing, active-match preservation, scroll stability,
  and highlighting deferred until a native selection collapses.
- Over-budget blocks use plain text without loading their grammars solely for
  those blocks or parsing them. Test both the individual-block and cumulative
  limits, including documents containing many individually small code blocks.
- Run relevant editor, viewer, DOM-search, and theme tests, frontend lint/build,
  and desktop/mobile browser checks through the approved demo connection.

## Effort And Risk

| Work | Estimate |
| --- | --- |
| Shared language resolution, code/Markdown styles, editor integration | 1-1.5 days |
| Static adapter, whitespace fix, loading/search/selection integration | 1-1.5 days |
| Tests, browser checks, documentation, dependency cleanup | 1 day |
| Total | 3-4 engineering days |

Overall risk is low-to-moderate. Main risks are DOM-search interactions during
asynchronous preview replacement, large-block parsing cost, light/dark contrast,
Markdown/embedded-code scope isolation, and compatibility with existing
Highlight.js language aliases. The estimate includes the whitespace repair and
explicit preview/search lifecycle work. Allow another day if selection, DOM
ownership, or scope-isolation checks expose additional integration problems.
Estimates assume no change to Markdown content or editing architecture.
