# Quick Bar: Remaining Tasks

## Status and Checklist Rules

Updated 2026-11-01. Repository version: 2.0.26. Implementation is partial. The new directory-index search capability remains disabled.

This checklist lists unfinished implementation and verification. An unchecked verification task does not mean its implementation is absent. Close each task only when its acceptance checks pass and the evidence is recorded. Reuse existing code and tests; do not restart completed work.

The [current implementation record](../website/content/docs/2.0/developer-guide/backend-architecture/smb-change-notification-and-directory-freshness/index.md#storage-qualification-and-remaining-work) confirms that shared SQLite storage, background managers, independent-term search, progressive results, recent-directory icons, administration controls, and policy-grant delivery are implemented. Standard Python `sqlite3`, serialized writer/checkpoint ownership, read-only queries, process leases, FTS repair, and bounded cleanup also have focused tests. Their final integration and failure checks remain part of the tasks below.

The approved requirements remain in the collapsed reference section. Its original findings and future-tense instructions are historical context, not the current task status.

## Scope Constraints

- Keep the eight approved decisions. This checklist does not resume application implementation; the last approval resumed only the Python binding and concurrency change.
- Keep backend SQLite on Debian's system library and the companion on its approved Rust binding. Do not restore APSW, build custom SQLite, or mix Debian distributions. Follow the dependency workflow for further dependency changes.
- Keep SQLite as the only directory-index storage format. Keep recent history in the application database and local indexes on the companion computer.
- Keep directory searches within the targeted connection and file matching within loaded basenames and accessible recent-file history. Do not add drive-wide file or content search.
- Keep Windows indexing in scope. macOS indexing is excluded; report it as unavailable and preserve successful history results.
- Keep routine tests focused, with one 100,001-path cutoff regression per runtime. Keep million-path experiments opt-in and outside the aggregate.
- Change product documentation in version 2.0 only through the docs editor. Do not change product versions, commit, publish, deploy, or require manual hardware certification.

## Source Identity and Traversal

- [ ] Complete backend SMB root identity and availability checks beyond the existing root-listing probe. Cover root replacement, mount/DFS identity, idle/sleep revalidation, and rejection of late results from an old binding.
- [ ] Qualify retained-source identity for supported local source types. Keep session-bound SQLite data where restart identity cannot be proved; report that limit and bound cleanup.
- [ ] Implement a safe Windows traversal adapter with handle-based containment, volume/root validation, exact native-name handling, and removal/replacement detection.
- [ ] Classify Windows reparse tags. Exclude junctions, name-surrogate redirections, shortcuts, and unknown or unverified cloud placeholders with explicit coverage issues; do not treat all reparse points as equivalent.
- [ ] Complete race-safe traversal containment for backend SMB and supported companion sources. Test link and parent replacement, nested mounts, pseudo-filesystems, invalid native encodings, inaccessible descendants, and root failure.
- [ ] Verify bounded traversal work for many-file trees, path/depth limits, cancellation checks, and batch backpressure. Directory counts must never stop coverage.

## Events and Verification

- [ ] Complete dirty-parent reconciliation: immediate children, new or moved-in subtrees, deleted subtrees, and both rename parents. Do not require paired rename events.
- [ ] Complete the common mutation notification path for create/delete, empty-directory removal, rename, copy/move, transfers, parent-creating uploads, and archive extraction. Reconcile affected parents after partial failures.
- [ ] Complete changed-prefix coalescing and outstanding-producer tracking. Retire barriers only after all older reads and queued batches can no longer apply; never retire them by elapsed time.
- [ ] Verify entry/byte and dirty-queue overflow handling in both runtimes. Invalidate affected scan epochs before clearing bookkeeping, preserve accepted rows and worker permits, reject late publication, and retain one verification request.
- [ ] Verify reconciliation of accepted and candidate generations through a captured sequence before final selection. Failed verification must preserve usable accepted rows and accurate issues and freshness.
- [ ] Complete and test watcher-loss, overflow, idle/sleep, and root-change recovery. Verify healthy/degraded full-pass deadlines, jitter, 30-second-to-five-minute failure backoff, and no retry storms under unchanged resource refusal.
- [ ] Qualify idle release, source replacement, and explicit exit versus tray hiding. Blocked calls must retain worker, SMB-pool, and process ownership until actual exit; do not promise forced cancellation.

## Storage and Recovery

- [ ] Complete race-safe private-storage creation, open, replacement, and deletion. Preserve custom backend cache roots; reject unsafe permissions, ownership, links, and aliases without exposing private paths.
- [ ] Qualify Windows hard-link and filesystem-alias protection for main databases, sidecars, leases, and protected configuration paths. Run native Unicode alias tests where available; record unavailable native checks.
- [ ] Complete background replacement of corrupt, incompatible, or invalid directory databases. Preserve usable accepted data where possible, exclude corrupted rows, bound quarantine, and prevent discard/rebuild loops on storage failure.
- [ ] Measure FTS reset/rebuild headroom and qualify interrupted repair, denied storage, FULL/IOERR, and retry behavior. Valid row-table scans must remain complete while FTS is repaired.
- [ ] Remove obsolete backend RAM/JSONL implementation and snapshot-only tests after replacing required lifecycle coverage. Verify bounded legacy retirement, no import or full-drive fallback, and isolation from older writers and rollback binaries.
- [ ] Qualify row/FTS/count/issue/revision transactions, failed queued mutations, candidate acceptance, orphan retirement, and restart recovery. Count and results must use one selected-generation read view.
- [ ] Qualify writer/checkpoint/maintenance/close serialization and process leases under long readers, cancellation, cleanup contention, and interrupted shutdown. Read-only query connections must never checkpoint or write.
- [ ] Run required SQLite feature checks in the actual supported Docker image and record runtime versions and tokenizer settings. The local Python runtime is qualified; a fresh Docker build was not available on the recorded host. Do not claim a Debian WAL-reset backport or unavailable filesystem durability.

## Resources and Administration

- [ ] Complete manager-wide disk accounting for main files, WAL/SHM, journals, SQL temporary work, candidates, maintenance, quarantine, and legacy retention. Measure sufficient operation headroom; do not describe admission as a hard physical allocation ceiling.
- [ ] Qualify growth refusal, budget shrink, inactive-only eviction, age/count retention, and capacity restoration. Preserve active accepted catalogues and retry eligibility; report usage, cleanup, headroom, and over-budget state.
- [ ] Qualify bounded logical cleanup, incremental vacuum, and normal WAL checkpoints under pressure, pinned readers, interruption, and insufficient headroom. Verify foreground priority and unchanged results, revisions, and verification time.
- [ ] Measure aggregate page-cache targets, batches, top-K buffers, dirty queues, barriers, file descriptors, temporary SQL work, and application RSS. Smaller caches must preserve coverage; allocation failure must produce a specific error.
- [ ] Complete administration integration checks for units, ranges, defaults, backend configuration precedence, policy version, separate host scopes, and desired versus effective usage and policy. Read the settings-form-dialog pattern before further form changes.
- [ ] Qualify administrator grant issuance and atomic redemption against wrong purpose, backend, origin, companion, challenge, policy substitution, expiry, replay, revoked authority, and out-of-order revisions.
- [ ] Qualify direct verified HTTPS redemption, redirect rejection, loopback-only development HTTP, timeout/offline failures, cancellation, and single-prompt admission. Browser-supplied policy or endpoint values must never become authority.
- [ ] Qualify native policy persistence and recovery under concurrent delivery, source initialization, save failure, and owner reset. Preserve the effective policy, require local consent for a new owner, invalidate pending challenges, and block delivery if recovery fails.
- [ ] Qualify pending/failed/unsupported delivery presentation for unavailable, unpaired, old, offline, and competing-origin companions. Ordinary pairing must not grant policy ownership.

## Search, API, and Quick Bar

- [ ] Complete cross-source acceptance checks for normalization, limits, any-term inclusion, exact unique counts, short-term full scans, literal punctuation, and term-count-first ranking before result limits. Reuse shared fixtures and existing source tests.
- [ ] Verify the fixed mixed-source total order, Unicode ties, history usage below relevance, and duplicate relevance merging while preserving the history icon, selection value, and action. Preserve filename-only file matching and per-user history access.
- [ ] Complete highlight and row tests for case-fold expansion, decomposed accents, overlapping terms, primary/secondary text, stable dimensions, accessibility, keyboard selection, and Shift+Delete.
- [ ] Complete source-failure and stale-response tests: history before index completion, loaded files before history completion, valid selection maps, obsolete query/source/activation responses, and no focus change from background updates.
- [ ] Qualify the gated quiet-refresh path with one 500 ms timeout, 200 ms input priority, no overlap or spinner flashes, same-query history reuse, invalidation, terminal-stop/backoff, hidden-tab pause/resume, and activation cleanup. Never poll legacy full-scan endpoints.
- [ ] Complete API/status tests for counts above 100,000, output truncation, partial coverage, stale accepted data, query cancellation/failure, source loss, corruption, and storage refusal. Keep these states distinct and preserve successful sources.
- [ ] Complete mixed-version capability tests and source-specific upgrade behavior. Do not recover legacy semantics with capped per-term requests or enable the new capability before the required safety and policy checks pass.

## Logs and Measurements

- [ ] Verify structured lifecycle and query logs for initialization, recovery, scans, accepted generations, watcher loss, storage pauses, eviction, transactions, busy waits, checkpoints, maintenance, and retries. Aggregate descendant failures.
- [ ] Verify companion frontend API timing for method, route template, status, duration, cancellation, and optional revision. Exclude raw paths, source/account identities, terms, credentials, pairing data, and signed URLs from all logs.
- [ ] Run one generated 100,000-path baseline per runtime after material query/storage changes. Measure selective, common, mixed-short, and query-during-verification cases, exact counts, CPU/RSS, cache targets, and endpoint timing.
- [ ] Measure pasted/incremental-query visible-result timing with mocked companion responses. Report selective endpoint p95 against 100 ms and visible merged results against 300 ms including debounce; separate broad exact-count timing and do not claim native companion performance from mocks.
- [ ] Run one generated million-path capacity experiment per runtime with injected scanning. Record build/reopen time, query availability, bounded application resources, and database/FTS/WAL/temp/candidate peaks during verification. Repeat a query/count check with a smaller cache and assess the 2 GiB default separately.
- [ ] Record first-partial-result and mutation-freshness timing, including blocked-call admission and a small native many-file tree. Compare ordinary event freshness with the two-second target and verification start with its configured deadline.
- [ ] Record host, runtime versions, fixture methods, target misses, and unavailable native checks. Existing opt-in storage fixtures and pre-`sqlite3` RSS figures are not complete application capacity or peak-storage evidence.

## Final Checks and Documentation

- [ ] Complete focused owning-boundary tests for the tasks above. Retain the routine 100,001-path build/update/verification/reopen regression and one small source-validated Python-to-Rust database compatibility check; do not add a platform/performance matrix.
- [ ] Run available native identity, traversal, permissions, locks, recovery, and exit tests. Use injected unavailable-platform cases and state their limits; cross-compilation is not native certification and macOS indexing is not an open gate.
- [ ] Update version 2.0 user documentation after behavior is qualified: independent terms, path/basename scope, history icons, useful status, recovery actions, and upgrade limits.
- [ ] Complete version 2.0 developer and administration documentation for storage/search contracts, source identity, generations/races, WAL ownership, recovery, disk/cache/retention semantics, policy precedence/ownership/delivery, local locations, and privacy. Use the docs editor and 2.0 overrides for inherited pages.
- [ ] Complete capability, first-start legacy rebuild, and rollback notes. Do not add database downgrade, history migration, JSONL mirrors, or export/restore procedures. Validate documentation and refresh derived artifacts through the docs workflow.
- [ ] At implementation completion, run `./scripts/test` once on the final revision, then Rust formatting and companion lint. Run companion frontend Vitest separately, which the aggregate does not cover. Run the Windows cross-check only if its toolchain is available and the aggregate skipped it; otherwise record it as unavailable. Resolve related warnings and errors.
- [ ] Record final acceptance evidence and remaining platform limits. Enable the new source capability only after its implementation, safety, policy, and compatibility gates pass; this checklist edit does not authorize that code change.

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

The user confirmed standard Python `sqlite3` for backend directory indexes. The supported backend deployment is the repository's Docker image. Use Debian's system SQLite library, as the application database does; remove APSW and its separately bundled SQLite runtime. Do not build a custom SQLite library or mix Debian distributions to obtain a newer release. Validate STRICT tables, RETURNING, and FTS5 trigram support in the actual runtime. Keep WAL and `synchronous=FULL`. Prevent the documented WAL-reset race by using one connection for every active database's writes and checkpoints under its writer lock, with strictly read-only query connections and a process ownership lease. Cleanup can open a writer only after the active writer has closed and cleanup holds that lease. External writes to active managed indexes are unsupported. Continue Debian security updates; this configuration does not claim that Debian has backported the WAL-reset fix. The user resumed implementation for this binding and concurrency change only; the remaining plan work is not resumed by this decision.

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
