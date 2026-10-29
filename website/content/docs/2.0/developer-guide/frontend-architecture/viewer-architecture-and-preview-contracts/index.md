+++
title = "Viewer Architecture and Preview Contracts"
+++

Preview behavior in Sambee is a cross-boundary contract, not just a frontend component choice.

## The Core Contract

The browser app decides how to render a file based on metadata and file-type information, but that depends on server-side classification staying aligned.

Three rules matter most:

- the backend and frontend file-type registries must agree on image formats, conversion requirements, and MIME types used for dedicated viewers
- the backend decides whether an image format needs server-side conversion for browser compatibility
- the frontend chooses the right viewer component and file icon based on the effective file type and MIME information it receives

## Where the Main Decisions Live

| Path | Responsibility |
|---|---|
| `backend/app/utils/file_type_registry.py` | backend source of truth for extensions, MIME types, categories, and whether an image requires conversion |
| `frontend/src/utils/fileLanguages.ts` | shared CodeMirror language catalogue, filename matching, and additional plain-text extensions used by highlighting and default text opening |
| `frontend/src/utils/FileTypeRegistry.ts` | dedicated viewer mappings and MIME/presentation metadata; derives text-editor support from shared filename recognition |
| `frontend/src/components/Viewer/` | viewer components and shared viewer UI |
| `backend/app/services/image_converter.py` | server-side conversion for non-browser-native image formats |

## Viewer Selection Model

At a high level, the preview pipeline works like this:

1. the backend determines file category and MIME behavior
2. the backend decides whether the file can stream as-is or needs image conversion
3. the frontend maps the file type to the appropriate viewer component
4. the shared viewer controls keep the toolbar and common behavior consistent across viewers

Dedicated formats such as images require backend and frontend agreement. Text-file recognition instead uses `fileLanguages.ts`: both highlighting and default text opening consume the same CodeMirror catalogue. Language metadata doesn't load a grammar or import the highlighting core into the file browser.

Explicit image, PDF, and Markdown viewers take precedence over extension-based text recognition. A recognized, non-generic MIME type with a viewer mapping takes precedence over the filename; empty MIME types, `application/octet-stream`, and `text/plain` fall back to filename recognition. Saved viewer preferences override the default selection. Unknown files still use the viewer picker unless a MIME mapping or saved preference selects a viewer.

## Unified Text Editor

`TextEditor.tsx` owns the text destination and reuses `TextCodeEditor` for writable and read-only content. There isn't a separate text-viewer component or an Edit action. The public `viewer=text` identifier, viewer preferences, settings, and recovery-draft keys remain compatible. Text routes accept absent, `view`, and `edit` modes as the same destination; canonical URLs omit `mode` without adding a history entry or dropping fragments. Markdown still uses its existing preview/edit route modes.

Opening an eligible text file automatically calls `beginViewerTextEdit`. The editor stays read-only until acquisition succeeds and a fresh content read establishes the baseline. Archive members, read-only connections, and oversized files don't acquire sessions. Storage boundaries distinguish contention, denied permissions, unsupported editing, and temporary unavailability. SMB's acquisition request opts into a non-mutating per-file write probe; Companion also checks an existing file with read/write open and no creation or truncation.

Acquisition feedback appears after 200 ms as a small spinner beside the filename, in a fixed-size toolbar slot. Fast acquisitions show no progress message, and slower ones don't move the document. Completion, navigation, and unmount cancel pending feedback without delaying readiness. Access failures remain immediate; related error details and the read-only reason share one notice with Retry where supported.

Acquisition uses an activation generation to release obsolete results, and a pending release completes before another acquisition starts. Confirmed lock loss or revoked access freezes mutations and retains the draft; a transient heartbeat failure shows a warning. Retry is explicit, not an acquisition loop. A fresh baseline that differs from a retained draft's original baseline requires a conflict decision before editing resumes. Choosing the draft doesn't save it.

Text and Markdown saves pass `reacquireExpiredLock: false`; they must not silently reacquire an expired lock and overwrite a changed file. Save acknowledges only the captured revision, preserving newer edits as dirty. The routed leave guard protects dirty navigation and pending operations. Text Close goes directly to the file list after release, and Discard commits a clean state before navigation so the guard doesn't prompt twice.

Save from a valid active session can recreate a file deleted at the original path. It can also overwrite changes made at that path; it does not detect replacement files. Failed writes retain the draft. The dynamic host mounts one viewer, not a hidden candidate alongside the current document. Each viewer owns its load and error state; the image gallery reuses only its own local cache.

Read-only disables typing, Save, and Replace, not Find, selection, copying, wrapping, download, or sharing. Recovery is resolved before automatic activation. Keep regressions for late acquisition, Strict Mode, read-only and conflict states, history navigation, and Markdown's separate lifecycle when changing this shared path.

## Shared Viewer Notifications

`ViewerNotifications.tsx` reuses the application notification host, shared edit-lock message mapping, and delayed acquisition indicator for text and Markdown. There is no viewer-corner or pane-local toast host in the file browser. Markdown retains its preview/edit lifecycle, but uses the same lock/read-only notification, filename badge, explicit Retry action, and retained-draft conflict decision. Lock release completes before another acquisition starts; obsolete acquisition results are released without publishing errors.

Each viewer supplies active notices with stable IDs, severity, and operation occurrence numbers. One host displays one bottom-center toast across both panes and all viewer and page operations, prioritizing errors over warnings and information. Next notification exposes another pending condition. Dismissed heartbeat and draft-storage conditions stay dismissed until resolution or a changed condition. A new operation failure can notify again even when its message is unchanged. Resolved notices leave the active set, and source identities isolate dismissal state between files. Moving the host into a modal does not reset dismissal state.

All Text and Markdown editor toasts expire after 15 seconds, including informational lock notices, edit and save errors, print errors, heartbeat warnings, and draft-storage warnings. Hover or keyboard focus pauses expiry. Expiry hides only the notification; it does not clear the error, release a lock, discard a draft, or change the edit session. There is no additional inline warning after expiry. Existing editor controls and unsaved-change safeguards remain available. Toasts don't take focus or change document geometry. Recovery and unsaved-changes dialogs retain their own failure notices and suppress viewer toasts while open. Document-load failures, file-size limits, search validation, and editor-load/crash recovery remain in context rather than moving into the toast queue.

## Browser-Native Versus Server-Converted Images

Sambee supports both browser-native formats and formats that need server-side conversion.

- browser-native formats can be sent to the viewer directly
- non-browser-native image formats are converted on the server before the browser renders them
- special cases such as transparency preservation can change the output format choice

If you change conversion rules, you are changing a product contract, not just an implementation detail.

### Server-Side Conversion Contract

The conversion path is owned by `backend/app/services/image_converter.py` and is exercised through the viewer API.

The backend conversion service is responsible for:

- deciding whether an image needs processing
- converting unsupported or impractical browser formats into a viewer-safe output format
- preserving transparency where the output contract requires it
- applying optional downscaling so one preview request cannot explode memory usage casually
- returning enough metadata for the viewer endpoint to send the correct MIME type back to the browser

Representative service responsibilities include:

- `needs_processing(filename)`
- `convert_image_for_viewer(...)`
- `is_image_file(filename)`
- `get_image_info(...)`

