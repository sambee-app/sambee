+++
title = "Local-Drive and Save-Back Pipeline"
+++

The companion supports two different desktop-side data paths.

- paired local-drive access through the localhost API
- SMB-backed native-app editing with temp files, locks, and explicit save-back

They are related because the same desktop app participates in both, but they do not share the same trust or data lifecycle.

## Local-Drive Access Pipeline

For local drives, the browser stays in control and the companion behaves like a desktop-local backend.

1. the browser detects the companion through the localhost health endpoint
2. browser and companion pair explicitly
3. the browser requests available drives
4. the browser routes local-drive browse, file, and file-management requests to the companion instead of the server backend
5. a companion-side watcher and WebSocket channel keep local directory state fresh

This is why local drives can appear inside the same UI as SMB shares while still using a different execution path.

## Localhost API Shape

The companion embeds a localhost HTTP server and mirrors the backend API contract closely enough that the frontend can stay mostly connection-type agnostic.

The server is bound to `127.0.0.1:21549` and exposes routes under `/api`.

Representative endpoints include:

- `GET /api/health`: companion availability
- `POST /api/pair/initiate`: begin pairing
- `POST /api/pair/confirm`: finish pairing after dual confirmation
- `GET /api/pair/status`: origin-scoped browser pairing status
- `POST /api/pair/cancel`: cancel a pending pairing for the current browser origin
- `DELETE /api/pair/current`: remove the current browser origin's pairing
- `GET /api/drives`: enumerate available local drives and volumes
- `GET /api/browse/{drive}/list`: list a directory
- `GET /api/browse/{drive}/info`: stat one file or directory
- `GET /api/browse/{drive}/directories`: search directories recursively
- `GET /api/viewer/{drive}/file`: stream a file for inline viewing
- `GET /api/viewer/{drive}/download`: stream a file as a download
- `POST /api/browse/{drive}/upload`: upload a file into the drive-backed path
- `DELETE /api/browse/{drive}/item`: delete a file or directory
- `POST /api/browse/{drive}/rename`: rename a path
- `POST /api/browse/{drive}/create`: create a file or directory
- `POST /api/browse/{drive}/copy`: copy within or across local drives
- `POST /api/browse/{drive}/move`: move within or across local drives
- `WS /api/ws`: companion-side directory change notifications

Response shapes intentionally follow the backend contract so the browser can reuse models such as directory listings and file info instead of maintaining a separate local-drive UI protocol.

The important exception is pairing state: the browser-facing pairing contract is intentionally origin-scoped and typed, rather than exposing a global paired flag or browser-visible inventory of all trusted origins.

## Local-Drive Operation Rules

- the companion mirrors the backend API contract closely so the frontend can stay mostly connection-type agnostic
- local-drive operations use desktop filesystem primitives, not SMB semantics
- local files opened directly through the companion can skip download, lock, upload, and the "Done Editing" flow entirely

Additional rules that matter in practice:

- image conversion is not part of the companion local-drive path; raw local files are served directly
- local-drive browsing has no SMB edit-lock semantics
- same-drive copy and move use local filesystem operations directly
- cross-backend transfers between SMB and local storage are browser-mediated rather than hidden inside the companion's direct-open flow

That direct local-open path is intentionally different from SMB-backed native-app editing.

## Drive Enumeration Model

The companion discovers drives and mounted volumes automatically.

Platform-specific inputs differ, but the goal is the same: expose what the current desktop user can already access through the normal filesystem.

- Windows: fixed drives, removable drives, mapped drives, and virtual drives exposed through the filesystem
- macOS: mounted volumes under the normal desktop volume model
- Linux: mounted filesystems that represent real file content rather than pseudo-filesystems

That includes cloud-backed or virtual drives when they appear through the OS filesystem layer.

The browser therefore does not need manual drive configuration. It asks the companion for the current drive list and renders those entries alongside SMB connections.

The companion should still filter out pseudo-filesystems and other non-file mounts that would only add noise or unsafe paths.

## Browser Routing and Auth Behavior

The browser uses the same UI for SMB and local drives, but the request path changes underneath.

- SMB-backed requests continue through the main Sambee backend
- local-drive requests route to the companion localhost API instead
- the browser detects the companion through the health endpoint
- once paired, it requests drives and merges them into the connection list as local-drive entries

