+++
title = "SMB Change Notification and Directory Freshness"
+++

Sambee uses separate SMB2/SMB3 `CHANGE_NOTIFY` paths for browser refreshes and directory-search indexing. Companion maintains local-drive indexes with native watchers. This page describes their consistency, traversal, and recovery rules.

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

`DirectoryMonitor` shares one `MonitoredDirectory` per `connection_id:path`. The first subscriber starts it; the last unsubscribe stops it. Disconnect releases the client's subscriptions.

WebSocket paths are user-facing. `ConnectionManager` adds `path_prefix` for native SMB access; callbacks remove it before delivery. Do not mix subscription keys with native watch paths.

| Message | Example |
|---|---|
| Subscribe | `{ "action": "subscribe", "connection_id": "uuid", "path": "/dir" }` |
| Unsubscribe | `{ "action": "unsubscribe", "connection_id": "uuid", "path": "/dir" }` |
| Change notification | `{ "type": "directory_changed", "connection_id": "uuid", "path": "/dir" }` |

### Events and Refreshes

Browser watchers observe immediate-child names, sizes, and last-write changes, not whole subtrees. Deep writes do not invalidate every ancestor, but reported metadata changes to an immediate child directory can trigger a refresh.

Automatic refresh retains loaded rows, waits for an active listing request, combines notifications, and starts at most once per second. Navigation and pane disposal cancel queued refreshes.

`directory_changed` requests a listing, not a file diff. See [File Browser and Navigation Model](../../frontend-architecture/file-browser-and-navigation-model/).

### Resource Ownership

A monitor acquires connection, session, tree, directory handle, and `FileSystemWatcher` in order, then cleans up in reverse order, including after partial initialization.

Startup cancellation retains the worker until it can release its own subscription, never a replacement subscription. Shutdown rejects new monitors and calls `shutdown_monitor()`; running workers retain handles until exit.

Transient failures use capped exponential backoff with jitter for as long as the subscription remains active. Directory deletion stops the monitor; new subscribers require a new monitor.

## Directory-Index Consistency

Shared background managers maintain SQLite indexes; requests do not walk the tree. Cold queries return initialization status. Committed initial batches are searchable with partial coverage. Result limits do not limit coverage or exact match counts.

Recursive directory-name notifications drive parent reconciliation. Full verification covers missed notifications, not each navigation or query.

### Verification Intervals

Each runtime selects intervals through one policy helper:

| Monitoring | Effective interval | Default | Allowed range |
|---|---|---|---|
| Healthy | `healthy_verification_seconds` | 24 hours | 60 seconds to 30 days |
| Degraded | `min(degraded_verification_seconds, healthy_verification_seconds)` | 30 minutes | Degraded setting: 30 seconds to 24 hours |

Intervals start at the last completed pass, with up to 10 percent jitter. Startup, observation loss, watcher startup or recovery, and SMB reconnect request verification. Minimum pass spacing and failure backoff still apply.

Linux Companion `Network` and `Virtual` sources use the degraded interval because inotify cannot report remote changes on network and FUSE file systems. This classification alone changes neither `verification_required` nor coverage or acceptance. It logs `directory_monitoring_limited` once per source session. Other Linux classes and all Windows classes use watcher health. Windows SMB uses server-side `CHANGE_NOTIFY`; unsupported redirectors use watcher-failure recovery.

A ready backend SMB watcher is treated as reliable; unreliable NAS notifications are not detected automatically. Administrators can shorten the healthy interval.

Policy accepts either interval ordering without migrating administrator values; bundled defaults must keep degraded at or below healthy. Policy shape and version are unchanged. Older Companions reject values outside their supported ranges or ordering, retain the last valid policy, and report that an update is required.

### Generations and Observation Order

Each index retains one generation: `building` initially, then `accepted`. Full verification updates it in place while committed rows remain searchable. Interrupted passes retain rows, pass identity, queued parents, and issues across reopens. Only a completed full pass advances `last_verified_at_ms`, including a pass with item issues.