The viewer endpoint then follows this rule:

- if the image can stream safely as-is, return a streaming response
- if it requires conversion, read it, convert it, and return the converted bytes with the converted MIME type

Physical streams read their first chunk before sending response headers. An initial read failure can therefore return a safe structured error. A later read failure terminates the stream and closes the backend; it cannot replace an already committed HTTP response with JSON. PDF derivative preparation reads its source before returning bytes, so a source failure during that buffered read can still use the structured error boundary. Native-download intent redemption uses the same prepared-stream boundary.

That means preview behavior for formats such as TIFF, HEIC, BMP, ICO, and similar formats depends on backend conversion policy, not just on frontend MIME recognition.

### Local-Drive Preview Policy

The Companion serves local-drive files and archive members as raw bytes. It does not copy local content to the backend for processing and does not bundle the backend image or PDF processing stack.

- Browser-native images, text files, and original PDFs can preview from their raw local bytes.
- Image formats that require server-side conversion, such as TIFF, HEIC, PSD, JPEG XL, and scientific image formats, show an explicit preview-unavailable state for local drives.
- Image resizing and PDF compatibility normalization are unavailable for local drives.
- Downloading and opening the original file locally remain available when a local preview is unavailable.

The frontend resolves these capabilities before making a local viewer request. Local archive-member requests use the Companion's strict raw-stream contract, while SMB archive-member requests retain the full conversion and PDF-normalization request parameters.

### Output Format Rules

The backend does not always convert everything to the same output type.

- JPEG is the common output for opaque images
- PNG remains important when transparency must be preserved
- ICO-like transparency handling is therefore different from ordinary opaque-photo conversion
- alpha-bearing formats converted to JPEG need explicit compositing behavior rather than silent accidental loss

If you change those rules, check both visual correctness and user-facing assumptions such as download behavior and gallery continuity.

### Current Format-Specific Preview Semantics

Several converted-image families have product-specific preview semantics that contributors should preserve unless the product intentionally changes.

- multi-page TIFF currently previews the first page rather than exposing a document-style page stack
- PSD and PSB preview the flattened composite instead of surfacing layer-edit semantics through the browser viewer
- EPS and AI are rasterized through the preprocessing path at high quality, currently using the 300 DPI rendering baseline
- HDR-oriented formats such as EXR and Radiance HDR are tone-mapped into ordinary browser-display output
- whole-slide formats such as SVS, NDPI, SCN, MRXS, VMS, VMU, and BIF preview as an overview or first practical pyramid level rather than as a full pathology viewer
- FITS and similar scientific-image formats apply visibility scaling so low-level pixel values become inspectable in a normal browser image surface

These are not accidental implementation details. They define what users should expect from preview and therefore belong to the product contract.

### Resizing and Resource Limits

Server-side conversion can consume significant memory because the file must be read, decoded, and re-encoded.

The current contract therefore includes:

- configurable JPEG-quality behavior
- maximum-dimension downscaling to avoid unbounded preview size
- backend-side protection against excessive memory usage from large source images

Contributors should treat those limits as operational safety controls, not as arbitrary defaults.

### Dependency and Environment Expectations

The conversion path depends on reviewed Python and system-image libraries.

That includes the normal image stack plus HEIC/HEIF support through the reviewed dependency chain and corresponding system libraries in the container or runtime image.

When conversion support seems to disappear unexpectedly, check:

- the backend Python dependency set
- the container or host system-image libraries
- whether the format-specific support was actually installed in the current environment

### Preprocessor Registry for Exotic Formats

Some formats need a preprocessing step before the normal conversion path can handle them at all.

That registry lives in:

- `backend/app/services/preprocessor.py`

It is consumed by:

- `backend/app/services/image_converter.py`

The preprocessor layer exists for formats that libvips should not or cannot decode directly for Sambee's preview contract.

Current registered formats route through the ImageMagick-backed preprocessor:

- `.psd`
- `.psb`
- `.eps`
- `.ai`

The registry is the single source of truth for which extensions require preprocessing before the final viewer-safe conversion step.

For the backend service architecture behind that path, continue to [Image Preprocessing and Conversion Pipeline](../../backend-architecture/image-preprocessing-and-conversion-pipeline/).

Representative registry operations include:

- `PreprocessorRegistry.requires_preprocessing(extension)`
- `PreprocessorRegistry.get_preprocessor_for_format(extension)`
- `PreprocessorRegistry.get_supported_formats()`
- `PreprocessorRegistry.register_format(extension, preprocessor_class)`

### Preprocessor Design Rules

The preprocessor layer has its own constraints:

- one registry entry per preprocessable extension
- direct in-memory conversion to the final browser-ready format rather than chained intermediate formats
- no shell-mediated fallback chain logic in the registry itself
- input validation and timeout enforcement happen in the preprocessor layer
- failures should surface as explicit preprocessing or conversion errors rather than silent format drift

The main abstraction is `PreprocessorInterface`, with `ImageMagickPreprocessor` as the current built-in implementation.

### Adding a New Preprocessed Format

If a new format cannot be handled by the normal conversion stack directly:

1. implement a `PreprocessorInterface` subclass if the existing preprocessor is not appropriate
2. register the extension in `PreprocessorRegistry`
3. add or update file-type metadata if the format becomes user-visible in preview flows
4. add tests for format recognition, tool availability, validation, and successful conversion

Do not treat preprocessable formats as ordinary file-type additions. They change the backend conversion pipeline itself.

### Error Surface Contributors Must Preserve

Conversion failures are user-visible API behavior, not internal-only exceptions.

Typical outcomes include:

- not implemented when the current environment lacks support for a format family
- unprocessable-content style failures when the file is corrupt or cannot be decoded
- ordinary backend failures when an unexpected exception escapes the conversion path

That means error wording, status behavior, and frontend fallback behavior should be reviewed together.

## Shared Viewer UI

The main viewer toolbar is intentionally centralized in `frontend/src/components/Viewer/ViewerControls.tsx`.

This is no longer just an image-and-PDF convenience component. It is the canonical control surface for the current full-screen image, PDF, and Markdown viewers.

- shared toolbar layout, styling, keyboard-tooltip behavior, and responsive behavior live in `ViewerControls`
- each viewer turns features on through configuration and passes only the state objects it needs
- future viewers should reuse that control shell where possible instead of creating another top-level toolbar implementation

### Control-Surface Model

`ViewerControls` uses a feature-flag configuration plus typed state objects.

The configuration currently enables these capability groups:

- `navigation` for gallery-style previous and next navigation
- `pageNavigation` for PDF page input and page stepping
- `zoom` for viewer-managed zoom actions
- `rotation` for image and PDF rotation actions
- `search` for the shared search row and match navigation affordances
- `download` for explicit download actions
- `share` for mobile-first share actions

The component then accepts matching state surfaces:

- `NavigationState` for item index, total items, and next or previous handlers
- `PageNavigationState` for current page, total pages, and page-change handling
- `ZoomState` for zoom-in and zoom-out handlers
- `RotationState` for rotate-left and rotate-right handlers
- `SearchState` for search text, match counts, search-panel state, open or close callbacks, and viewer-specific search navigation

