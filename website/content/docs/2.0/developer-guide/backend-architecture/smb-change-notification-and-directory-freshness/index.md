+++
title = "SMB Change Notification and Directory Freshness"
+++

Sambee uses SMB2/SMB3 `CHANGE_NOTIFY` support to keep directory state fresh without falling back to naive polling.

That capability is used in two different backend paths:

- `backend/app/services/directory_monitor.py` for browser-visible WebSocket refresh notifications
- `backend/app/services/directory_cache.py` for per-connection directory-cache freshness

Use this page when a backend change affects WebSocket directory updates, SMB watcher lifecycle, or how the product maintains fresh directory state over time.

## Why This Matters

Directory freshness is a cross-boundary product contract.

Users expect Sambee to react when:

- another SMB client creates, deletes, renames, or edits content in the current directory
- the current browser view should refresh because the underlying SMB directory changed
- cached directory-search data should stay reasonably current without rescanning the entire tree on every request

That is why the backend owns change-notification behavior instead of leaving refresh decisions entirely to the browser.

## The Two Change-Notification Paths

Sambee does not have a single watcher for all purposes.

### Browser Notification Path

`directory_monitor.py` is responsible for directory-specific monitoring tied to active WebSocket subscriptions.

Its job is to:

- start watching a directory when the first browser subscriber appears
- share one SMB monitor across multiple subscribers for the same watched path
- stop monitoring when the last subscriber leaves
- send `directory_changed` messages back through the WebSocket layer

This is the path that keeps an open file browser view fresh.

### Directory-Cache Freshness Path

`directory_cache.py` uses its own `CHANGE_NOTIFY` watcher for a different reason.

Its job is to:

- watch the share root or effective path prefix for directory-name changes
- update SQLite directory rows for adds, removes, and renames
- combine event-driven updates with periodic full rescans as a safety net
- preserve fast directory-search behavior without rebuilding the entire cache on every navigation event

This is not the same as the browser WebSocket monitor, even though both rely on SMB `CHANGE_NOTIFY`.

## Browser Notification Flow

At a high level, the browser-facing flow is:

1. the browser opens the backend WebSocket endpoint
2. it sends a subscription message for a connection and directory path
3. `ConnectionManager` resolves access, applies any `path_prefix`, and starts monitoring if this is the first subscriber
4. `DirectoryMonitor` opens SMB resources for that resolved directory and starts a background watcher thread
5. when the SMB server reports a change, the backend emits `directory_changed` to all subscribers for the user-facing path
6. when the last subscriber leaves, the monitor stops and releases its SMB resources

Representative client messages include:

- subscribe: `{ "action": "subscribe", "connection_id": "uuid", "path": "/dir" }`
- unsubscribe: `{ "action": "unsubscribe", "connection_id": "uuid", "path": "/dir" }`
- server notification: `{ "type": "directory_changed", "connection_id": "uuid", "path": "/dir" }`

## Path Resolution and Subscription Keys

One subtle but important part of the design is that browser subscriptions and SMB watches do not always use the same path string.

The WebSocket layer keys subscriptions by the user-facing path.

If the SMB connection has a `path_prefix`, the backend resolves the actual watched SMB path by combining:

- the normalized connection prefix
- the user-facing relative path

That resolved SMB path is what `DirectoryMonitor` actually watches.

The callback then maps notifications back to the user-facing path before sending `directory_changed` over the WebSocket.

If you remove that mapping, subscriptions stop lining up with the paths the browser thinks it subscribed to.

## Main Components

| Path | Responsibility |
|---|---|
| `backend/app/api/websocket.py` | WebSocket endpoint, subscription bookkeeping, access checks, path-prefix resolution, and delivery of `directory_changed` events |
| `backend/app/services/directory_monitor.py` | per-directory SMB watchers for active browser subscriptions |
| `backend/app/services/directory_cache.py` | per-connection directory cache plus root-level `CHANGE_NOTIFY` watcher for cache freshness |
| `backend/app/main.py` | application shutdown hooks for directory caches and directory monitors |

