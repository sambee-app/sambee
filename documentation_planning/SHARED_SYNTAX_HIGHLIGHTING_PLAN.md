# Shared Syntax Highlighting Completion Plan

Updated: 2026-10-22. **Merge and rollout remain blocked by responsiveness and
open interaction acceptance.** Work through the remaining gates in dependency
order: define acceptance, close correctness, check native constraints, then
optimize measured costs. Mark items complete only with their relevant
verification. Functional passes do not close performance or manual interaction
gates. Reordering does not approve policy changes or relax existing targets.

## Goal And Boundaries

Share language resolution, parsers, token categories and theme colors across
the text viewer/editor, rendered Markdown fences and Markdown source editor.
Highlight Markdown structure and embedded code. Preserve exact source, editing,
search, selection, copy, navigation, Save and recovery.

Keep CodeMirror behind the small application-owned highlighting contract. Reuse
the native editor, registry, token mapping, theme variables, lazy grammars and
dedicated cancellable workers. ReactMarkdown is the only application
whole-document renderer. Initial loads reuse the normalization worker's canonical
tree, paired with its exact source/generation and cloned before remark transforms.
Edited content without a matching tree keeps normal parsing.

Do not add a renderer, parser stack, embedded preview editors, virtualizer,
worker pool, provider registry, parallel theme store, generic scheduler or
geometry cache without measured need and explicit scope approval. Retired
renderer proofs are not deliverables. Recovery/authentication redesign and the
experimental checkpoint scheduler remain out of scope.

## Current Status And Findings

- **The shared foundation is sound.** Registry, token mapping, lazy grammars,
  Markdown source styles and legacy theme compatibility are integrated.
  Representative four-surface language parity now passes in production browsers;
  grammar-readiness, failure isolation and theme/browser-state slices also pass.
  Theme-dialog regressions now pass; wider native-interaction acceptance remains open.
  Item 5's printing and heading implementations are complete. The independent
  printing slice has 24 browser passes and 12 complete text/image PDF outputs;
  item 5c's automated gate now passes all 12 cases and six PDF-content checks.
  The user confirms 5d's manual checks are complete; all substeps 5a-5e and
  item 5's representative native-constraint gate are complete.
  Language-independent token enrichment is complete under 5e. Broader
  interaction/device acceptance remains open under item 7.
  Passing these subchecks
  doesn't authorize unrelated layout optimization or establish rollout acceptance.
  Configuration-only theme/grammar updates no longer
  request caret reveal; four-surface browser selection/search/scroll preservation
  is now verified without closing scrolling-performance acceptance.
- **Progress is measurable, not rollout acceptance.** Canonical-tree reuse
  removes repeated initial main-thread parsing. Viewport publication and local
  geometry fast paths reduce work without replacing native text. The latest
  matrix still fails 19/48 timing trials solely on the 50 ms timer-gap target;
  the previous tree-reuse run failed 18. The latest step is not uniformly better.
- **Publisher invalidation defect fixed locally.** Syntax now refreshes after
  captured image loads and font loading, matching preview search. Tests cover
  clipping, coalescing, unchanged text, listener removal and post-disposal
  inactivity. This does not close broader image/font/width acceptance.
- **Highlight readiness passes the approved fixture envelope.** Syntax publication waits for all
  requested blocks, while current text-load timing deliberately holds syntax
  preparation. Measure first visible syntax and full preparation before
  considering incremental publication; that barrier is not yet proven slow.
  A separate unheld four-fixture slice now has 48 passes with
  approved readiness limits enforced. Many-block visible-syntax maxima are
  898.8/1,378 ms Chromium/Firefox; this does not justify incremental publication.
  Long-line coverage now includes horizontal clipping and exact UTF-16 offsets.
  A separate real-HTTP run now passes 96 cold/cache samples with fresh workers,
  measured cache reuse and no preloading. Item 4b is complete; this doesn't
  close the independent timer-gap, memory, interaction or device gates.
- **Nested load and parse failure isolation is verified.** A failed nested
  grammar retains enclosing Markdown structure and successful sibling highlighting.
  Static mixed parsing contains startup/advance errors within the failing fence,
  without mutating cached grammars, retrying or adding another parse. Cancellation
  and depth safeguards remain intact. All 36 production browser failure/nesting
  cases pass across both engines/widths, including pending-load cancellation and
  clean-generation recovery. This does not close the old timer-gap gate.
- **Production preparation is normalization-only.** The host, worker and protocol
  no longer import document-preview models or contain hard-coded search/syntax
  proof branches. Historical proof transport and worker execution remain in the
  existing prototypes area, independent of the live normalization path. This is
  dependency cleanup, not a measured performance improvement.
- **Source regex containment is integrated, not fully accepted.** Dedicated
  worker counts/navigation/replacement, bounded delivery, stale-plan guards,
  timeout/restart and visible feedback have functional coverage. Dense atomic
  replacement, retained result memory and sustained typing remain open.
- **Worker support policy is decided; native gates remain open.** The existing
  pre-app capability gate now requires the Web Worker API and shows the existing
  unsupported-browser screen without importing the app when it is absent.
  Worker-less app operation isn't supported; helper fallbacks don't establish a
  supported mode. Startup/crash/timeout handling remains required. Actual browser
  Find, OS clipboard, assistive technology, printing and physical devices still
  need acceptance.

Latest recorded unchanged production matrix: three trials per fixture, width
and engine; 48 complete timing reports plus six native-contract passes. All
fixture trials reached functional checks and cleanup. These are prior results,
  not a performance rerun for the invalidation or nested-failure fixes.

| Browser-Side Timing | Chromium Maximum | Firefox Maximum | Target |
| --- | --- | --- | --- |
| Text load through two frames | 450.9 ms | 629 ms | 1,500 ms |
| First exact search | 33.9 ms | 59 ms | 1,000 ms |
| Changed query | 47.8 ms | 40 ms | 100 ms |
| Last-match navigation | 60.4 ms | 46 ms | 100 ms |
| Viewer timer-service gap | 123.7 ms | 89 ms | 50 ms |