That split matters because `ViewerControls` owns the common UI, but it does not own viewer logic. It renders controls and delegates behavior back to the viewer that actually knows how to navigate pages, zoom, rotate, or search.

### Current Consumers

The current shared-toolbar consumers are:

- `ImageViewer`, which enables gallery navigation, zoom, rotation, download, and optional mobile share
- `PDFViewer`, which enables page navigation, zoom, rotation, search, download, and optional mobile share
- `MarkdownViewer`, which reuses the same shell for download, optional mobile share, shared search UI, and viewer-specific action buttons such as editing flows

`ViewerControls` also supports generic toolbar actions through the `actions` prop, which can render either text buttons or icon buttons. That is what allows Markdown-specific actions to live inside the same shared toolbar instead of forcing a second toolbar implementation.

### PDF Loading And Password Cancellation

The PDF viewer keeps the document hidden and its controls disabled until the active page's canvas has rendered. The loading indicator and text appear only after 500 ms. A fast load shows neither. Each new document, retry, or compatibility attempt starts a new feedback delay. Readiness does not wait for text extraction or a minimum indicator display time.

Escape, Cancel, and the mobile back action in the password dialog cancel the current PDF load. Cancellation clears the password, unmounts the document to destroy its PDF.js loading task, releases its blob URL, and shows a notice with Retry. It does not submit an empty or null password, and it does not request compatibility processing. Downloading the original remains available through the viewer's existing download action. Only an explicit retry can start a new password request after cancellation.

Password callbacks belong to one load session. The viewer ignores callbacks from canceled or replaced sessions. An incorrect password can request another attempt within the same active session.

### Search UI Versus Search Engine

The search row is shared, but the search backend is viewer-specific.

- `PDFViewer` wires the search controls to PDF text extraction, page-aware match tracking, and PDF-specific next or previous navigation. Its text-layer markers use `frontend/src/utils/domTextSearch.ts`.
- Rendered Markdown uses a preview-owned session in `frontend/src/utils/viewportDomTextSearch.ts`. It reuses the DOM index and matcher from `domTextSearch.ts`, preserving rendered-text boundaries, cross-inline matches and exact code whitespace.
- Markdown edit mode doesn't reuse the rendered-view DOM search implementation. It bridges the same outer toolbar UI into the editor-specific search state and commands instead.

The Markdown preview separates logical matches from their presentation. It retains exact match positions and text-node mappings, but paints at most 1,000 viewport search ranges plus one active-match range through CSS Highlights. Search doesn't insert markers, split text nodes or replace preview content. Navigation resolves the destination directly from the index and scrolls the content viewport, including for off-screen matches.

Each preview generation owns its search session. Query changes reuse the unchanged DOM index; text replacement or character-data changes invalidate it. Syntax painting and theme-variable changes don't invalidate it. Scroll, resize, image loading and font readiness refresh presentation without matching the document again. Disposing the preview removes its highlights, style, observers, listeners, cached text and pending animation frame. PDF search remains independent.

DOM capture collects text chunks and joins them once, preserving numeric offsets and block separators without repeatedly flattening the growing source. Syntax publication separately caps its viewport ranges and clips horizontally overflowing unwrapped code to visible columns. Both search and syntax skip vertical character-range lookup when the owning text box is wholly inside the viewport; partially clipped boxes retain exact boundary lookup. Horizontal clipping is independent of that fast path: the left lookup can stop at the first character, and the right lookup reuses the exact left boundary as its lower bound. Disjoint horizontal clips produce no ranges. These optimizations don't estimate character widths or cache geometry. Nested code-block scrolling refreshes syntax and search ranges without changing the source or search index.

Search highlight colors inherit the preview's scoped theme variables. Browsers without CSS Highlights retain counts and indexed navigation without visual search highlighting; the viewer logs that limitation rather than falling back to whole-document marker insertion. Browser support and whole-viewer performance acceptance remain separate rollout gates. Cached indexing doesn't guarantee responsive capture or rendering for arbitrarily large documents.

Use the existing production-viewer check in `frontend/e2e/markdown-viewer.spec.ts` to attribute performance within the ReactMarkdown path. Its User Timing entries separate preview-search lookup, geometry, scrolling and publication from syntax mapping, geometry, range construction and publication. Geometry reads may force layout; registry calls can include native browser work, but don't necessarily include deferred painting. Worker round trips include transfer and acknowledgements, not just parsing. Source-response, DOM-commit-observer and frame milestones narrow initial-load costs without claiming isolated React CPU or hardware input-to-visible-paint latency. Functional passes don't establish the responsiveness budgets.

Initial-load Markdown normalization uses the shared helper in `frontend/src/utils/markdownCodePreparation.ts`. Documents of at most 4,096 UTF-16 units run the existing canonical normalizer directly, avoiding worker startup and transport for small notes. This bounded path returns the same canonical text and prepared MDAST; it doesn't skip normalization or change rendering. The size limit lives in the shared preparation protocol. Larger documents each own a preparation worker and transfer source, canonical text and an equivalent canonical MDAST in acknowledged, bounded chunks. Tree batches contain at most 512 records and 16,384 string UTF-16 units; individual field pieces are at most 2,048 units. Numeric/flag/position metadata is validated separately, and large text and table alignment fields use the chunk channel instead of content limits. Host acknowledgements yield between tree batches. Success, cancellation, decode failure and timeout terminate the worker; aborted loads can't publish content. Worker failures use the existing load-error path without a synchronous retry, and local preparation failures aren't reported as server overload. The pre-app capability gate requires a callable Web Worker API and otherwise shows the existing unsupported-browser screen without importing the app. The helper retains defensive synchronous normalization with a diagnostic for larger documents when workers are unavailable, but Worker-less app operation isn't supported. API presence doesn't guarantee successful worker construction or execution; existing startup, timeout, crash and decode-error handling remains necessary. The shared protocol is DOM-free. Vite's shared resolver aliases the character decoder to its non-DOM implementation before dependency optimization, so development and production workers use the same implementation. A worker-build-only resolver isn't sufficient for development's prebundled dependencies.

ReactMarkdown remains the only application whole-document renderer in every build mode. Its parser hook reuses a defensive clone of the prepared tree only when the tree matches the preview generation's exact source. All normal remark transforms, GFM, table-cell break handling, safe URL/raw HTML behavior and React rendering remain in that path. Cloning prevents those transforms from mutating the retained canonical tree. A successful Save that changes the source releases the superseded tree; edited content without a matching tree uses the normal parser.

Rendered Markdown sources of at least 50,000 UTF-16 units use `ProgressiveMarkdown` to append the existing pipeline's fully transformed output. Document-wide references, headings and GFM are resolved once before staging. Chunks aren't parsed as independent Markdown documents. Ordinary sources keep their immediate rendering path. Staged batches use the same ReactMarkdown rendering and safe-link/raw-HTML handling, with at most 1,024 structural nodes or 8,192 text units. Oversized tables, containers and code blocks are subdivided internally, preserving one native table or code block rather than splitting it into separate documents. Already-published nodes aren't replaced by later appends.

