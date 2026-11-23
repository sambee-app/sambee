import { authSession } from "../../services/authSession";
import { normalizeLocalDrivePath } from "../../services/backendRouter";
import { logger } from "../../services/logger";
import type { Connection } from "../../types";
import { randomUuid } from "../../utils/randomUuid";
import {
  type BrowseRouteState,
  type BrowseRouteTarget,
  buildBrowseRouteTarget,
  getBrowseParentPath,
  resolveBrowseRouteTarget,
  serializeBrowseRoute,
} from "./routing";
import {
  createEmptyTabSession,
  DEFAULT_TAB_SORT_DIRECTION,
  DEFAULT_TAB_SORT_FIELD,
  hydrateTabCollection,
  type PaneTabCollection,
  type PaneTabSummary,
} from "./tabSessions";
import type { PaneId, PaneMode, SortField } from "./types";

export const LEGACY_PANE_TABS_KEY = "sambee:pane-tabs-session";
export const WORKSPACE_TAB_RECORD_PREFIX = "sambee:workspace-tabs:";
export const WORKSPACE_PAGE_ID_KEY = "sambee:workspace-page-id";
export const WORKSPACE_PAGE_HISTORY_KEY = "sambeeWorkspacePageId";
export const PANE_TAB_HISTORY_STATE_KEY = "sambeePaneTabs";
export const MAX_CLOSED_WORKSPACE_TAB_RECORDS = 50;
export const WORKSPACE_TAB_CHANNEL = "sambee-workspace-tabs";
const LIVENESS_WAIT_MS = 250;

type UserScope = string | null;
type WorkspaceRoute = Pick<BrowseRouteState, "left" | "right" | "activePaneId">;
type Connections = readonly Pick<Connection, "id" | "slug">[];

interface StoredTab {
  id: string;
  kind: BrowseRouteTarget["kind"];
  targetId: string;
  path?: string;
  archive?: { sourcePath: string; virtualPath: string };
  sortBy?: SortField;
  sortDirection?: "asc" | "desc";
}

interface StoredPane {
  selectedTabId: string;
  tabs: StoredTab[];
}

export interface PersistedWorkspaceTabsRecord {
  schemaVersion: 2;
  userScope: UserScope;
  updatedAt: number;
  paneMode: PaneMode;
  activePaneId: PaneId;
  left: StoredPane;
  right: StoredPane | null;
}