Earlier single-renderer baseline gaps were 286.9/473 ms. Latest failures: 12
many-block cases, five Chromium long-line cases and one near-safeguard case per
engine. Chromium diagnostic traces attribute 83.2 ms of a many-block gap to native
Layout for 60,600 code lines. This is not Firefox attribution or proof that all
remaining gaps share that cause. Treat native layout separately; further geometry
changes need evidence of material remaining geometry cost.

Latest timing report: `/tmp/sambee-horizontal-geometry-final.json`; comparison:
`/tmp/sambee-viewport-geometry-final.json`; diagnostic attribution:
`/tmp/sambee-stall-attribution.json`. Temporary files are supplementary evidence,
not required implementation artifacts. Tracing/GC runs are not timing acceptance.

## Ordered Completion Checklist

- [x] **1. Fix syntax publisher font/image invalidation.** Reuse the existing
  refresh path, coalesce events and remove listeners on disposal. Both new
  regressions failed before the fix and pass afterward; 83 affected syntax,
  parser and DOM-search unit tests, frontend lint, touched-file diagnostics and
  whitespace checks pass. A development-browser probe at the approved demo URL
  confirms that simulated font-metric changes refresh clipping without a scroll,
  preserve text and remove owned highlights on abort. No production timing gate
  or real asynchronous font/image acceptance is closed by this local check.
- [x] **2. Remove retired proof coupling from production preparation.** Production
  preparation now handles only one canonical source and its optional tree;
  historical proof execution is isolated in the existing scripts area. Shared
  syntax workers and normalization/tree chunk bounds remain intact. Verification:
  130 adapter/viewer tests, normal production build, frontend lint, touched-file
  diagnostics and independent historical-entry compilation. All four unchanged
  dense production cases pass in Chromium/Firefox at widths 1543/390, including
  held-normalization cancellation, reopening and zero live workers/highlights
  after close. These are functional checks, not a repeated timing matrix or a
  claimed speedup. The existing large-chunk build warning remains.
- [x] **3. Finalize missing acceptance definitions and support policy.** Defined
  first usable text, first visible syntax/full preparation, peak/resource and
  available-hardware/refresh-rate criteria before further responsiveness changes.
  Worker-less app operation is now explicitly unsupported and blocked by the
  existing pre-app gate, without a separate reduced-functionality mode. A size
  guard or yield between blocks does not bound one main-thread parse, and a
  timer cannot interrupt that parse.
  Retain approved targets below. Record decisions requiring approval rather than
  silently changing fallbacks or relaxing tests. Measurement can inform a policy
  decision without requiring that policy to be implemented first.
  **Completed by explicit approval:** Readiness, memory and scrolling limits
  below are approved, alongside the implemented Worker requirement. Test on
  available hardware and record its configuration; no prescribed models or
  minimum hardware profiles are required. Helper fallbacks and existing timing
  targets are unchanged. Measurement/enforcement and actual acceptance remain
  in items 4b, 6 and 7; defining the criteria doesn't establish passing results.
