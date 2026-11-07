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

Full verification updates the selected generation in place while retained data remains searchable. Interrupted first builds and active verification passes keep their rows, pass identity, and queued parents, including item issues and storage reopens. A completed full pass advances `last_verified_at_ms` even with item issues; incremental changes and queries do not. Each index retains one generation, with `building` for an initial build and `accepted` after completion.

Non-root access failures, unsafe traversal, invalid names, and other item read errors do not stop a pass. The scanner skips an invalid name or completes a failed parent, then continues with readable siblings. A failed parent retains stored descendants, including batches already published during the current read. Acceptance retains the issue count and sets partial coverage. It clears the verification request and uses the regular verification interval, not a special item retry. Event loss still blocks acceptance and keeps coverage uncertain. Root, transport, authentication, resource-limit, and storage failures retain their retry and recovery rules.

Read tokens and observation barriers reject stale results. Observed directory changes update the index and request verification, but they do not change coverage. Lost events or pending-observation queue overflow mark coverage uncertain and request verification without deleting retained data. Pass acceptance requires a valid root and no outstanding observations or reads that could invalidate the pass.

Directory rows, FTS entries, counts, issues, queued subtree work, and revision updates must remain transactionally consistent. Queries read results and metadata from one selected-generation transaction.

### SMB Watcher Startup

Backend initialization waits up to 10 seconds for the first watcher attempt before it probes the source root or scans directories. Success means that the first `CHANGE_NOTIFY` request has been sent and startup invalidation has completed, not just that the thread or connection has started. The wait is asynchronous and holds no scan slot, worker, coordinator lock, or generation lock.

A connection failure, notification-start failure, or timeout permits fallback verification. Watcher retries continue in the background. A failed first attempt reports unavailable monitoring, not lost observations before monitoring started. The first-attempt result is separate from current monitoring readiness. Cancellation and shutdown remove the waiter and prevent a later scan from starting.

If the watcher first becomes ready during fallback verification, it changes the epoch. Pre-monitoring reads cannot commit. Verification resumes after the bounded observation retry; a valid root probe keeps retained results searchable. Normal successful startup captures its scan epoch after watcher setup and needs no startup retry.

### SMB Barriers and Local Retries

The backend captures an epoch for each full pass without registering a pass-wide reader. A directory read depends on that directory, its direct children, and its ancestors. A barrier on a deeper descendant does not reject the ancestor listing. A root barrier rejects all content reads. Source-root availability probes check epoch and reader ownership, not directory-content barriers.

Observations update the selected generation before their barriers retire. Barriers remain only while pending observations or older live parent reads need them. When retained barriers exceed their count or byte bound, they collapse to one current root barrier. Live content reads become stale, but the epoch does not change and pending hints remain available.

A stale parent stays pending and moves to the queue tail in one transaction. Published child batches remain; deferral clears their staged snapshot names. The next read re-enumerates the parent and starts a fresh snapshot. Local stale reads, final-capture refusals, and transient parent errors do not invalidate unrelated completed work. Observation loss and exhausted read capacity cause bounded revalidation of retained completed parents. Other epoch changes do not restart completed parents.

The periodic loop checks due verification before incremental reconciliation. A full pass owns the selected generation's scan queue; separate reconciliation does not run during that pass. Completed buffered ancestors commit before descendants are selected, so deleted rows and refreshed FileIds take effect first. Stale reads use the one-second observation retry; source-wide failures keep the failure backoff. Quiet branches can progress, but a full pass cannot be guaranteed to finish while relevant directories keep changing.

Large reads store early snapshot names in `scan_snapshot_children`, owned by the pending parent queue row. This keeps memory bounded without separate per-child absence requests. The final diff considers both staged names and the final child batch. Direct-child changes still reject the read before parent completion. Failed parent reads preserve stored children instead of applying an incomplete deletion diff.

### Parent Reconciliation

Background workers reconcile affected parents between full passes. Renames check both parents, and new directories trigger descendant reads. A completed listing under a held, validated parent drives the atomic child diff; an incomplete listing or access error cannot delete missing children. Streamed reads use the same disk-backed snapshot names as full passes. An item error records partial coverage, completes the parent, and retains its stored subtree. Source-wide failures and stale observations leave work pending. Reconciliation does not establish full verification or clear uncertain coverage.

File operations queue parent hints before dispatch and after actual worker completion, including failure. New mutation paths must preserve this rule. Cancellation must not release worker ownership early or change the original operation result when hint delivery fails.

