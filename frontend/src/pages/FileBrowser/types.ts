//
// types
//

import type { Virtualizer } from "@tanstack/react-virtual";
import type React from "react";
import type { SearchProvider } from "../../components/FileBrowser/search/types";
import type { BrowserHistoryService } from "../../services/browserHistoryService";
import type { BrowserLinkTargetService } from "../../services/browserLinkTargetService";
import type { CompanionPairingErrorKind } from "../../services/localDrivePairing";
import type { StorageBackendRegistry } from "../../services/storageContracts";
import type { Connection, FileEntry, FileType } from "../../types";
import type { ViewerId } from "../../utils/FileTypeRegistry";
import type {
  BrowserItem,
  ContentCapabilities,
  ContentLocation,
  ContentProviderRegistry,
  VirtualContentProviderId,
  VirtualItemHandle,
} from "./contentProviders";

export type SortField = "name" | "size" | "modified" | "type";

export type ViewMode = "list" | "details";
export type BrowserOpenMode = "associated-viewer" | "force-viewer-picker" | "associated-native-app" | "force-native-picker";

// ============================================================================
// Dual-pane types
// ============================================================================

/** Identifies which pane in the dual-pane layout. */
export type PaneId = "left" | "right";

/** Whether the file browser shows one or two panes. */
export type PaneMode = "single" | "dual";

export interface ViewInfo {
  connectionId?: string;
  path: string;
  fileSize?: number;
  fileModifiedAt?: string;
  mimeType: string;
  viewerId?: ViewerId;
  virtualSource?: VirtualItemHandle;
  images?: string[];
  currentIndex?: number;
  sessionId: string;
}

export interface BrowserViewerPickerState {
  connectionId?: string;
  fileName: string;
  filePath: string;
  mimeType: string;
  virtualSource?: VirtualItemHandle;
  virtualActivationId?: number;
  viewerIds: ViewerId[];
  compatibleViewerIds: ViewerId[];
  defaultViewerId: ViewerId | null;
  preferredViewerId: ViewerId | null;
  showNativeOption: boolean;
  saving?: boolean;
  saveError?: string | null;
}

export interface NavigationHistoryEntry {
  focusedIndex: number;
  scrollOffset: number;
  selectedFileName: string | null;
}

export interface DirectoryCacheEntry {
  items: FileEntry[];
  timestamp: number;
}

/** A ZIP directory shown through an ordinary file-browser pane. */
export interface ArchiveLocation {
  providerId: VirtualContentProviderId;
  archivePath: string;
  virtualPath: string;
}

export interface DirectoryChange {
  connectionId: string;
  path: string;
}

export interface FileBrowserPaneRecoverySnapshot {
  connectionId: string;
  path: string;
  archiveLocation?: ArchiveLocation | null;
  items: FileEntry[];
  sortBy: SortField;
  sortDirection: "asc" | "desc";
  viewMode: ViewMode;
  focusedIndex: number;
  focusedFileName: string | null;
  selectedFileNames: string[];
  viewInfo: ViewInfo | null;
  scrollOffset: number;
}

// ============================================================================
// Pane hook configuration & return types
// ============================================================================

// ============================================================================
// localStorage keys
// ============================================================================

/** localStorage key for persisting single/dual pane preference. */
export const DUAL_PANE_STORAGE_KEY = "dual-pane-mode";

/** localStorage key for persisting the last active pane. */
export const ACTIVE_PANE_STORAGE_KEY = "active-pane";

// ============================================================================
// URL query-parameter keys (Phase 3 — URL routing for dual-pane)
// ============================================================================

/** Query parameter encoding right pane's connection-slug/path. */
export const RIGHT_PANE_QUERY_KEY = "p2";

/** Query parameter recording which pane has focus (1 = left, 2 = right). */
export const ACTIVE_PANE_QUERY_KEY = "active";

/** A provider-neutral, read-only location layered on a physical route path. */
export interface VirtualRouteLocation {
  providerId: VirtualContentProviderId;
  sourcePath: string;
  virtualPath: string;
}

// ============================================================================
// Pane hook configuration & return types
// ============================================================================

/** Configuration for the useFileBrowserPane hook. */
export interface UseFileBrowserPaneConfig {
  /** Row height in pixels for the virtualizer (touch: 56, mouse: 40). */
  rowHeight: number;

  /** Available connections so the hook can derive capability state for the selected connection. */
  connections?: Connection[];

  /** Browser-file providers composed at the page boundary. */
  contentProviders: ContentProviderRegistry;

  /** Browser storage target resolver composed at the page boundary. */
  storageRegistry?: StorageBackendRegistry;

  /** Recent-history and directory-navigation service composed at the page boundary. */
  history?: BrowserHistoryService;

  /** Link-target metadata service composed at the page boundary. */
  linkTargets?: BrowserLinkTargetService;

  /**
   * When true, keyboard handlers inside the pane are suppressed.
   * Use this when a global dialog (settings, help) is open.
   */
  disabled?: boolean;

