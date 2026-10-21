# Shared Syntax Highlighting Plan

Updated: 2026-10-21. Core highlighting is integrated; acceptance and performance
work remain. **Merge/rollout is blocked by whole-viewer responsiveness.**
This document replaces the historical design, P1-P6 status tables and experiment
log. The scope and acceptance requirements below are authoritative; completed
implementation details belong in code, tests and developer documentation.

## Goal

Use the same language resolution, parsers, token categories and theme colors in
the text viewer/editor, rendered Markdown code blocks and Markdown editor.
Highlight Markdown source structure as well as fenced code. Preserve source
fidelity, editing, search, selection, copying, navigation, Save and recovery.

Keep CodeMirror behind the existing small application-owned highlighting
contract. Do not replace the editor, embed editors in rendered code blocks or
build a generic highlighting/search/worker framework. Editor replacement and
parser replacement are separate future projects, not requirements here.

## Current State

Implemented and covered by focused checks:

- Shared lazy language resolution, token mapping, Markdown source styling and
  theme integration, including legacy-theme compatibility.
- Live Markdown syntax preparation in a cancellable worker, bounded source/result
  transfer and frame-paced CSS Highlights capped at 4,000 viewport ranges.
  Highlighting does not replace preview text or restart its search.
- Immutable editor snapshot handles used by Save; duplicate serialization on
  controlled-value echoes removed. One full-string callback per edit remains.
- Cached source-search metrics and shared binary active-match lookup;
  selection/viewport decoration updates do not independently recount all matches.
  DOM next/previous activation touches only the old and new match.
- Bounded User Timing entries separate preview DOM capture, matching, slice mapping,
  marker publication and clearing. Dense marker clearing coalesces text once per
  parent instead of normalizing thousands of fragments with live syntax ranges;
  this removes a reproducible Chromium changed-query hang after syntax publication.
- Markdown preview search now retains the unchanged-content DOM index and logical
  matches, with at most 1,000 viewport CSS search ranges plus one active range.
  Query changes don't replace text nodes; syntax/theme updates don't recapture the
  index. Text mutations invalidate it. PDF search keeps its existing marker path.
- Syntax publication clips horizontally overflowing unwrapped code to visible
  columns and refreshes on nested scrolling. DOM capture joins chunks once rather
  than repeatedly inspecting a growing concatenated string. Navigation, syntax
  stages, worker round trips and initial commit/frame milestones are measured.
- Isolated retained-text whole-Markdown/model-search and source-regex worker
  prototypes. Their successful proofs are not live-viewer acceptance.
- The existing retained publisher is connected to the actual viewer only in
  `test-preview` builds. Ordinary production/development builds retain
  ReactMarkdown; this is an integration experiment, not a rollout.

Latest affected-slice verification: 231 shared-search/syntax/normalization/Markdown/PDF unit tests,
48 unchanged performance-matrix trials per renderer, and six final native-viewer
contract trials per renderer passed. The final retained smoke matrix also passes
all 18 cases, including partial-publication cancellation. An initial default
Firefox native trial raced delayed autofocus; waiting for automatic focus before
Tab resolved the harness race, and all six final default native trials pass.
Frontend lint, touched-file diagnostics and both build modes pass. The existing
build warning for chunks above 500 kB remains. Performance and manual interaction
acceptance are incomplete.

### Performance Baseline To Beat

The original development-build dense fixture (54,000 code units, 6,000 matches)
blocked a high-priority task for approximately 518-539 ms during token publication.
Keep that fixture; a production-build speedup alone is not architectural proof.

After bounded syntax publication, real production-viewer functional checks pass,
but the surrounding rendering/search work still stalls. In the latest single-run
matrix at widths 1543/390:

- Chromium's 600-block fixture had 892-1,003 ms maximum timer gaps and
  867/981 ms long tasks.
- Firefox's near-safeguard search action took 1,212-1,270 ms; maximum timer gaps
  reached 1,165 ms. Its Long Tasks API is unavailable, not evidence of zero stalls.

Action timings include Playwright synchronization; timer gaps include scheduling.
Neither isolates a CPU stage or measures input-to-paint latency. Separate initial
Markdown rendering, search indexing/application, clearing and syntax painting
before choosing the next optimization.

### Search Attribution Follow-Up

The subsequent three-trial production matrix at both widths separates synchronous
search work. Rounded-up worst stage times across widths/trials, in milliseconds:

| Engine / Fixture | DOM Capture | Marker Publication | Clearing |
| --- | --- | --- | --- |
| Chromium dense | 1 | 269 | 7 |
| Chromium near-safeguard | 1 | 701 | 25 |
| Chromium many-blocks | 101 | 369 | 82 |
| Firefox dense | 1 | 690 | 432 |
| Firefox near-safeguard | 1 | 1,383 | 763 |
| Firefox many-blocks | 6 | 738 | 296 |

Matching remained at or below 18 ms and slice mapping at or below 19 ms. Prioritize
the planned viewport-only search presentation and unchanged-content DOM-index cache
before adding a matching worker. Linear clearing fixes the Chromium hang, not the
remaining per-match marker insertion/removal costs or Firefox clearing budget.

The browser check now covers real sequential keyboard entry, changed queries,
next/previous and last-match wrap, viewport scrolling and active search during
syntax preparation completion. It records per-phase windows, long tasks where
supported, timer gaps and keyboard-event-to-two-frame samples. These samples are
not hardware input-to-visible-paint latency: event queue delay and visible paint
are not measured. Sequential entry performs several searches and is not directly
comparable to the earlier single-fill search action.

Many-block initial-render-through-two-frame windows reached 1,638 ms in Chromium
and 2,577 ms in Firefox; those windows still include click/Playwright scheduling.
Keyboard-to-two-frame p95 reached 1,884 ms; maximum timer gaps reached 1,932 ms.
Performance acceptance therefore still fails. Initial parse/React commit, deferred
layout and syntax painting are not yet isolated; syntax-release windows include
worker preparation and must not be reported as paint-only measurements. The
document-switching checks currently close/reopen with preparation held, not rapid
switching between distinct documents. Keep those attribution/interaction gaps open.