### Source Identity and Traversal

Catalogue names are SHA-256 hashes of source boundary settings. SMB uses the connection ID, host, port, share, configured folder, and username. Passwords, display names, connection edit times, and runtime session IDs do not change the file name. Local sources use the configured root path and, for fixed, removable, and unknown drives, available volume serial or file-system UUID evidence. Network and virtual drives use the root path alone. Runtime session IDs remain diagnostic values.

Reused rows are unverified until a verification pass completes. An SMB reconnect binds new handles and invalidates unfinished reads. Queued child FileIds are expected read identities, not proof of storage continuity. SMB server GUIDs and volume metadata are diagnostic values. File IDs of zero or all ones are unavailable and are not queued as expected identities. Session and tree IDs are compared only within one connection.

| Source | Traversal rules |
|---|---|
| SMB | No automatic DFS or symlink retries on compound reads; no-delete root handles; observed direct-parent reads only with healthy monitoring and a queued FileId; retained ancestors for safe fallback; connection-scoped session, tree, file-ID, and bound native-path checks |
| Linux local drive | Retained directory descriptors, `openat2` with no-link, no-mount, and beneath-root resolution; component-by-component fallback when the syscall is unavailable; exact names and mount checks; kernel pseudo-filesystems and device-tree aliases excluded |
| Windows local drive | No-delete bound-root handles, delete-sharing full-pass parent handles, 128-bit file IDs, volume and native-device paths; bounded enumeration and strict UTF-16 decoding |

The SMB boundary is logical: the configured share and folder. A configured subfolder is not an access-control boundary; the connection credentials can access the share. Storage mounted inside a share can be indexed; SMB does not promise physical-volume containment. DFS shares and reported reparse descendants remain excluded. Local traversal does not cross mounts. Windows junctions, name-surrogate redirections, cloud placeholders, and unknown reparse tags are excluded rather than followed. Missing optional volume metadata does not weaken these traversal checks.

Descendant symbolic links and reparse entries are silent exclusions. They produce no item issues, status-detail records, or partial-coverage state. Complete coverage refers to eligible directories within the source boundary. Bound-root checks and opened-parent identity, path, and redirect validation remain strict; a failed safety check is not an exclusion. Missing and non-directory native parents are read failures, not evidence of unsafe traversal. A new verification replaces previous exclusion-derived issue counts without clearing unrelated failures.

SMB full passes check the bound root at the start and end. Between these checks, a known parent can use a direct no-follow open without an ancestor chain only while the recursive folder-change watcher is ready and the epoch has no observation-loss or read-capacity invalidation. The opened FileId must match the queue, the handle must not report a reparse point, and the requested native path, session, and tree must match the binding. Root and reconciliation reads, missing-parent recovery, and exact child checks retain the safe ancestor chain. Parents without a queued FileId also use the safe path.

Observation protects index correctness on the direct path. An ancestor event rejects affected reads before publication. Tokens remain live until grouped commits and check watcher readiness again at commit. A late event corrects already committed rows through the normal mutation path; the index is eventually consistent with the watcher delay. If monitoring is lost during a pass, active observed reads are deferred and the pass continues with safe reads. Observation loss requeues completed parents for revalidation, while coverage can remain uncertain. Root and non-compound scan handles retain no-delete sharing.

During a full pass, safe reads reuse the pinned share and configured-root handles. Between full probes, local checks require connected handles, a non-DFS tree, the same connection object and server GUID, and unchanged session and tree IDs. Descendant ancestor chains and target FileAll identity checks remain. Closing a parent read does not close the root handles. A source-read failure requests a full root probe before a later read; versioned requests preserve failures that occur during a probe. Standalone reconciliation retains full root checks rather than relying on full-pass boundaries.

Safe reads reuse cached `FsVolume` metadata across handles on the same live tree. The cache matches the tree and connection objects plus the session and tree IDs. A changed binding requires a new volume query. Unsupported optional volume information is cached for that binding; permission and transport failures are not cached. This cache does not replace root or parent verification.

### SMB Compound Reads

The observed reader sends one related compound: `CREATE`, `QUERY_INFO(FileInternalInformation)`, two `QUERY_DIRECTORY` requests, and `CLOSE`. The first directory query restarts enumeration; the second continues it. End-of-directory responses complete a small or empty directory in one round trip. If both queries return data, the reader discards those partial results and opens the parent again through the existing enumeration loop.

