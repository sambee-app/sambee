# Pane Tabs: UI, UX, and Implementation Plan

## Status and Purpose

This is a proposed implementation plan, not documentation of a released feature.

The feature adds independent folder tabs to each Sambee pane. Users can keep several browsing positions open without losing their selections or scroll positions.

Horizontal space is a primary design constraint, especially in dual-pane mode. Use compact titles and controls so each pane can show several useful tabs. Scroll when needed instead of spending width on separate icon slots, repeated location details, or navigation buttons.

This change does not add document tabs. File viewers and editors keep their existing workspace behavior.

## 1. Scope

### Include in the First Version

- Independent ordered tab collections in both panes.
- Create, select, and close actions.
- Independent browsing state for tabs at different or identical locations.
- A non-focusable tab bar above non-focusable breadcrumbs.
- Mouse, touch, and file-list keyboard operation.
- Compact content-sized tabs with close controls overlaid on their titles.
- Horizontal overflow with an always-visible add button.
- Undo the most recent tab close.
- Restore tab locations and order after a reload in the same browser session.
- Correct URL, browser-history, viewer, operation, and real-time-update behavior.
- Equal support for SMB connections, local drives, and supported archive locations.
- Updated shortcut help and directly related published documentation.

### Defer

- Drag reordering and moving tabs between panes.
- Pinned or locked tabs.
- Tab groups, custom names, and custom colors.
- Multi-row tab bars and an all-tabs picker.
- File drops onto tab headers.
- New modifier-click gestures on file rows.
- Document tabs, cross-device restoration, and account-level tab settings.

Do not add settings for first-version tab behavior. Use one consistent interaction model.

## 2. UI Structure

Each visible pane has its own tab bar, breadcrumb row, content area, and existing status information.

```text
Shared connection, pane, view, and sort controls

LEFT PANE                               RIGHT PANE
+-----------------------------------+   +-----------------------------------+
| [Images][Test][Reports]       [+] |   | [Demo][Exports]                [+] |
+-----------------------------------+   +-----------------------------------+
| Demo / Test                       |   | Demo / Exports                    |
+-----------------------------------+   +-----------------------------------+
|                                   |   |                                   |
| Files in Test                     |   | Files in Exports                  |
|                                   |   |                                   |
+-----------------------------------+   +-----------------------------------+

Shared file-operation controls and existing per-pane status information
```

The diagram omits close icons because they do not have their own layout space. Each visible close icon overlays the trailing end of its tab title. The add button immediately follows the tabs when they fit; the diagram's space before it is not a required spacer.

Do not add folder icons, connection badges, tab numbers, or persistent status icons to individual headers. Keep location details in breadcrumbs and hover tooltips, and loading/error details in the existing content surfaces.

### Selection, Active Pane, and Focus

These are separate states:

| State | Meaning | Visual treatment |
|---|---|---|
| Selected tab | The tab displayed within one pane. | Distinct background and border that connect it to the content below. |
| Active pane | The pane that receives shared toolbar commands. | Sambee's existing active-pane treatment, adjusted only where needed for the new layout. |
| Keyboard focus | The element that receives keyboard input. | Existing file-list and row focus treatment. Never a tab-header focus ring. |

Both panes always have a selected tab. Only one visible pane is active.

Do not rely only on yellow to identify the selected tab. A selected tab must remain clear in the inactive pane and in all supported themes.

### Compact Geometry

Use a single tab row even when only one tab exists. Do not hide the bar or change its height when tabs are created or closed.

Tab width follows the title plus small symmetric padding, clamped to a compact range. The close button must not participate in width calculation. Do not assign equal widths or stretch tabs to fill unused space.

Use these as initial design targets, then reuse the nearest suitable theme tokens. Minimum widths are interaction safety limits, not preferred widths:

| Element | Mouse layout | Touch-friendly layout |
|---|---:|---:|
| Tab-bar height | 36 px | 48 px |
| Minimum width of a closable tab | 56 px | 88 px |
| Tab maximum width | 160 px | 160 px |
| Title padding at each inline edge | 6 px | 6 px |
| Gap between tabs | 0 px | 0 px |
| Add and close target | At least 24 by 24 px | At least 44 by 44 px |

The touch minimum leaves at least 44 px of unobstructed tab-selection width beside the 44 px close target. The two hit regions must not overlap. The mouse minimum similarly leaves at least 24 px for selection beside the close target.

The only remaining tab needs no close target and may use a smaller content-sized width, subject to the applicable selection-target minimum.

Clamp the maximum tab width to the available strip width as well. A selected tab must fit completely beside the add control at supported pane widths. When space is tight, show fewer tabs, not smaller hit targets.

Define new dimensions centrally. Do not scatter literal dimensions through components.

### Close Overlay, Not a Reserved Slot