- [x] **4. Close four-surface language and theme correctness.** Audit aliases and
  dialects, including `mssql` and `mariadb`, in the existing registry. Verify
  JavaScript/TypeScript, Python, SQL, shell, legacy modes, nested Markdown and
  neutral prose/unknown fences through actual surfaces. Cover cold/cached
  grammars, load/parse failures, late rejection, cancellation and unrelated-block
  success. Check light/dark/custom-alpha colors, selection/search contrast and
  independent scopes. Theme/grammar changes must preserve document/editor
  identity, selection, search and scroll without content reprocessing. Exercise
  existing theme-dialog save/cancel/copy/validation/permissions at both widths;
  follow the repository form/dialog pattern for any UI changes.
  Close these slices independently; item 4 requires all four:
  - [x] **4a. Failure isolation and nesting.** Keep successful siblings and
    enclosing Markdown structure highlighted when a nested grammar fails to
    load or parse. The review reproduced whole-parent fallback after a nested
    Python load failure; nested load and static parse containment are now fixed.
    Cancellation, stale-result rejection and the intentional four-level nesting
    safeguard are preserved, with late-failure and recovery coverage.
    **Verified local slice:** Both load-failure sibling-order regressions and both
    parse-start sibling-order regressions failed before their fixes and pass now.
    Tests also cover parser-advance errors in either order, a healthy later fence
    using the same grammar, neutral failed code, retained structure and siblings,
    independent top-level success, later recovery and source-private diagnostics.
    Cancellation during parse or followed by late load rejection still propagates.
    All 280 affected unit/component tests, 40 production language/theme cases,
    frontend lint, normal production build and touched-file diagnostics pass.
    **Browser completion:** All 36 production failure/nesting cases pass in
    Chromium/Firefox at widths 1543/390. Test-only asset instrumentation injects
    actual worker grammar-load, parser-start and parser-advance failures, in both
    sibling orders at the four-level limit. Assertions require neutral failed
    Python keywords, retained headings/JavaScript siblings, later healthy Python
    after parse failure, exact text, unchanged text nodes and search counts.
    Pending-load cases close and terminate the worker, then reopen without the
    fault and require successful highlighting. Over-depth cases keep the guarded
    block plain while independent JavaScript still highlights. Owned workers and
    syntax highlights reach zero after close. All 71 parser/publication/worker
    regressions also pass, including late rejection and obsolete-message guards.
    No production injection hooks or alternate parser path were added. The
    existing large-chunk build warning remains; no timing gate is closed here.
  - [x] **4b. Grammar readiness.** Isolate cold/cached grammar conditions and
    measure first visible syntax and full preparation against item 3 criteria.
    Current text-load timing deliberately holds syntax preparation and does not
    establish highlighting readiness. Change all-block publication only if its
    measured cost warrants the added complexity.
    **Enforced readiness slice:** The existing production-viewer harness now has
    separate unheld dense, near-safeguard, many-block and long-line readiness
    cases. All 48 trials pass at widths 1543/390
    in Chromium/Firefox, three per combination, with exact source, complete token
    coverage on initial fully visible lines or horizontally visible characters,
    native selection, exact search counts
    and highlight cleanup. All trials enforce usable text <=1,500 ms, visible
    syntax <=1,500 ms and full preparation <=3,000 ms. The shared budget evaluator
    rejects missing, invalid and over-budget samples; all 26 evaluator tests pass.
    Forced-GC/tracing modes are rejected for this readiness slice, and attached
    reports retain evidence before asserting the budget result.
    **Cache completion:** `SAMBEE_E2E_HTTP_CACHE=1` uses an isolated loopback HTTP
    proxy, not Playwright request routing. Browser navigation remains at the
    approved demo URL; the existing dev server isn't reconfigured or stopped.
    Existing API fixtures are shared with the proxy. Assets use explicit HTTP
    cache headers; API and HTML responses remain uncached. All 48 paired tests
    pass, producing 96 individually budget-checked reports: three cold/cache pairs
    per fixture/width/engine. The first open uses a fresh context and fetches the
    worker/grammar assets; reopening follows zero live workers, creates a fresh
    syntax worker and makes zero JavaScript asset requests to the proxy. The
    600-block fixture also exercises repeated grammar use within one worker job.
    No preloading, retained worker or worker pool was introduced. The
    many-block run records first-block and all-block receipt separately; all-block
    publication currently meets the approved readiness limits, so no incremental
    publication change is justified by these samples.
  - [x] **4c. Theme and browser state.** Verify contrast and actual browser
    selection, active search and scroll through theme/grammar changes, with no
    content reprocessing. Node identity and computed colors alone are insufficient.
    **Verified browser slice:** All 16 production cases pass in Chromium/Firefox
    at widths 1543/390, with each of the four surfaces tested independently under
    the unchanged 15-second timeout. Test-only instrumentation holds the actual
    lazy JavaScript grammar until native selection, an active keyword search and
    nonzero vertical/horizontal scroll are established. Releasing the grammar and
    applying light/dark/custom-alpha themes preserve selection text and endpoints,
    active-match ranges/counts, scroll offsets, surface identity and exact text.
    Preview text nodes remain unchanged; cumulative render-stage observation and
    worker requests reject repeated normalization or Markdown content processing.
    State and alpha-composited contrast reports are attached to each browser case.
    **Contrast corrections:** Dark ordinary search text failed at approximately
    4.14:1, reproduced by a unit regression before the shared opacity fix.
    Keyword/search overlap then failed at approximately 3.83:1. Search now uses
    the viewer foreground over syntax; preview syntax priority -1 retains search
    priorities 0/1. All measured keyword, selection and ordinary/current search
    pairs pass 4.5:1, and unit tests cover all eight built-in syntax roles on
    viewer/code backgrounds. The custom-alpha fixture is deliberately readable;
    arbitrary custom colors aren't contrast-validated or silently rewritten.
    Final reports contain 228 browser contrast samples, minimum 5.30:1, with
    no skipped, retried or flaky browser cases. All 426 affected unit/component
    tests, normal production build, frontend lint, touched-file diagnostics,
    docs-content validation and whitespace checks pass. The existing large-chunk
    build warning remains. Supplementary browser report:
    `/tmp/sambee-4c-theme-browser-state.json`.
    These are state/contrast checks, not performance, close/navigation, native
    clipboard, physical-device or theme-dialog acceptance.
  - [x] **4d. Theme-dialog regression.** Exercise existing save/cancel/copy,
    validation and permissions at both widths without redesigning the dialog.
    **Verified browser slice:** All 48 production cases pass in Chromium/Firefox
    at 1543x900 and 390x600 under the unchanged 15-second timeout. Light/dark
    personal and admin site themes preserve the original on Cancel, reject blank
    names and invalid syntax without writes, and save exact alpha-inclusive
    definitions with the original scope/version. The last Syntax field remains
    above the visible footer actions in the short mobile drawer. Built-ins remain
    read-only for everyone; ordinary users can't overwrite site themes or create
    site copies. Copy validates collapsed Syntax fields, restores focus after
    Escape, preserves the source and applied selection, and sends exactly one
    correctly scoped create request. Rejected 403/409 saves retain the draft and
    actionable server detail without changing the stored theme or selection.
    The existing dialog needed no production change. API interception confines
    theme writes to fixtures at the approved demo URL. All 106 existing focused
    dialog/Appearance/theme tests and touched-file diagnostics pass. These checks
    don't establish physical-phone, assistive-technology or wider native-viewer
    acceptance; those gates remain in items 5-8.
  **Verified slice:** `mssql` and `mariadb` resolve to the existing dialect
  grammars, without changing `.sql` filename behavior. All 32 new production
  correctness cases pass in Chromium/Firefox at widths 1543/390: JavaScript,
  TypeScript, Python, SQL, shell and PowerShell through text viewing/editing,
  rendered fences and Markdown source; SQL dialect fences through preview/source.
  Checks cover exact categories/UTF-16 offsets, complete token coverage across
  horizontally clipped preview windows, unchanged preview text nodes, Markdown
  structure and neutral prose/unknown fences. All 104 affected unit tests,
  normal build, lint and touched-file diagnostics pass.
  **Theme and development follow-up:** Eight production cases pass across both
  engines/widths for light/dark/custom-alpha colors, scoped overrides and stable
  content/text-node identity through all four surfaces. Six mounted-component
  regressions additionally preserve editor document/selection/search/scroll/undo
  and preview selection/search/preparation ownership. Text and Markdown browser
  cases are isolated; they don't certify cross-file close/navigation behavior.
  Fixed the development normalization-worker crash by resolving the DOM-free
  character decoder before dependency optimization, not only in worker builds.
  Both development-browser entity-decoding cases pass; local preparation errors
  now retain actionable details instead of claiming server overload. All 179
  affected unit tests, build, lint and touched-file diagnostics pass. The default
  browser-test timeout is 15 seconds; explicit longer proof overrides remain.
  These earlier checks are supplemented by items 4c and 4d above; all item 4
  language/theme correctness slices are complete, not rollout acceptance.
  The existing large-chunk build warning remains.