Each query buffer is bounded by the negotiated transaction size, the shared 1 MiB maximum, and available credits. A connection without multi-credit support uses at most 64 KiB. Full scans send up to `scan_pipeline_depth` compounds before receiving the oldest result. The shared default is eight parents. All reads use one worker and the root's retained connection; reused session and tree IDs cannot admit a replacement transport.

Before each pipeline send, the reader checks the credit window under the connection lock and leaves `scan_credit_reserve` credits, with a shared default of 16. Scan requests ask for credit growth until the window can support the configured depth. If a compound cannot fit, the worker receives the oldest outstanding parent first. With no outstanding reads, it can send one bounded credit-growth echo per queue page, including when the window starts at one credit. If the server does not grant enough credits, the reader uses the existing loop instead.

The pool creates a `ScanCreditConnection` before transport setup and lets `smbclient` register its session with the configured authentication and encryption policy. Its reentrant sequence lock covers the full scan credit check and compound send. Ordinary browse sends use the same lock, so they cannot consume credits between the scan check and the library's per-message allocations. The check uses the library's negotiated credit charges, with a minimum of one credit per message. If the full compound and reserve do not fit, admission changes no sequence numbers or outstanding requests. The lock is released before receiving responses.

Connections without this atomic-admission method use the existing loop instead of an unprotected pipeline send. A failed compound send still retires and aborts that connection generation rather than reusing uncertain request state.

The loop also adapts its query buffer before each request. It uses the negotiated transaction size and the shared 1 MiB maximum, then limits the size to the current credit budget. It leaves the browse reserve where possible, but retains a one-credit query when the window is small. Connections without multi-credit support use at most 64 KiB. These size estimates do not add atomic admission to loop reads; the whole-compound lock applies to pipeline sends.

Compound handles allow read, write, and delete sharing because they open and close within the same request group. The reader disables client-side symlink retries and drains responses after a parent error. Each in-flight read has a deadline measured from submission. A timeout, including during cleanup after watcher loss, defers unfinished parents and retires the connection generation through the pool's abort path. A mutation barrier on one parent defers only that parent; unrelated valid results remain eligible for grouped commit in queue order. Watcher loss defers all outstanding observed reads before the pass continues with safe traversal.

FileId mismatches, reparse attributes, malformed responses, and listings that make no progress cannot publish children. Missing-path and access-denied responses retain their existing cache error handling. Buffered results still check observation and local root binding during enumeration and before commit. Exact child checks reopen the safe retained-ancestor reader.

The drive browser and local index share one classifier. USB, SD, MMC, and hot-plug disks are removable even when Windows reports a fixed drive. Failed classification uses the unknown class. Fixed drives select another index only when available volume serial or UUID evidence changes. Removable and unknown drives also replace the current generation when available label, file-system type, or total-capacity evidence changes. Generation replacement selects the new generation and deletes the old one in one transaction. Unchanged volume evidence does not rewrite source metadata. Missing evidence and drive-class changes alone do not replace data. Windows uses the 64-bit serial from `FILE_ID_INFO`, including zero. Local file IDs are session-scoped checks, not replacement signals.

Volume evidence is checked again when the root binds. An unmounted Linux source stays unavailable instead of indexing its mount-point folder. Linux mount checks use descriptor-bound `statx` mount IDs with `/proc/self/fdinfo` as a fallback. A missing mount-boundary capability stops that source until Companion restarts. Idle removable sources without active work or a watcher release their root handles. Windows removal notifications pause source work and release handles before removal is allowed.

Depth and path-length bounds are defined in `shared/directory-index/contract.json`. Excluded descendants produce partial coverage while readable branches continue.

Linux enumeration uses `d_type` to skip regular files without a metadata call. Unknown entry types use a no-follow metadata check. A no-follow `statx` checks each directory child's inode and mount without opening the child. Missing statx fields use the descriptor fallback. Windows enumeration uses a 1 MiB buffer and validates names, attributes, reparse tags, and full 128-bit FileIds from directory records without opening each child.

A native scan uses one `NativeParent` read through enumeration, batch validation, issue handling, and parent completion. It checks the queued identity before processing children and keeps the observation token checks before writes. Linux retains the parent descriptor and gives `fdopendir` a duplicate, so enumeration cannot close the original. Descriptor checks reject a deleted parent without reopening its path. If the watcher is missing, failed, or not yet ready, Linux also checks the root-relative parent identity before each child batch and final parent completion, including parallel full-pass and reconciliation reads. A healthy watcher adds no parent opens at these boundaries. Windows full-pass reads use FileId opens, relative no-reparse opens, or the checked ancestor fallback. Non-root scan handles permit read, write, and delete sharing. The bound root and strict standalone reads keep no-delete sharing. Identity and native-path checks reject a moved parent before publication. Missing-parent recovery uses exact child lookups under the retained parent.

