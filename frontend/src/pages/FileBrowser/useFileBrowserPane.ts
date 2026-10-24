/**
 * useFileBrowserPane
 * ==================
 *
 * Encapsulates **all** per-pane state and logic for a single file-browser
 * panel: directory loading, caching, sorting, focus management, keyboard
 * navigation, file viewer state, CRUD dialogs, and the TanStack Virtual
 * virtualizer.
 *
 * The parent (Browser) component is responsible for:
 *  - Routing / URL synchronisation
 *  - WebSocket connection (delegates to handleDirectoryChanged)
 *  - Global UI (settings dialog, mobile drawer, help overlay)
 *  - Keyboard shortcut registration (reads handlers from this hook)
 *
 * Multiple instances of this hook can coexist for a dual-pane layout.
 */

import { useVirtualizer } from "@tanstack/react-virtual";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { useDirectorySearchProvider } from "../../components/FileBrowser/search";
import { translate } from "../../i18n";
import { isClientTimeoutError, isLocalAbortError } from "../../services/backendAvailability";
import { isLocalDrive, normalizeLocalDrivePath } from "../../services/backendRouter";
import { browserHistoryService } from "../../services/browserHistoryService";
import { browserLinkTargetService } from "../../services/browserLinkTargetService";
import { type CompanionPairingErrorKind, getLocalDrivePairingErrorKind } from "../../services/localDrivePairing";
import { logger } from "../../services/logger";
import { publishRecentDirectoriesChanged } from "../../services/recentDirectoriesSync";
import { publishRecentFilesChanged } from "../../services/recentFilesSync";
import type { StorageBackendRegistry } from "../../services/storageContracts";
import { useSambeeTheme } from "../../theme";
import type { FileEntry, RecentFileValidationError } from "../../types";
import { FileType, isApiError } from "../../types";
import { getApiErrorMessage } from "../../utils/apiErrors";
import { getAllViewerIds, getCompatibleViewerIds, getFileTypeByExtension, isImageFile, type ViewerId } from "../../utils/FileTypeRegistry";
import { compareLocalizedStrings } from "../../utils/localeFormatting";
import { getConnectionById, isConnectionReadOnly } from "./access";
import {
  createContentItem,
  deleteContentItems,
  getCreateContentItemAvailability,
  getNativeOpenAvailability,
  openContentInNativeApp,
  renameContentItem,
} from "./contentOperations";
import {
  type BrowserItem,
  type ContentCapabilities,
  type ContentItemHandle,
  type ContentLocation,
  isVirtualItem,
  physicalItem,
  physicalItemHandle,
  physicalLocation,
  type VirtualItemHandle,
  virtualItem,
  virtualLocation,
} from "./contentProviders";
import {
  useFileBrowserViewModePreference,
  useQuickNavIncludeDotDirectoriesPreference,
  writeSelectedConnectionIdPreference,
} from "./preferences";
import type {
  ArchiveLocation,
  BrowserOpenMode,
  DirectoryChange,
  FileBrowserPaneRecoverySnapshot,
  SortField,
  UseFileBrowserPaneConfig,
  UseFileBrowserPaneReturn,
} from "./types";
import { getPreferredViewerId, setPreferredViewerId } from "./viewerPreferences";

// ============================================================================
// Constants
// ============================================================================

/** How long a cached directory listing is considered fresh. */
const DIRECTORY_CACHE_TTL_MS = 30_000;
const INCREMENTAL_SEARCH_RESET_DELAY_MS = 1_000;

/**
 * After an explicit forced reload (e.g. delete / rename), WebSocket-triggered
 * reloads within this window are suppressed to avoid double-fetches.
 */
const RELOAD_DEDUP_WINDOW_MS = 2_000;
const REALTIME_REFRESH_INTERVAL_MS = 1_000;
const DIRECTORY_LOAD_GENERIC_ERROR = "Failed to load directory contents. Please try again.";
const DIRECTORY_LOAD_NETWORK_ERROR = "Failed to load files. Please check your connection settings.";
const DIRECTORY_LOAD_TIMEOUT_ERROR = "Directory listing timed out. The remote share took too long to respond.";
const ARCHIVE_LOAD_ERROR = "Archive contents could not be loaded.";
const ARCHIVE_MEMBER_OPEN_ERROR = "Archive member could not be opened.";
const ARCHIVE_LIST_PAGE_SIZE = 100;
const ARCHIVE_ROUTE_RESOLUTION_PAGE_SIZE = 500;
const VIRTUAL_PAGE_PRELOAD_THRESHOLD = 15;
const RECENT_FILE_DEFAULT_ERROR = "The recent file could not be opened.";
const RECENT_FILE_MISSING_ERROR = "The recent file no longer exists.";

const UNAVAILABLE_STORAGE_REGISTRY: StorageBackendRegistry = {
  resolveDirectory() {
    throw new Error("Storage services are unavailable");
  },
  resolveItem() {
    throw new Error("Storage services are unavailable");
  },
  getBackend() {
    throw new Error("Storage services are unavailable");
  },
  getCapabilities() {
    return {
      readable: false,
      writable: false,
      canList: false,
      canReadArchive: false,
      canEditText: false,
      preview: { imageConversion: false, imageResizing: false, pdfNormalization: false },
      canWriteFile: false,
      canResolveActivation: false,
      canOpenInNativeApp: false,
    };
  },
};

interface ResolvedRouteLocation {
  physicalPath: string;
  archiveLocation: ArchiveLocation | null;
  canonicalPath: string;
}

function getArchiveNavigationKey(location: ArchiveLocation): string {
  return `${location.providerId}\u0001${location.archivePath}\u0001${location.virtualPath}`;
}

function joinRoutePath(...parts: string[]): string {
  return parts.filter(Boolean).join("/");
}

function getResponseStatus(error: unknown): number | undefined {
  return isApiError(error) ? error.response?.status : undefined;
}

export function shouldLoadNextVirtualPage({
  hasNextPage,
  isLoadingNextPage,
  lastRenderedIndex,
  loadedItemCount,
  scrollDirection,
  viewportIsUnderfilled,
}: {
  hasNextPage: boolean;
  isLoadingNextPage: boolean;
  lastRenderedIndex: number;
  loadedItemCount: number;
  scrollDirection: string | null;
  viewportIsUnderfilled: boolean | null;
}): boolean {
  if (!hasNextPage || isLoadingNextPage) {
    return false;
  }

  if (viewportIsUnderfilled === null) {
    return false;
  }

  if (viewportIsUnderfilled) {
    return true;
  }

  return scrollDirection === "forward" && lastRenderedIndex >= loadedItemCount - VIRTUAL_PAGE_PRELOAD_THRESHOLD;
}

const STALE_RECENT_FILE_CODES = new Set<RecentFileValidationError["code"]>([
  "recent_file_target_missing",
  "recent_file_target_not_file",
  "recent_file_native_launch_failed",
  "recent_file_invalid_path",
  "recent_file_connection_removed",
  "recent_file_access_denied",
]);

type ActivationCurrentGuard = () => boolean;

type DirectoryEntryIntent = { kind: "fresh" } | { kind: "restore-history" } | { kind: "parent-return"; childName: string };

type ReloadCurrentLocationOptions = {
  forceRefresh?: boolean;
  preserveVisibleContent?: boolean;
};

type PendingLocationReload = {
  connectionId: string;
  path: string;
  options: ReloadCurrentLocationOptions;
};

// ============================================================================
// Helpers
// ============================================================================

function toPhysicalItems(connectionId: string, path: string, entries: FileEntry[]): BrowserItem[] {
  const location = physicalLocation(connectionId, path);
  return entries.map((entry) => physicalItem(location, entry));
}

function archiveLocationsMatch(left: ArchiveLocation | null, right: ArchiveLocation | null): boolean {
  return left?.providerId === right?.providerId && left?.archivePath === right?.archivePath && left?.virtualPath === right?.virtualPath;
}