Non-root item failures do not stop a pass. Invalid names are skipped; failed parents retain descendants, including published batches. Acceptance records issues as partial coverage and uses the regular verification interval, not a special item retry. Event loss blocks acceptance. Root, transport, authentication, capacity, and storage failures use source-level recovery.

Read tokens and barriers reject stale results. Normal observed changes and listing feedback queue parent reconciliation without setting `verification_required` or changing coverage. When reconciliation drains without observation loss, healthy monitoring keeps the healthy interval. Lost events or observation overflow request full verification and mark coverage uncertain without deleting rows. Stalled reads request verification without changing coverage. Startup, source rebinding, and reopening after idle release still require a full pass. Acceptance requires a valid root and no conflicting observations or reads.

Rows, FTS entries, counts, issues, queued work, and revisions commit atomically. Queries read results and metadata in one selected-generation transaction.

### SMB Watcher Startup

Initialization waits asynchronously for up to 10 seconds before probing the root or scanning. Readiness requires the first `CHANGE_NOTIFY` request to be sent and startup invalidation to finish. The wait holds no scan slot, worker, or coordinator/generation lock.

Failure or timeout permits fallback verification while watcher retries continue. Initial failure means unavailable monitoring, not pre-start event loss. The first-attempt result is separate from current readiness. Cancellation or shutdown removes the waiter and prevents a later scan.

Readiness during fallback changes the epoch and rejects pre-monitoring reads. Verification resumes after the observation retry; a valid root probe keeps retained results searchable. Normal startup captures its scan epoch after watcher setup.

### SMB Barriers and Local Retries

Each backend pass captures an epoch without a pass-wide reader. Reads depend on the directory, its direct children, and its ancestors. Deeper-descendant barriers do not reject ancestor listings; a root barrier rejects all content reads. Availability probes check epoch and ownership, not content barriers.

Barriers retire after observations update the selected generation and older reads no longer need them. Overflow collapses barriers to one current root barrier: reads become stale, but the epoch and pending hints remain.

A stale parent moves to the queue tail atomically. Published rows remain, but staged snapshot names are cleared for a fresh read. Local retries do not invalidate unrelated completed work. Only observation loss and exhausted read capacity require bounded revalidation of completed parents.

Due verification takes priority over reconciliation; a full pass exclusively owns its scan queue. Buffered ancestors commit before descendants are selected. Stale reads use a one-second observation retry; source-wide failures use failure backoff. Continuous relevant changes can prevent pass completion.

Large reads stage names in disk-backed `scan_snapshot_children`, owned by the pending parent. Final diffs include staged names and the last batch. Direct-child changes reject stale reads; failed reads never apply an incomplete deletion diff.

### Parent Reconciliation

Between full passes, workers reconcile affected parents. Renames check both parents; new directories queue descendant reads. Only a complete, validated parent snapshot can remove absent children. Item errors retain subtrees and record partial coverage; source-wide failures or stale reads leave work pending. Reconciliation does not advance full verification or clear uncertain coverage.

File operations queue parent hints before dispatch and after actual worker completion, including failure. Cancellation must retain worker ownership and preserve the original operation result if hint delivery fails.

#### SMB Listing Feedback

Successful SMB listings feed an active index through a retained background task outside the response path and event loop. A pooled reader checks accepted and building generations in bounded batches. Known folders cause no observations or scan restarts.

Up to `max_listing_add_observations` missing folders, currently 64, queue individual additions. Larger lists, or additions that exceed capacity, use one parent observation if it fits. Admission checks count and bytes under the coordinator lock; a full queue discards optional feedback without observation loss. Errors log at DEBUG and never fail the listing.

#### Companion Listing Feedback

Successful local listings that contain at least one eligible child directory submit non-blocking hints bound to an existing source's session and root. They neither start sources/scans, open retained storage, refresh access time, nor prevent idle cleanup. Responses and per-entry errors are unchanged.

