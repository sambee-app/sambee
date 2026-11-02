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

Connection, socket, and timeout failures use capped exponential reconnect backoff with jitter. Deletion of the watched directory stops its monitor. Shutdown calls `shutdown_monitor()` to release watchers and SMB handles explicitly.

## Directory-Index Consistency

The backend and companion maintain SQLite directory indexes through shared background managers, not per-request tree walks. Cold queries return status while initialization proceeds. Committed initial batches are searchable with partial coverage; result limits do not limit indexed coverage or exact match counts.

The index watcher observes directory-name changes recursively from the share root or configured prefix. Events drive parent reconciliation. Periodic full verification covers missed notifications; it must not become a full rescan on every navigation or query.

### Generations and Observation Order

Full verification builds a candidate while the accepted generation remains selected. An interrupted initial build is verified through a fresh candidate. Only an issue-free full pass advances `last_verified_at_ms`; incremental changes, writes, and query access do not.

Each source read has a producer token, scan epoch, and observation sequence. Changed-prefix barriers reject overlapping stale reads before child writes or parent completion. Lost events and queue overflow invalidate the epoch, retain admitted work, and request verification. Event loss marks accepted coverage uncertain without deleting its rows. Failed SQL mutations remain queued.

Candidate selection occurs under the coordinator lock after root revalidation. It requires a live baseline, the same epoch, no pending observations or uncertainty write, no other current-epoch producer, and no unfinished accepted or candidate parents. A later event remains queued for the selected generation.

Directory rows, FTS entries, counts, issues, queued subtree work, and revision updates must remain transactionally consistent. Queries read results and metadata from one selected-generation transaction.

### Parent Reconciliation

Background workers reconcile affected parents between full passes. Additions and moved-in directories queue descendant reads; removals retire missing subtrees. Both rename parents are reconciled without requiring paired events. New-name hints do not insert an assumed directory, so a regular file cannot enter the index through a transfer notification.

Reconciliation uses the same source identity, read-token, scan-admission, and bounded-write checks as full scans. Exact missing-child checks use a held, revalidated parent and the original native name. A listing omission, access error, redirected child, or failed cleanup is not proof of absence. Failed work remains pending. Reconciliation does not advance full-verification time or clear uncertainty and the verification request.

Application mutation guards queue parent hints before dispatch and after the synchronous operation actually exits, including failure. They validate the active source binding and preserve the original operation result if hint delivery fails. Recursive SMB copy and deletion guard each child operation. Companion guards cover directory creation, rename, empty and recursive deletion, upload and file-transfer parent creation, and direct or relayed archive extraction.

Parent creation queues checks for each source-relative ancestor. Retained archive workers bind these checks to the destination root, including resumed cross-drive extraction. Recursive deletion pages indexed subtree paths from active generations to queue affected parents without changing native deletion behavior. Queue refusal preserves accepted rows and requires verification. A missing hinted descendant queues an ancestor check; it is not proof of absence and does not start failure backoff.

Cancellation or timeout cannot send a completion hint or release a producer early. Cooperative stale-read interruption leaves existing failure backoff unchanged so queued reconciliation can resume on the next maintenance tick.

### Source Identity and Traversal

Catalogue names are session-bound. A changed source or credential binding stops the old source; retained rows must never be exposed as data from a replacement root. Cross-session catalogue reuse is disabled because durable root identity is not established.

| Source | Traversal rules |
|---|---|
| SMB | Direct no-follow handles without delete sharing or automatic DFS retries; retained ancestors; server, session, tree, volume, file ID, and native-name validation |
| Linux local drive | Retained directory descriptors, no-follow opens, exact native names, device and mount checks; kernel pseudo-filesystems and device-tree aliases excluded |
| Windows local drive | Retained no-delete ancestor handles, 128-bit file IDs, volume and native-device paths; bounded enumeration and strict UTF-16 decoding |

SMB DFS shares, unverified identities, changed ancestry, and volume crossings are refused. Reparse descendants and unsupported directory names produce coverage issues. Windows junctions, name-surrogate redirections, cloud placeholders, and unknown reparse tags are excluded rather than followed. Unsupported identity APIs must not trigger a path-only fallback.

Backend initialization withholds rows until a handle-bound root probe succeeds. Root identity, metadata, transport, or pool-entry failure makes the source unavailable without deleting accepted data; the directory API returns HTTP 503. Descendant access denial remains a separate partial-coverage condition. Late results cannot restore a stopped or invalidated binding.