The viewer targets two viewport heights for the initial fill, then yields. Later frames use the 4 ms elapsed-work target without a height limit or repeated per-batch geometry reads. Each frame commits at most four batches, checking elapsed time after every commit to bound work accumulated before native layout. Neither the fill target nor these limits guarantee a maximum task duration: whole-document cloning/transforms, a single commit and native layout remain synchronous. Visible pages use animation frames; hidden pages use timers so completion doesn't wait indefinitely for a frame. Source or rendering-configuration changes and disposal cancel the old publication owner; a restarted generation resets document readiness. A 200 ms delayed, accessible loading indicator disappears immediately on completion and respects reduced motion.

Reading published text and closing the viewer remain available during progressive loading. Document search/counts, editing, heading-link navigation and toolbar printing wait for complete publication; syntax painting and DOM search indexing also wait. Browser-menu printing while loading shows a loading notice instead of partial document content. Once complete, normal native selection, search, links and print behavior apply. These controls prevent partial results from being presented as complete; they don't promise that synchronous preparation can never block input.

Markdown editing reuses the preparation worker for full-document canonical normalization when the editor source contains `<br`. The existing no-`<br` typing path still publishes immediately without normalization. If both the original baseline and edited document contain possible table syntax, a background preservation-only job compares their tables without changing that typing normalization policy. Identical sources or documents without a pipe character need no table comparison. Each editor owns at most one active job and one replaceable latest request. Only the current source, baseline, policy and generation can satisfy a prepared snapshot; obsolete success, failure and diagnostic messages are ignored. Worker acknowledgements never replace the native CodeMirror document, recreate table-cell editors or change transaction history. Pending table/IME publication and worker preparation keep the viewer dirty independently of canonical draft publication. External source changes and unmount dispose the old owner and its workers; a baseline change invalidates unmatched prepared bytes.

Toolbar Save takes focus before its click handler captures selection. The rich editor therefore remembers the active nested table cell on native focus entry and departure, and refreshes that snapshot when selection is explicitly preserved inside the editor. Stay-edit Save restores the same connected cell within the current root instead of focusing the root and triggering native table-widget reconstruction. If the cell document changed while Save was pending, restoration keeps its newer native selection rather than replaying old offsets. Returning to root-text editing, replacing the external document and unmounting clear the remembered cell; disconnected or replaced cells use the existing root-selection fallback. This doesn't change native transactions, history grouping or composition handling. Production checks require retained cell identity/focus after Save, continued typing, and native undo/redo; these functional checks don't establish responsiveness acceptance.

Async snapshot capture flushes table/IME publication and worker preparation within the existing transition deadline. It requires full-document normalization even after the typing fast path, so Save retains list, escape and table canonicalization. The same worker performs the unchanged AST-aware table comparison against the exact original baseline, preserving original source for semantically unchanged tables. Source and baseline transfer sequentially in acknowledged chunks of at most 16,384 UTF-16 units, with generation and sequence validation; result chunks retain the same bound. Edit preparation doesn't request a preview tree, whose offsets would no longer match preserved source. Save consumes immutable, complete source-preserving snapshot bytes; repeated serialization returns the captured string without parsing. A successful write acknowledges only its snapshot: newer pending edits stay dirty, and an unavailable newer snapshot doesn't turn the completed write into a failure. Worker failure preserves editing and dirty content; a subsequent explicit async snapshot request can retry, but failures never trigger a synchronous parsing fallback or an automatic retry loop.

Synchronous snapshot capture and canonical getters reject pending or failed worker preparation, including an unmatched source-preservation baseline, rather than returning an older revision as current. Recovery retains its synchronous pagehide/pre-sign-in attempts, debounce and limits; failed capture logs the failure and shows the existing recovery warning. It doesn't mark content saved. Native text sharing is unavailable while publication is pending and reads a complete snapshot when ready. Worker-side normalization and source preservation don't establish whole-viewer timing or resource acceptance; native table editing, layout and preview reconstruction remain separately measured costs.

The bounded `sambee:edit-preparation:*` entries separate queue wait, worker startup/first acknowledgement, source and baseline transfers, run-to-first-result, result delivery, total transport/job time and complete async snapshot flush. Numeric metadata records generation, source/baseline lengths, policy, chunk counts and whether a completed job is current or obsolete; it contains no source text. Transport completion also reports worker normalization and source-preservation durations separately. Host intervals include event-loop scheduling and acknowledgement delays, so startup isn't isolated worker boot time and transfer isn't pure wire time. Worker durations aren't main-thread CPU, and nested intervals mustn't be added to their enclosing job or snapshot flush. Each stage retains only its latest entry; the existing test observer collects individual samples. Use these measurements to distinguish Save wait from the native table/focus work that can follow write acknowledgement, not to infer a faster Save or passing keyboard/paint budgets from worker offload alone.

The bounded `sambee:preview-preparation:*` entries separate asynchronous decode elapsed time, load normalization, tree cloning, code-block collection and ReactMarkdown transforms. For worker-backed loads, `load-normalization-elapsed` includes worker startup, transfer, work, host tree assembly, acknowledgements and scheduling, not main-thread CPU time. For small notes, it measures direct canonical normalization and prepared-tree creation. `render-prepared-tree` measures the defensive clone; `render-parse` measures normal parsing when no matching tree is available. The initial-load production matrix requires the clone stage and rejects synchronous `render-parse` and standalone `collection-parse` stages. Live syntax request collection walks the renderer's existing tree; it doesn't parse source again or change markup. The `collection-walk` interval is included in `render-transform`, not additional time to sum. Each generation publishes its ordered requests after DOM commit, before the passive syntax preparation effect, which snapshots them and retains cancellation and stale-generation guards.

The HAST-ready-to-layout-effect interval includes element construction, reconciliation, commit and scheduling, not just React CPU or paint. Entries contain no source text; each stage retains its latest measurement while the browser test observer collects individual samples. Normalization reuses its parsed tree when canonicalization leaves the source unchanged and reparses in the same preparation path when edits change source offsets. Tree reuse doesn't close responsiveness, retained-memory, syntax-completion or native interaction acceptance.

That separation is an important contract: contributors should reuse the shared search UI when possible, but should not assume every viewer can use the same search implementation under the hood.

### Single-Renderer Acceptance

The retained whole-document viewer integration and its special build-mode selection have been removed. Don't reconnect the historical publisher or add a second renderer to finish shared highlighting. Reuse ReactMarkdown, its parsed-tree code collection, the existing workers and viewport CSS highlights. Standalone renderer proofs are historical research, not application acceptance or a delivery dependency.

Run `npm run build`, then `SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1 --repeat-each=3` from `frontend/`. The existing matrix uses the approved demo connection and unchanged dense, near-safeguard, host-envelope, many-block and long-line fixtures in Chromium and Firefox at desktop and narrow widths. Add `PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-reactmarkdown-baseline.json` and `--reporter=json` to retain structured reports without npm's console preamble. Each fixture attaches `viewer-timing-budgets.json`, with observed values, numeric targets, pass/fail results and criteria that remain unmeasured.