Collection preserves native case and Unicode names and stops at the first prefix limit: `ROW_BATCH_SIZE` (256 children) or `max_observation_bytes` (1 MiB, including the parent). Links, junctions, redirects, invalid UTF-8 names, and invalid index paths are excluded. Canonical-parent mismatches or failed enumeration submit nothing. Skipped items never imply deletion; children beyond the prefix depend on monitoring or verification.

The source-owned queue combines entries by parent. Queued and in-flight payloads together are limited to 1,024 entries (`max_pending_observations`) and 1 MiB of paths. A separate suppression set has the same bounds. Thus, retained paths use at most 2 MiB per source, plus one bounded collection per active listing. Allocation and query-encoding overhead are additional; this is not a heap-memory ceiling.

The existing worker processes at most one entry per update cycle (timer: 300 ms), after required recovery, flush, and reconciliation. Required observations can interrupt the read-only check. One 100 ms SQLite budget covers busy waits and final admission, starting after initial root verification. Filesystem calls can still block; this is not a hard worker deadline.

Checks require a selected accepted generation without an active scan, an indexed non-root parent, and no pending scan for that parent. A known prefix, even if truncated, causes no observation, barrier, verification, or revision change.

One missing child can request one `ReadParent`, never listing-derived `Add`, `Remove`, or `Rename`. Unlike `Add`, which publishes rows before filesystem checks, parent reconciliation verifies children through the safe reader. Final admission rechecks generation/revision, parent state, source availability, and observation/suppression capacity. Lock order is observations, writer, then feedback state; SQLite statements finish before the last lock. Rejection changes no observation state.

Admission adds a parent barrier and advances revision once on flush; a content-changing reconciliation can advance it again. It does not set `verification_required` or select the degraded interval. The parent stays suppressed until the next complete pass to avoid repeated reads for unindexable children. Stop or rebinding clears feedback and suppression.

Busy, full, suppressed, stale, interrupted, or failed hints are discarded without source failure handling. Required native and application observations keep their existing paths. A drive without an active source is not a discard. `directory_listing_feedback_discarded` logs INFO counts once per non-zero reason per cycle; worker rejections also log DEBUG `directory_listing_feedback_skipped` events.

### Source Identity and Traversal

Catalogue names hash source boundaries with SHA-256. SMB includes connection ID, host, port, share, configured folder, and username, but not passwords, display names, edit times, or runtime sessions. Local sources use root path plus available volume serial/UUID for fixed, removable, and unknown drives; network and virtual drives use root path alone.

Reused rows remain unverified until a pass completes. SMB reconnect binds new handles and invalidates unfinished reads. Queued FileIds identify expected reads, not storage continuity; SMB zero/all-ones IDs are unavailable. Server GUIDs and volume metadata are diagnostic. Session/tree IDs are meaningful only within one connection.

| Source | Traversal rules |
|---|---|
| SMB | No automatic DFS or symlink retries on compound reads; no-delete root handles; observed direct-parent reads only with healthy monitoring and a queued FileId; retained ancestors for safe fallback; connection-scoped session, tree, file-ID, and bound native-path checks |
| Linux local drive | Retained directory descriptors, `openat2` with no-link, no-mount, and beneath-root resolution; component-by-component fallback when the syscall is unavailable; exact names and mount checks; kernel pseudo-filesystems and device-tree aliases excluded |
| Windows local drive | No-delete bound-root handles, delete-sharing full-pass parent handles, 128-bit file IDs, volume and native-device paths; bounded enumeration and strict UTF-16 decoding |

SMB containment is logical, not physical: storage mounted inside the share can be indexed. A configured folder is not an access-control boundary for the connection credentials. DFS and reported reparse descendants are excluded. Local traversal never crosses mounts or follows links, junctions, cloud placeholders, or other reparse redirects. Missing optional volume metadata does not weaken checks.

Descendant links/reparse entries are silent exclusions, not issues or partial coverage. Complete coverage means eligible directories within the boundary. Root and opened-parent identity/path checks remain strict; failures are not exclusions. Missing or non-directory parents are read errors. Verification replaces old exclusion-derived issues without clearing unrelated failures.

