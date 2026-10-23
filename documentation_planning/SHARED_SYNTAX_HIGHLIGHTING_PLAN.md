# Shared Syntax Highlighting Completion Plan

Updated: 2026-10-23. **Items 1-6 are fully done. Merge and rollout
remain blocked by the unfinished checks in items 7-8.**

The user accepts large atomic Replace All latency with visible feedback (D5),
the recorded progressive Markdown preview-loading pauses (D6), the existing
Markdown editor table component's responsiveness (D8), the recorded Firefox
syntax-colour delay (D9), and the recorded Firefox code-display pauses (D10).
Item 4's native/browser/accessibility and physical-scrolling checks are finished
by user confirmation; its additional image/font/resize coverage was removed as
unnecessary. These are scoped decisions, not passing
performance measurements or release approval. Keep original thresholds and raw
failures unchanged. Item 5 is fully done by user instruction; item 6's scoped
resource investigation is now complete. Broader editing/recovery checks remain
under item 7, not duplicated as prerequisites for item 5's closure.

Remaining work: finish editing/recovery and the remaining native correctness
checks under item 7, obtain the remaining
physical-device/input evidence, reconcile published contracts, and make a
separate release decision under item 8. Do not restart declined
experiments or repeat completed work merely to close an accepted limitation.

## Goal And Boundaries

Finish shared syntax highlighting across text viewing/editing, Markdown fences
and Markdown source while preserving exact content, native interactions,
editing, search, Save and recovery. Fix measured causes without redesigning the
renderer or editor solely to satisfy a benchmark.

- Reuse CodeMirror, the shared language/token/theme contract, lazy grammars and
  dedicated cancellable workers. ReactMarkdown remains the sole whole-document
  renderer. No second parser/renderer, embedded preview editor, virtualizer,
  worker pool, registry, parallel theme store, generic scheduler or geometry
  cache without measured need and explicit approval.
- Preserve GFM, document-wide references/heading IDs, canonical table-cell
  breaks, safe links/raw-HTML policy, whitespace/UTF-16 offsets, selection and
  scroll anchors. Keep AST-based code collection and unchanged-content DOM search.
- Keep canonical trees immutable and paired with their exact source/generation;
  isolate mutating transforms. Unmatched edited sources use normal parsing.
  Do not remove cloning without an equally safe ownership design.
- Preserve one native replacement transaction, logical change mapping, history
  and undo/redo. Never truncate output, apply partial replacements, reset editor
  state or replace the whole document to hide native edit costs. No dependency
  fork, private transaction-field writes or prototype overrides are authorized.
- Preserve immutable snapshot/flush boundaries. Save acknowledges only its own
  revision; newer edits stay dirty. Keep recovery limits, warnings, debounce and
  pagehide/pre-sign-in attempts. Recovery never marks content saved; failures
  leave editing usable and content dirty.
- Keep the Worker requirement and startup/crash/decode/timeout handling. No
  synchronous fallback after worker failure. Preserve acknowledged source/result
  chunks of 16,384 units, syntax batches of 512 ranges, tree batches of 512
  records/16,384 string units with 2,048-unit fields, and the 2,000 ms source-regex
  startup/per-response deadline.
- Keep the 100,000-unit per-block parsing safeguard, four-level nesting limit,
  4,000 viewport syntax ranges and 1,000 preview-search ranges plus one active
  range. These are not aggregate content cutoffs. Missing highlight capabilities
  retain plain syntax or exact search counts/navigation, not per-match DOM edits.
- Keep eight theme colour roles and legacy defaults without schema changes or
  writes. Recovery/authentication redesign and the experimental checkpoint
  scheduler remain out of scope.

## Decision Status

All approvals below were given by the user on 2026-10-23. D10 records item 4's
explicit closure and scope reduction. Other correctness, resource, manual and
overall release requirements remain unchanged except for D11's resource-scope
reduction below.

**Item 5 closure (user instruction, 2026-10-23):** dense-output and large-table
implementation, fixed workloads and functional verification are fully done.
Remaining cross-cutting resource/disposal and editing/recovery/native-input
acceptance stays solely in items 6 and 7. This closure neither claims new tests
or measurements nor waives those independent checks or approves release.

