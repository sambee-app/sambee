import { authSession } from "../../services/authSession";
import { normalizeLocalDrivePath } from "../../services/backendRouter";
import { logger } from "../../services/logger";
import type { Connection } from "../../types";
import {
  type BrowseRouteState,
  type BrowseRouteTarget,
  buildBrowseRouteTarget,
  resolveBrowseRouteTarget,
  serializeBrowseRoute,
} from "./routing";
import {
  createEmptyTabSession,
  hydrateTabCollection,
  type PaneTabCollection,
  type PaneTabSummary,
  type TabSessionState,
} from "./tabSessions";
import type { ArchiveLocation, PaneId, PaneMode, SortField, VirtualRouteLocation } from "./types";

export const PANE_TABS_SESSION_STORAGE_KEY = "sambee:pane-tabs-session";
export const PANE_TABS_SCHEMA_VERSION = 1;
export const PANE_TAB_HISTORY_STATE_KEY = "sambeePaneTabs";

export interface PaneTabHistoryMetadata {
  leftTabId: string;
  rightTabId: string | null;
}

export interface PersistedTabLocationDescriptor {
  target: BrowseRouteTarget;
  connectionId: string;
  physicalPath: string;
  archiveLocation: ArchiveLocation | null;
}

export interface PersistedTabEntry {
  id: string;
  location: PersistedTabLocationDescriptor;
  sortBy: SortField;
  sortDirection: "asc" | "desc";
}

export interface PersistedPaneTabCollection {
  orderedIds: string[];
  selectedTabId: string;
  tabs: PersistedTabEntry[];
}

export interface PersistedWorkspaceTabsRecord {
  schemaVersion: typeof PANE_TABS_SCHEMA_VERSION;
  userScope: string | null;
  workspaceRouteIdentity: string;
  paneMode: PaneMode;
  activePaneId: PaneId;
  left: PersistedPaneTabCollection;
  right: PersistedPaneTabCollection | null;
}

export interface LoadPaneTabsSessionResult {
  record: PersistedWorkspaceTabsRecord | null;
  notifyUnavailable: boolean;
}

export interface SavePaneTabsSessionResult {
  saved: boolean;
  notifyUnavailable: boolean;
}

let hasLoggedStorageUnavailable = false;
let hasNotifiedStorageUnavailable = false;

function reportStorageUnavailableOnce(error: unknown, options: { consumeUiNotice: boolean }): boolean {
  if (!hasLoggedStorageUnavailable) {
    hasLoggedStorageUnavailable = true;
    logger.warn("Session storage is unavailable for pane tab restoration", { error }, "browser");
  }
  if (!options.consumeUiNotice || hasNotifiedStorageUnavailable) {
    return false;
  }
  hasNotifiedStorageUnavailable = true;
  return true;
}

/** Resets one-time storage-unavailable reporting between tests. */
export function resetPaneTabsStorageStateForTesting(): void {
  hasLoggedStorageUnavailable = false;
  hasNotifiedStorageUnavailable = false;
}

function isSortField(value: unknown): value is SortField {
  return value === "name" || value === "size" || value === "modified" || value === "type";
}

function isSortDirection(value: unknown): value is "asc" | "desc" {
  return value === "asc" || value === "desc";
}

function isVirtualRouteLocation(value: unknown): value is VirtualRouteLocation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<VirtualRouteLocation>;
  return (
    candidate.providerId === "zip" &&
    typeof candidate.sourcePath === "string" &&
    candidate.sourcePath.length > 0 &&
    typeof candidate.virtualPath === "string"
  );
}

function isArchiveLocation(value: unknown): value is ArchiveLocation {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ArchiveLocation>;
  return (
    candidate.providerId === "zip" &&
    typeof candidate.archivePath === "string" &&
    candidate.archivePath.length > 0 &&
    typeof candidate.virtualPath === "string"
  );
}

function isBrowseRouteTarget(value: unknown): value is BrowseRouteTarget {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<BrowseRouteTarget>;
  return (
    (candidate.kind === "smb" || candidate.kind === "local") &&
    typeof candidate.targetId === "string" &&
    candidate.targetId.length > 0 &&
    typeof candidate.path === "string" &&
    (candidate.virtualLocation === undefined || isVirtualRouteLocation(candidate.virtualLocation))
  );
}

