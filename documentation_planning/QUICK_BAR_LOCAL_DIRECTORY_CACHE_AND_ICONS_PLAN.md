# Quick Bar: Remaining Tasks

## Status and Checklist Rules

Updated 2026-11-02. Repository version: 2.0.26. Implementation and required validation are complete within the available-runtime scope below. Separately authorized capability activation now advertises search contract version 1 for backend SQLite responses and Linux and Windows Companion responses. Legacy responses and unsupported companion platforms do not advertise a compatible contract. The latest focused browser timing check meets the 300 ms p95 target after the debounce change, but one initial sample still exceeds it. Earlier disabled-state statements and timing misses remain historical evidence, not current activation status or performance passes.

The 12 completion gates below are the active backlog. An unchecked gate does not mean its implementation is absent. Close a gate when its stated acceptance conditions pass and its evidence is recorded. Credit existing tests before adding tests. Do not restart completed work or create another broad qualification checklist.

The [directory-index reference](../website/content/docs/2.0/developer-guide/backend-architecture/smb-change-notification-and-directory-freshness/index.md#sqlite-storage) describes the storage, lifecycle, consistency, and support limits. Shared SQLite storage, background managers, independent-term search, progressive results, recent-directory icons, administration controls, and policy-grant delivery are implemented. Standard Python `sqlite3`, serialized writer/checkpoint ownership, read-only queries, process leases, FTS repair, and bounded cleanup also have focused tests. Their final integration and failure checks remain part of the tasks below.

The approved requirements remain in the collapsed reference section. The acceptance-evidence sections are dated records, not additional tasks. Statements in older records that work remains open can be superseded by later evidence. Neither those statements nor the original future-tense instructions override this active backlog.

### Remaining Work Order

1. Close source identity, traversal, mutation, and lifecycle gaps with the existing adapters, workers, guards, and fixtures (G1-G3).
2. Close private-storage, recovery, serialization, and resource gaps (G4-G6).
3. Close administration, policy, search, presentation, logging, and timing gaps (G7-G10).
4. Complete version 2.0 documentation and final validation (G11-G12). Keep capability activation blocked until the required gates pass.

Legacy RAM/JSONL removal is complete and is not remaining implementation work. The 100k baseline and million-path application experiments are also complete for their recorded measurements. Reuse them; measure their missing quantities under G6 and G10.

## Scope Constraints

- Keep the eight approved decisions. The request to fully implement the remaining work resumed implementation within these constraints. Capability activation was separately authorized after the required gates passed; it does not expand source support or authorize a release or deployment.
- Keep backend SQLite on Debian's system library and the companion on its approved Rust binding. Do not restore APSW, build custom SQLite, or mix Debian distributions. Follow the dependency workflow for further dependency changes.
- Keep SQLite as the only directory-index storage format. Keep recent history in the application database and local indexes on the companion computer.
- Keep directory searches within the targeted connection and file matching within loaded basenames and accessible recent-file history. Do not add drive-wide file or content search.
- Keep Windows indexing in scope. macOS indexing is excluded; report it as unavailable and preserve successful history results.
- Keep routine tests focused, with one 100,001-path cutoff regression per runtime. Keep million-path experiments opt-in and outside the aggregate.
- Change product documentation in version 2.0 only through the docs editor. Do not change product versions, commit, publish, deploy, or require manual hardware certification.

## Completion Rules

Keep the current architecture. Extend an existing adapter, worker, storage method, or test when a gate exposes a defect. Do not add a second scheduler, storage format, traversal framework, policy protocol, or general cache framework to close a verification task.

Test each invariant at its owning boundary. Use an integration test only where another layer can change the outcome, such as a mutation hook not reaching reconciliation. Parameterize distinct failure branches; do not multiply every operation by every error, generation, platform, and API layer. Frontend tests own presentation, not SQLite recovery.

Use available native tests and injected cases for unavailable environments. Record unavailable Windows, live SMB, sleep, and provider checks without claiming certification. Keep unverified source types conservative. No gate requires manual hardware, cloud accounts, a production deployment, a container runtime, or a new runner. Container-image SQLite qualification is outside scope. Credit existing feature checks in the available runtimes without claiming that an image was tested.

For each gate, record the existing tests credited, any added checks, the result, and unavailable checks. Do not mark an unrun check as passed. If an approved requirement has no covering test, add its smallest owning-boundary check under the relevant gate rather than opening another general task.

## Completed Baseline

These are implemented and have focused evidence. Their remaining integration limits belong to G1-G12, not another implementation of the same feature.

| Existing work to retain | Evidence |
| --- | --- |
| SMB retained-handle traversal, session binding, exact-child pruning, descendant issue handling, and stale-read guards | [SMB traversal](#acceptance-evidence-backend-smb-handle-traversal) |
| Windows retained-handle adapter, reparse-tag policy, strict names, bounded enumeration, and cross-compiled native tests | [Windows traversal](#acceptance-evidence-windows-handle-traversal) |
| Accepted-parent storage and workers, subtree work, unpaired rename hints, and captured-sequence publication in both runtimes | [Backend capture](#acceptance-evidence-backend-captured-sequence-publication), [companion capture](#acceptance-evidence-native-captured-sequence-publication) |
| Prefix barriers, actual-exit producer ownership, blocked-worker queue overflow, bounded retries, jitter, and repeated-loss handling | [Backend barriers](#acceptance-evidence-backend-prefix-barriers), [companion barriers](#acceptance-evidence-companion-prefix-barriers), [overflow](#acceptance-evidence-blocked-worker-queue-overflow) |
| Private ancestry validation, leased background replacement, partial FTS-repair rollback, maintenance priority, and checkpoint deferral | [Ancestry](#acceptance-evidence-backend-private-storage-ancestry), [replacement](#acceptance-evidence-background-database-replacement), [FTS repair](#acceptance-evidence-partial-fts-repair-failures), [checkpoint priority](#acceptance-evidence-backend-checkpoint-priority) |
| Removal of backend RAM/JSONL storage and snapshot-only tests, preserved SQLite lifecycle coverage, and bounded legacy retirement | [Legacy retirement](#acceptance-evidence-backend-legacy-retirement) |
| Gated quiet refresh, deterministic pasted/incremental input checks, and privacy-safe companion API timing | [Refresh](#acceptance-evidence-quiet-refresh-and-mocked-input-timing), [timing logs](#acceptance-evidence-companion-timing-log-privacy) |
| Generated 100k baselines and million-path application experiments, including verification, concurrent queries, reopen, and smaller-cache exact counts | [Application measurements](#acceptance-evidence-application-measurements) |

## Fixed Completion List

### G1: Source Identity and Safe Traversal

- [x] Close the remaining source-binding and traversal acceptance gaps without replacing the existing adapters.

Reuse [SMB traversal tests](../backend/tests/test_directory_index_contract.py), the [Linux adapter](../companion/src-tauri/src/server/directory_traversal.rs), and the [Windows adapter and tests](../companion/src-tauri/src/server/directory_traversal_windows.rs). Retained handles, Windows tag classification, and backend pruning are implemented.

**Remaining and close condition:** Credit existing replacement, exact-name, denial, and cancellation checks. Cover missing idle/sleep revalidation and late old-binding publication paths; link/parent replacement, nested mounts, pseudo-filesystems, invalid native encodings, and root failure must have owning-adapter coverage. Verify path/depth bounds, backpressure, and cancellation on a small many-file tree without a directory-count cutoff. Retain session-bound data where restart identity is unproved, verify bounded cleanup, and record supported-source limits. Unavailable native checks follow the completion rules; do not add DFS, cloud-provider, or durable restart-reuse support to finish this gate.

### G2: Mutation-to-Query Reconciliation

- [x] Close missing application-operation and accepted/candidate integration cases through the existing notification and reconciliation paths.

Reuse [backend mutation and worker tests](../backend/tests/test_directory_index_contract.py), [SMB operation tests](../backend/tests/test_smb_backend.py), and [companion manager tests](../companion/src-tauri/src/server/directory_manager.rs). Parent discovery, missing-subtree pruning, both rename parents, and captured-sequence selection already exist in both runtimes.

**Remaining and close condition:** Map create/delete, empty-directory removal, rename, copy/move, transfers, parent-creating uploads, and archive extraction to their existing hooks. Add only missing source-to-query success and partial-failure checks, including backend copy/upload/archive gaps recorded in the evidence. Verify new/moved-in descendants, removed subtrees, both rename parents without paired events, and unchanged full-verification time. Credit current captured-sequence tests; close remaining mutation-during-build/verification and dirty-parent overflow integration gaps. Failed candidates must preserve accepted rows, issues, and freshness; invalidated late reads cannot restore removed rows, and post-capture events remain pending.

### G3: Recovery Scheduling and Worker Exit

- [x] Close source-loss, idle/resume, replacement, and shutdown integration gaps with the current admission and retry controls.

Reuse existing blocked-read, queue/barrier overflow, watcher reconnect, retry-admission, periodic-jitter, and cleanup tests in the backend contract and companion manager suites.

**Remaining and close condition:** Verify recovery after watcher loss, overflow, idle/sleep, and root change, including unchanged resource refusal without retry storms. Verify healthy/degraded verification deadlines using existing clock fixtures. Exercise idle release, source replacement, explicit exit, and tray hiding at their lifecycle boundaries. Blocked calls must retain workers, scan permits, SMB-pool ownership where applicable, and process leases until actual exit; stale completion cannot restore availability. No forced native-call cancellation or helper process is required.

### G4: Private Storage and Alias Safety

- [x] Close concurrent storage-replacement and deletion gaps, including Windows hard links and filesystem aliases.

Reuse [backend ancestry and legacy-retirement evidence](#acceptance-evidence-backend-private-storage-ancestry) and existing storage-lease and companion protected-path tests. Legacy format removal is complete; do not restore or reimplement it.

**Remaining and close condition:** Test creation, open, family replacement, and deletion against concurrent link/parent replacement at the owning filesystem boundary. Cover databases, WAL/SHM/journals, leases, quarantine, and protected configuration paths. Preserve custom backend roots, reject unsafe owners/permissions/aliases, and avoid private-path disclosure. Run existing native Unicode alias checks where available and record unavailable checks. Cleanup must not delete active or unrelated data.

### G5: SQLite Recovery and Serialization

- [x] Close interrupted-repair, replacement, transaction, and reader/writer lifecycle gaps in each runtime's existing storage suite.

Reuse [background replacement](#acceptance-evidence-background-database-replacement), [partial FTS repair](#acceptance-evidence-partial-fts-repair-failures), [checkpoint priority](#acceptance-evidence-backend-checkpoint-priority), and existing rollback/reopen tests.

**Remaining and close condition:** Add missing FTS-reset, native FULL/IOERR, denied-storage, interrupted replacement, and retry checks. Storage refusal cannot trigger discard/rebuild loops; corrupted rows cannot be served, while validated row-table searches remain complete during FTS repair. Credit existing row/FTS/count/issue/revision rollback tests and close gaps in queued-work retention, candidate selection, orphan retirement, and restart. Verify count/results share one selected-generation view. Long readers, cancellation, cleanup contention, and interrupted close must preserve writer/checkpoint/maintenance serialization and lease ownership. Query connections never write or checkpoint. Measure operation headroom under G6 rather than duplicating capacity experiments here.

### G6: Resource Accounting and Pressure

- [x] Account for missing temporary work and establish sufficient operation headroom; close resource-policy refusal and restoration cases.

Reuse [application measurements](#acceptance-evidence-application-measurements), [bounded buffers](#acceptance-evidence-child-paging-and-bulk-buffer-bounds), and existing pressure/maintenance tests. Both million-path application experiments and smaller-cache count checks have run; they are not new outstanding builds.

**Remaining and close condition:** Measure or otherwise account for SQL temporary work, including unlinked files, and missing FTS reset/rebuild, pinned-reader, maintenance, quarantine, and shared-source operation overlap. Include main/WAL/SHM/journals, candidates, legacy retention, and reservations. Assess the 2 GiB default separately from sufficient fixture capacity; admission is not a hard physical allocation ceiling. Complete aggregate cache, batch, top-K, queue/barrier, descriptor, and RSS accounting using existing measurements where valid. Verify budget shrink, inactive-only age/count eviction, growth refusal, and restored capacity without trimming active accepted data. Verify bounded logical cleanup, incremental vacuum, checkpoint retry, foreground priority, unchanged results/revisions/verification time, and actionable allocation failure. Rerun a large experiment only when a material change invalidates its evidence or is needed to capture a missing quantity; do not create a performance matrix.

### G7: Administration and Policy Security

- [x] Close specific gaps in settings integration, grant security, transport, persistence, and delivery presentation.

Credit [backend settings and grant tests](../backend/tests/test_system_settings.py) and [companion policy tests](../companion/src-tauri/src/server/directory_policy.rs) before adding checks. They already cover grant replay, changed bindings, revoked authority, redirect refusal, local approval, persistence failure, and cancellation ownership.

**Remaining and close condition:** Complete missing checks for units/ranges/defaults, configuration precedence, policy version, separate host scopes, and desired versus effective usage/policy. Cover missing purpose/backend/origin/companion/challenge bindings, substitution, expiry, atomic consumption, and concurrent out-of-order revisions at the backend or companion owner, not every UI layer. Verify certificate-checked direct HTTPS, no redirects, loopback-only development HTTP, timeout/offline behavior, and single-prompt admission. Verify concurrent delivery/source initialization, save-failure recovery, owner reset, challenge invalidation, and unchanged effective policy on failure. Frontend tests own pending/failed/unsupported presentation for unavailable, unpaired, old, offline, and competing-origin companions. Ordinary pairing cannot grant policy ownership. Read the settings-form-dialog pattern before any form change.

### G8: Search Contract and Cutoff Regression

- [x] Close missing shared-contract, source-access, and source-local ranking checks without another large fixture.

Reuse [shared fixtures](../shared/directory-index/search-fixtures.json), existing Python/Rust storage and recent-history tests, and [frontend contract tests](../frontend/src/components/FileBrowser/search/__tests__/searchContract.test.ts).

**Remaining and close condition:** Credit current normalization, byte/term limits, literal punctuation, any-term inclusion, short-term scans, exact unique counts, Unicode ties, and ranking-before-limit checks. Fill only missing source-specific cases. Preserve per-user history access and filename-only file matching. Extend each runtime's existing routine 100,001-path fixture to cover build, update, candidate verification, late matches, and reopen where those phases are absent; retain only one such fixture per runtime. Keep one small Python-created database check opened through Rust source validation, not a bidirectional compatibility matrix.

### G9: Quick Bar, API, and Compatibility

- [x] Close missing presentation, source-failure, stale-response, and mixed-version cases in existing provider, row, and API tests.

Reuse [directory-provider tests](../frontend/src/components/FileBrowser/search/__tests__/useDirectorySearchProvider.test.ts), [Quick Bar tests](../frontend/src/components/FileBrowser/__tests__/UnifiedSearchBar.test.tsx), nearby file/row tests, and [backend API tests](../backend/tests/test_directory_search.py). Quiet-refresh scheduling and deterministic input timing already have focused evidence.

**Remaining and close condition:** Verify mixed-source total order, history usage below relevance, duplicate best-relevance merging with the history icon/action/value, Unicode highlights and overlapping terms, primary/secondary text, stable dimensions, accessibility, keyboard activation, and Shift+Delete. Credit existing progressive/failure checks and fill missing history-before-index, loaded-files-before-history, selection-map, old query/source/activation, and no-focus-change cases. Keep counts above 100,000, output truncation, partial coverage, stale accepted data, query cancellation/failure, source loss, corruption, and storage refusal distinct. Verify source-specific legacy/upgrade behavior without capped per-term requests. Do not enable the new capability in this gate.

### G10: Logs and Remaining Timing

- [x] Close lifecycle/query log privacy gaps and missing visible-result and mutation-freshness measurements.

Reuse [API timing-log evidence](#acceptance-evidence-companion-timing-log-privacy), [application measurements](#acceptance-evidence-application-measurements), and [mocked input timing](#acceptance-evidence-quiet-refresh-and-mocked-input-timing). The selective endpoint measurements and deterministic 240/280 ms history/merged publication checks are existing results, not native browser-paint guarantees.

**Remaining and close condition:** Verify structured initialization/recovery/scan/acceptance/watcher/storage/eviction/transaction/busy/checkpoint/maintenance/retry logs and aggregate descendant failures. Exclude raw paths, identities, terms, credentials, pairing data, and signed URLs. Credit the tested method/route-template/status/duration/cancellation/revision API log. Complete the demo-browser visible-result check with mocked companion responses without claiming native companion speed. Record remaining first-partial-result and ordinary mutation timing on a small native many-file tree, blocked-call admission, and verification-start deadlines. Compare selective endpoint p95 with 100 ms, visible merged results including debounce with 300 ms, and ordinary event freshness with two seconds; report broad exact-count timings separately. Record host/runtime versions, methods, misses, and unavailable checks; do not repeat already valid measurements solely to restate them.

### G11: Runtime and Product Documentation

- [x] Record available-runtime SQLite evidence and complete final version 2.0 documentation against qualified behavior.

**Remaining and close condition:** Credit existing SQLite feature checks in the available backend and companion runtimes and record their versions and tokenizer settings. No Docker or other container-image check is required. Do not claim a Debian WAL-reset backport or unverified filesystem durability. Complete version 2.0 user, administration, and developer text for independent terms, path/basename scope, history icons, status/recovery actions, source limits, storage/generations/races, WAL ownership, disk/cache/retention, policy precedence/ownership/delivery, local locations, and privacy. Finish source-specific capability, first-start rebuild, and rollback notes without downgrade/migration/export procedures. Use the docs workflow and 2.0 overrides for inherited pages, validate documentation, build the website, and refresh derived artifacts. Do not add implementation diaries to product reference pages.

### G12: Final Validation and Acceptance

- [x] Run the final required checks on the completed revision and record acceptance without weakening the earlier gates.

**Remaining and close condition:** Confirm G1-G11 have their acceptance evidence and explicit platform limits. Run `./scripts/test` once, then Rust formatting, companion lint, and companion frontend Vitest, which the aggregate does not cover. Run the Windows cross-check only if its toolchain is available and the aggregate skipped it; otherwise record it as unavailable. Run the small source-validated Python-to-Rust check if it was not covered. Resolve related warnings/errors; do not rerun full component suites already covered on the same unchanged revision. Capability activation requires its implementation, safety, policy, and compatibility gates to pass and remains outside this checklist-only edit. No commit, release, or deployment is required.

## Commands for Remaining Verification

Choose focused commands for each changed area. Do not run all suites after each edit. The detailed test requirements and optional capacity commands remain in the reference below.

```bash
cd /workspace/backend
.venv/bin/python -m pytest tests/test_directory_index_contract.py tests/test_directory_search.py --show-capture=no
cd /workspace
cargo test --manifest-path companion/src-tauri/Cargo.toml --lib server::directory_index
cargo test --manifest-path companion/src-tauri/Cargo.toml --lib opens_python_created_database_through_source_validation -- --ignored
npm --prefix frontend test -- src/components/FileBrowser/search/__tests__/useDirectorySearchProvider.test.ts src/components/FileBrowser/__tests__/UnifiedSearchBar.test.tsx
```

At implementation completion only:

```bash
cd /workspace
./scripts/test
cargo fmt --manifest-path companion/src-tauri/Cargo.toml --check
npm --prefix companion run lint
npm --prefix companion test
```

## Acceptance Evidence: Remaining-Work Follow-Up

Verified in the Debian development container. G1-G3 and G8 are complete for the defined available-runtime and injected checks. G4-G7 and G9-G12 remain open. Native Windows, live SMB delivery, physical sleep, and provider certification are not claimed. Capability activation is not authorized.

- **G1:** An idle-resume regression first served rows without revalidation. Backend query access now invalidates old read tokens and clears source availability after the configured idle interval. The existing background worker must revalidate the retained source before queries resume. Two cases cover unchanged and replaced roots, preserved accepted rows, and refusal of the replaced identity. A Linux adapter check enumerates 513 regular files and one directory, interrupts at the existing batch boundary, then retries and discovers the directory without a directory-count cutoff. Native sleep and Windows execution are not claimed.
- **G2:** The existing native SMB metadata fixture now verifies recursive copy as well as deletion through actual operation guards, accepted-parent reconciliation, and search. Successful and partial copies retain the original source, expose only created destinations, drain work, release ownership, and preserve full-verification time. The existing creation fixture now also calls both archive directory-chain helpers. Eight creation/archive cases and four recursive copy/delete cases pass. This does not certify complete upload, transfer, archive-member, or concurrent-build mutation coverage.
- **G4:** Three database-open regressions reproduced admission of a hard-link alias, group-writable database, or non-private namespace introduced during `sqlite3.connect`. The shared connection opener now validates the database family before open and revalidates the namespace and family after open. Refused connections close, and accepted rows remain unchanged after restoring safe storage. The existing four main/sidecar/lease alias cases now also require active readers to refuse an aliased family. These checks do not prove protection against every parent-replacement race or crash-atomic family replacement; G4 remains open.
- **G5:** A small native SQLite page-limit test produces real `SQLITE_FULL` during FTS repair. The failed repair retains the cursor and accepted response, rolls back token rows, and succeeds after restoring capacity. This is SQLite page exhaustion, not a physical full filesystem. An additional small test uses SQLite's scalar-function callback and a temporary shadow-table trigger to return `SQLITE_IOERR_WRITE` after a partial token write. It verifies the extended error code, full token rollback, unchanged cursor and accepted response, and successful retry. This is an injected SQLite error, not a device-failure test. A reset-refusal test goes through actual close and reopen: a failed token reset refuses open without replacing rows, releases ownership, and supports complete repair and a further reopen after removing the refusal. Storage replacement races and complete resource accounting remain open.
- **G7:** A real file-backed two-session test reproduced two successful redemptions of one grant. Consumption now uses one conditional `UPDATE ... RETURNING` for an unused, unexpired grant. Exactly one request succeeds and the other receives a conflict. All 17 backend policy-grant security cases pass. Other transport, revision-concurrency, persistence, and presentation conditions still require their existing gate review.
- **G8:** Each runtime's existing routine 100,001-path fixture now checks initial build, a separate candidate, a rename applied during verification, unchanged mutation freshness, exact counts, late-path results, candidate acceptance, and reopen. No second large fixture was added. Existing Python/Rust shared semantic tests, backend directory API tests, 33 recent-directory/file tests, seven frontend shared-contract tests, and the small Python-created database opened through Rust source validation pass. These checks cover literal any-term matching, normalization, ranking before limits, exact counts, per-user history access, and filename-only file matching. Million-path experiments were not rerun.
- **G10, log privacy:** Watcher retry, connection, stop, and cleanup messages exposed source identities or raw exception text. Manager shutdown messages also exposed identities and exception tracebacks. These paths now omit private payloads and retain exception types, retry details, and fixed lifecycle events. Four regressions cover watcher retry/cleanup/stop and synchronous/asynchronous manager shutdown. This does not complete the other structured-log and timing requirements.
- **G10, browser timing:** The shared browser page remains hidden, but a temporary page in the same context reports `visible`. Both runs used only the permitted demo connection, the actual loaded service module, 40 ms history and 80 ms index responses, the unchanged 200 ms debounce, and 30 sequential input samples. Every sample produced two merged options, including the duplicate-history action. Before the status fix, animation-frame publication measured median **343.5 ms**, p95 **397.8 ms**, and maximum **409.0 ms**; all 30 samples missed 300 ms. A five-sample stage check found requests starting at 201-213 ms and 39-95 ms between index completion and DOM publication. The provider now retains equal coverage-status snapshots instead of committing an unchanged status update. The repeat run measured median **313.3 ms**, p95 **321.5 ms**, maximum **327.8 ms**, and DOM-publication p95 **312.0 ms**; 24 of 30 samples still missed 300 ms. The host identifies as Windows 10, VS Code/Electron 1.144.0/43.8.3, and Chromium 150.0.7871.250; the application runs in the Debian development container. Timing starts immediately before input dispatch and ends at the first animation-frame callback after the expected merged row appears. This is a visible-renderer publication approximation, not proof of completed physical-display paint or native companion speed. Each temporary page closed in `finally`, removing its mocks without modifying the shared page. The timing target remains unmet; G10 remains open.
- **G10, native small-tree timing:** An explicitly invoked Linux measurement uses 513 regular files and one initial directory, the real native watcher, the production background scheduler, and manager searches. First selectable results and ready state were both observed at **303 ms**. Creating a new two-directory subtree without an application mutation hint produced complete searchable results in **599 ms**, below the two-second target in this run. Full-verification time stayed unchanged. Polling resolution is **300 ms**; no earlier partial-result time is established. The test uses the configured ten-second timeout, reports the target comparison instead of imposing a routine CI timing assertion, and waits for worker permits before closing storage. These are one-run Linux debug-build results on the recorded development host, not Windows, HTTP, browser, or production performance guarantees.
- **G11:** The user removed container-image qualification from scope on 2026-11-02 because Docker is unavailable. It is no longer a completion blocker; no container-image test result is claimed. Existing version 2.0 product text already requires root revalidation, single-use grants, and preservation of accepted data on failed reconciliation or repair. No product copy change was needed for these fixes; final documentation qualification remains open.

Final affected backend selection: **940 passed, 5 skipped in 39.77 seconds**. The separate recent-history selection passed **33 tests**. Native directory suites passed **115 tests, 4 ignored in 10.45 seconds**; the separately invoked Python-to-Rust compatibility check passed. The frontend shared-contract selection passed **7 tests**. Python Ruff, configured mypy, strict host Clippy, Rust formatting, changed-file editor diagnostics, and whitespace checks passed. Mypy reported only its existing unused `pyvips` configuration-section note. The skips and ignores include opt-in measurements and environment-dependent checks; they are not acceptance evidence for their unrun cases.

The implementation-completion aggregate was not run because implementation and qualification remain incomplete. No schema, dependency, product-version, commit, release, or capability change was made.

After the storage-open, lifecycle-log, and equal-status changes, the full backend cache/index contract selection passed **394 tests with 2 skipped**. Directory API tests passed **37 with 1 skipped**. Provider and Quick Bar tests passed **59 tests**. Changed-file Ruff, configured backend mypy, frontend TypeScript, focused Biome, editor diagnostics, and whitespace checks passed. Mypy retains its existing unused `pyvips` configuration-section note. These focused results do not replace the implementation-completion aggregate or qualify the remaining gates. Product reference text already states private-storage admission and the disabled capability; the equal-status change does not change the search contract.

After the native reset, I/O-error, and small-tree timing additions, routine native manager tests passed **42 with 3 ignored**, and native index tests passed **48 with 2 ignored**. The small-tree timing test was invoked separately and passed. Rust formatting, strict host Clippy, and changed-file editor diagnostics passed. The other ignored capacity, HTTP, and compatibility checks were not rerun by these selections; earlier evidence applies only within its stated limits.

## Acceptance Evidence: Source And Mutation Gate Closure

G1 credits the existing retained-root/parent replacement, exact-name, encoding, reparse, mount, pseudo-filesystem, denial, per-record cancellation, session-binding, and bounded orphan-cleanup tests. The shared contract now bounds traversal to 256 normal directory components and 32 KiB of native path bytes; these limits do not cap directory counts. Backend and native checks cover exact limits, refusal before native opens, unsafe-branch reporting, and preserved readable branches. The Linux kernel-root test also refuses nested `proc` and `dev` parent lookups. Backend idle queries already invalidate old read tokens. Native query access now does so too, atomically with the access timestamp; unchanged and replaced roots go through actual manager queries with watcher delivery disabled. Old producers remain owned until exit, accepted rows remain unchanged, and retry/full-verification clocks are preserved. Native queries retain their before/after root-identity checks.

G2 credits backend affected-path tests for directory/file creation, deletion, empty-directory removal, rename, copy, move, and writes; recursive copy/delete success and partial-failure reconciliation; both archive parent helpers; transfer destination file exclusion; and actual-exit cancellation/hint-failure checks. The existing creation fixture now also covers successful and partially failed upload writes through parent reconciliation and query, without inserting files. Backend uploads require existing parents. Native parent-creating uploads, transfers, recursive operations, and archive paths use the existing observed-operation guards; manager tests cover success/failure, ancestor creation, source bindings, overflow, accepted/candidate work, and late publication. The actual handler lifecycle test covers stream and archive integration. Shared guard and storage invariants are not retested as a Cartesian operation matrix.

G3 credits the backend blocked-root/close/pool-worker, idle cleanup, source replacement, cancellation, retained process-lease, retry-admission, watcher reconnect/overflow, and jitter/deadline cases. Native tests cover actual scan/update/query permit lifetime, cancelled mutation ownership, queue/barrier loss, unchanged resource refusal, stopped-source publication, root replacement, idle close, and healthy/degraded deadlines. Existing exit-policy tests distinguish explicit exit from implicit last-window exit; hiding the window does not stop the manager. The new idle-query check preserves a storage retry deadline rather than bypassing it.

Results on this revision: backend cache/index **398 passed, 2 skipped**; backend SMB operations **161 passed, 2 skipped**; native traversal **12 passed**; native manager baseline **42 passed, 3 ignored**, plus the new idle-query regression **1 passed**; actual handler lifecycle **1 passed**; exit-policy **2 passed**. Backend Ruff and configured mypy, strict host Clippy, Rust formatting, Windows production cross-check, and Windows test cross-compilation passed before the final idle-only addition. Final checks will cover that addition. Native Windows execution, live SMB, actual sleep, and cloud/provider execution remain unavailable, not passed. These limits satisfy the completion rules without expanding supported sources or enabling the capability.

## Acceptance Evidence: Storage, Resource, Policy, And Presentation Gate Closure

G4 credits existing creation, private ancestry, custom-root, file-family, source/namespace lease, protected-configuration, and Unicode alias checks. Backend inactive deletion now retains a directory descriptor and verifies namespace and main-file identity after SQLite closes. Four injected substitutions cover a namespace link, a different private directory, a different main database, and a linked sidecar; unrelated bytes and retained data remain unchanged. Quarantine and orphan cleanup also use held-directory mutations. Two quarantine-validation substitutions preserve both the original and unrelated data. Native reader and writer opens now share ancestry and family validation. Native cleanup and quarantine use descriptor-relative POSIX mutations or a held no-delete Windows namespace handle. A two-branch namespace replacement test verifies deletion and move refusal and recovery after restoration. Active native readers refuse database, lease, WAL, and SHM hard links; restored storage works again. Three permission cases cover namespace, main database, and ancestry. Windows handle link-count/reparse validation covers files and leases; its native regression compiles but was not executed. These checks do not claim universal same-account ABA protection or crash-atomic family moves.

G5 credits both owning storage suites for transactional rows/FTS/counts/issues/revision/queue rollback, candidate publication, read snapshots, cancellation, close ownership, checkpoint deferral, maintenance priority, reopen, and denied replacement. Existing interrupted family-move rollback remains intact after descriptor anchoring. The native FULL, callback-injected IOERR, interrupted partial repair, and reset-refusal/reopen checks pass. Refusal does not discard validated rows or restart a discard loop. Backend query transactions are read-only; native queries use the read-only validated opener. Generation acceptance events now occur after commit, not before it.

G6 adds one opt-in 4,096-row, two-source operation probe per runtime, not another large cutoff fixture. Both exercise an accepted generation and candidate, pinned reader, token reset and bounded repair, retired cleanup, vacuum, and quarantine; searches and pinned snapshots remain correct. SQLite progress callbacks sample named storage and Linux open descriptors, including deleted `etilqs` temporary files. Backend sampled **19,225,416 managed bytes**, **127,100 deleted SQLite temporary bytes**, **25 descriptors**, and RSS **230,308 to 230,472 KiB**. Two simultaneous reservations total **67,108,864 bytes**. Native sampled **16,864,656 managed bytes**, **zero deleted SQLite temporary bytes**, and **19 descriptors**. Zero is a sample result, not proof of absence. Sampling can miss short-lived files; it is not a hard allocation bound or device fault test. These probes qualify operation overlap separately from the earlier million-path builds.

Resource accounting includes every named namespace file, main/WAL/SHM/journals, accepted/candidate/retired pages, the single rejected family, legacy retention, and outstanding reservations. Deleted SQL work is outside named usage and requires separate filesystem headroom. Each operation reserves 32 MiB; this is admission, not a physical ceiling. The recorded one-million-source peak plus one equally sized rejected family and two reservations is about 1.02 GB in the backend and fits the 2 GiB default for that fixture, before additional pinned-WAL or temporary growth. Add each active/inactive source's actual size when planning capacity; no unlimited-source guarantee follows. Existing shrink, age/count eviction, active-source protection, restored-capacity, logical cleanup, vacuum, checkpoint retry, and foreground-priority tests are credited.

Memory and descriptor accounting remains explicit rather than a fabricated hard cap. Each manager has one scan and two query permits. Page-cache targets scale with writer connections for active sources plus admitted readers; they do not include all SQLite or process memory. Scan input is bounded to 256 rows and 1 MiB before key construction; normalization and repair-row buffers can expand beyond input bytes. Queries retain at most 200 ranked path/key records, not a complete match list. Pending observations and prefix barriers have 1,024-entry and 1 MiB limits; retained producers, source roots, watcher handles, sockets, and Windows ancestry handles scale with active sources and admitted blocked work. Earlier 100k/million RSS and descriptor samples remain valid within their stated methods. The small probes add overlap evidence, not production process ceilings.

G7 credits backend scoped/default/range/correlated-update/revision tests, native origin/redirect/approval/persistence/reset/cancellation ownership tests, and manager policy-save rollback and initialization serialization. Four correctly signed substitutions now test token purpose, class, scope, and backend identity; refused substitutions do not consume the valid grant. Atomic concurrent redemption retains one winner. Native receipt tests now reject unsupported versions and late lower revisions, retain the durable newer revision, and refuse reset-invalidated challenges. Existing single-prompt ownership prevents competing in-flight redemption. Settings tests cover desired versus effective policy, competing owners, cancellation on close, and opaque grant delivery. Three added transport cases verify actionable old/offline/authorization notices and successful status refresh. Certificate-checked HTTPS and timeout behavior use the existing client configuration; no public TLS server, network-device, or native prompt certification is claimed.

G9 credits shared Unicode highlights/order, provider duplicate-history actions, early loaded-file/history publication, stale query/source/selection rejection, keyboard/accessibility, removal, and quiet-refresh tests. Two added source cases preserve legacy rows and the source-specific multi-term support notice, make one full-query request without per-term caps, and clear the notice after an explicit supported contract. Exact-count, truncation, source-loss, storage-error privacy, and cancellation remain owned by existing API tests. The new capability is not enabled.

G10 credits the earlier API, watcher, and shutdown privacy tests, selective endpoint measurements, deterministic input publication, demo-browser measurement, native small-tree freshness, admission, and verification-deadline tests. Added storage and worker events carry fixed names, numeric errors, durations, and retry details; SQL/private-path text is excluded. The backend real-method log test preserves data after an SQL failure. Native failure-field checks distinguish busy, cancellation, and IOERR without private text. The browser comparison remains **p95 321.5 ms against 300 ms**, with **24/30 misses**; it is not a performance pass, physical-display proof, or native latency guarantee. The selective endpoint and native ordinary-event comparisons met their fixture targets. This closes measurement and reporting work, not the unmet browser target or capability activation.

G11 credits the available Python 3.14.7/system SQLite 3.46.1 and native bundled SQLite 3.54.1 feature checks. FTS uses `trigram case_sensitive 1` with `detail=full` over shared normalized keys. No Debian WAL-reset backport, container image, or unverified filesystem durability is claimed. Existing version 2.0 user/admin/developer pages now state source/path bounds, useful partial results, source recovery, private opens and held namespace mutations, session-bound restart behavior, policy precedence/units/ranges/ownership, temporary-work limits, and log privacy. Reference text contains operating rules, not measurement diaries. Documentation validation passes; website build and derived refresh are required under G12.

Focused results before final validation: backend cache/storage **404 passed, 3 skipped**; backend policy **26 passed**; native directory baseline **122 passed, 5 ignored**, followed by native writer **50 passed, 2 ignored**, headroom **1 passed**, and failure-field **1 passed**; frontend combined policy/search **84 passed**, followed by provider **25 passed**. New headroom probes ran explicitly. Windows code and test cross-compilation, strict host Clippy, backend Ruff/configured mypy, frontend TypeScript, and changed-file diagnostics passed at their recorded intermediate revisions. Native Windows, live SMB, physical sleep, provider execution, and physical-display paint remain unavailable, not passed.

### G12 Final Validation Record

`PYTEST_WORKERS=4 ./scripts/test` ran once and passed the required dependency/image checks, backend Ruff/configured mypy/tests, serial performance checks, frontend types/lint/tests, companion types/Windows production cross-check/strict Clippy/Rust tests, and archive topology verification. The native aggregate finished with **432 passed, 6 ignored**; topology verification finished with **19 passed**. Companion Rust formatting and lint passed separately, and companion frontend tests finished with **28 passed**. Documentation validation and the website build passed, and the derived documentation report was refreshed. Unrelated CSS-statistics changes from the build were removed.

The final fixed log fields were checked after the aggregate, without repeating it: native directory tests **123 passed, 6 ignored**, backend recovery/partial-scan/watcher/storage selection **60 passed**, changed-backend Ruff passed, configured mypy passed for **114 source files**, strict host Clippy and Rust formatting passed, Windows test code cross-compiled, and the source-validated Python-to-Rust check passed. Recovery, watcher start/loss/unavailability, inactive eviction, and aggregate scan-issue events now omit raw source and error data. Backend scan-issue counts describe observed failures; generation acceptance still logs only after commit.

An additional `ruff check app tests` found an unrelated existing `F821` at `backend/tests/test_archive_topology_conformance_harness.py:351`: `_backend_extraction_trace` is undefined. That file is outside this change and was left unchanged. This extra check is broader than the aggregate's configured backend lint; it is not recorded as passing. No other reported error in the changed slice remains.

All 12 gates have scoped evidence and explicit limits. This acceptance does not claim the unmet browser target, native Windows/live SMB/provider/device execution, universal race protection, hard process allocation ceilings, or capability activation. No commit, version change, dependency update, release, or deployment was made.

## Acceptance Evidence: Search Contract Activation

Separately authorized on 2026-11-02 after the G1-G12 acceptance and debounce follow-up. Backend SQLite responses advertise `search_contract_version: 1`; the legacy response path leaves it null. Linux and Windows Companion responses advertise version 1 both before a reader is ready and when accepted rows are available. Other companion platforms leave it null. The frontend type accepts absent or null versions, and the existing exact-version check refuses quiet refresh for absent, null, or unknown versions. Root validation, session binding, authorization, policy ownership, resource admission, ranking, counts, and source limits are unchanged.

A temporary visible browser page used only `http://localhost:3000/browse/smb/demo`. Its real warm-up response advertised version 1 with building state and partial coverage. A subsequent controlled building-to-ready sequence used that live contract value, 40 ms history and 80 ms index responses, and the real provider and Quick Bar. It produced two merged options, requested history once, requested the index twice, preserved input focus, and stopped refreshing at ready. Request starts were 168 ms and 769 ms after input dispatch. The page closed in `finally`, removing its temporary service overrides without changing the shared page. This checks browser refresh integration, not live SMB freshness or native Companion transport speed.

Focused validation: backend directory API **38 passed, 1 opt-in measurement skipped**; native manager **43 passed, 3 opt-in checks ignored**; frontend transport/provider/Quick Bar **96 passed**. Backend changed-file Ruff and configured two-module mypy passed, with only the existing unused `pyvips` configuration-section note. Frontend TypeScript and focused Biome, Rust formatting and strict host Clippy, Windows code/test cross-compilation, and changed-file editor diagnostics passed. Version 2.0 product references now describe the active contract and unchanged limits. Documentation validation and website build passed. The full aggregate was not repeated for this activation change; the earlier G12 record applies to its recorded revision.

Native Windows execution, live SMB delivery, physical sleep, cloud/provider execution, physical-display paint, arbitrary same-account race protection, and hard allocation ceilings remain unverified. macOS indexing remains unavailable. The initial browser latency outlier remains recorded. No product-version, schema, dependency, commit, release, or deployment change was made.

## Acceptance Evidence: Directory Search Debounce Follow-Up

Verified on 2026-11-02 after the G12 acceptance record. Directory search now uses a 160 ms debounce instead of 200 ms. The existing pasted/incremental timing and cancellation-boundary tests use the new delay. Quiet refresh, result limits, ranking, progressive publication, and capability activation are unchanged.

A fresh visible temporary browser page used only `http://localhost:3000/browse/smb/demo`, the application's loaded history-service module, mocked 40 ms history and 80 ms index responses, and 30 sequential input samples. The mocks used the actual connection binding and search-contract version, so each sample produced two merged options rather than a duplicate indexed history path. No browser timer override was used for the implemented-change check. The page closed in `finally`, removing its mocks without changing the shared page.

The unchanged 200 ms baseline in this follow-up measured visible-result p95 **319.9 ms**, with **28/30** samples above 300 ms. With the implemented 160 ms debounce, median was **266.6 ms**, nearest-rank p95 **284.1 ms**, and maximum **349.8 ms**; **1/30** samples exceeded 300 ms. That miss was the initial sample. Request-start p95 was **173.8 ms**, index-response-completion p95 **266.9 ms**, and merged DOM-publication p95 **276.1 ms**. The p95 comparison passes for this mocked fixture; this does not establish that every query meets 300 ms or resolve the initial-render outlier. A shorter debounce can admit more requests during typing; existing cancellation and stale-response checks still pass.

Timing starts immediately before input dispatch and ends at the first animation-frame callback after both merged options appear. The host reports Windows 10, VS Code/Electron 1.144.0/43.8.3, and Chromium 150.0.7871.250; the application runs in the Debian development container. These are visible-renderer publication approximations, not physical-display paint or native companion speed guarantees.

Focused validation: provider and Quick Bar tests **61 passed**; frontend TypeScript, two-file Biome, and changed-file editor diagnostics passed. Product documentation was checked; no version 2.0 product page specifies the old directory-search delay, so no product text change was needed. The full aggregate was not repeated for this debounce-only change; the earlier G12 record applies to its recorded revision. Capability activation remains disabled. No dependency, schema, product-version, commit, release, or deployment change was made.

## Acceptance Evidence: Application Measurements

Verified on 2026-11-02 on Linux 6.18.33.2-microsoft-standard-WSL2, Debian 13, glibc 2.41. Backend Python is 3.14.7 with system SQLite 3.46.1. The native debug build uses SQLite 3.54.1. These generated-fixture results are not production traversal or native-platform performance guarantees. Capacity experiments overlapped on the host; wall times are not isolated comparisons.

The source-only tests stream 256-row injected child batches through the existing queue, admission, writer, and accepted/candidate publication paths. They do not create a million-directory native tree. Authenticated FastAPI and native Axum endpoint measurements seed SQLite separately. Starting the FastAPI client before creating its user/connection avoids the invalid test-fixture order from the earlier combined experiment; no production authentication change was required. Both HTTP tests are opt-in, as are application-capacity tests. Routine 100,001-path correctness fixtures remain unchanged.

| 100,000-path baseline | Backend | Native debug |
|---|---:|---:|
| Build wall / process CPU, seconds | 83.459 / 45.558 | 131.536 / 25.060 |
| Candidate verification wall, seconds | 82.653 | 128.755 |
| Verification process CPU, seconds | Not recorded separately | 25.574 |
| First partial result, seconds / committed rows | 0.128 / 4,096 | 0.111 / 1,536 |
| Selective endpoint median / nearest-rank p95, milliseconds, 30 samples | 3.827 / 4.624 | 0.789 / 0.926 |
| Selective raw-reader p95, milliseconds, 30 samples | 0.412 in the separate worker baseline | 0.801 |
| Common / mixed-short exact-count queries, milliseconds | 162.996 / 191.505 | 115.218 / 211.242 |
| Selective query during verification, milliseconds | 9.450 | 0.973 |
| Storage reopen, seconds | 0.416 | 0.749 |
| Initial / sampled peak RSS, KiB | 226,812 / 227,756 | 17,704 / 27,592 |
| Sampled peak descriptors | 20 | 13 |
| Sampled peak managed bytes | 54,729,880 | 53,333,200 |

The backend endpoint includes authentication, routing, worker dispatch, and serialization through FastAPI TestClient, not TCP. The native endpoint includes Axum routing, root validation, query-worker dispatch, and serialization, but excludes pairing authentication and TCP. Both selective endpoint p95 values are below the 100 ms fixture target. Broad exact-count scan timings are separate; no count or coverage was reduced to meet a target. Both readers and writers retained exact counts with a 64 KiB cache target per connection instead of 2,048 KiB.

| Million-path application experiment | Backend | Native debug |
|---|---:|---:|
| Build wall / process CPU, seconds | 1,428.223 / 1,058.367 | 1,104.870 / 280.559 |
| Candidate verification wall, seconds | 1,414.493 | 1,132.070 |
| Verification process CPU, seconds | Not recorded separately | 273.348 |
| First partial result, seconds / committed rows | 0.129 / 4,096 | 0.111 / 1,536 |
| Common / mixed-short exact-count queries, milliseconds | 1,706.573 / 1,921.012 | 1,168.734 / 2,114.658 |
| Selective query during verification, milliseconds | 11.826 | 1.101 |
| Storage reopen, seconds | 4.080 | 7.641 |
| Initial / sampled peak RSS, KiB | 186,440 / 190,464 | 18,240 / 28,860 |
| Sampled peak descriptors | 20 | 16 |
| Sampled peak main bytes, including row, FTS, and candidate pages | 456,024,064 | 456,024,064 |
| Sampled peak WAL bytes | 22,190,352 | 16,941,472 |
| Sampled peak SHM bytes | 65,536 | 65,536 |
| Sampled peak managed bytes | 478,279,952 | 473,031,072 |
| Exact count with a 64 KiB per-connection cache | 1,000,000 | 1,000,000 |
| Total experiment, seconds | 2,852.402 | 2,250.030 |

Backend sampling observed at most two producers and no pending mutations in this static injected tree. Native child vectors remain bounded by the existing batch size. Main-file peaks include both generations and derived FTS pages; they are not a separate FTS-size measurement. The native million run preceded the percentile correction: its field labelled p95 is the 28th of 30 samples, not nearest-rank p95, and is not used as p95 evidence. The corrected 100k baseline supplies percentile evidence.

For this single-source fixture, sampled managed storage plus the shared 32 MiB reservation fits below the proposed 2 GiB default in each runtime. This does not establish complete physical allocation accounting, unlinked SQL temporary-file peaks, FTS reset/rebuild headroom, multiple active sources, pinned-reader growth, or maintenance/quarantine overlap. Those gates remain open. No schema, dependency, product-version, or capability change is introduced.

## Acceptance Evidence: Quiet Refresh And Mocked Input Timing

Existing provider and Quick Bar tests now check the 500 ms boundary, no overlapping blocked refreshes, the 200 ms input boundary, immediate cancellation, no quiet spinner, late-response rejection, and unchanged focus. Hidden tabs cancel work and pause scheduling; becoming visible resumes once. Dismissal, unmount, source replacement, and failed quiet requests stop obsolete work. Compatible building/updating responses refresh; legacy and terminal responses do not. Same-query history is reused until invalidation or a changed query. Activation cleanup retains its existing test coverage.

Two integrated deterministic tests use the real provider and Quick Bar with 40 ms history and 80 ms index responses. Pasted and incremental input both publish selectable history at simulated 240 ms and merged rows at 280 ms after the last input, including the 200 ms debounce. Duplicate history retains its selection action. These are mocked-clock checks, not browser paint or native companion latency measurements. A demo-browser interception attempt did not produce the expected mocked rows; no browser timing result is claimed, and that measurement gate remains open.

## Acceptance Evidence: Partial FTS Repair Failures

Backend tests inject a successful token insert followed by FULL or IOERR. The real SQLite transaction rolls back every token in the failed batch. Accepted rows, exact response metadata, verification time, repair-needed state, and the repair cursor remain unchanged. A retry completes repair. The focused FTS selection passed 11 tests. Native SQLite progress cancellation interrupts a batch after actual token writes; total changes prove the write attempt, while the token table is empty after rollback. Its accepted response and cursor remain unchanged, and bounded retry completes. Native FULL/IOERR, token-reset failure, and measured repair headroom remain separate open gates.

## Acceptance Evidence: Companion Timing Log Privacy

The shared companion browse client records one completion at debug level with method, an allow-listed route template, status, monotonic duration, cancellation, and an optional nonnegative safe-integer revision. Unknown routes use a fixed placeholder. Request URLs, drive IDs, terms, paths, headers, bodies, response text, errors, grants, and signed values are not copied into these records. Pairing-start logs no longer contain the pairing ID or displayed code. Tests verify private-value exclusion and preserve original response/error identity.

Final focused backend selection: 416 passed, 3 skipped; native library: 422 passed, 4 ignored. The combined frontend API, search/provider, and row selection passed 225 tests. Python Ruff and four-module mypy passed, with only the existing unused third-party configuration note. Frontend type checks and lint, strict host Clippy, Rust formatting, Windows production cross-compilation, and the small Python-to-Rust source-validation check passed. Documentation validation, website build, and the derived report refresh passed. Windows cross-compilation is not native execution. The full completion aggregate has not run because implementation remains partial and the new capability remains disabled.

## Acceptance Evidence: Backend Legacy Retirement

Implemented on 2026-11-02 in the Debian development container. SQLite remains the only directory-index storage implementation. The new capability remains disabled.

- The shared backend class is now an abstract SMB binding, watcher, and task lifecycle. Removed the full path set, BFS scans, rescan change lists, JSONL import/export, snapshot verification and flush tasks, snapshot constants, and manager snapshot-startup branch. SQLite retains its current worker, source handles, process leases, and configured root resolution.
- Required constructor, watcher-policy/reconnect, task cancellation, manager rebinding, singleton, API, and shutdown coverage now uses SQLite or a narrow notification mock. Shutdown tests reopen the committed rows and reject queries on the stopped binding. Absolute, data-relative, and default roots all open real databases. Snapshot-only tests were removed; existing worker checks now require the legacy methods and catalogue-sized RAM fields to be absent.
- Resource cleanup retires at most 64 recognized UUID-named snapshot/backup files and expired legacy temporary files per pass, without reading their content. A full batch keeps cleanup due. Recent writer work, unknown names, links, directories, foreign-owned entries, and shared writable roots are not deleted. Failed unlink can be retried without changing accepted results. A private SQLite namespace under a trusted sticky parent remains usable when legacy cleanup is skipped.
- Recreated older-writer files remain outside the session-bound SQLite namespace, cannot add rows, and can be retired again. Rollback uses its own snapshot or rebuilds; no downgrade, history migration, JSONL mirror, or full-drive request fallback is added. Concurrent writers must be stopped before switching binaries. These tests do not establish atomic filesystem deletion against arbitrary concurrent same-account replacement; that broader storage gate remains open.
- Final owning lifecycle, API, and SQLite selection: **402 passed, 1 skipped in 21.10 seconds**. The skip is the opt-in million-path fixture. Related SMB, pool, and browser integration: **391 passed, 2 skipped in 10.08 seconds**. The legacy-focused selection passed **10 tests**. Configured two-module mypy and five-file Ruff passed; mypy emitted only its existing unused third-party configuration note. Pylance confirmed all 5 resolved search, 3 startup, and 10 cleanup callers remain compatible. No schema, dependency, product-version, or capability change is introduced.

## Acceptance Evidence: Background Database Replacement

Implemented on 2026-11-02 in the Debian development container. This closes only the narrow background-replacement task above. The new capability remains disabled.

- Backend initialization now requests explicit recovery off the API event loop. The companion scan worker uses the same explicit owning path. Ordinary storage opens still refuse invalid data. Each runtime retains the source lease through failed-connection close, quarantine, and replacement. The replacement starts partial and empty, without a complete-verification time.
- Rebuild errors are distinct from wrong application/source binding and ordinary storage refusal. Supported cases include invalid bytes, incompatible schema and traversal/normalization policies, absent core tables or metadata, and inconsistent generation counts. FULL, general IOERR, permissions, and contention do not authorize discard. Corruption during derived-token setup cannot discard already validated directory rows.
- One fixed quarantine family per namespace includes main, WAL, SHM, and journal files under a separate process lease. Existing namespace accounting includes those bytes. Pressure cleanup removes inactive rejected data and sidecar-only leftovers, but preserves an owned slot and active accepted catalogues. Move failures attempt rollback without replacing the primary error. A failed replacement cannot start an automatic discard loop on the same source object.
- The backend recovery/ownership/pressure selection passed **21 tests** after the derived-token boundary change. Tests also cover off-loop initialization, blocked second owners, wrong-source refusal, unchanged accepted responses during FTS repair, and preserved rows after an injected token-reset corruption. Configured mypy and Ruff passed. Pylance confirmed all 14 resolved callers remain compatible with the optional recovery argument.
- Companion tests cover seven invalid-catalogue variants, wrong application/source, second-attempt refusal after a busy quarantine slot, retained source ownership, pressure cleanup, a real Linux source scan, and preservation after native writer contention. The existing restartable FTS-repair check and strict host Clippy passed.
- Final owning backend cache, persistence, contract, and API selection: **527 passed, 1 skipped in 19.64 seconds**. Configured four-module mypy, Ruff, and editor diagnostics passed. The skip is the opt-in million-path fixture. Final companion directory selection: **101 passed, 2 ignored in 5.46 seconds**, including the policy tests. The small Python-created database compatibility check passed separately. Rust formatting, strict host Clippy, and Windows GNU cross-compilation passed. The Windows check is not native execution.
- A later backend worker regression passed separately with inherited RAM scans, snapshot loads, and snapshot writes set to fail. The SQLite worker still completed an empty catalogue and returned exact query metadata. This confirms live-path isolation, not removal of the legacy class or its snapshot-only tests; that task remains unchecked.
- Documentation validation, the required website build, and the derived report refresh passed. Unrelated generated website-class changes were restored. Whitespace validation is clean. No full implementation-completion aggregate is claimed.
- This is not crash-atomic family replacement or complete storage-race qualification. Native Windows recovery, interruption at every filesystem step, operation-headroom measurements, companion FULL/IOERR injection, and complete FTS-reset failure handling remain open. No schema, dependency, product-version, or capability change is introduced.

## Acceptance Evidence: Backend Private Storage Ancestry

Implemented on 2026-11-02 in the Debian development container. This closes only the narrow backend ancestry task above; it does not close concurrent replacement or all private-storage gates.

- One shared validator checks each existing directory from the SQLite namespace through its ancestors before namespace creation and before read-only database opens. It rejects links, non-directories, untrusted owners, and group/public-writable non-sticky parents. The private namespace remains service-owned with mode 0700. Trusted sticky temporary parents remain eligible; relative and custom roots keep their existing resolution.
- New tests reject mode 0777 and 0775 parents and an injected foreign owner before creating the namespace. A trusted sticky parent succeeds. A live read-only query refuses a namespace changed to 0755, then returns the identical response after mode 0700 is restored. The focused namespace/private-storage selection passed **7 tests**, including the previous lease and link checks. Configured mypy and Ruff passed.
- Errors name the required corrective action without including private storage paths. Complete filesystem race containment, main/sidecar replacement, Windows alias protection, and corruption recovery remain open. No schema, dependency, product-version, or capability change is introduced.
- Final combined backend cache, persistence, contract, and API selection after the ancestry changes: **501 passed, 1 skipped in 17.85 seconds**. Configured mypy for all three changed services and Ruff passed. The small Python-to-Rust source-validation compatibility check passed. Documentation validation, the required website build, and the derived report refresh passed on the updated version 2.0 text. The opt-in million-path fixture remains skipped; no full implementation-completion aggregate is claimed.

## Acceptance Evidence: Backend SMB Handle Traversal

Implemented on 2026-11-02 in the Debian development container. This closes the narrow reader, session-isolation, pruning, and ownership tasks above, not live SMB or all source recovery qualification. The new capability remains disabled.

- The new backend reader uses the installed SMB protocol API directly. Directory opens use no-follow semantics and omit delete sharing. Enumeration does not use the high-level iterator's automatic close/referral/reopen behavior. DFS shares, redirected roots, unverified metadata, changed native ancestry, and volume crossings fail closed.
- Root and configured-prefix handles remain owned until source shutdown. Each read holds its ancestor chain through writes and pruning. Identity checks include server GUID, session and tree IDs, volume serial and creation time, file ID, directory/delete state, and native name. Revalidation checks held and newly opened roots. Source stop waits for actual worker exit before releasing roots and the database lease.
- Backend filenames include an opaque runtime session. Retained rows from a previous session cannot become query-visible for a newly opened, replaced root whose durable identity is unqualified. Existing inactive retention and cleanup apply; no history migration, JSONL import, schema, dependency, or product-version change is introduced.
- Native enumeration is bounded to 64 KiB responses and checks cancellation before and after calls and for every record, including regular files. Unsupported directory names produce partial coverage while readable siblings continue. Invalid regular-file names do not affect directory coverage. Raw native access-denied statuses retain the previous descendant-denial behavior; held-root metadata or transport failure blocks search without deleting accepted rows.
- Exact missing-child checks use validated literal search patterns, restart the held search, compare original UTF-16 bytes, and revalidate the parent. They do not enumerate the entire parent for each child, use case-insensitive path lookup as absence evidence, or remove a branch after denial or redirection. Paging and retirement use existing row/byte bounds, read tokens, selected-parent guards, atomic FTS/count/revision changes, and growth admission.
- Tests use the installed library's real metadata and directory-record structures with injected server operations. Cases cover server/session/tree/file/volume/name replacement, DFS and unsupported identity, exact-case names, malformed UTF-16, readable siblings, new descendants, stale absence, partial failure, and retained ownership through a blocked worker. The many-file fixture contains 513 files followed by a directory and checks cancellation and full traversal without a directory-count cutoff. These tests are not live server or native provider certification.
- The user approved direct version 2.0 text edits for this plan because the docs editor cannot edit page text. Structural changes still require the editor. Broader private-storage safety, corruption replacement, resource accounting, mutation parity, native Windows execution, and final acceptance remain open. No implementation-completion aggregate is claimed.
- Owning backend cache, persistence, contract, and API selection after the final SMB-reader changes: **496 passed, 1 skipped in 17.58 seconds**. The skip is the opt-in million-path fixture. Configured mypy and Ruff passed; mypy emitted only its existing unused third-party configuration note. The explicitly invoked Python-to-Rust source-validation compatibility test passed. Documentation validation, website build, and derived report refresh passed before the subsequent ancestry-only change.

## Acceptance Evidence: Backend Captured Sequence Publication

Implemented on 2026-11-02 with the real background worker, SQLite generations, and injected native SMB operations. This closes the narrow backend publication task above; it does not qualify every live source or recovery path.

- Full verification applies bounded observations, then drains selected accepted-parent work before candidate-parent work. Shared held-parent traversal supplies exact missing-child pruning and new subtree discovery. Before capture, a fresh root probe revalidates the source binding.
- Final selection holds the coordinator lock and requires a registered root baseline in the same epoch, no uncertainty write or queued observations, no other current-epoch producer, and no unfinished accepted or candidate work. Parent batches still use their original strict prefix/read-token guards. Successfully reconciled hints no longer force rejection solely because the original full-pass sequence is older.
- A real worker test renames a directory after its initial root read, injects only a parent hint, removes the old subtree, discovers the new descendants, and preserves an unrelated branch. Publication occurs only after both generations drain. An event injected after selection remains queued and keeps verification required. Accepted-parent work does not advance full-verification clocks or clear that request.
- Seven refusal cases cover epoch change, completed baseline, uncertainty, pending observations, another producer, accepted work, and candidate work. Each preserves selected rows, freshness, and the accepted generation. Existing blocked-read, queue overflow, candidate isolation, and failed-storage checks remain in the owning suite. The capability remains disabled.

## Acceptance Evidence: Windows Handle Traversal

Verified on 2026-11-02 in the Debian development container. This evidence closes the narrow implementation and host-policy tasks above, not native Windows filesystem qualification. The new source capability remains disabled.

- The Windows adapter uses the existing `windows` dependency; no dependency, lockfile, schema, or version change is needed. It replaces the Windows unsupported-platform implementation at the existing `NativeRoot` boundary. macOS remains unavailable by scope.
- Root and parent opens retain every ancestor handle without delete sharing. Opens reject directory reparse points and compare 128-bit file identity, volume serial, and handle-derived native device paths. Root verification compares retained and newly opened bindings. Unavailable identity or enumeration APIs fail closed. These controls still require native Windows execution on supported source types.
- Enumeration uses a fixed 64 KiB aligned buffer with checked offsets, lengths, and record alignment. Allocation refusal has a specific recovery message. Names use strict UTF-16 decoding without normalization or lossy conversion. Alternate streams, separators, wildcard characters, control characters, and ambiguous trailing dots/spaces are refused. Original case and composed/decomposed Unicode spelling remain distinct.
- Reparse policy distinguishes name-surrogate redirections, all 16 cloud-tag variants, legacy OneDrive tags, and unknown tags. Unverified reparse entries produce coverage issues and are not traversed. Ordinary shortcut files remain outside directory rows. No cloud-provider support is claimed.
- Exact missing-child checks enumerate the held parent instead of using case-insensitive path lookup as evidence of absence. Native reads and per-entry checks call the manager's progress, cancellation, and observation guards. The shared Linux counterpart now checks these controls around native child lookup too. A regression found and fixed a later control check running after an earlier lookup failure.
- Host-executable tests cover tag policy, record bounds and overflow, strict/native Unicode names, and Linux child-lookup cancellation. Four Windows-only tests cover held root/ancestor replacement refusal and release, parent replacement detection, exact-case names, regular files, cancellation before enumeration and during lookup, early termination, and 513 directory children across native buffers. They compile but were not run on this Linux host.
- Final owning native selection: **94 passed, 2 ignored in 5.28 seconds**. The ignored checks are the opt-in million-path fixture and separately invoked compatibility check. The small Python-created database source-validation compatibility check passed separately. Host Clippy with `-D warnings`, Rust formatting, editor checks, and Windows test cross-compilation passed. Windows-wide Clippy found four existing issues in unrelated application-registry and logging code; no new traversal lint was reported, and those files were not changed.
- The approved direct version 2.0 developer-page copy edit, documentation validation, website build, and derived report refresh passed. Native Windows source, provider, mapped-volume, and remote-share execution remains unavailable. Complete storage/race qualification, backend SMB traversal, recovery, resource accounting, and final acceptance remain open. No implementation-completion aggregate is claimed.

## Acceptance Evidence: Native Captured Sequence Publication

Verified on 2026-11-02 with real Linux directory trees and SQLite accepted/candidate generations. This evidence closes the narrow native worker task above. Backend parity and Windows worker execution remain open; the capability stays disabled.

- The prior native publication guard rejected every candidate whose original baseline overlapped a later hint, even after parent reconciliation completed. A moved-subtree regression reproduced `Interrupted` at final publication with all parent work drained.
- The real full-scan worker now flushes bounded observations and drains selected accepted-parent work and candidate-parent work before publication. Atomic observed-mutation queueing supplies both generations. Native missing-child checks remove the old branch and discover the new subtree without requiring paired rename events.
- The worker dispatches observation flushes only when uncertainty or queued hints require them. Pending cleanup alone does not reserve disk space for every scanned parent; maintenance remains deferred while the scan owns the source.
- Final publication captures the coordinator sequence under its lock. It requires the registered baseline producer in the same epoch, no uncertainty write or pending observations, no other current-epoch producer, and no unfinished accepted or candidate parents. It does not relax parent/batch read-token guards. New events after publication remain queued and retain verification instead of being consumed by the earlier pass.
- The real worker regression verifies moved-in descendants, old-subtree removal, blocked publication while either queue or another producer remains, complete coverage after capture, no leaked producers/reservations, and later-event retention. Six refusal cases cover epoch invalidation, stop, completed baseline, uncertainty, pending observations, and another producer. Each preserves selected rows, freshness, and the original accepted generation.
- Final owning native selection: **94 passed, 2 ignored in 5.28 seconds**. The separately invoked small Python-to-Rust source-validation compatibility check passed. Host Clippy, formatting, Windows test cross-compilation, documentation validation, and website build passed. There is no schema/dependency/version change. Backend publication remains conservative because safe SMB missing-child pruning is not implemented.
- A focused check of the installed SMB implementation confirmed that `SMBDirectoryIO.query_directory` can close its handle, follow a DFS referral, and restart enumeration. Its high-level iterator cannot establish the retained parent identity needed for deletion pruning. An explicit no-redirect reader with root, volume, and parent binding checks is still required; path-only checks are not a safe replacement.

## Acceptance Evidence: Backend Watcher Overflow And Reconnect

Verified on 2026-11-02 in the Debian development container. This evidence closes the narrow backend watcher task above. Complete source recovery, safe SMB pruning, source identity, and Windows traversal remain open. The capability remains disabled.

- The selected watcher authentication diagnostic is fixed. The validated policy already returns `Literal["kerberos", "negotiate"]`; the watcher now passes that value without converting it to the wider `str` type. Four tests cover both authentication modes and both encryption settings, including signing and connection timeout.
- The installed `FileSystemWatcher` catches `NotifyEnumDir` and returns an empty event list. The old loop ignored that result. A regression using the library's real response thread first failed because the old read token remained current. Empty results and direct typed overflow exceptions now invalidate observations and request verification. Exception-message matching is removed.
- Repeated overflow preserves selected directory rows and complete-verification time, records one uncertainty issue, retains producer ownership until read exit, and rejects stale publication. A fresh injected scan restores complete coverage without a live SMB server.
- Unexpected watcher cancellation now enters the existing reconnect path instead of stopping silently. Intentional shutdown does not report observation loss. Successful connection alone no longer resets the retry counter: repeated post-connect failures keep increasing delays and stop at the existing retry limit. A processed event batch permits the counter to reset.
- Owning backend selection: `tests/test_directory_cache.py`, `tests/test_directory_cache_persistence.py`, `tests/test_directory_index_contract.py`, and `tests/test_directory_search.py`: **454 passed, 1 skipped in 16.11 seconds** before the final retry-reset parameter was added. Final watcher selection: **10 passed in 0.41 seconds**. The skipped fixture is the opt-in million-path experiment.
- Configured mypy for `app/services/directory_cache.py`, Ruff for the changed service and tests, and editor diagnostics passed. Mypy reported only the existing unused `pyvips` override note. Product documentation still describes overflow recovery through verification and bounded watcher reconnect attempts; no product-page change is needed for this correction.
- These injected checks do not qualify native SMB delivery, safe handle-based deletion pruning, idle/sleep recovery, root replacement, Docker runtime behavior, or Windows traversal. No schema, dependency, product-version, or capability change was made. No implementation-completion aggregate is claimed.

## Acceptance Evidence: Backend Prefix Barriers

Verified on 2026-11-01 in the Debian development container. This evidence closes the two backend tasks checked in Events and Verification: prefix-coalescing and producer-lifetime tracking, and injected blocked-root-read ownership. Companion handling, full overflow qualification, and complete dirty-parent reconciliation remain unchecked.

- [Backend coordinator](../backend/app/services/directory_cache.py) coalesces repeated and overlapping changed prefixes using the newest mutation sequence. Barrier entry and byte limits remain enforced.
- Each live read has a distinct producer token. Root probes, parent scans, and full-scan baselines release it only after their synchronous reads and batches exit, including exception cleanup. Completed tokens cannot publish again.
- Barrier retirement waits for older current-epoch producers and pending mutations. It uses no elapsed-time rule. Overflow invalidates the epoch before barriers are cleared; blocked producers remain registered until actual exit.
- [Focused regressions](../backend/tests/test_directory_index_contract.py) cover coalescing, independent same-sequence producers, queued-mutation retention, exception cleanup, rejected completed tokens, and a blocked root call. The blocked-call case preserves accepted rows, one verification request, and the scan permit until worker exit. Its late completion cannot restore source availability.
- Final focused command: `cd backend && .venv/bin/python -m pytest tests/test_directory_index_contract.py tests/test_directory_search.py --show-capture=no -o addopts='' -q`. Result: **153 passed, 1 skipped in 9.60 seconds**. The opt-in million-path fixture remains skipped; these changes do not alter query or storage layout.
- Configured mypy for `app/services/directory_cache.py` and Ruff for the changed implementation and test files passed. The root-directory mypy invocation did not load backend configuration and reported untyped third-party imports; the configured backend invocation resolved those reports without code suppression.
- Docker is not installed on this host. Supported-image SQLite qualification remains unavailable. No full implementation-completion aggregate, native Windows qualification, or capacity experiment is claimed. The new capability remains disabled. The existing version 2.0 contract remains accurate; final product-documentation changes remain gated on behavior qualification.

## Acceptance Evidence: Companion Prefix Barriers

Verified on 2026-11-01 in the Debian development container. This evidence closes companion prefix-coalescing and producer-lifetime tracking, plus the injected blocked-read and stale-publication tasks above. Full dirty-parent reconciliation and captured-sequence candidate acceptance remain open.

- [Companion coordinator](../companion/src-tauri/src/server/directory_manager.rs) records bounded entry/byte prefix barriers with the newest mutation sequence. Normal directory events no longer invalidate unrelated parent reads. Root baselines still reject final selection after changes that have not been reconciled.
- Distinct read tokens and RAII guards track full-pass baselines and parent reads through synchronous native calls and batch writes. Completed tokens cannot publish. Retirement waits for older current-epoch producers and pending mutations; there is no time-based expiry.
- Entry/byte barrier overflow and pending-queue overflow invalidate the epoch before clearing barriers or rejecting a new hint. Existing queued mutations remain pending. Invalidated blocked producers remain registered until their owners exit.
- [Native manager tests](../companion/src-tauri/src/server/directory_manager.rs) cover overlapping/repeated prefixes, newest sequences, unrelated paths, same-sequence producers, queued-work retention, entry/byte overflow, and actual blocked-thread ownership. A Linux descriptor-root test uses a real SQLite accepted/candidate database with an injected removal event: stale children and stale candidate selection are rejected, unrelated accepted rows remain searchable, and verification remains required.
- Event hints are copied and admitted one at a time. A single oversized event stops at pending-byte refusal without first copying all remaining paths. The overflow test preserves admitted work and invalidates old reads before dropping the new hint.
- Final `cargo test --manifest-path companion/src-tauri/Cargo.toml --lib server::directory_manager::tests`: **24 passed**, with no skipped tests in this selection. Rust formatting and `cargo clippy --manifest-path companion/src-tauri/Cargo.toml --lib --tests -- -D warnings` passed.
- These tests do not qualify Windows traversal, complete mutation reconciliation, native blocked-call isolation, or storage-capacity limits. The capability remains disabled. No dependency, schema, or product-version change was made.

## Acceptance Evidence: Failure Retry Timing

Verified on 2026-11-01 in the Debian development container. This evidence closes failure-retry timing only. Full watcher recovery, periodic-pass jitter, and failure/resource interaction qualification remain open.

- Backend initialization, verification, and update failures use a 30-second exponential base capped at five minutes. Source-specific jitter is bounded to 10 percent, with actual delays kept between 30 seconds and five minutes. Successful rescans clear backoff. Unchanged policy reloads cannot reset it; a changed policy permits a new attempt.
- Companion scan and update failures use the same delay bounds and jitter rule. A due retry no longer waits for the normal full-pass interval. Completed passes reset backoff; a partial pass waits for the degraded interval before another pass. This scheduling clock is separate from persisted complete-verification time.
- Deterministic tests check successive bases of 30, 60, 120, 240, 300, and 300 seconds, no eligibility before each retry deadline, eligibility at that deadline, jitter bounds and variation, and reset. Backend tests also cover repeated root failure followed by successful work and unchanged versus changed policy.
- Final backend contract/API selection: **157 passed, 1 skipped in 9.68 seconds**. Configured mypy for the changed module and Ruff for both changed backend files passed. The opt-in million-path fixture remains skipped.
- The native directory selection passed **66 tests with 2 ignored** before the final event-staging edit. The final native manager selection passed **24 tests**. Rust formatting and warning-free Clippy passed after the final native edit. The ignored checks were the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test; neither is claimed by this selection.
- The editor reports an SMB watcher `auth_protocol` type diagnostic on an unchanged line already present in `HEAD`. This work does not suppress or change that unrelated code. Configured mypy reported no errors in the changed module.
- No capacity measurement, Docker qualification, Windows native qualification, or implementation-completion aggregate is claimed. The new capability remains disabled.

## Acceptance Evidence: Subtree And Rename Hints

Verified on 2026-11-01 in the Debian development container. This evidence closes active-scan subtree queueing and companion rename-hint routing only. Complete immediate-child reconciliation against accepted rows and candidates, mutation-freshness timing, and captured-sequence final selection remain open.

- [Backend storage](../backend/app/services/directory_index.py) and [companion storage](../companion/src-tauri/src/server/directory_index.rs) add subtree work to building/candidate scan queues in the same transaction as directory rows and FTS entries. Repeated hints reset processed work. Tests inject a failed queue insertion and verify row/revision rollback.
- Accepted generations still receive observed row mutations, but do not receive scan work without an owner. Tests in both runtimes verify that an add does not advance accepted complete-verification time. Backend acceptance tests now reject candidate selection until the added subtree's queued read is complete.
- [Native event handling](../companion/src-tauri/src/server/directory_manager.rs) handles moved-out hints independently. Moved-in and unknown-direction hints queue a parent read instead of assuming the renamed object is a directory. Paired renames also queue both parents. Root-parent hints fence every older directory read; completed or stale tokens cannot bypass the barrier.
- A parent-read hint can queue the root, but cannot insert a root or inferred filename into directory rows. Native tests use a small real Linux directory tree with injected From-only, To-only, reversed To/From, and unknown-direction events. Full verification discovers the moved directory and child, removes old paths, and excludes a renamed regular file.
- Final backend contract/API command: **159 passed, 1 skipped in 9.99 seconds**. Configured mypy for the changed storage module and Ruff for the changed backend files passed. The opt-in million-path fixture remains skipped.
- Native directory selection: **71 passed, 2 ignored**. The added-subtree test also passed after the accepted-generation assertions were added. Rust formatting and warning-free Clippy passed on the final native edits. The ignored checks were the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test.
- These changes do not complete immediate accepted-row parent reconciliation: parent-read hints currently feed active build/candidate queues, and full verification supplies recovery when no such scan is active. Ordinary event-driven freshness and candidate reconciliation through a captured sequence are not claimed. No schema, dependency, product-version, or capability change was made.

## Acceptance Evidence: Bounded Parent Pruning

Verified on 2026-11-01 in the Debian development container. This evidence closes bounded storage paging/retirement and guarded Linux parent-scan pruning only. Complete accepted-generation dirty-parent reconciliation and captured-sequence final selection remain open.

- [Backend storage](../backend/app/services/directory_index.py) and [companion storage](../companion/src-tauri/src/server/directory_index.rs) return immediate-child pages with an original-path keyset cursor. Each page contains at most 256 paths and one MiB of UTF-8 path bytes. Literal percent/underscore names, composed/decomposed Unicode, and descendant branches without ancestor rows remain in scope. Multi-page tests cover 513 immediate children without a coverage cutoff.
- Missing-subtree retirement deletes at most 256 directory rows and 256 queued paths in each transaction. FTS/count triggers and selected revision updates are atomic. Tests cover signed row IDs, a 513-row subtree, queue-delete failure rollback, repeated no-op retirement, and candidate isolation. Complete-verification time is unchanged.
- [Linux traversal](../companion/src-tauri/src/server/directory_traversal.rs) checks exact child names with a held parent descriptor and no-follow metadata/open operations. A missing child or regular-file replacement permits retirement. Access failures, symlinks, mount changes, and parent replacement return errors instead of an empty result.
- [Companion parent scans](../companion/src-tauri/src/server/directory_manager.rs) check parent identity, read-token validity, and source stop state before bounded pruning writes. They check cancellation before each native child lookup and reserve disk growth before each transaction. Tests preserve unrelated accepted rows and freshness, reject stale tokens, and leave rows unchanged after parent replacement.
- Final backend contract/API selection: **162 passed, 1 skipped in 10.40 seconds**. Configured mypy for the changed storage module and Ruff for the changed backend files passed. Mypy noted unused existing third-party overrides in this focused invocation. The skipped fixture is the opt-in million-path experiment.
- Final native directory selection: **76 passed, 2 ignored in 5.09 seconds**. Warning-free Clippy and Rust formatting passed. The ignored checks are the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test; neither is claimed here.
- Backend scanner integration, an owned accepted-generation dirty-parent worker, mutation-freshness timing, complete SQL temporary-work accounting, and Windows native traversal remain open. No schema, dependency, version, or capability change was made. Existing version 2.0 documentation remains accurate; final behavior documentation is still gated on qualification.

## Acceptance Evidence: Backend SMB Reparse Exclusions

Verified on 2026-11-01 in the Debian development container. This evidence closes conservative backend reparse-directory exclusion and issue reporting only. SMB root identity, race-safe containment, and native Windows tag classification remain open.

- [Backend parent scans](../backend/app/services/directory_cache.py) exclude directory entries with the SMB reparse-point attribute. These entries are not inserted into searchable rows or queued for traversal. Ordinary directory batches remain progressive and complete.
- The coordinator records each exclusion only under a current scan-read token. [Storage](../backend/app/services/directory_index.py) aggregates the shared `unsafe_traversal` issue in the same transaction as coverage, issue totals, and selected revision updates. It accepts only building/candidate generations, preserves uncertain coverage, and does not advance complete-verification time.
- Injected SMB-entry tests verify that excluded directories are never read, an initial pass reports partial coverage, and a candidate with exclusions cannot replace usable accepted rows. A subsequent issue-free pass clears partial coverage through a fresh candidate and advances complete-verification time.
- Focused failure tests reject completed/invalidated read tokens and accepted/retired/missing generations. An injected metadata-update failure rolls back the issue row, coverage, and revision. Issue rows contain only aggregate codes and counts, not source paths.
- Final backend contract/API selection: **171 passed, 1 skipped in 10.59 seconds**. Configured mypy for both changed service modules and Ruff for the changed backend files passed. Mypy noted an unused existing `pyvips` override in this focused invocation. The skipped fixture is the opt-in million-path experiment.
- The editor still reports the previously recorded SMB watcher `auth_protocol` type diagnostic on an unchanged line. No suppression or unrelated watcher change was made. No native SMB server or Windows traversal qualification, capacity measurement, schema/dependency/version change, or capability activation is claimed. Existing version 2.0 documentation remains accurate; final behavior documentation is still gated on qualification.

## Acceptance Evidence: Backend Descendant Access Denial

Verified on 2026-11-01 in the Debian development container. This evidence closes backend source access-denial handling for descendants only. Root identity, containment races, native Windows traversal, and other source-failure classes remain open.

- [Backend scans](../backend/app/services/directory_cache.py) classify Python `PermissionError` and the installed SMB client's exact `SMBOSError` access-denied status at source-call boundaries. Runtime inspection confirmed that this client's SMB exception is not a `PermissionError` and has errno zero. Other SMB errors are not classified as access denial.
- An unreadable descendant records an aggregate `access_denied` issue and completes its queued attempt, so later readable siblings are scanned. The listed directory remains searchable, but no missing descendants are inferred or removed. Root denial still blocks publication. Local SQLite/storage permission failures still propagate rather than being treated as source exclusions.
- Issue recording reuses the guarded [storage transaction](../backend/app/services/directory_index.py) for unsafe traversal: active building/candidate generations only, aggregate issue totals and coverage updated atomically, uncertain coverage preserved, and no advance of complete-verification time. Read-token guards reject late denial results after invalidation.
- Tests inject denial at source open and during iteration using both exception representations. They cover readable sibling descendants, partial initial coverage, accepted-row preservation after a partial candidate, recovery through a later successful pass, root denial, local storage denial, and stale-parent rejection. Shared tests cover issue rollback, inactive generations, completed reads, and uncertainty for both issue codes.
- Final backend contract/API selection: **186 passed, 1 skipped in 11.68 seconds**. Configured mypy for both changed service modules and Ruff for changed backend files passed. Mypy noted an unused existing `pyvips` override. The skipped fixture is the opt-in million-path experiment. The editor's previously recorded watcher `auth_protocol` diagnostic remains on an unchanged line; no new index/test diagnostics were reported.
- No live SMB server qualification, native Windows qualification, schema/dependency/version change, or capability activation is claimed. Product documentation still describes partial coverage and failed verification; final behavior documentation remains gated on qualification. The new capability remains disabled.

## Acceptance Evidence: Backend Source Read Cleanup

Verified on 2026-11-01 in the Debian development container. This evidence closes backend source-iterator cleanup and injected blocked-close ownership only. Full idle-release, SMB-pool, source-replacement, and native shutdown qualification remain open.

- Regression tests first reproduced three cases where iterator close denial replaced storage, stale-read, or cancellation failures. The descendant handler then treated cleanup as a recoverable source denial and incorrectly completed the parent.
- [Backend scans and root probes](../backend/app/services/directory_cache.py) now share a cleanup guard. It attempts close on both successful and failed reads. A secondary close failure records only its exception type and preserves the original failure object, including task cancellation. Parent completion follows successful close; an unhandled close failure leaves work queued.
- Root probes check stop state and read-token validity after close before publishing availability. A blocked close retains the producer, scan-running state, and scan permit until the worker exits. Injected stop and epoch-invalidation tests preserve accepted rows and reject late availability.
- Root and descendant tests cover storage denial, stale reads, interrupted reads, task cancellation, exactly one close attempt, pending parent work, and no false coverage issue. Diagnostic tests capture the logger call directly and verify that private source-error text is absent. This avoids dependence on the test process's log-handler configuration.
- Final backend contract/API selection: **197 passed, 1 skipped in 11.87 seconds**. Configured mypy for the changed service module and Ruff for changed backend files passed. Mypy noted an unused existing `pyvips` override. The skipped fixture is the opt-in million-path experiment. The editor's previously recorded watcher `auth_protocol` diagnostic remains on an unchanged line; the test file has no diagnostics.
- Existing version 2.0 documentation still matches retained ownership and failure semantics. No live SMB server qualification, native Windows qualification, schema/dependency/version change, or capability activation is claimed. The capability remains disabled.

## Acceptance Evidence: Periodic Verification Jitter

Verified on 2026-11-01 in the Debian development container. This evidence closes periodic scheduling jitter and focused deadline checks only. Watcher-loss, overflow, idle/sleep, root-change, and resource-refusal recovery remain open.

- [Backend scheduling](../backend/app/services/directory_cache.py) uses its existing source-identity seed. [Companion scheduling](../companion/src-tauri/src/server/directory_manager.rs) uses a seed derived from its source session. A source's offset is stable across scheduling checks, so polling cannot move its deadline.
- Healthy and degraded passes become eligible at 90 to 100 percent of their configured intervals. The offset advances work by zero to 10 percent rather than delaying the configured deadline. Existing failure-retry deadlines remain authoritative; a due failure retry does not wait for a normal full-pass interval. Initial native source admission remains immediate when no retry gate applies.
- Tests check all 256 seed values for both configured intervals: no eligibility just before each deadline, eligibility at that deadline, bounded offsets, source variation, and retry-gate priority. Native tests verify source-session derivation and completed-pass scheduling reset. Existing partial-pass and failure-retry tests also pass. These changes do not write rows, revisions, coverage, or persisted complete-verification time.
- Final backend contract/API selection: **199 passed, 1 skipped in 12.16 seconds**. Configured mypy and Ruff passed. Mypy noted an unused existing `pyvips` override. The skipped fixture is the opt-in million-path experiment. The editor's previously recorded watcher `auth_protocol` diagnostic remains on an unchanged line; the test file has no diagnostics.
- Final native directory selection: **77 passed, 2 ignored in 5.13 seconds**. Warning-free Clippy and Rust formatting passed. The ignored checks are the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test; neither is claimed here.
- Existing product documentation does not conflict with this timing rule. Final behavior documentation remains part of qualification. No schema, dependency, product-version, or capability change was made. The capability remains disabled.

## Acceptance Evidence: Repeated Watcher Loss

Verified on 2026-11-01 in the Debian development container. This evidence closes idempotent repeated-loss persistence and injected watcher-error recovery only. Native watcher delivery, full overflow handling, idle/sleep, root-change, and unchanged resource-refusal recovery remain open.

- A backend regression reproduced a selected-revision increase after a repeated loss report even though every other response field was unchanged. [Backend storage](../backend/app/services/directory_index.py) and [companion storage](../companion/src-tauri/src/server/directory_index.rs) now update uncertain metadata and advance the selected revision only when coverage or aggregate issue totals change. Repeated reports retain one `event_loss` issue without deleting rows or advancing complete-verification time.
- Loss reports still invalidate read epochs and retain a verification request. Tests confirm that repeated invalidation rejects newly started old-epoch reads even when its persisted status is unchanged. Injected update triggers prove that unchanged reports skip generation-metadata writes.
- A revision-write failure rolls back issue insertion and generation metadata in both stores. Backend coordinator tests verify that the pending uncertainty and verification request survive the failed transaction and that retry persists the issue after storage recovers.
- Backend source and Linux companion manager tests inject repeated watcher errors, preserve accepted rows and freshness, complete a fresh verification pass, and then inject a new loss. Successful recovery clears selected issues; the new loss marks the new generation uncertain and advances its revision. The native store also preserves the final response across close/reopen.
- Final backend contract/API selection: **200 passed, 1 skipped in 12.10 seconds**. Configured mypy and Ruff passed. Mypy noted unused existing third-party overrides in this focused invocation. The skipped fixture is the opt-in million-path experiment.
- Final native directory selection: **80 passed, 2 ignored in 5.03 seconds**. Warning-free Clippy, Rust formatting, and editor checks for all touched code files passed. The ignored checks are the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test; neither is claimed here.
- Existing version 2.0 documentation still matches uncertainty and retained-row semantics. No schema, dependency, product-version, or capability change was made. The capability remains disabled.

## Acceptance Evidence: Shared Retry Admission

Verified on 2026-11-01 in the Debian development container. This evidence closes retry admission at shared scan-start entry points only. Full resource accounting, capacity restoration, maintenance under refusal, and broad watcher/platform recovery remain open.

- Regression tests reproduced backend initialization before its retry deadline and a direct full-rescan call moving that deadline before it was due. [Backend initialization and verification](../backend/app/services/directory_cache.py) now check retry deadlines before creating tasks, changing state, or acquiring SMB connections.
- Repeated backend starts before a deadline do not initialize storage. Initialization becomes eligible exactly at the deadline. The full-rescan test checks no early connection attempts or deadline movement, exponential backoff on a due failed attempt, and reset after a due successful attempt. Existing policy and scan-admission checks also pass.
- [Companion shared scan start](../companion/src-tauri/src/server/directory_manager.rs) now checks the retry deadline before claiming source ownership or a scan permit. The existing cold-request helper and periodic loop retain their gates, but no longer carry sole responsibility for admission.
- Native tests inject resource-paused status for cold and initialized sources. Repeated direct and cold-helper calls leave the deadline, backoff, message, progress, accepted response, and available scan permits unchanged. They create no producers or busy workers. Existing native deadline and retry-priority tests also pass.
- Final backend contract/API selection: **201 passed, 1 skipped in 12.45 seconds**. Configured mypy and Ruff passed. Mypy noted an unused existing `pyvips` override. The skipped fixture is the opt-in million-path experiment. The editor's previously recorded watcher `auth_protocol` diagnostic remains on an unchanged line; the test file has no diagnostics.
- Final native directory selection: **81 passed, 2 ignored in 5.19 seconds**. Warning-free Clippy and Rust formatting passed. The native manager has no editor diagnostics. The ignored checks are the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test; neither is claimed here.
- These gates do not change persisted rows, freshness, schema, dependencies, product versions, or capabilities. Existing documentation about bounded failure retry remains accurate. Final behavior documentation and broader resource-failure qualification remain open. The capability remains disabled.

## Acceptance Evidence: Pressure Maintenance Priority

Verified on 2026-11-01 in the Debian development container. This evidence closes foreground-priority checks and retained reclamation requests under injected refusal only. Complete operation-headroom measurements, pressure/interruption qualification, and resource accounting remain open.

- A backend regression reproduced pressure reclamation running while a foreground mutation was queued. [Backend reclamation](../backend/app/services/directory_cache.py) now checks pending observations under the coordinator lock, as logical cleanup already does. Deferral leaves the coalesced reclamation request pending.
- The extended backend test covers queued mutations, an active scan, an active-reader count, a refused maintenance attempt, a deferred reclamation result, and eventual completion. Requests remain pending until completion. The selected response, including revision and complete-verification time, is unchanged by refused or completed maintenance.
- The extended [native ownership test](../companion/src-tauri/src/server/directory_manager.rs) queues 257 mutations. The first bounded flush leaves one pending mutation and does not clear cleanup or reclamation. A held query permit and injected scan-busy state continue to defer maintenance after mutations drain.
- The native test then injects zero available filesystem space. Maintenance refuses admission without losing requests, leaking reservations, or changing the selected response. Restoring the space probe permits retired cleanup and reclamation to finish. Results, revision, coverage, and verification time remain identical to the response after foreground mutations completed. This is injected admission evidence, not a physical full-filesystem durability test.
- Final backend contract/API selection: **201 passed, 1 skipped in 12.22 seconds**. Configured mypy and Ruff passed. Mypy noted an unused existing `pyvips` override. The skipped fixture is the opt-in million-path experiment. The editor's previously recorded watcher `auth_protocol` diagnostic remains on an unchanged line; the test file has no diagnostics.
- Final native directory selection: **81 passed, 2 ignored in 5.07 seconds**. Warning-free Clippy and Rust formatting passed. The native manager has no editor diagnostics. The ignored checks are the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility test; neither is claimed here.
- Existing version 2.0 documentation already specifies maintenance after pending updates and remains accurate. No schema, dependency, product-version, or capability change was made. The capability remains disabled.

## Acceptance Evidence: Backend Root Scan Publication

Verified on 2026-11-01 in the Debian development container. This evidence closes backend root-scan publication checks at iterator read and cleanup boundaries only. Stable SMB root identity, mount/DFS validation, idle/sleep revalidation, and race-safe traversal remain open.

- A regression reproduced three failures in four initial cases: invalidation during close left the root available, while stop during a read or close allowed parent completion. The root probe already had checks at these boundaries; the parent-scan path did not.
- [Backend parent scans](../backend/app/services/directory_cache.py) now check stop state after each source iterator read, before processing its result. Root availability is published only after successful iterator close and guarded parent completion. The final stop check, token-guarded completion, and availability publication use the coordinator lock.
- Eight deterministic cases in the existing [contract tests](../backend/tests/test_directory_index_contract.py) cover stop and invalidation during `next` and `close`, for empty and nonempty roots. They reject parent completion and availability/probe-completion publication, preserve the complete selected response and verification request, close the iterator once, and release producers and scan permits after worker exit. These are injected read-boundary checks, not native SMB root-replacement or stalled-call shutdown certification.
- Final backend contract/API selection: **209 passed, 1 skipped in 12.71 seconds**. Configured mypy and Ruff passed. The skipped fixture is the opt-in million-path experiment. Mypy noted an unused existing `pyvips` override; the previously recorded watcher `auth_protocol` editor diagnostic remains unchanged. The test file has no editor diagnostics.
- Existing version 2.0 documentation still describes guarded publication and distinguishes basic availability from stable root identity. No product documentation change was required. No companion, schema, dependency, product-version, or capability change was made in this increment. The capability remains disabled.

## Acceptance Evidence: Backend Checkpoint Priority

Verified on 2026-11-01 in the Debian development container. This evidence closes backend normal-checkpoint foreground priority and focused retry checks only. Complete operation-headroom measurements, storage-pressure/interruption qualification, and native-platform coverage remain open.

- An update-loop regression queued 257 mutations and reproduced a normal checkpoint starting with one mutation still pending after the first bounded batch. Storage-level checkpoint ownership could not detect source-level pending mutations.
- [Backend checkpoint scheduling](../backend/app/services/directory_cache.py) now uses a maintenance worker that checks pending observations, active queries, active scans, and source stop under the coordinator lock before calling the existing threshold-based storage method. The periodic loop still runs maintenance outside the async executor. A deferred attempt does not disable later checks.
- The update-loop test verifies no checkpoint after the first batch and one checkpoint after the final mutation drains. Four worker tests check deferral for mutations, query ownership, scan ownership, and stop state, followed by eligibility when the test removes each blocker.
- A real SQLite WAL test pins a read transaction while the WAL exceeds the shared one-MiB threshold. The worker defers truncation and preserves the selected response. After the reader releases its snapshot, injected headroom refusal propagates without truncating the WAL or changing results. Restored admission permits truncation to zero bytes with identical rows, counts, revision, coverage, and complete-verification time. This is local SQLite and injected admission evidence, not a physical full-filesystem durability test.
- Focused checkpoint selection: **9 passed**. Final backend contract/API selection: **215 passed, 1 skipped in 13.45 seconds**. Configured mypy and Ruff passed. The skipped fixture is the opt-in million-path experiment. Mypy noted an unused existing `pyvips` override; the previously recorded watcher `auth_protocol` editor diagnostic remains unchanged. The test file has no editor diagnostics.
- Existing version 2.0 documentation already requires due checkpoints to defer for active work and pinned readers, and remains accurate. No product documentation, companion, schema, dependency, product-version, or capability change was made in this increment. The capability remains disabled.

## Acceptance Evidence: Blocked Worker Queue Overflow

Verified on 2026-11-01 in the Debian development container. This evidence closes overflow lifecycle checks for the existing observation queues and prefix barriers. It does not complete dirty-parent reconciliation or qualify queues added by that remaining work.

- The existing [backend blocked-root test](../backend/tests/test_directory_index_contract.py) now covers queue-entry, queue-byte, barrier-entry, and barrier-byte overflow while a real root-probe thread remains blocked. Tests use small injected limits to reach each boundary without large allocations.
- Each backend case checks epoch invalidation, cleared barriers and byte totals, retained pending work and its exact bytes, and repeated overflow. The old producer remains registered and the scan permit remains held. Stale child commits, parent completion, and candidate selection all fail. Draining admitted work preserves exact accepted result rows and complete-verification time, with uncertain coverage and one aggregate event-loss issue. The late root read cannot restore availability; ownership releases after thread exit.
- The existing [native blocked-worker test](../companion/src-tauri/src/server/directory_manager.rs) now runs the same four limit cases against real accepted/candidate SQLite generations. A `ReadParent` hint exercises the shared parent-hint bounds. Repeated overflow preserves admitted work, bounded byte accounting, one verification-needed flag, and one aggregate event-loss issue.
- On Linux, native batch and candidate publication methods reject the invalidated token against a validated root. Exact accepted rows, counts, and complete-verification time remain unchanged. The blocked thread retains its RAII read and scan permit until actual exit; draining observations does not release them early. These injected blocked-thread checks do not certify cancellation of stalled native filesystem calls or native Windows traversal.
- Final backend contract/API selection: **218 passed, 1 skipped in 13.37 seconds**. Ruff passed. The skipped fixture is the opt-in million-path experiment. Final native directory selection: **81 passed, 2 ignored in 5.27 seconds**. Warning-free Clippy and Rust formatting passed. The ignored checks are the opt-in million-path experiment and explicitly invoked Python-to-Rust compatibility check. Both touched test files have no editor diagnostics.
- This increment extends existing regression tests; it does not change runtime behavior. Existing version 2.0 documentation remains accurate. No schema, dependency, product-version, or capability change was made. The capability remains disabled, and broader dirty-parent, recovery, storage, and platform qualification remains open.

## Acceptance Evidence: Companion Accepted Parent Storage

Verified on 2026-11-01 in the Debian development container. This evidence closes companion storage primitives only. Native worker integration was not part of this checkpoint; the later [worker evidence](#acceptance-evidence-companion-accepted-parent-worker) records that work. Backend parity and broader recovery qualification remain open.

- [Companion storage](../companion/src-tauri/src/server/directory_index.rs) now has separate methods to queue/requeue an accepted parent, write its immediate children, and finish its queued read. They require the selected accepted generation; writes and completion also require pending parent work. Full-scan writers and completion retain their existing building/candidate-only guards.
- Child batches contain at most 256 rows and one MiB of UTF-8 path bytes. Byte refusal stops consuming input before SQL starts. Non-immediate or unrelated child paths are rejected. The root parent is supported without inserting an empty directory row.
- Directory rows, FTS/count triggers, newly discovered subtree work, and selected revision change in one transaction. Only newly inserted directories queue descendant reads; existing children do not cause repeated subtree walks. Repeated child batches do not change the selected revision. Queuing and completing work do not advance complete-verification time.
- Four focused tests cover root and non-root parents, child/deeper-subtree discovery, repeated hints, no-op revision behavior, row/byte bounds, bounded input consumption, missing/completed parent work, building/candidate/retired/missing generations, replacement of the selected generation, and reopen with pending work. Injected queue and revision-write failures roll back rows and work and permit retry. Initial tests also exposed the full-scan completion guard; a separate accepted-parent completion method resolved that boundary without relaxing it.
- Final native directory selection: **85 passed, 2 ignored in 5.14 seconds**. The explicitly invoked small Python-to-Rust source-validation compatibility test also **passed**. The routine ignored checks are that separately invoked compatibility test and the opt-in million-path experiment; the capacity experiment was not run. Warning-free Clippy, Rust formatting, and editor diagnostics passed.
- Existing version 2.0 documentation still describes the live manager behavior and its remaining reconciliation work accurately. No product documentation, schema, dependency, product-version, or capability change was made. Existing user edits in the native manager were preserved. The capability remains disabled.

## Acceptance Evidence: Companion Accepted Parent Worker

Verified on 2026-11-01 in the Debian development container. This evidence closes companion Linux accepted-parent worker integration for the tested event and admission paths. Backend reconciliation, safe Windows traversal, native watcher delivery/loss qualification, blocked-call shutdown, and complete captured-sequence candidate acceptance remain open.

- [Observed mutations](../companion/src-tauri/src/server/directory_index.rs) now have a manager-owned entry point that commits affected accepted parents and subtree work in the same transaction as rows and revision. Added directories queue their own read even when the observation inserted their row first. Renames queue both parents and the renamed subtree only when it is already known as a directory; unknown/file destinations are discovered through parent reads. Existing unowned mutation behavior is unchanged.
- The [native update worker](../companion/src-tauri/src/server/directory_manager.rs) now attempts reconciliation after applying a bounded observation batch. It requires source and shared scan ownership and rechecks the selected queued generation after admission. The worker shares parent traversal with full scans: held-descriptor checks, current read tokens, row/byte-bounded writes, bounded missing-child pruning, guarded parent completion, and separate disk reservations.
- Reconciliation does not select a candidate, advance persisted complete-verification time, reset the full-pass scheduling clock, clear uncertainty, or remove the verification-needed flag. Capacity refusal and retry backoff leave queued work eligible. Storage refusal releases reservations, producers, and scan permits; the existing failure path schedules retry. Cleanup and normal checkpoints defer while accepted-parent work remains pending.
- A real Linux filesystem test covers paired, From/To, reversed To/From, and unknown-direction rename hints. It discovers added/moved-in descendants, removes an indexed subtree missing from the filesystem, excludes a renamed regular file, and rejects a stale accepted-generation batch. Each case checks scan-capacity deferral, injected zero-space refusal, retry gating, eventual progress, unchanged verification clocks, and complete ownership release. Watcher delivery is injected; this is not native event-delivery or physical full-filesystem durability certification.
- An async manager `tick` test verifies that the real background update worker discovers a moved-in subtree without a full pass. It waits for update-permit release and checks unchanged selected generation and verification clocks, no producer/permit/reservation leak, and updated results. A storage test injects accepted-parent queue failure and verifies complete row/revision/work rollback, then successful retry with both rename parents and added subtree work.
- The maintenance ownership fixture now completes its synthetic accepted-parent jobs before expecting cleanup. It verifies that reconciliation work itself defers maintenance after query and scan ownership end.
- Final native directory selection: **88 passed, 2 ignored in 5.21 seconds**. The explicitly invoked small Python-to-Rust source-validation compatibility test also **passed**. The routine ignored checks are that separately invoked compatibility test and the opt-in million-path experiment; the capacity experiment was not run. Warning-free Clippy, Rust formatting, and editor diagnostics passed.
- Version 2.0 developer documentation now describes the live worker and remaining limits. The editor CLI has no content-edit command; the user approved this one direct page copy edit. Documentation validation and the required website build passed. No schema, dependency, product-version, or capability change was made. Existing user edits were preserved. The capability remains disabled.

## Acceptance Evidence: Backend Accepted Parent Storage

Verified on 2026-11-02 in the Debian development container. This evidence closes backend storage primitives only. Backend mutation/coordinator integration, source traversal and missing-child pruning, and the accepted-parent background worker remain open. The broad dirty-parent task is not complete.

- [Backend storage](../backend/app/services/directory_index.py) now has separate selected-accepted and pending-work queries, parent queue/requeue, bounded immediate-child writes, and pending-parent completion. Writes and completion require the exact pending parent on the selected accepted generation. Full-scan writers retain their building/candidate-only guards.
- Child batches are limited to 256 rows and one MiB of UTF-8 path bytes before SQL. Byte refusal stops input consumption immediately. Root work is supported without inserting an empty directory row; unrelated and deeper descendants are rejected as immediate children.
- Rows, FTS/count triggers, new subtree work, and selected revision commit together. Existing children do not requeue subtrees or change revision. Queue/requeue and completion preserve the selected response, and reconciliation never advances complete-verification time.
- Seven focused cases in the [existing contract tests](../backend/tests/test_directory_index_contract.py) passed. They cover discovery, repeat no-ops, persistent pending work after reopen, completion/requeue, building/candidate/retired/missing and stale selected generations, root and parent boundaries, row/UTF-8 byte bounds, early input refusal, injected queue/revision/completion failures, and retry after denied write headroom. Failed writes leave accepted rows and pending work unchanged.
- Final backend contract/API command: `cd backend && .venv/bin/python -m pytest tests/test_directory_index_contract.py tests/test_directory_search.py --show-capture=no -o addopts='' -q`. Result: **225 passed, 1 skipped in 14.09 seconds**. The opt-in million-path fixture was not run. Configured mypy, Ruff, and changed-file editor diagnostics passed; mypy emitted only its existing unused third-party configuration-section note.
- The explicitly invoked small Python-to-Rust source-validation compatibility test **passed**. No schema, dependency, product-version, or capability change was made. Existing version 2.0 product documentation remains accurate because the backend worker is still required. Existing user changes were preserved. The capability remains disabled.

## Acceptance Evidence: Backend Accepted Parent Discovery

Verified on 2026-11-02 in the Debian development container. This evidence closes backend accepted-parent discovery only. It does not complete safe missing-child pruning, SMB identity and containment, complete mutation/hint routing, or the broad dirty-parent task.

- Manager-owned observed mutations now queue accepted parents in the same transaction as rows and revision. Additions queue their own read even when the observation inserted their row first. Renames queue both parents and a known directory destination. A failed queue insertion rolls back the rename and retains the original observation for retry. The existing unowned storage API retains its previous behavior.
- The backend update loop runs accepted-parent discovery outside the async executor. A worker obtains source-generation and shared scan ownership, rechecks pending selected work, and uses the existing live read-token and bounded row/byte write checks. New children queue descendant reads. Each scheduling slice is bounded; an operating-system call can still block beyond that slice.
- Discovery preserves the selected generation, complete-verification time, full-pass scheduling time, uncertainty, and verification-needed flag. Retry, source unavailability, stop, capacity refusal, and generation ownership defer reads. Storage refusal, access denial, redirected children, and failed iterator cleanup leave work pending. This worker does not prune missing children from listing omissions.
- Focused checks cover the real background update loop with an injected SMB tree, atomic rename/parent rollback, repeated refusals and recovery, failed parent reads, all three maintenance gates, and a blocked read. The blocked worker retains its producer, scan permit, and generation ownership until actual exit, rejects late rows after invalidation, and preserves accepted rows and pending work. Existing child rows do not trigger repeated subtree walks.
- Final backend contract/API selection: **238 passed, 1 skipped in 14.71 seconds**. The skipped fixture is the opt-in million-path experiment. Configured mypy and Ruff passed. Pylance verified all nine child-commit and five parent-completion call sites. The previously recorded watcher `auth_protocol` diagnostic remains on unchanged code; no new storage or test diagnostics were reported.
- The explicitly invoked Python-to-Rust source-validation compatibility test passed. The user approved one direct copy edit to the existing version 2.0 developer page because the docs editor CLI cannot edit page content. Documentation validation, the required website build, and the derived documentation-report refresh passed. No schema, dependency, product-version, or capability change was made. The capability remains disabled.

## Acceptance Evidence: Backend Parent And Rename Hints

Verified on 2026-11-02 in the Debian development container. This evidence closes backend parent-hint routing and the regular-file destination regression only. Safe missing-child pruning, all mutation/partial-failure hooks, SMB identity and containment, and captured-sequence candidate acceptance remain open.

- Five source-level regressions first reproduced retained old-only rename rows and unverified new-name rows, including a regular-file destination. The SQLite watcher now handles each direction independently: remove an old prefix and queue its parent, or queue the new parent without inserting a row. Add events also queue a parent. The legacy watcher remains unchanged while its required lifecycle tests are retained.
- Parent hints queue the selected accepted generation and active building/candidate generations in one transaction. Repeated hints reset processed work. Queue failure rolls back every generation and retains the original observation. The hint does not insert an inferred directory or change the selected revision or verification time.
- Root-parent hints fence older non-root reads. Root and overlapping barriers coalesce at the newest sequence. Entry/byte overflow invalidates the epoch, retains admitted hints and their byte accounting, preserves live producers, and rejects late children. Parent-hint tests use small injected limits; they do not establish native SMB notification delivery.
- The existing browser transfer-destination helper could insert a regular file as a directory. Its live SQLite path now queues the destination parent for source validation. A regression verifies no row or revision change before validation, directory-only discovery afterward, and unchanged complete-verification time. The legacy cache helper retains its previous behavior.
- Reconciliation pool-entry failure now makes the source unavailable without deleting accepted rows, as full-pass pool-entry failure already does. Storage and descendant failures after session admission remain distinct. Focused source-loss and accepted-parent checks passed.
- Backend contract, API, cache lifecycle, and browser selection: **648 passed, 1 skipped in 24.53 seconds**. Configured mypy and Ruff passed. Documentation validation, the required website build, and the derived report refresh passed. The larger subsequent selection below also covers this work. The new capability remains disabled. No schema, dependency, or product-version change was made.

## Acceptance Evidence: Backend Mutation Observation Guard

Verified on 2026-11-02 in the Debian development container. This evidence closes the common backend observation guard and its connected SMB call sites only. Full operation-level reconciliation, partial recursive-mutation races, safe missing-child pruning, companion parity, and captured-sequence candidate acceptance remain open.

- The SMB worker accepts explicit affected paths rather than inferring mutation behavior from operation-name strings. One shared guard queues source-relative parent hints before dispatch and in `finally` after actual synchronous exit. Directory/file creation, recursive deletion, empty-directory removal, rename, copy/move, writes, exclusive archive targets, stream publication, and cleanup use the guard. Move-source delete and final handle close use the same guard through their retained worker.
- Hints require the current source's connection-cache object, host/share/port, credentials, configured root, and live stop state to match. Structured Windows-path parsing resolves native SMB paths relative to that root. Read-only and unowned operations do not queue work. Hint failure invalidates observations and logs only its exception type without replacing the source operation result.
- A source-level directory-creation test checks before-dispatch and after-exit hints on success and source denial, both at a share root and below a configured prefix. Cancellation and injected timeout tests keep a real worker blocked after the async request exits. Only worker release sends the second hint and invalidates reads started during the mutation; the existing pool hook retains the worker future.
- Five source-binding cases reject unrelated contexts, roots, credentials, stopped sources, and unowned operations. A failed-hint test preserves the successful source result, retains verification, and checks exact privacy-safe warning arguments. Eight compact call-site cases verify explicit affected paths for create-directory, create-file, delete, empty-directory removal, rename, copy, move, and write.
- Final affected backend selection: **835 passed, 3 skipped in 25.05 seconds**, covering SMB, SMB pool, directory-index contract, directory API, cache/persistence lifecycle, and browser tests. The skips are existing opt-in/live-server checks. Configured mypy for all four touched source modules and Ruff passed. Pylance confirmed all 20 call-wrapper, 22 operation-wrapper, and three move-reader call sites. The touched SMB source and tests have no editor diagnostics. The previously recorded watcher diagnostic remains on unchanged code.
- Version 2.0 documentation records this guard and its limits. Documentation validation, the required website build, and the derived documentation-report refresh passed after the final product-page edit. Unrelated generated CSS-stat changes were removed. No schema, dependency, product-version, or capability change was made. The capability remains disabled; the full implementation-completion aggregate has not been run.

- Source-to-query follow-up on 2026-11-02 reproduced a partial recursive-delete failure: one descendant was removed before another deletion was denied, but parent reconciliation left the removed descendant searchable because the top-level target still existed. Each recursive child deletion now uses the existing source-bound observation guard before dispatch and after actual synchronous exit. The original source result or failure is preserved.
- The existing native SMB metadata fixture now verifies successful and partly failed recursive deletion through the production reader, accepted-parent reconciliation, and search. Deleted rows disappear, surviving and unrelated rows remain, queued work completes, ownership and disk reservations release, and full-verification time does not advance. The existing four creation cases now also check query-visible reconciliation after success and failure below both configured roots. These injected checks do not certify live server behavior, every mutation operation, or companion parity; the broad mutation and reconciliation tasks remain open.
- Follow-up SMB, directory-index contract, and directory API selection: **497 passed, 3 skipped in 19.92 seconds**. The skips are existing opt-in/live-server checks. Configured mypy, Ruff, and changed-file editor diagnostics passed; mypy emitted only its existing unused third-party configuration note. Existing version 2.0 developer text already requires failure reconciliation and remains accurate. No product-page, schema, dependency, version, or capability change was made, and no implementation-completion aggregate is claimed.

## Acceptance Evidence: Child Paging And Bulk Buffer Bounds

Verified in the Debian development container. These changes close two local buffer and temporary-sort gaps, not complete resource qualification.

- Both storage bulk writers now limit input path bytes as well as row count before building row keys. An oversized path is refused without deleting earlier committed rows. The Python small-budget regression verifies transaction boundaries. The Rust regression uses paths above half the real batch-byte limit and verifies one transaction per path, then preserved data after oversized rejection.
- Immediate-child paging no longer uses a computed-path `DISTINCT` and sort. Both stores stream the ordered indexed generation/path range and retain a sorted child buffer bounded by rows and UTF-8 bytes. Missing ancestor rows, punctuation, original Unicode names, cursors, and byte-budget errors retain their prior behavior. A prefix-aware frontier stops a filled page without reading the full remaining flat tree. Each runtime uses SQLite instruction counts to verify this on 8,192 rows. The Python test inspects actual query plans and requires a covering index with no temporary B-tree. Both runtimes compare interleaved descendants with a sorted reference across seven byte budgets.
- The repeated existing storage fixtures passed after the bulk-buffer changes. Python reported **21,563,480 managed bytes for 100,001 paths** and **173,067,224 bytes for 1,000,001 paths**; both cases completed in **28.51 seconds** combined. Rust reported **167,534,064 managed bytes for 1,000,001 paths**, with the test completing in **51.54 seconds** in a debug build. These totals are fixture observations, not peak-storage, application RSS, endpoint latency, or production traversal measurements.
- Verification-generation peaks, external SQLite temporary work, operation headroom, smaller-cache capacity checks, and application-level resource measurements remain open. No budget or cache default was changed. The new capability remains disabled.

## Acceptance Evidence: Initial Companion Application Mutation Guard

Verified in the Debian development container. This closes the shared synchronous guard and its first three handler integrations, not complete companion mutation parity.

- Single-directory creation, same-parent rename, and empty-directory deletion now queue parent observations before and after their synchronous filesystem calls. The guard requires the current drive/root binding, a live source, validated source-relative paths, bounded observations, and root verification. It reuses the existing producer and changed-prefix coordinator. Hint errors retain verification and do not replace the operation result. A narrow Axum state extractor keeps the handlers testable without a native application handle.
- The guard is owned inside `spawn_blocking`. Cancelling the async waiter cannot send the completion hint or release the producer before the actual call exits. The blocked-worker regression checks retained producer and barrier ownership, then completion hints and release after actual exit.
- Linux manager tests disable the watcher and check creation, deletion, and subtree rename after both success and injected post-mutation failure. Accepted data stays selected until reconciliation, repaired queries have exact counts, full-verification time does not advance, pending work drains, and disk reservations release. Five additional cases reject unrelated drives, changed roots, stopped sources, outside paths, and unavailable identity without replacing the original operation error.
- The direct-handler create/rename/empty-delete lifecycle test exposed a normal observation race entering resource-failure backoff and retaining an old row. Cooperative `Interrupted` failures now leave existing retry deadlines, failure delays, messages, and verification clocks unchanged. A direct state test verifies both fresh and existing storage-refusal states. The previously failing real-tree lifecycle now completes through the background manager without increasing its timeout.
- Measured direct-handler-to-query timings on the small native Linux tree were **244 ms creation, 308 ms rename, and 296 ms deletion**, compared with the **2,000 ms target**. These debug-build test observations include background reconciliation but not HTTP transport or browser rendering. They do not establish production latency, all-filesystem behavior, or native Windows execution.
- Recursive deletion, move/copy, parent-creating archive/upload paths, source replacement races, and complete initial/verification mutation qualification remain open. Windows cross-compilation passed; this is not native execution evidence. No dependency, schema, product-version, or capability change was made.

## Acceptance Evidence: Companion Recursive And Parent-Creating Mutations

- Recursive deletion retains the standard filesystem deletion implementation. Its blocking worker owns pre/post observations until actual exit. Bounded row/byte pages from active accepted/build/candidate catalogues identify parents to reconcile after partial deletion. Native held-parent checks still authorize row removal; catalogue membership alone does not.
- Upload, local copy/move, and stream-transfer destinations observe source-relative ancestor chains around parent creation. Direct and remote-to-local archive extraction guard root, directory, and file-target preparation in their actual blocking workers. Paused and resumed direct extraction carries the manager to the destination-root binding, not the source-drive label. Failed hints preserve the filesystem operation result and require verification.
- A real stream-to-query regression exposed an early ancestor read entering failure backoff before parent creation finished. Missing or non-directory descendant opens now queue an ancestor check and return cooperative interruption. They do not prove absence, remove rows, or advance full-verification time. A deterministic watcher-disabled test forces this interleaving and verifies unchanged failure delay and retry deadline.
- Watcher-disabled native tests cover ordinary and root-bound parent creation, successful and partial recursive deletion, retained accepted results, unchanged verification time, drained work, and released disk reservations. Additional tests cover candidate-only subtree paths, literal punctuation, multi-page results, queue refusal with retained producers, and actual-exit ownership for all four guard scopes after async cancellation. The existing real background-handler lifecycle now includes recursive deletion, complete and truncated streams, and a real ZIP extraction.
- Final companion library selection: **419 passed, 2 ignored in 5.74 seconds**. The ignored tests are the existing opt-in million-path fixture and Python-to-Rust compatibility fixture. Strict host Clippy passed. Native Windows execution, full HTTP and source-replacement races, complete mutation timing, and broad recovery qualification remain open. No schema, dependency, product-version, or capability change is introduced. This is not completion of the full plan.
- Final Windows production and test cross-compilation, Rust formatting, editor diagnostics, documentation validation, website build, and derived documentation-report refresh passed. Cross-compilation is not native execution. Product documentation contains only the behavior contract and limits; this plan holds the verification record. The implementation-completion aggregate has not been run because the full plan is not complete.

## Acceptance Evidence: Recursive SMB Copy Follow-Up

- Recursive child copies now use the existing observation guard for each destination. Success and injected child failure both retain pre/post child hints and preserve the original source result. The focused two-case guard regression passed. Source-to-query copy, upload, archive, and full partial-failure coverage remain open.

## Validation Of This Follow-Up

- The affected backend SMB, pool, storage, directory API, cache, and persistence selection passed: **716 passed, 3 skipped in 21.86 seconds**. The skips are existing opt-in/live-server checks. Python lint and configured source type checks passed; mypy emitted only its existing unused third-party configuration note.
- All companion library tests passed: **417 passed, 2 ignored in 5.65 seconds**. Formatting, warning-free host Clippy, and Windows production/test cross-compilation passed. The ignored million-path fixture was also run explicitly and passed as recorded above. Changed production modules and directory-contract tests have no editor diagnostics. The SMB test file retains baseline typing diagnostics on unchanged lines. An explicit `smbclient.path` import resolved the new copy test's submodule diagnostic; current Pylance diagnostics, its two focused tests, and Ruff verified the fix.
- Version 2.0 developer text, documentation validation, the required website build, and the derived documentation-report refresh passed. Only unrelated generated CSS statistics were restored. The complete implementation aggregate was not run because implementation is still partial. Legacy removal, full mutation coverage, application capacity/resource measurements, broad safety/policy qualification, and capability activation remain open.

<details>
<summary>Approved Requirements and Original Acceptance Contract</summary>

## Original Status and Scope

Approved implementation plan, dated 2026-11-01. Repository version: 2.0.26. The eight implementation decisions are approved. Documentation changes are limited to version 2.0. This reference does not describe current completion status.

### Scope Updates From Implementation Review

The user approved the following updates on 2026-11-01:

- Allow at most 32 distinct normalized search terms, with the existing 4 KiB raw UTF-8 input limit.
- Accept the existing dependency upgrades for `anyio`, `starlette`, `websockets`, `platformdirs`, and `wcwidth`. Further dependency changes remain subject to the dependency workflow.
- Keep routine tests focused and fast. Retain one generated 100,001-path cutoff regression per index runtime; run million-path fixtures only by explicit opt-in, outside the aggregate. Smaller fixtures cover other correctness cases. Do not expand routine tests into a performance matrix.
- macOS directory indexing is outside this implementation scope. Do not implement a macOS traversal adapter. Report indexing as unavailable and preserve successful recent-history results. This is an intentional scope exclusion, not an unfinished acceptance gate. Windows directory indexing remains in scope.

The user confirmed standard Python `sqlite3` for backend directory indexes. Use Debian's system SQLite library, as the application database does; remove APSW and its separately bundled SQLite runtime. Do not build a custom SQLite library or mix Debian distributions to obtain a newer release. Validate STRICT tables, RETURNING, and FTS5 trigram support in the available backend runtime; container-image checks are outside scope. Keep WAL and `synchronous=FULL`. Prevent the documented WAL-reset race by using one connection for every active database's writes and checkpoints under its writer lock, with strictly read-only query connections and a process ownership lease. Cleanup can open a writer only after the active writer has closed and cleanup holds that lease. External writes to active managed indexes are unsupported. Continue Debian security updates; this configuration does not claim that Debian has backported the WAL-reset fix. The user resumed implementation for this binding and concurrency change only; the remaining plan work is not resumed by this decision.

This plan addresses three required work items:

1. Replace per-query local-drive scans with a persistent, disk-backed directory index.
2. Distinguish recent directories from directory-index matches with result icons.
3. Implement the [selected independent-term search TODO](../TODO.md#directory-navigation-and-file-search) for directory navigation and file search, including matching, ranking, and highlighting.

Use SQLite-only directory-index storage in both the Python backend and the Rust companion. The shared contract is the SQLite schema, source validation, lifecycle, and search semantics. Do not implement JSONL v3, snapshot exports, snapshot checksums, a second persisted representation, or an application mutation journal. This decision replaces the earlier full-RAM index and JSONL persistence design. Backend directory storage and queries are now in scope, not only its persistence boundary.

Keep the current source scope. Directory-index matches cover the connection of the pane targeted by the quick bar. Recent-directory matches cover the signed-in user's accessible history across connections. File search covers loaded regular files in the active directory and accessible recent-file history. Match directory terms against paths and file terms against basenames, as the current providers do. Do not add a full-drive file index, file-content search, scans of other drives, or broader history access.

Keep recent history in the existing backend application database. Change its query and ranking behavior for independent terms, not its ownership or retention policy. Local directory databases stay on the companion computer; do not upload them to the backend. Existing local paths in recent history remain subject to the current history policy.

There is no fixed directory-count limit, including during builds, verification, updates, and reopening a database. Memory settings control caches and in-flight work, not searchable coverage. Actual disk capacity, source failures, and traversal-safety limits still apply and must produce specific, visible errors. Response-size limits remain separate from index coverage.

Important resource controls must be available in Settings > Administration, with separate backend and companion policy scopes. This is required work, not an optional later dialog. Publish product documentation with implementation through the website documentation workflow; this file remains an implementation plan.

### Autonomous Implementation Scope

The implementation tasks must be executable with repository tools, generated fixtures, and available local test resources. The following prerequisites are removed. Their removal does not establish platform support or production performance.

| Removed prerequisite | Replacement |
| --- | --- |
| Manual Windows hardware, removable-drive, cloud-provider, sleep, and stalled-network certification. | Automated tests on available platforms, injected identity/event/failure cases, and conservative behavior for unverified source types. Record tests that were not run. macOS indexing is excluded as specified above. |
| Measurements on a representative production computer or deployment. | Repeatable generated 100k and million-path experiments on the available host, with its environment and measurement limits recorded. |
| Human ranking approval or architecture sign-off before implementation. | One approved technical contract per decision below; do not maintain two implementations. |
| A project-level consent or policy-owner approval meeting. | Implement and test runtime administrator authorization, local consent, and owner-conflict handling. These security controls remain required. |
| Selecting a future product release, publishing artifacts, or performing a production rollout. | Update documentation in version 2.0 only and prepare compatibility notes. Do not change versions, publish releases, or deploy. |

Keep correctness, authorization, containment, recovery, and bounded-resource tests. Do not remove an implementable safety control because its manual certification is unavailable. The decisions below are approved implementation requirements, not evidence of completed implementation or checks.

## Verified Findings

| Finding | Evidence | Effect |
| --- | --- | --- |
| Every local directory query waits for a filesystem walk. | [Local search handler](../companion/src-tauri/src/server/handlers.rs#L5473) | Query time depends on drive size and speed. |
| The walker caps discovered directories at 100,000 and responses at 50. | [Scan constants](../companion/src-tauri/src/server/handlers.rs#L5450) | The discovery cap hides paths; the response cap does not avoid traversal. |
| Activation sends an empty query, and requests can overlap. | [Activation handler](../frontend/src/components/FileBrowser/search/useDirectorySearchProvider.tsx#L383) | Opening the mode can cause an extra wasted scan. |
| The provider waits for history and directory results together. | [Directory provider](../frontend/src/components/FileBrowser/search/useDirectorySearchProvider.tsx#L239) | Slow local requests hold back available history. |
| HTTP cancellation does not stop the running blocking walker. | [Search execution](../frontend/src/components/FileBrowser/UnifiedSearchBar.tsx#L450) and [walker](../companion/src-tauri/src/server/handlers.rs#L5520) | Obsolete scans can continue using workers. |
| Backend directory search scans its full memory set, normalizes paths per query, and sorts all matches. | [Cache search](../backend/app/services/directory_cache.py#L316) | Changing only the serializer would not solve RAM use or query allocations. |
| Backend JSONL v2 saves copy the full set; save time substitutes for verification time. | [Persistence lifecycle](../backend/app/services/directory_cache.py#L453) | Replace full rewrites and preserve distinct verification metadata. |
| Current persistence deliberately accepts a count mismatch. | [Persistence test](../backend/tests/test_directory_cache_persistence.py#L507) | Legacy cache validity is insufficient for migration; rebuild rather than import. |
| Existing pane watchers are non-recursive. | [Directory watcher](../companion/src-tauri/src/server/watcher.rs#L176) | Drive-wide freshness needs separate observation and reconciliation. |
| Current searches generally match the whole query string. | [Cache search](../backend/app/services/directory_cache.py#L316), [file provider](../frontend/src/components/FileBrowser/search/useFileSearchProvider.tsx), [recent directories](../backend/app/services/recent_directories.py), and [recent files](../backend/app/services/recent_files.py) | Independent terms must be implemented before filtering and truncation in each source. |
| Frontend normalization differs from Python normalization. | [Frontend helper](../frontend/src/components/FileBrowser/search/recentHistory.ts) and [backend helper](../backend/app/services/history_common.py) | Locale lowercase and limited combining-mark removal do not establish case-fold parity. |
| Both directory sources use folder icons, while recent files have history icons. | [Directory provider](../frontend/src/components/FileBrowser/search/useDirectorySearchProvider.tsx#L264), [file provider](../frontend/src/components/FileBrowser/search/useFileSearchProvider.tsx#L89), and [row renderer](../frontend/src/components/FileBrowser/QuickBarResultRow.tsx#L18) | Add a semantic recent-directory icon. |
| Typed-query ranking removes group headers. | [Ranking helper](../frontend/src/components/FileBrowser/search/recentHistory.ts#L21) | Source icons remain useful after result groups are merged. |
| There is no progress-refresh loop or equivalent companion API timing log. | [Bar status](../frontend/src/components/FileBrowser/UnifiedSearchBar.tsx#L982) and [API client](../frontend/src/services/api.ts#L550) | Add quiet refresh and privacy-safe timing. |

The selected directory provider uses a 200 ms debounce. The unused zero-debounce smart provider is not the cause; see [mode routing](../frontend/src/pages/FileBrowser.tsx#L3570). A localhost console notice does not measure permission delay. Production scan time, drive size, and link cycles remain unmeasured.

## Research Basis and Selected Design

Use disk-backed SQLite directory rows with an external-content FTS5 trigram index. Queries use indexed candidates where suitable and complete literal substring scans where required. SQLite is both the working catalogue and its persistent storage. Native events accelerate updates; full background verification covers missed events. No application list or set contains the entire directory catalogue.

The [FTS5 documentation](https://www.sqlite.org/fts5.html) establishes substring indexing, boolean candidate queries, and the three-Unicode-character minimum for trigram MATCH. Ordinary word or prefix indexes do not preserve arbitrary substring matching. FTS operators are internal implementation details, not a user query language. Do not use BM25 as the product ranking rule.

The [SQLite cache documentation](https://www.sqlite.org/pragma.html#pragma_cache_size) describes a page-cache target, not a hard process-RSS limit. The [temporary-file documentation](https://www.sqlite.org/tempfiles.html) identifies journals, WAL, temporary sorts, and maintenance files that need disk accounting. A retained SQLite database is not an export that can safely be copied while active.

The [notify constraints](https://docs.rs/notify/8.2.0/notify/#known-problems) require fallback verification for network mounts, dropped events, and platform watcher limits. [Tokio blocking-task cancellation](https://docs.rs/tokio/latest/tokio/task/fn.spawn_blocking.html) cannot interrupt a started blocking OS call. [WalkDir](https://docs.rs/walkdir/latest/walkdir/struct.WalkDir.html) supplies traversal controls but follows a root link by default; application root validation and Windows reparse classification remain required.

Research experiments used SQLite 3.46.1, not a deployment-approved build. A temporary 200,000-path experiment measured count-only queries with a 2 MiB cache target and database mapping disabled. Selective trigram counts were faster than scans, but a common term was slower through FTS. The database with FTS occupied about 69 MiB versus about 16 MiB of JSONL directory bodies. These figures exclude production ranking, HTTP, concurrency, complete resource accounting, and native-drive behavior; they are not latency or RSS guarantees.

A separate six-case correctness experiment verified any-term inclusion, distinct matched-term counts, mixed short/long terms, Unicode, and literal punctuation. Strict AND returned two matches where OR returned five. This does not prove bounded-memory production queries or cross-language ranking parity. Check required SQLite features and the serialized write/checkpoint configuration in both runtime test suites on available platforms. Record unavailable platform checks without claiming they passed. Follow the [dependency workflow](../website/content/docs/2.0/developer-guide/release-and-versioning/dependency-update-workflow/index.md) before adding a Rust SQLite dependency or changing pinned packages or lockfiles.

## Required Behavior

- Warm searches query SQLite, without a drive walk or full database load into RAM.
- Cold requests start or join one background source initialization and return promptly with available results and status. Empty queries initialize but return no index matches.
- Queries and browser origins share indexing work. Request cancellation stops query work and updates, not a useful shared build.
- Every eligible indexed path remains searchable when database pages leave RAM. Small cache settings must not cause missing results.
- Candidate verification uses disk storage while accepted data remains searchable. A failed pass cannot replace usable data with an empty or incomplete generation.
- Independent terms use any-term literal inclusion and matched-term-count-first ranking, with unique result counts.
- Recent results publish independently, remain selectable, and retain history icons on duplicate paths.
- Source replacement, partial coverage, stale data, query failure, and disk exhaustion are distinguishable. No failure may claim complete coverage or cause an endless spinner.
- Dot-directory visibility is a query filter, not a reason to rescan.
- Committed rows, FTS entries, revisions, and coverage metadata agree. Failed transactions preserve the last accepted state and retry eligibility.
- Administration controls describe the host they affect and distinguish disk budget, inactive retention, and memory-cache targets.

## Shared SQLite Storage Contract

### Schema and Ownership

Keep the normative schema, search specification, constants, and language-neutral fixtures under `shared/`. Python and Rust implement the same contract through established SQLite libraries, not a shared runtime library or a custom storage engine. Allocate an application identifier and an independent SQLite schema version; do not call it JSONL v3. Use `application_id`, `user_version`, and validated metadata to distinguish this database from unrelated SQLite files.

Use one managed database per source identity. This permits source eviction, isolation, and size accounting without mixing credentials or local drives. Keep its journal and temporary working files inside managed local storage. The database resides on local backend/companion storage even when the indexed source is a network mount.

| Logical data | Required content |
| --- | --- |
| Source metadata | Source kind and validated identity, schema/search-normalization/traversal-policy versions, selected generation, accepted revision, committed time, last complete verification time, and last access time. |
| Generations | Build state, coverage state, indexed count, unresolved issue codes/counts, and scan baseline. Initial builds can be searchable with explicitly partial coverage; verification candidates are not query-visible before acceptance. |
| Directories | Stable row ID, generation ID, original relative path, normalized path and basename keys, depth, and dot-directory metadata. Original path uniqueness is enforced per generation. |
| Trigram index | External-content FTS5 over normalized path keys, referring to directory row IDs. It is derived data inside the same database, not a second durable file format. |

Use SQL constraints, parameter binding, checked conversions, and explicit validation. SQLite integers are signed 64-bit; define non-negative signed 64-bit revisions, counts, and epoch-millisecond timestamps with overflow handling. `last_verified_at_ms` can be null. Wire counts require checked conversion to the existing HTTP numeric representation; do not clamp them at 100,000.

For SMB, preserve connection ID, host, share, port, path prefix, username, and connection revision as identity inputs, excluding passwords. For local sources, validate platform, canonical root, and tested mount/volume identity. Filenames, drive letters, and display labels do not authorize database reuse. Keep source-kind rules distinct; runtime SMB access must never accept a local-source database merely because its schema is valid.

Preserve original path case and Unicode spelling. Search keys can collide without merging distinct paths. Reject absolute paths, root records, empty or dot components, NUL, and names that cannot round-trip through the supported API. Define separator and literal-backslash handling per source platform. Unsupported native encodings produce explicit coverage issues rather than lossy names. Persist neither file contents nor history scores.

Complete coverage means a successful full pass under the traversal policy with no unresolved coverage issues. Committing mutations does not advance verification time. A valid database can be partial or stale. Watcher health, verification activity, query errors, and write errors remain separate from coverage. Use monotonic clocks for scheduling and a named wall-clock skew policy for persisted timestamps; recent writes or future times must not imply freshness.

### Transactions, Concurrency, and Recovery

Use one serialized writer/coordinator per active database and a bounded read-connection pool. Run blocking SQL and filesystem work outside async request executors. Release manager locks before query execution. Commit bounded row batches with their FTS changes, counts, issue metadata, and revision in one transaction. Use one tested trigger-based FTS synchronization path for inserts, updates, and deletes; test generation cleanup and rebuilds through it. Never clear queued work before commit succeeds.

Use WAL on managed local storage for concurrent readers and one writer, with `synchronous=FULL`, bounded busy handling, and checkpoint scheduling. All active writes, checkpoints, maintenance, and writer closure use the same writer lock and connection. Query connections are strictly read-only and must not checkpoint. A process ownership lease excludes other managed writers and cleanup until active handles have closed. The documented WAL-reset bug requires writes and checkpoints on different connections at the same time; prevent that configuration rather than require a newer Debian SQLite release. Do not disable journaling or synchronization to meet performance targets. Do not assume SQLite library settings alone guarantee native-filesystem durability on all platforms.

Each query reads one selected generation and revision in a consistent read transaction. Count and returned rows must refer to the same view. Cancel obsolete statements through the library's interruption/progress support, close cursors, and release read transactions promptly. Long readers can delay checkpoints and grow WAL; admission, cancellation, and resource accounting must cover this. A cancelled or timed-out query is not a successful complete response with an invented count.

Startup opens and validates the database in one shared background job after source binding is established. Check application/schema identifiers, metadata, policy and normalization compatibility, and appropriate SQLite integrity checks. Schedule expensive checks off the request path. A database integrity check does not authorize paths or prove FTS consistency. Gate query availability on the required validation and test a bounded startup strategy on large databases. Rebuild missing or inconsistent FTS data in background; complete path-table scans can remain available when directory rows are valid.

Database corruption, unsupported schema, invalid metadata, or source mismatch cannot produce results. Rebuild disposable data from the filesystem without touching history. Preserve the old database until the replacement is safely initialized where useful; bounded quarantine must count against the disk budget. If storage is unwritable or full, keep accepted readable data and report a recoverable error, not repeated discard/rebuild attempts. Actual database corruption is different: corrupted rows cannot be advertised as usable.

Rebuild disposable cache databases with unsupported schema versions. Do not implement historical schema migrations for the first release. Add a transactional migration only when measured rebuild cost justifies it. Normalization or traversal-policy changes require versioned key rebuilding or source verification before incompatible data is served. Close/checkpoint database users before managed deletion or replacement. Acquire a process ownership lease to prevent concurrent managers and cleanup races. SQLite locks alone do not coordinate application generations across two processes.

There are no periodic full-index saves, application snapshot backup pairs, or export/import checksums. SQLite transactions provide recovery of committed state; pending filesystem observations can still require verification after a crash. Routine backups are not required for this recoverable cache. If an operational backup is later required, use SQLite's backup API, never a bare copy of an active main file.

### Locations, Cleanup, and Disk Maintenance

Use a new `sqlite/` namespace below the configured backend directory-cache root, with safe opaque source filenames ending in `.sqlite3`. Preserve `directory_cache_location` and its relative/absolute resolution; the default root is `data/directory_cache/sqlite/`. Companion databases live under `directory-index/sqlite/` in its OS-user cache directory, resolved through Tauri. Do not use browser storage, the pairing store, or backend storage for companion indexes.

Use a private application cache directory for all databases and working files. On Unix, create it with mode `0700` and verify its ownership and access permissions before use. On Windows, use the OS-user cache directory's inherited access controls; no separate per-file ACL management is required. A home/profile location alone does not prove that a directory is private. Validate existing or custom storage directories at initialization, including backend storage owned by the service account, and reject unsafe locations with an actionable error. Avoid links during creation and cleanup, and validate filename inputs. Do not expose local paths or account identities through status responses or logs.

Disk budget includes main databases, WAL/SHM, rollback journals where applicable, temporary query work, verification generations, rebuild candidates, maintenance files, quarantine, and bounded legacy retention. Reserve measured operation headroom before scans, transactions, checkpoint/merge work, and replacement. `journal_size_limit` and `max_page_count` are not complete disk quotas; use manager-wide accounting, admission checks, and SQLite/OS error handling. Do not promise a hard allocation ceiling that SQLite can exceed during a bounded admitted operation.

Evict eligible inactive sources first, after closing their connections and workers. Never evict an active source or delete its last accepted generation to admit a verification candidate that can fail. On insufficient headroom, pause growth or verification with a specific storage issue. Initial partial data stays partial; an already accepted generation remains usable but becomes stale when updates cannot commit. Retry after eligible cleanup, a policy change, or bounded backoff, not on every query.

Deletion usually frees pages for reuse without reducing main-file size. Keep logical cleanup, WAL checkpointing, and physical space reclamation separate. Set and test `auto_vacuum=INCREMENTAL` before creating database tables so bounded `incremental_vacuum` steps can reclaim space under disk pressure. Add explicit FTS segment merging only if measurements show a need; merging does not itself guarantee that the database file shrinks. Reserve full `VACUUM` for exceptional off-request maintenance with sufficient temporary disk capacity and coordinated database access; do not run it routinely. Any full rebuild or maintenance operation needs capacity for its temporary work. Do not run unbounded FTS optimize after every mutation.

Use the existing writer/coordinator for bounded reclamation when disk admission cannot obtain sufficient headroom and reusable pages are available. Coalesce requests into one pending job per source. Keep normal WAL checkpoint handling independent of disk pressure; attempt WAL truncation only when readers and writers permit it without prolonged blocking. Foreground queries and source updates take priority. Defer reclamation on busy databases or insufficient operation headroom, preserve accepted rows and retry eligibility, and update measured main/WAL usage after work. Do not add periodic idle maintenance, a separate tuning scheduler, or per-operation reclaimed-byte telemetry for the first release. Add these only if measurements show a need. Maintenance must not advance verification time or change search results.

## Independent-Term Search Contract

### Inclusion and Normalization

This is required implementation work from the selected TODO, not only preparation for a later feature. Define one language-neutral contract used by backend directory/history services, companion search, and frontend loaded-file filtering, ranking, and highlighting.

Normalize through the existing intended NFKD, combining-mark removal, and full Unicode case-fold behavior. Fix frontend drift and prove Python/Rust/TypeScript parity, including characters outside the frontend's current combining-mark block. Normalize path separators according to source semantics, not by changing literal Unix filename characters. Split on defined Unicode whitespace, discard empty terms, and deduplicate after normalization. Define behavior when normalization removes all characters from a term. Empty effective queries preserve the existing recent-history/group behavior and do not match every indexed directory.

Include a result when at least one distinct term is a literal substring of its searchable field. Terms can appear in either order and in different directory path segments. A result matching both `term1` and `term2` ranks above a result matching only one. Repeating `TERM1 term1` does not increase its score. Preserve filename-only matching for file search; broader file-path matching is not part of this TODO implementation.

Do not add quotation syntax, exclusions, wildcard syntax, fuzzy matching, or a user-visible FTS language. Quotes, percent signs, underscores, stars, and other non-whitespace characters remain literal. Bind SQL parameters and quote/escape each internal MATCH term safely. Explicitly bound input bytes and distinct-term count through named validation limits; reject unsupported input with an actionable error rather than silently ignoring extra terms.

### Candidate Retrieval and Exact Counts

Use external-content FTS5 with trigram tokenization over already normalized keys. Start with case-sensitive tokenization and full detail so quoted longer terms work; do not select reduced-detail modes that cannot execute the required expressions. Test the exact tokenizer/build settings in both languages.

For all-long-term queries, combine literal terms with OR to retrieve any-term candidates. Validate candidates against the literal substring contract. For a term shorter than three normalized Unicode characters, MATCH alone is incorrect. Use one complete path-table scan evaluating all terms when short terms occur, unless a measured complete union plan is faster. Do not repeat a full scan separately for each short term. Common all-long-term queries may also use a complete scan when measurement supports it. Query-plan choice cannot change inclusion, rank, or counts.

Process candidates with SQLite disk-backed work or streaming cursors, not giant application sets. Count each matching original path once, even when it matches multiple terms or multiple FTS branches. Do not sum per-term counts. Filter dot directories and source access before counting and ranking. Do not cap each term's candidate list and merge those prefixes.

Evaluate all candidates needed for the exact count and best results. Keep a bounded top-K result structure, or a measured equivalent SQL plan with accounted temporary storage. The existing returned-result cap limits output only. Arbitrary query scan limits must not produce apparently successful complete counts. Broad OR queries can match most paths; exact counts and ranking still require work. Cancellation releases work and leaves source/history results that already succeeded; an incomplete query is reported as such, not as partial index coverage.

### Ranking, Merging, and Highlights

Compare distinct matched-term count descending first. Do not use FTS BM25 or the old scalar `match_rank` alone.

**Approved ranking contract:** Use term count followed by the best existing single-term rank among matched terms, then the history/depth and deterministic tie-breaks below. Define that rank consistently across sources and languages; repeating or reordering terms must not change it. This contract preserves the intended single-term quality ordering without per-term quality vectors. Do not implement the detailed quality-vector alternative or a comparator selection setting. References to quality below mean the best single-term relevance rank.

After term count and quality, use existing history usage ordering for history results, directory depth for index tie-breaking, and deterministic normalized/original path keys. Define a consistent source tie-break for mixed results so comparator behavior is transitive; do not conditionally compare different fields for different pairs. Empty-query usage order and group labels stay unchanged.

Apply the relevant comparator inside each source before its result limit. Merge with the same term-count/quality ordering in the frontend. Deduplicate by existing connection-and-path identity; recent history keeps its representation, icon, selection value, and action. If two source versions of the same path supply different relevance metadata, use the valid best relevance for the merged row without losing its history representation. Do not let history usage place a one-term result above a two-term result.

Update highlight handling to highlight separate literal terms, including overlapping matches, rather than the complete input string. Map normalized offsets back to displayed original text so case-fold expansion and decomposed accents do not produce incorrect spans. Preserve primary/secondary text, stable dimensions, keyboard selection, and accessibility. Add highlight parity fixtures; do not render normalized search keys as filenames.

Backend recent-directory and recent-file services remain in their current application database. Implement the new filtering/counting/ranking there before truncation, with bounded processing and existing per-user access checks. Frontend loaded-file filtering remains local and uses the same contract. There is no new global file search service or full-drive file scan.

## Source Managers, Scanning, and Freshness

### Ownership and Initialization

Add the companion directory manager to [AppState](../companion/src-tauri/src/server/mod.rs#L49), with a dedicated owning module and nearby tests. Keep handlers thin and platform identity beside [drive enumeration](../companion/src-tauri/src/server/drives.rs). Replace backend set-based search and JSONL persistence behind its existing cache-manager boundary, while retaining SMB traversal and authentication behavior where compatible with the new lifecycle.

Each active source owns its validated root, database handles, selected generation/revision, scan generation, mutation sequence, coverage, cancellation flags, watcher, bounded dirty queue, and access/verification clocks. Authenticated companion origins share the OS user's source index, retaining authentication and CORS. Workers send bounded batches through one mutation/lifecycle coordinator; queries do not hold that coordinator lock while filtering or sorting.

Activation and typed requests join one source initialization job. Identity checks, database open/validation, watcher setup, and scanning run in bounded background work. A first request can return initializing status without old paths. Never synchronously load all rows or enumerate the root tree in a request. An empty query can prefetch only after this behavior is implemented.

### Source Identity and Availability

Drive IDs are routing labels. Use a refreshed drive catalogue and shared background identity resolution rather than [whole-drive enumeration](../companion/src-tauri/src/server/drives.rs#L71) or Windows label probes on each keystroke. Validate canonical roots and platform-tested mount/volume identity before serving retained data.

Use native tests for available source types and injected fixtures for Windows fixed/removable volumes, mapped UNC sources, and Unix ordinary/bind/network mounts. These fixtures do not certify unavailable native environments. A drive letter, Unix device number, Windows volume serial, or display label alone is insufficient. Where restart identity cannot be proven, use a session-bound disk database rebuilt for that session, not a full-RAM fallback or unsafe retained-data reuse. Bound its cleanup and report identity limitations.

Revalidate after idle/sleep and before retained-data reuse. Detect removal/replacement through available notifications plus active-root checks. Removal stops workers and makes the binding unavailable; replacement increments the runtime generation before any new matches are served. Neither event deletes recent history. A late worker or SQL completion from an old binding must not publish into its replacement.

### Traversal and Build Policy

Index real directories, including dot directories, but not the root as a selectable match. Preserve original relative paths and compute search keys once when rows change. Prefer WalkDir with a small platform-policy wrapper over expanding the custom walker.

Do not descend through symlinks, Windows junctions, name-surrogate redirections, or `.lnk` files. The [current Windows classifier](../companion/src-tauri/src/server/handlers.rs#L5929) treats every reparse point as a link and cannot be copied unchanged. Test redirection classification with native tests where available and injected tag fixtures. Unknown, unreadable, or unverified cloud-placeholder tags produce coverage issues and are not traversed. Cloud-provider certification is outside this implementation scope; do not claim complete coverage of excluded roots. A selectable alias must still pass existing navigation target validation without recursively indexing its target.

Do not cross separately mounted filesystems or scan Unix pseudo-filesystem trees. Root validation and discovered-entry checks must prevent outside-root indexing under link replacement races. Add handle-based OS validation where iterator/path checks cannot enforce containment. Unsupported native path encodings and inaccessible descendants produce issue counts; root failure invalidates the source.

Check cancellation, source generation, path/depth limits, and batch capacity before iterator advance, after OS calls, and before batch send. Counts are diagnostics, not stop conditions. Queue pressure uses backpressure; memory-cache eviction cannot stop directory coverage. A tree with few directories but millions of files still needs work accounting and cancellation.

Initial scans commit bounded batches into a searchable partial generation. Verification scans build a separate generation in SQLite while the accepted generation remains selected. Failed verification discards or retires only the candidate and retains accepted data with accurate freshness/issues. Final publication switches the selected generation and metadata in one transaction after reconciliation. Queries holding the old read view must finish or cancel before cleanup can reclaim its resources. Account for both generations on disk; do not copy the catalogue into an immutable RAM snapshot.

### Events and Race Handling

Keep index observation separate from non-recursive subscriber-counted pane watchers. Install it before scanning where practical, through bounded background work. Treat native events as dirty-parent hints: reconcile immediate directory children, scan new/moved-in subtrees, remove deleted subtrees, and reconcile both rename parents. Do not depend on paired rename events on every platform.

Use one common post-mutation notification API for create/delete/empty-directory removal, rename, copy/move, transfers, parent-creating uploads, and archive extraction. Partly failed operations reconcile affected parents rather than asserting complete success. Useful directory listings can reconcile their parent without claiming full-source coverage.

Source generations alone do not solve mutations within one scan. Each batch carries the mutation sequence captured before its directory read. The coordinator records changed-prefix barriers, rejects/quarantines older entries under those prefixes, and reconciles with a newer sequence. An event arriving during reconciliation retains its dirty marker. Full scans and subtree scans cannot publish independently or resurrect deleted/renamed paths through late batches.

Keep changed-prefix barriers in a coalesced map with named limits for both entry count and stored path bytes. Coalesce repeated and overlapping prefixes without weakening rejection of older reads. Track outstanding producers and their queued batches. Retire a barrier only after every producer that can submit an older read has finished and its queued batches have been applied or rejected. Do not expire barriers by elapsed time. These bounds limit in-flight race bookkeeping, not directory coverage.

Give each scan or reconciliation producer and its batches a scan epoch, separate from source identity and accepted database revision. The coordinator checks this epoch before applying rows and before selecting a verification candidate. At barrier or dirty-queue capacity, invalidate affected producers before clearing their barriers or dropping dirty hints. Preserve accepted rows, mark coverage uncertain, and retain one sticky verification request. Reject all late batches and candidate publication from invalidated epochs. Restart through existing worker admission and backoff; a blocked producer keeps its permit until it exits. Sustained changes can delay complete verification, but must not cause unbounded barriers, retry storms, or deleted-path restoration. Do not add a persisted barrier journal or another scheduler.

Before final candidate selection, reconcile through a captured coordinator sequence and validate the source generation again. Subsequent events remain queued. Observation applies to both the accepted generation and candidate through the coordinator while verification runs. Overflow marks coverage uncertain, sets a sticky verification-needed flag, and schedules one pass; observation continues. No incomplete candidate becomes selected merely because its scan ended.

Watcher failure, event loss, root changes, and sleep/idle resume trigger verification. Healthy sources also need periodic full passes under traversal policy, not samples or directory-count prefixes. Use scheduled verification for unreliable sources; avoid duplicate native polling and full scans. Retry after 30 seconds, doubling to five minutes with jitter, reset after success, and clear only resolved issues. Resource refusal must not cause a retry storm under unchanged conditions.

Use access-driven scheduling for inactive sources. Idle release closes watchers and signals workers without automatically deleting retained databases. Explicit companion exit stops the manager and finishes or rolls back transactions where possible; tray hiding does not. Preserve [the existing exit policy](../companion/src-tauri/src/lib.rs#L1163). Retain worker permits until actual exit; cooperative cancellation cannot interrupt a stalled OS call. Test this limitation with injected blocked calls. A helper process and guaranteed shutdown isolation for blocked native calls are outside this implementation scope.

## Resource Policy and Administration Settings

### Controls and Accounting

Replace the former full-index RAM limits and snapshot retention budget. Disk-backed catalogue coverage does not depend on a RAM copy. Use named centrally owned policy constants, validated administration settings, and fixture-measured defaults. Initial values below are approved starting values, subject to fixture measurements, not production guarantees.

| Control | Initial value and meaning |
| --- | --- |
| Directory-index disk budget | 2 GiB per host instance, independently for backend and companion; includes all managed working/retained/temporary bytes and operation headroom. Validate against generated million-path fixtures during implementation. |
| Inactive-source retention age | Seven days since last index access, not verification time or file modification time. Eligible inactive data can be evicted earlier for disk pressure. |
| Retained inactive sources | At most four; this limits idle database retention, not active source count or directory coverage. |
| SQLite page-cache target | 2 MiB per connection initially, with bounded connection counts and aggregate targets; set `mmap_size=0` initially to make database mapping an explicit later decision. Not a hard RSS cap. |
| Query workers | At most two per manager; cancel obsolete statements and bound top-K buffers and term input. |
| Full-source scans | One per manager and one pending job per source; backpressure on batches. |
| Commit/status publication | Bounded transactions with status publication no more often than every 250 ms initially; mutations coalesced through the coordinator. No periodic full-index rewrite. |
| Verification intervals | Healthy active sources: 15 minutes; degraded active sources: five minutes, with jitter and failure backoff. |
| Event coalescing and idle watcher release | Start at 300 ms and ten minutes respectively. |

Measure batch bytes, connection/page-cache totals, top-K buffers, dirty queues, file descriptors, temporary SQL work, and RSS. SQLite/OS caches and statement allocations extend beyond `cache_size`; do not label it a process memory maximum. Select path/depth/queue/input safeguards from fixtures. Backpressure and smaller caches must preserve full searchable coverage; actual allocation failure produces an explicit operation error, not silent prefix searching.

Disk budget limits current storage use and admitted growth. Retention age/count determine which inactive sources can remain for fast reuse. They are different controls. Lowering the disk budget must first clean eligible idle data, then pause new growth if necessary; it must not remove an active catalogue or trim arbitrary rows. Report current bytes, pending cleanup, unavailable headroom, and over-budget state. No setting can guarantee unlimited filesystem coverage on finite storage.

### Administration Delivery and Ownership

Before changing forms, settings surfaces, or dialogs, read the [settings-form-dialog pattern](../website/content/docs/2.0/developer-guide/frontend-architecture/settings-form-dialog-pattern/index.md). Reuse the established administration form, validation, save/error states, and settings API; do not create a competing settings framework.

Expose disk budget, inactive retention age/count, page-cache target, and healthy/degraded verification intervals in Settings > Administration. Keep low-level parser/SQL/worker safeguards centrally defined unless measurements establish a user need. Show backend storage and companion-local storage as separate scopes, with actual usage and effective policy version. Do not imply backend `[directory_cache]` configuration alone controls the companion.

Persist backend policy through existing system-settings/config conventions with documented precedence. Deliver a versioned companion policy over its authenticated local API after authorized administration save, and persist the effective policy in companion-owned configuration. The backend cannot silently enforce a local setting without an available paired companion. Failed/unavailable delivery must be visible as pending or failed, not shown as applied.

Companion indexes are shared by the OS user across pairing origins. Do not allow ordinary browser sessions or competing origins to overwrite global local policy. Use backend-validated, single-use policy grants with one locally consented owner. Implement the following trust contract before the administration surface:

- Reuse the existing backend JWT issuance and companion single-use token-exchange pattern, with a separate policy token purpose and bounded replay records. Issue a grant only after an administrator-authorized save. Bind it to the validated approved policy, backend identity, paired origin, companion-generated challenge, expiry, and monotonic policy revision. Use named limits for grant lifetime and pending challenges.
- Redeem the grant directly from the companion with the locally approved backend endpoint, not a URL supplied with the grant. Verify HTTPS certificates, disable redirects, and use a bounded timeout. Permit plain HTTP only for loopback development. Other insecure deployments report policy delivery as unsupported; do not weaken transport validation or change their existing index access.
- The backend verifies token purpose, all bindings, expiry, and current administrator authority, and atomically consumes the grant. It returns the approved policy and revision. The companion checks the response against its pending challenge and owner binding, validates policy ranges, and persists only those approved values. Never apply separate browser-supplied policy fields. Reject older revisions and treat an already effective revision as a no-op only when its policy agrees. Concurrent deliveries cannot replace a newer effective policy.
- Persist one locally consented backend identity and origin as policy owner. Ordinary pairing is not owner consent. Other origins cannot replace the owner. Owner reset requires a local action, invalidates pending challenges, and preserves the effective policy. Require new local consent before another owner can deliver policy.
- Failed or offline redemption leaves the effective policy unchanged and delivery pending or failed. An expired or consumed grant needs a new authorized grant; do not reuse it. Policy changes require an online backend, but offline indexing continues with the last accepted policy. Do not add public-key distribution or a general remote-management service.

Offline companion operation uses the last accepted local policy, or validated built-in defaults if none exists. Older companions report unsupported policy control; do not invent successful delivery. Validate ranges, units, policy versions, and unsafe zero/unlimited values. Apply changes at safe operation boundaries, preserve active data when shrinking budgets, and let restored capacity resume paused work. Add settings audit behavior only through an existing supported mechanism; a new general audit system is outside this plan.

## API and Frontend Contract

### Responses and Compatibility

Keep directory API routes and the existing `results`, `total_matches`, `cache_state`, and `directory_count` fields. Extend [companion models](../companion/src-tauri/src/server/models.rs#L631), backend response models, and [frontend types](../frontend/src/types/index.ts#L557) with optional accepted revision, quality/issues, verification time, and a search-contract capability/version. Add distinct matched-term counts and quality metadata for each result, including recent-history responses. Retain legacy `match_ranks` for clients that use them, but do not encode all multi-term relevance in that single scalar.

`total_matches` is the exact unique matching-path count in the query-visible generation, after filters, not the sum of term counts or all discovered/undiscovered paths. `directory_count` is that generation's indexed count. Counts above 100,000 must round-trip without clamping. Result truncation, incomplete index coverage, incomplete query execution, and stale data are separate states.

Keep activity compatible with `empty`, `building`, `ready`, and `updating`. Coverage and freshness metadata qualify these values. A disk-paused initial scan can expose partial accepted rows; a failed verification or blocked write can leave usable stale accepted rows. Query failure does not by itself mean index coverage is partial. Define named issue enums and specific retry actions rather than unchecked UI strings.

New clients accept legacy payloads without optional metadata. New backend/companion query semantics change intentionally for independent terms, while API shapes remain compatible. Capability detection must identify each source: old clients cannot implement new ranking merely by reading new directory strings, and new clients cannot recover omitted two-term candidates by reordering a legacy single-string response. Show a source-specific upgrade requirement or use its explicitly documented legacy behavior; do not issue capped per-term legacy requests and claim complete new semantics. File-loaded candidates can use the new contract independently, but mixed history/index capabilities need tests and rollout notes.

### Progressive Results and Failure Isolation

Extend [SearchProvider](../frontend/src/components/FileBrowser/search/types.ts#L92) with an optional complete-array update callback and only the refresh-policy hook needed by the shared bar. Existing providers can keep one final array. Foreground requests and quiet refresh use the same `fetchResults` execution and merge path; do not add a separate `refreshResults` method. Approved signatures, separate from the wire model:

```typescript
type SearchResultsUpdate = (results: SearchResult[]) => void;

fetchResults: (
	query: string,
	signal: AbortSignal,
	onUpdate?: SearchResultsUpdate
) => Promise<SearchResult[]>;

getRefreshIntervalMs?: () => number | null;
```

Publish recent history when ready and merged results when index responses arrive, using one deduplication/ranking path for callbacks and final results. Callbacks replace the complete merged array, not append batches. Populate record-selection maps before publishing. Preserve selection by value and never move focus or open the bar due to background responses.

The frontend query generation is separate from source scan generations and accepted database revisions. Apply callbacks only when signal and query generation remain current. Keep existing missing-target validation and Shift+Delete history removal. A duplicate keeps its history representation and valid best relevance as specified above.

Handle source failures independently. Preserve successful history/index/loaded-file results with specific pairing, unavailable-source, query timeout, storage, or capability errors and appropriate retry actions. Use a generic full-search failure only when no source succeeded. Do not remove recent history for these errors.

### Quiet Refresh and Activation

Refresh only while directory navigation is visible/active and a supported source is initializing, building, or updating. Schedule one timeout 500 ms after the last accepted response, not an overlapping interval. A pending 200 ms input debounce or foreground request takes priority. Input cancels old refresh work; use separate request controllers with the same query-generation guard.

Within the directory provider, reuse accepted history for the same query, user, and target source while fetching current index/status data through the shared execution path. History-change events invalidate it and request a foreground refresh. Empty-query refresh can update status without repeated history fetches. Do not add a general history-cache framework. Stop on completion, terminal resource failure, dismissal, mode/pane changes, unmount, or hidden tab; back off repeated errors and resume once on visibility. Do not repeatedly call a legacy companion full-scan endpoint.

Retain and clean up the activation controller on deactivation, source change, and unmount. An abort does not stop a shared build. Keep the 200 ms input debounce. Foreground work uses the input spinner; background build activity stays in the index-status area without spinner flashes. Revision and query identity together control row-update reuse; a revision alone cannot identify results for another query.

## Directory Result Icons

Add `recent-directory` to [SearchResultIcon](../frontend/src/components/FileBrowser/search/types.ts#L27), only for recent-directory rows. Map it to existing MUI `HistoryOutlined` in [QuickBarResultRow](../frontend/src/components/FileBrowser/QuickBarResultRow.tsx#L18). Keep `directory` for index folders and retain current file/recent-file icons.

Treat both directory icon values as directory text styles. Preserve row height, icon column width, colors, virtualization, empty-query groups, selection values, and history actions. Independent-term ranking and highlighting change as specified in this plan, not as a side effect of icon selection. A history/index duplicate appears once with the history icon. Do not add typed-result badges or duplicate group headers. Accessible text and actions must remain sufficient without relying only on icon/color.

## Observability

Add structured lifecycle and privacy-safe query logs for source initialization, database open/recovery, scan completion/cancellation, accepted generations, watcher degradation, resource pauses, retention eviction, and transaction errors. Record schema/search version, source kind, revision, duration, counts, bytes, query-plan class, busy waits, checkpoint/merge activity, and retry state. Aggregate descendant errors rather than logging paths.

Record actual main/WAL/temp/candidate disk use, cache targets, and maintenance headroom for resource control. Measure RSS in the scoped performance experiments, not through a new continuous production collector. Distinguish stale verification, identity mismatch, corruption, FTS inconsistency, disk full, denied storage, query cancellation, and incomplete policy delivery. Do not log database source identities, raw paths, query terms, credentials, pairing material, or signed URLs.

Add companion frontend API timing with method, route template, status, duration, cancellation, and optional revision. Use DevTools Network to separate request time from waiting for combined results. Measure pasted and incrementally typed queries, database startup, scan time, watch installation, updates, and quiet refresh. Container experiments cannot establish production companion drive performance.

## Implementation Sequence

| Phase | Deliverable | Gate |
| --- | --- | --- |
| 1. Contracts and fixtures | Shared SQLite schema/source identities, selected search comparator, normalization/highlight fixtures, capabilities, coverage/issues, policy scope, and injected scan/clock/SQL interfaces where needed by focused tests. | Ranking decision is closed; OR inclusion and exact unique counts are specified; tests reproduce per-query scans, whole-string matching, and directory icon ambiguity. |
| 2. Backend SQLite index | Disk-backed rows/FTS, bounded queries, background open/validation, transactional batches, verification generations, disk maintenance, and legacy retirement. | Warm queries do not normalize/load the full catalogue; interrupted transactions recover; count/ranking/source access gates pass above 100,000 paths. |
| 3. Companion SQLite manager | AppState manager, source binding, bounded traversal, removal of count cutoffs, progressive transaction commits, candidate generations, and cancellation. | Cold/empty requests return without awaiting traversal; concurrent calls join one job; cache eviction never removes searchable paths. |
| 4. Independent-term search | Backend directory and recent-history matching/ranking, companion candidates/fallback/counts, frontend loaded-file filtering, shared merge comparator, relevance metadata, capability handling, and highlights. | Both-term results precede one-term results across sources; mixed short terms, duplicates, Unicode, limits, and highlights agree. |
| 5. Responsive quick bar and icons | Complete-array partial updates, source failure isolation, quiet refresh, activation cleanup, recent-directory icon, and stable selection. | History is selectable before index completion; stale updates/focus changes are rejected; icon and mixed-version tests pass. |
| 6. Freshness and native lifecycle | Dedicated index watchers, mutation hooks, sequence barriers, overflow recovery, full verification scheduling, replacement detection, and explicit exit. | Late scan rows cannot resurrect deleted paths; accepted/candidate transactions and source reuse pass focused tests, including native tests where available. |
| 7. Administration resource controls | Backend/companion disk and retention/cache/verification settings, safe live updates, local policy delivery/ownership, effective usage/status, and offline/legacy behavior. | Unauthorized origins cannot change shared local policy; failed delivery is visible; budget shrink preserves active data. |
| 8. Verification and documentation | Small generated-database compatibility test, available native safety tests, scoped generated performance/capacity experiments, SQLite runtime qualification, docs, retirement, and compatibility notes. | Available acceptance checks pass without full-RAM catalogues, directory cutoffs, or a second snapshot format; capacity evidence and unavailable checks are recorded. No release publication or deployment is required. |

The icon change can ship independently. Do not ship the new local index without freshness/recovery or claim independent-term support while a required source still applies whole-string filtering. Backend, frontend, and companion need coordinated capability rollout, though their physical databases are never exchanged at runtime. Do not change product versions or create Git commits as part of planning.

## Test and Acceptance Plan

Use shared parameterized fixtures for contract cases and focused tests for each owning service. Test an invariant at its owning boundary, with integration coverage only where another layer can change the behavior. Do not repeat storage recovery tests in the frontend; test its response and error presentation there. Run focused checks during each phase and affected repository gates at implementation completion. Performance experiments have the separate schedule below; they are not requirements for every edit or unrelated release.

### Shared Storage and Backend Tests

Extend [existing persistence tests](../backend/tests/test_directory_cache_persistence.py) and nearby cache/query/history tests. Replace obsolete JSONL writer tests with SQLite lifecycle assertions as implementation removes that code; retain tests of source binding, freshness, empty indexes, and recovery. Keep common schema/search fixtures under `shared/` and reuse injected failures and temporary directories.

- Run the same schema and search fixtures in Python and Rust. Keep one small generated-database compatibility test in which one runtime creates a database and the other opens and queries it through test-only access. It must not bypass runtime source validation. Do not require bidirectional mutation, migration, or recovery matrices: databases are not exchanged at runtime. Each runtime tests its own transactions, FTS synchronization, and recovery. Test unsupported schema rejection and background rebuild; add migration tests only when a migration is implemented.
- Test application/schema identifiers, metadata constraints, source mismatch, normalization/policy mismatch, invalid paths, distinct original paths with colliding normalized keys, and native encodings that cannot round-trip. Runtime tests must preserve source authorization.
- Test complete/partial/empty generations, null/old/future verification times, clock changes, successful mutations after failed verification, and last-directory deletion. Committed time cannot substitute for verification time.
- Interrupt transactions during row/FTS/metadata changes and generation selection. Restart must observe a consistent committed state, never mismatched counts or FTS rows. Test rollback, busy handling, SQLite FULL/IOERR, denied access, missing/corrupt index, and bounded retries.
- Test a failed candidate while accepted rows remain readable; source invalidation during queued SQL; pending mutations after rollback; orphan candidate cleanup after restart; and readers spanning generation selection/checkpoint work.
- Test local configured cache roots, links/permissions, process leases, safe cleanup of sidecars, inactive eviction, disk headroom, WAL growth, temp work, and implemented reclamation interruption. Do not count only the main database file.
- Test disk-pressure reclamation, coalescing, bounded work, and foreground priority. Verify physical space reclamation after incremental vacuum and WAL truncation, unchanged counts/ranking/revision/verification time, busy-reader deferral, insufficient operation headroom, and safe retry after interruption. Do not add periodic-idle or FTS-tuning scheduler tests unless those features are justified and implemented.
- Test legacy v1/v2 files ignored with one background rebuild, no full-RAM restore fallback, separate SQLite namespace, safe retirement, and rollback isolation. Preserve backend API shapes, result caps, history access, and unrelated single-term behavior.
- Verify small page-cache targets and connection reuse do not remove indexed results. Measure bounded row/key batches and top-K memory rather than accepting a set-based catalogue hidden behind SQLite persistence.

### Independent-Term Search Tests

- Test terms in different path segments and reverse order; both-term versus one-term ranking; no-term exclusion; repeated normalized terms; empty/whitespace/combining-only input; and input-limit validation without silent term dropping.
- Test mixed short/long terms, all-short terms, normalized term lengths, common OR terms, literal punctuation/quotes/wildcards, safe FTS expression binding, and complete-scan parity. A long overall query containing a two-character term still needs short-term handling.
- Test exact unique counts for overlapping term matches and FTS unions; dot filtering before counts; rank before result limits; and no per-term candidate cutoff. A late high-quality two-term match must beat earlier one-term candidates.
- Test Python/Rust/TypeScript normalization and comparator parity for accented/decomposed names, sharp S, non-Latin scripts, Unicode word boundaries, separators, literal backslashes, and original paths with equal normalized keys.
- Test source-local ranking before truncation, mixed-source transitive ordering, history usage subordinate to term count, deduplication retaining history representation, and metadata differences between duplicate versions of a path.
- Test independent highlights and original-text spans for case-fold expansion, combining marks, overlapping terms, and punctuation. Preserve empty-query history ordering/groups and keyboard selection.
- Test backend recent-directory/file access filtering and frontend loaded-file filename-only scope. No global file scan or additional connection search may appear as a side effect.

### Companion Tests

Keep the manager testable without a live Tauri AppHandle. Reuse temporary trees, registered test drives, fake clocks, scan barriers, injected events, and nearby handler/router tests. Use native cases on available platforms and injected fixtures elsewhere; no item below requires manual hardware access or certifies an unavailable platform.

- Test cold/progressive/warm/restart behavior, empty activation, multiple origins, repeated queries, bounded worker admission, and one initialization/scan per source. Ten warm queries must cause no extra tree enumeration.
- Index at least 100,001 eligible paths with an injected scanner and search a target discovered after path 100,000. Verify full build/update/verification/reopen counts without a count cutoff. Use small native trees for platform traversal tests; a native 100,001-directory tree is not a routine release requirement.
- Test cancellation, idle release, explicit exit versus tray hiding, stalled OS calls, old-source completions, queue backpressure, and bounded application buffers. Timeout cannot release a still-running worker permit.
- Test create/delete/rename/move/copy, parent-creating archive/uploads, partial failures, external changes, and mutations during initial scan and verification. Exercise accepted/candidate sequence barriers and late-batch rejection.
- In both index runtimes, block an old producer read, exceed barrier entry/byte or dirty-queue capacity, and delete a directory before releasing the read. Assert bounded bookkeeping, epoch rejection of late rows and candidate publication, preserved accepted data, retained blocked-worker permits, one pending verification, and correct later recovery. Test safe barrier retirement with queued batches and overlapping prefixes; elapsed time alone cannot retire a barrier.
- Test watcher failure/overflow/unpaired renames, sleep/resume, scheduled fallback, and recovery without scan storms. Overflow cannot clear its sticky verification requirement prematurely.
- Test dot-directory flags, inaccessible descendants/root failure, symlink loops/outside-root links, replacement races, Unix nested mounts/pseudo trees, Windows junctions/shortcuts/reparse tags, and conservative exclusion of unverified cloud placeholders with explicit coverage issues.
- Test fixed/removable/mapped/network source identity and same-label/root reuse. Unproven restart identity uses session-bound disk storage without old-path exposure.
- Test corruption/rebuild, WAL crash recovery, FTS row consistency, disk exhaustion, candidate/headroom refusal, long paths, maintenance, and permission errors. No resource failure may trim arbitrary accepted rows or create an automatic rebuild storm.

### Frontend and Administration Tests

Extend [directory-provider tests](../frontend/src/components/FileBrowser/search/__tests__/useDirectorySearchProvider.test.ts), [shared-bar tests](../frontend/src/components/FileBrowser/__tests__/UnifiedSearchBar.test.tsx), nearby file/history/renderer/API tests, and existing administration settings tests.

- Resolve history while directory work is deferred: rows appear with valid record maps and remain selectable. Test both source failure directions, complete failure, cancellation, old query/source responses, and mixed capabilities.
- Test quiet refresh/input priority, non-overlap, foreground spinner isolation, resource-stop/backoff, hidden-tab pause/resume, activation cleanup, and no repeated unchanged history calls or legacy full scans.
- Test term-count-first merging and highlights in both modes, source-local truncation, history dedup/icons, stable selected value, dimensions, click/keyboard activation, and Shift+Delete behavior.
- Test counts above 100,000, complete-index response truncation, partial initial coverage, stale accepted data after write failure, query cancellation, and corruption. These states cannot share misleading complete-count or partial-coverage messages.
- Assert history icons for recent directories, folders for index directories, unchanged directory styles, and unchanged file/recent-file icons.
- Test administration units/ranges/defaults, authorization and policy-owner conflicts, paired/unpaired/legacy/offline companion behavior, failed/pending delivery, effective versus desired policy, and safe budget/cache/interval changes.
- Test policy-grant issuance by an ordinary user, wrong purpose/backend/origin/challenge, substituted policy fields, expiry, replay, revoked administrator authority, and concurrent out-of-order revisions. Test verified HTTPS, redirect rejection, loopback-only HTTP, bounded redemption failure, local owner reset, and new consent. Backend tests own issuance and atomic consumption; companion tests own transport, challenge/owner checks, and effective-policy persistence; frontend tests own pending/failed presentation.
- Test disk budget versus retention semantics, current main/WAL/temp/candidate usage, inactive-only eviction, and recovery after capacity increase. A cache-target reduction must preserve full search results.

### Available-Platform and Performance Checks

Run native tests supported by the available host for volume identity, traversal, permissions, locks, SQLite recovery, and exit. Keep platform-specific automated tests so they can run on appropriate CI runners without requiring a release workflow dispatch. Do not require manual hardware access, cloud accounts, production deployments, or new runner provisioning to complete this implementation. Use injected fixtures for unavailable cases and record their limits. Cross-compilation is not native behavior evidence. Verify the local runtime SQLite versions, FTS5 build features, tokenizer settings, and known fixes in both runtimes. Unverified source types retain conservative traversal and restart-reuse behavior.

Use three scoped checks, not a Cartesian product of sizes, path shapes, cache states, concurrency, and operating systems:

- **Coverage regression:** The injected 100,001-path fixture proves that counts, late matches, verification, and reopen have no cutoff. It is a correctness test, not a separate benchmark size.
- **Performance baseline:** During implementation and after material query/storage changes, measure selective, common, and mixed-short queries on one generated 100,000-path dataset on the available host. Record endpoint latency, visible-result timing in frontend tests with mocked companion responses, exact counts, CPU/RSS, configured cache targets, and the test environment. Do not present mocked timing as native companion end-to-end timing. Include one query-during-verification case. Use shared small fixtures for deep/Unicode correctness rather than a benchmark for every shape. Investigate cold-cache, concurrency, or maintenance combinations only when the baseline identifies a problem or a related change needs validation.
- **Capacity experiment:** During implementation and after material storage, traversal, or resource-policy changes, run one generated million-path dataset for each index implementation on the available host, using injected scanning rather than a million-directory native tree. Record initial build and reopen time, query availability, bounded application buffers/RSS, and database/FTS/WAL/temp/candidate peaks during verification. Use measured sufficient capacity to establish full coverage, and assess the proposed default budget separately. Repeat one query/count check with a smaller page cache. These measurements assess storage and query behavior, not production traversal speed. This is not a native-platform benchmark matrix or a gate for unrelated releases.

For selective healthy warm queries at 100,000 paths, retain the target endpoint p95 below 100 ms and visible merged results within 300 ms of the last keystroke, including the 200 ms debounce. Report results against these targets in the available test environment. Record broad exact-count OR scan timings separately rather than require an unmeasured production latency guarantee. Never omit matches or fabricate counts to meet a target. Cancel obsolete queries promptly and preserve usable history while slower complete queries finish. These are targets, not production promises.

Use the capacity experiment and focused small-cache regression to show that cache targets affect performance, not result coverage, and that application memory does not grow as a full copy of the catalogue. Separate SQLite and OS resident memory where practical; disk-backed storage does not mean zero RAM. Tune query plans, page caches, batches, and disk defaults only where these results show a need, without count/RAM-prefix omissions or JSONL persistence.

Use injected scan barriers and stalled calls for tests of query availability, many-file work accounting, and bounded worker admission. Use a small native many-file tree on the available host; do not require a manually stalled network mount or million-file native fixtures. Injected blocked calls verify admission and cancellation bookkeeping, not native shutdown isolation. Record time to first partial results and correct mutation results in the test environment. Target event-driven freshness within two seconds after coalescing under ordinary load; missed-event reconciliation must start by its configured deadline, with completion dependent on scan duration.

Browser checks in VS Code use only `http://localhost:3000/browse/smb/demo`. Mock local companion responses in frontend tests and use native companion tests for real local-drive behavior. Do not connect the VS Code browser to production or another test source.

### Required Commands

During implementation, choose the focused command for the changed slice; this list is not a sequence to run in full after every phase:

```bash
cd /workspace/backend
.venv/bin/python -m pytest tests/test_directory_cache_persistence.py
cd /workspace
cargo test --manifest-path companion/src-tauri/Cargo.toml server::directory_index
npm --prefix frontend test -- src/components/FileBrowser/search/__tests__/useDirectorySearchProvider.test.ts src/components/FileBrowser/__tests__/UnifiedSearchBar.test.tsx
```

At implementation completion, run the aggregate once, plus the gates it does not cover:

```bash
cd /workspace
./scripts/test
cargo fmt --manifest-path companion/src-tauri/Cargo.toml --check
npm --prefix companion run lint
```

`./scripts/test` already runs backend pytest, including existing performance tests, backend mypy, frontend tests/typecheck/lint, and companion TypeScript, Clippy, and Rust tests. Do not rerun those full suites individually on the same unchanged revision. Its Windows cross-check is conditional and skipped in CI; run the following only if the required toolchain is available locally and the aggregate skipped it. Otherwise record the unavailable check; provisioning a runner or dispatching a release build is not required:

```bash
npm --prefix companion run check:rust:windows
```

Adapt Rust filters to the chosen module. Put shared search fixtures and each runtime's storage fixtures in the existing test suites. Test highlight spans in the frontend, where highlighting is rendered, against the shared normalization fixtures; do not build Python/Rust highlight implementations only for testing. Add one repeatable CI command for the small generated-database compatibility test only if existing suites cannot run it. Keep the large capacity experiment separately invoked, outside routine pytest performance markers and the aggregate. Include focused recent-history, loaded-file, response-model, renderer, settings, policy-delivery, and companion frontend tests when those slices change; `./scripts/test` does not run companion frontend Vitest tests. Resolve related warnings and errors; do not suppress them for passing gates. These are future implementation commands, not evidence that the proposed architecture already passes.

The existing million-path storage fixtures are opt-in checks, not complete capacity experiments. Invoke them separately when needed:

```bash
cd /workspace
DIRECTORY_INDEX_CAPACITY_TEST=1 backend/.venv/bin/python -m pytest backend/tests/test_directory_index_contract.py -k 'coverage_above_old_cutoff and 1000001'
cargo test --manifest-path companion/src-tauri/Cargo.toml --lib million_path_capacity -- --ignored
```

Their results do not replace the required verification-generation peak-storage, smaller-cache, application-resource, and query-availability measurements. Routine suites run only the 100,001-path cutoff case from these fixtures.

## Documentation and Rollout

Update the resolved quick bar user guide in documentation version 2.0 only; [the current page](../website/content/docs/2.0/user-guide/find-and-browse-files/smart-navigation-and-the-quick-bar/index.md) is the target reference. All user, administration, and developer documentation edits for this work must stay under `website/content/docs/2.0/`. If a page is inherited, use the docs editor to create a 2.0 override before editing it; do not edit its earlier-version source or author changes in another version. Do not select a future product release or create a version solely for this work. Describe independent terms with both-term-first/one-term-retained examples, filename/path scope, recent-directory icons, useful indexing status, and upgrade limits. Keep it concise and avoid an internal indexing tutorial.

Publish developer documentation for the shared SQLite schema/version rules, normalized search keys, comparator/highlight fixtures, FTS fallback, source identities, accepted/candidate generations, race handling, WAL/transactions/checkpoints, corruption recovery, maintenance, local locations, privacy, and cross-language database tests. Explain that database integrity differs from scan completeness, freshness, and authorization. No JSONL specification, export/restore workflow, or application snapshot backup protocol is part of this release.

Update administration documentation for disk budget versus inactive retention, memory-cache targets versus RSS, usage/headroom accounting, effective backend/companion policy, delivery/ownership/offline behavior, and errors/resume actions. Preserve custom backend cache locations and document precedence/mapping for existing `[directory_cache]` controls; retire full-snapshot save controls rather than leaving them ineffective. Use the docs-update skill and docs editor for version 2.0 pages only; this explicit version scope replaces the usual earliest-applicable-version rule for this work.

Ignore legacy v1/v2 JSONL caches and rebuild in the new SQLite namespace through one background scan per source. Do not import weak legacy metadata, write JSONL mirrors, or retain the per-query walker as an error fallback. Document the first-start background rebuild without requiring production scan-load forecasts. Legacy retirement is bounded and must not race an older writer; temporarily retained legacy bytes count in disk planning.

Rollback binaries ignore the SQLite namespace and rebuild through their existing behavior. Do not downgrade new databases for old readers. No recent-history storage migration is needed for directory-cache replacement, although new history query behavior and response metadata need release tests. Backend and companion databases are not exchanged at runtime, so shared-schema compatibility does not require simultaneous storage migration.

Roll out search capabilities explicitly across backend, frontend, and companion. Older companions retain slow scans, count cutoffs, and single-string search; older frontends lack multi-term merge ranking and progressive refresh. Do not advertise complete new semantics until required source capabilities are available. Index failure preserves successful history with a specific retry/upgrade/storage error rather than silently reverting to full-drive scans.

## Approved Implementation Decisions

The user approved these eight decisions on 2026-11-01, with documentation edits restricted to version 2.0. They define the final implementation contract; they are not evidence that implementation or verification is complete.

1. **Schema and shared contract:** Use one centrally defined application identifier, schema version 1, and separate normalization/search/traversal versions. Keep SQL constraints and language-neutral fixtures under `shared/`. Share the contract, not a runtime storage abstraction. Keep one small cross-runtime open/query test; test each runtime's writes and recovery in its own suite. Rebuild incompatible disposable databases instead of adding migrations or alternate formats.
2. **SQLite integration and recovery:** Use Python's standard `sqlite3` with Debian's maintained system SQLite and an established Rust binding with a maintained bundled SQLite build, subject to the dependency workflow. Check actual runtime versions and required SQL features in tests; do not infer Python's version from Rust's build or require a newer Debian runtime solely for the WAL-reset fix. Keep one serialized write/checkpoint connection, strictly read-only queries, process ownership, WAL and `synchronous=FULL`, bounded busy handling, and library interruption/progress support. Validate identifiers and metadata before serving rows; run integrity and FTS checks in background before the affected data is available. Test rollback and locking locally without claiming power-loss durability on unavailable platforms.
3. **Search comparator and limits:** Use distinct-term count descending, then the best existing single-term rank, not quality vectors. Define one fixed total-order key for mixed sources: relevance first, then a fixed source order, source-local history usage or directory depth, and deterministic connection/path keys. Never switch comparison rules based on the pair being compared. Start with named limits of 4 KiB of raw UTF-8 query input and 32 distinct normalized terms; reject excess input and validate these limits with fixtures. Discard terms that normalize to empty. Use one complete scan when any term is shorter than three normalized characters; otherwise use quoted OR trigram candidates with literal verification. Map highlights back to original text and version the complete contract per source. Apply ranking before every result cap.
4. **Source identity and traversal:** Reuse retained rows only when source identity and containment checks succeed. Otherwise use session-bound SQLite data and report the limitation. Keep platform-specific identity and traversal code small and testable. Reject redirections and unverified cloud tags with coverage issues; do not add cloud-provider support without native evidence. Session-bound reuse alone does not solve within-session removal or replacement: keep root revalidation and old-generation rejection.
5. **Resources and performance:** Keep the proposed defaults as initial settings and run one generated 100k baseline plus one generated million-path capacity experiment per implementation on the available host. Retain the 100,001-path correctness regression. Record measured disk peaks, bounded buffers, RSS, and target misses; adjust only settings or query plans that the measurements justify. Do not add a benchmark matrix, periodic maintenance scheduler, FTS tuning service, or production latency guarantee.
6. **Administration policy:** Reuse the current settings and pairing boundaries, but do not treat an ordinary pairing credential as proof of administrator authority. Use the backend-validated, single-use grant contract in Administration Delivery and Ownership, based on existing JWT/token-exchange tools, current administrator checks, a companion challenge, approved policy contents, and monotonic policy revisions. Redeem directly with the locally consented backend over verified HTTPS without redirects; HTTP is loopback-development-only. Persist one local policy owner; reset requires a local action and new consent while retaining effective policy. Failed/offline delivery cannot change effective values. Resolve backend settings precedence through its existing loader; backend policy must not override companion-local policy implicitly. Implement the trust contract before the form; do not add public-key distribution or a general remote-management framework.
7. **Blocked work and races:** Keep bounded workers and cooperative cancellation; retain permits until blocked work actually exits. Use the bounded barrier and scan-epoch rules in Events and Race Handling. Retire barriers only when older producers and queued batches cannot apply; invalidate affected epochs before overflow cleanup, preserve accepted data, and keep one pending verification through existing admission/backoff. Use injected blocked calls, scan barriers, and SQL failures to test mutation ordering and crash recovery. Do not add a persisted barrier journal, another scheduler, a helper process, or a promise of forced cancellation or bounded native shutdown. A timeout ends the request, not the OS call. If measured requirements later demand process isolation, treat it as a separate scope change.
8. **Documentation and compatibility:** Modify documentation version 2.0 only, using the docs editor and creating 2.0 overrides for inherited pages where needed. Do not edit documentation sources in other versions, choose a future product version, or create a new version. Prepare capability, legacy-rebuild, and rollback notes without publishing or deploying. Ignore legacy JSONL caches, use the separate SQLite namespace, and leave history storage unchanged. Require source capabilities for new semantics; report upgrade needs instead of capped per-term legacy queries or full-drive scan fallback.

The original investigation identified filesystem traversal in every local search request. These historical findings do not establish a production link cycle, blocked mount, permission failure, or support for untested source types. The selected TODO adds required multi-term behavior; it does not change which sources the user can search.

</details>