| ID | Approved Scope | Completion And Boundaries |
| --- | --- | --- |
| D5 | Accept noticeable large atomic Replace All latency, with visible busy feedback. | Item 2 fully done, including replacement mapping/history coverage. Native application optimization is not a prerequisite. Unrelated source-search, typing, publication and resource gates remain required. |
| D6 | Use bounded progressive loading for very large rendered Markdown; accept the recorded prose/table preview-loading pauses. | Item 3 fully done. All 24 trials complete within 1,500 ms; 19 exceed the unchanged 50 ms timer-gap limit, worst 128 ms. These failures are accepted limitations, not passes. No further optimization or approval is required for these results. Item 4's separate code-display gaps, longer future delays, other workloads and missing native/resource/manual evidence are not covered. |
| D7 | Conditional offscreen-rendering proposal, not approved. | Not required by current attribution. Any experiment needs fresh evidence and explicit approval; no virtualizer or geometry cache is authorized. |
| D8 | Use the existing WYSIWYG Markdown table component as is; accept its responsiveness limitations. | Table-component timing is diagnostic and non-blocking for shared syntax highlighting. No upstream optimization, dependency change, local fork or layout experiment is required. Exact input, Save, history, composition and resources remain required. Preview loading and source/non-table timing are not covered. |
| D9 | Accept the ten recorded Firefox many-block syntax-colour samples at 1,511-1,579 ms against the 1,500 ms target. | Readiness and item 1 fully done. All 120 cold/warm samples were collected; 110 meet the target, text is usable within 863 ms and full syntax preparation within 1,579 ms. Longer future delays, other workloads and interaction pauses are not covered. |
| D10 | Accept the four recorded Firefox desktop code-display gaps of 51-59 ms; remove additional delayed-image/font/resize and scroll-anchor coverage as unnecessary; mark item 4's browser-menu Find/reveal, clipboard, assistive-technology and physical-scrolling checks finished. | Item 4 fully done by user decision/confirmation. Keep the four raw timing failures and the 50 ms limit. No further optimization, removed coverage or repeat of these completed checks is required solely for closure. No new automated measurements or device/AT details are claimed. Remaining editing/IME, phone, print, resources and release gates are independent. |
| D11 | Remove item 6's staged memory measurements, peak-memory acceptance and fixed six-cycle shutdown protocol as unnecessary. | Item 6 covers only investigating and fixing memory/resource leaks; that scoped work is now complete as recorded below. Removed measurements, numerical memory ceilings and cycle counts are no longer release gates; do not reinstate them elsewhere or report them as passed. No exhaustive leak-free result or release approval is implied. |

The asynchronous preview-preparation integration was **declined**. Do not resume
its feasibility spike or implementation without a new scope decision. Retain
the current progressive renderer and canonical-tree isolation. D6 now accepts
the recorded loading pauses; it does not authorize that declined work.

For any additional exception, present current measurements, attribution,
attempted bounded fixes, affected engine/fixture/operation and user-visible
impact for explicit approval. Prefer a narrow documented exception over a
renderer redesign solely to meet a gate. Retain the original failed verdict
alongside the approval and revised acceptance treatment. Process approval alone
waives no requirement and approves no limited rollout.

## Current Verification Inventory

These are the latest applicable results. Item 6 records new cleanup verification;
the earlier timing and manual results were not rerun for that investigation.
Overlapping test runs must not be added together. Reports under `/tmp` are local
evidence, not durable release artifacts; retain/export them before cleanup.
Superseded tuning runs and investigation logs are not part of this active plan.

