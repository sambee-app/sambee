import { formatConnectionPath } from "../../components/FileBrowser/formatConnectionPath";
import type { CompanionPairingErrorKind } from "../../services/localDrivePairing";
import { randomUuid } from "../../utils/randomUuid";
import type { BrowserItem } from "./contentProviders";
import type { ArchiveLocation, NavigationHistoryEntry, PaneId, SortField } from "./types";

/** Default cap on inactive tab sessions retaining full item listings per pane. */
export const DEFAULT_MAX_INACTIVE_RETAINED_TAB_LISTINGS = 32;
export const DEFAULT_TAB_SORT_FIELD = "name";
export const DEFAULT_TAB_SORT_DIRECTION = "asc";

/** Lightweight public summary of a tab in a pane's ordered collection. */
export interface PaneTabSummary {
  id: string;
  connectionId: string;
  currentPath: string;
  archiveLocation: ArchiveLocation | null;
  sortBy: SortField;
  sortDirection: "asc" | "desc";
  searchTitle?: string;
}

/** Complete browsing state owned by an individual tab session. */
export interface TabSessionState {
  id: string;
  connectionId: string;
  currentPath: string;
  archiveLocation: ArchiveLocation | null;
  items: BrowserItem[];
  hasPhysicalListing: boolean;
  hasArchiveListing: boolean;
  listingTimestamp: number | null;
  invalidated: boolean;
  unmonitoredWhileHidden: boolean;
  evicted: boolean;
  archiveNextCursor: string | null;
  archiveHasMore: boolean;
  selectedFiles: Set<string>;
  selectionAnchor: string | null;
  focusedIndex: number;
  focusedItemIdentity: string | null;
  scrollOffset: number;
  sortBy: SortField;
  sortDirection: "asc" | "desc";
  navigationHistory: Map<string, NavigationHistoryEntry>;
  archiveNavigationHistory: Map<string, NavigationHistoryEntry>;
  error: string | null;
  errorSeverity: "warning" | "error";
  errorOccurrence: number;
  failedTarget: { connectionId: string; path: string; label: string; summary?: string } | null;
  companionPairingError: { kind: CompanionPairingErrorKind; message: string } | null;
  directoryMonitorError: string | null;
  directoryMonitorErrorSummary?: string;
  directoryMonitorErrorOccurrence: number;
  searchSessionId?: string;
  searchTitle?: string;
}

/** Ordered tab collection and per-tab session map for one pane. */
export interface PaneTabCollection {
  orderedIds: string[];
  selectedTabId: string;
  sessions: Map<string, TabSessionState>;
  /** Least-recently-used to most-recently-used tab IDs. */
  mruIds: string[];
}

/** Workspace-level undo record for the most recently closed tab. */
export interface ClosedPaneTabRecord {
  paneId: PaneId;
  insertionIndex: number;
  session: TabSessionState;
  occurrence: number;
}

function cloneHistoryMap(source: ReadonlyMap<string, NavigationHistoryEntry>): Map<string, NavigationHistoryEntry> {
  const next = new Map<string, NavigationHistoryEntry>();
  for (const [key, entry] of source.entries()) {
    next.set(key, { ...entry });
  }
  return next;
}

/** Deeply clones mutable collections inside a tab session so sessions never alias state. */
export function cloneTabSessionState(session: TabSessionState): TabSessionState {
  return {
    ...session,
    archiveLocation: session.archiveLocation ? { ...session.archiveLocation } : null,
    items: [...session.items],
    selectedFiles: new Set(session.selectedFiles),
    navigationHistory: cloneHistoryMap(session.navigationHistory),
    archiveNavigationHistory: cloneHistoryMap(session.archiveNavigationHistory),
    failedTarget: session.failedTarget ? { ...session.failedTarget } : null,
    companionPairingError: session.companionPairingError ? { ...session.companionPairingError } : null,
  };
}