## Directory Monitor Lifecycle

The browser-facing monitor is reference-counted by subscription demand.

`DirectoryMonitor` keeps one `MonitoredDirectory` per `connection_id:path` key and tracks subscriber counts.

That means:

- the first subscriber starts the monitor
- later subscribers reuse the same watched directory instance
- unsubscribing decrements the count
- the monitor only stops when the count reaches zero

This avoids opening duplicate SMB watcher handles for the same directory just because multiple browser clients are watching it.

## SMB Resource Management

`MonitoredDirectory` owns low-level SMB resources directly.

Creation follows this order:

1. connection
2. session
3. tree connect
4. directory open handle
5. `FileSystemWatcher`

Cleanup happens in reverse order so partial failure does not leak handles.

That ordering is important because change-notification bugs are often really handle-lifecycle bugs.

## Watched Events

The browser-facing monitor currently watches for:

- file-name changes
- directory-name changes
- size changes
- last-write changes

The browser-facing monitor watches only immediate children of the subscribed directory. Writes deeper in the tree, such as installing packages in a project's `node_modules` folder, don't invalidate an ancestor's file list. If the SMB server reports a metadata change for an immediate child directory, that change can still trigger a refresh.

The directory-cache watcher is narrower by design.

It watches directory-name changes across the tree because the cache only needs enough signal to update its directory index efficiently.

## Directory-Index Consistency

The default backend cache manager now creates a SQLite-backed SMB source. Database validation and scanning run in a shared background task. Cold and empty queries return available status without waiting for the full scan. Initial batches are query-visible with partial coverage. An interrupted build is checked through a fresh candidate rather than accepted from its old scan queue.

Verification builds a separate generation while existing rows remain selected. The coordinator checks a read's sequence, changed-prefix barriers, and scan epoch before committing children or completing a parent. Final selection also checks the root baseline. An overlapping change or lost observation invalidates the producer and retains a verification request. Queue overflow preserves already queued mutations. A failed SQL mutation stays queued for retry.

Directory rows, FTS entries, counts, and queued subtree paths change in one transaction. Remove and rename operations cannot leave obsolete scan paths behind. Unresolved issue rows prevent complete coverage. Event loss marks accepted coverage uncertain without deleting rows or advancing verification time.

The manager shares one scan permit and two query permits across its sources. SMB scan batches are bounded by both rows and path bytes. Queries run off the API event loop and obtain results, relevance, exact counts, revision, and coverage from one read transaction. Cancelling a scan retains its SMB pool lease and process ownership until the blocking worker exits. Storage initialization failures keep a bounded background retry. Replacing a source does not wait for a stalled old close worker; that worker retains its ownership until it exits. Both managers reject late query results from stopped bindings.

The SQLite scanner does not descend into directory reparse points, including DFS referrals. DFS behavior, link-replacement containment, and excluded-root coverage still need traversal qualification before the new capability is enabled.

### SQLite Persistence

Backend databases use opaque source filenames under `data/directory_cache/sqlite/`, or the `sqlite/` namespace below `directory_cache_location`. Identity includes connection ID, host, port, share, normalized path prefix, username, and connection revision. Passwords are excluded from stored metadata. A changed runtime source or credential binding stops the previous source before replacement.

Live SQLite sources do not read or import JSONL snapshots. Legacy snapshot code remains only for migration test coverage while its replacement is completed. There are no periodic full-index exports in the live SQLite path.

### Storage Qualification And Remaining Work

The shared SQLite schema and search fixtures are in `shared/directory-index/`. The Python storage module is `backend/app/services/directory_index.py`. The Rust storage module is `companion/src-tauri/src/server/directory_index.rs`.

Both modules are connected to their live directory APIs. The companion uses a shared background manager instead of a per-request walk or a discovery cutoff. Its independent readers can query committed initial batches while a scan continues. Exact counts are not limited by the returned-result cap. Recent-directory history, recent-file history, loaded files, and the indexes use independent search terms. The new index capability flag remains disabled until all required safety and policy controls are complete.