| Check | Current Evidence | Remaining Limitation |
| --- | --- | --- |
| Production functionality | 264/264 cases across Chromium/Firefox and widths 1543/390, plus 2/2 semantic/native cases at the default viewport; no skips/retries. Language/theme, nested failures/safeguards, worker failures, source regex/lifecycle, printing, cancellation, dense expansion and all seven table actions covered. | Broader recovery/native combinations, physical input and resources remain independent. |
| Readiness | 60/60 trial identities, 120 cold/warm samples; 54 trials pass, six fail. Ten samples exceed 1,500 ms as specified in D9; all meet 3,000 ms full preparation. | Accepted under D9; raw failures remain failures. |
| Code publication | 56/60 timing passes; all complete within 861 ms. Four Firefox desktop gaps: host-envelope trials 0/1 at 53/51 ms, long-line trial 0 at 59 ms, many-blocks trial 1 at 55 ms. | Accepted under D10; raw failures remain failures and item 4 is fully done. |
| Item 4 native checks and scrolling | Browser-menu Find/reveal, OS clipboard, assistive-technology and physical-scrolling checks marked finished by the user on 2026-10-23. Additional image/font/resize coverage removed as unnecessary. | User-confirmed completion, not a new automated run. Device, refresh-rate, AT and detailed fixture results were not supplied; do not infer a broader support matrix. |
| Prose/table preview | All 24 loads complete within 1,110 ms; first viewport within 761 ms. Five timing passes, 19 failures at the 50 ms gap gate; maximum 128 ms. | Accepted under D6; item 3 fully done. |
| Source typing | 24/24 timing passes; keyboard two-frame p95 <=36 ms, gap <=39.9 ms, serialization <=1 ms, synchronous publication <=2 ms. Exact Save verified. | Browser scheduling probes do not establish physical input/paint response. |
| Source responsiveness | 24 trials complete exact output/history/Save/disposal; raw timing 1 pass/23 failures. Atomic apply <=333.4 ms, gap <=348.4 ms; 18 atomic and 23 gap measurements fail. Serialization <=2.2 ms, synchronous publication <=0.7 ms. | D5 accepts atomic application latency only, not unrelated gaps or new attribution. |
| Replacement correctness/feedback | 70 affected tests and 16 production regex parity cases pass after preserving individual adjacent-change boundaries. Includes 256 deterministic actual-worker edit/search steps, all case/whole-word settings, custom word characters, mapped positions and undo/redo. Eight production feedback cases verify visible pre-apply feedback and cleanup. | Item 2 complete; not blanket editing, physical-input or resource acceptance. |
| Dense expansion | Fixed functional cases verify exact output, bounded transport, one native operation/history, undo/redo and multipart Save. All 24 enforced timing trials fail. Item 5 fully done by user instruction. | D5 accepts atomic application latency, not unrelated timing. Independent resource checks belong to item 6; remaining recovery/native correctness belongs to item 7. |
| Large-table editing | All 28 fixed functional cases pass, preserving exact Save, focus, clean state and editor/worker disposal. Latest 12 enforced line-break trials all fail; 248 focused tests pass at that checkpoint. Item 5 fully done by user instruction. | D8 accepts component responsiveness. Item 6 owns remaining resource/disposal acceptance; item 7 owns broader editing/recovery and physical-input checks. No new run is claimed. |
| Composition and close flush | Four composition Save and eight immediate Close-to-Save browser cases pass. Focused coverage includes failed/delayed writes with newer edits and out-of-order results across three documents. | Chromium composition-end is untrusted; Firefox browser text insertion emits its own composition lifecycle. Neither is physical IME evidence. |
| Print/PDF | 24 printing and 12 native browser cases pass; 12 Chromium printing PDFs contain complete text/images and six native PDFs complete text. Representative first/last pages visually inspected. | Actual Firefox PDF, physical output, phone print UI and remaining manual checks are unverified. Visual checks do not cover every page. |
| Regression/build checks | 418 tests in 13 existing unit/component files and 50 evaluator regressions pass at the item 1 checkpoint. Later item 2 verification passes its 70 affected tests/16 browser cases. Normal production build, frontend lint, docs and whitespace validation pass. | Not one combined test total or a claim that a separate stricter app-project TypeScript invocation is clean. Existing Vite large-chunk advisory remains. |
| Resources/remaining manual acceptance | Item 6's ownership investigation and source-regex cleanup fixes are complete: 310 tests across seven existing unit/component files and 24 production browser cases pass. Item 4 manual checks are user-confirmed complete. | No exhaustive heap-retention proof is claimed. Peak/growth measurements and fixed-cycle acceptance were removed under D11, not passed. Remaining phone, physical typing/IME, editing and printing evidence stays open; do not reopen item 4's completed checks. |

Current evidence references:

- `/tmp/sambee-final-current-functional-complete.json` and
  `/tmp/sambee-final-current-semantic-native-complete.json`.
- `/tmp/sambee-final-current-readiness-complete.json`.
- `/tmp/sambee-final-current-timing.json`, with lossless slice reports
  `/tmp/sambee-final-current-<slice>.json` for `publication`, `prose-table`,
  `source-typing` and `source-responsiveness`; corresponding `-verdict.json`
  and `-verdict.log` files retain evaluator results.
- `/tmp/sambee-final-current-printing-only.json` and
  `/tmp/sambee-final-current-native-only.json` retain the fixed PDF matrices.
- `/tmp/sambee-replacement-feedback.json` and
  `/tmp/sambee-replacement-regressions.json` retain feedback and adjacent
  replacement checks; targeted mapping follow-up results are summarized above.

Automated environment: Debian 13, x86_64 Linux
6.18.33.2-microsoft-standard-WSL2, Intel Core Ultra 9 285, 12 exposed CPUs,
31 GiB exposed RAM; approximately 24 GiB available at sampling. Production
engines: Chromium 156.0.8078.4 / Firefox 157.0. These virtualized observations
do not establish physical-device, display-refresh or power-mode measurements.

## Completion Checklist

### 1. Restore Reproducible Acceptance Coverage

**Fully done.** Test registrations, report-identity enforcement, resource/manual
inventory and available current-build verification are complete. Readiness is
accepted under D9. Missing resource/manual evidence belongs to the remaining
items, not a reopening of this inventory.

### 2. Provide Atomic Replacement Busy Feedback

