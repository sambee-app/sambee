+++
title = "File Browser and Navigation Model"
+++

The file browser is the densest browser-side product surface in Sambee. It combines navigation, selection, editing entry points, viewer launch, keyboard behavior, and real-time directory refresh.

## Core Component Split

The implementation is deliberately split between shared page logic and per-pane logic.

| Area | Responsibility |
|---|---|
| `pages/FileBrowser.tsx` | owns shared browser-level concerns such as active pane routing, URL sync, WebSocket lifecycle, and global shortcut registration |
| `pages/FileBrowser/useFileBrowserPane.ts` | owns per-pane state such as connection and path, selection, sorting, filtering, dialogs, viewer state, incremental search, and directory refresh handling |
| `pages/FileBrowser/routing.ts` | parses and serializes typed directory, viewer, editor, and settings locations |
| `pages/FileBrowser/useWorkspaceNavigation.ts` | resolves viewer targets and owns workspace navigation and safe overlay return entries |
| `hooks/useRoutedViewerEditing.tsx` | connects the active editor's existing confirmation dialog to React Router navigation blocking |
| `pages/FileBrowser/FileBrowserPane.tsx` | renders one pane's UI |
| `components/FileBrowser/CopyMoveDialog.tsx` | manages copy and move confirmation flow |
| `config/keyboardShortcuts.ts` | central shortcut definitions used across the browser |

This split matters because two visible panes still need one coherent browser workflow.

The parent-versus-hook split is intentional:

- `FileBrowser.tsx` owns shared state such as the connections list, active-pane routing, responsive layout, WebSocket connection lifecycle, and browser-level shortcut registration
- `useFileBrowserPane.ts` owns per-pane state such as file loading, sort and filter state, viewer and dialog state, focus handling, multi-select state, and pane-specific directory-change reactions

## Pane Model

Sambee supports one-pane and two-pane browsing, but the two-pane implementation is intentional rather than conditional duplication.

- the left pane is always active in routing terms
- the right pane is still instantiated even when not visible, which keeps the hook model stable
- the active pane decides which pane keyboard shortcuts and toolbar commands target
- dual-pane mode is desktop-first and collapses to single-pane on compact layouts
- dual-pane preference and active-pane preference are persisted so the browser can restore the user's working style
- the viewer opens as a fullscreen overlay from whichever pane launched it rather than being constrained to one pane region

Visual state also matters:

- the active pane gets the stronger emphasis treatment
- the inactive pane is visually de-emphasized rather than treated as a separate route or different screen

## Real-Time Directory Refresh

Each pane handles directory-change notifications independently. An automatic refresh keeps an already loaded physical-directory listing mounted, including an empty listing, so unchanged rows retain selection, keyboard focus, and scroll position. Initial loading and navigation without a usable snapshot still show loading feedback.

Notifications don't cancel an active listing request. Instead, the pane remembers that another refresh is needed and starts one follow-up request after the active request finishes. Automatic refreshes start at most once per second. Further notifications don't move an existing deadline, so continuous writes still produce periodic updates. Navigation and unmount cancel queued work.

A listing with unprocessed change notifications can remain visible, but it isn't cached as fresh. Deferred link-target metadata only updates cache entries that are still valid, so cancelling a follow-up refresh can't make an outdated snapshot reusable on return.

SMB file-list subscriptions watch immediate children rather than the whole subtree. The separate backend directory-search cache retains recursive directory-name monitoring. See [SMB Change Notification and Directory Freshness](../../backend-architecture/smb-change-notification-and-directory-freshness/) for watcher ownership and lifecycle.

## URL-Driven Workspace Navigation

The URL selects the directory, pane layout, viewer, editing intent, and settings view. The file browser stays mounted under overlays. Loaded content, drafts, locks, selection, scroll, search panels, and zoom remain runtime state.

| Part | Meaning |
|---|---|
| `/browse/smb/<slug>/<path>` | Primary SMB pane |
| `/browse/local/<drive-id>/<path>` | Primary companion-drive pane |
| `p2=<kind>/<target>/<path>` | Right pane, enabled when present |
| `active=2` | Right pane is active |
| `file=<kind>/<target>/<path>` | Viewer target, independent of the directory and active pane |
| `viewer=image\|markdown\|pdf\|text` | Requested browser viewer |
| `mode=edit` | Editing intent for text or Markdown |
| `pane=2` | Right pane owns the viewer; requires a right-pane target |
| `virtual=<JSON array>` | Archive member descriptor: provider ID, source archive path, member path |
| `settings=main\|<category>` | Settings main view or category from the shared category registry |

For example:

```text
/browse/smb/my-server/documents
/browse/smb/my-server/documents?p2=smb%2Fother-server%2Fphotos&active=2
/browse/smb/my-server/documents?file=smb%2Fmy-server%2Fdocuments%2Fnotes.md&viewer=markdown
/browse/smb/my-server/documents?file=smb%2Fmy-server%2Fdocuments%2Fnotes.md&viewer=markdown&mode=edit
/browse/smb/my-server/documents?settings=account
```