### Cached Viewport Search Follow-Up

The next three-trial matrix retained the original fixtures, engines and widths, added
a 6,000-match horizontal long-line fixture, and
asserted one DOM capture across sequential typing, changed queries, navigation and
syntax publication. No search markers were created; the original selected text
node survived query changes, and last-match navigation revealed the indexed range.
All 48 final functional trials passed without retries or flakes. Worst synchronous
search-presentation tasks on the original fixtures were 4.6 ms in Chromium and
2 ms in Firefox, replacing marker publication that reached 701/1,383 ms. The added
long-line fixture reached 26.7/8 ms. Clearing was at most 1 ms; matching was at most
10 ms. The browser check verifies distinct computed search colors and retained
text-node identity, but isn't the full custom/light/dark theme acceptance matrix.

At that checkpoint, capture reached 60.2 ms in Chromium's many-block fixture
(4 ms in Firefox); the linear capture fix below supersedes the need for yielding
in that measured envelope. The changed
query's end-to-end two-frame phase reached 147.6/148 ms for many blocks; last-match
navigation reached 180/199 ms. The worst per-trial dense and near-safeguard
keyboard-to-two-frame p95 stayed below 50 ms, but many-block p95 reached 100.7/99 ms.
Long-line navigation reached 1,426.5 ms in Chromium; its keyboard p95 reached
187.5 ms (44 ms in Firefox). These remain proxies, not actual hardware
input-to-visible-paint measurements.

Initial rendering and syntax refresh are still unresolved: many-block initial
windows reached 1,668.6/2,595 ms and syntax-release windows reached 878.6/910 ms.
Firefox's long-line syntax-release window reached 1,922 ms; its timer gap reached
1,815 ms. Keep rollout blocked; the bounded search
presentation result isn't a whole-viewer budget pass. Isolate initial commit/layout
and syntax refresh before choosing the next renderer change. Scoped colors and
counts/navigation-only execution without CSS Highlights are implemented, but final
browser-support policy, physical mobile and full theme/accessibility acceptance
remain open.

The added real-keyboard long-line check also exposed delayed preview autofocus
stealing focus mid-query. The preview now honors an already focused search input,
matching the editor's existing guard. A deterministic timer regression covers it;
the browser check waits for active-range query identity, not an unchanged count.

### Navigation And Syntax Attribution

The following baseline and fix use three long-line trials per engine/width, then
the full 48-trial matrix. Navigation lookup, registry publication, geometry and
scroll calls were small (at most 3 ms in the final matrix). Don't treat the older
Playwright action windows as time spent inside these calls.

Firefox's long-line stall was native syntax registry publication: up to 1,167 ms
before horizontal clipping, versus at most 3 ms afterward. Final long-line syntax
tasks were at most 28.8 ms in Chromium and 4 ms in Firefox. Navigation click-to-two-
frame maxima were 69/37 ms, versus 205.1/51 ms in the instrumented pre-fix baseline.
These samples begin at the click handler, not hardware input arrival; registry
publication timings exclude deferred rendering unless the browser performs it
inside the call. The far-right destination is checked for actual syntax ranges,
not just nonempty registry entries.

Chunked index assembly reduced Chromium many-block capture from 60.2 ms to 1.3 ms;
Firefox remained at 4 ms. Defer asynchronous capture for this envelope rather than
introducing pending-count state unnecessarily; retain the requirement to yield if
larger measured captures exceed the budget. Search matching remained at most 11 ms.

Worker round trips start at actual source send, excluding the intentional test
hold. They include transport, grammar loading, scheduling and result acknowledgements,
not isolated parser CPU. Final near-safeguard per-block round trips reached
94.8/109 ms; many-block preparation still includes 600 sequential block exchanges.

The next controlling gap is initial content preparation/rendering: many-block
source-response-to-commit-observer intervals reached 651.4/1,562 ms, followed by
up to 115.3/71 ms through two frames. These intervals include source decoding,
application preparation, Markdown parsing, rendering, commit and scheduling; they
don't isolate React CPU or establish visible paint. Full initial action windows
were 1,656.3/2,612 ms and maximum timer gaps were 730.4/810 ms. Changed-query and
last-match action windows also still exceed 100 ms on some fixtures. Rollout remains
blocked. Attribute the pre-commit work and compare the existing retained-text
publisher before any renderer migration; keep native interaction acceptance gates.

### Initial Preparation Attribution

Bounded `sambee:preview-preparation:*` entries now distinguish asynchronous blob
decoding elapsed time, synchronous load normalization, code-block collection
parse/walk, ReactMarkdown parse/transforms and HAST-ready-to-layout-effect time.
Unified plugin hooks measure the actual renderer parser and transforms without
changing the rendered HTML. The final interval includes element construction,
reconciliation, commit and scheduling; it isn't isolated React CPU or visible
paint. Collection parsing includes processor setup. Each named entry retains only
the latest measurement and contains no source text; the browser observer collects
the individual samples across the test lifecycle.

Three many-block trials per width/engine established the baseline. Normalization
parsed twice even when escape cleanup left the source unchanged. It now reuses
the first tree in that case, but reparses when cleanup changes offsets. Existing
normalization, editing and Save tests remain intact, with an added offset-shift
regression covering later table breaks and list markers.

The same 48-case matrix passed without retries or flakes afterward. These are
maxima across six trials per engine, not sums or paired-trial CPU totals:

| Many-block interval | Chromium baseline / final | Firefox baseline / final |
| --- | --- | --- |
| Load normalization | 339.9 / 202.8 ms | 793 / 407 ms |
| Collection parse | 137.7 / 156.5 ms | 360 / 428 ms |
| Render parse | 160.6 / 138.7 ms | 394 / 369 ms |
| Render transforms | 1.2 / 1.4 ms | 1 / 1 ms |
| HAST ready to layout effect | 14.2 / 5.4 ms | 9 / 8 ms |
| Source response to commit observer | 642.8 / 510.1 ms | 1,555 / 1,220 ms |
| Maximum timer gap | 734.4 / 608.2 ms | 816 / 859 ms |