- [x] **5. Check representative native constraints before optimization.** On
  representative multiline, long-line and nested Markdown documents, check
  cross-block native selection/copy, actual browser Find/reveal, keyboard/focus
  and real print/PDF output. These checks constrain layout-affecting changes;
  rerun affected checks after such changes. Record any manual testing blockers.
  They do not replace the full interaction/device acceptance in item 7. Do not
  introduce a replacement renderer to evade measured native-layout costs.
  - [x] **5a. Fix full-document printing.** Add scoped print-only styles to the
    existing Markdown viewer: release viewport height/overflow constraints, hide
    controls/background UI, paginate normally and wrap long code lines. Verify a
    focused real PDF before running the full matrix; preserve screen layout,
    document identity, selection and scroll after printing.
    **Verified print implementation:** A preview-only Print icon opens the native
    dialog, including its Save as PDF destination; failures leave the viewer usable
    with actionable feedback. Scoped print styles release modal/scroll constraints,
    hide controls/backing UI, wrap code/table cells and use black-on-white text in
    both themes. Native print lifecycle handlers preserve focus, selection and
    nested scroll and release listeners/frames on disposal. Fullscreen paper uses
    its fixed container's dimensions rather than leaking print-page viewport units
    back into screen layout. All 24 independent Chromium/Firefox print cases pass
    across three fixtures, light/dark and widths 1543/390. All 12 actual Chromium
    PDFs contain every expected non-whitespace text line and an embedded image;
    first/last-page rasters were visually inspected for each output. The 13 PDF
    checker tests and 207 affected component tests pass. Firefox checks print CSS
    and action behavior, not actual Firefox PDF output or physical printing.
  - [x] **5b. Fix heading targets.** Generate stable, safely prefixed heading IDs
    in the existing render pipeline using a standard slugger. Resolve internal
    fragments consistently, including Unicode and duplicate headings. Verify
    keyboard target reveal without losing viewer identity or application state.
    **Verified implementation slice:** `rehype-slug` assigns safely prefixed IDs
    in the existing HAST pass; matching fragments resolve to those IDs. Focused
    tests cover duplicate/stable IDs, Unicode, already-prefixed fragments and
    unchanged malformed/unknown/external/footnote links. Desktop Chromium reaches
    the target by keyboard and preserves the route path/query and preview node.
    All 204 affected
    viewer/Markdown/theme tests pass. The 5c rerun now verifies heading target/reveal,
    route and preview identity in all 12 engine/fixture/width cases.
  - [x] **5c. Enforce native regressions.** Replace observational hash checks
    with target/reveal assertions. Require the 12-case browser matrix and all six
    real PDF-content checks, plus focused regression tests and visual inspection.
    Keep missing/duplicate/failed evidence fatal; PDF byte size isn't acceptance.
    Printing is independently enforced by `production Markdown printing` and the
    PDF checker's `--printing` mode, so native Find can't prevent print verification.
    **Verified automated gate:** All 12 production cases pass in Chromium/Firefox
    at widths 1543/390 without skips or retries. Heading navigation requires the
    actual target ID/reveal, unchanged route path/query and preview identity.
    Select All, cross-block selection and exact trusted keyboard clipboard
    payloads pass. All six actual Chromium PDFs contain every expected
    non-whitespace text line; first/last-page rasters for each were visually
    inspected with no observed blank/clipped output. The aggregate PDF checker
    passes and keeps missing/duplicate/failed evidence fatal. All 15 PDF-checker
    regressions and 138 focused viewer/Markdown tests pass, as do touched-file
    diagnostics and whitespace checks.
    **Find verification correction:** The user reports that Chrome's actual
    native Find works in the Markdown viewer. Chromium's `window.find` selects
    but doesn't reveal even in an application-free scroller, so its reveal
    geometry is now explicitly diagnostic-only, not native-toolbar acceptance.
    Exact `window.find` selection remains required in both engines; Firefox
    additionally requires complete match reveal inside the content viewport.
    Reports retain bounds/scroll evidence and label the engine-specific assertion
    policy. Actual browser-menu Find completion is recorded in 5d;
    no application scrolling workaround or production layout change was added.
    Supplementary evidence: `/tmp/sambee-5c-native-complete.json` and
    `/tmp/sambee-5c-complete-pdf-review/`. This automated evidence closes 5c;
    completed manual checks in 5d and syntax enrichment in 5e close item 5,
    not rollout acceptance.
  - [x] **5d. Obtain manual native evidence.** Check browser-menu Find rather
    than app search or `window.find`; inspect Chromium/Firefox print previews and
    output for multiline, long-line and nested fixtures. Record unavailable
    physical-printer/device evidence explicitly without waiving acceptance.
    **Manually completed on 2026-10-22:** The user confirms this manual-testing
    substep is complete, supplementing the earlier confirmation that Chrome
    native Find works as expected in the Markdown viewer. Accept this as manual
    completion of 5d, not an administrative closure or transfer of unfinished
    checks to item 7. Detailed browser versions, fixture/width results and
    printer/device inventory weren't supplied; no specific results are inferred.
    All substeps 5a-5e are complete, closing item 5's representative gate.
    Item 7 retains its separate, broader interaction/device/resource acceptance.
  - [x] **5e. Preserve language-independent syntax distinctions.** Map existing
    grammar tags for built-ins, properties/keys, booleans, null, regular
    expressions, escapes and metadata/directives to shared application token
    categories. Reuse the eight existing theme color roles with one central
    category-to-color mapping across editors and rendered fences; do not add
    language-specific tokenizers, semantic analysis, document scans, dependencies
    or theme schema changes. Preserve neutral identifiers and unknown fences,
    exact source/UTF-16 offsets, nested Markdown, selection/search and cleanup.
    Verify representative grammars, native/static parity, publication, light/dark
    colors and legacy theme compatibility. This does not close responsiveness
    or remaining item 7 native-interaction acceptance.
    **Verified implementation:** The existing shared mapping now preserves
    `builtin`, `property`, `boolean`, `null`, `regexp`, `escape` and `metadata`.
    Editors and preview CSS Highlights reuse `TOKEN_COLOR_ROLES`: built-ins use
    `function`; properties/keys and regexes use `type`; booleans, null and
    metadata use `keyword`; escapes use `operator`. Neutral identifiers stay
    neutral. No grammar overrides, additional parsing, new theme colors,
    settings UI, dependencies or backend schema changes were introduced.
    All 12 representative regressions failed before the mapping change and pass
    afterward, with exact token offsets, native editor classes and nested
    Markdown coverage. All 186 affected syntax/publication/worker/search/theme
    tests pass. All 40 production four-surface correctness cases and all 16
    independent theme-state cases pass in Chromium/Firefox at widths 1543/390,
    including explicit new-category assertions, exact source, preview text-node
    identity, search/selection/scroll preservation and theme contrast checks.
    The combined browser run was interrupted by terminal reuse after 50 passes;
    the complete 16-case theme slice was then rerun independently and passed.
    Normal production build, frontend lint, docs-content validation and whitespace
    checks pass. Existing large-chunk build warning and two strict-indexing
    diagnostics on untouched nested-parser lines remain; the normal build passes.
    Published developer docs describe the shared mapping and grammar-dependent
    limitations. This is correctness evidence, not a new performance result or
    closure of unavailable native/physical-device checks.
  **Initial representative checks, not completion:** All 12 production probes passed in
  Chromium/Firefox at widths 1543/390 for 120-line code, a horizontally overflowing
  line and Markdown containing an inner JavaScript fence. Native cross-block
  selections retain the full code, and trusted keyboard copy/paste reproduces the
  exact selected payload in a temporary textarea. Keyboard Tab reaches the link;
  Select All includes the distant tail. Narrow Select All can include surrounding
  app text, so viewer-only selection scoping isn't certified. Native `window.find`
  selected/revealed the off-screen tail, but isn't the browser Find toolbar.
  These results predate the strengthened heading/navigation checks.
  **Initial failed output/navigation gates:** All six original Chromium PDFs contained only
  the scrolled viewport tail, omitting earlier prose/code. The repeatable PDF
  checker exits nonzero on all six and compares extracted output with the rendered
  document, not byte size or print-media DOM. Its 10 focused regression tests pass.
  Original hash-link activation had no matching heading ID in all 12 probes.
  The implementation and focused corrections are recorded under 5a/5b above;
  the original six-failure PDF report isn't a rerun of the corrected build.
  **Historical Find-proxy failure, corrected in 5c:** The earlier combined run
  had six Firefox passes and six Chromium failures solely at `window.find`
  reveal; all six PDF-content checks passed, but the aggregate correctly failed.
  A minimal 200px-high native scroller with a 2,000px spacer reproduced Chromium
  selection without scrolling after two frames; Firefox scrolled to 1,856px.
  The user's later successful Chrome native-Find check distinguishes actual
  browser behavior from this automated proxy. The corrected assertion policy and
  complete passing rerun are recorded under 5c, without manufacturing reveal.
  **Representative gate complete:** The user's manual completion confirmation
  in 5d supersedes the earlier open manual-testing status. Together with 5a-5c
  and 5e, this closes item 5. It doesn't establish broader item 7 acceptance,
  universal physical-printer/device guarantees or passing responsiveness.
  Rerun affected native checks after layout changes.
  Supplementary reports: `/tmp/sambee-native-constraints.json`
  (including PDFs) and `/tmp/sambee-native-pdf.json` (six explicit failures).
  Corrected print evidence: `/tmp/sambee-markdown-printing.json`,
  `/tmp/sambee-markdown-printing-pdf.json` and `/tmp/sambee-print-review/`.