**Fully done.** User-confirmed feedback and targeted replacement correctness
coverage are complete. Ordinary literal replacements remain immediate. Worker
preparation shows feedback after 200 ms; quick completion cancels it. The heavy
gate is at least 1,000 replacements and at least 50,000 source or inserted
UTF-16 units. Heavy plans, or already-visible feedback, receive two animation
frames before their single native apply. Revalidate source, query, selection and
writability after yielding; prevent duplicates and clear feedback on all terminal
paths. Preserve hidden-tab completion, reduced motion and accessible status.

No minimum display duration, blanket delay, split transaction, document reset or
history-policy change is permitted. Feedback may stop animating during synchronous
application; it does not promise input responsiveness. D5 accepts that latency.

### 3. Implement Progressive Rendered Markdown Loading (D6)

**Fully done (user acceptance, 2026-10-23).** Implementation and scoped functional
verification are complete. The user accepts the recorded prose/table preview
loading pauses: 19/24 trials exceed the 50 ms timer-gap limit, worst 128 ms,
while all loads finish within 1,500 ms. No further optimization or acceptance
decision is required to close item 3. Keep raw failures and original limits;
do not relabel them as performance passes.

The implemented contract remains:

- Sources of at least 50,000 UTF-16 units use `ProgressiveMarkdown`, staging the
  existing ReactMarkdown pipeline's whole-document transformed tree. Ordinary
  documents retain their immediate path; no independently parsed fragments or
  second renderer are introduced.
- Batches are capped at 1,024 structural nodes and 8,192 text units. Large tables,
  containers and code subdivide internally while retaining native elements and
  earlier nodes. Target two viewport heights initially; subsequent frames use
  the existing 4 ms elapsed-work check and at most four committed batches,
  without repeated height reads. These cooperative checks cannot preempt a
  single transform, commit or native layout.
- Cancel stale publication on source/rendering-configuration changes and
  disposal; use timers for hidden-tab completion. Reading and Close remain
  available. Search/counts, editing, heading navigation and toolbar printing
  wait for the complete generation; syntax/search indexing starts afterward.
- Accessible loading feedback appears after 200 ms with no minimum duration
  and respects reduced motion. Browser-menu printing while incomplete shows a
  loading notice rather than partial content.
- Whole-document cloning/transforms and browser layout remain synchronous.
  Canonical-tree isolation is retained. Asynchronous preparation remains
  declined and is not unfinished work.

Coverage includes complete references/headings, safe HTML/links, Unicode, one
transform, stable earlier DOM, table/code subdivision, ordinary documents, Strict
Mode, hidden tabs, source/configuration changes, cancellation, failures, pending
controls and complete printing. Item 4's separate code pauses and native/scrolling
checks are now closed under D10, not D6. Remaining resource, physical-input,
editing, phone, printing and release checks stay independent.

### 4. Resolve Native Layout And Scrolling Costs

**Fully done (user decision/confirmation, 2026-10-23; D10).** Current-engine
profiling, bounded syntax publication and progressive pacing, fixed functional
selection/search/stable-node/scroll checks and automated native/printing
regressions are complete. Retain these changes.

- [x] Accept the four recorded Firefox desktop code timer gaps of 51-59 ms.
  Preserve their raw failed verdicts and the original 50 ms limit; no additional
  optimization or approval is required for these recorded pauses.
- [x] Finish actual browser-menu Find/reveal, OS clipboard and
  assistive-technology checks, as confirmed by the user.
- [x] Finish physical-scrolling checks at the display's native refresh rate,
  as confirmed by the user.

The user removed additional delayed-image/font, width-change and scroll-anchor
coverage as unnecessary. It is no longer an outstanding acceptance requirement.
This removes a test obligation, not the requirement to preserve correct content,
selection, highlights and scrolling or fix a demonstrated regression.

Manual completion is recorded from the user's instruction, not a new automated
run; no device, refresh-rate or AT measurements are invented. Item 7 must not
reopen these completed checks without an affected change or new failure.
No offscreen-rendering experiment is required or approved; D7 still needs fresh
evidence and explicit approval. Resource, remaining editing/input/phone/printing
checks and release approval remain independent.

### 5. Cover Dense Output And Large-Table Editing

**Fully done (user instruction, 2026-10-23).** Fixed workloads, dense-output and
large-table implementation, and their scoped functional verification are
complete. No further item 5 implementation or approval is required.

Retain worker-based canonical edit normalization and
source-preserving snapshot serialization, revision-safe Save/recovery/exit,
ordered AST-aware segment assembly and fixed production functional checks.
Preserve one active job and one replaceable latest request, exact
source/baseline/policy/generation ownership, explicit retry, cancellation and no
synchronous fallback. Worker acknowledgements must not replace newer native
content or recreate nested table editors. Snapshots flush nested publication and
capture immutable matching bytes; pending/failed synchronous capture rejects
rather than returning stale content. Keep layout-phase controlled-value guards.