Final many-block decode elapsed maxima were 16.1/36 ms and collection traversal
was at most 0.2/1 ms. The redundant normalization parse is removed, but synchronous
full-source parsing remains the main attributed pre-commit cost. Firefox's timer
gap didn't improve, and initial action windows still reached 1,727/2,512 ms.
Functional success is not responsiveness acceptance; rollout remains blocked.

### Render-Tree Code Collection

The live preview now collects syntax requests during ReactMarkdown's existing
remark pass rather than reparsing source separately. The standalone collector
remains for proof and test callers, sharing the same tree walk. Collection retains
block order, language labels and exact UTF-16 code text, including nested,
indented and unlabeled blocks. It doesn't modify the tree or rendered markup.

Each generation owns a request ref populated by the preview's layout effect only
after its DOM commits. The parent's passive syntax effect snapshots those requests
before starting preparation. Cleanup aborts obsolete preparation, and the existing
generation guard prevents late results from publishing into another document.
Tests cover committed-DOM readiness and a replaced generation's late result as
well as existing selection, search, unmount, editing, Save and recovery behavior.

All 48 unchanged functional trials passed without retries or flakes, with an added
assertion that the separate `collection-parse` stage is absent. The collection walk
is now inside the measured render-transform interval, not additional time to sum.
Many-block maxima before/after this change were:

| Many-block interval | Chromium before / after | Firefox before / after |
| --- | --- | --- |
| Separate collection parse | 156.5 ms / removed | 428 ms / removed |
| Collection walk | 0.2 / 0.1 ms | 1 / 1 ms |
| Render parse | 138.7 / 158.2 ms | 369 / 410 ms |
| Render transforms, now including collection | 1.4 / 1.9 ms | 1 / 2 ms |
| Source response to commit observer | 510.1 / 361 ms | 1,220 / 841 ms |
| Maximum timer gap | 608.2 / 450.1 ms | 859 / 488 ms |

These are separate trial maxima, not paired CPU samples. Final normalization
still reached 191.5/390 ms, initial action windows reached 1,556/2,161 ms and
commit-to-two-frame intervals reached 109.1/70 ms. Dense and near-safeguard initial
response-to-commit also improved, but long-line response-to-commit was essentially
unchanged. The renderer, source normalization and Save/recovery contracts remain
unchanged; responsiveness acceptance and rollout remain blocked.

The next bounded integration should target the remaining normalization/render
parses using the existing whole-Markdown worker/model/publisher, not another
prototype or an unmeasured React rewrite. Retain native selection/copy, Select All,
browser Find, focus, accessibility, print, GFM/link/safe-HTML and Save/recovery
acceptance gates, then repeat the unchanged performance matrix.

### Production Worker Normalization

The existing preparation worker and transport now live in runtime utilities, with
forwarding modules preserving the proof's imports. A DOM-free protocol module
owns message types and transfer bounds. The worker uses the existing static
highlighter core directly rather than importing browser logging. Worker-only Vite
resolution selects the character decoder's non-DOM implementation without changing
main-thread resolution or adding dependencies. Production startup and the existing
development-server viewer/re-entry check pass in Chromium and Firefox.

Only initial-load normalization is integrated into the live viewer in this slice.
Each job owns its worker, transfers source and canonical results in acknowledged
chunks of at most 16,384 UTF-16 units, and terminates on completion, cancellation,
decode/sequence failure or progress timeout. Aborted jobs can't publish content.
Worker startup and runtime failures reach the existing load-error path; they don't
silently trigger synchronous retries. Environments without Web Workers retain the
previous synchronous normalization with an explicit informational diagnostic.
Editing, Save, recovery and ReactMarkdown rendering are unchanged.

The document model also supports opt-in canonical normalization, and the existing
whole-document worker uses it. Both retained-publisher proofs pass at widths
1543/390 in Chromium/Firefox, including a new canonicalization fixture, exact
text/native selection, layout/resize, safe HTML/links, footnote navigation,
print-media visibility, syntax/search failures and partial-publication cleanup.
These are proof-host checks, not live-publisher acceptance. Their interaction gate
remains OPEN: actual browser Find reveal, assistive-technology behavior, real
print/PDF output, physical/reference devices, aggregate memory and large-structure
performance are not established. Don't replace the live renderer on this evidence.

The final unchanged 48-trial live matrix passes without retries or flakes, now
also closing during held normalization and verifying termination and no late DOM.
Unit coverage includes isolated concurrent jobs, cancellation, oversized source
results, decode failure and watchdog expiry, plus canonical source/model parity.
Many-block maxima before/after this integration are:

| Many-block interval | Chromium before / after | Firefox before / after |
| --- | --- | --- |
| Normalization | 191.5 ms synchronous / 233 ms elapsed | 390 ms synchronous / 440 ms elapsed |
| Render parse, still synchronous | 158.2 / 178.8 ms | 410 / 397 ms |
| Source response to commit observer | 361 / 428.7 ms | 841 / 881 ms |
| Maximum timer gap | 450.1 / 290.4 ms | 488 / 483 ms |

`load-normalization-elapsed` replaces the old synchronous timing stage and includes
worker startup, transport, work, acknowledgements and scheduling. It isn't main-
thread CPU time. Initial action windows still reached 1,838/2,193 ms; worker startup
also adds latency on small fixtures. Moving this work off-thread doesn't claim
faster document completion or whole-viewer performance acceptance. Rollout remains
blocked. The next integration must address the remaining render parse and the
publisher's host/native-interaction gates, reusing the existing publisher rather
than creating another one.

### Test-Only Real-Viewer Retained Integration

`RetainedMarkdownPreview` hosts the existing document publisher inside the actual
Markdown viewer when built with `npm run build -- --mode test-preview`. It isn't a
user setting or a query flag. The promoted publisher/search modules retain proof
forwarders rather than creating another implementation. Initial normalization
still uses its isolated worker; an isolated document job parses the canonical
source, streams acknowledged records and owns its syntax paging session. The
canonical-source flag avoids another normalization pass. There is no document
parse on the main thread in this path, and no main-thread retry on worker failure.