/** Creates a clean tab session with independent empty selection, history, and scroll state. */
export function createEmptyTabSession(id: string = randomUuid(), overrides: Partial<TabSessionState> = {}): TabSessionState {
  return {
    id,
    connectionId: "",
    currentPath: "",
    archiveLocation: null,
    items: [],
    hasPhysicalListing: false,
    hasArchiveListing: false,
    listingTimestamp: null,
    invalidated: false,
    unmonitoredWhileHidden: false,
    evicted: false,
    archiveNextCursor: null,
    archiveHasMore: false,
    selectedFiles: new Set(),
    selectionAnchor: null,
    focusedIndex: 0,
    focusedItemIdentity: null,
    scrollOffset: 0,
    sortBy: DEFAULT_TAB_SORT_FIELD,
    sortDirection: DEFAULT_TAB_SORT_DIRECTION,
    navigationHistory: new Map(),
    archiveNavigationHistory: new Map(),
    error: null,
    errorSeverity: "error",
    errorOccurrence: 0,
    failedTarget: null,
    companionPairingError: null,
    directoryMonitorError: null,
    directoryMonitorErrorSummary: undefined,
    directoryMonitorErrorOccurrence: 0,
    ...overrides,
    ...(overrides.archiveLocation !== undefined
      ? { archiveLocation: overrides.archiveLocation ? { ...overrides.archiveLocation } : null }
      : {}),
    ...(overrides.items !== undefined ? { items: [...overrides.items] } : {}),
    ...(overrides.selectedFiles !== undefined ? { selectedFiles: new Set(overrides.selectedFiles) } : {}),
    ...(overrides.navigationHistory !== undefined ? { navigationHistory: cloneHistoryMap(overrides.navigationHistory) } : {}),
    ...(overrides.archiveNavigationHistory !== undefined
      ? { archiveNavigationHistory: cloneHistoryMap(overrides.archiveNavigationHistory) }
      : {}),
  };
}

function touchMru(mruIds: readonly string[], validIds: ReadonlySet<string>, activeId: string): string[] {
  const filtered = mruIds.filter((id) => validIds.has(id) && id !== activeId);
  for (const id of validIds) {
    if (id !== activeId && !filtered.includes(id)) {
      filtered.unshift(id);
    }
  }
  filtered.push(activeId);
  return filtered;
}

function hasRetainedListing(session: TabSessionState): boolean {
  return session.items.length > 0 || session.hasPhysicalListing || session.hasArchiveListing;
}

/**
 * Bounds retained item arrays across inactive tabs in a pane while keeping lightweight
 * location, selection, focus, scroll, and history metadata intact for reload on activation.
 */
export function evictOverflowTabListings(
  collection: PaneTabCollection,
  maxInactiveRetained: number = DEFAULT_MAX_INACTIVE_RETAINED_TAB_LISTINGS
): PaneTabCollection {
  const limit = Math.max(0, maxInactiveRetained);
  const inactiveWithListings = collection.mruIds.filter((id) => {
    if (id === collection.selectedTabId) return false;
    const session = collection.sessions.get(id);
    if (session?.searchSessionId) return false;
    return session ? hasRetainedListing(session) : false;
  });

  if (inactiveWithListings.length <= limit) {
    return collection;
  }

  const sessions = new Map(collection.sessions);
  const evictCount = inactiveWithListings.length - limit;
  for (let index = 0; index < evictCount; index += 1) {
    const victimId = inactiveWithListings[index];
    if (!victimId) continue;
    const victim = sessions.get(victimId);
    if (!victim) continue;
    sessions.set(victimId, {
      ...victim,
      items: [],
      hasPhysicalListing: false,
      hasArchiveListing: false,
      listingTimestamp: null,
      archiveNextCursor: null,
      archiveHasMore: false,
      evicted: true,
    });
  }

  return {
    ...collection,
    sessions,
  };
}

/** Creates an initial single-tab collection for a pane. */
export function createInitialTabCollection(initialTabId: string = randomUuid()): PaneTabCollection {
  const session = createEmptyTabSession(initialTabId);
  return {
    orderedIds: [session.id],
    selectedTabId: session.id,
    sessions: new Map([[session.id, session]]),
    mruIds: [session.id],
  };
}

/**
 * Inserts a new tab immediately after the currently selected tab, copying its committed
 * location and sort settings while starting at the top with no selected items.
 */
export function createTabAfterSelected(
  collection: PaneTabCollection,
  options?: {
    id?: string;
    seedListing?: {
      items: BrowserItem[];
      hasPhysicalListing: boolean;
      hasArchiveListing: boolean;
      listingTimestamp: number | null;
      archiveNextCursor: string | null;
      archiveHasMore: boolean;
    };
    maxInactiveRetained?: number;
  }
): { collection: PaneTabCollection; createdTab: TabSessionState } {
  const selectedSession = collection.sessions.get(collection.selectedTabId) ?? collection.sessions.values().next().value;
  if (!selectedSession) {
    const fallback = createInitialTabCollection(options?.id);
    return { collection: fallback, createdTab: fallback.sessions.get(fallback.selectedTabId)! };
  }

  const newId = options?.id && !collection.sessions.has(options.id) ? options.id : randomUuid();
  const seed = options?.seedListing;
  const createdTab = createEmptyTabSession(newId, {
    connectionId: selectedSession.connectionId,
    currentPath: selectedSession.currentPath,
    archiveLocation: selectedSession.archiveLocation ? { ...selectedSession.archiveLocation } : null,
    sortBy: selectedSession.sortBy,
    sortDirection: selectedSession.sortDirection,
    items: seed ? [...seed.items] : [],
    hasPhysicalListing: seed?.hasPhysicalListing ?? false,
    hasArchiveListing: seed?.hasArchiveListing ?? false,
    listingTimestamp: seed?.listingTimestamp ?? null,
    archiveNextCursor: seed?.archiveNextCursor ?? null,
    archiveHasMore: seed?.archiveHasMore ?? false,
  });

  const selectedIndex = Math.max(0, collection.orderedIds.indexOf(collection.selectedTabId));
  const orderedIds = [
    ...collection.orderedIds.slice(0, selectedIndex + 1),
    createdTab.id,
    ...collection.orderedIds.slice(selectedIndex + 1),
  ];
  const sessions = new Map(collection.sessions);
  sessions.set(createdTab.id, createdTab);
  const validIds = new Set(orderedIds);
  const nextCollection = evictOverflowTabListings(
    {
      orderedIds,
      selectedTabId: createdTab.id,
      sessions,
      mruIds: touchMru(collection.mruIds, validIds, createdTab.id),
    },
    options?.maxInactiveRetained
  );

  return { collection: nextCollection, createdTab };
}