- Position the close control absolutely at the inline end of the tab, centered vertically.
- Lay out the title across the tab's normal inner width. Do not add a close column, extra title padding, or a permanent blank suffix for the button.
- When the control is visible, cover only the title beneath its hit region with an opaque surface matching that tab's current background.
- Use a short fade at the overlay's inner edge to soften the text cutoff without making the close icon translucent.
- Match selected, unselected, hover, and theme backgrounds. Do not leave text visible through the icon.
- Showing or hiding the overlay must not change tab widths, label layout, neighboring positions, or strip scroll offset.
- Keep the button's hit target larger than the glyph. Do not reduce the touch target to save title space.

The intentional trade-off is that the end of a title can be covered while the close control is visible. Preserve the leading part of the title; use the full accessible name, hover tooltip, and selected tab's breadcrumbs for the complete location.

## 3. Labels and Location Information

- Use the current folder name as the tab label.
- At a connection or drive root, use the connection or drive name.
- In an archive, use the current archive-folder name, or the archive name at its root.
- Do not append parent paths or connection suffixes to visible labels, even when names match. Repeated context consumes scarce width; show it in the full accessible name and hover tooltip instead.
- Allow exact duplicate locations. They can hold different selections and scroll positions.
- Shorten long labels with a trailing ellipsis without changing their accessible names. The close overlay may cover that ellipsis while visible.
- Use existing grapheme-aware identifier helpers where shortening is required. Preserve Unicode names and bidirectional text.
- Show the complete connection and path in a hover tooltip. Do not make the header focusable to expose the tooltip.
- Keep breadcrumbs available below the tab bar so touch users can inspect and navigate the selected location.

Matching visible names are allowed. Users can select a tab to inspect its breadcrumbs without losing that tab's saved browsing state. Do not add another title row or widen all tabs to distinguish an occasional collision.

Tab labels follow the committed location. If navigation is pending, show pending state in the existing content area without presenting old files as the contents of a new location. Do not reserve a spinner or error-icon slot in each header.

## 4. Creating Tabs

### Add Button

Place the add button immediately after the tabs when they fit. On overflow, keep it at the right edge outside the scrollable strip.

Use one compact icon-only control per pane with no visible text label or wide container padding. Reserve only its applicable hit-target width; do not allocate another toolbar-sized section.

Its accessible label is "New tab". Its tooltip includes the configured shortcut.

On activation:

1. Capture the selected tab and its committed location.
1. Insert a new tab immediately to its right.
1. Copy the location, including virtual-provider and archive information.
1. Copy its sort settings, but not its selection, scroll position, dialogs, or pending operations.
1. Make the pane active and select the new tab.
1. Reveal the new header in the strip.
1. Focus the new tab's file-list container when it is committed to the DOM.

Use existing view-mode preference scope. Do not turn a shared preference into a tab-local preference as a side effect of this feature.

Start at the top with no selected files. Focus the first available row through the existing list behavior.

A tab may share cached immutable listing data, but its selection, focus, history, and pagination state must remain independent.

## 5. Selecting Tabs

Clicking or tapping a tab:

1. Makes that pane active.
1. Selects that tab.
1. Restores its browsing state.
1. Updates breadcrumbs, toolbar context, quick-bar context, and status information consistently.
1. Returns keyboard focus to its file-list container without an unexpected page scroll.

The other pane does not change.

Do not activate a tab on hover. Do not use delayed hover switching.

If the selected tab is activated again, keep its state unchanged and return focus to its file list.

The close overlay owns only its own hit region. The remaining title area selects the tab. A tap on an always-visible close target closes the tab directly; it must not select the tab first or require a second tap.

## 6. Closing Tabs and Undo

### Close Controls

On fine-pointer devices with reliable hover, show the close overlay only on the hovered tab, including when that tab is selected. Hide it when the pointer leaves so the title can use the full width.

On touch devices, devices without reliable hover, and when touch-friendly controls are enabled, always show the close overlay on every closable tab, selected or not. Do not require a hover, long press, or first selection to reveal it. Prefer this behavior on mixed-input devices that support touch.

Always-visible touch controls intentionally cover part of the title; they do not get a reserved slot or cause all touch tabs to become wide. Preserve the safe selection and close targets defined in Compact Geometry.

Use the label "Close <tab name> tab", with enough location information to distinguish otherwise identical targets.

Use the existing close icon. The close control must not also activate the surrounding tab. Render selection and close as sibling controls within a positioned wrapper; do not nest interactive buttons.

Activate close on a completed click or tap, not on pointer down. A swipe or scrollbar drag must never close a tab. Hidden mouse overlays must not intercept clicks through an invisible hit region.