The companion stores SQLite catalogues under its OS-user cache directory in `directory-index/sqlite/`. Catalogue names are session-bound because durable root-identity reuse is not yet qualified. Linux traversal uses held directory descriptors, no-follow opens, exact native names, and device and mount checks. It classifies the held root filesystem to reject known kernel pseudo-filesystems. Device-tree roots and aliases on the same device as `/dev` are rejected; ordinary tmpfs data remains eligible. Native tests cover `/proc`, `/sys`, and `/dev`, links, unsupported names, and parent/root replacement. These checks do not certify every filesystem type. Root replacement retires the old binding. Other platforms refuse indexing until a safe native adapter is available. Idle companion sources release their readers, writers, and watcher after ten minutes when no worker or request still owns them. Stalled workers retain their actual permits until they exit.

Both managers reserve shared write headroom and check filesystem free space before growing batches. Backend accounting includes SQLite sidecars, namespace temporary files, and legacy snapshots. Lowering a disk policy can pause growth without deleting accepted rows. These controls do not establish a hard physical disk ceiling or complete temporary-storage accounting.

Backend sources release idle handles after ten minutes when no scan, query, or blocking worker still uses them. A cancelled cleanup request retains the source until its close worker exits. The backend records query access separately from writes and verification. Its inactive cleanup applies retention, a bounded retained-source count, and disk-pressure eviction. Active-source registration and process leases prevent deletion of admitted or externally owned sources. Future access timestamps do not imply recent use.

Both runtimes serialize source-lease creation and orphan-lease removal through a short-lived namespace process lease. Cleanup removes at most 64 orphan lease files per pass, only when no owner, main database, or sidecar remains. It closes the source lease before removal while retaining namespace ownership, which prevents a cooperating process from replacing the lease inode during the operation. The namespace lease remains in place. Tests cover namespace contention, retained source owners, sidecars, and bounded batches. These controls do not replace race-safe filesystem containment or qualify older processes that do not use the namespace protocol.

Unix storage checks reject hard-linked main databases, WAL, SHM, and lease files. A second pathname must not open the same database inode with different sidecars. Tests verify rejection before a second source opens, while the original source remains readable. Windows hard-link qualification and concurrent filesystem replacement remain required.

Backend initialization hides retained rows until a background root-listing probe succeeds. The probe uses nonblocking scan admission and retains the SMB pool lease through actual worker exit. Root-listing or pool-entry failure makes the binding unavailable without deleting its rows. The directory API returns a specific HTTP 503; late SQL results cannot bypass the availability check. Descendant failures remain separate from root loss. Invalid scan epochs cannot restore availability through a late root probe. Capacity refusal preserves known availability and retries through the existing loop without starting an unadmitted SMB read. These controls establish basic read availability, not stable SMB root identity, mount containment, or safe retained-data reuse after root replacement.

Both stores remove retired directory and scan-queue rows in bounded transactions. Successful verification and failed-candidate retirement queue this logical cleanup without changing selected results, revisions, or verification time. Cleanup defers for active query work. The native manager can schedule additional batches within a 250 ms slice, with a separate growth reservation for each transaction. It releases writer and observation locks between batches and gives priority to queries, scans, and pending observations. The slice limits scheduling, not operating-system call duration. Native subtree rename batches include all signed SQLite row IDs, including zero and negative values.

The shared `schema.sql` defines directory rows and synchronization triggers; `fts.sql` defines the derived virtual table. Startup validates directory storage before checking FTS consistency. The shared `validate-generations.sql` checks exact directory and issue counts and a selected generation in a publishable state. SQLite integrity checks alone do not establish those application invariants. Invalid generation metadata is rejected before query publication. Missing or inconsistent FTS data uses complete literal scans of validated directory rows while a background scan worker rebuilds tokens in batches of at most 256 rows. Directory mutations wait for repair; pending observations remain queued. Repair does not change directory counts, revisions, or verification time. Interrupted repair restarts from validated rows, and storage failures retain scan-based search and bounded retry. Physical database corruption still fails closed. Full database replacement, FTS-reset headroom measurements, and recovery-failure qualification remain required.