The host reuses the viewer's viewport, DOM-search session, safe link resolver,
focus behavior and scoped theme variables. Host-owned search doesn't build the
proof's duplicate model index. Generation changes/close abort preparation, remove
styles, listeners and highlights, dispose the publisher and terminate its owned
syntax worker. Late sessions are disposed rather than published. Error messages
are generation-scoped. The actual-viewer matrix additionally closes during held
normalization, syntax-window requests and document-publication acknowledgements,
then releases held work and verifies no late DOM or live worker remains.

The original long-line destination assertion caught missing horizontal syntax
clipping in the retained publisher. Both publishers now reuse the same column
window calculation and observe nested code-block scrolling; the assertion and
range cap weren't relaxed.

In three native-contract trials per engine/renderer, rendered `innerText`, native
Select All, selected code text and the semantic accessibility snapshot match
exactly. Checks cover headings, GFM tables/tasks, raw HTML as safe text, unsafe URL
rejection, resolved relative/hash/external links, automatic focus followed by Tab,
shared Find/Enter navigation, and native copy events with exact selected text.
Syntax theme-variable changes preserve selected text nodes and selection.
Chromium print-media text remains unchanged and PDF bytes are generated. These
checks don't establish OS clipboard payloads, browser-native Find reveal,
assistive-technology behavior, visual pagination/full-document printing or
physical/reference-device acceptance. Those gates remain OPEN.

The unchanged repeated matrix uses 6,000-line dense, 11,111-line near-safeguard,
600 x 101-line many-block and 6,000-match single-line fixtures, widths 1543/390,
Chromium/Firefox and three trials. All 48 functional trials pass per renderer.
For the many-block fixture, maxima across both widths and all three trials are:

| Interval or observation | Chromium default / retained | Firefox default / retained |
| --- | --- | --- |
| Normalization elapsed | 232 / 227.3 ms | 430 / 433 ms |
| Source response to code-container observer | 432.4 / 1,142.2 ms | 859 / 1,711 ms |
| Retained document job completion | n/a / 1,101.6 ms | n/a / 1,556 ms |
| Source response to retained completion | n/a / 1,341.6 ms | n/a / 2,015 ms |
| Initial open action window | 1,806 / 2,489 ms | 2,162 / 3,222 ms |
| Maximum timer gap | 299 / 243 ms | 469 / 166 ms |
| Keyboard through two frames | 102.3 / 141.9 ms | 102 / 161 ms |
| Navigation through two frames | 105.5 / 146.1 ms | 111 / 153 ms |
| Observed renderer JS heap after interactions | 60.3 / 289.6 MiB | unsupported |

These are independent maxima, not paired CPU samples. The code-container observer
retains the existing expected-block-count condition and can fire before retained
publication completes; it isn't a first-batch or document-complete measurement.
The retained-completion stage includes worker startup, source transport, parsing,
grammar work, acknowledged publication and scheduling, not main-thread CPU time.
Action windows include browser-test synchronization. Two-frame samples aren't
hardware input-to-visible-paint acceptance.

Chromium heap samples are taken before open, after the completed interaction
sequence and after close using `Runtime.getHeapUsage`, without forced GC. They
exclude worker heaps and don't establish aggregate/native/DOM memory. Many-block
after-close used-heap maxima are 66.2/302.3 MiB default/retained; these aren't
post-GC survivors or leak evidence. Firefox has no corresponding heap samples.
The retained path reduces the largest many-block task gap but worsens startup,
completion, interaction windows and observed heap use. Its gaps still exceed
50 ms, Firefox source-to-complete exceeds 1,500 ms, and warm navigation samples
exceed 100 ms. Promotion remains BLOCKED.

Reproduce the experiment without changing stored demo files:

```bash
cd frontend
npm run build -- --mode test-preview
SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_RETAINED=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1 --repeat-each=3
npm run build
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1 --repeat-each=3
```

### Retained Publication Attribution And Pacing

The next slice adds bounded scalar attribution to the existing worker/transport,
publisher and real-viewer check. It doesn't add another renderer or worker pool.
Transport startup-to-first-ack and source-transfer intervals use the main-thread
clock. Document model creation, record generation excluding acknowledgement waits,
acknowledgement waits and syntax preparation use the worker clock. Syntax timing
includes grammar loading/highlighting rather than claiming isolated parser CPU.
The existing total `preparationMs` is elapsed pipeline time, including publication
acknowledgements; it must not be described as worker CPU time.

Publisher stats separate synchronous assembly, largest batch assembly, frame
waits and record counts. Worker and publisher batch/record counts must match.
Chromium browser counters separate initial-render from full-interaction layout,
style and script totals; these cover the renderer interval, not just the publisher
function. Firefox has no equivalent CDP counters. The many-block fixture retains
5,401 elements and 4,799 text nodes in this renderer; the change doesn't reduce
content or remove off-screen text.

Three trials at each width/engine identified acknowledgement/frame pacing as the
largest measured avoidable interval. The publisher previously waited a frame after
every two batches regardless of their cost. It now yields after eight batches or
4 ms of cumulative synchronous assembly, whichever comes first. Record/chunk,
syntax-page and viewport-range bounds are unchanged. This is a yield threshold,
not a preemption guarantee or a claimed layout/paint time budget.

Many-block maxima across the same six trials per engine, before/after this change:

| Interval | Chromium before / after | Firefox before / after |
| --- | --- | --- |
| Document job elapsed | 1,122.7 / 847 ms | 1,551 / 1,390 ms |
| Acknowledgement waits | 726.8 / 440.7 ms | 817 / 654 ms |
| Explicit frame waits | 486.9 / 88.3 ms | 348 / 115 ms |
| Synchronous DOM assembly | 23.6 / 22.5 ms | 30 / 24 ms |
| Largest assembly batch | 0.9 / 1.3 ms | 6 / 4 ms |
| Maximum timer gap | 243.2 / 228.3 ms | 182 / 181 ms |
| Initial open action window | 2,525 / 2,393 ms | 3,440 / 3,188 ms |