- [ ] **6. Finish measured existing-path responsiveness.** Extend the existing
  production-viewer harness, not a new benchmark framework. Measure highlighting
  readiness, fresh/cached grammars, large prose/tables, scrolling, source typing
  and dense/long-line regex replacement. Exercise zero-length/case/word-boundary
  parity, startup/crash/decode failures, cancellation during delivery and large
  replacement output. Measure final atomic dispatch including parent updates
  (`sambee:source-search:commit`) and result memory. Measure edit serialization,
  normalization and parent updates before changing the remaining full-string
  callback. Optimize one measured owner at a time. If native layout or atomic
  commit cannot meet budgets within the architecture, present costs and obtain
  an approved specific policy. Never silently truncate, cap or partially apply
  replacements, or skip required work to pass a budget.
- [ ] **7. Close native interaction, editing and resource acceptance.** Verify
  cross-block copy, Select All, actual browser Find/reveal, keyboard/focus,
  screen-reader reading, hash links and real print/PDF output. Exercise
  image/font/width changes and rapid switching between distinct documents.
  Validate latest-edit Save, edits during Save, undo/redo, IME/table flush,
  preview/share/download, discard and recovery failures. Verify six warmed
  close/reopen cycles and zero owned DOM/highlights/live workers. Include testing
  on an available real phone and with assistive technology; narrow desktop viewports,
  semantic snapshots and print-media text are not substitutes. Save/recovery
  checks preserve existing contracts; they do not authorize redesign.
  A supplemental 4c close probe didn't establish closed viewer/root state after
  theme refresh. Its cause is unverified; close/navigation and full owned-resource
  release remain open here and aren't counted as passing 4c evidence.
- [ ] **8. Complete final acceptance and publish finalized contracts.** Run the
  unchanged relevant production matrix with explicit pass/fail, then close all
  gates or record approved policy decisions. Update published docs under
  `website/content/docs/` using docs-update. Run backend theme tests if that
  contract changes. A passing subset does not approve rollout. Stop when agreed
  gates pass; additional renderer/recovery work is not a prerequisite.

## Contracts And Acceptance Gates

- Preserve GFM, canonical table-cell line breaks, safe links/raw HTML, exact
  whitespace/UTF-16 offsets, native text/selection and scroll anchors. Prepared
  data remains engine-neutral. Keep AST-based code collection and the
  unchanged-content rendered-text search index.
