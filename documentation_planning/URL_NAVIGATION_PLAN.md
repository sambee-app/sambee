# URL-Driven Workspace Navigation

Status: Implemented. See implementation and verification results below.

## Implementation and Verification

The shared route model now controls viewers, gallery navigation, editing intent,
and desktop/mobile settings. Recovery is subordinate to the incoming URL. The app
uses a data router, supported edit blocking, and router-owned authentication
cleanup and User Management queries. Shared settings identifiers are independent
of translated presentation metadata.

- All 2,180 frontend tests pass across 157 suites, including routed history,
  direct links, dirty-editor decisions, slow lock release, late acquisition,
  authentication-fragment cleanup, recovery precedence, gallery navigation,
  invalid descriptors, and mobile settings history.
- Frontend lint passes without errors or warnings. The production build passes
  with a bundle-size advisory for large chunks.
- Documentation content validation passes. The 2.0 user and developer guides
  describe the URL contract and navigation behavior.
- Live settings category navigation, Back/Forward, explicit Close, refresh, and
  direct-link parent fallback were checked on the permitted demo connection at
  desktop and phone widths.
- Live file-viewer/editor validation remains blocked: the demo SMB directory
  returns a missing-directory error. Cached file rows aren't evidence of current
  file availability; automated coverage doesn't substitute for that live check.

The investigation and design below record the original behavior and agreed
implementation contract.

## Goal

Make meaningful workspace navigation bookmarkable and support browser Back and
Forward consistently on desktop and mobile:

- Open a file in a viewer.
- Switch between viewing and editing.
- Open settings and navigate between settings pages.
- Navigate between files within a viewer gallery.

Keep the file browser mounted underneath overlays so opening and closing them
does not unnecessarily reset pane selection, scroll, directory caches, or focus.
Transient controls such as menus, tooltips, zoom, and viewer search panels remain
local UI state. This work does not make every operation or confirmation dialog
independently addressable.

## Current Behavior and Evidence

- `frontend/src/pages/FileBrowser/useFileBrowserPane.ts` opens and closes viewers
  through `viewInfo` state, without creating a browser-history entry.
- `frontend/src/components/Viewer/TextViewer.tsx` and `MarkdownViewer.tsx` keep
  edit mode locally. Existing Save/Discard/Cancel behavior is not connected to
  router navigation.
- `frontend/src/components/Settings/SettingsDialog.tsx` owns desktop category
  selection; `frontend/src/components/Mobile/MobileSettingsDrawer.tsx` owns the
  mobile settings view.
- `frontend/src/pages/FileBrowser.tsx` consumes `?settings=<category>` and removes
  it using replacement navigation. It is an opening instruction rather than
  persistent settings location state.
- `frontend/src/App.tsx` also declares standalone `/settings/...` routes. Its
  route table omits SMB, File Search, and About categories supported by the
  settings navigation map and overlay content.
- `frontend/src/pages/FileBrowser/routing.ts` parses and serializes directory
  targets, the second pane, and the active pane. Serialization currently rebuilds
  only those parameters, so adding overlay parameters separately would allow
  normal route updates to erase them.
- `frontend/src/pages/UserManagementSettings.tsx` directly updates browser history
  for its directory query. Those writes bypass React Router and must be reconciled
  with routed settings and navigation blocking.
- `frontend/src/pages/AuthenticationSettings.tsx` removes the OIDC setup fragment
  with `history.replaceState(null, ...)`. That clears router history indices,
  location keys, and application return metadata even though the pathname and
  query remain unchanged. Login and OIDC callback cleanup also need auditing.
- `frontend/src/pages/FileBrowser.tsx` loads a recovery snapshot before resolving
  the incoming location and replaces a different incoming URL with the saved route.
  Snapshot capture serializes directory/pane state separately from saved viewer
  state. Both behaviors conflict with a URL-authoritative workspace.
- The app uses `BrowserRouter`. The installed React Router implementation requires
  a data router for `useBlocker`. Its POP blocking also requires intact router
  history indices; clearing history state can make blocking fail silently.

Investigation baseline, before implementation:

- 31 tests passed in `FileBrowser-url-routing.test.tsx`.
- 104 tests passed across `FileBrowser-viewer.test.tsx`, `TextViewer.test.tsx`, and
  `MarkdownViewer.test.tsx`.
- Live reproduction was inconclusive: the permitted demo SMB connection returned
  a missing-directory error. Automated tests and source inspection do not establish
  working mobile browser-history behavior.

## Proposed Architecture

### 1. Extend the Existing Route Model

Extend the existing typed parser and serializer rather than introducing another
router, custom `popstate` interception, or scattered query-string writers.