Clip the overlay to its own tab and the strip viewport. Do not let a close control cover the next tab or the add button. Do not offer a partially clipped close target at a viewport edge: reveal the tab by scrolling or selecting its exposed title before allowing pointer close.

### Selection Rules

| Closed tab | Result |
|---|---|
| Selected tab with a left neighbor | Select the left neighbor. |
| Selected first tab with a right neighbor | Select the right neighbor. |
| Unselected tab | Preserve the selected tab. |
| Only remaining tab | Do not close it. |

Keep at least one tab in each pane, including a temporarily hidden pane. Omit the close control for the last tab.

After closing a selected tab, focus the replacement tab's file list. Closing a background tab must not make an inactive pane active or steal focus from the other pane.

An attempted keyboard close of the last tab leaves focus and state unchanged. Announce "Keep at least one tab open in each pane" through the existing notification or status mechanism. Do not repeat this message for a held key.

### Undo

Use the existing notification system for "Tab closed" with an Undo action. Use its standard information duration, including existing pause and dismissal behavior, instead of introducing a separate timer convention.

Keep one most-recently-closed record for the workspace. A later close replaces it.

The record contains the original pane, insertion position, and tab session state. Undo:

- Restores the tab at its former position, clamped to the current collection length.
- Selects it and focuses its file list.
- Reveals its pane if that pane was hidden.
- Restores the saved position and selection where the current listing still permits it.
- Refreshes stale content rather than marking it fresh.

Release the record when it expires, is dismissed, or is replaced. Do not persist it across reloads.

Also expose Undo close tab through the keyboard-accessible command surface. Keyboard recovery must not depend on focusing a tab header or reaching a short-lived notification.

Closing a folder tab does not delete files. Do not add a confirmation dialog for an ordinary close.

## 7. Exact Focus and Keyboard Contract

### Non-Focusable Tab and Breadcrumb Controls

Apply the following policy in single-pane, dual-pane, and touch-friendly layouts:

- No tab-strip wrapper, scroll container, tab header, close button, or add button enters sequential keyboard focus navigation.
- No breadcrumb root or ancestor control enters sequential keyboard focus navigation.
- Do not programmatically focus these controls during create, select, close, resize, or restoration.
- Give native pointer controls `tabIndex={-1}` and prevent pointer activation from leaving focus there.
- Retain native control semantics, accessible names, and assistive-technology activation. Do not hide the controls with `aria-hidden`.
- After tab or breadcrumb activation, explicitly focus the relevant file list after the state change commits.
- Do not use blanket touch-event cancellation. Preserve scrolling, taps, and synthesized activation.
- Keep strip-scrolling gestures from moving focus out of the file list.
- Keep selected and current breadcrumb text noninteractive.

`tabIndex={-1}` alone is not sufficient: native buttons can still receive focus on pointer activation. Test the final focused element after both mouse and touch activation.

### Keyboard Map

| Focus/context | Key | Action |
|---|---|---|
| Active visible file-list container | Left | Select the preceding tab in that pane. |
| Active visible file-list container | Right | Select the following tab in that pane. |
| Active visible file-list container | Alt+Plus | Create and select a tab at the current location. |
| Active visible file-list container | Alt+Minus | Close the selected tab, subject to the last-tab rule. |
| File list in dual-pane mode | Tab | Preserve the existing pane-switch action. |
| File list | Up/Down, Home/End, Page Up/Down, Enter | Preserve existing file navigation and activation. |
| Existing parent-directory shortcut | Existing key | Preserve parent navigation. |
| Existing pane-location shortcuts | Ctrl+Left/Right | Preserve pane-location matching. |

Left and Right wrap at the ends. With one tab, consume the eligible unmodified arrow event and leave the tab unchanged.

Arrow-key tab switching must work in an empty, loading, or failed directory. It must not depend on the presence of files or a focused row.

For these new bindings, "file list focused" means the list container itself owns DOM focus. Do not infer this only from the active-pane ID. Do not treat focus in a nested menu, checkbox, row action, text input, or dialog as list focus.

### Event Handling

- Match unmodified Left/Right only. Exclude Ctrl, Meta, Alt, and Shift.
- Check focus ownership, current shortcut scope, composition state, and interaction guards before calling `preventDefault`.
- Do not intercept text-caret movement, viewer navigation, menus, or browser-history keys.
- Preserve the shared shortcut system's dialog and portal isolation.
- Allow normal arrow-key repetition for tab traversal. Each accepted event moves one tab.
- Ignore repeated create, close, and undo events so a held key cannot create or close many tabs.
- Clear incremental filename-search state on a tab switch. Do not carry a partially typed search prefix into another tab.

The shared shortcut hook currently prevents defaults before calling a matched handler. Therefore, a handler that returns early is not a sufficient focus guard.