Full passes read independent parents with at most four native worker threads, defined by `scan_read_parallelism`. A bounded channel sends child batches, issues, and completion to the scan thread; workers never write the index. Each read retains its handle and observation token until publication or discard. Queued ancestors finish and commit before their descendants start, so changed FileIds reach later reads. Cancellation and storage failure stop new jobs, drain ownership, and join all workers.

Backend initialization withholds rows until a handle-bound root probe succeeds. Root failure returns HTTP 503 without deleting accepted data. Descendant access denial produces partial coverage instead. Late results cannot restore an invalidated source.

### SQLite Storage

| Runtime | Location and driver |
|---|---|
| Backend | `data/directory_cache/sqlite/`, or `sqlite/` below `directory_cache_location`; standard Python `sqlite3` with Debian system SQLite |
| Companion | `directory-index/sqlite/` in the OS-user cache directory; bundled Rust SQLite binding |

Indexes are disposable directory data, separate from recent history. Stored source metadata excludes passwords. `shared/directory-index/` owns the schema, search normalization, validation rules, and contract fixtures.

Schema version 5 retains nullable FileIds in `scan_queue`: eight bytes for SMB and Linux, and 16 bytes for Windows. Root and observed-parent entries can omit an identity. Child identities commit with directory rows and survive a deferred read or reopen. Full passes and reconciliation refresh existing queue rows when a parent listing supplies a different non-null identity. Reconciliation does not insert a job for an existing child that has no queue row. A change from a known identity requeues completed child work; a change from an unknown identity keeps its processed state. Unchanged identities cause no queue writes. Readers compare a queued identity before publishing children. Companion can first commit a fresh buffered parent listing to update that identity. A confirmed mismatch is an unsafe item issue.

Directory rows have a nullable `parent_id` and the `directories_parent(generation_id, parent_id)` index. Stored links must identify an immediate parent in the same generation. Deletes cascade to linked descendants, their FTS entries, and their queue rows. Adds and moves maintain parent links. Both scanners diff complete and streamed parent snapshots and finish their queue rows in one transaction without rewriting unchanged directory or FTS rows. Early batches store their names in `scan_snapshot_children`. Final completion removes absent linked subtrees, clears staged names, and completes the parent atomically. Failed parents suppress deletions. Old-schema indexes rebuild through disposable-cache recovery; recent history is not changed.

Item issue counts belong to the producer's observation token. Full passes buffer these counts until the completed parent snapshot commits; reconciliation commits them with the final parent snapshot. Early incomplete child batches retain the pending counts. A stale token discards them and leaves its parent pending. Counts aggregate by issue code in the parent transaction, so coverage, revision, directory changes, and parent completion roll back together if a write fails. Buffered issue payloads count toward the group byte bound.

Both source managers retain a process-local sample of issue codes and affected locations after successful parent commits. Each parent/reason pair retains at most one known affected path. The owning parent stays separate from the displayed path, so excluded or unreadable children need not exist in the index. Path payloads belong to the observation token, count toward group byte bounds, and are published only after the parent transaction succeeds. Stale reads discard them. The sample uses the shared `max_logged_scan_issues_per_pass` bound of 20 parent/reason pairs, removes resolved parent entries after clean reads, and resets for a new full pass. Successful delete observations and parent snapshots also remove samples for deleted subtrees; failed database writes retain the samples. It is not persisted or added to the index schema. Ordinary search responses expose `issue_details_available`; `include_issue_details=true` additionally returns `issue_details` and `issue_details_incomplete`. Optional `scope` is `directory` for a known affected path and `contents` for a containing parent whose affected child name is unavailable. Consumers must accept older details without `scope`. These details use the same source authorization as directory search. Redirect exclusions never enter the sample.

The selected generation records `scan_pass_id` and `scan_active`. A fresh verification resets its queue completion flags and starts a new pass; an interrupted active pass resumes without that reset. A completed pass keeps the selected generation ID. The clean-shutdown marker is cleared on open and set only after a clean, transaction-free close with ready search tokens. A clean reopen skips SQLite `quick_check` and the FTS integrity command when the FTS schema is intact. An unclean reopen runs both checks. Schema, foreign-key, generation, and storage-binding validation still run on every open. Reopen retains valid streamed snapshot names; the first restarted batch replaces them. Invalid names or snapshots owned by completed parents trigger disposable-cache recovery.