- Keep caps of 4,000 viewport syntax ranges and 1,000 preview-search ranges plus
  one active search range. Missing highlight/visibility capabilities retain plain
  syntax or search counts/navigation, not per-match DOM mutation.
- Preserve acknowledged worker transfers: source/results at most 16,384 UTF-16
  units; syntax pages at most 512 ranges. Canonical-tree batches allow at most
  512 records and 16,384 string units, with fields split at 2,048. Preserve
  generation guards, timeout/crash/decode handling and cleanup. Source regex has
  a provisional 2,000 ms startup/per-response deadline and no synchronous fallback.
- Keep the provisional 100,000-UTF-16-unit per-block parsing safeguard and
  independent four-level Markdown nesting limit. Verify at/below/above the size
  boundary with worker/resource evidence; neither is an aggregate content cutoff
  or unlimited-size responsiveness claim.
- Keep eight syntax color roles. Absent legacy groups get central mode defaults
  without mutation/writes; supplied groups remain strictly validated.
- Preserve immutable snapshots/flush handles at Save, recovery, preview and draft
  export boundaries. Save acknowledges only its revision; newer edits stay dirty
  and recovery never marks a file saved. Snapshot/worker failure leaves live
  editing usable. Preserve best-effort synchronous recovery, debounce,
  pagehide/pre-sign-in attempts, limits and warnings.

Keep unchanged fixtures: 54,000 units/6,000 dense matches, a block near the
parsing safeguard, many eligible blocks exceeding 500,000 combined code units,
and a 6,000-match single line. Include large prose/tables and nested Markdown.
Use response interception, never stored demo edits. Do not shrink fixtures,
raise deadlines, truncate content or hide failures with development/production
comparisons. Change dependencies only for measured need and follow the repository
dependency workflow before changing pins/lockfiles.

Approved provisional development-host envelope, tested separately: 24,000 code
lines across four blocks, 4,000 short formatted paragraphs or 2,400 two-column
table rows. These are representative fixtures, not byte-size support guarantees.
Larger probes still expose scaling failures; retain that distinction.

| Metric | Approved Provisional Host Target |
| --- | --- |
| Text load through two frames | At most 1,500 ms |
| First exact search including worker/index startup | At most 1,000 ms |
| Warm changed query / last-match navigation | At most 100 ms each |
| Maximum timer-service gap | At most 50 ms; scheduling proxy only |
| Loaded Chromium renderer JS heap | At most 64 MiB; not total/peak memory |
| Six warmed explicit-GC shutdown cycles | At most 1 MiB growth; zero owned resources |

Also require actual input-to-visible-response p95 below 50 ms, no
application-controlled interaction-blocking task above 50 ms, and scrolling
within the approved refresh-rate budget below. Item 3 defines the additional
readiness and peak renderer/worker/native memory criteria; later items must
measure and enforce them.

## Item 3 Acceptance Decisions

The definitions below guide the next harness extension; they are not new passing
results. Readiness, memory and scrolling limits are approved provisional targets.
The Worker support decision below is approved and implemented. The approved
available-hardware policy replaces fixed reference-device profiles. Existing
targets above remain in force. Item 3 is complete as a definitions/support-policy
gate, not as readiness, resource or rollout acceptance.

### Readiness Boundaries

Use the existing browser-side file-open event as the common start, not the API
response, worker start or a Playwright round trip. Do not hold normalization or
syntax, pre-load grammars or warm away first use in readiness trials. Record
response-end, DOM commit, worker completion and publication as diagnostic
milestones without subtracting their costs from the end-to-end result.

| Measurement | Completion Boundary | Approved Provisional Limit |
| --- | --- | --- |
| First usable text | Exact expected rendered text is committed, loading no longer blocks the viewer, and selection/search controls are usable; observe two subsequent frames. Pair timing with successful selection and search assertions. | At most 1,500 ms from open; retain the existing text-load gate separately. |
| First visible syntax | Expected token categories and offsets cover the initial visible eligible code window, within the existing range cap; observe two subsequent frames. An arbitrary first nonempty highlight is insufficient. | At most 1,500 ms from open. |
| Full syntax preparation | Every requested block has settled to valid ranges or its expected plain-text outcome, the host has received all results, and the initial visible publication has reached two frames. Off-screen DOM highlights are not required. | At most 3,000 ms from open. |

Plain/unknown/oversized fences are expected neutral outcomes, not highlighted
successes. An injected failure can pass a functional fallback test but cannot
count as successful highlighting in a healthy timing trial. A fixture with no
eligible visible syntax reports that metric as not applicable and needs a
separate eligible fixture; missing measurements for eligible fixtures fail.
Frame callbacks remain scheduling proxies, not proof of hardware paint.

Keep three trials per fixture/width/engine and evaluate every required sample,
not only an average. Distinguish a fresh worker with cold browser module/cache
state, a fresh worker with warm browser cache, and repeated grammar use within
one worker job. A closed preview terminates its worker: reopening is not an
in-memory grammar-cache hit. Record the cache setup; do not add persistent
workers or a pool to manufacture a warm result.

### Measured Readiness Slice

The separate `production syntax readiness` slice reuses all four unchanged
publication fixtures, without holding normalization or syntax. Three trials per
fixture/engine/width produced 48 complete passing
reports, with approved readiness limits enforced individually. The many-block
fixture contains 600 blocks of 101 lines; every requested block must finish.
Existing timing targets remain unchanged.
The 26 evaluator tests cover exact targets, over-budget samples, missing/invalid
measurements and diagnostic runs, for both existing timing and readiness limits.

Each row below is the maximum across all six trials at widths 1543/390.

| Fixture | Engine | Maximum Usable Text | Maximum Visible Syntax | Maximum Full Preparation |
| --- | --- | --- | --- | --- |
| Dense | Chromium | 163 ms | 279.6 ms | 279.6 ms |
| Dense | Firefox | 215 ms | 395 ms | 395 ms |
| Near-safeguard | Chromium | 179.9 ms | 344.9 ms | 344.9 ms |
| Near-safeguard | Firefox | 246 ms | 447 ms | 447 ms |
| Many-blocks | Chromium | 412.7 ms | 898.8 ms | 898.8 ms |
| Many-blocks | Firefox | 635 ms | 1,378 ms | 1,378 ms |
| Long-line | Chromium | 182.3 ms | 313.9 ms | 314 ms |
| Long-line | Firefox | 180 ms | 313 ms | 313 ms |