Disk-admission failures request one coalesced reclamation job per source. The writer runs at most 256 incremental-vacuum pages per step, under the shared growth reservation, after pending updates and logical cleanup. Active scans, active queries, or pinned WAL readers defer the step. A passive checkpoint checks reader progress before reclamation; WAL truncation follows only when SQLite permits it. Tests verify reduced main-file page counts and unchanged search results, revision, and verification time. There is no periodic idle reclamation.

Normal WAL handling is independent of disk pressure. The existing update loop checks the shared 1 MiB WAL threshold outside the async executor. Below that threshold, it runs no checkpoint SQL and requests no maintenance reservation. Due checkpoints use shared headroom, defer for active work or pinned readers, and retry after readers release their snapshots. Tests verify truncation and unchanged results and freshness metadata. Complete disk accounting, operation-headroom measurements, and directory-database recovery remain required.

The companion applies inactive retention, retained-source count, and disk-pressure eviction under process leases. It checks the database application, schema, source kind, and unchanged access time before deletion. Active and externally owned databases remain protected. Its idle close runs outside the async executor and records last query access before releasing the lease. Failed access-time writes can cause disposable closed cache data to expire earlier; they do not affect history.

Administration has separate backend and companion desired policies. Backend changes apply to live sources. Companion delivery requires a current administrator, a native challenge, and local approval of one backend owner. The backend issues a purpose-separated, single-use grant and checks administrator access again at redemption. The browser sends only that opaque grant. The companion redeems it directly with verified HTTPS, or HTTP on a literal loopback host; redirects are refused. It checks the companion, challenge, origin, backend identity, revision, and policy before storing the approved receipt. Failed delivery preserves the last approved policy. An admitted redemption continues if its browser request is cancelled. Native Preferences shows the owner and provides a confirmed local reset to defaults. The policy process lease remains held through actual worker exit. Only one native approval prompt can remain active, including after challenge expiry. Busy policy storage returns an actionable response instead of blocking status requests. Complete platform persistence and transport qualification remain required.

Companion file-mutation APIs reject paths inside the configured native configuration and SQLite storage directories, and mutations of their ancestors. This includes create, delete, rename, move, and common destination resolution. Canonical path checks cover existing aliases and missing descendants. On Windows, component comparisons use the operating-system Unicode uppercase table through `CompareStringOrdinal`, not ASCII lowercasing. Comparison failures block mutations. Windows Unicode case-alias tests compile on the Debian cross-check host but still need native execution. These checks do not establish containment under concurrent path replacement or all Windows filesystem aliases.

Policy-origin bindings must contain at most 2,048 UTF-8 bytes, both before and after URL canonicalization. Backend tests cover oversized Unicode input, oversized canonical host names, and the exact byte boundary.

Native policy selection checks source locks before changing runtime settings. It serializes source initialization against policy changes and restores each writer's actual cache target when persistence fails. The reported resource policy changes only after persistence succeeds. Failed policy-file selection attempts to restore the previous file. If storage cannot be restored, further delivery is blocked with a specific native recovery message. Reset checks manager availability before clearing the stored owner. Platform durability and concurrent failure qualification remain required.

The storage tests cover source-kind and identity checks, strict integer storage, row and FTS transactions, separate verification generations, literal any-term matching, exact unique counts, and bounded returned results. Both runtimes have private-storage checks, process leases, transactional subtree mutations, and disk scan queues. Python tests also cover worker admission, stale scan rejection, queue overflow, uncertain coverage, API metadata, and off-loop queries. Close retains the writer and process lease until admitted work finishes. Both runtimes test generated 100,001-path and opt-in 1,000,001-path catalogues, including trigram searches, short-term full scans, a three-result limit, and reopen validation. The explicit compatibility test opens a Python `sqlite3`-created database through Rust source validation and checks process-lease exclusion. These storage tests do not establish full native traversal safety, resource-policy enforcement, or production performance.

