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
- keep the in-memory directory cache aligned with adds, removes, and renames
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

A full rescan builds a replacement index while the current index continues to serve directory searches. If any directory read fails or times out, the replacement isn't published or persisted. The existing index remains available, and the scan error is recorded for diagnosis. A later successful rescan can replace it.

While a rescan is running, directory additions, removals, and renames update the live index and are also recorded in order. Under the cache lock, Sambee checks pending operations before and after each directory read and before publication. Additions are safe to merge. Removals and renames can only be merged when they don't overlap a read that's already started.

If a removal or rename changes a directory that's already been read, one being read, an ancestor of either, or an immediate child's name, the replacement is ambiguous. Notifications can arrive after a read already reflects the change, so replaying them could rename or remove fresh paths a second time. Sambee discards the replacement rather than publishing or persisting it; the live index, including its recent changes, remains available. Only one rescan can run at a time, and cancellation discards pending reconciliation without discarding live updates.

Directory junctions, symbolic links, and unrecognized directory reparse points are indexed as destinations, but scans don't descend into their targets. This prevents ancestor links from causing repeated traversal. DFS referrals are identified by their reparse tag and remain traversable through the SMB client's referral support, so directories below DFS links stay searchable.

### Persisted Snapshots

Version 2 snapshots are bound to the connection's host, port, share, normalized path prefix, username, and connection revision. The revision changes when the connection is edited, including credential changes. Passwords aren't stored in snapshot metadata.

A snapshot with a different source identity is ignored, including when trying the backup file. Older version 1 snapshots are also ignored, so existing installations rebuild the directory index once after upgrading. Matching snapshots still provide immediate search results while background verification checks freshness.

Startup verification and the periodic rescan loop have separate tracked tasks. Removing a cache or shutting down the application cancels both tasks, along with initial scanning and snapshot flushing.

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