Keep the existing directory paths, `p2`, and active-pane conventions compatible.
Add a validated optional workspace navigation descriptor containing:

| State | Required information |
| --- | --- |
| Viewer | Full file target, owning pane, selected viewer |
| Editor | Same file target and viewer, plus edit mode |
| Settings | Main settings view or a category identifier |
| Settings page state | Existing page-specific parameters where applicable |

Use query parameters for overlays so the directory route remains mounted.
Suggested keys are `file`, `viewer`, `mode`, `pane`, and `settings`; finalize the
encoding in the route model and its round-trip tests before wiring components.
Use `URLSearchParams` and existing path encoding helpers.

The file target must identify the storage target and physical path or virtual
archive-member location independently of the directory being displayed. Do not
infer it solely from the active pane: recent-file and search results may point
elsewhere. Persist only stable identity and navigation mode, not file contents,
edit-session tokens, MIME guesses, gallery arrays, or runtime viewer session IDs.

Preserve unrelated query parameters and authentication callback fragments.
Validate enum values, target kinds, pane references, and supported combinations.
Use replacement navigation to recover invalid state without adding a history loop.

### 2. Let the URL Control Navigation State

Render the requested viewer, editor mode, and settings category from the parsed
route. Components request transitions through navigation callbacks rather than
independently setting navigation state and then synchronizing it back to the URL.

Keep fetched content, loading state, edit-session resources, drafts, selection,
scroll, and focus local. Existing `viewInfo` can remain a resolved runtime
representation, but it must not compete with the URL as the navigation authority.

Resolve direct links through the existing storage/content-provider abstractions,
not simulated file-row clicks. Resolve metadata and capabilities, then load the
requested viewer. Handle missing targets, unavailable local drives, denied access,
unsupported viewers, and archive members explicitly with useful recovery actions.
Do not fall back to opening a native application because a deep link requested a
browser viewer.

Make asynchronous resolution cancelable or reject stale results when navigation
changes. Overlay-only transitions must not reset directory listings or start a
new viewer content session unnecessarily.

### 3. Make Recovery Subordinate to the Incoming URL

Establish this startup rule before wiring URL-driven viewers: the current URL
selects the workspace; recovery snapshots may only accelerate or enrich that
workspace. Neither a fresh-tab bookmark nor a same-tab navigation, refresh,
authentication return, or Back/Forward traversal may be redirected to a different
location merely because a snapshot exists.

Apply recovery in this order:

1. Parse and validate the incoming navigation descriptor, retaining unresolved
  storage identities until connection/provider discovery completes. Do not treat
  an unresolved target as permission to use the snapshot's target.
2. Normalize the requested location using the shared route rules. Invalid or
  unavailable targets use the documented route recovery/error behavior, never an
  unrelated snapshot route.
3. Match snapshot data to the requested resource identities. Hydrate directory
  cache, selection, focus, and scroll only for matching pane locations, including
  archive/provider identity. An unmatched pane follows normal loading. Restore
  active pane and overlay intent only from the URL, not snapshot preferences.
4. Resolve the requested viewer and edit intent through the normal capability,
  loading, and lock-acquisition path. Ignore legacy saved `viewInfo` when the URL
  does not request it; never restore an edit session, lock, or runtime session ID.
5. Revalidate hydrated data through existing recovery mechanisms. Tie hydration
  and revalidation to the current route identity/token so late results cannot
  restore an old pane, viewer, or category after navigation.

Remove the unconditional replacement navigation to `snapshot.routeUrl`. A bare
`/browse` follows the normal default-directory policy without reviving snapshot
overlays. If resuming a different saved workspace is offered, it must be an
explicit user navigation through the same parser, permissions, and guard path;
do not add an automatic-resume heuristic based on reload detection or history keys.

Capture the canonical navigation descriptor from the current routed workspace,
not a separately reconstructed directory-only URL. Keep snapshot resource data
consistent with that descriptor; do not persist partially transitioned state.
Store no authentication flow fragments or edit-session secrets. Continue handling
expired, malformed, unavailable, and older snapshots defensively: ignore unusable
data and load the requested location normally. Existing draft recovery remains a
separate, resource-scoped recovery opportunity, not authority to change the URL.

### 4. Unify Settings Navigation

Make desktop and mobile settings navigation containers controlled by routed state.
Reuse `settingsNavigation.ts` category definitions and `SettingsCategoryContent`
instead of maintaining different content maps for routes and overlays.

Retain existing `/settings/...` links and aliases through the same category
definitions and rendering rules. Ensure every supported category has a working
direct link and consistent authorization. Opening settings from the browser must
preserve the underlying directory and pane context.

