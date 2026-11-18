+++
title = "Frontend Overview"
+++

The frontend is a React and TypeScript application built with Vite. It is responsible for presenting Sambee's workflows clearly while respecting the backend and companion contracts behind them.

## What the Frontend Owns

The browser app is responsible for:

- routing users into the main product surfaces
- rendering the file browser, viewer, and editing flows
- managing browser-side state, selection, and navigation behavior
- calling backend and companion-facing services through typed client code
- applying theming, localization, and browser-side logging behavior

## Main Frontend Areas

| Area | Responsibility |
|---|---|
| `frontend/src/pages/` | page-level product flows such as the file browser |
| `frontend/src/components/` | reusable UI building blocks |
| `frontend/src/services/` | API clients, browser-to-companion integration, and other service helpers |
| `frontend/src/i18n/` | typed translation resources and locale wiring |
| `frontend/src/theme/` | theme configuration and theme-selection behavior |
| `frontend/src/utils/` | formatting, registry, and other supporting utilities |

## File Browser as the Core Surface

The file browser is the center of the main product UI.

- It supports single-pane and dual-pane workflows with independent ordered folder-tab collections per pane.
- It separates lightweight tab-session state (`pages/FileBrowser/tabSessions.ts`) from one active browsing runtime and virtualizer per pane (`pages/FileBrowser/useFileBrowserPane.ts`), rather than mounting hidden browser trees for background tabs.
- It keeps the visible URL focused on each visible pane's selected location while attaching selected tab IDs to namespaced router history state (`sambeePaneTabs`) and persisting minimal tab descriptors in session-scoped `sessionStorage` (`pages/FileBrowser/tabSessionStorage.ts`) keyed by validated `userScope` (preserving anonymous records across unauthenticated startup refresh `401` responses while clearing account-owned records on auth clear and clearing all records on explicit sign-out).
- It captures source tab identity, item handles, and destination location when operations start so later tab switches or closes never retarget an in-flight write, and limits live WebSocket directory subscriptions to visible selected locations while routing change invalidations to retained sessions.

That is why frontend changes in the file browser often have broader user impact than they first appear to.

For the main browsing surface itself, continue to [File Browser and Navigation Model](../file-browser-and-navigation-model/).

## Frontend Contracts That Matter

### Backend Contracts

The frontend depends on stable backend response shapes. When those change, update the corresponding types, service logic, and contract tests together.

### Companion Contracts

The frontend is also the browser-side orchestrator for companion detection, pairing, local-drive access, and native-app editing initiation. That means browser-side state and desktop-side behavior are tightly linked even though they live in different projects.

### Theming and Localization

The app treats theme behavior and localization as typed, explicit systems rather than loose UI sugar.

- frontend copy should come from the translation system
- locale handling and regional formatting are treated as product behavior
- theme behavior is centralized instead of ad hoc component styling

## Cross-Cutting Frontend Concerns

- keyboard-first browsing and command surfaces
- typed logging and backend tracing configuration
- viewer behavior by file type and preview capability
- responsive behavior, including mobile limitations and dual-pane desktop features

## Rendering Hazards and Prevention Rules

This codebase has already hit at least one subtle React rendering failure where the app was logically correct but the browser still lost the first user click.

The useful lesson is that React rendering behavior, native event timing, portal trees, and third-party props can interact in ways that are easy to miss during normal component-level work.

### Representative Failure Mode

One real frontend regression affected Markdown links inside the viewer.

- links in the Markdown viewer ignored the first click when the viewer had been opened via keyboard
- the second click worked
- opening the viewer via mouse did not reproduce the problem

The root cause was not a single bad line. It was the combination of several implementation details:

1. a global capture-phase `pointerdown` handler in `FileBrowser.tsx` updated keyboard-versus-pointer focus state synchronously
2. React treated that update as a discrete-event flush and applied it between `pointerdown` and `click`
3. the viewer shell was still expensive enough that the re-render cascaded through the portal-rendered viewer tree
4. `react-markdown` override props included a `node` value that would have been dangerous to spread onto a native DOM anchor

The current code fixes that by deferring the focus-state update with `requestAnimationFrame`, memoizing the dynamic viewer shell, and stripping `node` out of the Markdown link override before spreading the remaining props.

### Why This Class of Bug Matters

This kind of problem is easy to underestimate because:

- it can be input-mode specific rather than globally reproducible
- it may only appear when several otherwise-correct abstractions interact
- the visible symptom can look like a browser bug or flaky click handling when the real cause is a mid-event re-render

Contributors should treat event timing and render isolation as architecture concerns, not just local component details.

### Prevention Rules

#### 1. Do Not Trigger Synchronous State Changes in Capture-Phase Pointer Handlers Unless Necessary

Capture-phase `pointerdown` and `mousedown` handlers can run before the click sequence finishes. If they trigger state updates synchronously, React can re-render in the middle of the browser's interaction pipeline.

When the state change is not required immediately, defer it past the current event cycle with `requestAnimationFrame`.

#### 2. Keep Portal-Rendered Viewer Surfaces Render-Isolated

Viewer trees rendered through dialogs or other portals should not re-render just because an unrelated parent concern changed.

In practice this means:

- memoize portal-rendered viewer shells when they are intended to be stable
- be skeptical of parent state changes that can cascade into the viewer tree during active pointer interaction
- review viewer wrappers such as `DynamicViewer` with the same care as the concrete viewer components themselves

#### 3. Never Blindly Spread Third-Party Props onto Native DOM Elements

Libraries such as `react-markdown` can inject props that are valid for the library layer but unsafe for direct DOM output.

When overriding renderers:

- explicitly destructure library-only props such as `node`
- spread only the remaining DOM-safe props onto native elements
- assume that leaking unknown props onto the interaction target can change browser behavior in ways that are hard to diagnose

### Practical Audit Checks

When debugging or reviewing similar issues, use targeted searches like these:

```bash
grep -rn 'addEventListener.*capture' frontend/src/
grep -rn '\.\.\.props' frontend/src/components/Viewer/
grep -rn 'React\.memo\|memo(' frontend/src/components/Viewer/
grep -rn 'React\.memo\|memo(' frontend/src/components/FileBrowser/DynamicViewer.tsx
```

These are not exhaustive audits, but they are good first-pass checks for the specific failure pattern this codebase has already seen.

## Go Deeper

- [Theming System and Theme Selection](../theming-system-and-theme-selection/): theme configuration, built-in themes, persistence, and how the UI switches themes
- [File Browser and Navigation Model](../file-browser-and-navigation-model/): pane state, URL routing, keyboard flows, and refresh behavior
- [Keyboard Shortcuts and Command Model](../keyboard-shortcuts-and-command-model/): central shortcut definitions, browser commands, quick-bar modes, and context-aware handlers
- [Viewer Architecture and Preview Contracts](../viewer-architecture-and-preview-contracts/): file-type registries, preview selection, and conversion-sensitive viewer behavior
- [Logging and Localization](../../cross-cutting-systems/logging-and-localization/): shared frontend-facing rules for diagnostics, translatable UI copy, and locale behavior

## Validation Expectations

When frontend behavior changes, start with:

```bash
cd frontend && npm test
cd frontend && npx tsc --noEmit
cd frontend && npm run lint
```

If the change also affects backend or companion contracts, add the matching checks there too.