export interface PaneTabHistoryMetadata {
  leftTabId: string;
  rightTabId: string | null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nonempty(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isSortField(value: unknown): value is SortField {
  return value === "name" || value === "size" || value === "modified" || value === "type";
}

function isSortDirection(value: unknown): value is "asc" | "desc" {
  return value === "asc" || value === "desc";
}

function isArchive(value: unknown): value is NonNullable<StoredTab["archive"]> {
  return isObject(value) && nonempty(value["sourcePath"]) && typeof value["virtualPath"] === "string";
}

function isKind(value: unknown): value is StoredTab["kind"] {
  return value === "smb" || value === "local";
}

function isStoredTab(value: unknown): value is StoredTab {
  if (!isObject(value)) return false;
  const { id, kind, targetId, archive, path, sortBy, sortDirection } = value;
  return (
    nonempty(id) &&
    isKind(kind) &&
    nonempty(targetId) &&
    (archive === undefined ? typeof path === "string" : isArchive(archive) && path === undefined) &&
    (sortBy === undefined || isSortField(sortBy)) &&
    (sortDirection === undefined || isSortDirection(sortDirection))
  );
}

function isStoredPane(value: unknown): value is StoredPane {
  if (!isObject(value)) return false;
  const { tabs, selectedTabId } = value;
  if (!Array.isArray(tabs) || !tabs.every(isStoredTab)) return false;
  const ids = new Set(tabs.map((tab) => tab.id));
  return nonempty(selectedTabId) && ids.has(selectedTabId) && ids.size === tabs.length;
}

function isStoredRecord(value: unknown): value is PersistedWorkspaceTabsRecord {
  if (!isObject(value)) return false;
  const { schemaVersion, userScope, updatedAt, paneMode, activePaneId, left, right } = value;
  return (
    schemaVersion === 2 &&
    (userScope === null || typeof userScope === "string") &&
    typeof updatedAt === "number" &&
    Number.isFinite(updatedAt) &&
    (paneMode === "single" || paneMode === "dual") &&
    (activePaneId === "left" || activePaneId === "right") &&
    isStoredPane(left) &&
    (right === null || isStoredPane(right))
  );
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function readRecord(pageId: string): PersistedWorkspaceTabsRecord | null {
  const raw = localStorage.getItem(WORKSPACE_TAB_RECORD_PREFIX + pageId);
  if (raw === null) return null;
  const parsed = parseJson(raw);
  if (isStoredRecord(parsed)) return parsed;
  logger.warn("Ignoring invalid workspace tab record", { pageId }, "browser");
  return null;
}

function listRecords(scope: UserScope) {
  const records: { pageId: string; record: PersistedWorkspaceTabsRecord }[] = [];
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith(WORKSPACE_TAB_RECORD_PREFIX)) continue;
    const pageId = key.slice(WORKSPACE_TAB_RECORD_PREFIX.length);
    if (!pageId) continue;
    const record = readRecord(pageId);
    if (record?.userScope === scope) records.push({ pageId, record });
  }
  return records;
}

function hasWorkspaceRecords(): boolean {
  for (let index = 0; index < localStorage.length; index += 1) {
    if (localStorage.key(index)?.startsWith(WORKSPACE_TAB_RECORD_PREFIX)) return true;
  }
  return false;
}

export function readWorkspacePageId(): string | null {
  try {
    const id = sessionStorage.getItem(WORKSPACE_PAGE_ID_KEY);
    if (id) return id;
  } catch (error) {
    logger.debug("Cannot read the workspace page ID from session storage", { error }, "browser");
  }
  const state: unknown = window.history.state;
  const id = isObject(state) ? state[WORKSPACE_PAGE_HISTORY_KEY] : null;
  return nonempty(id) ? id : null;
}

export function stampWorkspacePageHistory(pageId: string | null): void {
  if (!pageId) return;
  const state: unknown = window.history.state;
  if (isObject(state) && state[WORKSPACE_PAGE_HISTORY_KEY] === pageId) return;
  try {
    window.history.replaceState({ ...(isObject(state) ? state : {}), [WORKSPACE_PAGE_HISTORY_KEY]: pageId }, "");
  } catch (error) {
    logger.debug("Cannot update the workspace page ID in history", { error }, "browser");
  }
}

function rememberPageId(pageId: string): void {
  try {
    sessionStorage.setItem(WORKSPACE_PAGE_ID_KEY, pageId);
  } catch (error) {
    logger.debug("Cannot store the workspace page ID in session storage", { error }, "browser");
  }
  stampWorkspacePageHistory(pageId);
}

function compactTab(id: string, target: BrowseRouteTarget, sortBy?: SortField, sortDirection?: "asc" | "desc"): StoredTab {
  const virtual = target.virtualLocation;
  return {
    id,
    kind: target.kind,
    targetId: target.targetId,
    ...(virtual ? { archive: { sourcePath: virtual.sourcePath, virtualPath: virtual.virtualPath } } : { path: target.path }),
    ...(sortBy && sortBy !== DEFAULT_TAB_SORT_FIELD ? { sortBy } : {}),
    ...(sortDirection && sortDirection !== DEFAULT_TAB_SORT_DIRECTION ? { sortDirection } : {}),
  };
}

function migrateLegacyPane(value: unknown): StoredPane | null {
  if (!isObject(value)) return null;
  const { orderedIds, tabs: legacyTabs, selectedTabId } = value;
  if (!Array.isArray(orderedIds) || !Array.isArray(legacyTabs) || !nonempty(selectedTabId)) return null;
  const byId = new Map<string, StoredTab>();
  for (const entry of legacyTabs as unknown[]) {
    if (!isObject(entry)) return null;
    const { id, location, sortBy, sortDirection } = entry;
    if (!nonempty(id) || !isObject(location) || !isObject(location["target"])) return null;
    const { kind, targetId, path, virtualLocation } = location["target"];
    if (
      !isKind(kind) ||
      !nonempty(targetId) ||
      typeof path !== "string" ||
      (virtualLocation !== undefined &&
        (!isObject(virtualLocation) || virtualLocation["providerId"] !== "zip" || !isArchive(virtualLocation))) ||
      !isSortField(sortBy) ||
      !isSortDirection(sortDirection) ||
      byId.has(id)
    )
      return null;
    byId.set(
      id,
      compactTab(
        id,
        {
          kind,
          targetId,
          path,
          ...(isArchive(virtualLocation)
            ? { virtualLocation: { providerId: "zip", sourcePath: virtualLocation.sourcePath, virtualPath: virtualLocation.virtualPath } }
            : {}),
        },
        sortBy,
        sortDirection
      )
    );
  }
  const tabs: StoredTab[] = [];
  for (const id of orderedIds as unknown[]) {
    const tab = typeof id === "string" ? byId.get(id) : undefined;
    if (!tab) return null;
    tabs.push(tab);
  }
  const pane = { tabs, selectedTabId };
  return tabs.length === byId.size && isStoredPane(pane) ? pane : null;
}

function readLegacyRecord(scope: UserScope): PersistedWorkspaceTabsRecord | null {
  try {
    const raw = sessionStorage.getItem(LEGACY_PANE_TABS_KEY);
    if (raw === null) return null;
    const legacy = parseJson(raw);
    // Keep an old tab's private record isolated if it signs in as a different user.
    if (isObject(legacy) && legacy["schemaVersion"] === 1 && legacy["userScope"] !== scope) return null;
    const candidate =
      isObject(legacy) && legacy["schemaVersion"] === 1
        ? {
            schemaVersion: 2,
            userScope: scope,
            updatedAt: Date.now(),
            paneMode: legacy["paneMode"],
            activePaneId: legacy["activePaneId"],
            left: migrateLegacyPane(legacy["left"]),
            right: legacy["right"] === null ? null : (migrateLegacyPane(legacy["right"]) ?? undefined),
          }
        : null;
    if (isStoredRecord(candidate)) return candidate;
    sessionStorage.removeItem(LEGACY_PANE_TABS_KEY);
    logger.warn("Discarding invalid legacy pane tab record", undefined, "browser");
  } catch (error) {
    logger.debug("Cannot read legacy pane tab storage", { error }, "browser");
  }
  return null;
}

function removeMigratedRecord(): void {
  try {
    sessionStorage.removeItem(LEGACY_PANE_TABS_KEY);
  } catch (error) {
    logger.debug("Cannot remove the migrated pane tab record", { error }, "browser");
  }
}

function storedTarget(tab: StoredTab): BrowseRouteTarget {
  const { kind, targetId, archive } = tab;
  return archive
    ? {
        kind,
        targetId,
        path: [archive.sourcePath, archive.virtualPath].filter(Boolean).join("/"),
        virtualLocation: { ...archive, providerId: "zip" },
      }
    : { kind, targetId, path: tab.path ?? "" };
}

export function getWorkspaceBrowseIdentity(route: WorkspaceRoute): string {
  return serializeBrowseRoute({ left: route.left, right: route.right, activePaneId: route.right ? route.activePaneId : "left" });
}

function selectedTarget(pane: StoredPane): BrowseRouteTarget {
  return storedTarget(pane.tabs.find((tab) => tab.id === pane.selectedTabId)!);
}

export function getStoredWorkspaceRoute(record: PersistedWorkspaceTabsRecord): WorkspaceRoute {
  const right = record.paneMode === "dual" && record.right ? selectedTarget(record.right) : null;
  return { left: selectedTarget(record.left), right, activePaneId: right ? record.activePaneId : "left" };
}

export interface WorkspaceTabState {
  paneMode: PaneMode;
  activePaneId: PaneId;
  leftTabs: readonly PaneTabSummary[];
  leftSelectedTabId: string;
  rightTabs: readonly PaneTabSummary[];
  rightSelectedTabId: string;
  connections: Connections;
  fallbackTargets: ReadonlyMap<string, BrowseRouteTarget>;
}

function serializePane(
  tabs: readonly PaneTabSummary[],
  selectedTabId: string,
  { connections, fallbackTargets }: WorkspaceTabState
): StoredPane | null {
  const stored: StoredTab[] = [];
  for (const tab of tabs) {
    if (!tab.connectionId || !tab.id) continue;
    const archive = tab.archiveLocation;
    const target =
      buildBrowseRouteTarget(
        tab.connectionId,
        tab.currentPath,
        connections,
        archive && {
          providerId: archive.providerId,
          sourcePath: archive.archivePath,
          virtualPath: archive.virtualPath,
        }
      ) ?? fallbackTargets.get(tab.id);
    if (target) stored.push(compactTab(tab.id, target, tab.sortBy, tab.sortDirection));
  }
  const first = stored[0];
  return first ? { tabs: stored, selectedTabId: stored.some((tab) => tab.id === selectedTabId) ? selectedTabId : first.id } : null;
}

let hasReportedStorageUnavailable = false;

export function resetPaneTabsStorageStateForTesting(): void {
  hasReportedStorageUnavailable = false;
}

function reportUnavailable(error: unknown): boolean {
  if (hasReportedStorageUnavailable) return false;
  hasReportedStorageUnavailable = true;
  logger.warn("Local storage is unavailable for workspace tab restoration", { error }, "browser");
  return true;
}

function openChannel(): BroadcastChannel | null {
  try {
    return typeof BroadcastChannel === "undefined" ? null : new BroadcastChannel(WORKSPACE_TAB_CHANNEL);
  } catch (error) {
    logger.warn("Cannot open the workspace tab channel", { error }, "browser");
    return null;
  }
}

type ChannelMessage =
  | { type: "liveness-query"; queryId: string }
  | { type: "liveness-reply"; queryId: string; pageId: string }
  | { type: "sign-out"; userScope: UserScope };

function send(channel: BroadcastChannel | null, message: ChannelMessage): void {
  try {
    channel?.postMessage(message);
  } catch (error) {
    logger.warn("Cannot send a workspace tab message", { error }, "browser");
  }
}

async function findLivePages(locks: LockManager | undefined, channel: BroadcastChannel | null): Promise<Set<string>> {
  if (locks) {
    const snapshot = await locks.query();
    return new Set(
      snapshot.held?.flatMap(({ name }) =>
        name?.startsWith(WORKSPACE_TAB_RECORD_PREFIX) ? [name.slice(WORKSPACE_TAB_RECORD_PREFIX.length)] : []
      ) ?? []
    );
  }
  const live = new Set<string>();
  if (!channel) return live;
  const queryId = randomUuid();
  const onReply = ({ data }: MessageEvent<unknown>) => {
    if (!isObject(data)) return;
    const { type, queryId: replyId, pageId } = data;
    if (type === "liveness-reply" && replyId === queryId && nonempty(pageId)) live.add(pageId);
  };
  channel.addEventListener("message", onReply);
  try {
    send(channel, { type: "liveness-query", queryId });
    await new Promise<void>((resolve) => setTimeout(resolve, LIVENESS_WAIT_MS));
    return live;
  } finally {
    channel.removeEventListener("message", onReply);
  }
}

function tryHold(locks: LockManager, pageId: string): Promise<(() => void) | null> {
  return new Promise((resolve, reject) => {
    void locks
      .request(WORKSPACE_TAB_RECORD_PREFIX + pageId, { mode: "exclusive", ifAvailable: true }, (lock) => {
        if (!lock) return resolve(null);
        return new Promise<void>((release) => resolve(release));
      })
      .catch(reject);
  });
}

async function pruneClosed(scope: UserScope, locks: LockManager | undefined, live: Set<string>, extraBytes = 0): Promise<void> {
  const closed = listRecords(scope)
    .filter(({ pageId }) => !live.has(pageId))
    .sort((a, b) => a.record.updatedAt - b.record.updatedAt);
  let excess = Math.max(0, closed.length - MAX_CLOSED_WORKSPACE_TAB_RECORDS);
  for (const { pageId, record } of closed) {
    if (excess <= 0 && extraBytes <= 0) break;
    // Recheck ownership under the same lock used to claim a record.
    const release = locks ? await tryHold(locks, pageId) : () => {};
    if (!release) continue;
    try {
      const current = readRecord(pageId);
      if (current?.userScope !== scope || current.updatedAt !== record.updatedAt) continue;
      const key = WORKSPACE_TAB_RECORD_PREFIX + pageId;
      extraBytes -= key.length + (localStorage.getItem(key)?.length ?? 0);
      localStorage.removeItem(key);
      excess -= 1;
    } finally {
      release();
    }
  }
}

export interface WorkspaceTabClaim {
  readonly pageId: string | null;
  readonly record: PersistedWorkspaceTabsRecord | null;
  readonly fromClosed: boolean;
  readonly notifyUnavailable: boolean;
  markHydrated(): void;
  save(state: WorkspaceTabState, notify: (unavailable: boolean) => void): void;
}

/** Acquires a page record for the lifetime of the root owner. The signal also cancels an in-flight claim. */
export async function claimWorkspaceTabs(
  scopeReady: UserScope | Promise<UserScope>,
  route: WorkspaceRoute,
  signal: AbortSignal
): Promise<WorkspaceTabClaim> {
  const reference = readWorkspacePageId();
  const locks = navigator.locks;
  const channel = openChannel();
  let scope: UserScope | undefined;
  let pageId: string | null = null;
  let release: (() => void) | null = null;
  let record: PersistedWorkspaceTabsRecord | null = null;
  let fromClosed = false;
  let notifyUnavailable = false;
  let stopped = false;
  let storedJson: string | null = null;
  let migrationPending = false;
  const signOuts = new Set<UserScope>();

  const releaseOwnership = () => {
    release?.();
    release = null;
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    activeOwners.delete(onSignOut);
    releaseOwnership();
    channel?.close();
    signal.removeEventListener("abort", stop);
  };
  const onSignOut = (signedOut: UserScope) => {
    signOuts.add(signedOut);
    if (signedOut !== scope) return;
    record = null;
    stop();
    if (pageId) {
      try {
        const key = WORKSPACE_TAB_RECORD_PREFIX + pageId;
        if (readRecord(pageId)?.userScope === signedOut) localStorage.removeItem(key);
      } catch (error) {
        logger.warn("Cannot remove the signed-out workspace", { error }, "browser");
      }
    }
  };
  activeOwners.add(onSignOut);
  signal.addEventListener("abort", stop, { once: true });
  if (signal.aborted) stop();
  channel?.addEventListener("message", ({ data }: MessageEvent<unknown>) => {
    if (!isObject(data)) return;
    const { type, userScope, queryId } = data;
    if (type === "sign-out" && (userScope === null || typeof userScope === "string")) onSignOut(userScope);
    if (!stopped && pageId && type === "liveness-query" && nonempty(queryId)) {
      send(channel, { type: "liveness-reply", queryId, pageId });
    }
  });

  const own = async (id: string, live: Set<string>): Promise<boolean> => {
    if (stopped) return false;
    const token = locks ? await tryHold(locks, id) : live.has(id) ? null : () => {};
    if (stopped) {
      token?.();
      return false;
    }
    if (!token) return false;
    pageId = id;
    release = token;
    return true;
  };

  let pendingRetry = false;
  let latestJson: string | null = null;
  const write = (json: string): boolean => {
    if (stopped || !pageId || scope !== authSession.getUserId()) return false;
    let key = WORKSPACE_TAB_RECORD_PREFIX + pageId;
    // A sign-out in another page can delete the record before its broadcast arrives.
    if (storedJson !== null) {
      const current = localStorage.getItem(key);
      if (current === null) {
        stop();
        return false;
      }
      // On HTTP, a frozen page can miss the liveness query. Do not overwrite
      // a workspace that another page has since saved under the same ID.
      if (!locks && JSON.stringify(parseJson(current)) !== storedJson) {
        pageId = randomUuid();
        key = WORKSPACE_TAB_RECORD_PREFIX + pageId;
        storedJson = null;
        rememberPageId(pageId);
      }
    }
    localStorage.setItem(key, json);
    storedJson = json;
    if (migrationPending) {
      migrationPending = false;
      removeMigratedRecord();
    }
    return true;
  };

  const save = (next: PersistedWorkspaceTabsRecord, notify: (unavailable: boolean) => void): boolean => {
    record = next;
    const json = JSON.stringify(next);
    latestJson = json;
    try {
      return write(json);
    } catch (error) {
      if (!(error instanceof DOMException) || error.name !== "QuotaExceededError" || scope === undefined) {
        notify(reportUnavailable(error));
        return false;
      }
      if (pendingRetry) return false;
      pendingRetry = true;
      const retryScope = scope;
      void (async () => {
        try {
          const live = await findLivePages(locks, channel);
          if (stopped || !pageId) return;
          live.add(pageId);
          const currentLength = localStorage.getItem(WORKSPACE_TAB_RECORD_PREFIX + pageId)?.length ?? 0;
          await pruneClosed(retryScope, locks, live, Math.max(1, (latestJson?.length ?? 0) - currentLength));
          if (latestJson) write(latestJson);
        } catch (retryError) {
          notify(reportUnavailable(retryError));
        } finally {
          pendingRetry = false;
        }
      })();
      return false;
    }
  };

  if (!stopped) {
    try {
      const livePages = hasWorkspaceRecords() ? findLivePages(locks, channel) : new Set<string>();
      const [resolvedScope, live] = await Promise.all([scopeReady, livePages]);
      scope = resolvedScope;
      if (signOuts.has(scope)) stop();
      if (!stopped) {
        const referenced = reference ? readRecord(reference) : null;
        if (reference && referenced?.userScope === scope) {
          if (await own(reference, live)) {
            const current = readRecord(reference);
            if (current?.userScope === scope) {
              record = current;
              storedJson = JSON.stringify(current);
            } else {
              releaseOwnership();
              pageId = null;
            }
          } else if (!stopped && (await own(randomUuid(), live))) {
            const current = readRecord(reference);
            if (current?.userScope === scope)
              save({ ...current, updatedAt: Date.now() }, (notify) => {
                notifyUnavailable ||= notify;
              });
          }
        }
        // Prefer this page's pre-upgrade data to unrelated closed workspaces.
        const legacy = !record && !stopped ? readLegacyRecord(scope) : null;
        if (legacy && (pageId || (await own(randomUuid(), live)))) {
          migrationPending = true;
          save(legacy, (notify) => {
            notifyUnavailable ||= notify;
          });
        }
        if (!pageId && !stopped) {
          const identity = getWorkspaceBrowseIdentity(route);
          const candidates = listRecords(scope).filter(({ pageId: id }) => locks || !live.has(id));
          const rank = (candidate: PersistedWorkspaceTabsRecord) =>
            Number(getWorkspaceBrowseIdentity(getStoredWorkspaceRoute(candidate)) === identity);
          candidates.sort((a, b) => rank(b.record) - rank(a.record) || b.record.updatedAt - a.record.updatedAt);
          for (const candidate of candidates) {
            if (await own(candidate.pageId, live)) {
              const current = readRecord(candidate.pageId);
              if (current?.userScope === scope) {
                record = current;
                fromClosed = true;
                storedJson = JSON.stringify(current);
                break;
              }
              releaseOwnership();
              pageId = null;
            }
          }
        }
        if (!pageId && !stopped) await own(randomUuid(), live);
        if (pageId && !stopped) {
          rememberPageId(pageId);
          live.add(pageId);
          await pruneClosed(scope, locks, live);
        }
      }
    } catch (error) {
      notifyUnavailable ||= reportUnavailable(error);
      if (!pageId) stop();
    }
  }

  return {
    get pageId() {
      return pageId;
    },
    get record() {
      return record;
    },
    get fromClosed() {
      return fromClosed;
    },
    get notifyUnavailable() {
      return notifyUnavailable;
    },
    markHydrated() {
      fromClosed = false;
    },
    save(state, notify) {
      if (stopped || !pageId || scope === undefined || scope !== authSession.getUserId()) return;
      const left = serializePane(state.leftTabs, state.leftSelectedTabId, state);
      if (!left) return;
      save(
        {
          schemaVersion: 2,
          userScope: scope,
          updatedAt: Date.now(),
          paneMode: state.paneMode,
          activePaneId: state.paneMode === "dual" ? state.activePaneId : "left",
          left,
          right: serializePane(state.rightTabs, state.rightSelectedTabId, state),
        },
        notify
      );
    },
  };
}

const activeOwners = new Set<(scope: UserScope) => void>();

export function clearSignedOutWorkspaceTabs(scope: UserScope): void {
  for (const stop of activeOwners) stop(scope);
  const channel = openChannel();
  try {
    send(channel, { type: "sign-out", userScope: scope });
  } finally {
    channel?.close();
  }
  try {
    for (const { pageId } of listRecords(scope)) localStorage.removeItem(WORKSPACE_TAB_RECORD_PREFIX + pageId);
    // Explicit sign-out must also clear an unmigrated record of this user in this page.
    if (readLegacyRecord(scope)) removeMigratedRecord();
  } catch (error) {
    logger.warn("Cannot clear workspace tabs on sign-out", { error }, "browser");
  }
}

function restoreTab(entry: StoredTab, connections: Connections, unresolvedTargets: Map<string, BrowseRouteTarget>) {
  const target = storedTarget(entry);
  const resolved = resolveBrowseRouteTarget(target, connections);
  const connectionId = resolved?.connectionId ?? `missing-smb:${target.targetId}`;
  if (!resolved) unresolvedTargets.set(entry.id, target);
  else unresolvedTargets.delete(entry.id);
  const archive = target.virtualLocation;
  const path = archive ? getBrowseParentPath(archive.sourcePath) : target.path;
  return createEmptyTabSession(entry.id, {
    connectionId,
    currentPath: normalizeLocalDrivePath(connectionId, path),
    archiveLocation: archive ? { providerId: archive.providerId, archivePath: archive.sourcePath, virtualPath: archive.virtualPath } : null,
    sortBy: entry.sortBy ?? DEFAULT_TAB_SORT_FIELD,
    sortDirection: entry.sortDirection ?? DEFAULT_TAB_SORT_DIRECTION,
    unmonitoredWhileHidden: true,
  });
}

function applyIncomingTarget(pane: StoredPane | null, incoming: BrowseRouteTarget, fromClosed: boolean): StoredPane {
  const entries = pane?.tabs ?? [];
  if (fromClosed) {
    const identity = getWorkspaceBrowseIdentity({ left: incoming, right: null, activePaneId: "left" });
    const matches = (entry: StoredTab) =>
      getWorkspaceBrowseIdentity({ left: storedTarget(entry), right: null, activePaneId: "left" }) === identity;
    const existing = entries.find((entry) => entry.id === pane?.selectedTabId && matches(entry)) ?? entries.find(matches);
    if (existing) return { tabs: entries, selectedTabId: existing.id };
  }
  const selected = fromClosed ? undefined : entries.find((tab) => tab.id === pane?.selectedTabId);
  const replacement = compactTab(selected?.id ?? randomUuid(), incoming, selected?.sortBy, selected?.sortDirection);
  return {
    tabs: selected ? entries.map((tab) => (tab === selected ? replacement : tab)) : [...entries, replacement],
    selectedTabId: replacement.id,
  };
}

export interface ResolvedRestoredWorkspace {
  paneMode: PaneMode;
  activePaneId: PaneId;
  left: PaneTabCollection;
  right: PaneTabCollection | null;
  unresolvedTargets: Map<string, BrowseRouteTarget>;
}

export function resolveRestoredWorkspaceTabs(
  record: PersistedWorkspaceTabsRecord,
  route: WorkspaceRoute,
  connections: Connections,
  fromClosed = false
): ResolvedRestoredWorkspace {
  const storedRoute = getStoredWorkspaceRoute(record);
  const matches = !route.left || getWorkspaceBrowseIdentity(storedRoute) === getWorkspaceBrowseIdentity(route);
  const left = !matches && route.left ? applyIncomingTarget(record.left, route.left, fromClosed) : record.left;
  const right = !matches && route.right ? applyIncomingTarget(record.right, route.right, fromClosed) : record.right;
  const visibleRoute = route.left ? route : storedRoute;
  const unresolvedTargets = new Map<string, BrowseRouteTarget>();
  const hydrate = (pane: StoredPane) =>
    hydrateTabCollection(
      pane.tabs.map((tab) => restoreTab(tab, connections, unresolvedTargets)),
      pane.selectedTabId
    );
  return {
    paneMode: visibleRoute.right ? "dual" : "single",
    activePaneId: visibleRoute.right ? visibleRoute.activePaneId : "left",
    left: hydrate(left),
    right: right ? hydrate(right) : null,
    unresolvedTargets,
  };
}

export function readPaneTabHistoryState(state: unknown): PaneTabHistoryMetadata | null {
  const raw = isObject(state) ? state[PANE_TAB_HISTORY_STATE_KEY] : null;
  if (!isObject(raw)) return null;
  const { leftTabId, rightTabId } = raw;
  if (!nonempty(leftTabId) || (rightTabId !== null && !nonempty(rightTabId))) return null;
  return { leftTabId, rightTabId };
}

export function withPaneTabHistoryState(existingState: unknown, metadata: PaneTabHistoryMetadata): Record<string, unknown> {
  return { ...(isObject(existingState) ? existingState : {}), [PANE_TAB_HISTORY_STATE_KEY]: metadata };
}