The fixed dense-expansion cases verify exact output, bounded transport, native
history/undo/redo and Save. All 28 fixed table-editing cases pass. D5 accepts
atomic replacement latency; D8 accepts existing table-component responsiveness.
Retain raw timing failures rather than recording performance passes. Further
table-performance optimization is optional separate work.

Cross-cutting acceptance has one owner per checklist: item 6 covers memory and
resource leaks, including dense replacement and table editing; item 7 covers
remaining editing/recovery/native correctness and physical IME. Those checks
are complete under item 6 and remain open under item 7, not as duplicate
unfinished work here. Closing item 5 does
not claim new measurements, accept lost input or stale Save, establish leak-free
cleanup, or approve release. D11 separately removes quantitative memory gates.
Do not repeat completed replacement or fixed table
coverage merely because item 7 remains open.

### 6. Investigate Memory And Resource Leaks

**Fully done (2026-10-23).** The scoped ownership investigation and demonstrated
retention fixes are complete, including dense replacement and large-table
normalization. This is leak investigation, not a requirement to reduce normal
memory use or a claim that every possible leak has been excluded.

- [x] Investigate surviving viewer-owned resources and retaining paths. Include
  obsolete DOM/highlights, workers, listeners, observers, handlers, buffers and
  snapshots after completion, cancellation, failure, file/theme changes or Close.
- [x] Fix demonstrated leaks at their owner and verify affected teardown paths.
  Preserve required editor history, exact search results and immutable snapshots;
  centralize idempotent cleanup only if evidence requires it.

The user removed staged memory measurements, peak-memory limits and the fixed
six-cycle shutdown protocol as unnecessary (D11). No replacement numerical
budget or mandatory repeated-cycle matrix is introduced. Existing heap/process
tools may support a concrete leak investigation but are not separate acceptance
tasks. High memory use or a single post-Close sample alone does not prove a leak;
do not discard live document data or legitimate shared caches to lower a number.

Investigation and fixes:

- A live source-regex session retains its cancellation closure. Previously that
  closure retained the terminated Worker and its message/error handlers. Transport
  cleanup now detaches all owned handlers and clears the worker reference on
  completion, failure, cancellation and editor destruction. Four new regression
  cases failed before the fix and pass afterward.
- The same closure could retain assembled replacement/announcement chunks after
  cancellation or application. Terminal cleanup now clears these buffers while
  keeping them alive until a pending atomic apply finishes. Exact native history,
  search results, immutable snapshots and delayed feedback remain unchanged.
- Reviewed syntax publication, viewport search, progressive publication,
  preparation/syntax worker clients, rich-editor normalization and viewer effects.
  These owners disconnect observers, remove listeners/highlights/styles, cancel
  scheduled work, abort stale jobs and release normalization snapshots/queues at
  teardown. Existing tests cover source/theme changes, late results, failed jobs,
  cancellation and Close; no additional demonstrated leak was found in this review.

Verification: 310 tests across the existing `TextCodeEditor`, `markdownSyntax`,
`domTextSearch`, `ProgressiveMarkdown`, `MarkdownViewer`, `TextViewer` and
`MarkdownRichEditor` suites pass. The 24 existing production source-regex lifecycle
and regex replacement-feedback cases pass in Chromium and Firefox at widths
1543/390, with no retries or skips. They verify startup/crash/decode/timeout and
late-delivery cleanup, zero live workers after Close, and exact Save content.
Report: `/tmp/sambee-leak-cleanup-regression.json`.

This evidence is ownership review and behavioral cleanup verification, not a heap
snapshot or a measurement of all browser-retained objects. No unresolved concrete
leak remains from this investigation; demonstrated future retention still requires
investigation. Shared grammar caches, required history and live snapshots were not
discarded to reduce memory use. No published user-facing contract changes.

### 7. Finish Editing And Native Interaction Acceptance

This item owns remaining editing/recovery/native-input acceptance, including
large-table and dense-replacement combinations not established by existing
evidence. Item 5 is closed; identify actual gaps without reopening its completed
implementation, fixed functional cases or item 2's replacement coverage.

- [ ] Reproduce and resolve the unverified close-after-theme-refresh observation;
  test rapid switching between distinct documents and late worker completions.
- [ ] Complete remaining latest-edit Save, edits during delayed Save, failed
  Save, undo/redo, table/IME flush, preview/share/download, discard and
  recovery/snapshot failure combinations. Reuse existing passing cases and
  deterministic delayed responses; do not reopen completed replacement coverage.
