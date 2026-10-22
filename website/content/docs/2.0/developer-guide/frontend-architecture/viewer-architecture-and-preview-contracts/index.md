+++
title = "Viewer Architecture and Preview Contracts"
+++

Preview behavior in Sambee is a cross-boundary contract, not just a frontend component choice.

## The Core Contract

The browser app decides how to render a file based on metadata and file-type information, but that depends on server-side classification staying aligned.

Three rules matter most:

- the backend and frontend file-type registries must describe the same extensions and MIME types
- the backend decides whether an image format needs server-side conversion for browser compatibility
- the frontend chooses the right viewer component and file icon based on the effective file type and MIME information it receives

## Where the Main Decisions Live

| Path | Responsibility |
|---|---|
| `backend/app/utils/file_type_registry.py` | backend source of truth for extensions, MIME types, categories, and whether an image requires conversion |
| `frontend/src/utils/FileTypeRegistry.ts` | frontend source of truth for extensions, MIME types, categories, viewer components, icons, and colors |
| `frontend/src/components/Viewer/` | viewer components and shared viewer UI |
| `backend/app/services/image_converter.py` | server-side conversion for non-browser-native image formats |

## Viewer Selection Model

At a high level, the preview pipeline works like this:

1. the backend determines file category and MIME behavior
2. the backend decides whether the file can stream as-is or needs image conversion
3. the frontend maps the file type to the appropriate viewer component
4. the shared viewer controls keep the toolbar and common behavior consistent across viewers

That is why a file-type change almost always touches both backend and frontend code.

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

Initial-load Markdown normalization runs through the existing preparation worker in `frontend/src/utils/markdownCodePreparation.ts`. Each load owns a worker and transfers source, canonical text and an equivalent canonical MDAST in acknowledged, bounded chunks. Tree batches contain at most 512 records and 16,384 string UTF-16 units; individual field pieces are at most 2,048 units. Numeric/flag/position metadata is validated separately, and large text and table alignment fields use the chunk channel instead of content limits. Host acknowledgements yield between tree batches. Success, cancellation, decode failure and timeout terminate the worker; aborted loads can't publish content. Worker failures use the existing load-error path without a synchronous retry, and local preparation failures aren't reported as server overload. The pre-app capability gate requires a callable Web Worker API and otherwise shows the existing unsupported-browser screen without importing the app. The helper retains defensive synchronous normalization with a diagnostic, but Worker-less app operation isn't supported. API presence doesn't guarantee successful worker construction or execution; existing startup, timeout, crash and decode-error handling remains necessary. The shared protocol is DOM-free. Vite's shared resolver aliases the character decoder to its non-DOM implementation before dependency optimization, so development and production workers use the same implementation. A worker-build-only resolver isn't sufficient for development's prebundled dependencies.

ReactMarkdown remains the only application whole-document renderer in every build mode. Its parser hook reuses a defensive clone of the prepared tree only when the tree matches the preview generation's exact source. All normal remark transforms, GFM, table-cell break handling, safe URL/raw HTML behavior and React rendering remain in that path. Cloning prevents those transforms from mutating the retained canonical tree. A successful Save that changes the source releases the superseded tree; edited content without a matching tree uses the normal parser. Editing, Save and recovery keep their existing synchronous normalization APIs; this optimization doesn't move them into the worker.

The bounded `sambee:preview-preparation:*` entries separate asynchronous decode elapsed time, load normalization, tree cloning, code-block collection and ReactMarkdown transforms. `load-normalization-elapsed` includes worker startup, transfer, work, host tree assembly, acknowledgements and scheduling, not main-thread CPU time. `render-prepared-tree` measures the defensive clone; `render-parse` measures normal parsing when no matching tree is available. The initial-load production matrix requires the clone stage and rejects synchronous `render-parse` and standalone `collection-parse` stages. Live syntax request collection walks the renderer's existing tree; it doesn't parse source again or change markup. The `collection-walk` interval is included in `render-transform`, not additional time to sum. Each generation publishes its ordered requests after DOM commit, before the passive syntax preparation effect, which snapshots them and retains cancellation and stale-generation guards.

