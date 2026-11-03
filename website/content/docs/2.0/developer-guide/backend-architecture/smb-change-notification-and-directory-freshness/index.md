+++
title = "SMB Change Notification and Directory Freshness"
+++

Sambee uses two separate SMB2/SMB3 `CHANGE_NOTIFY` paths: one tells an open browser to refresh its directory listing; the other maintains the directory-search index. They have different subscription, event, and consistency rules.

## Components

| Component | Responsibility |
|---|---|
| `backend/app/api/websocket.py` | Browser subscriptions, access checks, path-prefix mapping, and `directory_changed` delivery |
| `backend/app/services/directory_monitor.py` | Shared per-directory SMB watchers for active browser subscriptions |
| `backend/app/services/directory_cache.py` | Per-connection index lifecycle, recursive directory-name notifications, and background verification |
| `backend/app/services/directory_index.py` | SQLite storage, generations, search, and maintenance |
| `backend/app/services/directory_traversal.py` | Handle-bound SMB enumeration, identity validation, and exact missing-child checks |
| `companion/src-tauri/src/server/directory_manager.rs` | Local-drive index lifecycle, native observations, and background workers |
| `backend/app/main.py` | Backend monitor and cache shutdown |

## Browser Notifications

### Subscriptions and Paths

`DirectoryMonitor` shares one `MonitoredDirectory` per `connection_id:path`. The first subscriber starts it; the last unsubscribe stops it. A WebSocket disconnect must release that client's subscriptions.

The WebSocket layer uses user-facing paths. `ConnectionManager` applies the connection's `path_prefix` to obtain the native SMB path. Notification callbacks map that path back to the user-facing path before delivery. Subscription keys and native watch paths must not be used interchangeably.

| Message | Example |
|---|---|
| Subscribe | `{ "action": "subscribe", "connection_id": "uuid", "path": "/dir" }` |
| Unsubscribe | `{ "action": "unsubscribe", "connection_id": "uuid", "path": "/dir" }` |
| Change notification | `{ "type": "directory_changed", "connection_id": "uuid", "path": "/dir" }` |

### Events and Refreshes

Browser watchers observe file names, directory names, sizes, and last-write changes in the subscribed directory's immediate children. They do not watch the whole subtree. A deep write does not invalidate every ancestor listing, although metadata changes reported for an immediate child directory can trigger a refresh.

The browser retains loaded rows during automatic refresh, including an empty listing. It waits for an active listing request, combines notifications into one pending refresh, and starts at most one automatic refresh per second. Navigation and pane disposal cancel queued refreshes.

`directory_changed` requests a new listing; it is not a file-difference protocol. See [File Browser and Navigation Model](../../frontend-architecture/file-browser-and-navigation-model/) for browser state and request handling.

### Resource Ownership

A monitor acquires its connection, session, tree, directory handle, and `FileSystemWatcher` in that order. Cleanup runs in reverse order, including after partial initialization.

Cancellation during startup retains the pending worker. When startup finishes, cleanup releases only the subscription acquired by that worker, not a replacement subscription. Shutdown rejects new monitor startup.

Transient failures use capped exponential reconnect backoff with jitter. Recovery continues after fast retries are exhausted, while the subscription remains active. Deletion of the watched directory stops its monitor. A stopped monitor is not reused for new subscribers. Shutdown calls `shutdown_monitor()`; a worker that is still running retains its handles until it exits.

## Directory-Index Consistency

The backend and companion maintain SQLite directory indexes through shared background managers, not per-request tree walks. Cold queries return status while initialization proceeds. Committed initial batches are searchable with partial coverage; result limits do not limit indexed coverage or exact match counts.

The index watcher observes directory-name changes recursively from the share root or configured prefix. Events drive parent reconciliation. Periodic full verification covers missed notifications; it must not become a full rescan on every navigation or query.

### Generations and Observation Order

Full verification builds a candidate while accepted data remains searchable. Only an issue-free full pass advances `last_verified_at_ms`; incremental changes and queries do not.

Read tokens and observation barriers reject stale results. Lost events or queue overflow mark coverage uncertain and request verification without deleting accepted data. Candidate selection requires a valid root and no outstanding observations or reads that could invalidate the pass.

Directory rows, FTS entries, counts, issues, queued subtree work, and revision updates must remain transactionally consistent. Queries read results and metadata from one selected-generation transaction.

### Parent Reconciliation

Background workers reconcile affected parents between full passes. Renames check both parents, and new directories trigger descendant reads. Removal requires a confirmed absence under a held, validated parent; a listing omission or access error is not sufficient. Failed work remains pending. Reconciliation does not establish full verification or clear uncertain coverage.

File operations queue parent hints before dispatch and after actual worker completion, including failure. New mutation paths must preserve this rule. Cancellation must not release worker ownership early or change the original operation result when hint delivery fails.

### Source Identity and Traversal