Before the pacing edit, model creation reached 151.6/380 ms, syntax preparation
201.8/309 ms, record-generation work 9.6/20 ms and transport startup 35.1/52 ms
in Chromium/Firefox. Chromium layout across the complete interaction sequence
reached 105.5/100.3 ms before/after; this isn't a per-task or publication-only
duration. These are independent maxima, not times to add or paired CPU samples.
The original structural/native document proofs pass in both engines after the
change, including large-table/paragraph, selection, resize, failure and cleanup
contracts. Proof-host passes still aren't production performance acceptance.

Controlled memory runs use `SAMBEE_E2E_MEMORY=1` with the same many-block browser
test, Chromium only, separately from responsiveness runs. They force collection
before open, after interactions and after close. The harness releases its selected
text-node reference before post-GC sampling. Before the pacing edit, retained used
heap reached 19.9 MiB after interaction and 16 MiB after close; afterward it reached
19.8/16.1 MiB. The earlier approximately 290 MiB uncollected observation therefore
doesn't establish live retained memory or a leak. These samples still exclude
worker/aggregate native memory and aren't a warmed repeated-close leak test.

The equivalent six default-renderer controlled-memory trials reach 43.5 MiB after
interaction and 16.3 MiB after close, versus 19.8/16.1 MiB retained. This narrows
the live renderer comparison but doesn't measure total application memory or
prove leak-free repeated use. Forced collection is excluded from the timing runs.

Final verification passes 231 affected unit tests, frontend lint, touched-file
diagnostics, both builds, documentation checks and both structural/native proofs.
The unchanged repeated real-viewer matrix passes all 54 cases per renderer
(48 fixture trials plus six native-contract trials), without retries or flakes;
rendered text, Select All, selected code and semantic snapshots still match.
Six controlled-GC trials per configuration (retained before/after, default) pass
separately. In the final retained full matrix, many-block job maxima are
873.3/1,308 ms and frame waits 92/110 ms in Chromium/Firefox, consistent with the
focused improvement but not identical trial maxima. Initial-render Chromium
layout reaches 92.8 ms across the renderer interval. Remaining timer gaps still
reach 226.2/173 ms. The normal production build is restored and excludes the
experimental retained host; default behavior remains unchanged.

The largest remaining Chromium gaps in the focused after-run overlap first-search
typing, while overlapping capture/matching stages reach only about 3/5 ms and no
long-task entry explains the gap. Firefox's largest gaps overlap navigation or
fall outside the named action windows; overlapping presentation is at most about
1 ms. A timer-service gap isn't proof of one long CPU task. The next slice should
separate browser scheduling, rendering and input-to-frame latency with a browser
trace before changing the matcher or moving more small synchronous calls.

The normal renderer remains ReactMarkdown. Reduced frame waits don't establish
the responsiveness, aggregate-memory or manual interaction gates. Don't promote
it or invent another publisher to bypass the failing measurements.

### Input Scheduling Trace And Harness Correction

The scheduling slice changes only the existing browser harness. With
`SAMBEE_E2E_TRACE=1`, Chromium attaches a streamed CDP timeline and V8 CPU profile
as `viewer-scheduling-trace`. Capture starts before opening the viewer and ends
after its cancellation/re-entry checks; the session and stream close in cleanup.
Firefox skips CDP capture. Tracing is diagnostic and adds overhead; it must run
separately from acceptance timing and controlled-GC memory trials. The harness
rejects combined tracing/forced-GC Chromium runs.

The `sambee:viewer-trace:start` mark aligns browser `performance.now()` samples
with trace timestamps. CPU profile chunks must be joined by renderer PID and
profile ID, not thread ID: chunks can arrive on a different thread. Count each
sample once when classifying stacks; recursive ancestor counts aren't CPU shares.

The original many-block trace exposes injected Playwright `elementText`/`queryAll`
work and repeated minor GC during typing/navigation. Exact match-count assertions
used page-wide text queries, traversing and allocating across the large preview.
They now query only the existing small counter/navigation container. Expected
counts, real keyboard/click actions, range limits, off-screen destinations,
selection identity and cleanup assertions are unchanged. No viewer, matcher,
publisher, worker or production gate changed.

In the same traced default desktop case, maximum keyboard handler-to-two-frame
time fell from 102.2 to 29.1 ms, and navigation from 103.7 to 23.4 ms. The typing
window's minor-GC duration fell from about 52 ms to zero; its largest main task
fell from 76.9 to 23.5 ms. A separate pre-fix CPU-profile run and the scoped run
also show injected-script samples falling from about 12% to 1% and GC samples
from 25% to zero in that window. These diagnostic observations support the
harness explanation; they aren't an application speedup or acceptance results.

Portable keyboard/navigation samples now separate first and second animation
frames. Keyboard samples also report event timestamp-to-handler age. The test
checks that values are finite/nonnegative and the first frame doesn't follow
the second. These start at synthetic DOM event handling, not hardware input or
visible paint; event age doesn't prove OS input delivery time. Measurements are
labelled `scoped-controls-v2` and include trace requested/supported flags. Don't
compare old page-wide-query input figures as if the measurement were unchanged.

The final untraced matrix repeats both widths three times in both engines.
Many-block maxima below span six trials per engine; keyboard p95 pools those
event samples rather than establishing physical-device input p95:

| Measurement | Default Chromium / Firefox | Retained Chromium / Firefox |
| --- | --- | --- |
| Keyboard handler-to-first-frame maximum | 18.7 / 30 ms | 18.1 / 46 ms |
| Keyboard handler-to-two-frame maximum | 33.1 / 40 ms | 29.1 / 77 ms |
| Keyboard handler-to-two-frame pooled p95 | 31.4 / 39 ms | 27.7 / 63 ms |
| Navigation handler-to-two-frame maximum | 24 / 47 ms | 23.4 / 28 ms |
| Maximum timer-service gap | 283.4 / 467 ms | 136.1 / 88 ms |
| Initial open action window | 1,793 / 2,178 ms | 2,361 / 3,030 ms |