SMB full passes probe the root at start and end. Between probes, direct no-follow parent opens require a ready recursive watcher, no observation-loss/read-capacity invalidation, matching queued FileId/path/session/tree, and no reparse point. Roots, reconciliation, missing-parent recovery, exact child checks, and parents without FileIds use the safe ancestor chain.

Ancestor events reject affected reads before publication. Tokens remain live through grouped commits and recheck watcher readiness. Late events correct committed rows through normal mutations. Watcher loss defers active observed reads and switches to safe traversal; event loss also revalidates completed parents. Root and non-compound handles retain no-delete sharing.

Safe reads reuse pinned share/root handles and retain ancestor and target FileAll checks. Between probes they require connected handles, a non-DFS tree, and unchanged connection, GUID, session, and tree bindings. Parent cleanup never closes root handles. Read failures request another full probe; versioned requests preserve failures raised during a probe. Standalone reconciliation always uses full root checks.

`FsVolume` metadata is cached by live tree/connection objects and session/tree IDs. Binding changes require a new query. Unsupported optional information is cached; permission and transport failures are not. The cache never replaces identity checks.

#### Native Traversal

The drive browser and index share volume classification. USB, SD, MMC, and hot-plug disks are removable; failed classification is unknown. Changed serial/UUID evidence selects another index for fixed drives. Removable/unknown drives can also replace the generation when available label, filesystem, or capacity changes. Replacement selects the new generation and deletes the old one atomically. Missing evidence, class changes, and unchanged evidence do not replace data. Windows uses the full 64-bit volume serial, including zero; native FileIds remain session-scoped.

Root binding rechecks volume evidence. Unmounted Linux sources cannot index mount-point folders. Mount checks use descriptor-bound `statx` IDs, falling back to `/proc/self/fdinfo`; missing capability stops the source until restart. Idle removable sources release root handles when no work or watcher needs them. Windows removal notifications pause work and release handles.

Linux skips known regular files through `d_type`; unknown types use no-follow metadata. Directory inode/mount checks use `statx` without child opens, with a descriptor fallback. Windows uses a 1 MiB enumeration buffer and validates names, attributes, reparse tags, and full 128-bit FileIds from records without child opens. Shared depth/path limits can exclude directories and leave partial coverage.

Each native read retains its `NativeParent` handle through enumeration, validation, and pruning, and checks queued identity before writes. Linux gives `fdopendir` a duplicate and rejects deleted descriptors. Without a healthy watcher, it also checks root-relative parent identity before each batch and completion. Windows full-pass reads use FileId opens, relative no-reparse opens, then the checked ancestor fallback. Parent handles permit delete sharing; roots and strict standalone reads retain no-delete sharing. Identity/path checks reject moved parents.

At most four native threads (`scan_read_parallelism`) read independent parents through a bounded channel; only the scan thread writes. Ancestors commit before descendants start. Cancellation or storage failure stops admission and joins workers after ownership is drained.

Backend initialization withholds rows until a valid root probe. Root failure returns HTTP 503 without deleting accepted data; descendant denial produces partial coverage. Late reads cannot restore an invalidated source.

### SMB Compound Reads

The observed reader sends `CREATE`, `QUERY_INFO(FileInternalInformation)`, two `QUERY_DIRECTORY` requests, and `CLOSE` as one compound. Queries restart then continue enumeration. End-of-directory completes small folders in one round trip; two data responses cause fallback to a fresh enumeration loop.

Buffers respect negotiated size, available credits, and the shared 1 MiB maximum; connections without multi-credit support are limited to 64 KiB. One worker pipelines up to `scan_pipeline_depth` parents, default eight, on the root's retained connection. Reused session/tree IDs cannot admit a replacement transport.

Pipeline admission reserves `scan_credit_reserve` credits, default 16, and requests credit growth. If a compound does not fit, the worker receives the oldest outstanding parent. With none outstanding, it can send one bounded growth echo per queue page, then use the loop if credits remain insufficient.