On the Debian test host, both drivers reported the same sampled database and sidecar sizes:

| Generated rows | Managed bytes after insertion |
|---|---:|
| 100,001 | 20,315,120 |
| 1,000,001 | 167,534,064 |

These measurements precede the backend conversion from APSW to standard `sqlite3`. The combined two-fixture Python run took 29.99 seconds and reached 193,144 KiB peak process RSS. The Rust debug test binary took 60.88 seconds and reached 24,164 KiB peak process RSS, excluding compilation. Each run includes initialization, insertion, searches, reopen checks, and cleanup; these are not query-latency measurements. Python includes pytest and application fixtures, while Rust uses a library test binary rather than the running Tauri application. Do not compare these figures as equivalent application memory measurements. Disk sampling is not a peak-storage guarantee. Concurrent manager jobs, descriptor use, worst-case Unicode paths, temporary storage, and native application resource measurements remain required.

`shared/directory-index/unicode.json` defines normalization keys, whitespace, and word-character ranges for search contract version 1. Generate it with `backend/.venv/bin/python scripts/generate-search-unicode-contract.py`; use `--check` to detect stale data. Rust and TypeScript use the generated Unicode 16.0 table. Python tests compare it with the backend interpreter's Unicode data. This avoids runtime-dependent case folding and word boundaries. TypeScript maps normalized matches back to original UTF-16 display ranges and merges overlapping highlights.

Backend directory indexes use Python's standard `sqlite3`, with the same Debian system SQLite library as the application database. The test host uses SQLite 3.46.1. No separate Python SQLite binding or custom SQLite build is required. Runtime validation checks serialized threading, SQLite 3.37 or later, STRICT tables, RETURNING, and the required FTS5 trigram settings. The production and devcontainer validation workflows run this check against their actual images. The Rust companion retains its maintained bundled SQLite build and its 3.51.3 minimum.

Both stores retain WAL and `synchronous=FULL`. SQLite's [WAL documentation](https://www.sqlite.org/wal.html#walresetbug) describes a reset race between writes and checkpoints on different connections. Each active backend index uses one connection for all writes, checkpoints, and maintenance under the same writer lock. Queries open strictly read-only connections and use explicit read transactions. Closure retains the writer lock and process lease until readers finish. Inactive cleanup can open a writer only while it holds the process lease after the active writer has closed; a busy checkpoint prevents deletion. External writes to active managed indexes are unsupported. This prevents the affected concurrent-write/checkpoint configuration; it does not claim that Debian has backported the fix. Continue Debian security updates through normal Docker builds. These checks do not certify filesystem durability on unavailable platforms.

Remaining work includes race-safe storage and traversal containment, a Windows traversal adapter, complete event reconciliation, backend root availability, complete disk accounting and operation-headroom measurements, directory-database recovery, and application-level million-path resource measurements. macOS directory indexing is outside the approved scope. Policy delivery also needs full native-platform and failure qualification. Do not enable the new index capability before those controls and their tests are complete.

### Progressive Quick-Bar Results

`SearchProvider.fetchResults` accepts an optional complete-array update callback. The directory provider uses the same merge path for updates and the final result. It installs recent-history selection records before publishing history rows. The file provider publishes selectable loaded-file matches before history completes. A history failure retains loaded matches and displays a specific connection error. Request generations and source bindings prevent old completions from replacing newer selection records.

The shared bar supports one quiet-refresh timeout after each accepted response. Refresh uses the same fetch and publication path without a foreground spinner or focus change. Typing, dismissal, source changes, hidden tabs, and terminal failures stop obsolete work. Providers must opt in through `getRefreshIntervalMs`; the directory provider requires search contract version 1 and an active build or update. Legacy endpoints never trigger automatic index polling.