The timing gate evaluates file-click-to-text-completion, first exact search, changed query, last-match navigation and maximum viewer timer-service gap. Missing, non-finite or negative samples fail every run; `SAMBEE_E2E_BUDGETS=1` also fails over-budget samples. Omit that flag for functional-only runs, which still attach the budget result. Forced-GC and tracing runs are marked diagnostic and can't enforce timing acceptance. Run `npm run test -- src/utils/__tests__/viewerPerformanceBudgets.test.ts` from `frontend/` for the evaluator's boundary and error tests. These browser-independent checks also run in the normal Vitest CI suite, without repeating them for each browser project. To validate a recorded report, the existing Playwright entry point remains available: `SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_REPORT=/tmp/report.json SAMBEE_E2E_SLICE=publication npm run test:e2e -- viewer-performance-budgets.spec.ts --workers=1`.

Search/query/navigation probes start in browser event handlers, observe the expected count and active highlight in the existing small search controls, and finish after two frames. They avoid page-wide text queries and Playwright round-trip timing, but aren't hardware input-to-visible-paint measurements. The existing active-search fixture deliberately holds syntax preparation; text-load completion doesn't include syntax. Fresh/cached grammar isolation, first usable text/highlight completion, source editing, large prose/tables, resource acceptance and native interaction still require their own evidence. A passing timing subset isn't full rollout acceptance.

The browser checks compare exact rendered text, native Select All, selected code text and accessibility-tree output. They also exercise keyboard focus, safe links/HTML, GFM tables/tasks, shared Find navigation, theme-variable updates without text-node replacement, native copy events and Chromium PDF generation. These don't establish OS clipboard payloads, browser-native Find reveal, assistive-technology behavior or visual full-document print/PDF correctness. Those remain manual gates.

The separate native-constraint slice checks representative multiline, long-line and nested Markdown at widths 1543/390 in Chromium/Firefox. It compares cross-block selected text with a trusted keyboard copy/paste payload, exercises keyboard focus and native `window.find` selection/reveal, and attaches real Chromium PDFs. The native text-find API isn't the browser Find toolbar, and a narrow desktop viewport isn't a physical phone. From `frontend/`, after a normal production build, run:

```sh
PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-native-constraints.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production native Markdown constraints' --workers=1 --reporter=json
```

From the repository root, check the attached PDF text with the existing backend environment:

```sh
backend/.venv/bin/python -m scripts.check_native_markdown_pdf /tmp/sambee-native-constraints.json
```

The checker rejects missing/duplicate PDF cases, unsuccessful browser results and missing rendered-document lines. Heading IDs use a safe prefix and standard duplicate/Unicode slugging in the existing HAST pipeline; matching fragments are rewritten consistently. Native and printing matrices have independent checks. Chromium's `window.find` reveal is diagnostic-only because it can select without scrolling even outside Sambee; exact selection remains required in both engines, and Firefox reveal remains enforced. Don't add application scrolling to manufacture a native Find pass.

The Markdown preview's Print icon calls the native browser print dialog; Save as PDF is a destination in that dialog, not a second renderer or server-side conversion. Print isn't offered in edit mode or enabled while loading has failed or is incomplete. Print-only styles hide controls/background UI, release fullscreen/scroll constraints, wrap code/table cells, retain images and use black text on white regardless of the screen theme. Native `beforeprint`/`afterprint` handlers preserve focus, selection and nested scroll, with pending callbacks removed on disposal. The fullscreen paper sizes against its fixed container rather than dynamic viewport units that can retain print-page dimensions.

Run the independent print matrix from `frontend/`, then inspect the PDF attachments from the repository root:

```sh
PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-markdown-printing.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production Markdown printing' --workers=1 --reporter=json
```

```sh
backend/.venv/bin/python -m scripts.check_native_markdown_pdf /tmp/sambee-markdown-printing.json --printing
```

The 24-case matrix covers three fixtures, both themes, both widths and both engines. It verifies action invocation, print CSS, wrapping/widths and actual Chromium PDF state restoration. The PDF gate requires all 12 Chromium outputs to contain every rendered non-whitespace text line and an embedded image. Clear any forced screen-media override before PDF generation; otherwise Playwright prints screen CSS. First/last-page raster inspection supplements text checks. Firefox CSS checks aren't actual Firefox PDF evidence. Actual Firefox PDF and desktop/physical printing were separately confirmed complete by the user on 2026-10-24; no detailed browser/printer support matrix is inferred. Browser destination, paper, margin and header/footer settings remain user-controlled.

Keep performance changes local to measured costs in the current path. Distinguish first visible syntax from completion of all block preparation, and include serialization and parent updates when measuring typing or atomic replace-all. Configuration-only theme and grammar updates must not request caret reveal or replace the document, selection or editor. Don't add streaming, scheduling abstractions or new edit protocols without evidence that the existing path misses its target.

The existing viewer harness also has a `production source responsiveness` slice for the 54,000-unit dense and 6,000-match long-line source fixtures. It verifies bounded worker delivery, one atomic replacement, undo/redo, exact saved file bytes and worker termination. Save assertions decode the complete multipart body received by the isolated test HTTP proxy; Playwright's request snapshot can omit uploaded file bytes. All traffic uses fixtures, never stored demo edits.

Large Replace All operations may temporarily block the editor while CodeMirror applies their atomic change set. This latency is an accepted limitation under D5, not permission to truncate output, split history or replace the entire document instead of preserving logical changes. Text and Markdown editors share an editor-owned indeterminate replacement indicator. Worker preparation shows it only after 200 ms; completion before that threshold cancels it without a flash. Ordinary literal replacements stay synchronous and aren't given an artificial delay.

Before a known-heavy apply, the indicator is shown and given two animation-frame callbacks so the browser has a paint opportunity before the native dispatch. The conservative workload gate requires at least 1,000 replacements and at least 50,000 UTF-16 units in the source or inserted payload. Literal commands inspect at most 1,000 matches for this estimate; worker commands use the completed change plan. This isn't a duration prediction: some fast workloads may be classified as heavy, and unexpectedly slow synchronous work cannot reveal a delayed indicator while blocking the main thread. Feedback already visible during preparation also receives a paint opportunity before application. There's no minimum visible duration or delayed completion, and the spinner doesn't promise continued animation or input responsiveness during synchronous apply.

The same command boundary covers toolbar and keyboard Replace All. Pending replacements reject duplicate invocations. Any introduced yield revalidates the exact document, query, selection and writability; editing or switching state cancels obsolete work rather than applying stale replacements. Failure, timeout, cancellation and editor disposal release the indicator, animation, timers and listeners. Hidden documents don't wait indefinitely for throttled animation frames. The status uses the editor theme, exposes accessible busy/status semantics and respects reduced motion; physical assistive-technology behavior remains a separate manual check.

The `production replacement feedback` slice checks quick no-flash behavior and captures visible feedback with the original source still present, then releases held frames and verifies atomic undo/redo, exact multipart Save and editor cleanup in both engines at widths 1543/390. Its held-frame evidence is functional, not timing acceptance.

Source edits retain one bounded User Timing entry per stage: `sambee:source-editor:serialize`, `sambee:source-editor:publish`, `sambee:source-editor:normalize` and `sambee:source-editor:parent-update`. The enclosing publication includes normalization and the synchronous parent callback. These overlapping stages mustn't be added together. Entries contain lengths/revisions, not document contents. `sambee:source-search:commit` brackets the native atomic dispatch, including its synchronous listeners; deferred React work isn't isolated CPU time inside that measure. The separate click-to-completion probe waits for the parent dirty-state render and two subsequent frames. That boundary is a scheduling proxy, not hardware paint.