Handle plain Left/Right at the file-list surface, using centralized shortcut definitions and the existing scope rules. Do not register an unrestricted document-level arrow shortcut. Use the same focus contract for the new lifecycle bindings; change shared infrastructure only if a focused integration test proves it necessary.

Support plus symbols that require Shift and the numeric keypad. Check AltGraph and macOS Option behavior explicitly. Do not mistake text entry for a shortcut, and do not claim a platform binding works before verifying it.

### Accessibility

This is an intentional departure from the conventional focusable WAI-ARIA tabs pattern.

Use a named group of native selection buttons with `aria-pressed` for the pointer tab strip, rather than claiming the full `tablist`/`tab` keyboard interaction model. Associate the visible content and selected location with stable labels.

Keep full location names on selection and close controls even when a title is shortened or covered by its close overlay. Do not use the covered text fragment as the accessible name. The fade and overlay background are decorative.

Give the file list localized instructions that explain Left/Right tab switching and the create/close shortcuts. Announce selected tab name and position, for example "Test, tab 2 of 4", without reading the whole directory on every switch.

Expose New tab, Close tab, Undo close tab, Previous tab, and Next tab in the existing keyboard-accessible command surface. This also provides a path for users whose assistive technology or keyboard layout reserves an arrow or Alt combination.

Breadcrumb pointer actions remain available through existing keyboard navigation: parent navigation, connection selection, and the quick bar for an arbitrary ancestor or location.

Do not claim full accessibility compliance from attributes alone. Validate screen-reader operation and command access with the final focus model.

## 8. Overflow and Responsive Behavior

### Width Budget and Scrolling

The add button is the only persistent control outside the strip. All remaining horizontal space belongs to tabs. Do not reserve space for previous/next buttons, an overflow menu, a tab count, or empty toolbar margins.

- Use compact content-sized tabs, then scroll when their combined width exceeds the strip.
- Do not compress every tab to force all tabs into view. Keep the interaction minimums and readable leading text.
- Support horizontal trackpad movement, Shift+wheel, and native touch scrolling.
- Keep a thin native horizontal scrollbar available in mouse layouts when content overflows, so scrolling does not require a trackpad or a special gesture. It must not consume horizontal tab space.
- Keep overall tab-bar height stable if a platform scrollbar needs vertical space. Account for it within the bar's sizing rather than changing file-list height as overflow appears.
- Use subtle, noninteractive edge fades only at edges where tabs are clipped. They must not block title selection, close targets, or the scrollbar.
- Do not add custom wheel translation, drag-scrolling behavior, or overlay arrow controls in the first version. Prefer native scrolling and the existing file-list keyboard path.

The strip scroll container itself stays out of sequential keyboard navigation, including browsers that otherwise make overflow containers focusable automatically.

### Reveal and Clipping Rules

- Reveal the selected tab on selection, creation, close, pane resize, and layout changes.
- Scroll only as far as needed to expose the selected tab; do not center it or reset the strip to the start.
- On programmatic reveal, expose both the tab-selection area and the complete close target, if present.
- Manual scrolling may move the selected header out of view. Do not snap back until a selection or layout action requires a reveal.
- Preserve file-list focus and selection while scrolling the strip.
- Keep the add button fully visible and separate from the scrollable content.
- Do not let the tab strip cause page-level horizontal overflow.
- Preserve both panes' tab collections when a narrow viewport hides one pane.

Use one layout structure for mouse and touch. Change close visibility, target sizes, and scrollbar presentation through the existing input-capability mechanisms, not separate tab-bar implementations.

Use existing input-capability and touch-layout preferences. Do not assume a narrow viewport always means touch input.

## 9. State Ownership and Implementation Structure

### Current Integration Points

The existing page creates two pane hooks and routes shared commands to the active one:

- [FileBrowser page](../frontend/src/pages/FileBrowser.tsx)
- [Pane hook](../frontend/src/pages/FileBrowser/useFileBrowserPane.ts)
- [Pane renderer](../frontend/src/pages/FileBrowser/FileBrowserPane.tsx)
- [Pane and route types](../frontend/src/pages/FileBrowser/types.ts)
- [File list](../frontend/src/components/FileBrowser/FileList.tsx)
- [Breadcrumb component](../frontend/src/components/FileBrowser/BreadcrumbsNavigation.tsx)

The pane hook holds navigation history, cached listings, request guards, selection, and virtual-provider state. Merely changing its path does not create independent tab sessions.

The existing recovery snapshot is also not a tab-switch API. Restoring it clears history and caches and resets archive paging. Do not call it on every tab switch.

### Recommended Structure

Keep one active browsing engine and one visible file-list surface per pane. Add a small typed tab-session layer around the existing pane state, rather than mounting a full file browser and its effects for every open tab.

Use stable tab IDs generated through the existing UUID helper. A location is not an identity: two tabs may show the same location.

