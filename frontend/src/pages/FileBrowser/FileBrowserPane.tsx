/**
 * FileBrowserPane — Renders a single file browser pane
 * =====================================================
 *
 * Displays the per-pane UI: breadcrumbs, view/sort controls, file list,
 * and CRUD dialogs. Used by the parent Browser component
 * both in single-pane and dual-pane layouts.
 *
 * In dual-pane mode, the active pane gets a visual accent border and
 * the inactive pane is slightly dimmed. Clicking an inactive pane
 * makes it active.
 *
 * @see useFileBrowserPane — provides all pane state and handlers
 * @see FileBrowser — the parent page-level orchestrator
 */

import BlockOutlinedIcon from "@mui/icons-material/BlockOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import SearchIcon from "@mui/icons-material/Search";
import { alpha, Box, Button, CircularProgress, LinearProgress, Typography, useTheme } from "@mui/material";
import React, { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { CompactBadge as Chip } from "../../components/CompactBadge";
import { AbbreviatedPathLabel } from "../../components/FileBrowser/AbbreviatedPathLabel";
import { BreadcrumbsNavigation } from "../../components/FileBrowser/BreadcrumbsNavigation";
import { BrowserViewerPicker } from "../../components/FileBrowser/BrowserViewerPicker";
import { CompactCreateMenu } from "../../components/FileBrowser/CompactCreateMenu";
import type { CompactItemAction } from "../../components/FileBrowser/CompactItemActionsMenu";
import { CompactSelectionActions } from "../../components/FileBrowser/CompactSelectionActions";
import ConfirmDeleteDialog from "../../components/FileBrowser/ConfirmDeleteDialog";
import CreateItemDialog from "../../components/FileBrowser/CreateItemDialog";
import { FileBrowserAlerts } from "../../components/FileBrowser/FileBrowserAlerts";
import { FileList } from "../../components/FileBrowser/FileList";
import { formatConnectionPath } from "../../components/FileBrowser/formatConnectionPath";
import { PaneTabBar } from "../../components/FileBrowser/PaneTabBar";
import RenameDialog from "../../components/FileBrowser/RenameDialog";
import { STATUS_BAR_HEIGHT } from "../../components/FileBrowser/StatusBar";
import { formatNoticeTarget, OperationNotifications } from "../../components/OperationNotifications";
import { PANE_SHORTCUTS } from "../../config/keyboardShortcuts";
import {
  formatShortcut,
  isEventInKeyboardShortcutScope,
  KeyboardShortcutScopeContext,
  matchesKeyboardShortcut,
} from "../../hooks/useKeyboardShortcuts";
import { DRAFT_RECOVERY_CHANGED_EVENT, getUnsavedDraftsForConnection } from "../../services/draftRecovery";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import type { Connection, FileEntry } from "../../types";
import { FileType } from "../../types";
import { getFileRowIdentity } from "../../utils/fileEntries";
import { isConnectionReadOnly } from "./access";
import type { BrowserItem } from "./contentProviders";
import type { FileOperationAction, FileOperationPolicyContext } from "./fileOperationActions";
import { getPaneTabLabel } from "./tabSessions";
import type { PaneId, PaneMode, UseFileBrowserPaneReturn } from "./types";

const PANE_PROGRESS_DELAY_MS = 200;

// ============================================================================
// Props
// ============================================================================

export interface FileBrowserPaneProps {
  /** The pane hook return value containing all pane state and handlers. */
  pane: UseFileBrowserPaneReturn;

  /** Which pane this is (left or right). */
  paneId: PaneId;

  /** Whether this pane is the currently active/focused pane. */
  isActive: boolean;

  /** Current layout mode (single or dual). */
  paneMode: PaneMode;

  /** Available SMB connections. */
  connections: Connection[];

  /** Whether the UI is in mobile/compact layout. */
  useCompactLayout: boolean;
  /** Whether touch-friendly file selection controls are available. */
  useTouchSelectionControls?: boolean;
  /** Whether touch-sized tab controls and always-visible close overlays are active. */
  useTouchTabControls?: boolean;
  /** Whether another page-owned surface currently owns interaction. */
  compactActionsDisabled?: boolean;

  /** Whether the user is navigating with keyboard (for focus indicators). */
  isUsingKeyboard: boolean;

  /** Called when the user clicks on this pane to make it active. */
  onPaneFocus: () => void;

  /** Pointer/command callback to select a tab in this pane. */
  onSelectTab?: (tabId: string) => void;
  /** Pointer callback to close a tab in this pane. */
  onCloseTab?: (tabId: string) => void;
  /** Pointer/keyboard callback to create a new tab in this pane. */
  onCreateTab?: () => void;
  /** Keyboard callback to close the selected tab (with last-tab protection announcement). */
  onCloseSelectedTabFromKeyboard?: () => void;
  /** Keyboard callback to switch to the preceding or following tab in this pane. */
  onSelectAdjacentTab?: (direction: "previous" | "next") => void;
  /** Restores focus to the workspace's active file list if focus strayed onto a non-focusable control. */
  onRestoreActiveListFocus?: () => void;

  /** Remove interactive controls from Tab order (dual-pane mode uses Tab for pane switching). */
  disableTabFocus?: boolean;

  /** Builds creation actions for an immutable pane context. */
  getCompactCreateActions?: (context: FileOperationPolicyContext) => readonly FileOperationAction[];
  /** Builds row actions for an immutable item context. */
  getCompactItemActions?: (context: FileOperationPolicyContext) => readonly CompactItemAction[];
  /** Builds bulk actions for an immutable selection context. */
  getCompactSelectionActions?: (context: FileOperationPolicyContext) => readonly FileOperationAction[];
  dropTargetLabel?: string;
  dropUnavailableReason?: string | null;
  onFileDrop?: (event: React.DragEvent<HTMLElement>) => void;
  onOpenLocalDrivesSettings?: () => void;
  onReload?: () => void;
}

// ============================================================================
// Component
// ============================================================================

export const FileBrowserPane: React.FC<FileBrowserPaneProps> = ({
  pane,
  paneId,
  isActive,
  paneMode,
  connections,
  useCompactLayout,
  useTouchSelectionControls = useCompactLayout,
  useTouchTabControls = false,
  compactActionsDisabled = false,
  isUsingKeyboard,
  onPaneFocus,
  onSelectTab,
  onCloseTab,
  onCreateTab,
  onCloseSelectedTabFromKeyboard,
  onSelectAdjacentTab,
  onRestoreActiveListFocus,
  disableTabFocus: _disableTabFocus,
  getCompactCreateActions,
  getCompactItemActions,
  getCompactSelectionActions,
  dropTargetLabel,
  dropUnavailableReason,
  onFileDrop,
  onOpenLocalDrivesSettings,
  onReload,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
  const shortcutScope = useContext(KeyboardShortcutScopeContext);
  const isDualMode = paneMode === "dual";
  const [fileDragActive, setFileDragActive] = useState(false);
  const dragDepthRef = useRef(0);
  const dragLocationRef = useRef("");

  useEffect(() => {
    const clearDrag = () => {
      dragDepthRef.current = 0;
      setFileDragActive(false);
    };
    const onEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearDrag();
    };
    const onWindowLeave = (event: DragEvent) => {
      if (!event.relatedTarget) clearDrag();
    };
    window.addEventListener("dragend", clearDrag);
    window.addEventListener("drop", clearDrag);
    window.addEventListener("dragleave", onWindowLeave);
    window.addEventListener("keydown", onEscape);
    return () => {
      window.removeEventListener("dragend", clearDrag);
      window.removeEventListener("drop", clearDrag);
      window.removeEventListener("dragleave", onWindowLeave);
      window.removeEventListener("keydown", onEscape);
    };
  }, []);

  /** Only show the selection highlight on the focused row when this pane is active. */
  const showSelectionHighlight = !isDualMode || isActive;

  const {
    connectionId,
    currentPath,
    archiveLocation,
    error,
    loading,
    navigationPending,
    viewMode,
    focusedIndex,
    selectedFiles,
    sortedFiles,
    viewInfo,
    // Dialogs
    browserViewerPickerState,
    deleteDialogOpen,
    deleteTargets = [],
    isDeleting,
    renameDialogOpen,
    renameTarget,
    isRenaming,
    renameError,
    createDialogOpen,
    createItemType,
    isCreating,
    createError,
    // Refs
    parentRef,
    listContainerRef,
    listContainerEl,
    // Virtualizer
    rowVirtualizer,
    // Handlers
    handleFileClick,
    toggleItemSelection,
    selectItemFromIcon,
    selectItem,
    handleClearSelection,
    getItemsByPaths,
    closeDeleteDialog,
    handleDeleteConfirm,
    closeRenameDialog,
    handleRenameConfirm,
    closeCreateDialog,
    handleCreateConfirm,
    closeBrowserViewerPicker,
    confirmBrowserViewerPicker,
  } = pane;
  const runningSearchId = pane.searchSession?.status === "running" ? pane.searchSession.id : undefined;
  const pendingProgressKey = runningSearchId ? `search:${runningSearchId}` : navigationPending ? "navigation" : null;
  const [visibleProgressKey, setVisibleProgressKey] = useState<string | null>(null);

  useEffect(() => {
    setVisibleProgressKey(null);
    if (!pendingProgressKey) return;
    const timer = window.setTimeout(() => setVisibleProgressKey(pendingProgressKey), PANE_PROGRESS_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [pendingProgressKey]);

  useEffect(() => {
    const location = `${connectionId}:${currentPath}`;
    if (dragLocationRef.current === location) return;
    dragLocationRef.current = location;
    dragDepthRef.current = 0;
    setFileDragActive(false);
  }, [connectionId, currentPath]);

  const currentConnection = useMemo(() => connections.find((connection) => connection.id === connectionId), [connections, connectionId]);
  const [unsavedDraftPaths, setUnsavedDraftPaths] = React.useState<Set<string>>(new Set());

  React.useEffect(() => {
    const refreshDraftPaths = () => {
      setUnsavedDraftPaths(new Set(getUnsavedDraftsForConnection(connectionId).map((draft) => draft.path)));
    };

    refreshDraftPaths();
    window.addEventListener(DRAFT_RECOVERY_CHANGED_EVENT, refreshDraftPaths);
    return () => {
      window.removeEventListener(DRAFT_RECOVERY_CHANGED_EVENT, refreshDraftPaths);
    };
  }, [connectionId]);

  // Connection display name for breadcrumbs
  const connectionName = currentConnection?.name ?? "";
  const connectionIsReadOnly = isConnectionReadOnly(currentConnection);
  const [closingBrowserViewerPickerState, setClosingBrowserViewerPickerState] = React.useState<typeof browserViewerPickerState>(null);
  const [liveAnnouncement, setLiveAnnouncement] = React.useState("");
  const previousSelectedCountRef = React.useRef(selectedFiles.size);
  const previousAnnouncedTabIdRef = React.useRef<string>(pane.selectedTabId);
  const renderedBrowserViewerPickerState = browserViewerPickerState ?? closingBrowserViewerPickerState;
  const listInstructionsId = `${paneId}-file-list-tab-instructions`;
  const tabInstructionsText = useMemo(
    () =>
      t("fileBrowser.tabs.listInstructions", {
        newTabShortcut: formatShortcut(PANE_SHORTCUTS.NEW_TAB),
        closeTabShortcut: formatShortcut(PANE_SHORTCUTS.CLOSE_TAB),
      }),
    [t]
  );

  React.useEffect(() => {
    if (previousAnnouncedTabIdRef.current === pane.selectedTabId) {
      return;
    }
    previousAnnouncedTabIdRef.current = pane.selectedTabId;
    const selectedIndex = pane.tabs.findIndex((candidate) => candidate.id === pane.selectedTabId);
    const selectedTab = selectedIndex >= 0 ? pane.tabs[selectedIndex] : undefined;
    if (!selectedTab) {
      return;
    }
    const tabConnectionName = connections.find((conn) => conn.id === selectedTab.connectionId)?.name ?? selectedTab.connectionId;
    const tabLabel = getPaneTabLabel(selectedTab, tabConnectionName);
    setLiveAnnouncement(
      t("fileBrowser.tabs.selectedAnnouncement", {
        name: tabLabel,
        index: selectedIndex + 1,
        total: pane.tabs.length,
      })
    );
  }, [connections, pane.selectedTabId, pane.tabs, t]);

  const handleCompactClearSelection = React.useCallback(() => {
    handleClearSelection();
  }, [handleClearSelection]);
  React.useEffect(() => {
    if (selectedFiles.size > 0) {
      setLiveAnnouncement(t("fileBrowser.compactActions.selectedCount", { count: selectedFiles.size }));
    } else if (previousSelectedCountRef.current > 0) {
      setLiveAnnouncement(t("fileBrowser.compactActions.selectionCleared"));
    }
    previousSelectedCountRef.current = selectedFiles.size;
  }, [selectedFiles.size, t]);
  const getCompactActionsContext = React.useCallback(
    (items: readonly BrowserItem[], focusedItem?: BrowserItem): FileOperationPolicyContext => ({ paneId, items, focusedItem }),
    [paneId]
  );
  const compactCreateActions = useMemo(
    () => getCompactCreateActions?.(getCompactActionsContext([])) ?? [],
    [getCompactActionsContext, getCompactCreateActions]
  );
  const getCompactItemActionsForFile = React.useCallback(
    (file: FileEntry) => {
      const item = getItemsByPaths([getFileRowIdentity(file)])[0];
      return item ? (getCompactItemActions?.(getCompactActionsContext([item], item)) ?? []) : [];
    },
    [getCompactActionsContext, getCompactItemActions, getItemsByPaths]
  );
  const getCompactSelectionActionsForMenu = React.useCallback(() => {
    const items = getItemsByPaths([...selectedFiles]);
    return getCompactSelectionActions?.(getCompactActionsContext(items, items[0])) ?? [];
  }, [getCompactActionsContext, getCompactSelectionActions, getItemsByPaths, selectedFiles]);
  const compactOverlay =
    !compactActionsDisabled &&
    !viewInfo &&
    !renderedBrowserViewerPickerState &&
    !deleteDialogOpen &&
    !renameDialogOpen &&
    !createDialogOpen ? (
      selectedFiles.size > 0 && useTouchSelectionControls ? (
        <CompactSelectionActions
          actions={getCompactSelectionActionsForMenu()}
          getActions={getCompactSelectionActionsForMenu}
          selectedCount={selectedFiles.size}
          onClearSelection={handleCompactClearSelection}
        />
      ) : useCompactLayout ? (
        <CompactCreateMenu actions={compactCreateActions} />
      ) : undefined
    ) : undefined;
  const compactOverlayLayout = selectedFiles.size > 0 ? "dock" : "floating";

  // ──────────────────────────────────────────────────────────────────────────
  // File Row Styles — depend on isUsingKeyboard (global) and theme
  // ──────────────────────────────────────────────────────────────────────────

  const fileRowStyles = useMemo(
    () => ({
      iconBox: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        width: useCompactLayout ? COMPACT_LAYOUT_SIZE.FILE_ROW_ICON_PX : 24,
        flexShrink: 0,
      },
      contentBox: {
        flex: 1,
        minWidth: 0,
      },
      buttonSelected: {
        display: "flex",
        alignItems: "center",
        gap: 1,
        height: "100%",
        px: 2,
        py: 1.5,
        cursor: "pointer",
        userSelect: "none",
        transition: "background-color 80ms ease-out",
        background: isUsingKeyboard && showSelectionHighlight ? theme.palette.action.selected : "transparent",
        "&:hover": {
          backgroundColor: isUsingKeyboard && showSelectionHighlight ? theme.palette.action.selected : "transparent",
        },
        "&:active": {
          backgroundColor: isUsingKeyboard && showSelectionHighlight ? theme.palette.action.selected : "transparent",
        },
      },
      buttonNotSelected: {
        display: "flex",
        alignItems: "center",
        gap: 1,
        height: "100%",
        px: 2,
        py: 1.5,
        cursor: "pointer",
        userSelect: "none",
        background: "transparent",
        transition: "background-color 80ms ease-out",
        "&:hover": {
          backgroundColor: isUsingKeyboard ? theme.palette.action.selected : "transparent",
        },
        "&:active": {
          backgroundColor: isUsingKeyboard ? theme.palette.action.selected : "transparent",
        },
      },
      buttonMultiSelected: {
        display: "flex",
        alignItems: "center",
        gap: 1,
        height: "100%",
        px: 2,
        py: 1.5,
        cursor: "pointer",
        userSelect: "none",
        transition: "background-color 80ms ease-out",
        background: alpha(theme.palette.primary.main, 0.16),
        color: theme.palette.primary.main,
        "&:hover": {
          backgroundColor: alpha(theme.palette.primary.main, 0.22),
        },
        "&:active": {
          backgroundColor: alpha(theme.palette.primary.main, 0.22),
        },
      },
      buttonFocusedMultiSelected: {
        display: "flex",
        alignItems: "center",
        gap: 1,
        height: "100%",
        px: 2,
        py: 1.5,
        cursor: "pointer",
        userSelect: "none",
        transition: "background-color 80ms ease-out",
        background:
          isUsingKeyboard && showSelectionHighlight ? alpha(theme.palette.primary.main, 0.26) : alpha(theme.palette.primary.main, 0.16),
        color: theme.palette.primary.main,
        "&:hover": {
          backgroundColor: alpha(theme.palette.primary.main, 0.26),
        },
        "&:active": {
          backgroundColor: alpha(theme.palette.primary.main, 0.26),
        },
      },
    }),
    [theme, isUsingKeyboard, showSelectionHighlight, useCompactLayout]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Pane container styles
  // ──────────────────────────────────────────────────────────────────────────

  const paneContainerSx = useMemo(() => {
    const base: Record<string, unknown> = {
      display: "flex",
      flexDirection: "column",
      flex: 1,
      minWidth: 0,
      overflow: "hidden",
    };

    if (isDualMode && !isActive) {
      base["cursor"] = "pointer";
    }

    return base;
  }, [isDualMode, isActive]);

  // ──────────────────────────────────────────────────────────────────────────
  // Event Handlers
  // ──────────────────────────────────────────────────────────────────────────

  /** Handle click on the pane container — makes this pane active. */
  const handlePaneClick = React.useCallback(() => {
    if (!isActive) {
      onPaneFocus();
    }
  }, [isActive, onPaneFocus]);

  const handlePaneFocus = React.useCallback(() => {
    if (!isActive) {
      onPaneFocus();
    }
  }, [isActive, onPaneFocus]);

  const handleCloseBrowserViewerPicker = React.useCallback(() => {
    setClosingBrowserViewerPickerState(browserViewerPickerState);
    closeBrowserViewerPicker();
  }, [browserViewerPickerState, closeBrowserViewerPicker]);

  const handleBrowserViewerPickerExited = React.useCallback(() => {
    setClosingBrowserViewerPickerState(null);
    listContainerEl?.focus({ preventScroll: true });
  }, [listContainerEl]);

  const handleFileOperationDialogExited = React.useCallback(() => {
    if (!useCompactLayout) {
      listContainerEl?.focus({ preventScroll: true });
    }
  }, [listContainerEl, useCompactLayout]);

  /** Navigate to a breadcrumb path segment and return focus to this pane's file list. */
  const handleBreadcrumbNavigate = React.useCallback(
    (path: string) => {
      if (archiveLocation) {
        if (path === archiveLocation.archivePath) {
          pane.navigateArchiveToPath("");
          pane.requestListFocus();
          return;
        }
        const archivePrefix = `${archiveLocation.archivePath}/`;
        if (path.startsWith(archivePrefix)) {
          pane.navigateArchiveToPath(path.slice(archivePrefix.length));
          pane.requestListFocus();
          return;
        }
      }
      pane.navigateToPath(path);
      pane.requestListFocus();
    },
    [archiveLocation, pane]
  );

  const restoreOwnOrActiveListFocus = React.useCallback(() => {
    if (onRestoreActiveListFocus) {
      onRestoreActiveListFocus();
      return;
    }
    listContainerEl?.focus({ preventScroll: true });
  }, [listContainerEl, onRestoreActiveListFocus]);

  const handleSelectTabClick = React.useCallback(
    (tabId: string) => {
      if (onSelectTab) {
        onSelectTab(tabId);
        return;
      }
      pane.selectTab(tabId, { focusList: true });
    },
    [onSelectTab, pane]
  );

  const handleCloseTabClick = React.useCallback(
    (tabId: string) => {
      if (onCloseTab) {
        onCloseTab(tabId);
        return;
      }
      pane.closeTab(tabId, { focusList: tabId === pane.selectedTabId });
    },
    [onCloseTab, pane]
  );

  const handleCreateTabClick = React.useCallback(() => {
    if (onCreateTab) {
      onCreateTab();
      return;
    }
    pane.createTab({ focusList: true });
  }, [onCreateTab, pane]);

  const tabsBlocked =
    compactActionsDisabled ||
    Boolean(viewInfo) ||
    Boolean(renderedBrowserViewerPickerState) ||
    deleteDialogOpen ||
    renameDialogOpen ||
    createDialogOpen;

  const handleListSurfaceKeyDown = React.useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (!isActive || tabsBlocked) {
        return;
      }
      const nativeEvent = event.nativeEvent;
      if (!isEventInKeyboardShortcutScope(nativeEvent, shortcutScope)) {
        return;
      }
      if (event.target !== event.currentTarget || document.activeElement !== listContainerEl) {
        return;
      }

      if (matchesKeyboardShortcut(nativeEvent, PANE_SHORTCUTS.PREVIOUS_TAB)) {
        event.preventDefault();
        if (onSelectAdjacentTab) {
          onSelectAdjacentTab("previous");
        } else {
          pane.selectAdjacentTab("previous", { focusList: true });
        }
        return;
      }

      if (matchesKeyboardShortcut(nativeEvent, PANE_SHORTCUTS.NEXT_TAB)) {
        event.preventDefault();
        if (onSelectAdjacentTab) {
          onSelectAdjacentTab("next");
        } else {
          pane.selectAdjacentTab("next", { focusList: true });
        }
        return;
      }

      if (matchesKeyboardShortcut(nativeEvent, PANE_SHORTCUTS.NEW_TAB)) {
        event.preventDefault();
        if (!nativeEvent.repeat) {
          handleCreateTabClick();
        }
        return;
      }

      if (matchesKeyboardShortcut(nativeEvent, PANE_SHORTCUTS.CLOSE_TAB)) {
        event.preventDefault();
        if (!nativeEvent.repeat) {
          if (onCloseSelectedTabFromKeyboard) {
            onCloseSelectedTabFromKeyboard();
          } else {
            pane.closeTab(pane.selectedTabId, { focusList: true });
          }
        }
      }
    },
    [handleCreateTabClick, isActive, listContainerEl, onCloseSelectedTabFromKeyboard, onSelectAdjacentTab, pane, shortcutScope, tabsBlocked]
  );

  const breadcrumbPath = archiveLocation
    ? [archiveLocation.archivePath, archiveLocation.virtualPath].filter(Boolean).join("/")
    : currentPath;
  const searchRequest = pane.searchSession?.request;
  const searchStartPath = searchRequest
    ? formatConnectionPath(
        connections.find(({ id }) => id === searchRequest.source.id)?.name ?? searchRequest.source.id,
        searchRequest.root.kind === "archive"
          ? [searchRequest.root.path, searchRequest.root.member_path].filter(Boolean).join("/")
          : searchRequest.root.path
      )
    : null;

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  if (!connectionId) return null;

  return (
    <Box
      data-pane-id={paneId}
      sx={[paneContainerSx, { position: "relative" }]}
      onClick={handlePaneClick}
      onFocusCapture={handlePaneFocus}
      onKeyDown={undefined}
    >
      <OperationNotifications
        suppressed={Boolean(pane.directoryUnavailable)}
        notices={[
          ...(pane.notification
            ? [
                {
                  ...pane.notification,
                  id: `${paneId}:${pane.notification.id}`,
                  action: pane.companionPairingError ? (
                    <>
                      {pane.companionPairingError === "signature" && (
                        <Button color="inherit" onClick={onReload}>
                          {t("settings.localDrives.reloadButton")}
                        </Button>
                      )}
                      <Button color="inherit" onClick={onOpenLocalDrivesSettings}>
                        {t("settings.localDrives.headerTitle")}
                      </Button>
                    </>
                  ) : undefined,
                  onRetry: pane.companionPairingError ? undefined : pane.notification.onRetry,
                },
              ]
            : []),
          ...(pane.directoryMonitorError
            ? [
                {
                  id: `${paneId}:monitor`,
                  message: pane.directoryMonitorErrorSummary ?? pane.directoryMonitorError,
                  occurrence: pane.directoryMonitorErrorOccurrence,
                  severity: "warning" as const,
                  failureKey: JSON.stringify([connectionId, currentPath]),
                  targetLabel: formatNoticeTarget(connectionName, currentPath),
                  onRetry: pane.handleRefresh,
                },
              ]
            : []),
        ]}
        onDismiss={pane.dismissNotification}
      />
      <OperationNotifications
        notices={(pane.searchNotifications ?? []).map((notice) => ({
          ...notice,
          action:
            notice.requiresCompanionUpdate && onOpenLocalDrivesSettings ? (
              <Button color="inherit" onClick={onOpenLocalDrivesSettings}>
                {t("fileBrowser.search.live.companionUpdateAction")}
              </Button>
            ) : undefined,
        }))}
      />
      <Box
        aria-live="polite"
        aria-atomic="true"
        sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}
      >
        {pane.searchAnnouncement}
      </Box>
      <Box
        aria-live="polite"
        aria-atomic="true"
        data-testid={`pane-tab-live-region-${paneId}`}
        sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}
      >
        {liveAnnouncement}
      </Box>
      <Box
        id={listInstructionsId}
        sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}
      >
        {tabInstructionsText}
      </Box>

      {/* Per-pane folder tab bar */}
      <PaneTabBar
        paneId={paneId}
        paneMode={paneMode}
        isActivePane={isActive}
        tabs={pane.tabs}
        selectedTabId={pane.selectedTabId}
        tabRevealToken={pane.tabRevealToken}
        connections={connections}
        useTouchControls={useTouchTabControls}
        disabled={tabsBlocked}
        onSelectTab={handleSelectTabClick}
        onCloseTab={handleCloseTabClick}
        onCreateTab={handleCreateTabClick}
        onRestoreFocus={restoreOwnOrActiveListFocus}
      />

      {/* Breadcrumbs row (available in all layouts below the tab bar) */}
      <Box
        data-testid="pane-context-row"
        sx={{
          mb: useCompactLayout ? 0.5 : 1.5,
          mt: 0.5,
          px: 2,
          height: useCompactLayout ? 28 : STATUS_BAR_HEIGHT,
          flexShrink: 0,
          boxSizing: "border-box",
          display: "flex",
          alignItems: "center",
        }}
      >
        {pane.isSearchTab ? (
          searchRequest &&
          searchStartPath && (
            <Box sx={{ display: "flex", alignItems: "center", gap: 1, flex: 1, minWidth: 0, color: "text.secondary" }}>
              <SearchIcon fontSize="small" aria-hidden="true" sx={{ flexShrink: 0 }} />
              <Typography variant="body2" component="div" sx={{ display: "flex", alignItems: "baseline", gap: 0.5, flex: 1, minWidth: 0 }}>
                <Trans
                  i18nKey="fileBrowser.search.live.queryContext"
                  components={{
                    term: (
                      <Box
                        component="span"
                        title={searchRequest.query}
                        sx={{ maxWidth: "55%", minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
                      />
                    ),
                    query: (
                      <Box component="bdi" dir="auto" sx={{ color: "text.primary", fontWeight: 500 }}>
                        {searchRequest.query}
                      </Box>
                    ),
                    path: (
                      <Box component="span" sx={{ flex: "1 1 0", minWidth: 0 }}>
                        <AbbreviatedPathLabel path={searchStartPath} />
                      </Box>
                    ),
                  }}
                />
              </Typography>
            </Box>
          )
        ) : (
          <BreadcrumbsNavigation
            currentPath={breadcrumbPath}
            connectionName={connectionName}
            onNavigate={handleBreadcrumbNavigate}
            onRestoreListFocus={() => pane.requestListFocus()}
            showActiveIndicator={isDualMode && isActive}
          />
        )}
        {!useCompactLayout && connectionIsReadOnly && (
          <Chip
            size="small"
            variant="outlined"
            color="warning"
            label={t("settings.connectionDialog.accessMode.readOnlyLabel")}
            title={t("settings.connectionDialog.helpers.accessModeReadOnly")}
            sx={{ ml: 1, flexShrink: 0 }}
          />
        )}
        {pane.directoryMonitorError && !pane.isSearchTab && (
          <Button size="small" onClick={pane.handleRefresh} sx={{ ml: "auto", flexShrink: 0, whiteSpace: "nowrap" }}>
            {t("common.actions.monitoringStopped")}
          </Button>
        )}
      </Box>

      {useCompactLayout && connectionIsReadOnly && (
        <Box sx={{ px: 2, pb: 1 }}>
          <Chip
            size="small"
            variant="outlined"
            color="warning"
            label={t("settings.connectionDialog.accessMode.readOnlyLabel")}
            title={t("settings.connectionDialog.helpers.accessModeReadOnly")}
          />
        </Box>
      )}

      {/* File list or loading indicator */}
      {loading ? (
        <Box
          ref={listContainerRef}
          data-testid="file-list-container"
          aria-describedby={listInstructionsId}
          tabIndex={0}
          onKeyDown={handleListSurfaceKeyDown}
          sx={{
            display: "flex",
            justifyContent: "center",
            alignItems: "flex-start",
            p: 4,
            flex: 1,
            minHeight: 0,
            "&:focus": { outline: "none" },
          }}
        >
          <CircularProgress />
        </Box>
      ) : pane.directoryUnavailable && pane.error ? (
        <Box
          ref={listContainerRef}
          data-testid="file-list-container"
          aria-describedby={listInstructionsId}
          tabIndex={0}
          onKeyDown={handleListSurfaceKeyDown}
          sx={{
            flex: 1,
            minHeight: 0,
            overflow: "auto",
            "&:focus": { outline: "none" },
          }}
        >
          <FileBrowserAlerts
            error={pane.error}
            companionPairingError={pane.companionPairingError}
            onOpenLocalDrivesSettings={onOpenLocalDrivesSettings}
            onReload={onReload}
            onRetry={pane.handleRefresh}
            loadingConnections={false}
            connectionsCount={connections.length}
            backendAvailabilityStatus="available"
          />
        </Box>
      ) : (
        <Box
          aria-busy={pendingProgressKey !== null}
          onDragEnter={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            dragDepthRef.current++;
            setFileDragActive(true);
          }}
          onDragOver={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = dropUnavailableReason ? "none" : "copy";
          }}
          onDragLeave={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
            if (dragDepthRef.current === 0 || !event.relatedTarget) setFileDragActive(false);
          }}
          onDrop={(event) => {
            if (!Array.from(event.dataTransfer.types).includes("Files")) return;
            event.preventDefault();
            event.stopPropagation();
            dragDepthRef.current = 0;
            setFileDragActive(false);
            onFileDrop?.(event);
          }}
          sx={{
            display: "flex",
            gap: 2,
            flex: 1,
            minHeight: 0,
            mb: 0,
            flexDirection: "column",
            ...(pane.isSearchTab ? { containerType: "inline-size", containerName: "search-results" } : {}),
            position: "relative",
            outline: fileDragActive && !dropUnavailableReason ? `2px solid ${theme.palette.primary.main}` : undefined,
            outlineOffset: -2,
          }}
        >
          {pendingProgressKey && visibleProgressKey === pendingProgressKey && (
            <LinearProgress
              aria-label={runningSearchId ? t("fileBrowser.search.live.running") : t("app.loading")}
              sx={{ position: "absolute", top: 0, insetInline: 0, zIndex: 1, pointerEvents: "none" }}
            />
          )}
          {fileDragActive && (
            <Box
              role="status"
              aria-label={dropUnavailableReason ?? [t("fileBrowser.transfers.dropToUpload"), dropTargetLabel].filter(Boolean).join(" ")}
              sx={{
                position: "absolute",
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%)",
                zIndex: 2,
                pointerEvents: "none",
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 1,
                width: "min(280px, calc(100% - 32px))",
                minHeight: 116,
                px: 2,
                py: 2,
                borderRadius: 1,
                bgcolor: dropUnavailableReason
                  ? theme.palette.background.paper
                  : theme.palette.mode === "dark"
                    ? theme.palette.grey[800]
                    : theme.palette.text.primary,
                color: dropUnavailableReason
                  ? theme.palette.text.primary
                  : theme.palette.mode === "dark"
                    ? theme.palette.text.primary
                    : theme.palette.background.paper,
                boxShadow: theme.shadows[8],
                border: dropUnavailableReason ? `1px solid ${theme.palette.divider}` : undefined,
                textAlign: "center",
              }}
            >
              {dropUnavailableReason ? (
                <BlockOutlinedIcon aria-hidden="true" sx={{ fontSize: 32, color: "text.secondary" }} />
              ) : (
                <CloudUploadOutlinedIcon aria-hidden="true" sx={{ fontSize: 32, color: "primary.main" }} />
              )}
              <Typography sx={{ fontSize: "1rem", fontWeight: 600, lineHeight: 1.35 }}>
                {dropUnavailableReason ?? t("fileBrowser.transfers.dropToUpload")}
              </Typography>
            </Box>
          )}
          <FileList
            files={sortedFiles}
            showEmptyState={!pane.isSearchTab && error === null}
            useCompactLayout={useCompactLayout}
            useTouchSelectionControls={useTouchSelectionControls}
            compactOverlay={compactOverlay}
            compactOverlayLayout={compactOverlay ? compactOverlayLayout : undefined}
            focusedIndex={focusedIndex}
            selectedFiles={selectedFiles}
            onFileClick={handleFileClick}
            onToggleItemSelection={toggleItemSelection}
            onSelectItem={selectItem}
            onIconClick={useTouchSelectionControls ? undefined : selectItemFromIcon}
            onClearSelection={handleClearSelection}
            rowVirtualizer={rowVirtualizer}
            parentRef={parentRef}
            listContainerRef={listContainerRef}
            fileRowStyles={fileRowStyles}
            viewMode={viewMode}
            unsavedDraftPaths={unsavedDraftPaths}
            getCompactItemActions={getCompactItemActionsForFile}
            ariaDescribedBy={listInstructionsId}
            onKeyDown={handleListSurfaceKeyDown}
          />
          {pane.isSearchTab &&
            pane.searchSession?.status === "finished" &&
            pane.searchSession.terminal?.reason === "complete" &&
            pane.searchSession.terminal.counts.skipped === 0 &&
            pane.searchSession.terminal.skips.length === 0 &&
            pane.searchSession.rows.length === 0 && (
              <Typography
                sx={{ position: "absolute", inset: 0, pt: 4, textAlign: "center", pointerEvents: "none", color: "text.secondary" }}
              >
                {t("fileBrowser.search.live.noMatches")}
              </Typography>
            )}
        </Box>
      )}

      {renderedBrowserViewerPickerState ? (
        <BrowserViewerPicker
          open={browserViewerPickerState !== null}
          fileName={renderedBrowserViewerPickerState.fileName}
          viewerIds={renderedBrowserViewerPickerState.viewerIds}
          defaultViewerId={renderedBrowserViewerPickerState.defaultViewerId}
          preferredViewerId={renderedBrowserViewerPickerState.preferredViewerId}
          showNativeOption={renderedBrowserViewerPickerState.showNativeOption}
          saving={renderedBrowserViewerPickerState.saving ?? false}
          saveError={renderedBrowserViewerPickerState.saveError ?? null}
          onClose={handleCloseBrowserViewerPicker}
          onTransitionExited={handleBrowserViewerPickerExited}
          onConfirm={(selection) => {
            void confirmBrowserViewerPicker(selection);
          }}
          onOpenWithoutSaving={({ viewerId }) => {
            void confirmBrowserViewerPicker({ viewerId, rememberSelection: false });
          }}
        />
      ) : null}

      {/* Delete Confirmation Dialog */}
      <ConfirmDeleteDialog
        open={deleteDialogOpen}
        items={deleteTargets.map((item) => item.entry)}
        isDeleting={isDeleting}
        onClose={closeDeleteDialog}
        onConfirm={handleDeleteConfirm}
        disableRestoreFocus={!useCompactLayout}
        onTransitionExited={handleFileOperationDialogExited}
      />

      {/* Rename Dialog */}
      <RenameDialog
        open={renameDialogOpen}
        itemName={renameTarget?.entry.name ?? ""}
        itemType={renameTarget?.entry.type ?? FileType.FILE}
        isRenaming={isRenaming}
        apiError={renameError}
        onClose={closeRenameDialog}
        onConfirm={handleRenameConfirm}
        disableRestoreFocus={!useCompactLayout}
        onTransitionExited={handleFileOperationDialogExited}
      />

      {/* Create Item Dialog */}
      <CreateItemDialog
        open={createDialogOpen}
        itemType={createItemType}
        targetConnectionName={connectionName}
        targetPath={currentPath}
        isCreating={isCreating}
        apiError={createError}
        onClose={closeCreateDialog}
        onConfirm={handleCreateConfirm}
        disableRestoreFocus={!useCompactLayout}
        onTransitionExited={handleFileOperationDialogExited}
      />
    </Box>
  );
};

export default FileBrowserPane;