### SQLite Storage

| Runtime | Location and driver |
|---|---|
| Backend | `data/directory_cache/sqlite/`, or `sqlite/` below `directory_cache_location`; standard Python `sqlite3` with Debian system SQLite |
| Companion | `directory-index/sqlite/` in the OS-user cache directory; bundled Rust SQLite binding |

Stored source metadata excludes passwords. Indexes are disposable directory data, separate from recent history. SQLite sources do not import legacy JSONL snapshots or export full-index mirrors.

The backend has no RAM catalogue or JSONL reader/writer fallback. Each cleanup pass can remove at most 64 recognized legacy snapshots, backups, or expired temporary files from the configured cache root. Recent temporary files remain until the inactive-retention interval expires. Cleanup skips unknown names, links, foreign-owned entries, and shared writable roots; these skipped files can still consume disk space.

Older binaries use separate snapshot names and cannot update SQLite catalogues. Stop the backend before switching binaries. A rollback rebuilds its disposable index when its snapshot is absent; it does not downgrade or import the SQLite database. Recent-file and recent-directory history remain separate and unchanged.

`shared/directory-index/` owns the schema, FTS definition, generation validation, and search fixtures. `unicode.json` supplies shared normalization and word-character data for Rust and TypeScript; Python checks it against its interpreter's Unicode data. Runtime validation requires serialized threading, STRICT tables, RETURNING, and FTS5 with the specified trigram settings. The backend requires SQLite 3.37 or later; the companion requires 3.51.3 or later.

Both stores use WAL and `synchronous=FULL`. Active writes, checkpoints, maintenance, and close are serialized through the writer. Queries use strictly read-only connections and explicit transactions; they must never checkpoint or write. Close retains process ownership until admitted readers and workers finish. External writes to active managed indexes are unsupported. Preserve this ownership model when changing checkpoint behavior; see SQLite's [WAL reset-race documentation](https://www.sqlite.org/wal.html#walresetbug).

Storage must be private and local. Backend ancestors must be real directories owned by the service account or root; group/public write access requires a trusted sticky parent. The namespace must be service-owned with mode 0700. Unix checks reject hard-linked database, sidecar, and lease files. Namespace leases serialize source-lease creation and orphan cleanup; active or externally owned database families cannot be evicted.

### Resource Controls

| Control | Rule |
|---|---|
| Worker admission | One shared scan permit and two query permits per manager |
| Scan and bulk-write batches | Bounded by both row count and input path bytes before row-key construction |
| Child paging | Ordered index scan with a row- and byte-bounded sorted buffer, including branches without ancestor rows |
| Observations | Entry- and byte-bounded pending queues and changed-prefix barriers |
| Disk growth | Shared write-headroom reservation and filesystem free-space check before growth |
| Maintenance | Bounded retired-row cleanup and incremental vacuum; pending updates, scans, queries, and pinned readers take priority |

Policy ranges and defaults belong to `shared/directory-index/contract.json`, not duplicated runtime settings. Lowering a disk budget may pause growth but must not trim active accepted rows. Retention and disk-pressure eviction apply only to inactive, unowned catalogues. Query access is recorded separately from writes and verification.

Normal WAL handling checks a 1 MiB threshold outside the async executor. Below it, no checkpoint SQL or maintenance reservation is requested. Due checkpoints use shared headroom, defer for active work or pinned readers, and retry when readers release their snapshots. Disk-pressure reclamation is coalesced per source; it is not periodic idle work.

Disk admission is not a hard physical allocation ceiling. Complete SQL temporary-storage accounting, operation headroom, and application peak-resource limits are not established by these controls.

### Recovery and Shutdown

Startup validates application and source identities, schema, directory rows, generation counts, and issues before publishing a reader. SQLite integrity checks alone do not establish application consistency.

Missing or inconsistent FTS data uses complete literal scans of validated rows while tokens rebuild in bounded background batches. Mutations wait; observations remain queued. Repair preserves counts, revisions, and verification time. Token-reset failure must not authorize replacement of valid directory rows.

