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
import { alpha, Box, Chip, CircularProgress, Typography, useTheme } from "@mui/material";
import React, { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BreadcrumbsNavigation } from "../../components/FileBrowser/BreadcrumbsNavigation";
import { BrowserViewerPicker } from "../../components/FileBrowser/BrowserViewerPicker";
import { CompactCreateMenu } from "../../components/FileBrowser/CompactCreateMenu";
import type { CompactItemAction } from "../../components/FileBrowser/CompactItemActionsMenu";
import { CompactSelectionActions } from "../../components/FileBrowser/CompactSelectionActions";
import ConfirmDeleteDialog from "../../components/FileBrowser/ConfirmDeleteDialog";
import CreateItemDialog from "../../components/FileBrowser/CreateItemDialog";
import { FileList } from "../../components/FileBrowser/FileList";
import RenameDialog from "../../components/FileBrowser/RenameDialog";
import { STATUS_BAR_HEIGHT } from "../../components/FileBrowser/StatusBar";
import type { SearchProvider } from "../../components/FileBrowser/search";
import type { UnifiedSearchBarModeOption } from "../../components/FileBrowser/UnifiedSearchBar";
import { UnifiedSearchBar } from "../../components/FileBrowser/UnifiedSearchBar";
import { DRAFT_RECOVERY_CHANGED_EVENT, getUnsavedDraftsForConnection } from "../../services/draftRecovery";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";
import type { Connection, FileEntry } from "../../types";
import { FileType } from "../../types";
import { isConnectionReadOnly } from "./access";
import type { BrowserItem } from "./contentProviders";
import type { FileOperationAction, FileOperationPolicyContext } from "./fileOperationActions";
import type { PaneId, PaneMode, UseFileBrowserPaneReturn } from "./types";

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
  /** Whether another page-owned surface currently owns interaction. */
  compactActionsDisabled?: boolean;

  /** Whether the user is navigating with keyboard (for focus indicators). */
  isUsingKeyboard: boolean;

  /** Called when the user clicks on this pane to make it active. */
  onPaneFocus: () => void;

  /** Remove interactive controls from Tab order (dual-pane mode uses Tab for pane switching). */
  disableTabFocus?: boolean;

  /** Current quick-bar provider for the browser. */
  searchProvider: SearchProvider;

  /** Increments whenever the quick bar is explicitly reopened. */
  searchActivationToken?: number;

  /** Increments whenever visible quick-bar results should refresh without reopening. */
  searchRefreshToken?: number;

  /** Controlled query value for filter mode. */
  searchQueryValue?: string;

  /** Controlled query change handler for filter mode. */
  onSearchQueryValueChange?: (value: string) => void;

  /** Disable dropdown behavior for list-backed filter mode. */
  disableSearchDropdown?: boolean;

  /** Temporarily suppress the quick-bar dropdown while a higher-priority dialog is open. */
  suppressSearchDropdown?: boolean;

  /** Move focus from the search input into the file list. */
  onSearchArrowDownToFileList?: () => void;
  /** Explicit quick-bar mode options shown in the search bar. */
  modeOptions?: UnifiedSearchBarModeOption[];
  /** Whether keyboard shortcut hints are useful in the active input context. */
  showKeyboardHints?: boolean;
  /** Builds creation actions for an immutable pane context. */
  getCompactCreateActions?: (context: FileOperationPolicyContext) => readonly FileOperationAction[];
  /** Builds row actions for an immutable item context. */
  getCompactItemActions?: (context: FileOperationPolicyContext) => readonly CompactItemAction[];
  /** Builds bulk actions for an immutable selection context. */
  getCompactSelectionActions?: (context: FileOperationPolicyContext) => readonly FileOperationAction[];
  dropTargetLabel?: string;
  dropUnavailableReason?: string | null;
  onFileDrop?: (event: React.DragEvent<HTMLElement>) => void;
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
  compactActionsDisabled = false,
  isUsingKeyboard,
  onPaneFocus,
  disableTabFocus,
  searchProvider,
  searchActivationToken,
  searchRefreshToken,
  searchQueryValue,
  onSearchQueryValueChange,
  disableSearchDropdown,
  suppressSearchDropdown,
  onSearchArrowDownToFileList,
  showKeyboardHints,
  modeOptions,
  getCompactCreateActions,
  getCompactItemActions,
  getCompactSelectionActions,
  dropTargetLabel,
  dropUnavailableReason,
  onFileDrop,
}) => {
  const theme = useTheme();
  const { t } = useTranslation();
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
    searchInputRef,
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
  const [selectionAnnouncement, setSelectionAnnouncement] = React.useState("");
  const previousSelectedCountRef = React.useRef(selectedFiles.size);
  const renderedBrowserViewerPickerState = browserViewerPickerState ?? closingBrowserViewerPickerState;

  const handleCompactClearSelection = React.useCallback(() => {
    handleClearSelection();
  }, [handleClearSelection]);
  React.useEffect(() => {
    if (selectedFiles.size > 0) {
      setSelectionAnnouncement(t("fileBrowser.compactActions.selectedCount", { count: selectedFiles.size }));
    } else if (previousSelectedCountRef.current > 0) {
      setSelectionAnnouncement(t("fileBrowser.compactActions.selectionCleared"));
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
      const item = getItemsByPaths([file.path])[0];
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

  /** Navigate to a breadcrumb path segment. */
  const handleBreadcrumbNavigate = React.useCallback(
    (path: string) => {
      handleClearSelection();
      if (archiveLocation) {
        if (path === archiveLocation.archivePath) {
          pane.navigateArchiveToPath("");
          return;
        }
        const archivePrefix = `${archiveLocation.archivePath}/`;
        if (path.startsWith(archivePrefix)) {
          pane.navigateArchiveToPath(path.slice(archivePrefix.length));
          return;
        }
        pane.closeArchive();
      }
      pane.navigateToPath(path);
    },
    [archiveLocation, handleClearSelection, pane]
  );

  const breadcrumbPath = archiveLocation
    ? [archiveLocation.archivePath, archiveLocation.virtualPath].filter(Boolean).join("/")
    : currentPath;

  // ──────────────────────────────────────────────────────────────────────────
  // Render
  // ──────────────────────────────────────────────────────────────────────────

  if (!connectionId) return null;

  return (
    <Box data-pane-id={paneId} sx={paneContainerSx} onClick={handlePaneClick} onFocusCapture={handlePaneFocus} onKeyDown={undefined}>
      <Box
        aria-live="polite"
        aria-atomic="true"
        sx={{ position: "absolute", width: "1px", height: "1px", overflow: "hidden", clip: "rect(0 0 0 0)", whiteSpace: "nowrap" }}
      >
        {selectionAnnouncement}
      </Box>
      {/* Breadcrumbs + View/Sort controls (desktop) */}
      {!useCompactLayout && (
        <Box
          sx={{
            mb: 2,
            px: 2,
            height: STATUS_BAR_HEIGHT,
            boxSizing: "border-box",
            display: "flex",
            alignItems: "center",
          }}
        >
          <BreadcrumbsNavigation
            currentPath={breadcrumbPath}
            connectionName={connectionName}
            onNavigate={handleBreadcrumbNavigate}
            onEscape={() => listContainerEl?.focus()}
            disableTabFocus={disableTabFocus}
            showActiveIndicator={isDualMode && isActive}
          />
          {connectionIsReadOnly && (
            <Chip
              size="small"
              variant="outlined"
              color="warning"
              label={t("settings.connectionDialog.accessMode.readOnlyLabel")}
              title={t("settings.connectionDialog.helpers.accessModeReadOnly")}
              sx={{ ml: 1, flexShrink: 0 }}
            />
          )}
        </Box>
      )}

      {/* Search bar (mobile compact layout) */}
      {useCompactLayout && (
        <>
          <UnifiedSearchBar
            provider={searchProvider}
            activationToken={searchActivationToken}
            refreshToken={searchRefreshToken}
            inputRef={searchInputRef}
            useCompactLayout={useCompactLayout}
            onBlurToFileList={() => listContainerEl?.focus()}
            queryValue={searchQueryValue}
            onQueryValueChange={onSearchQueryValueChange}
            disableDropdown={disableSearchDropdown}
            suppressDropdown={suppressSearchDropdown}
            onArrowDownToFileList={onSearchArrowDownToFileList}
            modeOptions={modeOptions}
            showKeyboardHints={showKeyboardHints}
          />
          {connectionIsReadOnly && (
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
        </>
      )}

      {/* File list or loading indicator */}
      {loading ? (
        <Box sx={{ display: "flex", justifyContent: "center", p: 4 }}>
          <CircularProgress />
        </Box>
      ) : (
        <Box
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
            position: "relative",
            outline: fileDragActive && !dropUnavailableReason ? `2px solid ${theme.palette.primary.main}` : undefined,
            outlineOffset: -2,
          }}
        >
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
            showEmptyState={error === null}
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
          />
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