Authentication also changes:

- backend requests use the normal server-side auth model
- companion requests use the pairing-derived HMAC model described in [Browser-to-Companion Trust Model](../browser-to-companion-trust-model/)

Localhost bootstrap follows these rules:

- production trust is established by exact-origin approval during pairing
- development remains practical through loopback-origin allowance
- browser-facing pairing management is limited to the current origin rather than arbitrary origin inventory or deletion

That distinction is critical. Local-drive access is not "server auth pointed at localhost". It is a separate authenticated browser-to-desktop channel.

## Directory-Index Policy Delivery

Directory policy uses the shared settings protocol described in [Browser-to-Companion Trust Model](../browser-to-companion-trust-model/#shared-settings-delivery). Pairing selects authority and permits automatic delivery by any active, authenticated user. Only administrators can edit policy. Companion retrieves canonical settings directly from the authoritative backend without redirects.

Updates serialize against source initialization. Unchanged revisions are no-ops within the same backend identity. Failed delivery or persistence preserves the last valid policy. Authority changes invalidate pending delivery. File APIs must protect policy and index storage from modification. Policy synchronization state is separate from index health.

Local-drive scans keep committed rows and queued work after interruption or reopen. Child FileIds commit with parent groups and are checked before child traversal. A changed identity requires a fresh parent listing before its children can enter the index. Status polls use memory snapshots; real queries reuse read-only SQLite connections with file-binding checks. Active work prevents idle release, and the shared browser status shows live scan counts.

Enumeration silently skips descendant symbolic links, Windows junctions, cloud placeholders, and other reparse entries without following them. These exclusions do not create item issues or partial coverage. Root and opened-parent checks still reject redirects and failed identity or boundary validation. Diagnostic records retain a known child path when available, or identify a containing parent when its unreadable child name is unavailable. Parent-owned cleanup and observation-token lifetime do not depend on that displayed path.

Linux uses `openat2` when available and no-follow statx checks for directory children. Only ENOSYS disables future `openat2` attempts; permission, link, and mount errors stay errors. The fallback checks each ancestor without following links. Regular files with known entry types need no metadata call; DT_UNKNOWN entries use no-follow metadata before directory checks. Windows uses the shared 1 MiB enumeration buffer. It validates names, attributes, and reparse tags from directory records and preserves full 128-bit FileIds without opening each child. The queued FileId is checked before that child is traversed.

Windows full scans use `OpenFileById` for parents with queued identities. The returned full identity, volume, directory attributes, and exact native path must match. A 64-bit descriptor is used only when it preserves the full stored identity. If FileId opens cannot supply the parent, relative `NtCreateFile` opens it from the retained root. Relative names are validated before I/O; intermediate and final reparse points are rejected. The returned directory must match the root volume and exact native path. The manager defers a replacement identity before its children can be published. Definite unsupported modes are cached per root, with the checked ancestor walk as the final fallback. Permission, redirection, and transport failures remain errors.

Each native scan retains its checked parent descriptor or ancestor chain through enumeration, batch validation, and pruning. With a healthy watcher, commit and child checks use that read without reopening the parent path. On Linux, a missing, failed, or not-yet-ready watcher requires a root-relative parent identity check before each child batch and final parent completion. This check also applies to parallel full-pass and reconciliation reads. Queued identity and observation-token checks still guard writes.

Full passes verify the root when binding and before acceptance. Between these probes, parent reads check the held root locally. Read errors and traversal issues request another full probe before the next parent opens. Version counters preserve requests raised during a probe. Standalone reads and reconciliation keep full root checks. Windows standalone and final ancestor-walk fallback reads retain no-delete ancestor chains; FileId and relative reads retain the parent handle. Held-parent identity and native-path checks run at read boundaries rather than for each record. Non-root full-pass handles permit delete sharing; the root and strict standalone handles retain no-delete sharing.

Full scans and reconciliation read independent parents with at most four worker threads through a bounded channel. Only the scan thread writes. Paged queue reads carry FileIds; ancestor groups commit before descendants start. Both modes use adaptive content/bookkeeping groups and one disk reservation per group. Reconciliation retains strict reads and does not advance the full-verification clock. Item issue counts stay with observation tokens until final snapshot commit; stale tokens discard their counts and leave work pending. Group exit releases buffered ownership, including after an interruption or storage error.

See [Directory-Index Consistency](../../backend-architecture/smb-change-notification-and-directory-freshness/#directory-index-consistency) for shared index rules and [Manage Directory Search](../../../admin-guide/operations-and-maintenance/manage-directory-search/) for the administrator workflow.

## Local-Drive Watching and WebSockets

The companion keeps local directory state fresh through its own watcher and WebSocket path.

- the browser opens a companion WebSocket when local-drive behavior is active
- subscriptions are tracked per directory
- the companion shares watcher state when possible instead of creating wasteful duplicate watchers
- local directory changes propagate back into the same browser refresh model used by the file browser

Native watchers do not report deletion of the watched directory on every platform. The companion also checks the target once per second. If the directory is missing or is no longer a directory, the companion removes its watcher state before it sends the change notification. A later subscription can watch a recreated directory.

Directory requests distinguish a missing path from a path with a file in place of a parent directory. This distinction also applies on Windows, where both cases can produce a missing-path OS error. Only a confirmed missing directory returns `directory_not_found`; a file used as a parent returns `not_a_directory`.

This is why local drives can participate in the same dual-pane and refresh workflows as SMB connections without pretending the transport is the same.

## SMB-Backed Native-App Save-Back Pipeline

For SMB-backed native-app editing, the companion is not the source of truth. It is the desktop-side coordinator for a backend-governed editing lifecycle.

1. the browser launches a `sambee://` deep link
2. the companion exchanges the URI token for an authenticated session
3. it fetches metadata and downloads the file to a temp directory
4. it acquires the backend edit lock
5. it opens the file in the chosen native application
6. a "Done Editing" window stays open while heartbeat and file-status checks continue in the background
7. on explicit user confirmation, the companion uploads the file or discards it
8. the backend lock is released and the temp file is recycled

## Why Save-Back Uses Explicit Confirmation

The save-back model uses explicit user action rather than automatic filesystem watching.

That avoids a harder class of problems around:

- partial writes and atomic-save behavior
- repeated intermediate uploads
- uncertainty about when editing is truly finished

The hold-to-confirm interaction is therefore a product decision, not just a UI quirk.

## Conflict and Recovery Behavior

The companion keeps operation state because desktop editing can outlive one clean process lifecycle.

- operation state is persisted alongside temp files for recovery
- server state is checked before overwrite-sensitive upload completes
- when server state changed during editing, the user must resolve the conflict rather than silently replacing the file

## Critical Distinction Contributors Must Preserve

- local-drive workflows do not use backend SMB edit locks
- SMB-backed native-app editing does use backend lock, heartbeat, and upload semantics
- cross-backend transfers between SMB and local storage are their own browser-mediated flow, not a shortcut through the deep-link edit lifecycle
- localhost API pairing and HMAC auth are part of the product contract, not replaceable convenience layers

If you blur these paths, you usually break either security assumptions or data-integrity guarantees.

## Where the Main Logic Lives

| Path | Responsibility |
|---|---|
| `companion/src-tauri/src/server/` | localhost API, drive enumeration, auth, pairing, and watcher behavior |
| `companion/src-tauri/src/commands/open_file.rs` | download and native-app open lifecycle |
| `companion/src-tauri/src/commands/upload.rs` | upload, lock, and heartbeat support |
| `companion/src-tauri/src/sync/operations.rs` | operation state and recovery tracking |
| `frontend/src/services/backendRouter.ts` | routes browser requests to backend or companion based on connection type |

## Design Constraints and Deliberate Tradeoffs

Some local-drive behavior is intentionally scoped rather than incomplete by accident.

- local direct-open avoids the SMB save-back lifecycle on purpose
- raw local files are served directly instead of bundling server-style image conversion into the companion path
- drive scope follows what the current desktop user can already access rather than inventing a separate path-allowlist model by default
- cross-backend file movement is a separate browser-mediated path because SMB and local-drive backends do not share one native transfer primitive

## Validation Expectations

When this pipeline changes, usually run:

```bash
cd companion && npx tsc --noEmit
cd companion && npm run lint
cd companion/src-tauri && cargo test
cd frontend && npm test
cd frontend && npx tsc --noEmit
cd backend && pytest -v
```

The backend checks matter whenever the change touches SMB-backed save-back, lock, heartbeat, or upload behavior.