The pool creates `ScanCreditConnection` before setup; `smbclient` applies configured authentication/encryption. Its reentrant sequence lock covers credit checks and the entire compound send, using negotiated per-message charges. Browse sends use the same lock. Refused admission changes no sequence or outstanding requests; receive runs outside the lock.

Connections without atomic admission use the loop. Failed compound sends retire and abort the connection generation rather than reuse uncertain state.

The loop adapts each buffer to current credits and leaves the browse reserve where possible, but permits a one-credit query. Buffer sizing does not give loop reads atomic pipeline admission.

Both query paths parse `FILE_ID_FULL_DIRECTORY_INFORMATION` with bounded `memoryview` and `struct.unpack_from()` reads. They validate record offsets and lengths, skip file records without decoding names, and retain directory FileIds and reparse attributes. Directory names use the existing strict UTF-16 and component checks. A files-only wire batch is progress, not end-of-directory. Malformed bounds fail the read before publication; compound failures still drain all responses.

Compound handles allow read/write/delete sharing. Client-side symlink retries are disabled, and errors drain remaining responses. Deadlines start at submission; timeout, including during cleanup, defers unfinished parents and retires the generation through the pool abort path. A parent barrier defers only that parent; watcher loss defers all observed reads before safe traversal resumes.

FileId mismatches, reparse points, malformed responses, or enumeration without progress cannot publish rows. Missing/denied paths retain normal cache error handling. Buffered results recheck observations and root binding before commit; exact child checks use the safe retained-ancestor reader.

### SQLite Storage

| Runtime | Location and driver |
|---|---|
| Backend | `data/directory_cache/sqlite/`, or `sqlite/` below `directory_cache_location`; standard Python `sqlite3` with Debian system SQLite |
| Companion | `directory-index/sqlite/` in the OS-user cache directory; bundled Rust SQLite binding |

Indexes are disposable and separate from recent history. Metadata excludes passwords. `shared/directory-index/` owns schema, normalization, validation, and fixtures.

Schema 5 stores nullable queue FileIds: eight bytes for SMB/Linux, 16 for Windows. Identities commit with rows and survive deferral/reopen. Parent snapshots refresh changed non-null IDs; a changed known ID requeues completed work, while an unknown-to-known change keeps completion. Reconciliation updates existing queue rows only. Unchanged IDs cause no writes. Reads validate queued identity before publication; Companion can first commit a fresh parent snapshot. Confirmed mismatches are unsafe item issues.

`parent_id` links immediate parents within one generation, indexed by `directories_parent(generation_id, parent_id)`. Deletes cascade through linked descendants, FTS, and queue rows. Complete/streamed snapshot diffs, staged-name cleanup, and parent completion commit together without rewriting unchanged rows. Failed parents suppress deletions. Old schemas rebuild without changing recent history.

Issue counts belong to observation tokens until final parent commit and count toward group bytes. Early batches retain them; stale tokens discard them and leave the parent pending. Issues, coverage, revision, rows, and completion roll back together.

Managers keep an in-memory sample of at most 20 parent/reason pairs (`max_logged_scan_issues_per_pass`), published only after commit. Each pair can retain one known affected path, separate from its owning parent. Clean reads/deletions remove resolved samples; failed writes retain them. New full passes reset the sample; redirect exclusions never enter it.

Search exposes `issue_details_available`; `include_issue_details=true` adds `issue_details` and `issue_details_incomplete` under the same authorization. Optional `scope` is `directory` for a known affected path or `contents` for its containing parent. Accept older responses without `scope`.

`scan_pass_id` and `scan_active` distinguish fresh verification, which resets queue completion, from resumed work. Clean close requires no transaction and ready search tokens. Clean reopen with intact FTS skips `quick_check` and FTS integrity checks; unclean reopen runs both. Schema, foreign-key, generation, and binding validation always run. Valid staged snapshots survive reopen; restarted reads replace them. Invalid snapshots trigger cache recovery.