Separate state into three groups:

| Owner | State |
|---|---|
| Pane tab collection | Ordered IDs, selected ID, tab sessions, and session restoration metadata. |
| Tab session | Location, listing freshness, pagination, selection, focus, scroll, sorting, directory restoration history, local errors, and any tab-owned query. |
| Active pane runtime | DOM refs, virtualizer bindings, active request controllers, timers, subscriptions, and committed focus requests. |

Do not duplicate preferences, services, viewer documents, or page-level operation state into every tab.

Refactor the existing hook so its active-tab interface reads and writes a keyed session. Retain the page's left/right pane interface where practical. Update all tab-owned writes to address the captured tab ID; do not let an old callback write through a mutable "currently selected tab" reference.

Extract only the state boundaries this feature requires. Do not rewrite storage providers, operation policies, or the whole browser page.

### Tab Activation Transaction

1. Capture the outgoing scroll offset and row identity.
1. Stop pending incremental search and tab-specific timers.
1. Abort or detach obsolete listing and metadata requests.
1. Select the destination session and advance the pane's activation generation.
1. Apply its location, content, and selection as one consistent transition.
1. Update the visible route using replacement navigation.
1. Bind the virtualizer and restore scroll after the list is ready.
1. Focus the list only if the transition requested focus and no newer surface owns interaction.
1. Refresh missing or stale content.

Use a commit or layout-effect boundary and a tab/generation token for focus restoration. Do not use an arbitrary timeout as a readiness signal.

### Selection and Pagination

- Retain selections by stable item identity or canonical paths, not row indices alone.
- Restore the focused item by identity before falling back to a valid nearby index.
- Keep archive cursors, loaded pages, and load-more state with the correct location and tab.
- Never restore an incomplete archive listing as a complete one.
- On cache eviction, keep location and lightweight restoration metadata, then reload on activation.
- Preserve navigation history independently even for tabs at identical paths.

## 10. Caching, Real-Time Updates, and Races

Bound listing data across each pane's tab collection, not separately with a full cache allowance for every tab. Reuse existing cache limits where practical.

Do not set a retained listing's timestamp to the current time merely because the tab was selected.

Only visible selected locations need active directory subscriptions. A visible inactive pane can still receive live updates. Hidden tabs and a hidden second pane must not multiply subscriptions, polling, or metadata work.

Route directory-change invalidation to affected retained sessions and caches. Where no live subscription exists for a hidden location, revalidate it on activation rather than assuming it stayed current.

For every async completion, verify the originating tab ID, location, and request generation. After a close, drop an obsolete read result. After a switch, never apply it to the new tab.

Reuse fresh immutable listing data across duplicate locations where possible. Do not share mutable selection or cursor objects.

## 11. Operations, Viewers, and Errors

### Operations

Capture source tab identity, source handles, destination location, and operation identity when an operation starts.

Changing the selected destination tab must not retarget an operation already in progress. Completing an operation must refresh the captured affected locations, not whichever tab is now selected.

Keep existing modal ownership and cancellation rules. Disable tab changes while a blocking page-owned operation surface requires it, and present an existing actionable reason where appropriate.

A non-blocking operation that already owns immutable handles may continue after its folder tab closes. Keep its progress, cancellation, and errors in the page-owned operation surface. Do not cancel a write merely to dispose of tab UI.

### Viewers and Editors

Keep the current page-owned viewer architecture. Record the originating tab internally for correct return focus and image/archive continuation.

While a viewer or editor owns interaction, folder-tab shortcuts do not run. Preserve unsaved-edit guards, viewer routing, and document state. Do not add background folder-tab changes that bypass those guards.

### Errors

Keep errors associated with the tab and attempted location. A failure must not overwrite another tab's files or cause a silent redirect to a different connection.

Preserve established missing-directory recovery where it already applies. Do not introduce new automatic fallback locations for tabs.

Use existing specific Retry, connection, pairing, and Companion guidance. An unavailable restored tab remains visible and recoverable rather than being silently removed.

## 12. Routing, History, and Persistence

### Visible URL

Keep the existing visible-location URL model: left target, optional right target, and active-pane information. Do not encode all background tabs into the URL.

Tab selection, create, close, and undo replace the visible URL. Directory navigation continues to create history entries according to existing rules.

Keep existing extra query parameters and viewer/settings route data. Do not overwrite router-owned history state.

### Browser Back and Forward

Attach selected left/right tab IDs to namespaced router location state for directory history entries. Preserve this identity when replacing a visible route.

On history navigation:

1. If the recorded tab still exists in that pane, select it and apply the historical location there.
1. If it no longer exists, apply the historical location to that pane's currently selected tab.
1. For a history entry or incoming route without tab metadata, use the selected tab for each addressed pane.
1. Never create an extra folder tab merely because a historical tab ID is missing.