The HAST-ready-to-layout-effect interval includes element construction, reconciliation, commit and scheduling, not just React CPU or paint. Entries contain no source text; each stage retains its latest measurement while the browser test observer collects individual samples. Normalization reuses its parsed tree when canonicalization leaves the source unchanged and reparses in the worker when edits change source offsets. Tree reuse doesn't close responsiveness, retained-memory, syntax-completion or native interaction acceptance.

That separation is an important contract: contributors should reuse the shared search UI when possible, but should not assume every viewer can use the same search implementation under the hood.

### Single-Renderer Acceptance

The retained whole-document viewer integration and its special build-mode selection have been removed. Don't reconnect the historical publisher or add a second renderer to finish shared highlighting. Reuse ReactMarkdown, its parsed-tree code collection, the existing workers and viewport CSS highlights. Standalone renderer proofs are historical research, not application acceptance or a delivery dependency.

Run `npm run build`, then `SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1 --repeat-each=3` from `frontend/`. The existing matrix uses the approved demo connection and unchanged dense, near-safeguard, many-block and long-line fixtures in Chromium and Firefox at desktop and narrow widths. Add `PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-reactmarkdown-baseline.json` and `--reporter=json` to retain structured reports without npm's console preamble. Each fixture attaches `viewer-timing-budgets.json`, with observed values, numeric targets, pass/fail results and criteria that remain unmeasured.

The timing gate evaluates file-click-to-text-completion, first exact search, changed query, last-match navigation and maximum viewer timer-service gap. Missing, non-finite or negative samples fail every run; `SAMBEE_E2E_BUDGETS=1` also fails over-budget samples. Omit that flag for functional-only runs, which still attach the budget result. Forced-GC and tracing runs are marked diagnostic and can't enforce timing acceptance. Run `npm run test:e2e -- viewer-performance-budgets.spec.ts --workers=1` for the evaluator's boundary and error tests.

Search/query/navigation probes start in browser event handlers, observe the expected count and active highlight in the existing small search controls, and finish after two frames. They avoid page-wide text queries and Playwright round-trip timing, but aren't hardware input-to-visible-paint measurements. The existing active-search fixture deliberately holds syntax preparation; text-load completion doesn't include syntax. Fresh/cached grammar isolation, first usable text/highlight completion, source editing, large prose/tables, resource acceptance and native interaction still require their own evidence. A passing timing subset isn't full rollout acceptance.

The browser checks compare exact rendered text, native Select All, selected code text and accessibility-tree output. They also exercise keyboard focus, safe links/HTML, GFM tables/tasks, shared Find navigation, theme-variable updates without text-node replacement, native copy events and Chromium PDF generation. These don't establish OS clipboard payloads, browser-native Find reveal, assistive-technology behavior or visual full-document print/PDF correctness. Those remain manual gates.

The separate native-constraint slice checks representative multiline, long-line and nested Markdown at widths 1543/390 in Chromium/Firefox. It compares cross-block selected text with a trusted keyboard copy/paste payload, exercises keyboard focus and native `window.find` selection/reveal, and attaches real Chromium PDFs. The native text-find API isn't the browser Find toolbar, and a narrow desktop viewport isn't a physical phone. From `frontend/`, after a normal production build, run:

```sh
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-native-constraints.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production native Markdown constraints' --workers=1 --reporter=json
```

From the repository root, check the attached PDF text with the existing backend environment:

```sh
backend/.venv/bin/python -m scripts.check_native_markdown_pdf /tmp/sambee-native-constraints.json
```

The checker rejects missing/duplicate PDF cases, unsuccessful browser results and missing rendered-document lines. Heading IDs now use a safe prefix and standard duplicate/Unicode slugging in the existing HAST pipeline; matching fragments are rewritten consistently. The combined native slice remains blocked at native text-find reveal, so printing has its own independent checks.