Background replacement is limited to recognized application-schema or policy incompatibility, invalid core metadata, failed integrity or generation checks, and SQLite corruption or invalid-database errors. Wrong application/source identity, busy storage, FULL, general I/O errors, and permission failures do not authorize discard. Replacement retains the source lease and requires operation headroom. Fresh data starts empty with partial coverage and no complete-verification time.

Each namespace has one rejected family, `.rejected-directory-index`, including sidecars and a separate lease. Pressure cleanup may remove it only when unowned. Ordinary move failures attempt to restore moved members and preserve the primary error. A failed replacement cannot cause a repeated discard loop on the same source. Restore capacity and permissions before reconnecting after a storage failure; family moves are not guaranteed crash-atomic.

Initialization and verification failures use bounded retries with source-specific jitter. Existing accepted rows remain usable only while the source is available. Healthy and degraded verification intervals are separate from failure backoff; repeated requests must not bypass a retry deadline.

Idle sources release readers, writers, root handles, and watchers after ten minutes without active ownership. Cancellation does not release a still-running worker's SMB pool lease, producer, or process lease. Source replacement need not wait for that old worker, but its results must be rejected. Backend shutdown calls `shutdown_directory_cache()` and waits for admitted work before closing storage and root ownership.

### Resource Policy Ownership

Backend and companion policies have separate host scopes. Backend settings apply to live sources. Companion delivery requires administrator authority, a native challenge, and local approval of one backend owner. The browser carries only an opaque single-use grant; the companion redeems it directly over verified HTTPS, or HTTP to a literal loopback host, without redirects. Failed delivery preserves the last approved policy.

Native policy changes serialize against source initialization. Persistence failure restores prior runtime targets; failed recovery blocks further delivery with a specific error. Native Preferences provides a confirmed owner reset. Companion mutation APIs must protect the configuration and SQLite directories, including their ancestors and filesystem aliases.

### Support Limits

The new directory-index search capability remains disabled. Storage and traversal replacement races, full mutation coverage, live SMB root/mount and idle/sleep recovery, complete resource accounting, interrupted recovery, and policy transport/persistence require further qualification before activation.

Linux native behavior and Windows cross-compilation are different kinds of evidence. Cross-compilation does not establish Windows handle, filesystem-alias, mapped-volume, provider, or recovery behavior. macOS directory indexing is unavailable. Generated storage fixtures do not establish native traversal speed, application memory use, or production latency.

### Progressive Quick-Bar Results

Quick-bar consumers must distinguish partial or uncertain coverage, source unavailability, and query failure. Usable history and loaded-file results remain available while slower index work completes. Index results carry exact counts and coverage metadata; the returned-result cap does not imply incomplete indexing.

Providers publish selectable records before result rows and reject obsolete query/source responses. Quiet index refresh requires an explicit compatible search capability; it must not poll legacy full-scan endpoints. Typing, dismissal, source changes, hidden tabs, and terminal failures stop obsolete refresh work. See [File Browser and Navigation Model](../../frontend-architecture/file-browser-and-navigation-model/) for presentation and selection behavior.

Companion browse-request completion logs contain the method, an allow-listed route template, HTTP status, monotonic duration, cancellation flag, and an optional validated revision. Unknown routes use a fixed placeholder. These debug records exclude request URLs, drive identities, terms, paths, headers, bodies, error text, grants, and signed values. Pairing-start logs contain no pairing identities, nonces, or displayed codes.

## Where to Continue

- [Request Flow and Service Boundaries](../request-flow-and-service-boundaries/): backend service ownership
- [File Operations and Edit Locking](../file-operations-and-edit-locking/): uploads, moves, renames, and edit sessions
- [Local-Drive and Save-Back Pipeline](../../companion-architecture/local-drive-and-save-back-pipeline/): companion file operations
- [Test Strategy Overview](../../testing-and-quality-gates/test-strategy-overview/): test scope and repository gates

## Validation Expectations

Select focused watcher, cache, storage, directory API, and SMB operation tests for the changed boundary. Verify source binding, partial failures, lost events, stale-read rejection, exact counts, and retained ownership through cancellation. For example:

```bash
cd backend
.venv/bin/python -m pytest tests/test_directory_cache.py tests/test_directory_index_contract.py tests/test_directory_search.py tests/test_smb_backend.py
.venv/bin/python -m mypy app
```

For companion index changes, run the relevant Rust manager, storage, traversal, and handler tests. Add frontend checks when refresh, status, selection, or progressive result behavior changes.