The default Chromium long-line pooled two-frame p95 also reaches 52.8 ms.
Action windows still include Playwright synchronization; they aren't the handler
samples above. Startup, timer-service and remaining typing tails still block
rollout. The next bounded investigation should attribute retained startup and
the Firefox many-block typing tail with the corrected harness, not optimize the
matcher on the strength of the old contaminated samples.

Both full matrices pass all 54 cases without retries/flakes. Exact text, Select
All, selected code and accessibility snapshots match per engine across renderers.
The additional 12 untraced many-block trials and four diagnostic Chromium traces
pass. Both builds, frontend lint, touched-file diagnostics and documentation
checks pass; ordinary production assets are restored. No new memory acceptance
or manual native Find/clipboard/AT/print/device evidence is claimed.

### Retained Startup Batching And Firefox Input Attribution

The next bounded slice adds viewport-paint attribution and changes acknowledged
document batching, not the renderer/search architecture. The proof's search
session is lazy and starts no worker in host-search mode, so an unused search
worker doesn't explain startup. Retained viewport paint now reports cumulative
and largest durations plus one bounded latest User Timing entry; the browser
observer captures individual events for overlap checks.

In twelve corrected-harness baseline trials, the slow first-character Firefox
frames don't overlap retained viewport painting. Chromium paint totals reach
8.1 ms and largest paint 0.6 ms; Firefox totals reach 147 ms and largest paint
19 ms. These include synchronous geometry/layout triggered by that callback,
not all deferred browser layout or paint. They don't explain the input tail.

The worker instead publishes 10,799 many-block records in 85 acknowledged
round trips, because code fragments force the smaller 128-record batch limit.
It now batches up to 512 records or 16,384 UTF-16 text/attribute units, flushing
before a record would exceed the text bound. Individual text/attribute chunks
remain at most 2,048 units. The transport rejects an oversized combined payload
before publication and terminates its worker. The record-count limit, source
transfer, syntax-page/cache bounds and publisher's eight-batch/4 ms assembly
yield threshold are unchanged. This isn't an increase in the permitted content
or a guarantee about deferred layout/paint. Tiny records share fewer messages;
large text payloads have a separate explicit bound.

The same twelve trials before/after this change give the following independent
many-block maxima across six trials per engine:

| Measurement | Chromium before / after | Firefox before / after |
| --- | --- | --- |
| Acknowledged document batches | 85 / 34 | 85 / 34 |
| Worker acknowledgement waits | 450.3 / 270 ms | 616 / 354 ms |
| Document job elapsed | 834.7 / 657.2 ms | 1,333 / 1,099 ms |
| Initial open action window | 2,370 / 2,089 ms | 3,153 / 2,932 ms |
| Largest synchronous assembly batch | 6.6 / 1.3 ms | 2 / 2 ms |

The final unprofiled full matrix passes 54 cases without retries/flakes. Its
many-block document jobs reach 670.7/1,036 ms and acknowledgement waits
278.7/328 ms in Chromium/Firefox, with 34 batches and the same 10,799 records.
Largest observed batches contain 320 records and 16,377 text units, within both
bounds. Largest viewport paint reaches 0.7/22 ms. Overall load-through-two-frame
windows still reach 1,817.1/2,532 ms; normalization reaches 228.6/421 ms, document
model creation 153.1/350 ms and syntax preparation 203.2/309 ms. These maxima
aren't paired timings to sum and don't remove overall completion failures.

For Firefox diagnostics, the existing test can also run with
`MOZ_PROFILER_STARTUP=1 MOZ_PROFILER_STARTUP_FILTERS=GeckoMain
MOZ_PROFILER_STARTUP_FEATURES=js,stackwalk,leaf
MOZ_PROFILER_SHUTDOWN=/tmp/sambee-firefox-retained-profile.json`, restricted to
one many-block fixture/width and `--project=firefox`. Read the emitted profile's
content-process User Timing markers to align search stages with the test samples;
the browser/parent process alone won't contain them. Keep this separate from
unprofiled acceptance and forced-GC runs. The diagnostic passes, but profiling
adds overhead and its samples aren't performance acceptance.

The aligned first-key window contains React input processing, layout and GC,
including minor collection and major-GC marking, with no overlapping retained
viewport paint. That doesn't establish matcher CPU as the cause or justify
disabling animation/GC, warming away the first key or reducing the fixture.
The final unprofiled Firefox many-block keyboard two-frame pooled p95 is 71 ms
and maximum 76 ms; Chromium reaches 27.7/30.7 ms. Maximum timer gaps remain
131/84 ms. Startup batching therefore improves startup, not proven input latency.
The next investigation should separate normalization/model startup costs and
Firefox's first-input React/layout/allocation work before changing either path.

Verification passes 231 affected unit tests, the full 54-case retained matrix,
both structural/native document proofs, all six native-contract comparisons
against the unchanged corrected default baseline, lint and touched-file
diagnostics. Two restored-normal-build browser smoke checks pass. Both builds
and documentation checks pass; the existing large-chunk warning remains. Normal
production assets are restored. No performance, aggregate-memory, physical-device
or manual interaction gate is waived, and ReactMarkdown remains the default.

## Constraints And Low-Cost Approach

Preserve behavior and meet measured budgets. Prefer existing code and the smallest
verified change; adopt prototype components only where simpler changes fail.
Editing optimization is performance-driven: eliminating all per-keystroke
serialization is not a separate acceptance requirement. This does not relax
correctness, recovery, regex containment or the agreed performance budgets.

- Preserve existing Save, discard and best-effort synchronous recovery, including
  the current debounce, pagehide/pre-sign-in attempts, limits and warnings.
  Authentication changes, recovery UI, checkpoint scheduling, stronger recovery
  guarantees and lifecycle/journaling redesign are out of scope. Do not connect
  the experimental checkpoint scheduler. Defer an optimization that needs it.
- Retain the engine-neutral language/range/fallback contract: unchanged UTF-16
  source offsets, ordered non-overlapping ranges, explicit plain-text outcomes,
  cancellation and no engine objects or DOM in public prepared data.
- Reuse the current parser registry, tag mapping, theme variables, native editor,
  caches and dedicated workers. No second parser, regex Markdown parsing,
  provider registry, worker pool or parallel theme store. Follow the dependency
  workflow only if a measured gap actually requires a dependency change.
