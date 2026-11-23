# Tab Persistence Resilience Plan

This plan makes the folder tabs of the file browser survive these events:

- You close and then reopen a browser tab or window.
- The browser restarts, with or without session restore, or the browser crashes.
- Your sign-in session expires and you have to sign in again.

Restore is fully automatic. Sambee never asks the user to restore.

The plan has four parts:

- **1** – Keep the saved tabs when the session expires. Delete them only on explicit sign-out.
- **2** – Save the tabs of each Sambee page in `localStorage`, and find them again automatically.
- **4** – Do not save a temporary single-tab state before the restored tabs are applied.
- **5** – Update the documentation.

Part 3 (make `sessionStorage` smaller) is out of scope.

## Terms

| Term | Meaning |
| --- | --- |
| Folder tab | A tab in the Sambee pane tab bar |
| Sambee page | One browser tab that shows Sambee. One browser window can contain many Sambee pages. |
| Page ID | A random ID that identifies one Sambee page and its saved tabs |
| Live record | A saved tab record whose Sambee page is open now |
| Closed record | A saved tab record whose Sambee page is closed |

## Problem Summary

| Symptom | Cause |
| --- | --- |
| Ctrl+Shift+T after closing a window restores only the selected folder tab of each pane (Firefox) | Tabs are saved only in `sessionStorage` (`sambee:pane-tabs-session`). Firefox does not save any `sessionStorage` for restore if the site stores more than `browser.sessionstore.dom_storage_limit` (2,048 bytes). Sambee stores about 14.5 KB with one folder tab. The URL holds only the selected location of each pane. |
| Tabs are lost after a browser restart without session restore, or when Sambee opens from a bookmark or a typed URL | A new page always gets an empty `sessionStorage`. |
| Tabs are lost after session expiry, in every browser | `authSession.clear()` calls the clear listener in `tabSessionStorage.ts`, which deletes records with `userScope !== null`. Then the page goes to `/login`. |
| On first load, one save writes the default single folder tab before the restored tabs apply | The save effect runs in the same commit as the hydration effect. It reads `leftPane.tabs` from the render before hydration. |

### Events that clear the saved tabs today

All of these call `authSession.clear()`, so the clear listener deletes the saved tabs:

| Event | Code |
| --- | --- |
| The server does not renew the session (OIDC refresh returns `401`, for example because the refresh session expired or the server revoked it) | `performRefreshRequest` in `frontend/src/services/authSession.ts` |
| The absolute OIDC session limit (`oidc_session_expires_at`) is reached | `requireReauthentication` in `authSession.ts` |
| A new sign-in starts on the sign-in page | `requestRefresh({ newLogin: true })` in `frontend/src/pages/Login.tsx` |
| An administrator changes the authentication mode, and the change needs a new sign-in | `frontend/src/pages/AuthenticationSettings.tsx` |
| Explicit sign-out | `clearCurrentBrowserSession` in `frontend/src/services/accountSession.ts` |

Only explicit sign-out must delete the saved tabs.

Relevant code:

- `frontend/src/pages/FileBrowser/tabSessionStorage.ts`: record format, validation, load, save, and restore precedence
- `frontend/src/pages/FileBrowser.tsx`: `initialPaneTabsSessionRef`, `syncResolvedRoute`, `restoreInitialRecoverySnapshot`, `reconcileBootstrapRoute`, and the save effect
- `frontend/src/services/accountSession.ts`: explicit sign-out cleanup
- `frontend/src/services/authSession.ts`: `clear()` and clear listeners
- `frontend/src/services/editLockRecovery.ts`: an existing per-page exclusive Web Lock

## 1 – Keep Tabs Through Session Expiry

### Target Behavior