Back/Forward therefore remains workspace navigation, not a separate history stack for each tab. Closing a tab is reversed only through Undo.

Include integration tests for replacement navigation. Replacing a route must not accidentally associate an older history entry with the wrong tab.

### Session Restoration

Use a versioned, validated session-storage schema scoped to the current authenticated browser session. Clear it through the account-session cleanup path so another signed-in user does not inherit locations.

Persist only the data needed to reopen the workspace:

- Tab IDs and order.
- Selected tab IDs.
- Connection and provider-neutral location descriptors.
- Layout and active-pane state where consistent with current preference scope.
- Tab sort settings if they are not already restored by an existing preference.

Do not persist file contents, credentials, listings, active requests, operation state, Undo records, or transient selections.

Precedence:

1. An explicit incoming route controls the visible addressed locations.
1. A reload of the same workspace restores tab collections and selected IDs, then reconciles the URL.
1. Retained background tabs may remain, but they must not replace an explicit incoming location.
1. Without a usable session record, seed one tab per pane from the existing route and preferences.

Record sufficient workspace-route identity to distinguish a matching reload from a different incoming link. Do not infer that every page load with saved storage is a reload.

Validate IDs, selected membership, location shape, and schema version. Handle malformed and unavailable storage explicitly through repository-standard logging. Continue browsing in memory if persistence is unavailable; notify the user that tab restoration is unavailable without repeating a notice on every write.

The existing backend-recovery snapshot has a separate purpose and lifetime. Keep it separate, add tab identity where necessary, and never hydrate a saved listing into a different tab.

## 13. Implementation Work Packages

### A. Establish the Tab-Session Boundary

- Add tab IDs, session types, collection invariants, and a small reducer or equivalent existing state pattern.
- Extract tab-owned state from the active pane runtime.
- Add activate, create, close, and undo transitions.
- Keep a one-tab workspace equivalent to current behavior before adding the bar.
- Preserve archive paging, selection identity, history, and stale-data handling.

Acceptance gate: focused state tests and existing pane-hook tests pass with one and multiple sessions.

### B. Integrate Workspace Routing and Lifecycle

Depends on A.

- Replace direct left/right location assumptions with each pane's selected session.
- Add history-state tab identity and URL replacement rules.
- Add session restoration and account cleanup.
- Keep backend recovery, viewer origin, and operation contexts aligned with stable tab IDs.
- Limit monitoring to visible locations and invalidate retained sessions correctly.

Acceptance gate: route, recovery, viewer, and operation regression tests pass before new controls are exposed.

### C. Add Tab UI and Breadcrumb Focus Changes

Depends on A and the selected-session interface from B.

- Add a small controlled pane-tab-bar component.
- Place it above the existing breadcrumbs.
- Implement content-sized widths, compact caps, zero inter-tab gaps, and location details outside the visible titles.
- Render close buttons as absolute overlays with matching backgrounds and fades, not reserved layout slots.
- Implement hover-only mouse close controls and always-visible touch close controls, including mixed-input handling.
- Keep the add button as the only fixed-width control outside the strip.
- Use native horizontal scrolling and scrollbar access without dedicated arrow-button columns.
- Handle clipped close targets and reveal selected tabs without resetting manual strip position unnecessarily.
- Apply the non-focusable control policy and explicit file-list focus restoration.
- Make breadcrumbs non-focusable in every layout.
- Remove obsolete breadcrumb-specific focus options and Escape handling only after checking all dependent callers.
- Do not remove the broader pane `disableTabFocus` behavior where other controls still use it.

Acceptance gate: component tests prove pointer behavior, focus destination, single-tab protection, and close-overlay state. Browser measurements prove compact widths, stable geometry, safe hit regions, and native overflow access.

### D. Add Commands and File-List Shortcuts

Depends on A and C.

- Define tab shortcuts centrally with localized labels and help text.
- Handle plain Left/Right only at the eligible file-list surface.
- Add create, close, and undo commands without repeat-triggered lifecycle actions.
- Add discoverable command-surface alternatives and file-list instructions.

Acceptance gate: shortcuts operate in empty, loading, failed, and populated lists and do not consume events in other surfaces.

### E. Validate UI and Update Published Docs

Depends on B, C, and D.

- Complete the regression matrix below.
- Measure horizontal space use in narrow dual panes with short and long titles.
- Check close-overlay contrast, pointer focus, touch gestures, zoom, and supported themes.
- Update in-app help and user/developer docs at the earliest applicable feature version.
- Use version inheritance and the docs editor for any published structural changes.
- State the unusual file-list arrow behavior and non-focusable controls clearly.

Acceptance gate: no unresolved regressions in changed behavior and no unsupported accessibility claims.