- Keep the eight syntax roles in the existing theme system. Entirely absent
  legacy syntax groups receive central mode defaults without mutation or writes;
  supplied groups remain strictly validated. Theme changes must not reparse,
  remount editors, replace token/text nodes or disturb search/selection/scroll.
- Prefer fixes in the owning code and existing test/proof files. Stop extending
  prototypes once the relevant uncertainty is resolved. A renderer migration is
  justified by failing measurements, not by completing an architecture diagram.
- Retained lightweight text DOM is the approved preview direction. Bound expensive
  syntax/search presentation and layout; do not require strict off-screen text
  removal. Whole-document text DOM/memory growth must still be measured.
- No cumulative source/block cutoff, truncated content, silently disabled browser
  interactions or fallback to the known blocking token-span publication path.
  Changed behavior or relaxed acceptance needs explicit approval.

## Remaining Work

Begin with attribution, then choose the slice that addresses the measured
bottleneck. The numbered sections are work areas, not a mandatory sequence:
renderer work need not wait for unrelated editor/search changes. Validate each
slice before widening scope; share existing machinery rather than creating
separate infrastructure projects.

### 1. Attribute The Remaining Viewer Stalls

Extend the existing production-viewer check to separate initial render/commit,
search indexing, marker application/clearing, layout and syntax refresh costs.
Include search already active when preparation completes, changed queries,
next/previous, scrolling and document switching. Measure real keyboard response,
not only worker completion or timer servicing.

Keep the current renderer and DOM-search indexing semantics initially. Separate
logical matches from visual markers, then try viewport-only CSS Highlights instead
of inserting/removing a DOM marker for every match. Cache the index while preview
content is unchanged. Measure DOM capture separately from matching: capture must
stay on the main thread and may need yielding; workers receive only text and
numeric positions, never DOM nodes. Move matching to cancellable background work
only if measurements require it.
Adopt prototype mappings only where this smaller change fails. Integrate the
streamed renderer in step 4 only if initial rendering/layout also misses budgets.
Do not build another renderer prototype or rewrite working syntax publication.

### 2. Meet Editing Budgets With The Smallest Safe Change

Measure serialization, normalization and parent updates separately in text,
Markdown source and nested table editing. Remove redundant work and cache unchanged
results first. Per-edit full-string handoffs or normalization may remain where
they meet the agreed typing budgets across the tested document/structure envelope.
Measure growth with document size; a pass is not an arbitrary-size guarantee.

Keep CodeMirror documents/transactions authoritative. If those costs cause a
budget failure, replace the affected boundary with revisions/changes where safe.
Debouncing a callback after `toString()` does not reduce serialization cost.

Reuse existing immutable snapshots and flush handles at Save, recovery,
preview-transition and draft download/share boundaries. Flush pending IME/table
edits and serialize the required revision without losing unchanged-source or
canonical table serialization behavior. Measure snapshot cost as well.

Preserve dirty-state and baseline synchronization. A successful Save acknowledges
only its revision; edits made during Save remain dirty. Recovery does not mark a
file saved. Snapshot/worker failure must leave the live document usable. Defer
any part that cannot preserve the synchronous recovery contract above.

Gate: measured typing responsiveness within the agreed budgets/envelope, plus
latest-edit Save, edits-during-Save, undo/redo, IME, table flush,
preview/share/download, explicit discard and recovery failure/boundary regressions.

### 3. Finish Search Without Another Search Framework

Reuse the existing native-search cache and public CodeMirror commands. Make first
counts asynchronous/cancellable, keyed by immutable document revision and full
query/options identity. Pending counts must not look exact or block navigation.
Keep selection-only and viewport-only work bounded even while metrics are pending.

Promote the proven dedicated-worker boundary for every source regex path:
counting, next/previous, active/visible decorations, replace-one and replace-all.
Do not leave native synchronous regex commands exposed after moving only counts.
Terminate/restart a stalled worker; an abort message cannot interrupt a running
regex. Define timeout/cancellation feedback and bound source/result transfer.

Before applying navigation or replacements, validate document, query and relevant
selection identity. Bound replacement-plan delivery and main-thread application;
cancelled/stale plans apply no partial edits. Preserve capture expansion,
case/whole-word options, zero-length behavior and one-step replace-all undo.
Reuse native matcher/replacement logic rather than copying it.

Before completing worker integration, prove the final atomic replace-all commit
meets budgets, including transaction processing and editor/parent updates.
Worker preparation cannot bound that synchronous cost. Revalidate identity
immediately before dispatching once. If it fails, resolve an explicitly approved
policy before applying edits; do not silently cap replacements or apply partial
changes to satisfy timing.

For preview search, start with the existing DOM index and preserve its rendered-text
semantics, not raw Markdown. Keep exact code whitespace, prose boundaries and
cross-token/fragment matches. Separate logical match positions from visual markers;
retain text-node/offset mappings for visible decoration and indexed navigation.
Reuse the index across query changes; invalidate it on content generation changes
or text-node replacement, not syntax/theme-only painting. Yield main-thread capture
if needed and keep node mappings there; offload only worker-eligible computation.
If indexing or result retention misses budgets, reuse the prototype's rendered-text
index and bounded match windows rather than inventing another implementation.
Reject stale query/document results. Neither path may require mounting a marker
for every match, and retaining the DOM index is not a claim that it scales adequately.

Gate: deterministic no-recount/viewport traversal tests, exact settled counts,
pending navigation and stale replacement tests; actual catastrophic regex
termination/restart during every affected operation with keyboard input serviced.

### 4. Integrate Retained-Text Rendering Where Measurements Require It

If step 1 confirms initial rendering/layout is a blocker, promote the existing
whole-Markdown model, worker and publisher rather than introducing another
virtualizer or generic document abstraction. Parse once per generation; retain
stable semantic text nodes and publish in bounded, paced tasks. Keep React and
imperative descendant ownership separate; never reconcile search-mutated text.