Catalogue names are SHA-256 hashes of source boundary settings. SMB uses the connection ID, host, port, share, configured folder, and username. Passwords, display names, connection edit times, and runtime session IDs do not change the file name. Local sources use the configured root path and, for fixed, removable, and unknown drives, available volume serial or file-system UUID evidence. Network and virtual drives use the root path alone. Runtime session IDs remain diagnostic values.

Reused rows are unverified until a verification pass completes. An SMB reconnect binds new handles and invalidates unfinished reads without comparing file IDs across connections. SMB server GUIDs and volume metadata are diagnostic values, not proof of storage continuity. File IDs of zero or all ones are unavailable; comparisons skip them. Session and tree IDs are compared only within one connection.

| Source | Traversal rules |
|---|---|
| SMB | Direct no-follow handles without delete sharing or automatic DFS retries; retained ancestors; connection-scoped session, tree, available file-ID, and exact native-name checks |
| Linux local drive | Retained directory descriptors, no-follow opens, exact native names, device and mount checks; kernel pseudo-filesystems and device-tree aliases excluded |
| Windows local drive | Retained no-delete ancestor handles, 128-bit file IDs, volume and native-device paths; bounded enumeration and strict UTF-16 decoding |

The SMB boundary is logical: the configured share and folder. Storage mounted inside a share can be indexed; SMB does not promise physical-volume containment. DFS shares, redirected ancestry, and reparse descendants remain excluded. Local traversal does not cross mounts. Windows junctions, name-surrogate redirections, cloud placeholders, and unknown reparse tags are excluded rather than followed. Missing optional volume metadata does not weaken these traversal checks.

The drive browser and local index share one classifier. USB, SD, MMC, and hot-plug disks are removable even when Windows reports a fixed drive. Failed classification uses the unknown class. Fixed drives select another index only when available volume serial or UUID evidence changes. Removable and unknown drives also retire the current generation when available label, file-system type, or total-capacity evidence changes. Missing evidence and drive-class changes alone do not replace data. Windows uses the 64-bit serial from `FILE_ID_INFO`, including zero. Local file IDs are session-scoped checks, not replacement signals.

Volume evidence is checked again when the root binds. An unmounted Linux source stays unavailable instead of indexing its mount-point folder. Linux mount checks use descriptor-bound `statx` mount IDs with `/proc/self/fdinfo` as a fallback. A missing mount-boundary capability stops that source until Companion restarts. Idle removable sources without active work or a watcher release their root handles. Windows removal notifications pause source work and release handles before removal is allowed.

Depth and path-length bounds are defined in `shared/directory-index/contract.json`. Excluded descendants produce partial coverage while readable branches continue.

Backend initialization withholds rows until a handle-bound root probe succeeds. Root failure returns HTTP 503 without deleting accepted data. Descendant access denial produces partial coverage instead. Late results cannot restore an invalidated source.

### SQLite Storage

| Runtime | Location and driver |
|---|---|
| Backend | `data/directory_cache/sqlite/`, or `sqlite/` below `directory_cache_location`; standard Python `sqlite3` with Debian system SQLite |
| Companion | `directory-index/sqlite/` in the OS-user cache directory; bundled Rust SQLite binding |

Indexes are disposable directory data, separate from recent history. Stored source metadata excludes passwords. `shared/directory-index/` owns the schema, search normalization, validation rules, and contract fixtures.

Both stores use WAL and `synchronous=FULL`. Writes, checkpoints, maintenance, and close are serialized through the writer. Queries use read-only connections and explicit transactions. Storage leases remain held until admitted readers and workers finish; active database families cannot be evicted.

Storage must be private and local. Opens and cleanup validate directory ownership, file identity, and aliases. Do not write to managed databases externally or weaken these checks to permit a path-only fallback.

### Resource Controls

Worker counts, batches, and observation queues are bounded by the shared contract. Disk growth requires headroom and free-space admission. Maintenance yields to active work.

Automatic full passes have a minimum spacing of 30 seconds, defined in the shared contract. Requests cannot bypass this limit or failure backoff. Interrupted issue-free candidates retain completed directory work. After an observation gap, retained directory reads are revalidated in bounded batches before candidate acceptance. Parent reconciliation does not start a new full pass or advance the full-verification clock.

Policy defaults and ranges belong to `shared/directory-index/contract.json`. A lower budget may pause growth but must not trim active data. Eviction applies only to inactive, unowned indexes. Disk and cache settings are not hard filesystem or process-memory ceilings.

