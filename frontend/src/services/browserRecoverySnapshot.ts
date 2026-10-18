import { buildBrowseRouteTarget, parseBrowseRoute } from "../pages/FileBrowser/routing";
import type { ArchiveLocation, FileBrowserPaneRecoverySnapshot, PaneId, PaneMode } from "../pages/FileBrowser/types";
import type { Connection } from "../types";

const BROWSER_RECOVERY_SNAPSHOT_KEY = "sambee:browser-recovery-snapshot";
const BROWSER_RECOVERY_SNAPSHOT_TTL_MS = 30 * 60_000;

export interface BrowserRecoverySnapshot {
  savedAt: number;
  routeUrl: string;
  activePaneId: PaneId;
  paneMode: PaneMode;
  connections: Connection[];
  left: FileBrowserPaneRecoverySnapshot | null;
  right: FileBrowserPaneRecoverySnapshot | null;
}

function isArchiveLocation(value: unknown): value is ArchiveLocation {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const location = value as Partial<ArchiveLocation>;
  return typeof location.providerId === "string" && typeof location.archivePath === "string" && typeof location.virtualPath === "string";
}

function isRecoveryPaneSnapshot(value: unknown): value is FileBrowserPaneRecoverySnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Partial<FileBrowserPaneRecoverySnapshot>;
  return (
    typeof snapshot.connectionId === "string" &&
    typeof snapshot.path === "string" &&
    Array.isArray(snapshot.items) &&
    (snapshot.sortBy === "name" || snapshot.sortBy === "size" || snapshot.sortBy === "modified" || snapshot.sortBy === "type") &&
    (snapshot.sortDirection === "asc" || snapshot.sortDirection === "desc") &&
    (snapshot.viewMode === "list" || snapshot.viewMode === "details") &&
    typeof snapshot.focusedIndex === "number" &&
    (typeof snapshot.focusedFileName === "string" || snapshot.focusedFileName === null) &&
    Array.isArray(snapshot.selectedFileNames) &&
    (snapshot.archiveLocation === undefined || snapshot.archiveLocation === null || isArchiveLocation(snapshot.archiveLocation)) &&
    typeof snapshot.scrollOffset === "number"
  );
}

function isBrowserRecoverySnapshot(value: unknown): value is BrowserRecoverySnapshot {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const snapshot = value as Partial<BrowserRecoverySnapshot>;
  return (
    typeof snapshot.savedAt === "number" &&
    typeof snapshot.routeUrl === "string" &&
    (snapshot.activePaneId === "left" || snapshot.activePaneId === "right") &&
    (snapshot.paneMode === "single" || snapshot.paneMode === "dual") &&
    Array.isArray(snapshot.connections) &&
    (snapshot.left === null || isRecoveryPaneSnapshot(snapshot.left)) &&
    (snapshot.right === null || isRecoveryPaneSnapshot(snapshot.right))
  );
}

export function saveBrowserRecoverySnapshot(snapshot: BrowserRecoverySnapshot): void {
  try {
    sessionStorage.setItem(BROWSER_RECOVERY_SNAPSHOT_KEY, JSON.stringify(snapshot));
  } catch {
    // Ignore storage failures; recovery snapshots are best-effort only.
  }
}

export function loadBrowserRecoverySnapshot(routeUrl?: string): BrowserRecoverySnapshot | null {
  try {
    const raw = sessionStorage.getItem(BROWSER_RECOVERY_SNAPSHOT_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw) as unknown;
    if (!isBrowserRecoverySnapshot(parsed)) {
      clearBrowserRecoverySnapshot();
      return null;
    }

    if (Date.now() - parsed.savedAt > BROWSER_RECOVERY_SNAPSHOT_TTL_MS) {
      clearBrowserRecoverySnapshot();
      return null;
    }

    if (!routeUrl) return parsed;
    const url = new URL(routeUrl, "http://localhost");
    const match = /^\/browse\/(smb|local)\/([^/]+)(?:\/(.*))?$/.exec(url.pathname);
    if (!match) return null;
    const route = parseBrowseRoute({ targetType: match[1], targetId: match[2], path: match[3], searchParams: url.searchParams });
    const matchPane = (pane: FileBrowserPaneRecoverySnapshot | null, target: typeof route.left) => {
      if (!pane || !target) return null;
      const archive = pane.archiveLocation;
      const cached = buildBrowseRouteTarget(
        pane.connectionId,
        pane.path,
        parsed.connections,
        archive ? { providerId: archive.providerId, sourcePath: archive.archivePath, virtualPath: archive.virtualPath } : null
      );
      return cached?.kind === target.kind && cached.targetId === target.targetId && cached.path === target.path
        ? { ...pane, viewInfo: null }
        : null;
    };
    const left = matchPane(parsed.left, route.left);
    const right = matchPane(parsed.right, route.right);
    if (!left && !right) return null;
    return { ...parsed, routeUrl, left, right, paneMode: route.right ? "dual" : "single", activePaneId: route.activePaneId };
  } catch {
    clearBrowserRecoverySnapshot();
    return null;
  }
}

export function clearBrowserRecoverySnapshot(): void {
  try {
    sessionStorage.removeItem(BROWSER_RECOVERY_SNAPSHOT_KEY);
  } catch {
    // Ignore storage failures; recovery snapshots are best-effort only.
  }
}