Preserve GFM, table-cell line breaks, safe links/raw-HTML handling, exact whitespace
and selection/copy semantics. Subdivide large code blocks, paragraphs, tables and
exceptionally long lines without changing content or semantic structure. Bound
layout/measurement as well as JavaScript; wrapping, width, images and fonts must
invalidate heights/anchors correctly. Do not assume `content-visibility` preserves
native selection across browsers; earlier Firefox checks disproved that.

Reuse priority publication for navigation to unpublished destinations. Report
partial versus complete publication honestly; retain selection, focus and scroll
anchors while earlier content arrives. Theme changes update local variables
without rebuilding the model or unchanged text.

Workers need generation/revision checks, bounded delivery and retained data,
startup/crash/decode failure handling, cancellation/termination and cleanup.
Frame waits must handle hidden pages and cancellation. Unsupported worker/CSS
Highlight execution needs an explicit safe plain-text or supported-environment
outcome, not silent return to the known blocking path.

Gate before replacing the live renderer: native selection across fragments,
cross-block copy, Select All, actual browser Find/reveal, focus/keyboard reading,
screen-reader reading, hash links and print/PDF output, plus image/font/width
changes and rapid supersession. Snapshot/a11y-tree or print-media-only tests do
not establish full assistive-technology or printing acceptance. Behavior changes
require approval rather than hidden workarounds.

### 5. Close Highlighting And Theme Acceptance

Complete the remaining alias/dialect audit and actual four-surface parser/token
parity for JavaScript/TypeScript, Python, SQL, shell and legacy modes. Check native
nested Markdown trees, neutral prose/unknown fences and unchanged source geometry.
Verify isolated cold/cached nested grammar readiness, depth/size guards,
loading/parsing failures, late shared-load rejection, cancellation and unrelated
block success. Static rendering/public exports must remain engine-neutral.

Finish light/dark/custom-alpha palette checks across all surfaces: computed
colors, search/selection contrast, neutral foreground, stable node/editor identity
and independently scoped variables. Verify existing theme-dialog picker/layout,
save/cancel/copy/validation/permissions at desktop/mobile widths; do not add a new
theme preview subsystem. Retain legacy import/API round trips and strict supplied
group validation. Follow the repository form/dialog pattern for any UI changes.

Keep lazy grammar chunks and public package imports. Recheck the provisional
100,000-UTF-16-unit per-block parsing safeguard using worker/resource measurements,
separately from rendering limits; test at/below/above it. The independent nested
Markdown depth limit is four levels. Neither value authorizes an aggregate cutoff
or claims unlimited-size responsiveness.

## Performance And Rollout Gates

Retain the required 54,000-unit/6,000-match dense fixture, a block near the parsing
safeguard and many eligible blocks exceeding 500,000 combined code units. Include
long lines, large prose/tables, nested Markdown and sustained editing/search/
navigation. Test production builds with fresh/cached grammars in Chromium and
Firefox at widths 1543/390 through `http://localhost:3000/browse/smb/demo` only.
Use response interception; do not modify stored demo files.

Approved provisional development-host envelope, tested separately: 24,000 code
lines across four blocks, 4,000 short formatted paragraphs or 2,400 two-column
table rows. These are representative fixtures, not a byte-size support guarantee
or permission to truncate larger files. Larger probes (including 72,000 code
lines and 4,800 table rows) still expose scaling failures.

| Metric | Approved Provisional Host Target |
| --- | --- |
| Document completion, load through two frames | At most 1,500 ms |
| First exact search including worker/index startup | At most 1,000 ms |
| Changed query on warm index / last-match navigation | At most 100 ms each |
| Maximum timer-service gap | At most 50 ms; scheduling proxy only |
| Loaded renderer JS heap, Chromium | At most 64 MiB; not total/peak memory |
| Shutdown growth across six warmed explicit-GC cycles | At most 1 MiB; zero owned DOM/highlights/live workers |

Use three trials per fixture/width/engine; missing or invalid required measurements
must fail rather than silently pass. Prototype budget passes do not establish
live-viewer acceptance. Do not raise deadlines, select smaller fixtures or compare
development with production to hide failures.

Remaining acceptance also includes actual input-to-visible-response (target p95
below 50 ms), no application-controlled interaction-blocking task above 50 ms,
scrolling at the reference refresh-rate budget, timely first usable text and
highlight completion, and peak renderer/worker/native memory. Finalize any still
undefined completion/resource budgets and browser-support policy explicitly.
Reference physical mid-range mobile and assistive-technology results remain
unverified; a narrow desktop viewport is not mobile performance evidence.

Rerun affected editor/viewer/search/theme tests and frontend lint/build; run backend
theme tests when that contract is affected. Update applicable published docs when
behavior/contracts are finalized and remove obsolete proof-only paths after their
replacement is accepted. Stop when the relevant correctness and performance gates
pass; unrelated recovery experiments are not prerequisites.

## Existing Verification Entry Points

Use existing tooling, extending it only for missing evidence. Commands below are
from the repository root unless a working directory is stated.

```sh
# Actual production viewer; run from frontend/.
npm run build
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1

# Repeated attribution with inline stage/phase measurements retained in JSON.
SAMBEE_E2E_PRODUCTION=1 npm run test:e2e:all -- --grep 'production syntax publication' --workers=1 --repeat-each=3 --reporter=json

# Isolated syntax-publication comparison; excludes initial viewer rendering.
node frontend/scripts/markdown-syntax-publication-proof.mjs

# Existing whole-Markdown prototype strict host gate; repeat with
# SAMBEE_PREVIEW_PROOF_BROWSER=firefox for Firefox.
SAMBEE_PREVIEW_PROOF_DOCUMENT=1 SAMBEE_PREVIEW_PROOF_SCALE=1 SAMBEE_PREVIEW_PROOF_BUDGETS=1 SAMBEE_KEEP_PREVIEW_PROOF=1 node frontend/scripts/markdown-preview-performance-proof.mjs

# Source-regex worker feasibility; not live-editor containment acceptance.
SAMBEE_SOURCE_SEARCH_PROOF_BROWSER=chromium,firefox node frontend/scripts/source-search-containment-proof.mjs
```