Both stores use WAL and `synchronous=NORMAL`; power loss can lose recent cache commits. Writers serialize writes, maintenance, and close. Pooled read-only queries use explicit transactions, revalidate storage binding, and clear cancellation handlers before reuse. Leases remain held until admitted work finishes; active databases cannot be evicted.

Full passes and reconciliation share bounded commit groups:

| Group | Maximum wait from first parent | Parent cap |
|---|---|---|
| Content changes | 250 ms | 1,000 |
| Bookkeeping only | 1 second | 20,000 |

Shared byte bounds, ancestor dependencies, failures, or pass completion can force earlier commits; page boundaries alone do not. Completed buffered parents retain tokens/barriers until commit, release active-reader capacity, and are excluded from later pages. Stale parents remain pending while valid peers can commit. Large reads can publish early batches.

Reconciliation uses queued FileIds and its own generation checks, strict root/parent reads, and existing per-parent deadlines. Group commits refresh memory status/progress without advancing full verification.

Empty-query status reads memory, not SQLite. `scan_progress` reports phase, completed/queued parents, directory count, and start time. The quick bar polls but hides `cache_state=opening`; errors stay visible. Active progress takes priority over uncertain coverage. Builds show `Indexing...` until the count is positive.

Storage must be private and local. Validate ownership, identity, and aliases on open and cleanup. Never edit managed databases externally or weaken binding checks to a path-only fallback.

### Resource Controls

`shared/directory-index/contract.json` bounds workers, batches, observations, and policy values. Disk growth requires headroom and free space. Native groups share one reservation. Admission holds the accounting lock, includes outstanding reservations, and resamples free space after cleanup. Maintenance yields to active work.

Automatic full passes have a minimum spacing of 30 seconds. Requests cannot bypass spacing or retry gates. Interrupted passes retain progress; observation gaps require bounded revalidation before acceptance.

Lower budgets can pause growth, never trim active data. Only inactive, unowned indexes can be evicted. Disk/cache settings are not hard filesystem or process-memory ceilings.