See [Directory-Index Policy Delivery](../../companion-architecture/local-drive-and-save-back-pipeline/#directory-index-policy-delivery) for Companion ownership and [Manage Directory Search](../../../admin-guide/operations-and-maintenance/manage-directory-search/) for administration.

### Recovery and Shutdown

Startup validates source identity and application consistency before exposing rows. Damaged search tokens rebuild from validated directory rows. Replacement is restricted to recognized invalid index data; permission, capacity, busy-storage, and general I/O failures must not trigger discard.

Failures use bounded retries. Requests must not bypass retry deadlines. Idle sources release resources and revalidate the root on reuse. Shutdown waits for admitted work before closing storage and root ownership, even when a request has been cancelled.

Index recovery does not reset a shared SMB connection or remove recent-directory history. A source binding mismatch pauses publication, re-binds source handles, and schedules verification. Source and storage failures are not evidence that a directory was deleted.

SMB setup runs outside the shared pool lock. Concurrent requests share setup for the same private cache. The pool bounds admitted work, setup tasks, and retained connection generations, both per source and across the process. A retired generation keeps its own cache until its workers and cleanup finish; replacement requests use a separate cache. Capacity failures return retry information rather than enter an unbounded queue. Shutdown stops new admission. Writes are not replayed automatically.

A caller timeout or cancellation does not itself stop a blocking SMB operation. Reader handles, connection leases, and worker permits remain owned until actual completion. Late successful opens are closed before their leases are released.

An operation deadline retires its connection generation and requests one pool-owned transport abort through public `Connection.disconnect(close=False)`. The abort runs outside the event loop and pool lock, uses a snapshot of that generation's connections, and does not send session logoff requests or touch replacement connections. Ordinary caller cancellation retains work without aborting unrelated operations on the shared generation. Long-lived watcher subscriptions use their own lifecycle, not ordinary operation deadlines.

Public abort wakes blocked receive requests in the installed client. It cannot provide a universal operation deadline: disconnect shares a lock with socket send and can remain blocked behind a send. Abort work retains capacity until it exits. If workers cannot finish, admission remains bounded and requests return capacity errors. Wait before retrying; restart the backend service if retained work continues to occupy capacity.

A mutation interrupted by abort, or whose caller deadline expires after dispatch, has uncertain completion. The API reports `smb_mutation_uncertain` with `mutation_uncertain: true` and `recoverable: false`. Check the source before retrying; the change may already be applied. Sambee does not replay the write automatically.

Backend and Companion watcher startup and native event failures trigger background recovery independently of index storage initialization. A successful scan does not clear an unavailable-watcher warning. Degraded verification remains active while monitoring is unavailable; recovered monitoring requires verification of the event gap.

Recovery diagnostics use opaque source and lifecycle-generation IDs. Failure transitions record one sanitized cause; repeated failures use bounded summaries. Recovery logs omit private exception text and paths; third-party SMB payloads are not rendered. Scan summaries include duration even when a scan fails.

### Quick-Bar Status Contract

Work state, snapshot coverage, verification time, and monitoring health are separate. `monitoring_state` is `starting`, `healthy`, `recovering`, or `unavailable`. `retry_after_ms` is a relative delay from response receipt, not a timestamp. Missing or null fields mean that the server supplies no monitoring state or retry delay; they do not prove healthy monitoring.

| Response or condition | Quick-bar behavior |
|---|---|
| Building or updating, without a retry delay | Show active work and check status again |
| Paused work with a retry delay | Show the status message without an active-work spinner; wait before checking |
| Empty data, uncertain coverage, or unavailable monitoring | Keep history available and continue bounded status checks |
| Recoverable request failure | Keep accepted results for the same query, show failure, and retry |
| Terminal or unsupported request failure | Stop automatic retries until reactivation or a source change |
| Ready, healthy data without a warning | Stop periodic status checks |
| Closed menu or hidden page | Stop periodic checks; reject stale responses when the query or source changes |

Status checks do not require a minimum search length. Empty-query activation initializes status and history. The directory provider limits retry delays to 1-60 seconds and uses a five-second fallback. Structured errors use `recoverable` and `retry_after_ms`; the client does not infer recovery rules from message text. Older responses without the shared search contract do not enable periodic status checks. Requests are bound to the current source, history client, storage capability revision, and request sequence. A replaced binding cannot publish old results, status, or retry timing.

### Support Limits

Companion directory indexing supports Linux and Windows, not macOS. Drive visibility alone does not establish index support. Changes to native traversal or recovery require tests on the affected platform; cross-compilation does not validate runtime behavior.

## Where to Continue

- [Request Flow and Service Boundaries](../request-flow-and-service-boundaries/): backend service ownership
- [File Operations and Edit Locking](../file-operations-and-edit-locking/): uploads, moves, renames, and edit sessions
- [Local-Drive and Save-Back Pipeline](../../companion-architecture/local-drive-and-save-back-pipeline/): companion file operations
- [Logging and Localization](../../cross-cutting-systems/logging-and-localization/#directory-search-diagnostics): directory-search diagnostics and privacy rules
- [Test Strategy Overview](../../testing-and-quality-gates/test-strategy-overview/): test scope and repository gates

## Validation Expectations

Select focused watcher, cache, storage, directory API, and SMB operation tests for the changed boundary. Verify source binding, partial failures, lost events, stale-read rejection, exact counts, and retained ownership through cancellation. For example:

```bash
cd backend
.venv/bin/python -m pytest tests/test_directory_cache.py tests/test_directory_index_contract.py tests/test_directory_search.py tests/test_smb_backend.py
.venv/bin/python -m mypy app
```

For companion index changes, run the relevant Rust manager, storage, traversal, and handler tests. Add frontend checks when refresh, status, selection, or progressive result behavior changes.