From `frontend/`, after a normal production build, run:

```sh
PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-source-responsiveness.json SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production source responsiveness' --workers=1 --repeat-each=3 --reporter=json
```

Each sample attaches source-private measurements and explicit 50 ms atomic-dispatch, enclosing serialization/publication and maximum-timer-gap checks. Missing or invalid evidence fails even without `SAMBEE_E2E_BUDGETS`; that flag additionally enforces the original limits. Retain the failed native atomic-application timing results as diagnostic evidence of the D5 accepted limitation, not as passing samples or a reason to repeat performance-only matrices. Unrelated source timing, worker correctness and resource gates remain required. Transfer counts aren't retained/peak memory evidence, and these fixtures don't establish sustained typing, large-table normalization, dense output expansion or scrolling acceptance.

The separate `production source typing` slice types 82 characters at a requested 10 ms inter-key delay into each 54,000-unit fixture, without per-key polling. It records trusted browser keydown-to-first/two-frame samples, timer gaps, all four edit stages and optional whole-renderer Long Tasks entries, then verifies exact saved source plus the payload. The `source-typing` attachment enforces two-frame p95 strictly below 50 ms and stage/gap maxima at most 50 ms. All 24 engine/width/repeat trials pass; the worst per-trial p95 is 35 ms. This is a scheduling proxy, not physical input-to-painted-pixel acceptance. Unsupported Long Tasks capability stays unmeasured, and observed tasks wouldn't establish application-owned CPU attribution.

The `production prose table responsiveness` slice mounts the approved 4,000 formatted paragraphs or 2,400 two-column table rows. It checks every rendered paragraph/cell exactly, preserves native block whitespace, root/text-node identity and full rendered text through 60 programmatic scroll steps, and verifies cross-block native selection and close cleanup. Load timing runs from the browser's file-open click through two frames after all expected blocks mount. The `prose-table-responsiveness` attachment separates load budgets, the earlier two-viewport geometry milestone and diagnostic rAF scroll intervals, including the frame following the final scroll assignment. The final 24 trials complete within 1,110 ms, with the first viewport available within 761 ms. Nineteen trials exceed the unchanged 50 ms timer-gap limit, with a worst gap of 128 ms. These recorded loading pauses are accepted under D6, not passing timing samples or isolated CPU attribution. Headless rAF intervals don't establish physical refresh rate, wheel/touch, compositor or painted-frame acceptance. These fixtures have no fenced syntax and don't measure syntax readiness or large-table source normalization.

The separate `production progressive Markdown loading cancellation` slice holds frame callbacks after two viewport heights exist. It requires visible feedback, disabled document controls, loading-only print output and a working Close action, then releases stale callbacks and verifies complete reopening. It runs in Chromium and Firefox at widths 1543/390. Its paused screenshots and functional passes aren't timing evidence. The existing large-code publication, native interaction and print matrices remain independent regression checks; their completion and acceptance boundaries are recorded below.

Run these slices separately from forced GC and CPU profiling:

```sh
PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-source-typing.json SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production source typing' --workers=1 --repeat-each=3 --reporter=json
PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-prose-table-responsiveness-final.json SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production prose table responsiveness' --workers=1 --repeat-each=3 --reporter=json
```

For separate Chromium load attribution, select the same prose/table slice with `SAMBEE_E2E_TRACE=1` and no budget enforcement or forced GC. The `viewer-load-cpu-profile` and `viewer-load-timeline` attachments span file open through completed mounting; nonempty CPU samples and both `sambee:viewer-load:start`/`sambee:viewer-load:complete` timeline markers are required. Budget status is diagnostic, never acceptance. Two desktop captures show one preview build, with a 126.05 ms prose render callback and a 53.69 ms table callback before native style/layout. The prose clone, transforms and HAST-to-layout-effect stages take 38.3, 37.5 and 44.5 ms; these overlap the encompassing callback and mustn't be added to it. Prose native style/layout takes a further 21.14/38.13 ms. Keep cached-tree isolation and native document semantics; neither deleting the clone nor an unapproved publication/renderer change is justified by this evidence. Firefox/mobile CPU attribution remains unverified.

Chromium CPU sample deltas can be negative. Reconstruct cumulative sample timestamps, sort them, then clip nonoverlapping intervals to the load markers. Summing only positive deltas inflates CPU weights. Use the marker's renderer PID/thread for main-thread timeline attribution; worker processing and unclassified native samples aren't automatically application-owned blocking CPU.

Repeated source-regex Next/Previous requests are queued in order while navigation is pending. The active navigation worker reuses its transferred document for that burst, applying each native CodeMirror command from the preceding result's selection with the current position's whole-word rules. It terminates when the queue drains; no idle worker is retained. Document/query changes, external selection changes, replacement commands, failures and disposal cancel obsolete queued navigation. Unit tests compare reused-worker navigation with native commands, including mixed directions, wraparound, overlapping matches and zero-length expressions.

The independent `production source regex parity` slice compares counts and exact saved output with the installed CodeMirror commands for zero-length lookahead, case-sensitive and whole-word matching. A replacement exceeding two source-transfer chunks verifies continuation assembly without truncation. `production source regex lifecycle` injects worker-construction, error/decode-event and startup-timeout failures, requires actionable feedback and a successful retry, and preserves continued editing and exact Save bytes. A partial-delivery case lets one replacement chunk arrive before cancellation, then replays stale change/completion messages; no partial replacement may be committed. These are host-side fault injections, not actual browser-process crash or structured-clone failure evidence. Run both functional slices with:

```sh
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production source regex (parity|lifecycle)' --workers=1
```

For optional source renderer footprint diagnostics, use `SAMBEE_E2E_MEMORY=1` without timing enforcement, select `production source responsiveness`, and run the Chromium-only `npm run test:e2e`. The `source-renderer-memory` attachment records CDP renderer heap after explicit GC at pre-open, counted-results, post-replacement and post-close boundaries. Its historical 64 MiB assertion isn't a release criterion under D11. These are whole-viewer post-GC observations, not isolated result-array bytes, peak/worker/native memory or proof of leak-free cleanup. Staged/peak-memory limits and a fixed close/reopen cycle protocol aren't required. The source budget status is diagnostic in memory mode.

For a separate Chromium CPU diagnostic, use `SAMBEE_E2E_TRACE=1` without `SAMBEE_E2E_BUDGETS=1`, restrict the grep to `production source responsiveness long-line at 1543px`, and run `npm run test:e2e`. The `source-dispatch-cpu-profile` attachment contains the CDP CPU profile; its source budget status is diagnostic, never an acceptance pass. The source slice rejects combined profiling/GC and either diagnostic mode combined with timing enforcement.

For separate controlled-memory trials, add `SAMBEE_E2E_MEMORY=1` and restrict the existing matrix to the many-block fixture and Chromium. Release harness-held node references before post-GC sampling. Renderer heap excludes worker heaps and aggregate/native memory; a single close isn't repeated-close leak acceptance. Keep forced GC separate from responsiveness timing.