/** Selects an existing tab in the collection without changing tab order. */
export function selectTabInCollection(
  collection: PaneTabCollection,
  targetTabId: string,
  maxInactiveRetained?: number
): { collection: PaneTabCollection; changed: boolean } {
  if (!collection.sessions.has(targetTabId)) {
    return { collection, changed: false };
  }
  if (collection.selectedTabId === targetTabId) {
    return { collection, changed: false };
  }

  const validIds = new Set(collection.orderedIds);
  const nextCollection = evictOverflowTabListings(
    {
      ...collection,
      selectedTabId: targetTabId,
      mruIds: touchMru(collection.mruIds, validIds, targetTabId),
    },
    maxInactiveRetained
  );
  return { collection: nextCollection, changed: true };
}

/** Returns the wrapped preceding or following tab ID in a pane's ordered tab strip. */
export function getAdjacentTabId(orderedIds: readonly string[], selectedTabId: string, direction: "previous" | "next"): string {
  if (orderedIds.length === 0) {
    return selectedTabId;
  }
  if (orderedIds.length === 1) {
    return orderedIds[0]!;
  }

  const currentIndex = orderedIds.indexOf(selectedTabId);
  const baseIndex = Math.max(currentIndex, 0);
  const delta = direction === "previous" ? -1 : 1;
  const nextIndex = (baseIndex + delta + orderedIds.length) % orderedIds.length;
  return orderedIds[nextIndex]!;
}

export type CloseTabResult =
  | { closed: false; collection: PaneTabCollection }
  | {
      closed: true;
      collection: PaneTabCollection;
      closedSession: TabSessionState;
      closedIndex: number;
      selectionChanged: boolean;
    };

export function getLastFolderTabId(tabs: Iterable<Pick<PaneTabSummary, "id" | "searchTitle">>): string | null {
  let folderTabId: string | null = null;
  for (const tab of tabs) {
    if (tab.searchTitle !== undefined) continue;
    if (folderTabId !== null) return null;
    folderTabId = tab.id;
  }
  return folderTabId;
}

/**
 * Closes a tab while keeping the last folder tab and selecting the left neighbor
 * (or right neighbor when closing the first tab).
 */
export function closeTabInCollection(collection: PaneTabCollection, targetTabId: string): CloseTabResult {
  if (collection.orderedIds.length <= 1 || getLastFolderTabId(collection.sessions.values()) === targetTabId) {
    return { closed: false, collection };
  }

  const closedIndex = collection.orderedIds.indexOf(targetTabId);
  const targetSession = collection.sessions.get(targetTabId);
  if (closedIndex < 0 || !targetSession) {
    return { closed: false, collection };
  }

  const closedSession = cloneTabSessionState(targetSession);
  const selectionChanged = targetTabId === collection.selectedTabId;
  const nextSelectedTabId = selectionChanged
    ? closedIndex > 0
      ? collection.orderedIds[closedIndex - 1]!
      : collection.orderedIds[1]!
    : collection.selectedTabId;

  const orderedIds = collection.orderedIds.filter((id) => id !== targetTabId);
  const sessions = new Map(collection.sessions);
  sessions.delete(targetTabId);
  const validIds = new Set(orderedIds);
  const mruIds = selectionChanged
    ? touchMru(
        collection.mruIds.filter((id) => id !== targetTabId),
        validIds,
        nextSelectedTabId
      )
    : collection.mruIds.filter((id) => validIds.has(id));

  return {
    closed: true,
    collection: {
      orderedIds,
      selectedTabId: nextSelectedTabId,
      sessions,
      mruIds,
    },
    closedSession,
    closedIndex,
    selectionChanged,
  };
}

/**
 * Restores a previously closed tab at its former position (clamped to current collection bounds),
 * selects it, and marks its content for revalidation rather than treating stale data as fresh.
 */