- [x] Complete browser-menu Find/reveal, OS clipboard and assistive-technology
  checks covered by item 4, by user confirmation under D10. Do not duplicate them
  as open work here.
- [ ] Finish remaining native cross-block selection/Select All, editing
  keyboard/focus, headings and complete print/PDF combinations not established
  by existing evidence or item 4's confirmed checks. Retest completed native/AT
  behavior only after an affected change or new failure.
- [ ] Complete remaining real-phone and physical keyboard/IME checks; record
  hardware, OS/browser and power mode where applicable. Item 4's physical
  scrolling and accessibility checks are finished, not pending device tasks.

**Done when:** all required automated/manual interactions are evidenced; failures
leave editing usable and newer edits dirty. Preserve completed representative
manual evidence unless an affected change or new failure requires retesting.
`window.find`, Range selection, narrow desktop viewports and semantic snapshots
do not substitute for browser-toolbar, clipboard, phone or AT acceptance.
Chromium proxy Find reveal remains diagnostic-only; exact selection remains
required in both engines and Firefox proxy reveal remains enforced.

### 8. Complete Final Verification And Documentation

- [ ] After fixes, run the affected unchanged production matrix and missing
  correctness/theme/worker, timing, leak/cleanup and native checks. Accepted results
  need no rerun solely because items 1-6 are marked complete. Do not reinstate
  image/font/resize coverage removed under D10 or quantitative memory/fixed-cycle
  checks removed under D11.
- [x] Check actual Chromium PDF text/images and representative first/last pages.
  Actual Firefox output, phone print UI and physical printing remain unverified.
- [x] Run the recorded focused unit/component tests, normal production build,
  lint, documentation and whitespace checks. Later code fixes need fresh affected
  checks; run backend theme tests only if that contract changes.
- [ ] Reconcile published behavior and limitations under `website/content/docs/`
  using the `docs-update` skill, including approved acceptance policies.
  This planning cleanup changes no application behavior.
- [ ] Record a separate merge/rollout decision after required gates pass or
  explicitly named exceptions/revised criteria are approved. Missing tools or
  passing subsets never silently waive a requirement.

**Done when:** evidence and published contracts agree, all release gates are
satisfied or explicitly revised, and the release decision is recorded.

## Required Fixtures And Applicability

Use existing constants/helpers in `frontend/e2e/markdown-viewer.spec.ts`; do not
resize fixtures after observing results or create a new benchmark framework.
Unless explicitly narrowed, required gates apply independently to Chromium and
Firefox, widths 1543/390, every applicable fixture and supported text view/edit,
Markdown preview/source/rich-edit surface. A narrow viewport is not phone evidence.

| Fixture Family | Fixed Workload And Scope |
| --- | --- |
| `SYNTAX_PUBLICATION_FIXTURES` | `dense`: 6,000 lines; `near-safeguard`: 11,111 lines; `host-envelope`: four 6,000-line blocks; `many-blocks`: 600 blocks of 101 lines, exceeding 500,000 combined code units; `long-line`: 6,000 repetitions on one line. Publication/readiness registrations measure Markdown preview, not text/source/rich-editor timing. Native/correctness/resource gates apply on supported surfaces. |
| Dense source/expansion | Both `("abc 123;\n").repeat(6000)` (actual newlines) and `("abc 123; ").repeat(6000)`: 54,000 UTF-16 units and 6,000 matches each. Replace `abc 123` with 128 ASCII `x` characters, yielding exactly 780,000 units. Preserve smaller parity cases, mapping, history, cancellation, Save and resources. |
| Prose/table envelope | `PROSE_ENVELOPE_PARAGRAPHS`: 4,000 formatted paragraphs; `TABLE_ENVELOPE_ROWS`: 2,400 two-column data rows. Preserve exact content, selection/search, scrolling, printing and resources. D10 removes additional image/font/resize and scroll-anchor test coverage, not correctness. No eligible fences makes fence syntax readiness not applicable, not other gates. D6 accepts recorded loading pauses only. |
| `TABLE_EDIT_CASES` | Seven independent cases: first/middle (row 1,200)/last column-one cell typing of `table edit`, line-break, composition, close-flush and composition-close. Keep fixed input sequences, initial cells and exact canonical Save bytes. D8 changes responsiveness acceptance only. |
| Shared language fixtures | `js`, `ts`, `py`, `sql`, `sh`, `ps1`, `json`, `c` across registered surfaces; `mssql`/`mariadb` fence aliases. Include theme/state and grammar failures. Alias-only cases do not establish filename-based text-view support. |
| Ordinary/nested/boundary cases | Below/at/above 100,000-unit safeguard, nested failures/depth, exact plain fallback, independent eligible blocks, safe links/HTML, UTF-16 offsets and cancellation. Above-safeguard rejected blocks require exact plain content, not tokens. |