function isPersistedTabLocationDescriptor(value: unknown): value is PersistedTabLocationDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PersistedTabLocationDescriptor>;
  return (
    isBrowseRouteTarget(candidate.target) &&
    typeof candidate.connectionId === "string" &&
    candidate.connectionId.length > 0 &&
    typeof candidate.physicalPath === "string" &&
    (candidate.archiveLocation === null || isArchiveLocation(candidate.archiveLocation))
  );
}

function isPersistedPaneTabCollection(value: unknown): value is PersistedPaneTabCollection {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<PersistedPaneTabCollection>;
  if (
    !Array.isArray(candidate.orderedIds) ||
    candidate.orderedIds.length === 0 ||
    typeof candidate.selectedTabId !== "string" ||
    !Array.isArray(candidate.tabs) ||
    candidate.tabs.length !== candidate.orderedIds.length
  ) {
    return false;
  }

  const orderedSet = new Set<string>();
  for (const id of candidate.orderedIds) {
    if (typeof id !== "string" || id.length === 0 || orderedSet.has(id)) {
      return false;
    }
    orderedSet.add(id);
  }

  if (!orderedSet.has(candidate.selectedTabId)) {
    return false;
  }

  const seenTabIds = new Set<string>();
  for (const entry of candidate.tabs) {
    if (typeof entry !== "object" || entry === null) return false;
    const tab = entry as Partial<PersistedTabEntry>;
    if (
      typeof tab.id !== "string" ||
      !orderedSet.has(tab.id) ||
      seenTabIds.has(tab.id) ||
      !isSortField(tab.sortBy) ||
      !isSortDirection(tab.sortDirection) ||
      !isPersistedTabLocationDescriptor(tab.location)
    ) {
      return false;
    }
    seenTabIds.add(tab.id);
  }

  return seenTabIds.size === orderedSet.size;
}

function validatePersistedWorkspaceRecord(
  value: unknown
): { valid: true; record: PersistedWorkspaceTabsRecord } | { valid: false; reason: string } {
  if (typeof value !== "object" || value === null) {
    return { valid: false, reason: "not-an-object" };
  }
  const candidate = value as Partial<PersistedWorkspaceTabsRecord>;
  if (candidate.schemaVersion !== PANE_TABS_SCHEMA_VERSION) {
    return { valid: false, reason: "unsupported-schema-version" };
  }
  if (candidate.userScope !== null && typeof candidate.userScope !== "string") {
    return { valid: false, reason: "invalid-user-scope" };
  }
  if (typeof candidate.workspaceRouteIdentity !== "string" || !candidate.workspaceRouteIdentity.startsWith("/browse")) {
    return { valid: false, reason: "invalid-route-identity" };
  }
  if (candidate.paneMode !== "single" && candidate.paneMode !== "dual") {
    return { valid: false, reason: "invalid-pane-mode" };
  }
  if (candidate.activePaneId !== "left" && candidate.activePaneId !== "right") {
    return { valid: false, reason: "invalid-active-pane" };
  }
  if (!isPersistedPaneTabCollection(candidate.left)) {
    return { valid: false, reason: "invalid-left-collection" };
  }
  if (candidate.right !== null && !isPersistedPaneTabCollection(candidate.right)) {
    return { valid: false, reason: "invalid-right-collection" };
  }

  return { valid: true, record: candidate as PersistedWorkspaceTabsRecord };
}

/** Canonical workspace location identity excluding viewer, settings, and extra query params. */
export function getWorkspaceBrowseIdentity(route: Pick<BrowseRouteState, "left" | "right" | "activePaneId">): string {
  return serializeBrowseRoute({
    left: route.left,
    right: route.right,
    activePaneId: route.right ? route.activePaneId : "left",
  });
}

/** Clears persisted pane tab session state from sessionStorage. */
export function clearPaneTabsSessionStorage(): void {
  try {
    sessionStorage.removeItem(PANE_TABS_SESSION_STORAGE_KEY);
  } catch {
    // Storage cleanup is best-effort when sessionStorage is restricted.
  }
}