The probe records file-open in the browser, checks exact text and enabled search
controls, and observes two frames. It verifies all five expected code categories
and UTF-16 coverage on each initial fully visible line, not merely a nonempty
registry. For long lines, expected coverage is clipped to fully visible characters
inside the horizontal viewport, rather than requiring off-screen tokens.
Native selection and exact search counts are checked afterward as
functional evidence, not included as measured hardware input latency. Probe
inspection/geometry costs remain in the measured intervals. Full preparation
includes receipt of all block results and initial visible syntax through two
frames. It nearly coincides with visible readiness because live syntax
publication waits for all results. The many-block first/all-block worker receipt
maxima are 430/813.8 ms Chromium and 676/1,303 ms Firefox. These are separately
observed maxima, not paired intervals or isolated parsing CPU. The publication
barrier still meets the approved readiness limit; these samples do not justify
an incremental path or certify off-screen syntax publication.

These earlier reports use fresh contexts/workers but routed assets, so they make
no cold/warm-cache acceptance claim. The separate real-HTTP run below closes that
specific gate without changing the running dev server.
Highlight cleanup passes,
but worker/memory/device acceptance and the previous timer-gap failures remain
open. Frontend lint, touched-file diagnostics and whitespace checks pass. No
application scheduling or publication behavior changed for this probe. This run
uses production assets containing the nested parser failure fix. Supplementary report:
`/tmp/sambee-syntax-readiness-four-fixtures.json`.

### Isolated HTTP Cache Readiness

The opt-in `SAMBEE_E2E_HTTP_CACHE=1` mode serves the production build and the
existing API fixtures through a test-only, loopback-bound HTTP proxy. Browser
navigation still uses `http://localhost:3000/browse/smb/demo`; no alternate
connection or real demo contents are used. Each test owns and closes its proxy
and browser context. Hashed build assets use `public, max-age=31536000, immutable`;
HTML and API responses use `no-store`. Service workers are blocked and Playwright
request routing isn't installed in these contexts.

The first open starts with an empty browser context and no grammar preloading.
After timing, exact selection/search and cleanup checks, the test closes the
viewer and requires zero live workers/highlights. A second measured open in the
same page creates a fresh syntax worker with the browser HTTP cache populated
only by the first measured open. Worker URLs and server request records are
attached: every cold sample fetches the worker and grammar assets, and every
cached sample makes zero JavaScript asset requests. Successful syntax preparation
in a new worker with no such requests distinguishes browser cache reuse from a
retained worker or unresolved preparation. The many-block fixture additionally
requires all 600 blocks to settle in one worker job.

All 48 paired tests pass without skips, retries or flaky outcomes: 96 reports,
three cold/cache pairs per fixture/width/engine. Every required measurement passes
its unchanged target; no averaging or diagnostic exemptions are used. Each row
below is the maximum across 24 samples covering all four fixtures and both widths.

| Engine | Cache Condition | Maximum Usable Text | Maximum Visible Syntax | Maximum Full Preparation |
| --- | --- | --- | --- | --- |
| Chromium | Cold | 414.4 ms | 896.3 ms | 896.3 ms |
| Chromium | Cached | 363.1 ms | 863.4 ms | 863.4 ms |
| Firefox | Cold | 634 ms | 1,361 ms | 1,361 ms |
| Firefox | Cached | 618 ms | 1,329 ms | 1,329 ms |

Environment: Debian 13 dev container, Linux WSL2 kernel
`6.18.33.2-microsoft-standard-WSL2`, Intel Core Ultra 9 285, 12 available logical
CPUs and approximately 31 GiB reported RAM. Engines: Chromium 156.0.8078.4 and
Firefox 157.0. Headless physical refresh rate and power mode are unverified.
These are available-host, local-HTTP measurements with the stated cache policy,
not a universal hardware/network guarantee or resource/native-input acceptance.
Supplementary report: `/tmp/sambee-syntax-readiness-http-cache.json`.

Fixture extraction also passes two direct transfer-stream request tests, including
headers/body and the existing special callback. An attempted older upload UI
regression test times out before sending a transfer: it expects the Upload button
to open a file chooser directly, but the current UI opens a Files/Folder menu.
That unrelated test mismatch is not repaired or counted as passing here.

### Resource And Device Boundaries

Retain the approved 64 MiB loaded Chromium renderer JS-heap ceiling and six
warmed explicit-GC shutdown cycles with at most 1 MiB growth and zero owned
resources. Measure those separately from timing, releasing harness references
before GC. A missing memory capability is unmeasured, not a pass.

For peak/resource acceptance, record the pre-open baseline, load/preparation,
typing/replacement, loaded state and post-close state. Report renderer JS heap,
worker JS heaps and process/native memory with their measurement method and
sampling cadence. Process totals can already include workers and JS heaps:
do not add them together or label renderer heap as total memory. Periodic samples
are observed maxima, not proven peaks; worker termination or GC cannot erase an
earlier high-water measurement.

| Resource Measurement | Approved Provisional Ceiling |
| --- | --- |
| Loaded Chromium renderer JS heap | 64 MiB, unchanged |
| Peak renderer JS heap | 128 MiB |
| Peak combined worker JS heaps | 64 MiB |
| Peak increase in aggregate renderer/worker private process memory over pre-open baseline | 256 MiB |

The aggregate process measurement includes JS heaps: these are independent
checks, not additive allowances. Include all processes owned by the measured
viewer; record the accounting method so shared processes aren't counted twice.
If reliable high-water measurements aren't available, label peak acceptance
unverified rather than passing it from sparse samples or post-GC values. A
measurement-tooling limitation doesn't silently waive a ceiling.