Fixed stress fixtures are not general byte-size support guarantees. Retain larger
scaling failures without making exploratory variants mandatory. Do not demote an
existing required fixture without specific approval.

## Acceptance Criteria

The timing limits below remain unchanged. D5/D6/D8/D9/D10 alter timing acceptance
only within their recorded scope; accepted failed measurements remain failed.
D10 removes additional invalidation coverage and records item 4's manual
completion. D11 removes quantitative memory and fixed-cycle acceptance; item 6
retains only leak investigation and verification of demonstrated cleanup fixes.

| Metric | Required Limit |
| --- | --- |
| Text load / first usable exact text | Each <=1,500 ms from browser file-open; complete exact content with selection/search enabled and two subsequent frames. Initial fragments/two viewport heights are not full completion. |
| First visible syntax | <=1,500 ms with complete expected initial visible token coverage; D9 accepts the ten recorded Firefox samples. |
| Full syntax preparation | <=3,000 ms; every requested block settled, host receipt complete and initial visible publication through two frames. |
| First exact search | <=1,000 ms, including startup/indexing. |
| Warm changed query / last-match navigation | <=100 ms each, from user action through exact readiness/visible reveal and two frames. |
| Timer-service gap / source atomic dispatch | <=50 ms each; scheduling proxies do not establish CPU ownership. Apply scoped D5/D6/D8/D10 exceptions without rewriting results. |
| Serialization / synchronous publication | <=50 ms each; overlapping stages are not additive. |
| Typing proxy / physical input-to-visible-response | Per-trial p95 strictly below 50 ms; proxy passes do not establish hardware response. |
| Application-controlled interaction-blocking task | No task above 50 ms, subject only to explicit scoped acceptance decisions. |
| Physical scrolling at refresh rate R | One-frame p95; no application-attributed interval above two frames (16.7/33.3 ms at 60 Hz). Item 4 checks finished by user confirmation under D10; no new measurements claimed. |
| Memory/resource leaks | Investigate unwanted retention and verify fixes under item 6. No staged/peak-memory ceilings, fixed cycle count or quantitative shutdown-growth gate under D11. |

Evaluate every required sample independently; never average across engines,
widths, fixtures or trials. Missing/invalid/duplicate identities, skips, retries
or diagnostic-only evidence do not establish a pass. Each fixture/gate pair
must be required, diagnostic under a named decision, or not applicable with a
reason. Unavailable tooling is unverified, not not-applicable. Correctness and
native regressions always block acceptance.

Fix typing/scrolling sequences and populations before collection. Compute p95
per trial as sorted rank `ceil(0.95 * count)`; retain count, maximum and raw
samples. Dropped input/incomplete actions fail correctness, not sample exclusion.

## Owners And Tool Limitations

Automated execution owner: **Copilot**, using the existing frontend harness.
Remaining physical-device/input execution owner: **unassigned**; no phone or
physical IME session has been supplied to the automated owner. Item 4's native,
assistive-technology and physical-scrolling checks are user-confirmed finished
under D10; detailed device/AT measurements were not supplied. Other missing
capabilities remain unverified and release-blocking unless specifically accepted.

| Gate | Available Capability | Outstanding Evidence |
| --- | --- | --- |
| Memory/resource leaks | Ownership review, fixed lifecycle assertions and 24 production browser cleanup cases complete under item 6; Chromium CDP/heap inspection and OS process tools remain available for concrete future diagnosis. | No outstanding scoped item 6 check. No exhaustive heap proof is claimed; unavailable peak/GC tools do not create standalone release gates. Release harness references before attributing future retention to the viewer. |
| Native/manual interactions | Automated focus/ARIA/heading/selection and fixed browser tests; item 4 Find/reveal, clipboard and AT checks finished by user confirmation. | Remaining editing focus/IME, selection, phone and print combinations under item 7. Do not invent a version/fixture support matrix or reopen confirmed checks merely because detail was not supplied. |
| Scrolling | Existing scripted checks; physical-scrolling completion confirmed by the user under D10. | No outstanding item 4 check. Additional image/font/resize and scroll-anchor coverage was removed as unnecessary; demonstrated regressions still require correction. |
| Print/PDF | Complete Chromium PDF text/image checks and representative page inspection. | Actual Firefox PDF, remaining visual/manual matrix, phone print UI and physical output. Preserve representative manual print evidence. |
| Save/recovery | Fixed source/table/history tests, delayed/failed writes, composition and immediate Close-to-Save. | Remaining item 7 combinations and physical IME. Chromium CDP start/input is trusted but composition-end is untrusted; retain this tooling limitation, not a correctness or physical-IME waiver. |