For diagnostic scheduling traces, add `SAMBEE_E2E_TRACE=1` to a single-fixture Chromium run. The `viewer-scheduling-trace` attachment contains a CDP timeline and V8 CPU profile. Align `sambee:viewer-trace:start` with browser timestamps; join CPU chunks by renderer PID and profile ID and count samples once. Firefox native profiling must use content-process User Timing markers rather than parent-only samples. Profiling adds overhead and isn't acceptance timing.

To isolate native table input from application work, run the existing proof from `frontend/`:

```sh
SAMBEE_NATIVE_TABLE_REPORT=/tmp/sambee-native-table node scripts/source-search-containment-proof.mjs --native-table
```

This uses public CodeMirror/Lezer and `markdownTables` APIs at the approved demo URL, with an isolated HTML response and default package styling. It edits the middle cell of the fixed 2,400-row table at 1543x900 without React, application CSS, normalization, Save or workers. It requires exact complete native source, atomic full-table replacement spans, native undo/redo and disposal. Native table source uses `<br>`; application canonicalization to `<br />` isn't part of this proof. Root state materialization and view-update intervals are reported separately; input-to-root includes scheduling and deferred publication, not just model CPU. The unminified desktop diagnostic isn't a production acceptance trial or a replacement for mobile, composition and lifecycle checks.

The optional report prefix writes per-engine JSON and the exact diagnostic bundle. For separate profiling, add `SAMBEE_E2E_TRACE=1` and configure `MOZ_PROFILER_STARTUP=1`, `MOZ_PROFILER_STARTUP_FILTERS=GeckoMain`, `MOZ_PROFILER_STARTUP_FEATURES=js,stackwalk,leaf` and `MOZ_PROFILER_SHUTDOWN` with an absolute output path. Chromium records input-only CPU samples; clip Firefox content-process samples between `sambee:native-table:input-start` and `sambee:native-table:input-end`, excluding construction and history checks. Profiling requires a report prefix and Firefox startup configuration; product-budget enforcement and controlled-GC modes are rejected. Inclusive model, parsing and native reflow samples overlap and mustn't be summed. Unclassified Chromium native samples aren't automatically package JavaScript CPU. Slow native input doesn't by itself establish slow atomic state application or justify private package patches, changed history, wrapping or selection semantics.

Count assertions remain scoped to the existing search controls to avoid page-wide Playwright text caches inside measurement windows. Results are labelled `scoped-controls-v2`; older input figures aren't directly comparable. Handler-to-frame samples and synthetic event age don't establish hardware input-to-visible-paint latency. Removing the alternate renderer doesn't close any performance, memory or manual interaction gate.

### Shared Highlighting Acceptance And Limitations

The shared-highlighting implementation was approved by the user for merge and rollout on 2026-10-24. Approval doesn't turn failed measurements into passes or establish support for untested devices. Keep original targets, raw verdicts and these scoped acceptance decisions together:

| Decision | Accepted scope | Boundaries |
|---|---|---|
| D5 | Noticeable large atomic Replace All latency with visible busy feedback. | Preserve complete output, logical change mapping, one native transaction and undo/redo. Unrelated source-search or typing pauses aren't accepted by this decision. |
| D6 | The recorded progressive prose/table preview-loading pauses: 19/24 trials above 50 ms, worst 128 ms; all complete within 1,110 ms. | These remain failed gap samples. Longer future delays and other workloads aren't covered. Asynchronous preview preparation remains declined. |
| D8 | Responsiveness limitations of the existing Markdown table editor. | Table-component timing is diagnostic and non-blocking; exact input, Save, composition, history and cleanup remain required. |
| D9 | Ten recorded Firefox many-block syntax-color samples at 1,511-1,579 ms against the 1,500 ms target. | All 120 cold/warm samples were collected; 110 meet that target. Full syntax preparation stays within 3,000 ms. No broader delay exception is implied. |
| D10 | Four recorded Firefox desktop code-display gaps at 51-59 ms against 50 ms. | Preserve the raw failures. Additional delayed-image/font/resize and scroll-anchor test coverage was removed, not passed. Correct content, selection and scrolling remain required. |
| D11 | Leak investigation and fixes for demonstrated unwanted retention, rather than quantitative memory acceptance. | Staged/peak-memory limits and fixed-cycle shutdown checks were removed, not passed. No exhaustive leak-free claim is made. |
| D12 | Removal of real-phone and physical keyboard/IME acceptance, including phone print UI and hardware-response measurements. | This isn't verified device support. Automated keyboard/composition, exact editing/Save/recovery and desktop native/print correctness remain required. |

Browser-menu Find/reveal, OS clipboard, assistive-technology and physical-scrolling checks were confirmed complete by the user on 2026-10-23. Remaining Firefox PDF and desktop/physical printing checks were confirmed complete on 2026-10-24. These are user confirmations, not new automated measurements or a detailed device, browser, AT or printer support matrix. Don't reopen completed checks or rerun accepted timing failures solely to close a checklist; retest affected behavior after a relevant change or demonstrated regression.

The final editing checks cover theme changes followed by editing exit and Close, late worker results, distinct documents, captured-revision Save with newer dirty edits, failed writes and recovery/snapshot failures. Source-regex terminal cleanup detaches worker handlers, releases terminated workers and clears obsolete replacement buffers, while retaining buffers needed for a pending atomic apply. Ownership review and lifecycle assertions establish the investigated cleanup, not a heap-retention proof for every browser object.

Use `PLAYWRIGHT_JSON_OUTPUT_FILE`, not `PLAYWRIGHT_JSON_OUTPUT_NAME`, for an explicit report path with the JSON reporter. Preserve complete identities, both engines, widths 1543/390, original workloads and three trials per timing identity. Recorded-report evaluation must retain failed samples and reject missing, duplicate, invalid, skipped or retried identities. Functional-only runs and tracing/GC diagnostics don't establish timing passes. Retain local reports before temporary-file cleanup; overlapping runs aren't additive test totals.

### Responsive and Accessibility Rules

The centralized toolbar also encodes product behavior that should stay consistent across viewers.

- filename display, optional filename adornments, and close behavior are shared
- mobile layout uses safe-area-aware spacing and smaller controls
- gallery arrows and desktop zoom controls are intentionally reduced on mobile, where gesture-based interaction is preferred
- share is exposed as a mobile-first affordance, with optional early-intent warming through `onShareIntent`
- buttons use explicit `aria-label` values and shortcut-oriented `title` text so the control surface remains navigable and self-describing
- the shared search row manages focus when it opens and preserves consistent close behavior for toggle and Escape-driven exits

### Legacy Components and Contributor Guidance

Legacy `ImageControls.tsx` and `PDFControls.tsx` files still exist in the frontend tree, but `ViewerControls` is the current architectural direction and the shared component used by the active image, PDF, and Markdown viewers.

If you add another viewer or extend an existing one:

- prefer extending `ViewerControlsConfig`, the relevant state interfaces, or the generic `actions` surface
- keep viewer-specific logic in the viewer component rather than teaching `ViewerControls` about file-format internals
- preserve shared mobile, accessibility, and search-panel behavior unless the product intentionally changes that contract
- add or update focused tests in `frontend/src/components/Viewer/__tests__/ViewerControls.test.tsx` when the shared toolbar contract changes