  /**
   * Whether this pane is the currently focused/active pane.
   * When false, the pane suppresses auto-focus on file list changes
   * to avoid stealing focus from the other pane. Defaults to true.
   */
  isActive?: boolean;

  /** Called when the pane wants to show the companion-app hint snackbar. */
  onCompanionHint?: () => void;

  /** Called when the pane should navigate to a different path in the same connection. */
  onNavigatePath?: (path: string) => void;

  /** Called when the pane should switch to a different connection root. */
  onNavigateConnection?: (connectionId: string) => void;

  /** Called when the pane should navigate to a directory in any accessible connection. */
  onNavigateDirectory?: (connectionId: string, path: string) => void;

  /** Called when the pane should navigate into or out of a virtual provider location. */
  onNavigateVirtualLocation?: (location: VirtualRouteLocation | null) => void;

  /** Called when an incoming route resolves to a canonical existing location. */
  onResolveRouteLocation?: (path: string, archiveLocation: ArchiveLocation | null) => void;
}

/** Everything returned by useFileBrowserPane for use by the parent and pane component. */
export interface UseFileBrowserPaneReturn {
  // ── Core State ──────────────────────────────────────────────────────────
  connectionId: string;
  setConnectionId: React.Dispatch<React.SetStateAction<string>>;
  currentPath: string;
  setCurrentPath: React.Dispatch<React.SetStateAction<string>>;
  currentLocation: ContentLocation;
  archiveLocation: ArchiveLocation | null;
  contentCapabilities: ContentCapabilities;
  archiveHasMore: boolean;
  archiveLoadingMore: boolean;
  files: FileEntry[];
  loading: boolean;
  error: string | null;
  setError: React.Dispatch<React.SetStateAction<string | null>>;
  companionPairingError: CompanionPairingErrorKind | null;

  // ── UI Preferences ─────────────────────────────────────────────────────
  sortBy: SortField;
  setSortBy: React.Dispatch<React.SetStateAction<SortField>>;
  sortDirection: "asc" | "desc";
  setSortDirection: React.Dispatch<React.SetStateAction<"asc" | "desc">>;
  viewMode: ViewMode;
  setViewMode: React.Dispatch<React.SetStateAction<ViewMode>>;
  focusedIndex: number;

  // ── Selection State (multi-select) ────────────────────────────────────
  /** Set of canonical file paths currently selected (multi-select). */
  selectedFiles: Set<string>;
  /** Toggle selection of the focused file (Insert / Space). */
  handleToggleSelection: (e?: KeyboardEvent) => void;
  /** Select the focused file and move focus down (Alt+ArrowDown). */
  handleSelectDown: (e?: KeyboardEvent) => void;
  /** Select the focused file and move focus up (Alt+ArrowUp). */
  handleSelectUp: (e?: KeyboardEvent) => void;
  /** Select all files in the current directory (Ctrl+A). */
  handleSelectAll: () => void;
  /** Clear all selections. */
  handleClearSelection: () => void;
  /** Removes canonical paths after a successful source-mutating operation. */
  removeSelectedPaths: (paths: readonly string[]) => void;
  /** Select one file without requiring list focus. */
  selectItem: (file: FileEntry, index: number) => void;
  /** Toggle one file without requiring list focus. */
  toggleItemSelection: (file: FileEntry, index: number) => void;
  selectItemFromIcon: (file: FileEntry, index: number, extend: boolean, additive: boolean) => void;
  /** Resolves canonical file paths to the current operation handles. */
  getItemsByPaths: (paths: readonly string[]) => BrowserItem[];
  /**
   * Returns the effective selection: if files are explicitly selected,
   * returns those; otherwise returns the single focused file.
   */
  getEffectiveSelection: () => BrowserItem[];

  // ── Computed Data ──────────────────────────────────────────────────────
  sortedFiles: FileEntry[];
  imageFiles: string[];
  directorySearchProvider: SearchProvider;

  // ── Viewer State ───────────────────────────────────────────────────────
  viewInfo: ViewInfo | null;
  setViewInfo: React.Dispatch<React.SetStateAction<ViewInfo | null>>;
  browserViewerPickerState: BrowserViewerPickerState | null;

  // ── Dialog State ───────────────────────────────────────────────────────
  deleteDialogOpen: boolean;
  deleteTargets: BrowserItem[];
  isDeleting: boolean;
  renameDialogOpen: boolean;
  renameTarget: BrowserItem | null;
  isRenaming: boolean;
  renameError: string | null;
  createDialogOpen: boolean;
  createItemType: FileType;
  isCreating: boolean;
  createError: string | null;
  openInAppLoading: boolean;