Continue bounded authorized implementation and available verification without
waiting for unavailable hardware. Do not build custom infrastructure solely to
hide a tooling limitation. Once available work is complete, present remaining
gaps together for an explicit choice: obtain evidence, continue blocking release,
or approve named revised criteria with published limitations. Never label missing
evidence passing or claim unsupported devices/capabilities.

## Reproduction And Verification Rules

Run frontend commands from `frontend/`. Use the existing production harness and
isolated fixture HTTP proxy at `http://localhost:3000/browse/smb/demo` only;
never edit stored demo content. Capture exact multipart Save bytes from the
proxy's complete request body. No new development server is needed.

```bash
npm run build
SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_HTTP_CACHE=1 PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-readiness.json npm run test:e2e:all -- e2e/markdown-viewer.spec.ts --grep 'production syntax readiness' --workers=1 --repeat-each=3 --retries=0 --reporter=json
SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-timing.json npm run test:e2e:all -- e2e/markdown-viewer.spec.ts --grep 'production (syntax publication.*preserves active search and selection|prose table responsiveness|source typing|source responsiveness)' --workers=1 --repeat-each=3 --retries=0 --reporter=json
SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-expansion.json npm run test:e2e:all -- e2e/markdown-viewer.spec.ts --grep 'production source dense expansion' --workers=1 --repeat-each=3 --retries=0 --reporter=json
SAMBEE_E2E_PRODUCTION=1 SAMBEE_E2E_BUDGETS=1 PLAYWRIGHT_JSON_OUTPUT_FILE=/tmp/sambee-table.json npm run test:e2e:all -- e2e/markdown-viewer.spec.ts --grep 'production large table editing' --workers=1 --repeat-each=3 --retries=0 --reporter=json
SAMBEE_E2E_REPORT=/tmp/sambee-expansion.json SAMBEE_E2E_SLICE=dense-expansion npm run test:e2e -- e2e/viewer-performance-budgets.spec.ts --grep 'recorded viewer acceptance report' --workers=1 --retries=0
node scripts/source-search-containment-proof.mjs --native-atomic
```

- Commands reproduce raw verdicts, not acceptance decisions. Accepted D5/D6/D8/D9/D10
  limitations can still make an enforced command fail. Do not rerun waived
  matrices solely to close completed items or manufacture passing results.
- Keep both engines, widths 1543/390 and three timing trials per required
  identity. Do not shrink fixtures, extend deadlines, preload grammars or warm
  away first use. Reopened viewers use fresh workers, not a pool.
- Separate cold browser cache, warm HTTP cache with fresh workers and repeated
  grammar use within one job. Soft timing assertions collect both cold/warm
  samples even after a timing failure; correctness/cache/worker/cleanup remain
  hard assertions.
- Use `PLAYWRIGHT_JSON_OUTPUT_FILE` to avoid npm console headers corrupting JSON.
  The existing evaluator requires complete identities and rejects empty,
  missing, duplicate, invalid, unenforced, skipped/retried or diagnostic evidence.
  Supported slices: `dense-expansion`, `source-responsiveness`, `source-typing`,
  `prose-table`, `table-editing`, `publication`, `readiness` and
  `readiness-http-cache` (both cold/warm evidence).
- Extract mixed reports losslessly into slice-only reports, retaining failures,
  attachments, source provenance and recomputed case counts. Native/PDF matrices
  use their existing checker, not the timing-slice evaluator. From the repository
  root, run `backend/.venv/bin/python -m scripts.check_native_markdown_pdf <report>`;
  add `--printing` for the fixed printing-only report.
- Run timing isolated from builds/tests, tracing and controlled GC. Keep
  `SAMBEE_E2E_TRACE=1` and `SAMBEE_E2E_MEMORY=1` separate from timing enforcement
  and each other. They are diagnostics, not timing passes.
- Attribute CPU on the correct renderer thread within browser markers;
  reconstruct/sort negative sample deltas and count samples once. Do not add
  nested stages to enclosing callbacks or call worker elapsed time main-thread
  CPU. Chromium attribution does not establish Firefox causes.
- Run focused checks after bounded fixes, affected native gates after layout
  changes, and the full relevant matrix at completion rather than after every
  small edit. Do not fix unrelated failures or change dependencies without the
  repository's dependency workflow.

**Closure:** items 1-6 require no further implementation or approval. Finish
items 7-8 without resuming declined work, duplicating completed item 5 coverage
or reinstating removed coverage.
Merge/rollout requires its own explicit
decision after the remaining gates pass or named exceptions are approved.