export function restoreClosedTabInCollection(
  collection: PaneTabCollection,
  closedSession: TabSessionState,
  insertionIndex: number,
  maxInactiveRetained?: number
): { collection: PaneTabCollection; restoredTab: TabSessionState } {
  const restoredId = collection.sessions.has(closedSession.id) ? randomUuid() : closedSession.id;
  const cloned = cloneTabSessionState(closedSession);
  const restoredTab: TabSessionState = {
    ...cloned,
    id: restoredId,
    invalidated: true,
    unmonitoredWhileHidden: true,
  };

  const clampedIndex = Math.max(0, Math.min(insertionIndex, collection.orderedIds.length));
  const orderedIds = [...collection.orderedIds.slice(0, clampedIndex), restoredId, ...collection.orderedIds.slice(clampedIndex)];
  const sessions = new Map(collection.sessions);
  sessions.set(restoredId, restoredTab);
  const validIds = new Set(orderedIds);
  const nextCollection = evictOverflowTabListings(
    {
      orderedIds,
      selectedTabId: restoredId,
      sessions,
      mruIds: touchMru(collection.mruIds, validIds, restoredId),
    },
    maxInactiveRetained
  );

  return { collection: nextCollection, restoredTab };
}

/** Builds a validated collection from restored tab sessions, guaranteeing >= 1 tab and valid selection. */
export function hydrateTabCollection(
  entries: readonly TabSessionState[],
  selectedTabId: string,
  maxInactiveRetained?: number
): PaneTabCollection {
  const sessions = new Map<string, TabSessionState>();
  const orderedIds: string[] = [];

  for (const entry of entries) {
    if (!entry.id || sessions.has(entry.id)) {
      continue;
    }
    orderedIds.push(entry.id);
    sessions.set(entry.id, cloneTabSessionState(entry));
  }

  if (orderedIds.length === 0) {
    return createInitialTabCollection();
  }

  const resolvedSelectedId = sessions.has(selectedTabId) ? selectedTabId : orderedIds[0]!;
  const validIds = new Set(orderedIds);
  return evictOverflowTabListings(
    {
      orderedIds,
      selectedTabId: resolvedSelectedId,
      sessions,
      mruIds: touchMru(orderedIds, validIds, resolvedSelectedId),
    },
    maxInactiveRetained
  );
}

/** Maps a pane's ordered tab collection to lightweight UI/persistence summaries. */
export function toPaneTabSummaries(collection: PaneTabCollection): PaneTabSummary[] {
  return collection.orderedIds.flatMap((id) => {
    const session = collection.sessions.get(id);
    if (!session) return [];
    return [
      {
        id: session.id,
        connectionId: session.connectionId,
        currentPath: session.currentPath,
        archiveLocation: session.archiveLocation ? { ...session.archiveLocation } : null,
        sortBy: session.sortBy,
        sortDirection: session.sortDirection,
        searchTitle: session.searchTitle,
      },
    ];
  });
}

/** Returns the display path (including archive virtual path when inside an archive) for a tab. */
export function getPaneTabDisplayPath(tab: Pick<PaneTabSummary, "currentPath" | "archiveLocation">): string {
  if (tab.archiveLocation) {
    return [tab.archiveLocation.archivePath, tab.archiveLocation.virtualPath].filter(Boolean).join("/");
  }
  return tab.currentPath;
}

/**
 * Computes the compact visible tab label:
 * - Inside an archive folder: the current virtual folder name (or archive filename at archive root).
 * - In a physical subfolder: the current folder name.
 * - At a connection or drive root: the connection or drive name.
 */
export function getPaneTabLabel(
  tab: Pick<PaneTabSummary, "connectionId" | "currentPath" | "archiveLocation" | "searchTitle">,
  connectionName: string
): string {
  if (tab.searchTitle) return tab.searchTitle;
  if (tab.archiveLocation) {
    const activeArchivePath = tab.archiveLocation.virtualPath || tab.archiveLocation.archivePath;
    const segments = activeArchivePath.split("/").filter(Boolean);
    if (segments.length > 0) {
      return segments[segments.length - 1]!;
    }
  }

  const pathSegments = tab.currentPath.split("/").filter(Boolean);
  if (pathSegments.length > 0) {
    return pathSegments[pathSegments.length - 1]!;
  }

  return connectionName || tab.connectionId;
}

/** Computes the complete connection and path string for tooltips and accessible names. */
export function getPaneTabFullLocation(
  tab: Pick<PaneTabSummary, "connectionId" | "currentPath" | "archiveLocation" | "searchTitle">,
  connectionName: string
): string {
  if (tab.searchTitle) return tab.searchTitle;
  const displayPath = getPaneTabDisplayPath(tab);
  return formatConnectionPath(connectionName || tab.connectionId, displayPath);
}