## Adding a New File Type Safely

File-type support is registry-driven. Dedicated formats need a coordinated backend/frontend contract update. Languages already present in the shared CodeMirror catalogue need no separate extension registration for text opening; extra frontend entries are only needed for MIME or presentation metadata.

### Main Files to Change

| Path | Why it changes |
|---|---|
| `backend/app/utils/file_type_registry.py` | declare extensions, MIME types, category, description, and whether an image requires conversion |
| `frontend/src/utils/fileLanguages.ts` | reuse shared language filename matching; maintain additional plain-text extensions here rather than duplicating language extensions |
| `frontend/src/utils/FileTypeRegistry.ts` | declare dedicated viewers and optional MIME/presentation metadata; text-viewer assignments are derived automatically |
| `frontend/src/components/Viewer/` | add or reuse a viewer component when the type needs a dedicated preview surface |

If a file type is user-visible, update the published support docs that describe what Sambee can preview.

### Quick Start for a New Image Format

For an image format such as JPEG XL, the minimum workflow is:

1. add a `FileTypeDefinition` entry to the backend registry
2. add the matching entry to the frontend registry
3. decide whether the image is browser-native or requires server-side conversion
4. keep extensions and MIME types identical across both registries
5. run the viewer and backend validation checks

Backend example:

```python
FileTypeDefinition(
		extensions=(".jxl",),
		mime_types=("image/jxl",),
		category=FileCategory.IMAGE,
		requires_conversion=True,
		description="JPEG XL Image",
)
```

Frontend example:

```typescript
{
	extensions: [".jxl"],
	mimeTypes: ["image/jxl"],
	category: "image",
	viewerComponent: () => import("../components/Viewer/ImageViewer"),
	icon: "image",
	color: "#a855f7",
	description: "JPEG XL Image",
}
```

That registry update is what drives MIME matching, icon treatment, viewer routing, and image-gallery inclusion.

### Backend Registry Rules

Backend file-type definitions must stay explicit and type-safe.

- `extensions` are tuples with a leading dot, such as `(".jpg", ".jpeg")`
- `mime_types` are tuples of standard MIME strings
- `category` uses `FileCategory` values such as `IMAGE`, `DOCUMENT`, `TEXT`, `VIDEO`, `AUDIO`, `ARCHIVE`, `CODE`, `SPREADSHEET`, or `OTHER`
- `requires_conversion` matters for image formats that cannot be rendered directly by the browser
- `description` should be the human-readable label contributors and users would expect

How to decide `requires_conversion`:

- set it to `False` for browser-native formats such as PNG, JPEG, GIF, WebP, SVG, and AVIF
- set it to `True` for formats with limited browser support or formats that are not practical to render directly, such as TIFF, HEIC, BMP, JPEG 2000, or JPEG XL when browser support is not sufficient for the product baseline

### Frontend Registry Rules

Frontend file-type definitions control how the browser app presents the file.

- keep `extensions` and `mimeTypes` aligned with the backend registry
- set `viewerComponent` to the shared viewer that should render the type
- choose an icon that matches the product language for that file category
- choose a color that distinguishes the format without inventing a new palette on every addition

For image formats, reusing `ImageViewer` is usually enough. For non-image formats, you may need a dedicated viewer such as `PdfViewer`, `VideoViewer`, `AudioViewer`, or the unified `TextEditor`.

### Non-Image File Types

The overall process is the same for documents, video, audio, text, archives, and code files.

1. add the backend registry entry
2. add the frontend registry entry
3. create or reuse the viewer component when preview support exists
4. verify the file icon, viewer routing, and download behavior

For non-image files, `requires_conversion` is usually `False`. The main design question is whether the product has a viewer component for that category or should fall back to download-only behavior.

### Integration Checklist

Use this checklist before you consider the file type integrated:

- backend registry entry added
- frontend registry entry added
- extensions and MIME types match exactly across both registries
- browser-native versus converted-image behavior decided intentionally
- viewer component chosen or added
- icon and color treatment chosen
- user-visible support docs updated if the file type changes what Sambee can preview

### Testing Checklist

After the registry change, verify:

- icon display in the file browser
- file opening in the expected viewer
- shared toolbar behavior if the preview uses `ViewerControls`
- conversion output if the format is server-converted
- gallery inclusion for image formats
- MIME type behavior across extension variants such as upper-case filenames
- download behavior with the correct MIME type
- mobile and tablet behavior when the preview is expected to work there

For server-converted formats, also verify:

- the backend returns the converted MIME type you expect
- transparency-sensitive formats still render correctly
- resizing or quality settings do not degrade the preview contract unexpectedly
- environment-specific format support failures surface in a controlled way

For preprocessable formats, also verify:

- the registry recognizes the extension regardless of case and leading-dot differences
- the expected preprocessor is selected for that format
- missing external-tool support fails cleanly
- validation and timeout rules behave as intended under bad inputs and slow conversions

### Architecture Notes

These helper functions are the practical integration points contributors usually touch:

- backend: `get_mime_type`, `needs_processing`, `is_image_file`, `get_file_type_by_extension`, `get_file_type_by_mime`
- frontend: `getViewerComponent`, `isImageFile`, `getFileIcon`, `getFileTypeByExtension`, `getFileTypeByMime`

At runtime, the flow is:

1. the backend lists files and assigns MIME information
2. the frontend receives `FileInfo` data with that MIME information
3. the frontend chooses icon treatment from filename and type rules
4. the frontend selects the viewer from MIME and file-type data
5. the backend routes convertible images through the image-conversion pipeline when needed

The frontend side still has work to do even when the backend owns the conversion:

- viewer MIME recognition must include the input formats the backend classifies as previewable
- file-type icon and color treatment must still reflect the original file type rather than the converted transport format
- browser-side fallback MIME logic must not drift from the backend contract in ways that hide conversion bugs

### Operational Characteristics

Server-side conversion changes the runtime profile of preview requests.

- large images can produce short CPU spikes during decode and encode
- memory usage can rise well above compressed input size while the image is fully decoded
- SMB-backed reads add their own latency before conversion even starts

That is why preview regressions for large HEIC or TIFF files often need both backend and user-facing verification.

### Future Extension Points

The current conversion path leaves room for later enhancements such as:

- caching converted preview outputs
- queueing especially large conversions
- dedicated thumbnail generation
- richer multi-page image handling
- conversion metrics for operational monitoring

Those are extension points, not assumptions the current product already guarantees.

The highest-risk mistake is still registry drift. If the backend and frontend disagree about extensions or MIME types, preview behavior becomes unreliable in ways that are easy to miss until users hit them.

## Common Failure Modes

- backend and frontend MIME types do not match
- a format is marked browser-native when it really needs conversion
- a viewer component is not registered even though the type is recognized
- a conversion change improves one format but breaks gallery behavior, download semantics, or mobile viewing

## Validation Expectations

When you change viewer or file-type behavior, usually run:

```bash
cd frontend && npm test
cd frontend && npm run typecheck
cd frontend && npm run lint
cd backend && pytest -v
```

If the change is image-conversion-specific, include the relevant backend tests around image conversion and preview behavior.