See [Directory-Index Policy Delivery](../../companion-architecture/local-drive-and-save-back-pipeline/#directory-index-policy-delivery) for Companion ownership and [Manage Directory Search](../../../admin-guide/operations-and-maintenance/manage-directory-search/) for administration.

### Recovery and Shutdown

Startup validates identity and consistency before exposing rows. Damaged search tokens rebuild from validated rows. Only recognized invalid index data permits replacement; permission, capacity, busy-storage, or general I/O errors never justify discard.

Retries are bounded. Access updates last-access time, not observations or deadlines. Idle sources release resources only without workers, readers, or queued scans, then revalidate the root on reuse. Shutdown retains storage/root ownership until admitted work finishes, including cancelled requests.

Backend scans wait for both resource-failure and observation-retry gates. `retry_after_ms` reports the earlier of that combined scan deadline and the next watcher retry. Queries do not move deadlines. Local stale reads use the one-second observation retry.

Epoch invalidation reasons are `watcher_start`, `observation_loss`, `source_rebind`, `read_capacity`, `stalled_read`, and `lifecycle`. All request verification; all except `stalled_read` mark coverage uncertain. Epoch/ownership checks reject stale work. SMB direct observed reads stay disabled for an epoch with observation loss or exhausted read capacity, even after queue revalidation.

Binding mismatch pauses publication, rebinds handles, and requests verification. Source/storage failures never prove deletion. Index recovery neither resets shared SMB connections nor removes recent history. Watcher recovery runs independently of storage initialization. Successful scans do not clear watcher warnings; recovered monitoring still requires gap verification.

SMB setup runs outside the pool lock and is shared for the same private cache. Work, setup tasks, and retained generations are bounded per source and process. Retired generations keep their cache until cleanup finishes; replacements use separate caches. Capacity failures return retry information. Shutdown stops admission; writes are never replayed automatically.

Caller cancellation does not stop blocking SMB I/O. Handles, leases, and permits remain owned until completion; late opens are closed before lease release.

Operation deadlines retire the generation and request one pool-owned `Connection.disconnect(close=False)` abort outside the event loop/pool lock. It uses that generation's connection snapshot, sends no logoff, and never touches replacements. Ordinary cancellation does not abort unrelated shared work; watchers have a separate lifecycle.

Abort wakes blocked receives but can itself wait behind socket send. It is not a hard deadline and retains capacity until exit. Wait before retrying capacity errors; restart the backend if retained work cannot finish.

Aborted mutations or deadlines after dispatch can have uncertain completion. The API returns `smb_mutation_uncertain`, `mutation_uncertain: true`, and `recoverable: false`. Check the source before retrying: the write may already have happened.

Backend status priority is source, disk budget, initialization, stalled read, verification failure, update failure, observation loss, watcher availability, partial coverage, token rebuild, then continuous changes. Messages clear only when the corresponding condition resolves. In particular, unrelated reads cannot clear verification failure; a successful periodic iteration clears update failure; a finished pass clears observation loss even with item issues.

Diagnostics use opaque source/session IDs and omit private paths, exception text, and SMB payloads. Invalidations log INFO reasons and counters. Pass start/finish use INFO; finish events include counts, commits, duration, and abort reason. Backend finish/retry events also report `invalidation_reason` and consecutive `stale_turns`. Repeated failures use bounded summaries.

I/O logs report per-pass differences from source-owned counters: `smb_round_trips` and `native_opens`. See [Directory-Search Diagnostics](../../cross-cutting-systems/logging-and-localization/#directory-search-diagnostics).

### Quick-Bar Status Contract

Work state, coverage, verification time, and monitoring health are separate. `monitoring_state` is `starting`, `healthy`, `recovering`, or `unavailable`. `retry_after_ms` is relative to response receipt. Missing/null fields do not prove healthy monitoring.

| Response or condition | Quick-bar behavior |
|---|---|
| Building or updating, without a retry delay | Show active work and check status again |
| Paused work with a retry delay | Show the status message without an active-work spinner; wait before checking |
| Empty data, uncertain coverage, or unavailable monitoring | Keep history available and continue bounded status checks |
| Recoverable request failure | Keep accepted results for the same query, show failure, and retry |
| Terminal or unsupported request failure | Stop automatic retries until reactivation or a source change |
| Ready, healthy data without a warning | Stop periodic status checks |
| Closed menu or hidden page | Stop periodic checks; reject stale responses when the query or source changes |

Empty-query activation initializes status/history without a minimum search length. Retry delays are clamped to 1-60 seconds with a five-second fallback. Use `recoverable` and `retry_after_ms`, never message text, for recovery. Older responses without the shared search contract do not enable periodic checks. Source, history-client, storage-capability, and request-sequence bindings reject stale results and timing.

### Support Limits

Companion indexing supports Linux and Windows, not macOS. Visible drives do not imply index support. Native traversal/recovery changes require tests on the affected OS; cross-compilation alone is insufficient.

## Where to Continue

- [Request Flow and Service Boundaries](../request-flow-and-service-boundaries/): backend service ownership
- [File Operations and Edit Locking](../file-operations-and-edit-locking/): uploads, moves, renames, and edit sessions
- [Local-Drive and Save-Back Pipeline](../../companion-architecture/local-drive-and-save-back-pipeline/): companion file operations
- [Logging and Localization](../../cross-cutting-systems/logging-and-localization/#directory-search-diagnostics): directory-search diagnostics and privacy rules
- [Test Strategy Overview](../../testing-and-quality-gates/test-strategy-overview/): test scope and repository gates

## Validation Expectations

Test changed watcher, cache, storage, API, and SMB boundaries. Cover binding, partial failures, event loss, stale reads, exact counts, and cancellation ownership:

```bash
cd backend
.venv/bin/python -m pytest tests/test_directory_cache.py tests/test_directory_index_contract.py tests/test_directory_search.py tests/test_smb_backend.py
.venv/bin/python -m mypy app
```

For Companion, run relevant Rust manager, storage, traversal, and handler tests. Add frontend checks for refresh, status, selection, or progressive results.