**Approved available-hardware policy:** use the existing automated host for
Chromium/Firefox at widths 1543/390, without prescribed device models or minimum
CPU/RAM requirements. Record OS, browser versions, available CPU/RAM and display
refresh information with the results; record power mode where available. If a
headless/container environment doesn't expose a physical refresh rate, say so
rather than treating animation callbacks as proof of a 60 Hz physical display.
Results support claims only for the recorded environment, not universal
hardware-performance guarantees.

Use any available real phone for item 7's manual interaction checks; no specific
model is required. Missing physical-phone or high-refresh coverage stays
explicitly unverified under item 7 and doesn't reopen item 3's definitions.
Desktop narrow viewports aren't physical-phone evidence. Test the actual native
refresh rate before claiming high-refresh support.

Approved provisional scrolling acceptance at 60 Hz is p95 frame interval at
most 16.7 ms and no application-attributed interval above 33.3 ms. At an actual
refresh rate R, one frame is 1,000/R ms; evaluate other refresh rates separately
against one-frame p95 and two-frame application-attributed intervals. Report
scrolling intervals and input-to-visible-response latency separately, with the
measurement method and its limitations. Keep the existing input p95 below 50 ms
and application-controlled blocking-task limit unchanged. Unavailable physical
paint/refresh measurements remain unverified, not automatic passes. Approval of
limits isn't evidence that the implementation meets them.

### Worker-Less Support Decision

**Approved decision:** browsers without Web Workers aren't supported. Reuse
the existing pre-app compatibility check rather than build a separate reduced
mode. The gate checks that Worker is callable, lists Web Workers among missing
capabilities and doesn't import the app when the check fails. No new fallback
editor, preview state or support-specific parsing path is needed.

Four bootstrap regressions cover absent/invalid Worker APIs and supported
startup; all 33 combined bootstrap/shared-highlighter tests pass. Development
browser probes at the approved demo URL confirm that absent Workers show the
compatibility reason without requesting the app entry, while supported startup
requests that entry and removes the compatibility screen. Lint, production build,
touched-file diagnostics, docs-content validation and whitespace checks pass.
The existing large-chunk build warning remains. These checks don't establish
worker execution or performance acceptance.

The normalization and syntax helpers retain their existing defensive main-thread
fallbacks, but they aren't reachable as a supported Worker-less app mode. Neither
a 100,000-unit guard, a yield between blocks nor a timeout bounds a synchronous
parse. API presence doesn't prove construction or execution succeeds: retain
existing worker startup/crash/timeout/decode-error handling and never silently
retry those failures synchronously. Save/recovery contracts remain unchanged.

## Verification

Run relevant slices after each bounded change. Use production Chromium/Firefox
at widths 1543/390 through `http://localhost:3000/browse/smb/demo` only. Final
timing acceptance uses three trials per fixture/width/engine; missing, invalid
or over-budget required samples fail. Existing report status covers a subset,
not all rollout criteria. Do not rerun an unchanged full matrix between every
small edit.

Commands run from `frontend/`:

```sh
npm run test -- src/__tests__/browserBootstrap.test.ts
npm run test -- src/utils/__tests__/markdownSyntax.test.tsx src/utils/__tests__/syntaxHighlighting.test.ts src/utils/__tests__/domTextSearch.test.ts
npm run lint
npm run build

# Evaluator boundaries and invalid samples.
npm run test:e2e -- viewer-performance-budgets.spec.ts --workers=1

# Functional language parity across actual application surfaces.
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production shared syntax correctness' --workers=1 --max-failures=1

# Worker failure injection, nesting safeguards, cancellation and recovery.
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production nested syntax failures' --workers=1 --max-failures=1

# Four-surface theme/late-grammar state and alpha-composited contrast acceptance.
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production shared syntax theme identity' --workers=1 --max-failures=1

# Unheld four-fixture readiness with approved limits enforced.
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-syntax-readiness-four-fixtures.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production syntax readiness' --workers=1 --repeat-each=3 --reporter=json

# Real HTTP cold/cache pairs, with a fresh worker for each measured open.
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-syntax-readiness-http-cache.json SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_HTTP_CACHE=1 npm run test:e2e:all -- --grep 'production syntax readiness' --workers=1 --repeat-each=3 --reporter=json

# Development normalization worker; uses the running approved demo server.
SAMBEE_E2E_DEVELOPMENT=1 npm run test:e2e:all -- --grep 'development Markdown worker' --workers=1 --max-failures=1

# Final unchanged production matrix with explicit timing enforcement.
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-highlighting-final.json SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1 --repeat-each=3 --reporter=json

# Focused functional source regex containment; not dense-replacement acceptance.
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production source regex containment' --workers=1

# Representative native selection/clipboard/focus and real PDF evidence.
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-native-constraints.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production native Markdown constraints' --workers=1 --reporter=json
```

The combined native slice passes with Chromium `window.find` reveal recorded as
diagnostic-only; exact selection remains required in both engines and Firefox
reveal remains enforced. Actual browser Find has separate manual evidence under
5d. Run the independent printing matrix from `frontend/`:

```sh
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-markdown-printing.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production Markdown printing' --workers=1 --reporter=json
```

From the repository root, inspect actual PDF text/image content separately.
Browser-probe passes alone don't establish complete output:

```sh
backend/.venv/bin/python -m scripts.check_native_markdown_pdf /tmp/sambee-native-constraints.json
backend/.venv/bin/python -m scripts.check_native_markdown_pdf /tmp/sambee-markdown-printing.json --printing
backend/.venv/bin/python -m pytest backend/tests/test_native_markdown_pdf_check.py
```

Keep `SAMBEE_E2E_MEMORY=1` Chromium controlled-GC runs separate from timing and
`SAMBEE_E2E_TRACE=1` diagnostic traces. Release harness-held node references
before GC. Timer gaps and frame callbacks are proxies, not hardware paint or
CPU attribution; worker elapsed times include transfers/scheduling. Trace CPU
samples must be counted once and Firefox attribution must use its content
process. Do not sum overlapping intervals or count diagnostic runs as acceptance.