Move User Management query updates to React Router navigation and merge its
page-specific parameters without dropping workspace navigation parameters.
Preserve existing authentication callback fragments and return destinations.
Consume and remove a completed authentication fragment only through the
router-safe cleanup described below.

Responsive presentation must not create history entries or change the selected
settings category. Desktop may use the main settings URL to display its default
category while mobile displays the settings category list.

### 5. Define History and Dismissal Semantics

| Action | History behavior |
| --- | --- |
| Open viewer | Push viewer location |
| Enter editor | Push edit location |
| Open settings | Push settings location |
| Select another settings category | Push category location |
| Gallery next/previous | Push displayed-file location |
| Repeat current navigation | No duplicate entry |
| Canonicalize or recover invalid state | Replace current entry |
| Change pane focus only | Preserve existing replacement behavior |
| Browser Back/Forward | Follow actual history |

Expected sequence: list -> viewer -> editor. Back returns to viewer, then list;
Forward restores those navigation locations, subject to current capabilities.

Escape keeps its existing priority: close viewer search first, leave editing
through its guard, then close the viewer. Explicit settings Close returns to the
underlying workspace even after several settings category changes. Mobile settings
Back should follow routed navigation, with a deterministic parent fallback for a
direct link.

Track app-created return entries in router navigation state, separate from the
bookmarkable URL. When a valid return entry exists, traverse back to it so Forward
can reopen the overlay. Otherwise replace with the deterministic parent URL. Do
not infer a safe return destination from `history.length`; the previous entry may
be login or another website. URL rendering must work without return-entry metadata.

Restore focus to the file last displayed in its owning pane when the viewer closes.
Preserve selection and scroll when opening and closing settings.

### 6. Guard Navigation Away From Edits

Migrate the existing route tree to `createBrowserRouter` and `RouterProvider` to
use React Router's supported `useBlocker`. This is a router setup change, not a
rewrite of route components into loaders or actions.

Complete a focused audit of production `pushState`, `replaceState`, and fragment
writes during this migration, before relying on navigation blocking. In
particular, cover User Management query changes and fragment cleanup in
Authentication Settings, Login, and the OIDC callback. Do not limit the audit to
writes that visibly change pages: URL housekeeping can erase router bookkeeping.

While a router owns the location, use its navigation APIs for both navigation and
cleanup. Authentication fragment cleanup must replace the current entry, preserve
the pathname, complete query, and application-owned location state, and remove
only the consumed callback data. Record the flow identifier using the existing
authentication lifecycle before removing it; preserve return destinations and
existing finalization/replay safeguards. Do not retain consumed secrets in new
URLs, navigation metadata, logs, or recovery snapshots.

Let React Router manage its own history indices and location keys; never clear or
manually fabricate those fields. If cleanup must run before router initialization,
perform it before creating the router and preserve existing `history.state`
instead of replacing it with `null`. Do not use pre-router cleanup as a workaround
inside a mounted route. A location replacement must preserve or explicitly
invalidate application return-entry metadata according to the return-target
contract, never silently erase it.

User Management must read query state from router location updates rather than a
parallel `popstate` listener. Verify that query navigation and authentication
cleanup do not add spurious history entries or invalidate safe overlay dismissal.

Use one navigation-guard owner for the active editing workspace. Reuse the existing
Save/Discard/Cancel dialog when a transition would leave a dirty edit session,
including browser Back/Forward, links, file changes, and close actions:

- Cancel resets the blocked transition and preserves the editor and draft.
- Successful Save or Discard continues the original blocked transition.
- Failed Save retains the editor, draft, and actionable error.
- Navigation that does not leave the editing resource must not discard its draft.

Release edit-session resources when actually leaving editing, not when navigation
is merely requested. Avoid duplicate lock requests and handle navigation during
lock acquisition or saving. Add `beforeunload` protection for dirty drafts on
reload/tab close; this is distinct from in-app navigation blocking.

For edit-mode bookmarks and Forward navigation, load the file, check permissions
and size/capability limits, and acquire a fresh edit session before presenting a
usable editor. On failure, show an actionable error and a valid view-mode recovery
path. A URL never grants permission or restores a stale lock.

## Implementation Order

1. Define route descriptors, encoding, normalization, and parser/serializer tests.
  Establish incoming-URL precedence over snapshots and implement resource-matched
  recovery hydration before introducing any URL-driven overlay behavior.
2. Migrate router setup and test harnesses; audit and migrate router-active history
  writes, including User Management queries and authentication fragment cleanup.
  Verify replacement/state preservation, then establish the navigation guard
  contract against intact router history entries.