Quiet index refresh reuses history for the active query. Explicit history-change, window-focus, and tab-visibility refresh tokens invalidate that reuse. Shared ranking uses distinct matched-term count first, then best single-term quality and deterministic Unicode code-point ties, including before loaded-file limits. Duplicate matches retain the history representation and action while taking the best valid relevance from either source. Files match basenames only. History services stream accessible per-user records before their bounded top-result selection. Invalid query limits return HTTP 400 rather than a server error.

The shared bar rejects obsolete request and query updates and preserves selection by value. Input changes and dismissal cancel the request. Recent directories use the history icon; indexed folders retain the folder icon and directory text style. The directory provider displays incomplete or uncertain coverage and source status messages while retaining usable rows. A late warm-up response cannot replace newer query status. Automatic index refresh remains gated by the disabled new search capability.

## Recovery and Failure Handling

The directory monitor treats connection failures as part of normal long-lived operation, not as impossible edge cases.

Current behavior includes:

- exponential backoff for reconnect attempts
- retry jitter to avoid synchronized reconnect storms
- capped retry attempts before giving up
- explicit detection of connection, socket, and timeout failures
- stop-on-delete behavior when the watched directory itself is deleted

The cache watcher has its own retry loop and also tolerates `CHANGE_NOTIFY` buffer-overflow conditions by relying on later rescans to restore correctness.

That distinction matters: browser notification is path-specific and subscriber-driven, while the cache watcher is connection-scoped and consistency-oriented.

## Shutdown Behavior

Sambee shuts these systems down explicitly.

During application shutdown:

- directory caches are stopped through `shutdown_directory_cache()`
- directory monitors are stopped through `shutdown_monitor()`

That explicit shutdown path exists to release watcher threads and SMB handles cleanly instead of depending on interpreter teardown.

## Performance Characteristics

The design tries to keep freshness inexpensive without resorting to constant polling.

- SMB `CHANGE_NOTIFY` is event-driven rather than poll-based
- multiple browser subscribers share one monitor for the same watched path
- browser-facing monitors don't request recursive subtree notifications
- each browser pane keeps loaded physical-directory rows visible during automatic refreshes, including a previously loaded empty listing
- automatic refreshes wait for an active listing request and combine newer notifications into one pending refresh, starting at most once per second
- navigation and pane disposal cancel queued refreshes
- directory-cache updates avoid full rescans for every single directory rename or add event
- periodic rescans remain in place as a correctness safety net, not the primary freshness mechanism

## Limits and Tradeoffs

Contributors need to preserve a few constraints here.

- this requires SMB2 or later
- some notifications can still be missed during network instability, which is why manual refresh and periodic cache rescans still matter
- the browser-facing path is optimized for telling clients to refresh, not for transmitting rich per-file diffs
- cache freshness and browser freshness are related concerns, but they are not the same subsystem and should not be collapsed casually

## Common Failure Modes

- path-prefix resolution is ignored, so the monitor watches the wrong SMB directory
- subscriber bookkeeping drifts, so monitors are leaked or stopped too early
- WebSocket disconnect cleanup forgets to release the last subscriber's monitor
- a recovery change handles one timeout path but leaks SMB resources on reconnect
- buffer-overflow or rename-edge handling is simplified in ways that quietly degrade cache correctness

## Where to Continue

- Use [Request Flow and Service Boundaries](../request-flow-and-service-boundaries/) for the broader backend layering model.
- Use [File Operations and Edit Locking](../file-operations-and-edit-locking/) when the changed behavior interacts with uploads, moves, renames, or companion-assisted editing.
- Use [Test Strategy Overview](../../testing-and-quality-gates/test-strategy-overview/) when the change requires wider backend or browser validation.

## Validation Expectations

When you change SMB change-notification behavior, usually run:

```bash
cd backend && pytest -v
cd backend && mypy app
```

If the change affects browser-visible refresh behavior, add the relevant frontend checks as well.