Use the shared parser/serializer and `URLSearchParams`, not concatenated query strings. File descriptors encode target IDs and individual path segments before query serialization. The archive provider is currently `zip`. Runtime session IDs, file contents, MIME guesses, gallery arrays, credentials, and lock capabilities never belong in navigation state.

### Navigation and Dismissal

Opening or closing a viewer, entering or leaving editing, changing gallery images, opening or closing settings, and changing settings categories push history entries. Repeating the same location does nothing. Pane-focus updates, invalid-descriptor recovery, failed edit acquisition, and canonicalization replace the current entry. Unrelated query parameters and authentication fragments are preserved.

Back and Forward follow actual history without adding entries. Explicit Close pushes the current workspace with the dismissed layer removed, including for direct links and refreshed viewers. For example, opening a directory, opening an image, and closing it produces directory, image, and directory entries; Back reopens the image before returning to the earlier directory entry. A new action after Back discards the old Forward branch, following normal browser behavior. Close doesn't depend on opening-entry metadata or `history.length`. Settings back controls traverse observed history; without an observed predecessor they replace the URL with an in-app parent.

Desktop settings and the mobile drawer are controlled by the same category descriptor. `settings=main` displays the desktop default category or the mobile category list. Resizing changes presentation without navigation. Standalone `/settings/...` routes and their aliases use the same category content and authorization checks. User Management owns its query keys through React Router, merging them with workspace parameters.

### Direct Links and Recovery

Viewer links resolve metadata through the storage registry or content provider, without simulated file-row clicks. Resolution is cancelled when its identity changes. Missing resources show Retry and Close actions. A viewer URL never falls back to opening a native application.

The incoming URL always wins over a browser recovery snapshot. Snapshot hydration matches each pane's resource identity, clears legacy viewer state, and ignores unmatched panes. A bare `/browse` uses normal default navigation. Captured snapshots use the current canonical workspace URL and contain neither callback fragments nor edit-session tokens.

### Viewer Loading and Transitions

Loading feedback belongs to the selected image, PDF, text, or Markdown viewer. Workspace metadata resolution and dynamic component imports do not show an intermediate full-screen loading dialog. On an initial opening, the browser remains visible until metadata and the viewer component are available; the viewer then displays its existing content-loading feedback.

During file-to-file or history navigation, keep the outgoing viewer presentation mounted until the replacement metadata and component are ready. Do not expose the directory between viewers or pass the new target's props to the old viewer component. Outgoing controls and shortcuts are suspended during the handoff, while Escape can cancel the pending opening. The existing error dialogs retain Retry and Close actions. Cancellation rejects late results rather than reopening a dismissed viewer.

One dynamic viewer host serves both panes. An explicit viewer ID, not an image's changing MIME type, controls component loading. Text and Markdown still reset resource-local state when the actual file changes; mode-only and settings-only navigation do not restart the viewer.

### Editing and Router Integrity

The app uses a data router (`createBrowserRouter` and `RouterProvider`) for supported `useBlocker` behavior. One guard owner delegates resource-leaving transitions to the active text or Markdown editor when its draft is dirty, a save is pending, or a session is being acquired. Clean editor Back and Forward navigate directly, avoiding the history reversal required by a blocked browser navigation. Cancel keeps the draft and lock; successful Save or Discard continues the original transition; failed Save keeps the editor open. Changes that retain the same edited resource and mode don't discard its draft. Dirty drafts also register `beforeunload` protection.

Edit bookmarks and history navigation back into editing acquire a fresh edit session after content and permission checks. Navigating away during acquisition invalidates the attempt and releases any late lock. Leaving editing releases its session once. The outgoing editor is read-only during cleanup, and re-entry waits for that cleanup to finish so an old release can't clear a new session. History restores navigation intent, not old file contents, discarded drafts, or saved locks. An edit URL doesn't grant permission.

Use router navigation for all mounted-route URL writes, including authentication fragment cleanup. `useRemoveLocationFragment` replaces the entry, removes only consumed fragment keys, and preserves the full query and application state. Never clear router-managed history state with `replaceState(null, ...)`: doing so can disable POP blocking.

## Keyboard and Command Model

Keyboard behavior is part of the product contract, not just convenience.

- pane switching, selection, copy, and move use centralized shortcut definitions
- the quick bar supports smart navigation, command mode, and pane-local current-directory filtering
- browser defaults that conflict with the product's navigation model are overridden intentionally
- shortcuts are disabled when dialogs or viewer states would make them unsafe

Changes here can easily affect power-user workflows, accessibility, and focus management all at once.

Use [Keyboard Shortcuts and Command Model](../keyboard-shortcuts-and-command-model/) for the central registry, command-palette rules, and quick-bar interaction details. This page focuses on how those rules shape the file-browser architecture.

## Pane-Local Current-Directory Filtering

Current-directory filtering is part of pane state, not just quick-bar UI state.

The important design choice is that the quick bar only supplies the input shell. The actual filter value and filtered list live in `useFileBrowserPane`.

- each pane owns its own `currentDirectoryFilter`
- the pane computes `sortedAndFilteredFiles` from the normal sorted list plus the active filter text
- the filtered list is the same list used by the virtualizer, keyboard navigation, viewer launch, selection helpers, and status bar
- the active filter is considered scoped to the pane's current `connectionId + path`