/** Generate a unique viewer session id for logging. */
const createViewerSessionId = (): string => {
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${randomPart}`;
};

function getRecentFileValidationError(error: unknown): RecentFileValidationError | null {
  if (!isApiError(error)) return null;
  const detail = error.response?.data?.detail;
  if (
    typeof detail === "object" &&
    detail !== null &&
    "code" in detail &&
    "message" in detail &&
    typeof detail.code === "string" &&
    typeof detail.message === "string"
  ) {
    return detail as RecentFileValidationError;
  }
  return null;
}

function getApiErrorCode(error: unknown): string | null {
  if (!isApiError(error)) return null;
  const code = error.response?.data?.code;
  return typeof code === "string" ? code : null;
}

function recordRecentHistoryEntry({
  connectionId,
  path,
  expectedType,
  record,
  hasItemType,
  publish,
  itemName,
}: {
  connectionId: string;
  path: string;
  expectedType: FileType;
  hasItemType: (connectionId: string, path: string, expectedType: FileType) => Promise<boolean>;
  record: (connectionId: string, path: string) => Promise<unknown>;
  publish: () => void;
  itemName: "directory" | "file";
}): void {
  if (isLocalDrive(connectionId)) {
    void hasItemType(connectionId, path, expectedType)
      .then((matchesExpectedType) => (matchesExpectedType ? record(connectionId, path).then(() => true) : false))
      .catch((error: unknown) => logger.warn(`Failed to qualify local recent ${itemName}`, { connectionId, path, error }, "browser"));
    return;
  }

  void Promise.resolve()
    .then(() => record(connectionId, path))
    .then(() => publish())
    .catch((error: unknown) => logger.warn(`Failed to record recent ${itemName}`, { connectionId, path, error }, "browser"));
}

// ============================================================================
// Hook
// ============================================================================

export function useFileBrowserPane(config: UseFileBrowserPaneConfig): UseFileBrowserPaneReturn {
  const {
    rowHeight,
    connections = [],
    contentProviders,
    storageRegistry,
    history,
    linkTargets,
    disabled = false,
    isActive = true,
    onCompanionHint,
    onNavigatePath,
    onNavigateConnection,
    onNavigateDirectory,
    onNavigateVirtualLocation,
    onResolveRouteLocation,
    onOpenViewer,
  } = config;
  const providerRegistry = contentProviders;

  const { currentTheme } = useSambeeTheme();

  // ──────────────────────────────────────────────────────────────────────────
  // Core State
  // ──────────────────────────────────────────────────────────────────────────

  const [connectionId, setConnectionId] = useState<string>("");
  const [currentPath, setCurrentPath] = useState<string>("");
  const [archiveLocation, setArchiveLocation] = useState<ArchiveLocation | null>(null);
  const [archiveHasMore, setArchiveHasMore] = useState(false);
  const [archiveLoadingMore, setArchiveLoadingMore] = useState(false);
  const [items, setItems] = useState<BrowserItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [companionPairingError, setCompanionPairingError] = useState<{ kind: CompanionPairingErrorKind; message: string } | null>(null);
  const files = useMemo(() => items.map((item) => item.entry), [items]);

  // ──────────────────────────────────────────────────────────────────────────
  // UI Preferences
  // ──────────────────────────────────────────────────────────────────────────

  const [sortBy, setSortBy] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("asc");
  const [viewMode, setViewMode] = useFileBrowserViewModePreference();
  const [focusedIndex, setFocusedIndex] = useState<number>(0);
  const [includeDotDirectoriesInQuickNav] = useQuickNavIncludeDotDirectoriesPreference();

  // ──────────────────────────────────────────────────────────────────────────
  // Selection State (multi-select)
  // ──────────────────────────────────────────────────────────────────────────

  /** Set of currently selected canonical file paths. */
  const [selectedFiles, setSelectedFiles] = useState<Set<string>>(new Set());
  const selectionAnchorRef = React.useRef<string | null>(null);

  useEffect(() => {
    if (selectedFiles.size === 0) selectionAnchorRef.current = null;
  }, [selectedFiles]);

  // ──────────────────────────────────────────────────────────────────────────
  // Viewer State
  // ──────────────────────────────────────────────────────────────────────────

  const [viewInfo, setViewInfo] = useState<UseFileBrowserPaneReturn["viewInfo"]>(null);
  const [browserViewerPickerState, setBrowserViewerPickerState] = useState<UseFileBrowserPaneReturn["browserViewerPickerState"]>(null);
  const browserViewerPickerConfirmationTokenRef = React.useRef(0);

  // ──────────────────────────────────────────────────────────────────────────
  // CRUD Dialog State
  // ──────────────────────────────────────────────────────────────────────────

  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);
  const [deleteTargets, setDeleteTargets] = useState<BrowserItem[]>([]);
  const [isDeleting, setIsDeleting] = useState(false);

  const [renameDialogOpen, setRenameDialogOpen] = useState(false);
  const [renameTarget, setRenameTarget] = useState<BrowserItem | null>(null);
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameError, setRenameError] = useState<string | null>(null);

  const [createDialogOpen, setCreateDialogOpen] = useState(false);
  const [createItemType, setCreateItemType] = useState<FileType>(FileType.DIRECTORY);
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  // ──────────────────────────────────────────────────────────────────────────
  // Companion App State
  // ──────────────────────────────────────────────────────────────────────────

  const [openInAppLoading, setOpenInAppLoading] = useState(false);

  const selectedConnection = useMemo(() => getConnectionById(connections, connectionId), [connections, connectionId]);
  const connectionIsReadOnly = isConnectionReadOnly(selectedConnection);
  const currentContentLocation = useMemo<ContentLocation>(() => {
    if (archiveLocation) {
      return virtualLocation(
        archiveLocation.providerId,
        connectionId,
        physicalLocation(connectionId, archiveLocation.archivePath),
        archiveLocation.virtualPath
      );
    }
    return physicalLocation(connectionId, currentPath);
  }, [archiveLocation, connectionId, currentPath]);
  const contentCapabilities: ContentCapabilities = providerRegistry.getCapabilities(currentContentLocation);
  const contentOperationEnvironment = useMemo(
    () => ({
      isCompanionPaired: false,
      storageRegistry: storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY,
      history: history ?? browserHistoryService,
    }),
    [history, storageRegistry]
  );
  const pendingRecentDirectoryVisitRef = React.useRef<{ connectionId: string; path: string } | null>(null);
  const searchBufferRef = React.useRef<string>("");
  const searchTimeoutRef = React.useRef<number | null>(null);

  const clearIncrementalSearch = useCallback(() => {
    searchBufferRef.current = "";
    if (searchTimeoutRef.current !== null) {
      clearTimeout(searchTimeoutRef.current);
      searchTimeoutRef.current = null;
    }
  }, []);

  const recordRecentDirectoryVisit = useCallback(
    (targetConnectionId: string, path: string) => {
      if (!path) {
        return;
      }

      recordRecentHistoryEntry({
        connectionId: targetConnectionId,
        path,
        expectedType: FileType.DIRECTORY,
        hasItemType: (history ?? browserHistoryService).hasItemType,
        record: (history ?? browserHistoryService).recordRecentDirectory,
        publish: publishRecentDirectoriesChanged,
        itemName: "directory",
      });
    },
    [history]
  );

  const clearPendingRecentDirectoryVisit = useCallback((targetConnectionId: string, path: string) => {
    const pendingVisit = pendingRecentDirectoryVisitRef.current;
    if (pendingVisit?.connectionId === targetConnectionId && pendingVisit.path === path) {
      pendingRecentDirectoryVisitRef.current = null;
    }
  }, []);

  const recordRecentFileAttempt = useCallback(
    (targetConnectionId: string, path: string) => {
      recordRecentHistoryEntry({
        connectionId: targetConnectionId,
        path,
        expectedType: FileType.FILE,
        hasItemType: (history ?? browserHistoryService).hasItemType,
        record: (history ?? browserHistoryService).recordRecentFile,
        publish: publishRecentFilesChanged,
        itemName: "file",
      });
    },
    [history]
  );

  const removeRecentFileRecord = useCallback(
    async (recordId: string) => {
      try {
        await (history ?? browserHistoryService).removeRecentFile(recordId);
        publishRecentFilesChanged();
      } catch (error: unknown) {
        logger.warn("Failed to remove stale recent file", { recordId, error }, "browser");
      }
    },
    [history]
  );

  const transitionListingLocationRef = React.useRef<
    (nextConnectionId: string, nextPath: string, nextArchiveLocation: ArchiveLocation | null) => boolean
  >(() => false);

  const prepareDirectoryTransition = useCallback((nextConnectionId: string, nextPath: string): void => {
    const ownsPhysicalLocation =
      archiveLocationRef.current === null && connectionIdRef.current === nextConnectionId && currentPathRef.current === nextPath;

    if (!nextConnectionId && ownsPhysicalLocation) {
      setItems([]);
      setLoading(false);
      setError(null);
      return;
    }

    if (!ownsPhysicalLocation) {
      return;
    }

    const cacheKey = `${nextConnectionId}:${nextPath}`;
    const cached = directoryCache.current.get(cacheKey);
    const now = Date.now();

    setError(null);

    if (cached && now - cached.timestamp < DIRECTORY_CACHE_TTL_MS) {
      setItems(toPhysicalItems(nextConnectionId, nextPath, cached.items));
      setLoading(false);
      return;
    }

    setLoading(true);
  }, []);

  const navigateToPath = useCallback(
    (nextPath: string) => {
      const nextConnectionId = connectionIdRef.current;
      if (!nextConnectionId) {
        return;
      }

      const normalizedPath = normalizeLocalDrivePath(nextConnectionId, nextPath);
      if (currentPathRef.current === normalizedPath && archiveLocationRef.current === null) {
        return;
      }

      clearIncrementalSearch();

      pendingRecentDirectoryVisitRef.current = normalizedPath ? { connectionId: nextConnectionId, path: normalizedPath } : null;

      pendingLocationRef.current = {
        connectionId: nextConnectionId,
        path: normalizedPath,
      };
      latestLocalActivationRequestIdRef.current += 1;

      transitionListingLocationRef.current(nextConnectionId, normalizedPath, null);
      prepareDirectoryTransition(nextConnectionId, normalizedPath);
      setCurrentPath(normalizedPath);
      setViewInfo(null);
      onNavigatePath?.(normalizedPath);
    },
    [clearIncrementalSearch, onNavigatePath, prepareDirectoryTransition]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Search Provider
  // ──────────────────────────────────────────────────────────────────────────

  const directorySearchProvider = useDirectorySearchProvider(
    connectionId,
    (path) => {
      navigateToPath(path);
    },
    {
      includeDotDirectories: includeDotDirectoriesInQuickNav,
      history,
      getConnectionName: (targetConnectionId) => getConnectionById(connections, targetConnectionId)?.name ?? targetConnectionId,
      onNavigateDirectory: (targetConnectionId, path) => {
        if (targetConnectionId === connectionIdRef.current) {
          navigateToPath(path);
          return;
        }
        pendingRecentDirectoryVisitRef.current = { connectionId: targetConnectionId, path };
        onNavigateDirectory?.(targetConnectionId, path);
      },
    }
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Refs — DOM
  // ──────────────────────────────────────────────────────────────────────────

  const parentRef = React.useRef<HTMLDivElement>(null);
  const searchInputRef = React.useRef<HTMLInputElement>(null);

  const [listContainerEl, setListContainerEl] = useState<HTMLDivElement | null>(null);
  const listContainerRef = useCallback((node: HTMLDivElement | null) => {
    setListContainerEl((current) => (current === node ? current : node));
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Refs — Performance / Async
  // ──────────────────────────────────────────────────────────────────────────

  const filesRef = React.useRef<FileEntry[]>([]);
  const itemsRef = React.useRef<BrowserItem[]>([]);
  const connectionIdRef = React.useRef<string>("");
  const currentPathRef = React.useRef<string>("");
  const archiveLocationRef = React.useRef<ArchiveLocation | null>(null);
  const archiveNextCursorRef = React.useRef<string | null>(null);
  const archiveLoadingMoreRef = React.useRef(false);
  const latestVirtualActivationIdRef = React.useRef(0);
  const pendingLocationRef = React.useRef<{ connectionId: string; path: string } | null>(null);
  const latestLocalActivationRequestIdRef = React.useRef(0);
  const loadPhysicalDirectoryRef = React.useRef<
    ((path: string, forceRefresh?: boolean, preserveVisibleContent?: boolean) => Promise<void>) | undefined
  >(undefined);
  const loadArchiveFilesRef = React.useRef<((location: ArchiveLocation, append?: boolean) => Promise<void>) | undefined>(undefined);
  const loadMoreVirtualItemsRef = React.useRef<() => void>(() => {});
  const latestLoadRequestIdRef = React.useRef(0);
  const directoryLoadAbortRef = React.useRef<AbortController | null>(null);
  const hasPhysicalListingRef = React.useRef(false);
  const realtimeRefreshPendingRef = React.useRef(false);
  const realtimeRefreshTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastRealtimeRefreshRef = React.useRef<number | null>(null);
  const scheduleRealtimeRefreshRef = React.useRef<() => void>(() => {});
  const latestLinkTargetLoadRequestIdRef = React.useRef(0);
  const linkTargetLoadAbortRef = React.useRef<AbortController | null>(null);
  const pendingLocationReloadRef = React.useRef<PendingLocationReload | null>(null);

  useEffect(() => {
    archiveLocationRef.current = archiveLocation;
  }, [archiveLocation]);

  const getItemForEntry = useCallback((entry: FileEntry): BrowserItem | null => {
    const listedItem = itemsRef.current.find((item) => item.entry === entry || item.entry.path === entry.path);
    if (listedItem) {
      return listedItem;
    }

    const archive = archiveLocationRef.current;
    if (archive) {
      return virtualItem(
        virtualLocation(
          archive.providerId,
          connectionIdRef.current,
          physicalLocation(connectionIdRef.current, archive.archivePath),
          archive.virtualPath
        ),
        entry
      );
    }

    return physicalItem(physicalLocation(connectionIdRef.current, currentPathRef.current), entry);
  }, []);

  const pendingFocusedIndexRef = React.useRef<number | null>(null);
  const focusCommitRafRef = React.useRef<number | null>(null);

  const currentViewIndexRef = React.useRef<number | null>(null);
  const currentViewImagesRef = React.useRef<string[] | undefined>(undefined);
  const lastDisplayedImagePathRef = React.useRef<string | null>(null);

  const [visibleRowCount, setVisibleRowCount] = useState(10);
  const visibleRowCountRef = React.useRef<number>(10);

  const navigationHistory = React.useRef<Map<string, { focusedIndex: number; scrollOffset: number; selectedFileName: string | null }>>(
    new Map()
  );
  const archiveNavigationHistory = React.useRef<
    Map<string, { focusedIndex: number; scrollOffset: number; selectedFileName: string | null }>
  >(new Map());
  const pendingArchiveRestoreRef = React.useRef<{
    key: string;
    state: { focusedIndex: number; scrollOffset: number; selectedFileName: string | null };
  } | null>(null);

  const directoryCache = React.useRef<Map<string, { items: FileEntry[]; timestamp: number }>>(new Map());
  const pendingDirectoryEntryIntentRef = React.useRef<DirectoryEntryIntent | null>({ kind: "fresh" });

  const pendingFocusNameRef = React.useRef<string | null>(null);
  const pendingSelectedFilesRestoreRef = React.useRef<Set<string> | null>(null);
  const lastAppliedRouteSyncTokenRef = React.useRef<number>(0);
  const routeLocationResolutionIdRef = React.useRef<number>(0);
  const lastForceReloadRef = React.useRef<number>(0);
  const onResolveRouteLocationRef = React.useRef(onResolveRouteLocation);

  // ──────────────────────────────────────────────────────────────────────────
  // Ref Sync Effects
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    connectionIdRef.current = connectionId;
  }, [connectionId]);

  useEffect(() => {
    currentPathRef.current = currentPath;
  }, [currentPath]);

  useEffect(() => {
    onResolveRouteLocationRef.current = onResolveRouteLocation;
  }, [onResolveRouteLocation]);

  const physicalRequestOwnsLocation = useCallback((requestId: number, targetConnectionId: string, targetPath: string): boolean => {
    return (
      latestLoadRequestIdRef.current === requestId &&
      connectionIdRef.current === targetConnectionId &&
      currentPathRef.current === targetPath &&
      archiveLocationRef.current === null
    );
  }, []);

  const archiveRequestOwnsLocation = useCallback(
    (requestId: number, abortController: AbortController, targetConnectionId: string, location: ArchiveLocation): boolean => {
      return (
        latestLoadRequestIdRef.current === requestId &&
        directoryLoadAbortRef.current === abortController &&
        connectionIdRef.current === targetConnectionId &&
        archiveLocationsMatch(archiveLocationRef.current, location)
      );
    },
    []
  );

  const transitionListingLocation = useCallback(
    (nextConnectionId: string, nextPath: string, nextArchiveLocation: ArchiveLocation | null): boolean => {
      const locationChanged =
        connectionIdRef.current !== nextConnectionId ||
        currentPathRef.current !== nextPath ||
        !archiveLocationsMatch(archiveLocationRef.current, nextArchiveLocation);
      if (!locationChanged) {
        return false;
      }

      const archiveChanged =
        connectionIdRef.current !== nextConnectionId || !archiveLocationsMatch(archiveLocationRef.current, nextArchiveLocation);
      realtimeRefreshPendingRef.current = false;
      if (realtimeRefreshTimerRef.current !== null) {
        clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
      lastRealtimeRefreshRef.current = null;
      hasPhysicalListingRef.current = false;
      directoryLoadAbortRef.current?.abort();
      directoryLoadAbortRef.current = null;
      latestLoadRequestIdRef.current += 1;
      linkTargetLoadAbortRef.current?.abort();
      linkTargetLoadAbortRef.current = null;
      latestLinkTargetLoadRequestIdRef.current += 1;
      connectionIdRef.current = nextConnectionId;
      currentPathRef.current = nextPath;
      archiveLocationRef.current = nextArchiveLocation;

      const pendingReload = pendingLocationReloadRef.current;
      if (
        pendingReload &&
        (pendingReload.connectionId !== nextConnectionId || pendingReload.path !== nextPath || nextArchiveLocation !== null)
      ) {
        pendingLocationReloadRef.current = null;
      }

      if (archiveChanged) {
        archiveNextCursorRef.current = null;
        archiveLoadingMoreRef.current = false;
        setArchiveHasMore(false);
        setArchiveLoadingMore(false);
      }

      return true;
    },
    []
  );

  useEffect(() => {
    transitionListingLocationRef.current = transitionListingLocation;
  }, [transitionListingLocation]);

  // ──────────────────────────────────────────────────────────────────────────
  // Focus Management
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * updateFocus — sets the focused file index, with optional RAF batching
   * to avoid layout thrashing during rapid keyboard navigation (key repeat).
   */
  const updateFocus = React.useCallback((next: number, options?: { immediate?: boolean }) => {
    const immediate = options?.immediate ?? false;

    const commit = () => {
      setFocusedIndex((prev: number) => (prev === next ? prev : next));
    };

    if (immediate) {
      if (focusCommitRafRef.current !== null) {
        cancelAnimationFrame(focusCommitRafRef.current);
        focusCommitRafRef.current = null;
      }
      pendingFocusedIndexRef.current = null;
      commit();
      return;
    }

    pendingFocusedIndexRef.current = next;
    if (focusCommitRafRef.current !== null) return;

    focusCommitRafRef.current = requestAnimationFrame(() => {
      focusCommitRafRef.current = null;
      const target = pendingFocusedIndexRef.current;
      pendingFocusedIndexRef.current = null;
      if (target === null) return;
      setFocusedIndex((prev: number) => (prev === target ? prev : target));
    });
  }, []);

  useEffect(() => {
    return () => {
      if (focusCommitRafRef.current !== null) {
        cancelAnimationFrame(focusCommitRafRef.current);
      }
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Data Loading
  // ──────────────────────────────────────────────────────────────────────────

  const loadLocalLinkTargets = useCallback(
    (targetConnectionId: string, targetPath: string, sourceItems: FileEntry[], directoryRequestId: number): void => {
      if (!isLocalDrive(targetConnectionId) || !sourceItems.some((item) => item.link_kind && !item.link_target)) {
        return;
      }

      linkTargetLoadAbortRef.current?.abort();
      const abortController = new AbortController();
      linkTargetLoadAbortRef.current = abortController;
      const linkTargetRequestId = latestLinkTargetLoadRequestIdRef.current + 1;
      latestLinkTargetLoadRequestIdRef.current = linkTargetRequestId;
      const cacheKey = `${targetConnectionId}:${targetPath}`;

      void (linkTargets ?? browserLinkTargetService)
        .listLocalLinkTargets(targetConnectionId, targetPath, { signal: abortController.signal })
        .then((listing) => {
          const isCurrentRequest =
            !abortController.signal.aborted &&
            latestLinkTargetLoadRequestIdRef.current === linkTargetRequestId &&
            latestLoadRequestIdRef.current === directoryRequestId &&
            physicalRequestOwnsLocation(directoryRequestId, targetConnectionId, targetPath);
          if (!isCurrentRequest) {
            return;
          }

          const resolutionBySourcePath = new Map(listing.items.map((item) => [item.source_path, item]));
          setItems((currentItems) => {
            const stillCurrent =
              latestLinkTargetLoadRequestIdRef.current === linkTargetRequestId &&
              latestLoadRequestIdRef.current === directoryRequestId &&
              physicalRequestOwnsLocation(directoryRequestId, targetConnectionId, targetPath);
            if (!stillCurrent) {
              return currentItems;
            }

            const enrichedItems = currentItems.map((item) => {
              const linkTarget = resolutionBySourcePath.get(item.entry.path);
              return linkTarget ? { ...item, entry: { ...item.entry, link_target: linkTarget } } : item;
            });
            const cached = directoryCache.current.get(cacheKey);
            if (cached) {
              directoryCache.current.set(cacheKey, {
                items: enrichedItems.map((item) => item.entry),
                timestamp: cached.timestamp,
              });
            }
            return enrichedItems;
          });
        })
        .catch((error: unknown) => {
          if (!abortController.signal.aborted && !isLocalAbortError(error)) {
            logger.warn(
              "Failed to load local link target metadata",
              { error, connectionId: targetConnectionId, path: targetPath },
              "browser"
            );
          }
        })
        .finally(() => {
          if (linkTargetLoadAbortRef.current === abortController) {
            linkTargetLoadAbortRef.current = null;
          }
        });
    },
    [linkTargets, physicalRequestOwnsLocation]
  );

  const loadPhysicalDirectory = useCallback(
    async (path: string, forceRefresh = false, preserveVisibleContent = false) => {
      const targetConnectionId = connectionIdRef.current;
      if (!targetConnectionId || archiveLocationRef.current !== null) return;

      directoryLoadAbortRef.current?.abort();
      linkTargetLoadAbortRef.current?.abort();
      linkTargetLoadAbortRef.current = null;
      latestLinkTargetLoadRequestIdRef.current += 1;

      const abortController = new AbortController();
      directoryLoadAbortRef.current = abortController;

      const targetPath = path;
      const cacheKey = `${targetConnectionId}:${targetPath}`;
      const requestId = latestLoadRequestIdRef.current + 1;
      latestLoadRequestIdRef.current = requestId;
      const now = Date.now();

      if (!forceRefresh) {
        const cached = directoryCache.current.get(cacheKey);
        if (cached && now - cached.timestamp < DIRECTORY_CACHE_TTL_MS) {
          if (!physicalRequestOwnsLocation(requestId, targetConnectionId, targetPath)) {
            return;
          }
          setItems(toPhysicalItems(targetConnectionId, targetPath, cached.items));
          hasPhysicalListingRef.current = true;
          directoryLoadAbortRef.current = null;
          setLoading(false);
          setError(null);
          loadLocalLinkTargets(targetConnectionId, targetPath, cached.items, requestId);
          const pendingVisit = pendingRecentDirectoryVisitRef.current;
          if (pendingVisit?.connectionId === targetConnectionId && pendingVisit.path === targetPath) {
            pendingRecentDirectoryVisitRef.current = null;
            recordRecentDirectoryVisit(targetConnectionId, targetPath);
          }
          return;
        }
      } else {
        directoryCache.current.delete(cacheKey);
      }

      const shouldKeepVisibleContent = preserveVisibleContent && hasPhysicalListingRef.current;

      if (physicalRequestOwnsLocation(requestId, targetConnectionId, targetPath)) {
        setLoading(!shouldKeepVisibleContent);
        setError(null);
        setCompanionPairingError(null);
      }

      try {
        const providerLocation = physicalLocation(targetConnectionId, targetPath);
        const listing = await providerRegistry.get(providerLocation).list(providerLocation, { signal: abortController.signal });
        if (!physicalRequestOwnsLocation(requestId, targetConnectionId, targetPath)) {
          logger.debug(
            "Ignoring stale directory response",
            {
              requestConnectionId: targetConnectionId,
              requestPath: targetPath,
              currentConnectionId: connectionIdRef.current,
              currentPath: currentPathRef.current,
            },
            "browser"
          );
          return;
        }

        const items = listing.items.map((item) => item.entry);
        if (!realtimeRefreshPendingRef.current) {
          directoryCache.current.set(cacheKey, { items, timestamp: now });
        }
        hasPhysicalListingRef.current = true;
        setItems(listing.items);
        loadLocalLinkTargets(targetConnectionId, targetPath, items, requestId);
        const pendingVisit = pendingRecentDirectoryVisitRef.current;
        if (pendingVisit?.connectionId === targetConnectionId && pendingVisit.path === targetPath) {
          pendingRecentDirectoryVisitRef.current = null;
          recordRecentDirectoryVisit(targetConnectionId, targetPath);
        }
      } catch (err) {
        if (abortController.signal.aborted || isLocalAbortError(err)) {
          if (physicalRequestOwnsLocation(requestId, targetConnectionId, targetPath)) {
            clearPendingRecentDirectoryVisit(targetConnectionId, targetPath);
          }
          return;
        }

        if (!physicalRequestOwnsLocation(requestId, targetConnectionId, targetPath)) {
          logger.debug(
            "Ignoring stale directory error",
            {
              requestConnectionId: targetConnectionId,
              requestPath: targetPath,
              currentConnectionId: connectionIdRef.current,
              currentPath: currentPathRef.current,
            },
            "browser"
          );
          return;
        }

        clearPendingRecentDirectoryVisit(targetConnectionId, targetPath);

        logger.error("Error loading directory", { error: err, connectionId: targetConnectionId, path: targetPath }, "browser");

        const pairingErrorKind = getLocalDrivePairingErrorKind(targetConnectionId, err);
        let errorMessage = pairingErrorKind
          ? translate(
              pairingErrorKind === "signature"
                ? "fileBrowser.chrome.alerts.localDrivePairingRejected"
                : "fileBrowser.chrome.alerts.localDrivePairingRequired",
              {
                connection: getConnectionById(connections, targetConnectionId)?.name ?? targetConnectionId,
              }
            )
          : DIRECTORY_LOAD_GENERIC_ERROR;

        if (pairingErrorKind) {
          setCompanionPairingError({ kind: pairingErrorKind, message: errorMessage });
        } else if (isClientTimeoutError(err)) {
          errorMessage = DIRECTORY_LOAD_TIMEOUT_ERROR;
        } else if (err && typeof err === "object" && "message" in err && typeof err.message === "string") {
          const message = err.message;
          if (message.includes("Network Error") || message.includes("ECONNREFUSED") || ("code" in err && err.code === "ECONNREFUSED")) {
            errorMessage = DIRECTORY_LOAD_NETWORK_ERROR;
          } else if (isApiError(err)) {
            if (err.response?.status === 404) {
              errorMessage = getApiErrorMessage(err, "Directory not found. It may have been removed or renamed.");
            } else if (err.response?.status === 504) {
              errorMessage = getApiErrorMessage(err, DIRECTORY_LOAD_TIMEOUT_ERROR);
            } else {
              errorMessage = getApiErrorMessage(err, errorMessage);
            }
          }
        } else if (isApiError(err)) {
          if (err.response?.status === 404) {
            errorMessage = getApiErrorMessage(err, "Directory not found. It may have been removed or renamed.");
          } else if (err.response?.status === 504) {
            errorMessage = getApiErrorMessage(err, DIRECTORY_LOAD_TIMEOUT_ERROR);
          } else {
            errorMessage = getApiErrorMessage(err, errorMessage);
          }
        }

        setError(errorMessage);
      } finally {
        if (directoryLoadAbortRef.current === abortController) {
          directoryLoadAbortRef.current = null;
        }

        if (physicalRequestOwnsLocation(requestId, targetConnectionId, targetPath)) {
          setLoading(false);
          scheduleRealtimeRefreshRef.current();
        }
      }
    },
    [
      clearPendingRecentDirectoryVisit,
      connections,
      loadLocalLinkTargets,
      physicalRequestOwnsLocation,
      providerRegistry,
      recordRecentDirectoryVisit,
    ]
  );

  useEffect(() => {
    loadPhysicalDirectoryRef.current = loadPhysicalDirectory;
  }, [loadPhysicalDirectory]);

  const loadArchiveFiles = useCallback(
    async (location: ArchiveLocation, append = false) => {
      const targetConnectionId = connectionIdRef.current;
      if (!targetConnectionId) {
        return;
      }

      const cursor = append ? archiveNextCursorRef.current : null;
      if (append && (!cursor || archiveLoadingMoreRef.current)) {
        return;
      }

      directoryLoadAbortRef.current?.abort();
      const abortController = new AbortController();
      directoryLoadAbortRef.current = abortController;
      const requestId = latestLoadRequestIdRef.current + 1;
      latestLoadRequestIdRef.current = requestId;
      if (append) {
        archiveLoadingMoreRef.current = true;
        setArchiveLoadingMore(true);
      } else {
        archiveLoadingMoreRef.current = false;
        setArchiveLoadingMore(false);
        archiveNextCursorRef.current = null;
        setArchiveHasMore(false);
        setLoading(true);
      }
      setError(null);

      try {
        const archiveVirtualLocation = virtualLocation(
          location.providerId,
          targetConnectionId,
          physicalLocation(targetConnectionId, location.archivePath),
          location.virtualPath
        );
        const listing = await providerRegistry.get(archiveVirtualLocation).list(archiveVirtualLocation, {
          cursor: cursor ?? undefined,
          pageSize: ARCHIVE_LIST_PAGE_SIZE,
          signal: abortController.signal,
        });
        if (!archiveRequestOwnsLocation(requestId, abortController, targetConnectionId, location)) {
          return;
        }

        archiveNextCursorRef.current = listing.nextCursor;
        setArchiveHasMore(archiveNextCursorRef.current !== null);
        setItems((currentItems) => (append ? [...currentItems, ...listing.items] : listing.items));
        if (!append) {
          setBrowserViewerPickerState((previous) => {
            if (!previous?.virtualSource) {
              return previous;
            }

            const pickerItem = listing.items.find((item) => item.handle.path === previous.filePath);
            return pickerItem?.entry.is_readable ? previous : null;
          });
        }
      } catch (error: unknown) {
        if (abortController.signal.aborted || isLocalAbortError(error)) {
          return;
        }

        if (archiveRequestOwnsLocation(requestId, abortController, targetConnectionId, location)) {
          logger.error(
            "Error loading archive directory",
            { error, connectionId: targetConnectionId, archivePath: location.archivePath, virtualPath: location.virtualPath },
            "browser"
          );
          setError(ARCHIVE_LOAD_ERROR);
        }
      } finally {
        const ownsRequest = archiveRequestOwnsLocation(requestId, abortController, targetConnectionId, location);
        if (directoryLoadAbortRef.current === abortController) {
          directoryLoadAbortRef.current = null;
        }
        if (append && ownsRequest) {
          archiveLoadingMoreRef.current = false;
          setArchiveLoadingMore(false);
        } else if (!append && ownsRequest) {
          setLoading(false);
        }
        if (ownsRequest) {
          scheduleRealtimeRefreshRef.current();
        }
      }
    },
    [archiveRequestOwnsLocation, providerRegistry]
  );

  useEffect(() => {
    loadArchiveFilesRef.current = loadArchiveFiles;
  }, [loadArchiveFiles]);

  const reloadCurrentLocationInternal = useCallback(
    async (options: ReloadCurrentLocationOptions = {}, recordForDirectoryDeduplication = true): Promise<void> => {
      if (options.forceRefresh && recordForDirectoryDeduplication) {
        lastForceReloadRef.current = Date.now();
      }

      const currentArchive = archiveLocationRef.current;
      if (currentArchive) {
        await loadArchiveFilesRef.current?.(currentArchive);
        return;
      }

      await loadPhysicalDirectoryRef.current?.(
        currentPathRef.current,
        options.forceRefresh ?? false,
        options.preserveVisibleContent ?? false
      );
    },
    []
  );

  const reloadCurrentLocation = useCallback(
    (options: ReloadCurrentLocationOptions = {}): Promise<void> => reloadCurrentLocationInternal(options),
    [reloadCurrentLocationInternal]
  );

  const scheduleRealtimeRefresh = useCallback(() => {
    if (!realtimeRefreshPendingRef.current || directoryLoadAbortRef.current !== null || realtimeRefreshTimerRef.current !== null) {
      return;
    }

    const elapsed = lastRealtimeRefreshRef.current === null ? REALTIME_REFRESH_INTERVAL_MS : Date.now() - lastRealtimeRefreshRef.current;
    const delay = Math.max(0, REALTIME_REFRESH_INTERVAL_MS - elapsed);
    if (delay > 0) {
      realtimeRefreshTimerRef.current = setTimeout(() => {
        realtimeRefreshTimerRef.current = null;
        scheduleRealtimeRefreshRef.current();
      }, delay);
      return;
    }

    realtimeRefreshPendingRef.current = false;
    lastRealtimeRefreshRef.current = Date.now();
    void reloadCurrentLocationInternal({ forceRefresh: true, preserveVisibleContent: true }, false).catch((error: unknown) => {
      logger.error("Automatic directory refresh failed", { error }, "browser");
    });
  }, [reloadCurrentLocationInternal]);

  useEffect(() => {
    scheduleRealtimeRefreshRef.current = scheduleRealtimeRefresh;
  }, [scheduleRealtimeRefresh]);

  const seedDirectorySnapshot = useCallback((targetConnectionId: string, targetPath: string, items: FileEntry[]) => {
    if (!targetConnectionId) {
      return;
    }

    const snapshot = [...items];
    directoryCache.current.set(`${targetConnectionId}:${targetPath}`, {
      items: snapshot,
      timestamp: Date.now(),
    });

    if (connectionIdRef.current === targetConnectionId && currentPathRef.current === targetPath) {
      if (archiveLocationRef.current === null) {
        hasPhysicalListingRef.current = true;
        setItems(toPhysicalItems(connectionIdRef.current, currentPathRef.current, snapshot));
        setLoading(false);
        setError(null);
      }
    }
  }, []);

  // Load files when connection or path changes
  useEffect(() => {
    if (connectionId && archiveLocation === null) {
      const pendingReload = pendingLocationReloadRef.current;
      const options =
        pendingReload?.connectionId === connectionId && pendingReload.path === currentPath ? pendingReload.options : undefined;
      pendingLocationReloadRef.current = null;
      void reloadCurrentLocation(options);
    }
  }, [archiveLocation, connectionId, currentPath, reloadCurrentLocation]);

  useEffect(() => {
    if (connectionId && archiveLocation !== null) {
      pendingLocationReloadRef.current = null;
      void reloadCurrentLocation();
    }
  }, [archiveLocation, connectionId, reloadCurrentLocation]);

  useEffect(() => {
    return () => {
      realtimeRefreshPendingRef.current = false;
      if (realtimeRefreshTimerRef.current !== null) {
        clearTimeout(realtimeRefreshTimerRef.current);
        realtimeRefreshTimerRef.current = null;
      }
      directoryLoadAbortRef.current?.abort();
      directoryLoadAbortRef.current = null;
      linkTargetLoadAbortRef.current?.abort();
      linkTargetLoadAbortRef.current = null;
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Sort (computed)
  // ──────────────────────────────────────────────────────────────────────────

  const sortedItems = useMemo(() => {
    const directories: BrowserItem[] = [];
    const regularFiles: BrowserItem[] = [];

    for (const item of items) {
      if (item.entry.type === "directory") {
        directories.push(item);
      } else {
        regularFiles.push(item);
      }
    }

    const sortFunction = (a: BrowserItem, b: BrowserItem) => {
      const left = a.entry;
      const right = b.entry;
      let comparison = 0;
      switch (sortBy) {
        case "name":
          comparison = compareLocalizedStrings(left.name, right.name);
          break;
        case "size":
          comparison = (left.size || 0) - (right.size || 0);
          break;
        case "modified": {
          const dateA = left.modified_at ? new Date(left.modified_at).getTime() : 0;
          const dateB = right.modified_at ? new Date(right.modified_at).getTime() : 0;
          comparison = dateA - dateB;
          break;
        }
        case "type": {
          const extA = left.name.includes(".") ? left.name.split(".").pop()?.toLowerCase() || "" : "";
          const extB = right.name.includes(".") ? right.name.split(".").pop()?.toLowerCase() || "" : "";
          comparison = compareLocalizedStrings(extA, extB);
          if (comparison === 0) {
            comparison = compareLocalizedStrings(left.name, right.name);
          }
          break;
        }
        default:
          comparison = 0;
      }
      return sortDirection === "asc" ? comparison : -comparison;
    };

    directories.sort(sortFunction);
    regularFiles.sort(sortFunction);

    return [...directories, ...regularFiles];
  }, [items, sortBy, sortDirection]);

  const sortedFiles = useMemo(() => sortedItems.map((item) => item.entry), [sortedItems]);

  /** Image files in display order — used for gallery mode. */
  const imageFiles = useMemo(() => {
    return sortedFiles
      .filter((f: FileEntry) => f.type === "file" && isImageFile(f.name))
      .map((f: FileEntry) => (currentPath ? `${currentPath}/${f.name}` : f.name));
  }, [sortedFiles, currentPath]);

  useEffect(() => {
    setViewInfo((previous) => {
      if (!previous?.virtualSource || previous.viewerId !== "image") {
        return previous;
      }

      const nextImages = sortedItems
        .filter(isVirtualItem)
        .filter((item) => item.entry.type === "file" && isImageFile(item.entry.name))
        .map((item) => item.handle.path);
      const imagesAreUnchanged =
        previous.images?.length === nextImages.length && previous.images.every((imagePath, index) => imagePath === nextImages[index]);
      if (imagesAreUnchanged) {
        return previous;
      }

      const currentIndex = Math.max(nextImages.indexOf(previous.path), 0);
      currentViewImagesRef.current = nextImages;
      currentViewIndexRef.current = currentIndex;
      return { ...previous, images: nextImages, currentIndex };
    });
  }, [sortedItems]);

  const getVirtualizerItemKey = useCallback(
    (index: number) => {
      const item = sortedItems[index];
      return item?.key ?? `${connectionId}:${currentPath}:${index}`;
    },
    [connectionId, currentPath, sortedItems]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Virtualizer
  // ──────────────────────────────────────────────────────────────────────────

  const rowVirtualizer = useVirtualizer({
    count: sortedFiles.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => rowHeight,
    overscan: 10,
    getItemKey: getVirtualizerItemKey,
    onChange: (virtualizer) => {
      if (archiveLocationRef.current === null) {
        return;
      }

      const virtualItems = virtualizer.getVirtualItems();
      const lastRenderedIndex = virtualItems.at(-1)?.index ?? -1;
      const viewportIsUnderfilled = virtualizer.scrollRect ? virtualizer.getTotalSize() <= virtualizer.scrollRect.height : null;
      if (
        shouldLoadNextVirtualPage({
          hasNextPage: archiveHasMore,
          isLoadingNextPage: archiveLoadingMoreRef.current,
          lastRenderedIndex,
          loadedItemCount: sortedItems.length,
          scrollDirection: virtualizer.scrollDirection,
          viewportIsUnderfilled,
        })
      ) {
        loadMoreVirtualItemsRef.current();
      }
    },
    enabled: !loading,
    useFlushSync: false,
  });

  const lastMeasuredRowHeightRef = React.useRef<number | null>(null);

  useLayoutEffect(() => {
    if (lastMeasuredRowHeightRef.current === rowHeight) {
      return;
    }

    lastMeasuredRowHeightRef.current = rowHeight;
    rowVirtualizer.measure();
  }, [rowHeight, rowVirtualizer]);

  // ──────────────────────────────────────────────────────────────────────────
  // Focus-Restore / Scroll Effects
  // ──────────────────────────────────────────────────────────────────────────

  const resetListScrollToTop = React.useCallback(() => {
    if (parentRef.current) {
      parentRef.current.scrollTop = 0;
    }
  }, []);

  const prevPathForFocusRef = React.useRef<string>(currentPath);
  const prevFocusedIndexRef = React.useRef<number>(0);
  const skipNextLayoutScrollRef = React.useRef<boolean>(false);
  const lastRestoredPathRef = React.useRef<string | null>(null);

  // Keep filesRef updated and restore or reset focused index when files change.
  // This must run before paint so a newly entered directory cannot briefly render
  // with the previous directory's focused index or virtualizer window.
  useLayoutEffect(() => {
    filesRef.current = sortedFiles;
    itemsRef.current = sortedItems;

    if (loading) {
      return;
    }

    if (currentPath !== prevPathForFocusRef.current) {
      prevPathForFocusRef.current = currentPath;
      pendingFocusNameRef.current = null;

      if (pendingDirectoryEntryIntentRef.current === null) {
        pendingDirectoryEntryIntentRef.current = { kind: "fresh" };
      }
    }

    const applyFreshDirectoryEntry = () => {
      pendingDirectoryEntryIntentRef.current = null;
      updateFocus(0, { immediate: true });
      resetListScrollToTop();
      if (sortedFiles.length > 0) {
        rowVirtualizer.scrollToIndex(0, { align: "start" });
      }
    };

    const pendingArchiveRestore = pendingArchiveRestoreRef.current;
    const currentArchive = archiveLocationRef.current;
    if (pendingArchiveRestore && currentArchive && pendingArchiveRestore.key === getArchiveNavigationKey(currentArchive)) {
      const restoreIndex = pendingArchiveRestore.state.selectedFileName
        ? sortedFiles.findIndex((file: FileEntry) => file.name === pendingArchiveRestore.state.selectedFileName)
        : Math.min(pendingArchiveRestore.state.focusedIndex, Math.max(sortedFiles.length - 1, 0));
      pendingArchiveRestoreRef.current = null;
      archiveNavigationHistory.current.delete(pendingArchiveRestore.key);

      if (restoreIndex >= 0) {
        lastRestoredPathRef.current = currentPath;
        updateFocus(restoreIndex, { immediate: true });
        const restoreArchiveKey = pendingArchiveRestore.key;
        requestAnimationFrame(() => {
          if (
            parentRef.current &&
            archiveLocationRef.current &&
            getArchiveNavigationKey(archiveLocationRef.current) === restoreArchiveKey
          ) {
            parentRef.current.scrollTop = pendingArchiveRestore.state.scrollOffset;
          }
        });
        return;
      }
    }

    const entryIntent = pendingDirectoryEntryIntentRef.current;
    if (entryIntent?.kind === "restore-history") {
      const savedState = navigationHistory.current.get(currentPath);
      if (savedState) {
        const restoredIndex = savedState.selectedFileName
          ? sortedFiles.findIndex((f: FileEntry) => f.name === savedState.selectedFileName)
          : Math.min(savedState.focusedIndex, Math.max(sortedFiles.length - 1, 0));

        if (restoredIndex >= 0) {
          pendingDirectoryEntryIntentRef.current = null;
          lastRestoredPathRef.current = currentPath;
          updateFocus(restoredIndex, { immediate: true });
          const restorePath = currentPath;
          requestAnimationFrame(() => {
            if (parentRef.current && currentPathRef.current === restorePath) {
              parentRef.current.scrollTop = savedState.scrollOffset;
            }
          });
          navigationHistory.current.delete(currentPath);
          return;
        }

        navigationHistory.current.delete(currentPath);
      }

      applyFreshDirectoryEntry();
      return;
    }

    if (entryIntent?.kind === "parent-return") {
      const restoreIndex = sortedFiles.findIndex((f: FileEntry) => f.name === entryIntent.childName);
      if (restoreIndex >= 0) {
        pendingDirectoryEntryIntentRef.current = null;
        updateFocus(restoreIndex, { immediate: true });
        rowVirtualizer.scrollToIndex(restoreIndex, { align: "auto" });
        return;
      }

      applyFreshDirectoryEntry();
      return;
    }

    if (entryIntent?.kind === "fresh") {
      applyFreshDirectoryEntry();
      return;
    }

    const pendingName = pendingFocusNameRef.current;
    if (pendingName !== null) {
      const idx = sortedFiles.findIndex((f: FileEntry) => f.name === pendingName);
      if (idx >= 0) {
        pendingFocusNameRef.current = null;
        updateFocus(idx, { immediate: true });
        rowVirtualizer.scrollToIndex(idx, { align: "auto" });
        return;
      }

      pendingFocusNameRef.current = null;
    }
  }, [sortedFiles, sortedItems, currentPath, loading, updateFocus, rowVirtualizer, resetListScrollToTop]);

  // Scroll focused item into view
  useLayoutEffect(() => {
    if (focusedIndex >= 0) {
      if (focusedIndex >= sortedFiles.length) {
        prevFocusedIndexRef.current = Math.max(sortedFiles.length - 1, 0);
        return;
      }

      const prev = prevFocusedIndexRef.current;
      const diff = focusedIndex - prev;

      if (skipNextLayoutScrollRef.current || lastRestoredPathRef.current === currentPathRef.current) {
        skipNextLayoutScrollRef.current = false;
        lastRestoredPathRef.current = null;
        prevFocusedIndexRef.current = focusedIndex;
        return;
      }

      let align: "auto" | "center" | "end" | "start" = "auto";
      if (diff >= visibleRowCount) {
        align = "end";
      } else if (diff <= -visibleRowCount) {
        align = "start";
      } else if (Math.abs(diff) === 1) {
        align = "auto";
      } else {
        align = diff > 0 ? "end" : "start";
      }

      rowVirtualizer.scrollToIndex(focusedIndex, { align });
      prevFocusedIndexRef.current = focusedIndex;
    }
  }, [focusedIndex, sortedFiles.length, visibleRowCount, rowVirtualizer]);

  // Resize observer for visible-row-count (used by PageUp/PageDown)
  useLayoutEffect(() => {
    const element = listContainerEl;
    if (!element) return;

    const updateVisibleRows = () => {
      const rect = element.getBoundingClientRect();
      const visibleRows = Math.floor(rect.height / rowHeight);
      const newCount = visibleRows >= 5 ? visibleRows : 10;
      if (newCount !== visibleRowCountRef.current) {
        setVisibleRowCount(newCount);
        visibleRowCountRef.current = newCount;
      }
    };

    updateVisibleRows();
    const observer = new ResizeObserver(updateVisibleRows);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [listContainerEl, rowHeight]);

  const currentLocationKey = `${connectionId}:${currentPath}`;

  // Restore the active pane's list focus before a new directory listing is painted.
  useLayoutEffect(() => {
    if (currentLocationKey && isActive && listContainerEl?.isConnected && !viewInfo) {
      listContainerEl.focus();
    }
  }, [currentLocationKey, isActive, listContainerEl, viewInfo]);

  // ──────────────────────────────────────────────────────────────────────────
  // Connection Change
  // ──────────────────────────────────────────────────────────────────────────

  const handleConnectionChange = useCallback(
    (newConnectionId: string) => {
      if (newConnectionId === connectionId) return;
      clearIncrementalSearch();
      const currentArchive = archiveLocationRef.current;
      if (currentArchive !== null) {
        latestVirtualActivationIdRef.current += 1;
        setArchiveLocation(null);
        archiveNavigationHistory.current.clear();
        pendingArchiveRestoreRef.current = null;
        setBrowserViewerPickerState((previous) => (previous?.virtualSource ? null : previous));
      }
      pendingLocationRef.current = {
        connectionId: newConnectionId,
        path: "",
      };
      latestLocalActivationRequestIdRef.current += 1;
      transitionListingLocation(newConnectionId, "", null);
      prepareDirectoryTransition(newConnectionId, "");
      setConnectionId(newConnectionId);
      setCurrentPath("");
      setViewInfo(null);
      selectionAnchorRef.current = null;
      setSelectedFiles(new Set());
      directoryCache.current.clear();
      navigationHistory.current.clear();
      writeSelectedConnectionIdPreference(newConnectionId);
      onNavigateConnection?.(newConnectionId);
    },
    [clearIncrementalSearch, connectionId, onNavigateConnection, prepareDirectoryTransition, transitionListingLocation]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // File Click / Viewer
  // ──────────────────────────────────────────────────────────────────────────

  const handleViewIndexChange = useCallback(
    (index: number) => {
      currentViewIndexRef.current = index;
      setViewInfo((prev) => {
        if (!prev?.images || prev.images.length === 0) return prev;
        const nextPath = prev.images[index] ?? prev.path;
        if (!prev.virtualSource && lastDisplayedImagePathRef.current !== nextPath) {
          recordRecentFileAttempt(prev.connectionId ?? connectionIdRef.current, nextPath);
          lastDisplayedImagePathRef.current = nextPath;
        }
        if (prev.currentIndex === index && prev.path === nextPath) return prev;
        return { ...prev, currentIndex: index, path: nextPath };
      });
    },
    [recordRecentFileAttempt]
  );

  const handleViewClose = useCallback(() => {
    const images = currentViewImagesRef.current ?? viewInfo?.images;
    const indexFromRef = currentViewIndexRef.current ?? viewInfo?.currentIndex ?? null;

    let finalPath: string | undefined;
    if (images && images.length > 0) {
      const clampedIndex = indexFromRef !== null ? Math.min(Math.max(indexFromRef, 0), images.length - 1) : 0;
      finalPath = images[clampedIndex];
    } else if (viewInfo?.path) {
      finalPath = viewInfo.path;
    }

    setViewInfo(null);
    currentViewIndexRef.current = null;
    currentViewImagesRef.current = undefined;
    lastDisplayedImagePathRef.current = null;

    if (!finalPath) return;

    const targetIndex = sortedFiles.findIndex((file: FileEntry) => {
      if (file.type !== "file") return false;
      const fullPath = viewInfo?.virtualSource ? file.path : currentPath ? `${currentPath}/${file.name}` : file.name;
      return fullPath === finalPath;
    });

    if (targetIndex >= 0) {
      updateFocus(targetIndex, { immediate: true });
    }
  }, [currentPath, viewInfo, sortedFiles, updateFocus]);

  // ──────────────────────────────────────────────────────────────────────────
  // Keyboard Navigation Handlers
  // ──────────────────────────────────────────────────────────────────────────

  const handleNavigateDown = useCallback(
    (e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;
      if (focusedIndex < 0) return;

      const fileCount = filesRef.current.length;
      const next = Math.min(focusedIndex + 1, fileCount - 1);
      if (next === focusedIndex) return;
      if (e?.repeat) {
        updateFocus(next, { immediate: false });
      } else {
        updateFocus(next);
      }
    },
    [focusedIndex, updateFocus, listContainerEl]
  );

  const handleArrowUp = useCallback(
    (e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;
      if (focusedIndex < 0) return;

      const next = Math.max(focusedIndex - 1, 0);
      if (next === focusedIndex) return;
      if (e?.repeat) {
        updateFocus(next, { immediate: false });
      } else {
        updateFocus(next);
      }
    },
    [focusedIndex, updateFocus, listContainerEl]
  );

  const handleHome = useCallback(() => {
    if (!listContainerEl) return;
    const activeElement = document.activeElement;
    if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;
    updateFocus(0);
  }, [updateFocus, listContainerEl]);

  const handleEnd = useCallback(() => {
    if (!listContainerEl) return;
    const activeElement = document.activeElement;
    if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;
    const fileCount = filesRef.current.length;
    updateFocus(fileCount - 1);
  }, [updateFocus, listContainerEl]);

  const handlePageDown = useCallback(
    (e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const fileCount = filesRef.current.length;
      const pageSize = visibleRowCount;
      const newIndex = Math.min(focusedIndex + pageSize, fileCount - 1);

      if (e?.repeat) {
        updateFocus(newIndex, { immediate: false });
      } else {
        rowVirtualizer.scrollToIndex(newIndex, { align: "end" });
        skipNextLayoutScrollRef.current = true;
        updateFocus(newIndex, { immediate: true });
      }
    },
    [focusedIndex, visibleRowCount, updateFocus, rowVirtualizer, listContainerEl]
  );

  const handlePageUp = useCallback(
    (e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const pageSize = visibleRowCount;
      const newIndex = Math.max(focusedIndex - pageSize, 0);

      if (e?.repeat) {
        updateFocus(newIndex, { immediate: false });
      } else {
        rowVirtualizer.scrollToIndex(newIndex, { align: "start" });
        skipNextLayoutScrollRef.current = true;
        updateFocus(newIndex, { immediate: true });
      }
    },
    [focusedIndex, visibleRowCount, updateFocus, rowVirtualizer, listContainerEl]
  );

  const getFocusedFileForAction = useCallback(
    (options?: { requireListFocus?: boolean }) => {
      if (!listContainerEl) return null;

      const requireListFocus = options?.requireListFocus ?? true;
      if (requireListFocus) {
        const activeElement = document.activeElement;
        if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) {
          return null;
        }
      }

      return filesRef.current[focusedIndex] ?? null;
    },
    [focusedIndex, listContainerEl]
  );

  const openFileInViewer = useCallback(
    (
      file: FileEntry,
      filePath: string,
      mimeType: string,
      viewerId?: ViewerId,
      targetConnectionId = connectionIdRef.current,
      virtualSource?: VirtualItemHandle
    ) => {
      const viewerSessionId = createViewerSessionId();
      const galleryImages = virtualSource
        ? sortedItems
            .filter(isVirtualItem)
            .filter((item) => item.entry.type === "file" && isImageFile(item.entry.name))
            .map((item) => item.handle.path)
        : imageFiles;
      const useImageGallery =
        viewerId === "image" &&
        isImageFile(file.name) &&
        targetConnectionId === connectionIdRef.current &&
        galleryImages.includes(filePath);

      logger.info(
        "File selected for viewing",
        {
          path: filePath,
          fileName: file.name,
          size: file.size,
          mimeType,
          viewerId,
          isImage: useImageGallery,
          imageFilesCount: galleryImages.length,
          virtual: virtualSource !== undefined,
        },
        "viewer"
      );

      if (useImageGallery) {
        const imageIndex = galleryImages.indexOf(filePath);
        const effectiveIndex = imageIndex >= 0 ? imageIndex : 0;
        currentViewIndexRef.current = effectiveIndex;
        currentViewImagesRef.current = galleryImages;
        lastDisplayedImagePathRef.current = null;
        (onOpenViewer ?? setViewInfo)({
          connectionId: targetConnectionId,
          path: filePath,
          fileSize: file.size,
          fileModifiedAt: file.modified_at,
          mimeType,
          viewerId,
          virtualSource,
          images: galleryImages,
          currentIndex: effectiveIndex,
          sessionId: viewerSessionId,
        });
        return;
      }

      currentViewIndexRef.current = null;
      currentViewImagesRef.current = undefined;
      if (!virtualSource) {
        recordRecentFileAttempt(targetConnectionId, filePath);
      }
      (onOpenViewer ?? setViewInfo)({
        connectionId: targetConnectionId,
        path: filePath,
        fileSize: file.size,
        fileModifiedAt: file.modified_at,
        mimeType,
        viewerId,
        virtualSource,
        sessionId: viewerSessionId,
      });
    },
    [imageFiles, onOpenViewer, recordRecentFileAttempt, sortedItems]
  );

  const openNativeFile = useCallback(
    async (
      file: FileEntry,
      options?: { forcePicker?: boolean },
      target?:
        | { connectionId: string; path: string; recentRecordId?: string; onResolvedDirectory?: (location: ContentLocation) => void }
        | { item: ContentItemHandle; recentRecordId?: string; onResolvedDirectory?: (location: ContentLocation) => void }
    ) => {
      if (file.type === "directory") return;
      const targetItem =
        target && "item" in target
          ? target.item
          : target && "connectionId" in target
            ? physicalItemHandle(target.connectionId, target.path)
            : connectionIdRef.current
              ? physicalItemHandle(connectionIdRef.current, currentPathRef.current ? `${currentPathRef.current}/${file.name}` : file.name)
              : null;
      if (!targetItem || !getNativeOpenAvailability(targetItem, contentOperationEnvironment).available) return;

      setOpenInAppLoading(true);
      try {
        const themeJson = JSON.stringify({
          id: currentTheme.id,
          mode: currentTheme.mode,
          primary: {
            main: currentTheme.primary.main,
          },
        });
        const { companionUri, resolvedDirectory } = await openContentInNativeApp(
          {
            item: targetItem,
            forcePicker: options?.forcePicker,
            recentRecordId: target?.recentRecordId,
            themeJson,
            assumeLocalTargetResolved: !target || !("item" in target),
          },
          contentOperationEnvironment
        );
        if (resolvedDirectory) {
          target?.onResolvedDirectory?.(resolvedDirectory);
          return;
        }
        if (companionUri) {
          window.location.href = companionUri;
          onCompanionHint?.();
        }
        logger.info("Opened file in native app", { file: file.name, forcePicker: options?.forcePicker ?? false }, "companion");
      } catch (err: unknown) {
        let detail = "Failed to open file.";
        const errorDetail = isApiError(err) ? err.response?.data?.detail : undefined;
        if (typeof errorDetail === "string") {
          detail = errorDetail;
        }
        setError(detail);
        logger.error(`Open in app failed: ${file.name}`, { error: err }, "companion");
      } finally {
        setOpenInAppLoading(false);
      }
    },
    [contentOperationEnvironment, currentTheme, onCompanionHint]
  );

  const openBrowserViewerPicker = useCallback(
    async (
      file: FileEntry,
      filePath: string,
      mimeType: string,
      options?: {
        includeAllViewers?: boolean;
        connectionId?: string;
        virtualSource?: VirtualItemHandle;
        virtualActivationId?: number;
        isActivationCurrent?: ActivationCurrentGuard;
      }
    ) => {
      const compatibleViewerIds = getCompatibleViewerIds(file.name, mimeType);
      const preferredViewerId = await getPreferredViewerId(file.name, mimeType);
      if (options?.isActivationCurrent && !options.isActivationCurrent()) {
        logger.debug("Ignoring superseded local viewer picker", { filePath }, "browser");
        return;
      }
      const defaultViewerId = compatibleViewerIds[0] ?? null;
      const viewerIds =
        options?.includeAllViewers ||
        compatibleViewerIds.length === 0 ||
        (preferredViewerId !== null && !compatibleViewerIds.includes(preferredViewerId))
          ? getAllViewerIds()
          : compatibleViewerIds;

      listContainerEl?.focus({ preventScroll: true });
      setBrowserViewerPickerState({
        connectionId: options?.connectionId,
        fileName: file.name,
        filePath,
        mimeType,
        virtualSource: options?.virtualSource,
        virtualActivationId: options?.virtualActivationId,
        viewerIds,
        compatibleViewerIds,
        defaultViewerId,
        preferredViewerId,
        showNativeOption: options?.virtualSource === undefined && compatibleViewerIds.length === 0,
      });
    },
    [listContainerEl]
  );

  const openFileWithAssociatedViewer = useCallback(
    (
      file: FileEntry,
      filePath: string,
      mimeType: string,
      targetConnectionId = connectionIdRef.current,
      isActivationCurrent?: ActivationCurrentGuard,
      virtualSource?: VirtualItemHandle,
      virtualActivationId?: number
    ) => {
      const compatibleViewerIds = getCompatibleViewerIds(file.name, mimeType);
      void getPreferredViewerId(file.name, mimeType).then((preferredViewerId) => {
        if (isActivationCurrent && !isActivationCurrent()) {
          logger.debug("Ignoring superseded local viewer activation", { filePath }, "browser");
          return;
        }
        if (preferredViewerId) {
          openFileInViewer(file, filePath, mimeType, preferredViewerId, targetConnectionId, virtualSource);
          return;
        }

        if (compatibleViewerIds.length === 0) {
          void openBrowserViewerPicker(file, filePath, mimeType, {
            connectionId: targetConnectionId,
            virtualSource,
            virtualActivationId,
            isActivationCurrent,
          });
          return;
        }

        if (compatibleViewerIds.length === 1) {
          openFileInViewer(file, filePath, mimeType, compatibleViewerIds[0], targetConnectionId, virtualSource);
          return;
        }

        void openBrowserViewerPicker(file, filePath, mimeType, {
          connectionId: targetConnectionId,
          virtualSource,
          virtualActivationId,
          isActivationCurrent,
        });
      });
    },
    [openBrowserViewerPicker, openFileInViewer]
  );

  const navigateToResolvedDirectory = useCallback(
    (sourceFile: FileEntry, targetConnectionId: string, targetPath: string) => {
      if (targetConnectionId !== connectionIdRef.current) {
        onNavigateDirectory?.(targetConnectionId, targetPath);
        return;
      }

      const currentScrollOffset = parentRef.current?.scrollTop || 0;
      navigationHistory.current.set(currentPathRef.current, {
        focusedIndex,
        scrollOffset: currentScrollOffset,
        selectedFileName: sourceFile.name,
      });
      pendingDirectoryEntryIntentRef.current = { kind: "fresh" };
      logger.info(
        "Navigating to resolved local directory",
        { from: currentPathRef.current, to: targetPath, source: sourceFile.name },
        "browser"
      );
      navigateToPath(targetPath);
    },
    [focusedIndex, navigateToPath, onNavigateDirectory]
  );

  const activateResolvedLocalTarget = useCallback(
    async (
      sourceFile: FileEntry,
      targetConnectionId: string,
      targetPath: string,
      targetFile: FileEntry,
      mode: BrowserOpenMode,
      recentRecordId?: string,
      isActivationCurrent?: ActivationCurrentGuard
    ) => {
      if (isActivationCurrent && !isActivationCurrent()) {
        return;
      }
      if (targetFile.type === FileType.DIRECTORY) {
        navigateToResolvedDirectory(sourceFile, targetConnectionId, targetPath);
        return;
      }

      const mimeType = targetFile.mime_type || "application/octet-stream";
      if (mode === "associated-native-app") {
        await openNativeFile(targetFile, undefined, { connectionId: targetConnectionId, path: targetPath, recentRecordId });
        return;
      }
      if (mode === "force-native-picker") {
        await openNativeFile(targetFile, { forcePicker: true }, { connectionId: targetConnectionId, path: targetPath, recentRecordId });
        return;
      }
      if (mode === "force-viewer-picker") {
        await openBrowserViewerPicker(targetFile, targetPath, mimeType, {
          includeAllViewers: true,
          connectionId: targetConnectionId,
          isActivationCurrent,
        });
        return;
      }

      openFileWithAssociatedViewer(targetFile, targetPath, mimeType, targetConnectionId, isActivationCurrent);
    },
    [navigateToResolvedDirectory, openBrowserViewerPicker, openFileWithAssociatedViewer, openNativeFile]
  );

  const resolveAndActivateLocalEntry = useCallback(
    async (sourceFile: FileEntry, sourcePath: string, mode: BrowserOpenMode) => {
      const sourceConnectionId = connectionIdRef.current;
      if (!sourceConnectionId) return;
      const requestId = ++latestLocalActivationRequestIdRef.current;

      try {
        const source = (storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY).resolveItem({
          connectionId: sourceConnectionId,
          path: sourcePath,
        });
        const backend = (storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY).getBackend(source.target);
        if (!backend.resolveActivation) throw new Error("Local activation resolution is unavailable");
        const resolution = await backend.resolveActivation(source);
        if (requestId !== latestLocalActivationRequestIdRef.current) {
          logger.debug("Ignoring superseded local activation target", { sourceConnectionId, sourcePath }, "browser");
          return;
        }

        await activateResolvedLocalTarget(
          sourceFile,
          resolution.connectionId,
          resolution.path,
          resolution.item,
          mode,
          undefined,
          () => requestId === latestLocalActivationRequestIdRef.current
        );
      } catch (error: unknown) {
        if (requestId !== latestLocalActivationRequestIdRef.current) {
          return;
        }

        const detail =
          isApiError(error) && typeof error.response?.data?.detail === "string"
            ? error.response.data.detail
            : "Failed to resolve local link.";
        setError(detail);
        logger.error("Failed to resolve local activation target", { sourceConnectionId, sourcePath, error }, "browser");
      }
    },
    [activateResolvedLocalTarget, storageRegistry]
  );

  const openArchive = useCallback(
    (archivePath: string) => {
      const providerId = providerRegistry.getVirtualProviderIdForFilename(archivePath);
      if (!providerId) {
        setError(ARCHIVE_LOAD_ERROR);
        return;
      }
      latestVirtualActivationIdRef.current += 1;
      archiveNavigationHistory.current.clear();
      pendingArchiveRestoreRef.current = null;
      const nextLocation = { providerId, archivePath, virtualPath: "" };
      transitionListingLocation(connectionIdRef.current, currentPathRef.current, nextLocation);
      setArchiveLocation(nextLocation);
      setViewInfo(null);
      setSelectedFiles(new Set());
      updateFocus(0, { immediate: true });
      onNavigateVirtualLocation?.({ providerId, sourcePath: archivePath, virtualPath: "" });
    },
    [onNavigateVirtualLocation, providerRegistry, transitionListingLocation, updateFocus]
  );

  const navigateArchiveToPath = useCallback(
    (virtualPath: string) => {
      const currentArchive = archiveLocationRef.current;
      if (!currentArchive || currentArchive.virtualPath === virtualPath) {
        return;
      }

      const currentPathPrefix = currentArchive.virtualPath ? `${currentArchive.virtualPath}/` : "";
      const enteredChildName = virtualPath.startsWith(currentPathPrefix)
        ? virtualPath.slice(currentPathPrefix.length).split("/")[0] || null
        : null;
      archiveNavigationHistory.current.set(getArchiveNavigationKey(currentArchive), {
        focusedIndex,
        scrollOffset: parentRef.current?.scrollTop ?? 0,
        selectedFileName: enteredChildName,
      });
      latestVirtualActivationIdRef.current += 1;
      const nextLocation = { ...currentArchive, virtualPath };
      const nextLocationKey = getArchiveNavigationKey(nextLocation);
      const savedState = archiveNavigationHistory.current.get(nextLocationKey);
      pendingArchiveRestoreRef.current = savedState ? { key: nextLocationKey, state: savedState } : null;
      transitionListingLocation(connectionIdRef.current, currentPathRef.current, nextLocation);
      setArchiveLocation(nextLocation);
      setSelectedFiles(new Set());
      updateFocus(0, { immediate: true });
      onNavigateVirtualLocation?.({
        providerId: nextLocation.providerId,
        sourcePath: nextLocation.archivePath,
        virtualPath: nextLocation.virtualPath,
      });
    },
    [focusedIndex, onNavigateVirtualLocation, transitionListingLocation, updateFocus]
  );

  const closeArchive = useCallback(() => {
    const currentArchive = archiveLocationRef.current;
    if (currentArchive === null) {
      return;
    }

    latestVirtualActivationIdRef.current += 1;
    const archiveName = currentArchive.archivePath.split("/").at(-1);
    pendingDirectoryEntryIntentRef.current = archiveName ? { kind: "parent-return", childName: archiveName } : { kind: "fresh" };
    transitionListingLocation(connectionIdRef.current, currentPathRef.current, null);
    setArchiveLocation(null);
    archiveNavigationHistory.current.clear();
    pendingArchiveRestoreRef.current = null;
    setSelectedFiles(new Set());
    pendingLocationReloadRef.current = {
      connectionId: connectionIdRef.current,
      path: currentPathRef.current,
      options: { forceRefresh: true },
    };
    onNavigateVirtualLocation?.(null);
  }, [onNavigateVirtualLocation, transitionListingLocation]);

  const loadMoreArchive = useCallback(() => {
    const currentArchive = archiveLocationRef.current;
    if (currentArchive) {
      void loadArchiveFilesRef.current?.(currentArchive, true);
    }
  }, []);

  useEffect(() => {
    loadMoreVirtualItemsRef.current = loadMoreArchive;
    return () => {
      loadMoreVirtualItemsRef.current = () => {};
    };
  }, [loadMoreArchive]);

  const openArchiveMember = useCallback(
    (file: FileEntry, mode: BrowserOpenMode = "associated-viewer") => {
      if (!archiveLocationRef.current) {
        return;
      }

      // Nested archives cannot be listed from a virtual member source yet.
      if (file.type === FileType.FILE && providerRegistry.getVirtualProviderIdForFilename(file.name)) {
        return;
      }

      if (!file.is_readable) {
        setError(ARCHIVE_MEMBER_OPEN_ERROR);
        return;
      }

      const item = getItemForEntry(file);
      if (!item || !isVirtualItem(item)) {
        setError(ARCHIVE_MEMBER_OPEN_ERROR);
        return;
      }

      const activationId = latestVirtualActivationIdRef.current + 1;
      latestVirtualActivationIdRef.current = activationId;
      const isActivationCurrent = () => activationId === latestVirtualActivationIdRef.current;
      const mimeType = file.mime_type ?? getFileTypeByExtension(file.name)?.mimeTypes[0] ?? "application/octet-stream";
      if (mode === "force-viewer-picker") {
        void openBrowserViewerPicker(file, file.path, mimeType, {
          includeAllViewers: true,
          virtualSource: item.handle,
          virtualActivationId: activationId,
          isActivationCurrent,
        });
        return;
      }

      openFileWithAssociatedViewer(file, file.path, mimeType, connectionIdRef.current, isActivationCurrent, item.handle, activationId);
    },
    [getItemForEntry, openBrowserViewerPicker, openFileWithAssociatedViewer, providerRegistry]
  );

  const handleFileClick = useCallback(
    (file: FileEntry, index?: number) => {
      if (index !== undefined) {
        updateFocus(index, { immediate: true });
      }

      if (archiveLocationRef.current) {
        if (file.type === "directory") {
          navigateArchiveToPath(file.path);
        } else {
          openArchiveMember(file);
        }
        return;
      }

      const filePath = currentPathRef.current ? `${currentPathRef.current}/${file.name}` : file.name;
      if (file.type === "file" && providerRegistry.getVirtualProviderIdForFilename(file.name)) {
        openArchive(filePath);
        return;
      }
      if (isLocalDrive(connectionIdRef.current)) {
        void resolveAndActivateLocalEntry(file, filePath, "associated-viewer");
        return;
      }

      if (file.type === "directory") {
        const currentScrollOffset = parentRef.current?.scrollTop || 0;
        const currentFocusedIndex = focusedIndex;
        navigationHistory.current.set(currentPath, {
          focusedIndex: currentFocusedIndex,
          scrollOffset: currentScrollOffset,
          selectedFileName: file.name,
        });

        const newPath = currentPath ? `${currentPath}/${file.name}` : file.name;
        pendingDirectoryEntryIntentRef.current = { kind: "fresh" };
        logger.info("Navigating to directory", { from: currentPath, to: newPath, directory: file.name }, "browser");

        navigateToPath(newPath);
        return;
      }

      const mimeType = file.mime_type || "application/octet-stream";

      openFileWithAssociatedViewer(file, filePath, mimeType);
    },
    [
      currentPath,
      updateFocus,
      focusedIndex,
      navigateToPath,
      navigateArchiveToPath,
      openArchive,
      openArchiveMember,
      openFileWithAssociatedViewer,
      providerRegistry,
      resolveAndActivateLocalEntry,
    ]
  );

  const handleOpenFileForFile = useCallback(
    (file: FileEntry, index: number, mode: BrowserOpenMode = "associated-viewer") => {
      if (archiveLocationRef.current) {
        if (file.type === "directory") {
          navigateArchiveToPath(file.path);
        } else {
          openArchiveMember(file, mode);
        }
        return;
      }

      const filePath = currentPathRef.current ? `${currentPathRef.current}/${file.name}` : file.name;
      if (file.type === "file" && providerRegistry.getVirtualProviderIdForFilename(file.name)) {
        openArchive(filePath);
        return;
      }
      if (isLocalDrive(connectionIdRef.current)) {
        void resolveAndActivateLocalEntry(file, filePath, mode);
        return;
      }

      if (file.type === "directory") {
        handleFileClick(file, index);
        return;
      }

      const mimeType = file.mime_type || "application/octet-stream";

      if (mode === "associated-native-app") {
        void openNativeFile(file);
        return;
      }

      if (mode === "force-native-picker") {
        void openNativeFile(file, { forcePicker: true });
        return;
      }

      if (mode === "force-viewer-picker") {
        void openBrowserViewerPicker(file, filePath, mimeType, { includeAllViewers: true });
        return;
      }

      openFileWithAssociatedViewer(file, filePath, mimeType);
    },
    [
      handleFileClick,
      navigateArchiveToPath,
      openArchive,
      openArchiveMember,
      openNativeFile,
      openBrowserViewerPicker,
      openFileWithAssociatedViewer,
      providerRegistry,
      resolveAndActivateLocalEntry,
    ]
  );

  const handleOpenFileAtPath = useCallback(
    async (targetConnectionId: string, path: string, mode: BrowserOpenMode = "associated-viewer", recentRecordId?: string) => {
      const name = path.split("/").pop();
      if (!name || !path) return;
      let file = { name, type: "file", mime_type: "application/octet-stream" } as FileEntry;
      const requestId = recentRecordId ? ++latestLocalActivationRequestIdRef.current : undefined;
      const isActivationCurrent = () => requestId === undefined || requestId === latestLocalActivationRequestIdRef.current;

      if (recentRecordId) {
        if (isLocalDrive(targetConnectionId)) {
          try {
            const source = (storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY).resolveItem({ connectionId: targetConnectionId, path });
            const backend = (storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY).getBackend(source.target);
            if (!backend.resolveActivation) throw new Error("Local activation resolution is unavailable");
            const resolution = await backend.resolveActivation(source);
            if (!isActivationCurrent()) {
              logger.debug("Ignoring superseded recent local activation target", { targetConnectionId, path }, "browser");
              return;
            }
            await activateResolvedLocalTarget(
              file,
              resolution.connectionId,
              resolution.path,
              resolution.item,
              mode,
              recentRecordId,
              isActivationCurrent
            );
            return;
          } catch (error: unknown) {
            if (!isActivationCurrent()) {
              return;
            }
            if (getApiErrorCode(error) === "local_link_target_missing") {
              await removeRecentFileRecord(recentRecordId);
              setError(RECENT_FILE_MISSING_ERROR);
            } else {
              setError(RECENT_FILE_DEFAULT_ERROR);
            }
            logger.warn("Recent local file could not be validated before opening", { targetConnectionId, path, error }, "browser");
            return;
          }
        } else {
          try {
            file = await (history ?? browserHistoryService).validateRecentFileTarget(recentRecordId);
            if (!isActivationCurrent()) {
              return;
            }
          } catch (error: unknown) {
            if (!isActivationCurrent()) {
              return;
            }
            const validationError = getRecentFileValidationError(error);
            if (validationError && STALE_RECENT_FILE_CODES.has(validationError.code)) {
              publishRecentFilesChanged();
            }
            setError(validationError?.message ?? RECENT_FILE_DEFAULT_ERROR);
            logger.warn("Recent file could not be validated before opening", { targetConnectionId, path, error }, "browser");
            return;
          }
        }
      }
      if (!isActivationCurrent()) {
        return;
      }
      const mimeType = file.mime_type || "application/octet-stream";

      if (mode === "associated-native-app") {
        void openNativeFile(file, undefined, { connectionId: targetConnectionId, path, recentRecordId });
        return;
      }
      if (mode === "force-native-picker") {
        void openNativeFile(file, { forcePicker: true }, { connectionId: targetConnectionId, path, recentRecordId });
        return;
      }
      if (mode === "force-viewer-picker") {
        void openBrowserViewerPicker(file, path, mimeType, {
          includeAllViewers: true,
          connectionId: targetConnectionId,
          isActivationCurrent,
        });
        return;
      }
      openFileWithAssociatedViewer(file, path, mimeType, targetConnectionId, isActivationCurrent);
    },
    [
      activateResolvedLocalTarget,
      openBrowserViewerPicker,
      openFileWithAssociatedViewer,
      openNativeFile,
      removeRecentFileRecord,
      storageRegistry,
      history,
    ]
  );

  const handleOpenFile = useCallback(
    (options?: { requireListFocus?: boolean; mode?: BrowserOpenMode }) => {
      const file = getFocusedFileForAction(options);
      if (file) {
        handleOpenFileForFile(file, focusedIndex, options?.mode ?? "associated-viewer");
      }
    },
    [focusedIndex, getFocusedFileForAction, handleOpenFileForFile]
  );

  const handleNavigateUpDirectory = useCallback(() => {
    const currentArchive = archiveLocationRef.current;
    if (currentArchive) {
      if (!currentArchive.virtualPath) {
        closeArchive();
      } else {
        const parentPath = currentArchive.virtualPath.includes("/")
          ? currentArchive.virtualPath.slice(0, currentArchive.virtualPath.lastIndexOf("/"))
          : "";
        navigateArchiveToPath(parentPath);
      }
      return;
    }

    if (!currentPathRef.current) return;
    const pathParts = currentPathRef.current.split("/");
    const childDirectoryName = pathParts[pathParts.length - 1] || null;
    const parentPath = pathParts.slice(0, -1).join("/");

    pendingDirectoryEntryIntentRef.current = childDirectoryName
      ? { kind: "parent-return", childName: childDirectoryName }
      : { kind: "fresh" };

    if (childDirectoryName) {
      const existingParentHistory = navigationHistory.current.get(parentPath);
      navigationHistory.current.set(parentPath, {
        focusedIndex: existingParentHistory?.focusedIndex ?? 0,
        scrollOffset: existingParentHistory?.scrollOffset ?? 0,
        selectedFileName: childDirectoryName,
      });
    }

    const newPath = pathParts.slice(0, -1).join("/");
    navigateToPath(newPath);
  }, [closeArchive, navigateArchiveToPath, navigateToPath]);

  /**
   * handleNavigateUp — Called by toolbar / breadcrumb "up" button.
   * Unlike handleNavigateUpDirectory (used by keyboard shortcut),
   * this also checks whether navigation is possible.
   */
  const handleNavigateUp = useCallback(() => {
    handleNavigateUpDirectory();
  }, [handleNavigateUpDirectory]);

  const handleClose = useCallback(() => {
    setViewInfo(null);
    setBrowserViewerPickerState(null);
    selectionAnchorRef.current = null;
    setSelectedFiles(new Set());
  }, []);

  const handleFocusSearch = useCallback(() => {
    searchInputRef.current?.focus();
  }, []);

  const handleRefresh = useCallback(() => {
    void reloadCurrentLocation({ forceRefresh: true });
  }, [reloadCurrentLocation]);

  // ──────────────────────────────────────────────────────────────────────────
  // Selection (multi-select)
  // ──────────────────────────────────────────────────────────────────────────

  /** Toggle the focused file's selection. Insert / Space both trigger this. */
  const handleToggleSelection = useCallback(
    (_e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const files = filesRef.current;
      if (files.length === 0) return;

      const currentFile = files[focusedIndex];
      if (!currentFile) return;

      selectionAnchorRef.current = currentFile.path;
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(currentFile.path)) {
          next.delete(currentFile.path);
        } else {
          next.add(currentFile.path);
        }
        if (next.size === 0) selectionAnchorRef.current = null;
        return next;
      });
    },
    [focusedIndex, listContainerEl]
  );

  /**
   * Select the focused file and move focus down (Alt+ArrowDown).
   * Always adds to the selection set (never deselects), like Shift+Down in most file managers.
   */
  const handleSelectDown = useCallback(
    (_e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const files = filesRef.current;
      if (files.length === 0) return;

      const currentFile = files[focusedIndex];
      if (!currentFile) return;

      selectionAnchorRef.current = currentFile.path;
      // Select the current file
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.add(currentFile.path);
        return next;
      });

      // Move focus down
      if (focusedIndex < files.length - 1) {
        updateFocus(focusedIndex + 1);
      }
    },
    [focusedIndex, updateFocus, listContainerEl]
  );

  /**
   * Select the focused file and move focus up (Alt+ArrowUp).
   * Always adds to the selection set (never deselects), like Shift+Up in most file managers.
   */
  const handleSelectUp = useCallback(
    (_e?: KeyboardEvent) => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const files = filesRef.current;
      if (files.length === 0) return;

      const currentFile = files[focusedIndex];
      if (!currentFile) return;

      selectionAnchorRef.current = currentFile.path;
      // Select the current file
      setSelectedFiles((prev) => {
        const next = new Set(prev);
        next.add(currentFile.path);
        return next;
      });

      // Move focus up
      if (focusedIndex > 0) {
        updateFocus(focusedIndex - 1);
      }
    },
    [focusedIndex, updateFocus, listContainerEl]
  );

  const handleSelectToBoundary = useCallback(
    (boundary: "first" | "last") => {
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const displayed = filesRef.current;
      const startIndex = pendingFocusedIndexRef.current ?? focusedIndex;
      const currentFile = displayed[startIndex];
      if (!currentFile) return;

      const targetIndex = boundary === "first" ? 0 : displayed.length - 1;
      const range = displayed.slice(Math.min(startIndex, targetIndex), Math.max(startIndex, targetIndex) + 1);
      selectionAnchorRef.current = currentFile.path;
      setSelectedFiles((previous) => new Set([...previous, ...range.map((file) => file.path)]));
      updateFocus(targetIndex);
    },
    [focusedIndex, updateFocus, listContainerEl]
  );

  /** Select all files in the current directory (Ctrl+A). */
  const handleSelectAll = useCallback(() => {
    const allPaths = new Set(filesRef.current.map((file) => file.path));
    selectionAnchorRef.current = filesRef.current[focusedIndex]?.path ?? null;
    setSelectedFiles(allPaths);
  }, [focusedIndex]);

  /** Clear all selections. */
  const handleClearSelection = useCallback(() => {
    selectionAnchorRef.current = null;
    setSelectedFiles(new Set());
  }, []);

  const removeSelectedPaths = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    const removedPaths = new Set(paths);
    setSelectedFiles((previous) => {
      const next = new Set([...previous].filter((path) => !removedPaths.has(path)));
      if (next.size === 0) selectionAnchorRef.current = null;
      return next.size === previous.size ? previous : next;
    });
  }, []);

  const selectItem = useCallback(
    (file: FileEntry, index: number) => {
      skipNextLayoutScrollRef.current = true;
      updateFocus(index, { immediate: true });
      selectionAnchorRef.current = file.path;
      setSelectedFiles((previous) => new Set(previous).add(file.path));
    },
    [updateFocus]
  );

  const toggleItemSelection = useCallback(
    (file: FileEntry, index: number) => {
      skipNextLayoutScrollRef.current = true;
      updateFocus(index, { immediate: true });
      selectionAnchorRef.current = file.path;
      setSelectedFiles((previous) => {
        const next = new Set(previous);
        if (next.has(file.path)) {
          next.delete(file.path);
        } else {
          next.add(file.path);
        }
        if (next.size === 0) selectionAnchorRef.current = null;
        return next;
      });
    },
    [updateFocus]
  );

  const selectItemFromIcon = useCallback(
    (file: FileEntry, index: number, extend: boolean, _additive: boolean) => {
      skipNextLayoutScrollRef.current = true;
      updateFocus(index, { immediate: true });
      const displayed = filesRef.current;
      const anchorIndex = displayed.findIndex((entry) => entry.path === selectionAnchorRef.current);
      if (extend && anchorIndex !== -1) {
        const range = displayed.slice(Math.min(anchorIndex, index), Math.max(anchorIndex, index) + 1).map((entry) => entry.path);
        setSelectedFiles((previous) => new Set([...previous, ...range]));
      } else if (extend) {
        selectionAnchorRef.current = file.path;
        setSelectedFiles((previous) => new Set(previous).add(file.path));
      } else {
        selectionAnchorRef.current = file.path;
        setSelectedFiles((previous) => {
          const next = new Set(previous);
          if (next.has(file.path)) next.delete(file.path);
          else next.add(file.path);
          if (next.size === 0) selectionAnchorRef.current = null;
          return next;
        });
      }
    },
    [updateFocus]
  );

  /**
   * Returns the effective selection for operations (copy, move, delete, etc.).
   * If files are explicitly selected, returns those in display order.
   * Otherwise returns the single focused file.
   */
  const getEffectiveSelection = useCallback(() => {
    if (selectedFiles.size > 0) {
      return itemsRef.current.filter((item) => selectedFiles.has(item.entry.path));
    }
    const focused = itemsRef.current[focusedIndex];
    return focused ? [focused] : [];
  }, [selectedFiles, focusedIndex]);

  const getItemsByPaths = useCallback((paths: readonly string[]) => {
    const pathSet = new Set(paths);
    return itemsRef.current.filter((item) => pathSet.has(item.entry.path));
  }, []);

  // Clear selection when the directory or connection changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: connectionId is needed as a trigger
  useEffect(() => {
    if (pendingSelectedFilesRestoreRef.current !== null) {
      setSelectedFiles(new Set(pendingSelectedFilesRestoreRef.current));
      selectionAnchorRef.current = null;
      pendingSelectedFilesRestoreRef.current = null;
      return;
    }

    selectionAnchorRef.current = null;
    setSelectedFiles(new Set());
  }, [currentPath, connectionId, archiveLocation?.archivePath, archiveLocation?.virtualPath]);

  useEffect(() => {
    if (loading) return;
    const currentPaths = new Set(files.map((file) => file.path));
    setSelectedFiles((previous) => {
      if (previous.size === 0) return previous;
      const next = new Set([...previous].filter((path) => currentPaths.has(path)));
      if (next.size === 0) selectionAnchorRef.current = null;
      return next.size === previous.size ? previous : next;
    });
  }, [files, loading]);

  // ──────────────────────────────────────────────────────────────────────────
  // Delete
  // ──────────────────────────────────────────────────────────────────────────

  const handleDeleteRequest = useCallback(
    (options?: { requireListFocus?: boolean }) => {
      if (!contentCapabilities.mutate || connectionIsReadOnly) return;

      const focusedFile = getFocusedFileForAction(options);
      if (!focusedFile) return;

      const targets = getEffectiveSelection();
      if (targets.length === 0) return;

      setDeleteTargets(targets);
      setDeleteDialogOpen(true);
    },
    [connectionIsReadOnly, contentCapabilities.mutate, getEffectiveSelection, getFocusedFileForAction]
  );

  const handleDeleteItems = useCallback(
    (items: readonly BrowserItem[]) => {
      if (!contentCapabilities.mutate || connectionIsReadOnly || items.length === 0) return;

      setDeleteTargets([...items]);
      setDeleteDialogOpen(true);
    },
    [connectionIsReadOnly, contentCapabilities.mutate]
  );

  const handleDeleteForFile = useCallback(
    (file: FileEntry, index: number) => {
      if (!contentCapabilities.mutate || connectionIsReadOnly) return;
      const item = getItemForEntry(file);
      if (!item) return;
      updateFocus(index, { immediate: true });
      setDeleteTargets([item]);
      setDeleteDialogOpen(true);
    },
    [connectionIsReadOnly, contentCapabilities.mutate, getItemForEntry, updateFocus]
  );

  const handleDeleteConfirm = useCallback(async () => {
    if (deleteTargets.length === 0 || !connectionId) return;
    if (!contentCapabilities.mutate || connectionIsReadOnly) return;

    setIsDeleting(true);
    let deletedCount = 0;
    try {
      await deleteContentItems(
        deleteTargets.map((target) => target.handle),
        contentOperationEnvironment
      );
      deletedCount = deleteTargets.length;

      setDeleteDialogOpen(false);
      setDeleteTargets([]);
      setSelectedFiles((previous) => {
        const next = new Set(previous);
        deleteTargets.forEach((target) => {
          next.delete(target.entry.path);
        });
        return next;
      });
      pendingFocusNameRef.current = null;

      void reloadCurrentLocation({ forceRefresh: true });
      listContainerEl?.focus();

      logger.info(`Deleted ${deleteTargets.length} item(s).`, { paths: deleteTargets.map((target) => target.handle.path) }, "file-browser");
    } catch (err: unknown) {
      const detail = getApiErrorMessage(err, "Failed to delete item.");
      setError(detail);
      setDeleteTargets((currentTargets) => currentTargets.slice(deletedCount));
      logger.error("Delete failed.", { error: err, paths: deleteTargets.map((target) => target.handle.path) }, "file-browser");
    } finally {
      setIsDeleting(false);
    }
  }, [
    connectionIsReadOnly,
    contentCapabilities.mutate,
    contentOperationEnvironment,
    deleteTargets,
    connectionId,
    listContainerEl,
    reloadCurrentLocation,
  ]);

  const closeDeleteDialog = useCallback(() => {
    setDeleteDialogOpen(false);
    setDeleteTargets([]);
  }, []);

  // Rename
  // ──────────────────────────────────────────────────────────────────────────

  const handleRenameRequest = useCallback(
    (options?: { requireListFocus?: boolean }) => {
      const file = getFocusedFileForAction(options);
      if (!file) return;
      if (!contentCapabilities.mutate || connectionIsReadOnly) return;

      const item = getItemForEntry(file);
      if (!item) return;

      setRenameError(null);
      setRenameTarget(item);
      setRenameDialogOpen(true);
    },
    [connectionIsReadOnly, contentCapabilities.mutate, getFocusedFileForAction, getItemForEntry]
  );

  const handleRenameConfirm = useCallback(
    async (newName: string) => {
      if (!renameTarget || !connectionId) return;
      if (!contentCapabilities.mutate || connectionIsReadOnly) return;

      setIsRenaming(true);
      setRenameError(null);
      try {
        await renameContentItem(renameTarget.handle, newName, contentOperationEnvironment);

        setRenameDialogOpen(false);
        setRenameTarget(null);
        pendingFocusNameRef.current = newName;
        setSelectedFiles((previous) => {
          if (!previous.has(renameTarget.entry.path)) return previous;
          const separatorIndex = Math.max(renameTarget.entry.path.lastIndexOf("/"), renameTarget.entry.path.lastIndexOf("\\"));
          const renamedPath = `${separatorIndex >= 0 ? renameTarget.entry.path.slice(0, separatorIndex + 1) : ""}${newName}`;
          const next = new Set(previous);
          next.delete(renameTarget.entry.path);
          next.add(renamedPath);
          return next;
        });

        void reloadCurrentLocation({ forceRefresh: true });
        listContainerEl?.focus();

        logger.info(`Renamed: ${renameTarget.handle.path} -> ${newName}`, undefined, "file-browser");
      } catch (err: unknown) {
        const detail = getApiErrorMessage(err, "Failed to rename item.");
        setRenameError(detail);
        logger.error(`Rename failed: ${renameTarget.handle.path}`, { error: err }, "file-browser");
      } finally {
        setIsRenaming(false);
      }
    },
    [
      connectionIsReadOnly,
      contentCapabilities.mutate,
      contentOperationEnvironment,
      renameTarget,
      connectionId,
      listContainerEl,
      reloadCurrentLocation,
    ]
  );

  const handleRenameForFile = useCallback(
    (file: FileEntry, index: number) => {
      if (!contentCapabilities.mutate || connectionIsReadOnly) return;
      const item = getItemForEntry(file);
      if (!item) return;
      updateFocus(index, { immediate: true });
      setRenameError(null);
      setRenameTarget(item);
      setRenameDialogOpen(true);
    },
    [connectionIsReadOnly, contentCapabilities.mutate, getItemForEntry, updateFocus]
  );

  const closeRenameDialog = useCallback(() => {
    setRenameDialogOpen(false);
    setRenameTarget(null);
    setRenameError(null);
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Create Item
  // ──────────────────────────────────────────────────────────────────────────

  const handleNewDirectoryRequest = useCallback(() => {
    if (!getCreateContentItemAvailability(currentContentLocation, contentOperationEnvironment).available) return;
    setCreateError(null);
    setCreateItemType(FileType.DIRECTORY);
    setCreateDialogOpen(true);
  }, [contentOperationEnvironment, currentContentLocation]);

  const handleNewFileRequest = useCallback(() => {
    if (!getCreateContentItemAvailability(currentContentLocation, contentOperationEnvironment).available) return;
    setCreateError(null);
    setCreateItemType(FileType.FILE);
    setCreateDialogOpen(true);
  }, [contentOperationEnvironment, currentContentLocation]);

  const handleCreateConfirm = useCallback(
    async (name: string) => {
      if (!getCreateContentItemAvailability(currentContentLocation, contentOperationEnvironment).available) return;

      setIsCreating(true);
      setCreateError(null);
      try {
        await createContentItem(
          currentContentLocation,
          name,
          createItemType === FileType.DIRECTORY ? "directory" : "file",
          contentOperationEnvironment
        );

        setCreateDialogOpen(false);
        pendingFocusNameRef.current = name;

        void reloadCurrentLocation({ forceRefresh: true });
        listContainerEl?.focus();

        logger.info(`Created ${createItemType}: ${name}`, undefined, "file-browser");
      } catch (err: unknown) {
        const detail = getApiErrorMessage(err, "Failed to create item.");
        setCreateError(detail);
        logger.error(`Create failed: ${name}`, { error: err }, "file-browser");
      } finally {
        setIsCreating(false);
      }
    },
    [contentOperationEnvironment, createItemType, currentContentLocation, listContainerEl, reloadCurrentLocation]
  );

  const closeCreateDialog = useCallback(() => {
    setCreateDialogOpen(false);
    setCreateError(null);
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Companion App
  // ──────────────────────────────────────────────────────────────────────────

  const handleOpenInApp = useCallback(
    async (options?: { forcePicker?: boolean }) => {
      if (!contentCapabilities.openInNativeApp || !connectionId) return;
      const file = filesRef.current[focusedIndex];
      if (!file || file.type === "directory") return;
      const item = getItemForEntry(file);
      if (!item || !getNativeOpenAvailability(item.handle, contentOperationEnvironment).available) return;
      await openNativeFile(file, options, {
        item: item.handle,
        onResolvedDirectory: (location) => navigateToResolvedDirectory(file, location.connectionId, location.path),
      });
    },
    [
      connectionId,
      contentCapabilities.openInNativeApp,
      contentOperationEnvironment,
      focusedIndex,
      getItemForEntry,
      navigateToResolvedDirectory,
      openNativeFile,
    ]
  );

  const handleOpenInAppForFile = useCallback(
    async (file: FileEntry, _index: number, options?: { forcePicker?: boolean }) => {
      if (!contentCapabilities.openInNativeApp || !connectionId || file.type === "directory") return;
      const item = getItemForEntry(file);
      if (!item || !getNativeOpenAvailability(item.handle, contentOperationEnvironment).available) return;
      await openNativeFile(file, options, {
        item: item.handle,
        onResolvedDirectory: (location) => navigateToResolvedDirectory(file, location.connectionId, location.path),
      });
    },
    [
      connectionId,
      contentCapabilities.openInNativeApp,
      contentOperationEnvironment,
      getItemForEntry,
      navigateToResolvedDirectory,
      openNativeFile,
    ]
  );

  const closeBrowserViewerPicker = useCallback(() => {
    browserViewerPickerConfirmationTokenRef.current += 1;
    setBrowserViewerPickerState(null);
  }, []);

  const confirmBrowserViewerPicker = useCallback(
    async (selection: { viewerId: ViewerId | null; rememberSelection: boolean }) => {
      const pickerState = browserViewerPickerState;
      if (!pickerState) {
        return;
      }

      if (pickerState.virtualActivationId !== undefined && pickerState.virtualActivationId !== latestVirtualActivationIdRef.current) {
        setBrowserViewerPickerState(null);
        return;
      }

      const activeDirectoryFile = pickerState.virtualSource
        ? filesRef.current.find((entry) => entry.path === pickerState.filePath)
        : filesRef.current.find(
            (entry) => (currentPathRef.current ? `${currentPathRef.current}/${entry.name}` : entry.name) === pickerState.filePath
          );
      if (pickerState.virtualSource && !activeDirectoryFile?.is_readable) {
        setError(ARCHIVE_MEMBER_OPEN_ERROR);
        return;
      }

      const file = activeDirectoryFile ?? ({ name: pickerState.fileName, type: "file", mime_type: pickerState.mimeType } as FileEntry);
      if (file.type === "directory") {
        return;
      }
      const targetConnectionId = pickerState.connectionId ?? connectionIdRef.current;

      if (selection.viewerId === null) {
        if (pickerState.virtualSource) {
          return;
        }
        setBrowserViewerPickerState(null);
        await openNativeFile(file, undefined, { connectionId: targetConnectionId, path: pickerState.filePath });
        return;
      }

      if (selection.rememberSelection) {
        const confirmationToken = browserViewerPickerConfirmationTokenRef.current + 1;
        browserViewerPickerConfirmationTokenRef.current = confirmationToken;
        setBrowserViewerPickerState((current) => (current === pickerState ? { ...current, saving: true, saveError: null } : current));
        try {
          await setPreferredViewerId(file.name, pickerState.mimeType, selection.viewerId);
        } catch (error) {
          if (browserViewerPickerConfirmationTokenRef.current === confirmationToken) {
            setBrowserViewerPickerState((current) =>
              current
                ? { ...current, saving: false, saveError: error instanceof Error ? error.message : "Unable to save viewer preference." }
                : current
            );
          }
          return;
        }
        if (browserViewerPickerConfirmationTokenRef.current !== confirmationToken) {
          return;
        }
      }

      setBrowserViewerPickerState(null);
      openFileInViewer(file, pickerState.filePath, pickerState.mimeType, selection.viewerId, targetConnectionId, pickerState.virtualSource);
    },
    [browserViewerPickerState, openFileInViewer, openNativeFile]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // WebSocket Integration
  // ──────────────────────────────────────────────────────────────────────────

  const handleDirectoryChanged = useCallback(
    (change: DirectoryChange, options?: { invalidateOnly?: boolean }) => {
      const { connectionId: changedConnectionId, path: changedPath } = change;
      // Invalidate cache for the changed directory
      const cacheKey = `${changedConnectionId}:${changedPath}`;
      directoryCache.current.delete(cacheKey);

      if (options?.invalidateOnly) return;

      if (changedConnectionId !== connectionIdRef.current || changedPath !== currentPathRef.current) {
        return;
      }

      if (Date.now() - lastForceReloadRef.current < RELOAD_DEDUP_WINDOW_MS) {
        logger.info("Skipping redundant WebSocket reload (recent forced reload)", undefined, "websocket");
        return;
      }

      realtimeRefreshPendingRef.current = true;
      scheduleRealtimeRefresh();
    },
    [scheduleRealtimeRefresh]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Cache Management
  // ──────────────────────────────────────────────────────────────────────────

  const clearCaches = useCallback(() => {
    directoryCache.current.clear();
    navigationHistory.current.clear();
  }, []);

  const invalidateConnectionCache = useCallback((targetConnectionId: string) => {
    for (const key of directoryCache.current.keys()) {
      if (key.startsWith(`${targetConnectionId}:`)) {
        directoryCache.current.delete(key);
      }
    }
  }, []);

  const captureRecoverySnapshot = useCallback((): FileBrowserPaneRecoverySnapshot | null => {
    if (!connectionIdRef.current) {
      return null;
    }

    const focusedFileName = filesRef.current[focusedIndex]?.name ?? null;
    const currentScrollOffset = parentRef.current?.scrollTop ?? 0;

    return {
      connectionId: connectionIdRef.current,
      path: currentPathRef.current,
      archiveLocation: archiveLocation ? { ...archiveLocation } : null,
      items: [...files],
      sortBy,
      sortDirection,
      viewMode,
      focusedIndex,
      focusedFileName,
      selectedFileNames: Array.from(selectedFiles),
      viewInfo: viewInfo
        ? {
            ...viewInfo,
            images: viewInfo.images ? [...viewInfo.images] : undefined,
          }
        : null,
      scrollOffset: currentScrollOffset,
    };
  }, [archiveLocation, files, focusedIndex, selectedFiles, sortBy, sortDirection, viewInfo, viewMode]);

  const restoreRecoverySnapshot = useCallback(
    (snapshot: FileBrowserPaneRecoverySnapshot | null) => {
      if (!snapshot?.connectionId) {
        return;
      }

      const normalizedPath = normalizeLocalDrivePath(snapshot.connectionId, snapshot.path);
      if (connectionIdRef.current !== snapshot.connectionId || currentPathRef.current !== normalizedPath) {
        clearIncrementalSearch();
      }

      const nextCacheKey = `${snapshot.connectionId}:${snapshot.path}`;
      const nextItems = [...snapshot.items];
      const restoredArchiveLocation = snapshot.archiveLocation ?? null;
      const restoredBrowserItems = restoredArchiveLocation
        ? nextItems.map((entry) =>
            virtualItem(
              virtualLocation(
                restoredArchiveLocation.providerId,
                snapshot.connectionId,
                physicalLocation(snapshot.connectionId, restoredArchiveLocation.archivePath),
                restoredArchiveLocation.virtualPath
              ),
              entry
            )
          )
        : toPhysicalItems(snapshot.connectionId, snapshot.path, nextItems);
      const restoredViewInfo = snapshot.viewInfo?.virtualSource && !restoredArchiveLocation ? null : snapshot.viewInfo;
      const nextFocusedIndex = Math.max(snapshot.focusedIndex, 0);
      const nextSelectedFiles = new Set(snapshot.selectedFileNames);
      pendingLocationRef.current = null;
      pendingDirectoryEntryIntentRef.current = { kind: "restore-history" };
      pendingFocusNameRef.current = null;
      pendingSelectedFilesRestoreRef.current = nextSelectedFiles;

      latestVirtualActivationIdRef.current += 1;
      const locationChanged = transitionListingLocation(snapshot.connectionId, normalizedPath, restoredArchiveLocation);
      if (!locationChanged) {
        directoryLoadAbortRef.current?.abort();
        directoryLoadAbortRef.current = null;
        latestLoadRequestIdRef.current += 1;
        linkTargetLoadAbortRef.current?.abort();
        linkTargetLoadAbortRef.current = null;
        latestLinkTargetLoadRequestIdRef.current += 1;
      }
      archiveNavigationHistory.current.clear();
      pendingArchiveRestoreRef.current = null;

      directoryCache.current.clear();
      directoryCache.current.set(nextCacheKey, {
        items: nextItems,
        timestamp: Date.now(),
      });

      navigationHistory.current.clear();
      navigationHistory.current.set(snapshot.path, {
        focusedIndex: nextFocusedIndex,
        scrollOffset: Math.max(snapshot.scrollOffset, 0),
        selectedFileName: snapshot.focusedFileName,
      });

      currentViewIndexRef.current = snapshot.viewInfo?.currentIndex ?? null;
      currentViewImagesRef.current = snapshot.viewInfo?.images ? [...snapshot.viewInfo.images] : undefined;

      setSortBy(snapshot.sortBy);
      setSortDirection(snapshot.sortDirection);
      setViewMode(snapshot.viewMode);
      setFocusedIndex(nextFocusedIndex);
      setSelectedFiles(nextSelectedFiles);
      setViewInfo(
        restoredViewInfo
          ? {
              ...restoredViewInfo,
              images: restoredViewInfo.images ? [...restoredViewInfo.images] : undefined,
            }
          : null
      );
      latestLocalActivationRequestIdRef.current += 1;
      setConnectionId(snapshot.connectionId);
      setCurrentPath(normalizedPath);
      setArchiveLocation(restoredArchiveLocation);
      setArchiveHasMore(false);
      setArchiveLoadingMore(false);
      hasPhysicalListingRef.current = restoredArchiveLocation === null;
      setItems(restoredBrowserItems);
      setLoading(false);
      setError(null);
    },
    [clearIncrementalSearch, setViewMode, transitionListingLocation]
  );

  const applyResolvedLocation = useCallback(
    (nextConnectionId: string, normalizedPath: string, nextArchiveLocation: ArchiveLocation | null) => {
      const physicalLocationChanged = connectionIdRef.current !== nextConnectionId || currentPathRef.current !== normalizedPath;
      const currentArchiveLocation = archiveLocationRef.current;
      const archiveLocationChanged =
        physicalLocationChanged ||
        currentArchiveLocation?.providerId !== nextArchiveLocation?.providerId ||
        currentArchiveLocation?.archivePath !== nextArchiveLocation?.archivePath ||
        currentArchiveLocation?.virtualPath !== nextArchiveLocation?.virtualPath;
      const archiveSourceChanged =
        currentArchiveLocation?.providerId !== nextArchiveLocation?.providerId ||
        currentArchiveLocation?.archivePath !== nextArchiveLocation?.archivePath;
      const pendingLocation = pendingLocationRef.current;
      const matchedPendingLocation =
        pendingLocation !== null && pendingLocation.connectionId === nextConnectionId && pendingLocation.path === normalizedPath;
      if (pendingLocation) {
        if (matchedPendingLocation) {
          pendingLocationRef.current = null;
        } else {
          return;
        }
      }

      if (archiveLocationChanged) {
        latestVirtualActivationIdRef.current += 1;
        setViewInfo(null);
        setSelectedFiles(new Set());
        updateFocus(0, { immediate: true });
        if (archiveSourceChanged) {
          archiveNavigationHistory.current.clear();
          pendingArchiveRestoreRef.current = null;
        }
        if (nextArchiveLocation === null) {
          setBrowserViewerPickerState((previous) => (previous?.virtualSource ? null : previous));
        }
      }

      const connectionChanged = connectionIdRef.current !== nextConnectionId;

      if (physicalLocationChanged || archiveLocationChanged) {
        transitionListingLocation(nextConnectionId, normalizedPath, nextArchiveLocation);
      }

      if (archiveLocationChanged) {
        setArchiveLocation(nextArchiveLocation);
      }

      if (connectionChanged) {
        clearIncrementalSearch();
        const nextCacheKey = `${nextConnectionId}:${normalizedPath}`;
        const seededSnapshot = directoryCache.current.get(nextCacheKey);
        pendingDirectoryEntryIntentRef.current = { kind: "fresh" };
        latestLocalActivationRequestIdRef.current += 1;
        if (nextArchiveLocation === null) {
          prepareDirectoryTransition(nextConnectionId, normalizedPath);
        }
        setConnectionId(nextConnectionId);
        setCurrentPath(normalizedPath);
        setViewInfo(null);
        setSelectedFiles(new Set());
        directoryCache.current.clear();
        if (seededSnapshot) {
          directoryCache.current.set(nextCacheKey, seededSnapshot);
        }
        navigationHistory.current.clear();
        writeSelectedConnectionIdPreference(nextConnectionId || null);
        return;
      }

      if (physicalLocationChanged) {
        clearIncrementalSearch();
        if (!matchedPendingLocation) {
          pendingDirectoryEntryIntentRef.current = { kind: "restore-history" };
        }
        latestLocalActivationRequestIdRef.current += 1;
        if (nextArchiveLocation === null) {
          prepareDirectoryTransition(nextConnectionId, normalizedPath);
        }
        setCurrentPath(normalizedPath);
        setViewInfo(null);
        setSelectedFiles(new Set());
      }
    },
    [clearIncrementalSearch, prepareDirectoryTransition, transitionListingLocation, updateFocus]
  );

  const resolveArchiveRouteLocation = useCallback(
    async (
      targetConnectionId: string,
      archivePath: string,
      providerId: ArchiveLocation["providerId"],
      virtualSegments: string[]
    ): Promise<ResolvedRouteLocation> => {
      let virtualPath = "";

      for (const segment of virtualSegments) {
        let cursor: string | undefined;
        let matchingEntry: { name: string; type: FileType } | undefined;
        do {
          const location = virtualLocation(providerId, targetConnectionId, physicalLocation(targetConnectionId, archivePath), virtualPath);
          const listing = await providerRegistry.get(location).list(location, {
            cursor,
            pageSize: ARCHIVE_ROUTE_RESOLUTION_PAGE_SIZE,
          });
          matchingEntry = listing.items.find((item) => item.entry.name === segment)?.entry;
          cursor = listing.nextCursor ?? undefined;
        } while (!matchingEntry && cursor);

        if (!matchingEntry || matchingEntry.type !== FileType.DIRECTORY) {
          break;
        }
        virtualPath = joinRoutePath(virtualPath, segment);
      }

      if (virtualSegments.length === 0) {
        const location = virtualLocation(providerId, targetConnectionId, physicalLocation(targetConnectionId, archivePath), "");
        await providerRegistry.get(location).list(location, { pageSize: ARCHIVE_ROUTE_RESOLUTION_PAGE_SIZE });
      }

      const physicalPath = archivePath.includes("/") ? archivePath.slice(0, archivePath.lastIndexOf("/")) : "";
      const archiveLocation = { providerId, archivePath, virtualPath };
      return {
        physicalPath,
        archiveLocation,
        canonicalPath: joinRoutePath(archivePath, virtualPath),
      };
    },
    [providerRegistry]
  );

  const resolveRouteLocation = useCallback(
    async (targetConnectionId: string, targetPath: string): Promise<ResolvedRouteLocation> => {
      const getItemInfo = async (path: string) => {
        const item = (storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY).resolveItem({ connectionId: targetConnectionId, path });
        return (storageRegistry ?? UNAVAILABLE_STORAGE_REGISTRY).getBackend(item.target).getInfo(item);
      };
      const segments = targetPath.split("/").filter(Boolean);
      let physicalPath = "";

      for (const [index, segment] of segments.entries()) {
        const candidatePath = joinRoutePath(physicalPath, segment);
        const providerId = providerRegistry.getVirtualProviderIdForFilename(candidatePath);
        if (!providerId) {
          physicalPath = candidatePath;
          continue;
        }

        let info: { type: FileType };
        try {
          info = await getItemInfo(candidatePath);
        } catch (error: unknown) {
          if (getResponseStatus(error) === 404) {
            let existingPath = physicalPath;
            while (existingPath) {
              try {
                const existingInfo = await getItemInfo(existingPath);
                if (existingInfo.type === FileType.DIRECTORY) {
                  break;
                }
              } catch (ancestorError: unknown) {
                if (getResponseStatus(ancestorError) !== 404) {
                  throw ancestorError;
                }
              }
              existingPath = existingPath.includes("/") ? existingPath.slice(0, existingPath.lastIndexOf("/")) : "";
            }
            return { physicalPath: existingPath, archiveLocation: null, canonicalPath: existingPath };
          }
          throw error;
        }

        if (info.type === FileType.DIRECTORY) {
          physicalPath = candidatePath;
          continue;
        }

        try {
          return await resolveArchiveRouteLocation(targetConnectionId, candidatePath, providerId, segments.slice(index + 1));
        } catch (error: unknown) {
          const status = getResponseStatus(error);
          if (status === 404 || status === 422) {
            return { physicalPath, archiveLocation: null, canonicalPath: physicalPath };
          }
          throw error;
        }
      }

      return { physicalPath: targetPath, archiveLocation: null, canonicalPath: targetPath };
    },
    [providerRegistry, resolveArchiveRouteLocation, storageRegistry]
  );

  const applyLocation = useCallback(
    (nextConnectionId: string, nextPath: string, routeSyncToken?: number) => {
      if (routeSyncToken !== undefined) {
        if (routeSyncToken < lastAppliedRouteSyncTokenRef.current) {
          return;
        }

        lastAppliedRouteSyncTokenRef.current = routeSyncToken;
      }

      const resolutionId = routeLocationResolutionIdRef.current + 1;
      routeLocationResolutionIdRef.current = resolutionId;

      const normalizedPath = normalizeLocalDrivePath(nextConnectionId, nextPath);
      const hasArchiveCandidate = normalizedPath
        .split("/")
        .filter(Boolean)
        .some((_, index, segments) => providerRegistry.getVirtualProviderIdForFilename(segments.slice(0, index + 1).join("/")) !== null);
      if (!hasArchiveCandidate) {
        applyResolvedLocation(nextConnectionId, normalizedPath, null);
        return;
      }

      latestLocalActivationRequestIdRef.current += 1;

      void resolveRouteLocation(nextConnectionId, normalizedPath)
        .then((resolvedLocation) => {
          if (resolutionId !== routeLocationResolutionIdRef.current) {
            return;
          }

          applyResolvedLocation(nextConnectionId, resolvedLocation.physicalPath, resolvedLocation.archiveLocation);
          if (resolvedLocation.canonicalPath !== normalizedPath) {
            onResolveRouteLocationRef.current?.(resolvedLocation.physicalPath, resolvedLocation.archiveLocation);
          }
        })
        .catch((error: unknown) => {
          if (resolutionId !== routeLocationResolutionIdRef.current || isLocalAbortError(error)) {
            return;
          }

          logger.error("Error resolving browser route", { error, connectionId: nextConnectionId, path: normalizedPath }, "browser");
          setError(DIRECTORY_LOAD_GENERIC_ERROR);
        });
    },
    [applyResolvedLocation, providerRegistry, resolveRouteLocation]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Incremental Search (keydown handler)
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    const handleKeyDown = (e?: KeyboardEvent) => {
      if (!e) return;

      if (disabled || viewInfo) return;
      if (e.defaultPrevented) return;

      const target = e.target as HTMLElement;
      const isInInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      if (isInInput) {
        const input = target as HTMLInputElement;

        // Quick-bar inputs own their keyboard interaction. File-list handlers
        // must not react while focus remains inside the quick bar.
        if (input.dataset["quickBarInput"] === "true") {
          return;
        }

        const allowedKeysInInput = ["?", "Escape"];
        if (allowedKeysInInput.includes(e.key)) return;
        return;
      }

      if (viewInfo) return;

      // Incremental search — only when file list has focus
      if (!listContainerEl) return;
      const activeElement = document.activeElement;
      if (activeElement !== listContainerEl && !listContainerEl.contains(activeElement)) return;

      const currentFiles = filesRef.current;
      const fileCount = currentFiles.length;

      const shortcutKeys = ["?", "Escape"];
      if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " " && !shortcutKeys.includes(e.key) && fileCount > 0) {
        e.preventDefault();

        if (searchTimeoutRef.current) {
          clearTimeout(searchTimeoutRef.current);
        }

        searchBufferRef.current += e.key.toLowerCase();

        const index = currentFiles.findIndex((f: FileEntry) => f.name.toLowerCase().startsWith(searchBufferRef.current));
        if (index !== -1) {
          updateFocus(index);
        }

        searchTimeoutRef.current = window.setTimeout(() => {
          searchBufferRef.current = "";
          searchTimeoutRef.current = null;
        }, INCREMENTAL_SEARCH_RESET_DELAY_MS);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [disabled, viewInfo, updateFocus, listContainerEl]);

  useEffect(() => {
    if (!listContainerEl) return;

    // Capture before a focused file-list control can consume Escape.
    const handleFileListKeyDownCapture = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        clearIncrementalSearch();
      }
    };

    listContainerEl.addEventListener("keydown", handleFileListKeyDownCapture, { capture: true });
    return () => {
      listContainerEl.removeEventListener("keydown", handleFileListKeyDownCapture, { capture: true });
    };
  }, [clearIncrementalSearch, listContainerEl]);

  // ──────────────────────────────────────────────────────────────────────────
  // Return
  // ──────────────────────────────────────────────────────────────────────────

  return {
    // Core state
    connectionId,
    setConnectionId,
    currentPath,
    setCurrentPath,
    currentLocation: currentContentLocation,
    archiveLocation,
    contentCapabilities,
    archiveHasMore,
    archiveLoadingMore,
    files,
    loading,
    error,
    setError,
    companionPairingError:
      error !== null && error === companionPairingError?.message && isLocalDrive(connectionId) ? companionPairingError.kind : null,

    // UI preferences
    sortBy,
    setSortBy,
    sortDirection,
    setSortDirection,
    viewMode,
    setViewMode,
    focusedIndex,

    // Selection (multi-select)
    selectedFiles,
    handleToggleSelection,
    handleSelectDown,
    handleSelectUp,
    handleSelectToBoundary,
    handleSelectAll,
    handleClearSelection,
    removeSelectedPaths,
    selectItem,
    toggleItemSelection,
    selectItemFromIcon,
    getItemsByPaths,
    getEffectiveSelection,

    // Computed
    sortedFiles,
    imageFiles,
    directorySearchProvider,

    // Viewer
    viewInfo,
    setViewInfo,
    browserViewerPickerState,

    // Dialog state
    deleteDialogOpen,
    deleteTargets,
    isDeleting,
    renameDialogOpen,
    renameTarget,
    isRenaming,
    renameError,
    createDialogOpen,
    createItemType,
    isCreating,
    createError,
    openInAppLoading,

    // Refs
    parentRef,
    searchInputRef,
    listContainerRef,
    listContainerEl,
    filesRef,
    connectionIdRef,
    currentPathRef,

    // Virtualizer
    rowVirtualizer,

    // Navigation
    handleFileClick,
    handleConnectionChange,
    handleNavigateDown,
    handleArrowUp,
    handleHome,
    handleEnd,
    handlePageDown,
    handlePageUp,
    handleOpenFile,
    handleOpenFileForFile,
    handleOpenFileAtPath,
    openArchive,
    navigateArchiveToPath,
    loadMoreArchive,
    closeArchive,
    navigateToPath,
    handleNavigateUpDirectory,
    handleNavigateUp,
    handleClose,
    handleFocusSearch,
    handleRefresh,
    reloadCurrentLocation,

    // Viewer
    handleViewIndexChange,
    handleViewClose,
    closeBrowserViewerPicker,
    confirmBrowserViewerPicker,

    // CRUD dialogs
    handleDeleteRequest,
    handleDeleteItems,
    handleDeleteConfirm,
    closeDeleteDialog,
    handleDeleteForFile,
    handleRenameRequest,
    handleRenameConfirm,
    handleRenameForFile,
    closeRenameDialog,
    handleNewDirectoryRequest,
    handleNewFileRequest,
    handleCreateConfirm,
    closeCreateDialog,

    // Companion
    handleOpenInApp,
    handleOpenInAppForFile,

    // WebSocket
    handleDirectoryChanged,

    // Cache
    clearCaches,
    invalidateConnectionCache,
    seedDirectorySnapshot,
    applyLocation,
    captureRecoverySnapshot,
    restoreRecoverySnapshot,
  };
}