## 14. Test Plan

### State and Hook Tests

- Insert after the selected tab and select the new tab.
- Create from physical and virtual locations without copying mutable selection.
- Close first, middle, last, background, and only tabs.
- Undo after other tab changes, after pane hiding, and after record replacement or expiry.
- Preserve independent selection, focus, scroll, history, and paging in duplicate locations.
- Evict retained listing data without losing lightweight browsing positions.
- Ignore stale completions after switching or closing.

### Keyboard and Focus Tests

- Verify no tab-bar or breadcrumb control participates in sequential focus navigation in either pane mode.
- Verify mouse, touch, and assistive activation leave focus in the correct file list.
- Verify plain Left/Right wrap and preserve focus in both panes.
- Verify Left/Right work when the directory is empty, loading, or failed.
- Verify Home/End and Up/Down keep their file-list meaning.
- Verify Ctrl+Left/Right retain pane matching.
- Verify inputs, menus, row controls, viewers, settings, and portalled dialogs retain their keys.
- Verify modified arrows, IME composition, and AltGraph do not trigger tab switching.
- Verify repeat behavior differs correctly between traversal and lifecycle actions.
- Verify breadcrumb activation restores file-list focus even when navigation fails.
- Verify keyboard commands provide every tab action without a focusable tab bar.

### Tab-Bar Layout and Pointer Tests

- Verify close overlays are not part of tab-width calculation and no close-specific title padding or blank slot remains.
- Verify hovering does not change any tab's width, title layout, neighboring position, or strip scroll offset.
- Verify touch and mixed-input layouts show close overlays on every closable tab without a reveal gesture.
- Verify hidden mouse overlays cannot close a tab through an invisible hit region.
- Verify selection and close are separate actions and one close tap never selects the target tab first.
- Verify a swipe, scrollbar drag, or cancelled pointer gesture cannot select or close a tab.
- Verify overlays cover underlying title text cleanly in selected, unselected, and hovered states across themes.
- Verify overlays cannot cover adjacent tabs or the add control, and clipped close targets are not actionable.
- Verify full accessible names survive truncation, duplicate visible names, and title coverage.
- Verify only the add button consumes fixed horizontal space outside the strip.
- Verify native scrollbar access works with a mouse without adding scroll-arrow columns.

Use component tests for state and event behavior. Use real browser measurements for layout and hit regions; DOM-only tests do not establish that the space-saving design works.

### Integration Tests

- Reload a matching session and follow a different explicit link.
- Handle old, malformed, missing, and unavailable session storage.
- Sign out and sign in without inheriting the prior account's tabs.
- Use Back/Forward across directory navigation, tab changes, and closed tab IDs.
- Preserve viewer/settings route state and unsaved-edit guards.
- Hide/show the right pane through both user layout changes and responsive changes.
- Change destination tabs during an async operation without retargeting it.
- Receive physical directory changes affecting selected and retained tabs.
- Reconnect SMB and Companion services without updating the wrong tab.
- Restore archive paging and handle a missing or changed archive.

Extend the existing pane, navigation, URL-routing, interaction, viewer, and WebSocket test files where they already cover the behavior. Add small focused files for new tab-session transitions and the tab-bar component. Do not duplicate every existing browser test for tabs.

### Browser Validation

Use only the approved test connection at `http://localhost:3000/browse/smb/demo`.

Check:

- Single and dual panes at wide and narrow widths.
- Long, duplicate, Unicode, and bidirectional labels.
- Short names that should produce narrow content-sized tabs, without minimum widths becoming the default.
- Enough tabs to overflow both panes, with the add button as the only fixed external control.
- Mouse hover transitions with identical before/after header widths and positions.
- Always-visible touch close overlays with no reserved title slot.
- Browser zoom and nonoverlapping touch selection/close targets.
- Native horizontal scrollbar use, touch swipes, and partial tabs at both edges.
- Selected-tab reveal that does not reset the strip unnecessarily.
- Mouse down/up focus behavior, touch scrolling, and selected-header visibility.
- Screen-reader announcements and keyboard command access.
- Real keyboard behavior for plus and Option/Alt combinations on supported platforms.

Use mocked storage contracts for local-drive parity where a safe local fixture is not available. Do not browse another connection to complete manual validation.

### Validation Commands for Implementation

Run the smallest relevant test set first from `frontend/`, for example:

```bash
npm test -- src/pages/__tests__/useFileBrowserPane.test.tsx src/pages/__tests__/FileBrowserPane.test.tsx src/pages/__tests__/FileBrowser-navigation.test.tsx src/pages/__tests__/FileBrowser-url-routing.test.tsx src/pages/__tests__/FileBrowser-interactions.test.tsx src/pages/__tests__/FileBrowser-websocket-behavior.test.tsx src/config/__tests__/keyboardShortcuts.test.ts
npm run typecheck
npm run lint
```