  // ── Refs (needed by parent for WebSocket wiring / shortcut checks) ────
  parentRef: React.RefObject<HTMLDivElement>;
  searchInputRef: React.RefObject<HTMLInputElement>;
  listContainerRef: (node: HTMLDivElement | null) => void;
  listContainerEl: HTMLDivElement | null;
  /** Always-current mirror of sortedFiles for use in callbacks. */
  filesRef: React.MutableRefObject<FileEntry[]>;
  /** Always-current mirror of connectionId for async/WebSocket callbacks. */
  connectionIdRef: React.MutableRefObject<string>;
  /** Always-current mirror of currentPath for async/WebSocket callbacks. */
  currentPathRef: React.MutableRefObject<string>;

  // ── Virtualizer ────────────────────────────────────────────────────────
  rowVirtualizer: Virtualizer<HTMLDivElement, Element>;

  // ── Navigation Handlers ────────────────────────────────────────────────
  handleFileClick: (file: FileEntry, index?: number) => void;
  handleConnectionChange: (connectionId: string) => void;
  handleNavigateDown: (e?: KeyboardEvent) => void;
  handleArrowUp: (e?: KeyboardEvent) => void;
  handleHome: () => void;
  handleEnd: () => void;
  handlePageDown: (e?: KeyboardEvent) => void;
  handlePageUp: (e?: KeyboardEvent) => void;
  handleOpenFile: (options?: { requireListFocus?: boolean; mode?: BrowserOpenMode }) => void;
  handleOpenFileForFile: (file: FileEntry, index: number, mode?: BrowserOpenMode) => void;
  handleOpenFileAtPath: (connectionId: string, path: string, mode?: BrowserOpenMode, recentRecordId?: string) => Promise<void>;
  openArchive: (archivePath: string) => void;
  navigateArchiveToPath: (virtualPath: string) => void;
  loadMoreArchive: () => void;
  closeArchive: () => void;
  navigateToPath: (path: string) => void;
  handleNavigateUpDirectory: () => void;
  handleNavigateUp: () => void;
  handleClose: () => void;
  handleFocusSearch: () => void;
  handleRefresh: () => void;
  reloadCurrentLocation: (options?: { forceRefresh?: boolean; preserveVisibleContent?: boolean }) => Promise<void>;

  // ── Viewer Handlers ────────────────────────────────────────────────────
  handleViewIndexChange: (index: number) => void;
  handleViewClose: () => void;
  closeBrowserViewerPicker: () => void;
  confirmBrowserViewerPicker: (selection: { viewerId: ViewerId | null; rememberSelection: boolean }) => Promise<void>;

  // ── CRUD Dialog Handlers ───────────────────────────────────────────────
  handleDeleteRequest: (options?: { requireListFocus?: boolean }) => void;
  /** Opens the delete dialog for explicitly captured item targets. */
  handleDeleteItems: (items: readonly BrowserItem[]) => void;
  handleDeleteConfirm: () => Promise<void>;
  closeDeleteDialog: () => void;
  handleDeleteForFile: (file: FileEntry, index: number) => void;
  handleRenameRequest: (options?: { requireListFocus?: boolean }) => void;
  handleRenameConfirm: (newName: string) => Promise<void>;
  handleRenameForFile: (file: FileEntry, index: number) => void;
  closeRenameDialog: () => void;
  handleNewDirectoryRequest: () => void;
  handleNewFileRequest: () => void;
  handleCreateConfirm: (name: string) => Promise<void>;
  closeCreateDialog: () => void;

  // ── Companion App ──────────────────────────────────────────────────────
  handleOpenInApp: (options?: { forcePicker?: boolean }) => Promise<void>;
  handleOpenInAppForFile: (file: FileEntry, index: number, options?: { forcePicker?: boolean }) => Promise<void>;

  // ── WebSocket Integration ──────────────────────────────────────────────
  /**
   * Call from the parent's WebSocket onmessage handler when a
   * `directory_changed` event is received.  Invalidates the cache entry
   * and triggers a reload if this pane is viewing the affected directory.
   */
  handleDirectoryChanged: (change: DirectoryChange, options?: { invalidateOnly?: boolean }) => void;

  // ── Cache Management ───────────────────────────────────────────────────
  /** Clear all directory and navigation caches (e.g. on connection switch). */
  clearCaches: () => void;
  /** Invalidate cached entries for a specific connection (e.g. after settings change). */
  invalidateConnectionCache: (targetConnectionId: string) => void;
  /** Seed directory contents and cache from already-known data for a matching connection/path. */
  seedDirectorySnapshot: (connectionId: string, path: string, items: FileEntry[]) => void;
  /** Apply route-driven state from the browser location without triggering navigation again. */
  applyLocation: (connectionId: string, path: string, routeSyncToken?: number) => void;
  /** Capture the current pane UI state for suspend/resume recovery. */
  captureRecoverySnapshot: () => FileBrowserPaneRecoverySnapshot | null;
  /** Restore a previously captured pane UI state without re-running bootstrap logic. */
  restoreRecoverySnapshot: (snapshot: FileBrowserPaneRecoverySnapshot | null) => void;
}