type ValidatedStoredRecordResult =
  | { status: "empty" }
  | { status: "invalid" }
  | { status: "unavailable"; notifyUnavailable: boolean }
  | { status: "valid"; record: PersistedWorkspaceTabsRecord };

function readValidatedPaneTabsRecord(options: { consumeUiNotice: boolean }): ValidatedStoredRecordResult {
  let raw: string | null = null;
  try {
    raw = sessionStorage.getItem(PANE_TABS_SESSION_STORAGE_KEY);
  } catch (error: unknown) {
    return { status: "unavailable", notifyUnavailable: reportStorageUnavailableOnce(error, options) };
  }

  if (!raw) {
    return { status: "empty" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn("Discarding malformed pane tab session JSON", undefined, "browser");
    clearPaneTabsSessionStorage();
    return { status: "invalid" };
  }

  const validation = validatePersistedWorkspaceRecord(parsed);
  if (!validation.valid) {
    logger.warn("Discarding invalid pane tab session state", { reason: validation.reason }, "browser");
    clearPaneTabsSessionStorage();
    return { status: "invalid" };
  }

  return { status: "valid", record: validation.record };
}

authSession.subscribeToClear(() => {
  const stored = readValidatedPaneTabsRecord({ consumeUiNotice: false });
  if (stored.status === "valid" && stored.record.userScope !== null) {
    clearPaneTabsSessionStorage();
  }
});

/** Loads and validates persisted pane tabs for the current authenticated or anonymous browser session. */
export function loadPaneTabsSessionStorage(): LoadPaneTabsSessionResult {
  const stored = readValidatedPaneTabsRecord({ consumeUiNotice: true });
  if (stored.status === "unavailable") {
    return { record: null, notifyUnavailable: stored.notifyUnavailable };
  }
  if (stored.status !== "valid") {
    return { record: null, notifyUnavailable: false };
  }

  const currentUserScope = authSession.getUserId();
  if (stored.record.userScope !== currentUserScope) {
    clearPaneTabsSessionStorage();
    return { record: null, notifyUnavailable: false };
  }

  return { record: stored.record, notifyUnavailable: false };
}

function serializePaneSummaryCollection(
  tabs: readonly PaneTabSummary[],
  selectedTabId: string,
  connections: readonly Pick<Connection, "id" | "slug">[],
  fallbackTargets?: ReadonlyMap<string, BrowseRouteTarget>
): PersistedPaneTabCollection | null {
  const persistedTabs: PersistedTabEntry[] = [];
  const orderedIds: string[] = [];

  for (const tab of tabs) {
    if (!tab.connectionId || !tab.id) continue;
    const virtualLoc: VirtualRouteLocation | null = tab.archiveLocation
      ? {
          providerId: tab.archiveLocation.providerId,
          sourcePath: tab.archiveLocation.archivePath,
          virtualPath: tab.archiveLocation.virtualPath,
        }
      : null;
    const target = buildBrowseRouteTarget(tab.connectionId, tab.currentPath, connections, virtualLoc) ?? fallbackTargets?.get(tab.id);
    if (!target) continue;

    orderedIds.push(tab.id);
    persistedTabs.push({
      id: tab.id,
      location: {
        target,
        connectionId: tab.connectionId,
        physicalPath: tab.currentPath,
        archiveLocation: tab.archiveLocation ? { ...tab.archiveLocation } : null,
      },
      sortBy: tab.sortBy,
      sortDirection: tab.sortDirection,
    });
  }

  if (orderedIds.length === 0) {
    return null;
  }

  const effectiveSelectedId = orderedIds.includes(selectedTabId) ? selectedTabId : orderedIds[0]!;
  return {
    orderedIds,
    selectedTabId: effectiveSelectedId,
    tabs: persistedTabs,
  };
}

/** Saves minimal workspace tab metadata to sessionStorage without persisting listings or credentials. */
export function savePaneTabsSessionStorage({
  workspaceRouteIdentity,
  paneMode,
  activePaneId,
  leftTabs,
  leftSelectedTabId,
  rightTabs,
  rightSelectedTabId,
  connections,
  fallbackTargets,
}: {
  workspaceRouteIdentity: string;
  paneMode: PaneMode;
  activePaneId: PaneId;
  leftTabs: readonly PaneTabSummary[];
  leftSelectedTabId: string;
  rightTabs: readonly PaneTabSummary[];
  rightSelectedTabId: string;
  connections: readonly Pick<Connection, "id" | "slug">[];
  fallbackTargets?: ReadonlyMap<string, BrowseRouteTarget>;
}): SavePaneTabsSessionResult {
  const left = serializePaneSummaryCollection(leftTabs, leftSelectedTabId, connections, fallbackTargets);
  if (!left || !workspaceRouteIdentity.startsWith("/browse")) {
    return { saved: false, notifyUnavailable: false };
  }
  const right = serializePaneSummaryCollection(rightTabs, rightSelectedTabId, connections, fallbackTargets);

  const record: PersistedWorkspaceTabsRecord = {
    schemaVersion: PANE_TABS_SCHEMA_VERSION,
    userScope: authSession.getUserId(),
    workspaceRouteIdentity,
    paneMode,
    activePaneId: paneMode === "dual" ? activePaneId : "left",
    left,
    right,
  };

  try {
    sessionStorage.setItem(PANE_TABS_SESSION_STORAGE_KEY, JSON.stringify(record));
    return { saved: true, notifyUnavailable: false };
  } catch (error: unknown) {
    return { saved: false, notifyUnavailable: reportStorageUnavailableOnce(error, { consumeUiNotice: true }) };
  }
}

function persistedCollectionToTabCollection(
  persisted: PersistedPaneTabCollection,
  connections: readonly Pick<Connection, "id" | "slug">[],
  unresolvedTargetsOut?: Map<string, BrowseRouteTarget>
): PaneTabCollection {
  const tabById = new Map(persisted.tabs.map((tab) => [tab.id, tab]));
  const sessions: TabSessionState[] = [];

  for (const id of persisted.orderedIds) {
    const entry = tabById.get(id);
    if (!entry) continue;
    const resolvedTarget = resolveBrowseRouteTarget(entry.location.target, connections);
    const connectionId = resolvedTarget?.connectionId ?? entry.location.connectionId;
    if (!resolvedTarget) {
      unresolvedTargetsOut?.set(entry.id, entry.location.target);
    }
    const physicalPath = normalizeLocalDrivePath(connectionId, entry.location.physicalPath);
    sessions.push(
      createEmptyTabSession(entry.id, {
        connectionId,
        currentPath: physicalPath,
        archiveLocation: entry.location.archiveLocation ? { ...entry.location.archiveLocation } : null,
        sortBy: entry.sortBy,
        sortDirection: entry.sortDirection,
        unmonitoredWhileHidden: true,
      })
    );
  }

  return hydrateTabCollection(sessions, persisted.selectedTabId);
}

function applyIncomingTargetToSelectedTab(
  collection: PaneTabCollection,
  target: BrowseRouteTarget,
  connections: readonly Pick<Connection, "id" | "slug">[],
  unresolvedTargetsOut?: Map<string, BrowseRouteTarget>
): PaneTabCollection {
  const resolved = resolveBrowseRouteTarget(target, connections);
  const connectionId =
    resolved?.connectionId ?? (target.kind === "local" ? `local-drive:${target.targetId}` : `missing-smb:${target.targetId}`);
  if (!resolved) {
    unresolvedTargetsOut?.set(collection.selectedTabId, target);
  }
  const archiveLocation: ArchiveLocation | null = target.virtualLocation
    ? {
        providerId: target.virtualLocation.providerId,
        archivePath: target.virtualLocation.sourcePath,
        virtualPath: target.virtualLocation.virtualPath,
      }
    : null;
  const rawPhysicalPath = archiveLocation
    ? archiveLocation.archivePath.includes("/")
      ? archiveLocation.archivePath.slice(0, archiveLocation.archivePath.lastIndexOf("/"))
      : ""
    : target.path;
  const physicalPath = normalizeLocalDrivePath(connectionId, rawPhysicalPath);

  const selected = collection.sessions.get(collection.selectedTabId);
  if (!selected) {
    return collection;
  }

  const updatedSessions = new Map(collection.sessions);
  updatedSessions.set(selected.id, {
    ...selected,
    connectionId,
    currentPath: physicalPath,
    archiveLocation,
    items: [],
    hasPhysicalListing: false,
    hasArchiveListing: false,
    listingTimestamp: null,
    invalidated: false,
    unmonitoredWhileHidden: true,
    evicted: false,
    archiveNextCursor: null,
    archiveHasMore: false,
    selectedFiles: new Set(),
    selectionAnchor: null,
    focusedIndex: 0,
    focusedItemIdentity: null,
    scrollOffset: 0,
  });

  return {
    ...collection,
    sessions: updatedSessions,
  };
}

export interface ResolvedRestoredWorkspace {
  isMatchingReload: boolean;
  paneMode: PaneMode;
  activePaneId: PaneId;
  left: PaneTabCollection;
  right: PaneTabCollection | null;
  unresolvedTargets: Map<string, BrowseRouteTarget>;
}

/**
 * Applies session-restoration precedence:
 * 1. Explicit incoming routes control visible addressed locations while preserving background tabs.
 * 2. Matching reloads restore full tab collections, selected tab IDs, and hidden-pane tabs.
 */
export function resolveRestoredWorkspaceTabs(
  record: PersistedWorkspaceTabsRecord,
  incomingRoute: Pick<BrowseRouteState, "left" | "right" | "activePaneId">,
  connections: readonly Pick<Connection, "id" | "slug">[]
): ResolvedRestoredWorkspace {
  const unresolvedTargets = new Map<string, BrowseRouteTarget>();
  let left = persistedCollectionToTabCollection(record.left, connections, unresolvedTargets);
  let right = record.right ? persistedCollectionToTabCollection(record.right, connections, unresolvedTargets) : null;

  if (!incomingRoute.left) {
    return {
      isMatchingReload: true,
      paneMode: record.paneMode,
      activePaneId: record.paneMode === "dual" ? record.activePaneId : "left",
      left,
      right,
      unresolvedTargets,
    };
  }

  const incomingIdentity = getWorkspaceBrowseIdentity(incomingRoute);
  if (incomingIdentity === record.workspaceRouteIdentity) {
    return {
      isMatchingReload: true,
      paneMode: incomingRoute.right ? "dual" : "single",
      activePaneId: incomingRoute.right ? incomingRoute.activePaneId : "left",
      left,
      right,
      unresolvedTargets,
    };
  }

  left = applyIncomingTargetToSelectedTab(left, incomingRoute.left, connections, unresolvedTargets);
  if (incomingRoute.right) {
    if (!right) {
      right = hydrateTabCollection([createEmptyTabSession()], "");
    }
    right = applyIncomingTargetToSelectedTab(right, incomingRoute.right, connections, unresolvedTargets);
    return {
      isMatchingReload: false,
      paneMode: "dual",
      activePaneId: incomingRoute.activePaneId,
      left,
      right,
      unresolvedTargets,
    };
  }

  return {
    isMatchingReload: false,
    paneMode: "single",
    activePaneId: "left",
    left,
    right,
    unresolvedTargets,
  };
}

/** Extracts namespaced pane-tab IDs from React Router history state if present and valid. */
export function readPaneTabHistoryState(state: unknown): PaneTabHistoryMetadata | null {
  if (typeof state !== "object" || state === null) {
    return null;
  }
  const container = state as Record<string, unknown>;
  const raw = container[PANE_TAB_HISTORY_STATE_KEY];
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const candidate = raw as Partial<PaneTabHistoryMetadata>;
  if (typeof candidate.leftTabId !== "string" || candidate.leftTabId.length === 0) {
    return null;
  }
  if (candidate.rightTabId !== null && (typeof candidate.rightTabId !== "string" || candidate.rightTabId.length === 0)) {
    return null;
  }
  return {
    leftTabId: candidate.leftTabId,
    rightTabId: candidate.rightTabId,
  };
}

/** Merges namespaced pane-tab IDs into router location state without clobbering router/caller keys. */
export function withPaneTabHistoryState(existingState: unknown, metadata: PaneTabHistoryMetadata): Record<string, unknown> {
  const base = typeof existingState === "object" && existingState !== null ? (existingState as Record<string, unknown>) : {};
  return {
    ...base,
    [PANE_TAB_HISTORY_STATE_KEY]: {
      leftTabId: metadata.leftTabId,
      rightTabId: metadata.rightTabId,
    },
  };
}