Add the actual new tab test paths to the same test invocation. Include the existing viewer and shared-shortcut tests when their integration code changes. Run the existing production build and relevant browser tests before release. Resolve warnings or failures caused by this work.

No application tests are required for creating this planning document alone. Validate its local references and formatting.

### Measurable Geometry Checks

Run these checks at the current app font and representative narrow pane widths:

- A closable tab with a short title uses the content-derived width or safety floor, not the 160 px cap.
- Showing a mouse close overlay changes its tab's bounding width and neighboring positions by 0 CSS px.
- A touch tab provides at least 44 by 44 px for selection outside the close target and at least 44 by 44 px for close.
- A mouse tab provides at least 24 by 24 px for selection outside the close target and at least 24 by 24 px for close.
- Combined fixed horizontal space outside the strip equals only the add control and any actual border, with no hidden scroll-button or spacer allocation.
- Three short closable titles fit in a 360 px pane in touch mode at the proposed minimums: three 88 px tabs plus the 44 px add target use 308 px before borders.
- When the titles are longer, overflow preserves the same target sizes and keeps the selected tab and add control fully usable.

The three-tab example is a minimum capacity check with short labels, not a rule to assign every tab an 88 px width. If theme metrics require adjustments, record the measured values and preserve the capacity and hit-target requirements rather than silently widening all tabs.

## 15. Published Documentation Work

The implementation must update the resolved documentation pages for:

- Browsing and navigation: tabs, overlaid close controls, touch visibility, native overflow access, state retention, and last-tab protection.
- Keyboard navigation and shortcuts: Left/Right while the file list owns focus; create, close, and command alternatives.
- Dual-pane mode: independent selected tabs, active-pane actions, and hidden-pane retention.
- Frontend architecture: session/runtime ownership, operation identity, route history, and subscription scope.

Current base pages include:

- [Keyboard navigation and shortcuts](../website/content/docs/0.7/user-guide/find-and-browse-files/keyboard-navigation-and-shortcuts/index.md)
- [Dual-pane mode](../website/content/docs/0.7/user-guide/find-and-browse-files/dual-pane-mode/index.md)
- [Frontend overview](../website/content/docs/0.7/developer-guide/frontend-architecture/frontend-overview/index.md)
- [Keyboard shortcuts and command model](../website/content/docs/0.7/developer-guide/frontend-architecture/keyboard-shortcuts-and-command-model/index.md)
- [Settings, dialog, and keyboard-isolation conventions](../website/content/docs/3.0/developer-guide/frontend-architecture/settings-form-dialog-pattern/index.md)

Resolve inheritance before editing. New feature copy belongs at its introduction version, not automatically in the base pages linked above.

Keep this planning document outside published user documentation. Do not present the feature as available until the implementation is ready.

## 16. Completion Criteria

The feature is complete when:

- Each pane retains at least one independent tab.
- Compact content-sized tabs use the agreed horizontal budget instead of wide default widths, extra icons, or repeated path suffixes.
- Close controls overlay titles without a reserved slot or hover-induced layout shift.
- Touch and mixed-input devices expose close directly, with separate safe selection and close targets.
- Only the add control takes fixed space outside the strip; native scrolling makes overflow usable without navigation-button columns.
- Tab and breadcrumb controls never become the intended keyboard-focus destination.
- Left/Right switch tabs only while the file list owns focus, including empty and failed lists.
- Every keyboard tab action is available without focusing the strip.
- Selection and scroll survive repeated switches between identical locations.
- No stale read, operation result, history entry, or recovery snapshot updates the wrong tab.
- Hidden tabs do not cause unbounded caches or additional live subscriptions.
- Pointer, touch, command, and assistive activation follow the same state transitions.
- SMB, local-drive, archive, viewer, and operation regressions are covered.
- Tests, type checks, lint, relevant browser checks, and related documentation are complete.

## Design References

- [Directory Opus folder tabs](https://docs.dopus.com/doku.php?id=basic_concepts:the_lister:tabs): independent folder tabs within file displays.
- [VS Code tabs](https://code.visualstudio.com/docs/editing/getting-started/userinterface#_tabs): readable headers, groups, labels, and overflow.
- [Chrome shortcuts](https://support.google.com/chrome/answer/157179?hl=en): browser-owned shortcuts that Sambee must not depend on.
- [WAI-ARIA tabs pattern](https://www.w3.org/WAI/ARIA/apg/patterns/tabs/): the conventional focusable interaction model, intentionally not adopted here.
- [WCAG target-size guidance](https://www.w3.org/WAI/WCAG22/Understanding/target-size-minimum.html): pointer target minimums and larger touch-target guidance.