Both stores use WAL and `synchronous=NORMAL`. The index is a verified cache, not the source of directory data. A power failure can lose recent cache commits; interrupted or uncommitted work remains pending for verification. Writes, checkpoints, maintenance, and close are serialized through the writer. Queries use read-only connections and explicit transactions. Both runtimes reuse isolated read connections and check their storage binding before each query. Query cancellation handlers are cleared before reuse. Storage leases remain held until admitted readers and workers finish; active database families cannot be evicted.

Scan writes use bounded parent groups. Content-changing groups have a 250 ms maximum wait and a 1,000-parent cap. Bookkeeping-only groups have a 1 s maximum wait and a 20,000-parent cap. Each interval starts with the first parent, not the previous commit. Both groups commit early at the parent cap or the shared byte bound; parent names count toward that bound. Independent work pages do not force a commit. Ancestor dependencies, error transitions, and pass completion can require an earlier commit. Each completed parent keeps its observation token and barriers until commit, but no longer uses active-reader capacity. The next page excludes completed buffered parents. A stale parent remains pending; valid parents in the group can commit. Large parent reads can publish child batches before the parent is complete.

Reconciliation uses the same adaptive groups as full passes without advancing the full-verification clock. Queue paths and FileIds are read in pages, and buffered completed parents are excluded from later pages. Ancestors commit before queued descendants start. Backend reconciliation uses the page's FileIds and keeps its per-parent worker deadline. Native reconciliation uses the bounded worker scheduler but retains strict root and parent opens, rather than full-pass fast opens. Early snapshots, issue counts, stale deferral, and ownership cleanup use the reconciliation generation checks. Status snapshots refresh after group commits.

Empty-query status uses committed metadata snapshots in memory. It does not open SQLite connections or run a directory query. The optional `scan_progress` response contains the phase, completed and queued parent counts, directory count, and start timestamp. Each group commit refreshes progress. The frontend shows active build or update progress before uncertain coverage.

The `cache_state` value `opening` identifies index initialization before scanning. The quick bar hides this status but continues polling. Errors and recovery messages remain visible. Once scanning starts, build or update progress replaces the opening state. A build shows `Indexing...` until its directory count is positive; zero is not shown as a directory result.

Storage must be private and local. Opens and cleanup validate directory ownership, file identity, and aliases. Do not write to managed databases externally or weaken these checks to permit a path-only fallback.

### Resource Controls

Worker counts, batches, and observation queues are bounded by the shared contract. Disk growth requires headroom and free-space admission. Native full-pass and reconciliation groups share one disk reservation for their writes. Ordinary admission reuses its free-space sample for the final reservation check while holding the accounting lock. If cleanup runs, admission takes a fresh sample before it reserves space. Outstanding reservations remain part of both budget and physical-space checks. Maintenance yields to active work.

Automatic full passes have a minimum spacing of 30 seconds, defined in the shared contract. Requests cannot bypass this limit or failure backoff. Interrupted passes retain completed directory work and item issues. After an observation gap, retained directory reads are revalidated in bounded batches before pass acceptance. Parent reconciliation does not start a new full pass or advance the full-verification clock.

Policy defaults and ranges belong to `shared/directory-index/contract.json`. A lower budget may pause growth but must not trim active data. Eviction applies only to inactive, unowned indexes. Disk and cache settings are not hard filesystem or process-memory ceilings.