3. Route viewer opening, closing, gallery changes, and direct-link restoration.
  Capture the complete canonical routed workspace in recovery snapshots and test
  it with stale and legacy snapshots present.
4. Route edit-mode transitions and connect existing unsaved-change dialogs. Verify
  real history traversal and edit-lock lifecycle after authentication cleanup.
5. Control settings navigation from the route and reconcile standalone links;
  verify query-state and OIDC-flow behavior inside the routed settings containers.
6. Complete focus restoration, relevant documentation, and browser-level regression
  coverage. Recovery precedence and router history integrity are earlier gates,
  not deferred cleanup tasks.

Keep each stage behavior-tested before proceeding. No backend or dependency
changes are assumed necessary.

## Acceptance Tests

- Parser/serializer round trips cover Unicode, spaces, percent signs, encoded
  separators, malformed targets, both panes, and archive members.
- Open viewer -> Back closes it without changing directory -> Forward reopens it.
- Viewer -> editor -> Back returns to viewer -> Forward reacquires editing safely.
- Fresh-tab bookmarks and refresh restore viewer, editor intent, and settings
  category without relying on prior row clicks or router navigation state.
- Settings main/category/category transitions support Back and Forward. Explicit
  Close returns to the workspace; direct-link dismissal stays inside the app.
- All settings categories and existing `/settings/...` links remain usable,
  including SMB, File Search, About, and authorization-restricted categories.
- User Management query changes preserve overlay state and work with Back/Forward.
- Authentication fragment cleanup replaces rather than pushes an entry, retains
  the full workspace query and application location state, and removes consumed
  flow data without breaking finalization or authentication return destinations.
- In a data-router integration test, navigate from the browser into Authentication
  Settings with a flow fragment, let cleanup complete, then use Back/Forward and
  explicit Close. Assert correct destinations, usable return metadata, and no
  untracked-POP warnings. Returning to the cleaned entry must retain router-managed
  history bookkeeping; do not assert that its location key stays unchanged.
- After authentication cleanup, open a text or Markdown editor, make it dirty,
  and traverse history across the cleaned entry. Verify Cancel, Save, Discard,
  and failed Save still guard the original transition. Include repeated Back and
  replacement/query navigation so corrupt or duplicate history indices cannot
  hide behind a single successful traversal.
- Dirty editors exercise Save, Discard, Cancel, failed saves, repeated Back, and
  navigation during lock acquisition/saving. Reload/tab close gets native warning
  protection; draft recovery continues to work.
- Right-pane and recent/search file targets reopen the correct resource. Gallery
  navigation updates the URL and restores the correct file through history.
- Missing files, unavailable drives, denied access, unsupported viewers, stale
  asynchronous responses, and edit-lock conflicts do not cause loops or silent loss.
- Responsive changes preserve routed state. Returning to the browser restores
  focus, selection, and scroll without needless listing/content reloads.
- Authentication redirects preserve the complete requested workspace URL.
- With a snapshot for workspace A in the current tab, navigate to a bookmark for
  workspace B and verify that B wins before hydration and after revalidation.
  Cover refresh, authentication return, Back/Forward, and fresh tabs with absent
  or copied session storage; do not assume a fresh tab necessarily has a snapshot.
- Matching snapshots restore only resource-matched pane data. Mismatched pane,
  connection, archive/member, viewer, editor, and settings state cannot override the
  requested URL. Late hydration results after navigation are ignored.
- A matching directory snapshot containing legacy viewer state does not open a
  viewer from a list-only URL. An edit URL acquires a fresh session even when a
  snapshot contains viewer data. Bare `/browse`, invalid/expired/legacy snapshots,
  unavailable targets, and storage failures follow the normal route/loading policy
  without snapshot redirects or loops.
- Capture and reload a workspace containing a viewer/editor or settings category
  with dual panes. Verify that the stored canonical descriptor matches the routed
  navigation state and no directory-only recovery URL strips the requested overlay.
  Assert that snapshots contain neither callback secrets nor edit-session tokens.

Run the focused existing and new tests, the normal frontend production build, and
frontend lint. Validate real Back/Forward and refresh at desktop and phone widths
using only `http://localhost:3000/browse/smb/demo` as the test connection. If that
connection remains unavailable, report live validation as blocked rather than
treating mocked tests as a substitute.

## Documentation

During implementation, update applicable user and developer documentation under
`website/content/docs/`, following the docs-update skill. Document bookmarkable
locations, Back/Forward behavior, dismissal fallbacks, unsaved-edit protection, and
the shared route/navigation contract. This planning document is not published
product documentation and does not claim the behavior already exists.