The Markdown preview's Print icon calls the native browser print dialog; Save as PDF is a destination in that dialog, not a second renderer or server-side conversion. Print isn't offered in edit mode or enabled while loading has failed or is incomplete. Print-only styles hide controls/background UI, release fullscreen/scroll constraints, wrap code/table cells, retain images and use black text on white regardless of the screen theme. Native `beforeprint`/`afterprint` handlers preserve focus, selection and nested scroll, with pending callbacks removed on disposal. The fullscreen paper sizes against its fixed container rather than dynamic viewport units that can retain print-page dimensions.

Run the independent print matrix from `frontend/`, then inspect the PDF attachments from the repository root:

```sh
PLAYWRIGHT_JSON_OUTPUT_NAME=/tmp/sambee-markdown-printing.json SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production Markdown printing' --workers=1 --reporter=json
```

```sh
backend/.venv/bin/python -m scripts.check_native_markdown_pdf /tmp/sambee-markdown-printing.json --printing
```

The 24-case matrix covers three fixtures, both themes, both widths and both engines. It verifies action invocation, print CSS, wrapping/widths and actual Chromium PDF state restoration. The PDF gate requires all 12 Chromium outputs to contain every rendered non-whitespace text line and an embedded image. Clear any forced screen-media override before PDF generation; otherwise Playwright prints screen CSS. First/last-page raster inspection supplements text checks. Firefox CSS checks aren't actual Firefox PDF evidence, and physical-printer behavior remains unverified. Browser destination, paper, margin and header/footer settings remain user-controlled.

Keep performance changes local to measured costs in the current path. Distinguish first visible syntax from completion of all block preparation, and include serialization and parent updates when measuring typing or atomic replace-all. Configuration-only theme and grammar updates must not request caret reveal or replace the document, selection or editor. Don't add streaming, scheduling abstractions or new edit protocols without evidence that the existing path misses its target.

For separate controlled-memory trials, add `SAMBEE_E2E_MEMORY=1` and restrict the existing matrix to the many-block fixture and Chromium. Release harness-held node references before post-GC sampling. Renderer heap excludes worker heaps and aggregate/native memory; a single close isn't repeated-close leak acceptance. Keep forced GC separate from responsiveness timing.

For diagnostic scheduling traces, add `SAMBEE_E2E_TRACE=1` to a single-fixture Chromium run. The `viewer-scheduling-trace` attachment contains a CDP timeline and V8 CPU profile. Align `sambee:viewer-trace:start` with browser timestamps; join CPU chunks by renderer PID and profile ID and count samples once. Firefox native profiling must use content-process User Timing markers rather than parent-only samples. Profiling adds overhead and isn't acceptance timing.

Count assertions remain scoped to the existing search controls to avoid page-wide Playwright text caches inside measurement windows. Results are labelled `scoped-controls-v2`; older input figures aren't directly comparable. Handler-to-frame samples and synthetic event age don't establish hardware input-to-visible-paint latency. Removing the alternate renderer doesn't close any performance, memory or manual interaction gate.

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

File-type support is registry-driven. The safest way to add a new type is to treat backend and frontend changes as one contract update.

### Main Files to Change

| Path | Why it changes |
|---|---|
| `backend/app/utils/file_type_registry.py` | declare extensions, MIME types, category, description, and whether an image requires conversion |
| `frontend/src/utils/FileTypeRegistry.ts` | declare extensions, MIME types, category, viewer component, icon, color, and description |
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

For image formats, reusing `ImageViewer` is usually enough. For non-image formats, you may need a dedicated viewer such as `PdfViewer`, `VideoViewer`, `AudioViewer`, or `TextViewer`.

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
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
cd backend && pytest -v
```

If the change is image-conversion-specific, include the relevant backend tests around image conversion and preview behavior.