See [Directory-Index Policy Delivery](../../companion-architecture/local-drive-and-save-back-pipeline/#directory-index-policy-delivery) for Companion ownership and [Manage Directory Search](../../../admin-guide/operations-and-maintenance/manage-directory-search/) for administration.

### Recovery and Shutdown

Startup validates source identity and application consistency before exposing rows. Damaged search tokens rebuild from validated directory rows. Replacement is restricted to recognized invalid index data; permission, capacity, busy-storage, and general I/O failures must not trigger discard.

Failures use bounded retries. Requests must not bypass retry deadlines. Access updates only the last-access time; an idle gap does not invalidate observations or make a running source unavailable. Idle sources release resources only when no worker, reader, or queued scan work remains. Released sources revalidate the root on reuse. Shutdown waits for admitted work before closing storage and root ownership, even when a request has been cancelled.

For the backend, scan work waits for both the resource-failure and observation-retry gates. The scan delay is therefore the later active deadline. `retry_after_ms` reports the earlier of that scan deadline and the next watcher retry. Status requests and searches do not move these deadlines. A local stale read uses the one-second observation retry, not a new failure backoff or a new full-pass interval.

Backend and Companion epoch invalidations record a diagnostic reason: `watcher_start`, `observation_loss`, `source_rebind`, `read_capacity`, `stalled_read`, or `lifecycle`. These cover first notification setup, lost observations, source rebinding, exhausted read admission, stalled workers, and lifecycle changes. All reasons request verification. All reasons except `stalled_read` also mark coverage uncertain, because they can lose source events. A stalled read loses no events, so the next accepted pass can verify the index. Epoch and ownership checks reject stale work. The SMB observed path also stays disabled in an epoch with observation loss or exhausted read capacity, even after the queue-revalidation flag is consumed. Each invalidation logs its reason and a counter at INFO, including repeated reasons. Pass start and finish events also use INFO. Finish events include parent and directory counts, group commits, duration, and an abort reason when the pass fails.

Index recovery does not reset a shared SMB connection or remove recent-directory history. A source binding mismatch pauses publication, re-binds source handles, and schedules verification. Source and storage failures are not evidence that a directory was deleted.

SMB setup runs outside the shared pool lock. Concurrent requests share setup for the same private cache. The pool bounds admitted work, setup tasks, and retained connection generations, both per source and across the process. A retired generation keeps its own cache until its workers and cleanup finish; replacement requests use a separate cache. Capacity failures return retry information rather than enter an unbounded queue. Shutdown stops new admission. Writes are not replayed automatically.

A caller timeout or cancellation does not itself stop a blocking SMB operation. Reader handles, connection leases, and worker permits remain owned until actual completion. Late successful opens are closed before their leases are released.

An operation deadline retires its connection generation and requests one pool-owned transport abort through public `Connection.disconnect(close=False)`. The abort runs outside the event loop and pool lock, uses a snapshot of that generation's connections, and does not send session logoff requests or touch replacement connections. Ordinary caller cancellation retains work without aborting unrelated operations on the shared generation. Long-lived watcher subscriptions use their own lifecycle, not ordinary operation deadlines.

Public abort wakes blocked receive requests in the installed client. It cannot provide a universal operation deadline: disconnect shares a lock with socket send and can remain blocked behind a send. Abort work retains capacity until it exits. If workers cannot finish, admission remains bounded and requests return capacity errors. Wait before retrying; restart the backend service if retained work continues to occupy capacity.

A mutation interrupted by abort, or whose caller deadline expires after dispatch, has uncertain completion. The API reports `smb_mutation_uncertain` with `mutation_uncertain: true` and `recoverable: false`. Check the source before retrying; the change may already be applied. Sambee does not replay the write automatically.

Backend and Companion watcher startup and native event failures trigger background recovery independently of index storage initialization. A successful scan does not clear an unavailable-watcher warning. Degraded verification remains active while monitoring is unavailable; recovered monitoring requires verification of the event gap.

Backend status messages come from current conditions, in priority order: unavailable source, disk budget, storage initialization, stalled read, verification failure, update failure, observation loss, unavailable watcher, incomplete coverage, search-token rebuild, and continuous changes. Resolved conditions no longer leave old error text behind. A verification failure clears after a valid source-root check or after verification recovers. A successful read of an unrelated parent does not clear it. An update failure comes from the periodic loop and clears after a successful periodic iteration. A finished full pass clears observation loss, also when the pass has coverage issues; the coverage message then shows the remaining issue. Startup waiting, isolated local retries, and late first readiness do not themselves report source changes or observation loss. Actual watcher failures and observation gaps remain visible until their causes resolve.

Recovery diagnostics use opaque source and lifecycle-generation IDs. Failure transitions record one sanitized cause; repeated failures use bounded summaries. Recovery logs omit private exception text and paths; third-party SMB payloads are not rendered. Scan summaries include duration even when a scan fails. Backend `directory_scan_finished` and `directory_retry_scheduled` events also include `invalidation_reason` and `stale_turns`, the count of consecutive stale turns with no completed parent.

Pass logs report source-owned I/O totals as per-pass differences: `smb_round_trips` for backend request groups and `native_opens` for companion directory-open attempts. See [Directory-Search Diagnostics](../../cross-cutting-systems/logging-and-localization/#directory-search-diagnostics) for the counter definitions and limits.

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