That arrangement is what makes the behavior consistent in both single-pane and dual-pane workflows.

### Why the Filter Lives in the Pane Hook

The filter is not modeled as a dropdown provider result set.

- smart navigation is a navigation surface that benefits from dropdown results
- command mode is a command surface that benefits from dropdown results
- current-directory filtering is a local transformation of the pane's main file list

Because the pane already owns the rendered list, focus state, virtualizer, and file actions, the filter belongs there as well.

### User-Facing Behavior the Architecture Must Preserve

The implemented flow is:

1. `Ctrl+Alt+F` opens filter mode for the active pane.
2. The shared input shows that pane's current filter value.
3. Typing immediately filters the pane's main file list.
4. `ArrowDown` from the input focuses the filtered file list.
5. Arrow keys, `Home`, `End`, `PageUp`, `PageDown`, `Enter`, and file actions operate on the filtered visible list.
6. Pressing `Ctrl+Alt+F` again returns focus to the same pane's filter input without clearing the term.

Reset and persistence rules are equally important:

- switching between smart navigation, command mode, and filter mode does not clear the active filter
- changing directories clears the filter for the new path scope
- changing the pane connection also clears the filter
- dual-pane mode keeps filter state isolated per pane
- browser recovery snapshots capture and restore the pane filter together with path, focused item, and selection state

### Focus and Zero-Result Behavior

Filtering changes focus semantics because it can remove rows from the visible list.

- if the previously focused file still exists in the filtered list, focus stays on that file
- if it disappears, focus clamps to the nearest valid visible item
- if the filter produces zero visible files, focus remains in the filter input when possible

That is why the pane hook owns both the filtered list and the focus-adjustment logic.

### Status Bar Visibility

The filter must remain visible even when the quick bar is no longer in filter mode.

- the desktop status bar renders the active filter term whenever the pane has a non-empty filter
- the status bar uses the filtered visible list for item counts and file metadata
- this keeps the active filter visible while the user switches to smart navigation or command mode

The status bar indicator is part of the product contract, not just decorative UI. It is the persistent signal that the pane is still filtered.

## Selection, Copy, and Move

The browser maintains explicit multi-select state per pane, but still supports a focused-item fallback when nothing is explicitly selected.

In practice, the pane computes an effective selection from either:

- the explicit selected-file set
- or the focused file when nothing has been explicitly selected

Selection is pane-local and clears naturally when directory navigation changes the active file list.

Copy and move behavior depends on:

- the active pane as the source
- the other pane as the destination in dual-pane workflows
- backend or companion routing depending on which connection types are involved
- conflict and validation behavior that still comes from the destination backend contract

The copy and move dialog is not just a confirmation prompt. It also:

- shows the selected source files
- pre-fills the destination from the other pane
- lets the user adjust the destination before confirming
- reports progress while multiple operations execute

Important contract details:

- `F5` means copy in dual-pane mode, but remains refresh in single-pane mode
- `F6` means move in dual-pane mode
- cross-connection operations are not treated the same as same-share SMB operations
- backend validation still decides whether same-path, self-copy, or conflicting operations are allowed

For same-connection SMB copy and move, the backend uses server-side operations rather than streaming all file bytes through the browser app.

## Refresh and Live State

Directory freshness is coordinated through WebSocket subscriptions.

- the browser subscribes to each visible pane's directory
- directory-change messages are routed back to the matching pane
- local-drive and SMB-backed directories can use different backends while still feeding one browser experience

In dual-pane mode, both panes are live participants in refresh behavior:

- each pane can subscribe to a different directory
- each pane re-subscribes when its own path changes
- directory-change events are dispatched back to the pane that owns the matching path and connection context

This is why navigation and data freshness are coupled more tightly than they first appear.

## Design Constraints and Deliberate Tradeoffs

Some file-browser behaviors are deliberate tradeoffs rather than incidental implementation detail.

- the UI caps visible panes at two even though the query-key pattern could theoretically scale further
- browser-default shortcuts such as tab switching are overridden when they conflict with the product's pane model
- dual-pane mode is disabled on compact layouts instead of forcing a cramped mobile approximation
- one pane can stay hidden while still existing in state so the hook model remains stable

## Why This Page Matters

Frontend changes in the file browser often look local, but they can break:

- URL-restoration behavior
- keyboard and focus contracts
- copy and move flows
- viewer launch behavior
- local-drive versus SMB routing assumptions
- refresh behavior across both panes

## Where to Continue

- Use [Keyboard Shortcuts and Command Model](../keyboard-shortcuts-and-command-model/) for centralized shortcut definitions, command-palette behavior, and focus rules.
- Use [Viewer Architecture and Preview Contracts](../viewer-architecture-and-preview-contracts/) for preview and file-type behavior.
- Use [Browser-to-Companion Trust Model](../../companion-architecture/browser-to-companion-trust-model/) when navigation or actions depend on paired local-drive access.
- Use [Test Strategy Overview](../../testing-and-quality-gates/test-strategy-overview/) when changes cross backend, frontend, and companion boundaries.