- Session expiry, forced sign-in, and authentication-mode changes do not delete saved tabs.
- After you sign in again, the same Sambee page restores all its folder tabs.
- Explicit sign-out deletes all saved tab records of the signed-out user (see [Sign-out](#sign-out)).
- Records are filtered by user scope (`authSession.getUserId()`). A different user never sees or restores another user's tabs.

### Changes

- Remove the `authSession.subscribeToClear` listener from `tabSessionStorage.ts`.
- Keep the cleanup in `clearCurrentBrowserSession`, and change it to delete the `localStorage` records (part 2).
- Loading ignores records of other users. It does not delete them, because each user has separate records.

### Why this is safe

The user-scope check on load already blocks restore for a different user. Folder paths are not credentials. The sign-out path still deletes them.

## 2 – Per-Page Tab Records in `localStorage`

### Target Behavior

- The design works per **Sambee page**, not per browser window. A web page cannot detect which window it is in. Each Sambee page has its own page ID and its own record. Example: one window with 10 Sambee pages, each with 20 folder tabs, has 10 records.
- Every restore case is automatic:

| Case | Result |
| --- | --- |
| Reload (F5) | The page restores its own record. |
| Close a Sambee page or window, then Ctrl+Shift+T | Each restored page restores its own record. |
| Browser restart or crash with session restore | Each restored page restores its own record. |
| Browser restart without session restore, a bookmark, a typed URL, or a new browser tab | The page takes the most recent closed record (see the startup rules). |
| Session expiry, then sign-in | The same page restores its own record. |
| Duplicate a browser tab | The copy gets a new page ID and a copy of the record. After that, the two pages change independently. |
| Two Sambee pages are open at the same time | Each page keeps its own folder tabs. Nothing is merged. |

### Storage Layout

| Data | Location | Why |
| --- | --- | --- |
| Tab record | `localStorage` key `sambee:workspace-tabs:<pageId>` | It survives window close, restart, and crash in all browsers. |
| Page ID | `sessionStorage` key `sambee:workspace-page-id` | It survives reload and sign-in redirects in the same browser tab. |
| Page ID | `history.state`, namespaced key `sambeeWorkspacePageId` on the current history entry | Chromium and Firefox restore `history.state` when they reopen a closed tab or window or restore a session. The Firefox 2 KB `sessionStorage` limit does not apply to it. |

#### One copy of the tab data

- The `localStorage` record is the only copy of the folder tabs. It is used for every case, including reload.
- Sambee no longer writes the folder tabs to `sessionStorage`. The `sambee:pane-tabs-session` key is removed (see [Migration](#migration)).
- `sessionStorage` and `history.state` contain only the page ID, a short reference to the record. They do not contain tab data.
- The page ID is stored in two places because each place covers cases that the other does not:
  - `history.state` survives Ctrl+Shift+T and session restore, also in Firefox. It does not survive the sign-in redirect, because `window.location.assign("/login?...")` and the return to the file browser create new history entries without this state.
  - `sessionStorage` survives the sign-in redirect in the same browser tab. Firefox does not restore it after the window closes.

The record never contains folder listings or credentials. The folder-listing recovery snapshot stays in `sessionStorage`.

### Record Format (schema 2)

The schema-1 record stores the same information more than once. Schema 2 stores each piece of information only one time, and Sambee derives the rest when it restores the tabs.

Example record with two folder tabs in the left pane: one folder tab at a folder and one inside a ZIP archive.

```json
{
  "schemaVersion": 2,
  "userScope": "<user ID or null>",
  "updatedAt": 1795000000000,
  "paneMode": "dual",
  "activePaneId": "left",
  "left": {
    "selectedTabId": "<tab ID>",
    "tabs": [
      { "id": "<tab ID>", "kind": "smb", "targetId": "demo", "path": "Projects/2026" },
      {
        "id": "<tab ID>",
        "kind": "local",
        "targetId": "<drive ID>",
        "archive": { "sourcePath": "Downloads/data.zip", "virtualPath": "docs" },
        "sortBy": "size",
        "sortDirection": "desc"
      }
    ]
  },
  "right": null
}
```

| Schema-1 field | Schema 2 | Why it is safe |
| --- | --- | --- |
| `left.orderedIds`, `right.orderedIds` | Removed. The order of the `tabs` array is the tab order. | `orderedIds` repeats every tab ID. |
| `location.connectionId` | Removed. Resolve `kind` and `targetId` with `resolveBrowseRouteTarget()`. | The SMB connection slug is set one time when the connection is created (`generate_unique_connection_slug` in `backend/app/api/connections.py`). `ConnectionUpdate` cannot change it. So the slug identifies the connection as reliably as the UUID. For local drives, the connection ID is `local-drive:<targetId>`. |
| `location.physicalPath` | Removed. For a folder, it is `path`. For an archive, it is the parent folder of `archive.sourcePath`. | `applyIncomingTargetToSelectedTab()` already derives it like this. Move this logic into one shared function and use it for the URL and for restore. |
| `location.archiveLocation` | Replaced by the optional `archive` field. | It repeats `target.virtualLocation`. |
| `target.path` for an archive | Omitted. `path` is present only for a folder tab without `archive`. | For an archive, `target.path` is `sourcePath` + `virtualPath`. The route path alone cannot show where the archive path ends, so `archive` keeps both values. |
| `sortBy`, `sortDirection` | Omitted when the value is the default (`name`, `asc`). | Today, `createEmptyTabSession()` writes the defaults as literal strings. Add shared constants (for example `DEFAULT_TAB_SORT_FIELD` and `DEFAULT_TAB_SORT_DIRECTION`) in `tabSessions.ts`, and use them in `createEmptyTabSession()`, in the save code, and in the restore code. |
| `workspaceRouteIdentity` | Removed. Calculate it from the selected tab of each visible pane, `paneMode`, and `activePaneId` with `getWorkspaceBrowseIdentity()`. | It repeats the selected locations. |
| `pageId` (proposed earlier as a new field) | Not added. | The `localStorage` key already contains it. |

The tab IDs stay UUIDs. Back/Forward history entries refer to them (`sambeePaneTabs`).

A record for a missing SMB connection does not need a separate fallback. The stored `kind` and `targetId` are the fallback target. Today, `fallbackTargets` and `unresolvedTabTargetsRef` keep that target in memory only for the next save.

#### Size

Measured with the same sample data: 20 folder tabs (10 in each pane) and a 42-character path in each tab.

| Format | One folder tab | Record with 20 folder tabs |
| --- | --- | --- |
| Schema 1 | 366 characters | 7,779 characters |
| Schema 2 | 129 characters | 2,864 characters (−63%) |
| Schema 2 with 8-character tab IDs (not recommended) | 101 characters | 2,248 characters (−71%) |

Short tab IDs would save only about 20% more. They would also need a new ID generator in `tabSessions.ts` and a check for duplicate IDs. This is not worth it.

The plan does not use these methods:

- Short JSON key names or arrays without keys: the records become hard to read and to debug, for a small gain.
- Compression (for example `lz-string`): it needs a new dependency and CPU time on every save, and the stored data cannot be read without tools.

### Ownership with Web Locks

- Each Sambee page holds an exclusive Web Lock `sambee:workspace-tabs:<pageId>` while it is open. The browser releases the lock when the page closes, reloads, or crashes.
- A record is **closed** when nobody holds its lock. `navigator.locks.query()` returns the held locks.
- A page **claims** a record with `navigator.locks.request(name, { ifAvailable: true })`. Only one page can get the lock, so two pages that start at the same time cannot claim the same record.
- This follows the pattern in `editLockRecovery.ts`.

### Startup Rules

The page runs these steps once, before the first hydration of the folder tabs:

1. Read the page ID from `sessionStorage`. If there is none, read it from `history.state`.
2. If a page ID was found, and a record for that ID exists with the current user scope:
   - If the page gets the lock, it restores the record. The precedence rules for a matching or different URL stay the same as today.
   - If another page holds the lock, the browser tab is a duplicate. The page makes a new page ID, copies the record under that ID, and claims it.
3. If no record was found, the page looks for closed records of the current user scope:
   - It tries the closed record whose calculated route identity (see [Record Format](#record-format-schema-2)) matches the URL first. Then it tries the others, newest `updatedAt` first.
   - It claims the first record whose lock it gets.
   - If the URL points to a location that is not visible in that record, the page opens that location in a **new** folder tab in the related pane and selects it. If a folder tab of that pane already shows the location, the page selects that tab. The page does not overwrite an existing folder tab.
4. If there is no closed record, the page makes a new page ID and starts with one folder tab, as it does today.
5. The page writes its page ID to `sessionStorage` and to the current `history.state` entry.

Reload keeps its current rule: if the URL differs from the record, the URL replaces the location of the selected folder tab. On reload, the user changed the URL of this page. When a page takes a closed record (step 3), the URL comes from a link or bookmark, so it opens in a new folder tab.

### Page ID in `history.state`

- Add one effect at the app root. It runs on every location change and calls `history.replaceState()` to add `sambeeWorkspacePageId` to the current entry if it is missing. It keeps the React Router fields (`usr`, `key`, `idx`).
- This covers all routes, including the viewer, editor, and settings routes. A page can be closed on any of these routes.
- The spike must confirm that Chromium and Firefox restore `history.state` for Ctrl+Shift+T and for session restore.

### Saving

- The existing save effect writes the record of the current page ID to `localStorage`, and sets `updatedAt` to the current time.
- The page saves the record again on `pagehide`, so the last state is stored.
- A page saves only while it holds its lock.

### Limits on Closed Records (instead of expiry)

Records do not expire after a fixed time. A record stays until one of these happens:

- A page claims it.
- The user signs out.
- The closed-record limit removes it.

A limit is necessary because Sambee cannot detect whether a page was closed by accident or on purpose. Each closed browser tab leaves one closed record. Without a limit, records collect without end and can fill the `localStorage` quota of the origin (about 5 MB).

- Constant `MAX_CLOSED_WORKSPACE_TAB_RECORDS` (proposed value: 50) for each user scope. This is similar to the "recently closed" list of a browser.
- Pruning removes the oldest closed records first. It runs at startup and when a save fails because of the quota.
- Pruning never removes live records.
- Size estimate (see [Size](#size)): one schema-2 record with 20 folder tabs uses about 2.9 K characters. 10 such open pages use about 29 K characters, and 50 closed records use about 145 K characters. This is much less than the `localStorage` quota.

### Sign-out

- `clearCurrentBrowserSession` deletes all `sambee:workspace-tabs:*` records of the signed-out user scope, both live and closed.
- It sends a message on a `BroadcastChannel` (`sambee-workspace-tabs`). Other Sambee pages of the same user stop saving and delete their own records. This stops an open page from writing its record again after sign-out.

### Fallback without Web Locks

Web Locks are available only in secure contexts (HTTPS and localhost). If Sambee is served over plain HTTP:

- Reload and the sign-in redirect still find the record through the page ID in `sessionStorage`.
- Ctrl+Shift+T and session restore still find the record through the page ID in `history.state`.
- To check if a page is open, the starting page sends a `BroadcastChannel` query and waits a short time (constant, proposed 250 ms) for replies from live pages. A page with no reply is treated as closed.
- Possible problem: a frozen or discarded page cannot reply. Then two pages can claim the same record, and the folder tabs appear in both pages. This makes a duplicate set of tabs, but no tabs are lost.

### Migration

- At startup, if the schema-1 key `sambee:pane-tabs-session` exists and the current page has no record, convert it to a schema-2 record for the current page ID. Then delete the old key.
- Only the migration step reads `sambee:pane-tabs-session`, and no code writes it. Remove the `sessionStorage` save function from `tabSessionStorage.ts`, and rename the module to show its new scope (for example `workspaceTabStorage.ts`). The migration step can be removed in a later release.

### Storage Unavailable

- There is no second copy in `sessionStorage` to fall back to. If `localStorage` is not available (for example, the browser blocks site storage), the folder tabs exist only in memory. They are lost when the page reloads or closes.
- Show the existing one-time notice. Change its text: folder tabs will not be restored after a reload or after the window closes, and the user can allow site storage for Sambee to fix this.
- Browsers that block site storage normally block `localStorage` and `sessionStorage` together. So a `sessionStorage` fallback would almost never help.

### Startup Timing

- Claiming a lock is asynchronous. Start the claim early, at the same time as the authentication bootstrap. Add a gate to `FileBrowser.tsx` so that hydration waits until the claim is complete, like the existing `recoveryPhase` and `loadingConnections` gates.
- The claim does not wait for the network. It must not cause a visible delay.

## 4 – No Early Single-Tab Save

### Problem

When `loadingConnections` changes to `false`, the hydration effect (`syncResolvedRoute`) and the save effect run in the same commit. The save effect reads `leftPane.tabs` and `rightPane.tabs` from the render before hydration, so it saves the default single folder tab. The next render saves the correct tabs. With `localStorage`, this temporary record would be visible to other pages and could be kept if the page closes at that moment.

### Change

- Add a `paneTabsHydrated` state. Set it in the same update batch as `hydrateTabs` (in `syncResolvedRoute` and in `restoreInitialRecoverySnapshot`), or immediately when there is no record to restore.
- The save effect does not run until `paneTabsHydrated` is `true`.

## 5 – Documentation

Follow the `docs-update` skill.

| Page | Change |
| --- | --- |
| `website/content/docs/3.0/user-guide/find-and-browse-files/connect-to-an-smb-share/index.md` | Update the "Last-tab protection and recovery" bullet. Describe automatic restore after reload, closing and reopening a window, browser restart, and a new sign-in. Say that sign-out deletes saved tabs. |
| `website/content/docs/3.0/user-guide/find-and-browse-files/dual-pane-mode/index.md` | Check the sentence about keeping right-pane tabs "for the current session". |
| `website/content/docs/3.0/developer-guide/frontend-architecture/file-browser-and-navigation-model/index.md` | Update the `tabSessionStorage.ts` row (new module name and `localStorage` scope) and the "URL, Back/Forward, and session restoration" bullet: per-page records, page ID, Web Locks, startup rules, closed-record limit, sign-out, and the fallback. |
| `website/content/docs/3.0/developer-guide/frontend-architecture/frontend-overview/index.md` | Update the bullet that describes "session-scoped `sessionStorage`". |
| `website/content/docs/3.0/release-info/news-and-changes/whats-new/index.md` | Add an entry for automatic folder tab restore. |

## Tests

Unit tests in `frontend/src/pages/FileBrowser/__tests__/tabSessionStorage.test.ts` (rename it together with the module). Use a Web Locks mock like the one in `frontend/src/services/storageBackends.test.ts`.

- The page restores its own record when it gets the lock.
- Saving writes the folder tabs only to `localStorage`. `sessionStorage` contains only the page ID. A reload restores all folder tabs from the `localStorage` record.
- A duplicate page (lock held by another page) gets a new page ID and a copy of the record.
- Without a page ID, the page claims the closed record that matches the URL first, then the newest closed record.
- Two pages that start at the same time do not claim the same closed record.
- A URL that is not in the claimed record opens in a new folder tab. A URL that matches an existing folder tab selects that tab.
- Records of other user scopes are ignored and are not deleted.
- `authSession.clear()` does not delete records. Sign-out deletes all records of the user and sends the broadcast message.
- Pruning removes the oldest closed records over the limit and never removes live records. A quota error causes a prune and one retry.
- A schema-1 record migrates correctly.
- Schema-2 save and restore give the same tab state for: an SMB folder, a local-drive folder, a folder tab inside a ZIP archive (correct physical folder and `archive` values), a tab with a non-default sort, and a tab of a missing SMB connection. Default sort values are not written.
- The workspace route identity calculated from a schema-2 record is equal to the schema-1 `workspaceRouteIdentity` for the same tabs.
- The fallback without Web Locks uses the `BroadcastChannel` liveness query.

Integration tests in `frontend/src/pages/__tests__/FileBrowser-pane-tabs.test.tsx`:

- Close and reopen simulation: clear `sessionStorage`, keep `localStorage` and `history.state`, mount again. All folder tabs in both panes are restored.
- Fresh open of `/browse` with a closed record restores it.
- Session expiry and sign-in in the same page restores all folder tabs.
- The first saved record after a restore of 3 folder tabs contains 3 folder tabs (part 4).

Manual checks in Firefox and in Chrome or Edge:

- Close a window with 2 panes and several folder tabs, then press Ctrl+Shift+T in another window.
- Restart the browser, with and without session restore.
- One window with 10 Sambee pages, each with several folder tabs: close the window, then reopen it.
- Duplicate a browser tab.
- Session expiry, then sign-in.
- Sign out in one page while other pages are open.
- Plain-HTTP deployment (no Web Locks).

## Implementation Order

1. Spike: confirm that Firefox and Chromium restore `history.state` for Ctrl+Shift+T and for session restore.
2. Part 4 (small and independent).
3. Part 1.
4. Part 2: storage module and unit tests, then the startup gate and `FileBrowser.tsx` integration, then the `history.state` effect, then sign-out and the broadcast message.
5. Part 5.
