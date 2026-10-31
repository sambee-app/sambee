/**
 * FileBrowser Component — Page-Level Orchestrator
 * =================================================
 *
 * Coordinates one or two file-browser panes with page-level concerns:
 * - Connection management and loading
 * - URL synchronisation (browser history, back/forward — both panes)
 * - WebSocket connection for real-time directory change notifications
 * - Keyboard shortcut registration (routed to the active pane)
 * - Global dialogs (settings, help)
 * - Responsive layout decisions
 * - Dual-pane layout toggle and pane focus management
 *
 * All per-pane state (directory listing, sorting, focus, caching, viewer,
 * virtualizer, CRUD dialogs, etc.) is delegated to `useFileBrowserPane`.
 * Per-pane rendering is handled by `FileBrowserPane`.
 *
 * @see useFileBrowserPane — manages all per-pane state and logic
 * @see FileBrowserPane — renders a single pane's UI (breadcrumbs, file list, etc.)
 */

import { AppBar, Box, Button, Container, Divider, Menu, MenuItem, Toolbar, Typography, useMediaQuery, useTheme } from "@mui/material";
import React, { useCallback, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { ArchiveExtractDialog, type ArchiveExtractionScope } from "../components/FileBrowser/ArchiveExtractDialog";
import { ArchiveOperationProgress } from "../components/FileBrowser/ArchiveOperationProgress";
import type { CompactItemAction } from "../components/FileBrowser/CompactItemActionsMenu";
import CopyMoveDialog, { type CopyMoveMode } from "../components/FileBrowser/CopyMoveDialog";
import { DesktopToolbar } from "../components/FileBrowser/DesktopToolbar";
import { DialogOperationContext } from "../components/FileBrowser/DialogOperationContext";
import { DynamicViewer, ViewerFallbackDialog } from "../components/FileBrowser/DynamicViewer";
import type { CompanionLifecycleStatus } from "../components/FileBrowser/FileBrowserAlerts";
import { FileBrowserAlerts, FileBrowserStatus } from "../components/FileBrowser/FileBrowserAlerts";
import { FileOperationsToolbar } from "../components/FileBrowser/FileOperationsToolbar";
import { formatConnectionPath } from "../components/FileBrowser/formatConnectionPath";
import { MobileToolbar } from "../components/FileBrowser/MobileToolbar";
import NameInputDialog from "../components/FileBrowser/NameInputDialog";
import {
  type ConflictDecision,
  type ConflictResolution,
  OverwriteResolutionDialog,
} from "../components/FileBrowser/OverwriteConflictDialog";
import { SecondaryActionStrip } from "../components/FileBrowser/SecondaryActionStrip";
import { StatusBar } from "../components/FileBrowser/StatusBar";
import { useBrowserCommandsProvider } from "../components/FileBrowser/search";
import { useFileSearchProvider } from "../components/FileBrowser/search/useFileSearchProvider";
import { KeyboardShortcutsHelp } from "../components/KeyboardShortcutsHelp";
import HamburgerMenu from "../components/Mobile/HamburgerMenu";
import { MobileSettingsDrawer } from "../components/Mobile/MobileSettingsDrawer";
import { NOTICE_DURATION_MS, OperationNotificationProvider, OperationNotifications } from "../components/OperationNotifications";
import SettingsDialog from "../components/Settings/SettingsDialog";
import { DEFAULT_SETTINGS_CATEGORY } from "../components/Settings/settingsNavigation";
import { useNativeSharing } from "../components/Sharing/useNativeSharing";
import { getEnabledBrowserCommands } from "../config/browserCommands";
import { BROWSER_SHORTCUTS, COMMON_SHORTCUTS, COPY_MOVE_SHORTCUTS, PANE_SHORTCUTS, SELECTION_SHORTCUTS } from "../config/keyboardShortcuts";
import { useCompanion } from "../hooks/useCompanion";
import { type KeyboardShortcut, useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { type ViewerLeaveGuard, WorkspaceNavigationGuard } from "../hooks/useRoutedViewerEditing";
import { signOutCurrentBrowser } from "../services/accountSession";
import { authSession } from "../services/authSession";
import { markBackendAvailable, useBackendAvailability } from "../services/backendAvailability";
import { subscribeBackendRecoveryConfirmed, subscribeBackendRecoveryReconnect } from "../services/backendRecoveryEvents";
import { isLocalDrive, mergeConnections } from "../services/backendRouter";
import { createBrowserContentServices } from "../services/browserContentServices";
import { loadBrowserRecoverySnapshot, saveBrowserRecoverySnapshot } from "../services/browserRecoverySnapshot";
import { companionSession } from "../services/companionSession";
import {
  hasForegroundArchiveWork,
  loadForegroundArchiveOperation,
  requestForegroundArchiveCancellation,
} from "../services/foregroundArchiveOperation";
import { logger } from "../services/logger";
import { loginPath } from "../services/oidcAuth";
import { RECENT_DIRECTORIES_CHANGED_EVENT } from "../services/recentDirectoriesSync";
import { RECENT_FILES_CHANGED_EVENT } from "../services/recentFilesSync";
import { scheduleRuntimeWarmup } from "../services/runtimeWarmup";
import { buildServerWebSocketUrl } from "../services/serverWebsocket";
import type { ContentTransferResult, TargetResolutionPolicy } from "../services/storageContracts";
import { getConfirmedCurrentUserSetting, refreshCurrentUserSettings } from "../services/userSettingsStore";
import { FILE_BROWSER_ROW_HEIGHT } from "../theme/constants";
import { getMobileViewportShellSx, mobileSafeAreaAppBarSx, mobileSafeAreaToolbarSx, SAFE_AREA_INSET } from "../theme/mobileShell";
import type { ConflictInfo, Connection, FileEntry } from "../types";
import { FileType, isApiError } from "../types";
import { getApiErrorMessage, getStorageErrorCode } from "../utils/apiErrors";
import { openExternalUrl } from "../utils/externalLinks";
import { compareLocalizedStrings } from "../utils/localeFormatting";
import { createShareFile, supportsNativeShare } from "../utils/nativeShare";
import { getConnectionById, isConnectionReadOnly, isConnectionWritable } from "./FileBrowser/access";
import { captureDropEntries, manifestFromDrop, manifestFromFiles } from "./FileBrowser/browserUploadManifest";
import {
  areSameContentLocations,
  type ContentOperationExecution,
  type ContentOperationReason,
  cancelForegroundArchiveOperationOnPageHide,
  executeTransfer,
  executeTransferTree,
  getArchiveExtractionAvailability,
  getCreateContainerAvailability,
  getCreateContentItemAvailability,
  getLocationDisplayName,
  getTransferAvailability,
  hasForegroundArchiveOperationWork,
  isPartialContainerOutputError,
  recoverInterruptedArchiveOperation,
  recoverInterruptedPhysicalTransfer,
  startArchiveExtraction,
  startCreateContainer,
} from "./FileBrowser/contentOperations";
import type {
  ArchiveExtractionConflict,
  ArchiveExtractionExecution,
  ArchiveExtractionOutcome,
  ArchiveExtractionSummary,
  BrowserItem,
  ContentItemHandle,
  ContentLocation,
  PhysicalLocation,
  VirtualLocation,
} from "./FileBrowser/contentProviders";
import { isDirectory, physicalLocation, readContent, virtualLocation } from "./FileBrowser/contentProviders";
import { FileBrowserPane } from "./FileBrowser/FileBrowserPane";
import {
  type CapturedDestination,
  createFileOperationActions,
  type FileOperationAction,
  type FileOperationActionId,
  type FileOperationInvocationContext,
  type FileOperationPolicyContext,
  type FileOperationSurface,
} from "./FileBrowser/fileOperationActions";
import { formatFileSize } from "./FileBrowser/formatters";
import { getItemActionAvailability } from "./FileBrowser/itemActionAvailability";
import {
  readFileBrowserPaneModePreference,
  readSelectedConnectionIdPreference,
  setFileBrowserPaneModePreference,
  shouldUseTouchSelectionControls,
  useQuickBarKeyboardHints,
  useQuickBarShortcutHintVisibilityPreference,
  useTouchFriendlyFileSelectionPreference,
} from "./FileBrowser/preferences";
import {
  type BrowseRouteState,
  buildBrowseRouteTarget,
  parseBrowseRoute,
  resolveBrowseRouteState,
  serializeBrowseRoute,
} from "./FileBrowser/routing";
import type { ArchiveLocation, DirectoryChange, PaneId, PaneMode, ViewInfo, VirtualRouteLocation } from "./FileBrowser/types";
import { ACTIVE_PANE_QUERY_KEY, ACTIVE_PANE_STORAGE_KEY, RIGHT_PANE_QUERY_KEY } from "./FileBrowser/types";
import { useBrowserDownload } from "./FileBrowser/useBrowserDownload";
import { useBrowserUpload } from "./FileBrowser/useBrowserUpload";
import { useFileBrowserPane } from "./FileBrowser/useFileBrowserPane";
import { useWorkspaceNavigation } from "./FileBrowser/useWorkspaceNavigation";

// ============================================================================
// Main Component
// ============================================================================

const FULL_ARCHIVE_EXTRACTION_SCOPE: ArchiveExtractionScope = { kind: "archive" };

const SERVER_WEBSOCKET_RECONNECT_DELAYS_MS = [500, 1_000, 2_000, 5_000] as const;
const COMPANION_WEBSOCKET_RECONNECT_DELAY_MS = 5_000;
const COMPANION_WEBSOCKET_CONNECT_TIMEOUT_MS = 15_000;
const DIRECTORY_SUBSCRIPTION_ACK_TIMEOUT_MS = 30_000;
const TRANSFER_NOTICE_AUTOHIDE_MS = NOTICE_DURATION_MS.information;

const COMPANION_STATUS_QUERY_PARAM = "companion_status";
const IGNORED_REALTIME_MESSAGE_TYPES = new Set(["subscribed", "unsubscribed", "pong"]);
const COPY_MOVE_FILE_CONFLICT_ACTIONS: readonly ConflictResolution[] = ["skip", "overwrite", "overwrite-older", "rename"];
const COPY_MOVE_DIRECTORY_CONFLICT_ACTIONS: readonly ConflictResolution[] = ["skip", "rename"];
const TEXT_ENTRY_SELECTOR = 'input, textarea, select, [contenteditable="true"]';
type CopyMoveConflictPolicy = TargetResolutionPolicy;
type FileListShortcutAction = FileOperationActionId;
type FileListShortcutUnavailableReason =
  | "no-focused-item"
  | "no-selection"
  | "dual-pane-required"
  | "archive-content-immutable"
  | "encrypted-archive-member"
  | "unsupported-archive-compression"
  | "read-only-location"
  | "unsupported-source"
  | "unsupported-destination"
  | "companion-unavailable"
  | "share-files-only"
  | "share-unsupported"
  | "interaction-blocked";
type FileListShortcutAvailability = { available: true } | { available: false; reason: FileListShortcutUnavailableReason };
type UnavailableShortcutNotice = { id: number; message: string };
type FileShareState = { status: "preparing"; count: number } | { status: "ready" | "sharing"; files: File[] };
type RecoveryPhase = "pending" | "awaiting-route" | "ready";

const AVAILABLE_FILE_LIST_SHORTCUT: FileListShortcutAvailability = { available: true };

function unavailableFileListShortcut(reason: FileListShortcutUnavailableReason): FileListShortcutAvailability {
  return { available: false, reason };
}

function mapContentOperationReason(reason: ContentOperationReason | undefined): FileListShortcutUnavailableReason {
  switch (reason) {
    case "empty-selection":
      return "no-selection";
    case "read-only":
      return "read-only-location";
    case "unsupported-destination":
      return "unsupported-destination";
    case "companion-unavailable":
      return "companion-unavailable";
    default:
      return "unsupported-source";
  }
}

function parentPath(path: string): string {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex < 0 ? "" : path.slice(0, separatorIndex);
}

function fileName(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function joinPath(parent: string, child: string): string {
  return parent ? `${parent}/${child}` : child;
}

export function getCopyMoveConflictActions(conflict: ConflictInfo | null): readonly ConflictResolution[] {
  if (conflict?.incoming_file.type === FileType.FILE && conflict.existing_file.type === FileType.FILE) {
    return COPY_MOVE_FILE_CONFLICT_ACTIONS;
  }
  return COPY_MOVE_DIRECTORY_CONFLICT_ACTIONS;
}

export function targetResolutionPolicyForConflictResolution(resolution: ConflictResolution): TargetResolutionPolicy {
  if (resolution === "skip") return "skip";
  if (resolution === "overwrite") return "replace";
  if (resolution === "overwrite-older") return "replace_older";
  return "ask";
}

type RealtimeMessage =
  | { type: "directory_changed"; change: DirectoryChange }
  | { type: "subscribed" | "subscription_error"; change: DirectoryChange; requestId: string; code?: string }
  | { type: "transfer_progress"; transferAttemptId: string; bytesTransferred: number; totalBytes: number | null; itemName: string }
  | { type: "ignored" };

function parseRealtimeMessage(rawMessage: unknown): RealtimeMessage | null {
  if (typeof rawMessage !== "string") {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(rawMessage);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const message = parsed as Record<string, unknown>;
    if (
      (message["type"] === "subscribed" || message["type"] === "error") &&
      typeof message["request_id"] === "string" &&
      typeof message["connection_id"] === "string" &&
      typeof message["path"] === "string"
    ) {
      return {
        type: message["type"] === "error" ? "subscription_error" : "subscribed",
        change: { connectionId: message["connection_id"], path: message["path"] },
        requestId: message["request_id"],
        code: typeof message["code"] === "string" ? message["code"] : undefined,
      };
    }
    if (typeof message["type"] === "string" && IGNORED_REALTIME_MESSAGE_TYPES.has(message["type"])) {
      return { type: "ignored" };
    }
    if (
      message["type"] === "directory_changed" &&
      typeof message["connection_id"] === "string" &&
      message["connection_id"].length > 0 &&
      typeof message["path"] === "string"
    ) {
      return { type: "directory_changed", change: { connectionId: message["connection_id"], path: message["path"] } };
    }
    if (
      message["type"] === "transfer_progress" &&
      typeof message["bytes_transferred"] === "number" &&
      typeof message["transfer_attempt_id"] === "string"
    ) {
      return {
        type: "transfer_progress",
        transferAttemptId: message["transfer_attempt_id"],
        bytesTransferred: message["bytes_transferred"],
        totalBytes: typeof message["total_bytes"] === "number" ? message["total_bytes"] : null,
        itemName: typeof message["item_name"] === "string" ? message["item_name"] : "",
      };
    }
  } catch {
    return null;
  }

  return null;
}

const toVirtualRouteLocation = (archiveLocation: ArchiveLocation | null): VirtualRouteLocation | null => {
  if (!archiveLocation) {
    return null;
  }

  return {
    providerId: archiveLocation.providerId,
    sourcePath: archiveLocation.archivePath,
    virtualPath: archiveLocation.virtualPath,
  };
};

function getSafeWebSocketLogUrl(wsUrl: string): string {
  try {
    const url = new URL(wsUrl);
    return `${url.origin}${url.pathname}`;
  } catch {
    return "invalid-websocket-url";
  }
}

function parseCompanionLifecycleStatus(rawStatus: string | null): CompanionLifecycleStatus | null {
  switch (rawStatus) {
    case "renewal_required":
    case "auth_failed":
    case "lock_lost":
    case "recovery_required":
      return rawStatus;
    default:
      return null;
  }
}

interface DirectorySubscription {
  connectionId: string;
  path: string;
}

function getDirectorySubscriptionKey({ connectionId, path }: DirectorySubscription): string {
  return `${connectionId}:${path}`;
}

function createDirectorySubscriptionMap(subscriptions: DirectorySubscription[]): Map<string, DirectorySubscription> {
  return new Map(subscriptions.map((subscription) => [getDirectorySubscriptionKey(subscription), subscription]));
}

function diffDirectorySubscriptions(
  previousSubscriptions: Map<string, DirectorySubscription>,
  nextSubscriptions: Map<string, DirectorySubscription>
): {
  removedSubscriptions: DirectorySubscription[];
  addedSubscriptions: DirectorySubscription[];
} {
  const removedSubscriptions: DirectorySubscription[] = [];
  const addedSubscriptions: DirectorySubscription[] = [];

  for (const [key, subscription] of previousSubscriptions) {
    if (!nextSubscriptions.has(key)) {
      removedSubscriptions.push(subscription);
    }
  }

  for (const [key, subscription] of nextSubscriptions) {
    if (!previousSubscriptions.has(key)) {
      addedSubscriptions.push(subscription);
    }
  }

  return {
    removedSubscriptions,
    addedSubscriptions,
  };
}

function collectDirectorySubscriptions({
  left,
  right,
  isDualMode,
  includeLocalDrives,
}: {
  left: DirectorySubscription;
  right: DirectorySubscription;
  isDualMode: boolean;
  includeLocalDrives: boolean;
}): DirectorySubscription[] {
  const subscriptions: DirectorySubscription[] = [];
  const seen = new Set<string>();

  const maybeAdd = ({ connectionId, path }: DirectorySubscription) => {
    if (!connectionId || isLocalDrive(connectionId) !== includeLocalDrives) {
      return;
    }

    const key = `${connectionId}:${path}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    subscriptions.push({ connectionId, path });
  };

  maybeAdd(left);

  if (isDualMode) {
    maybeAdd(right);
  }

  return subscriptions;
}

const Browser: React.FC = () => {
  // Track renders for performance monitoring
  const renderCountRef = React.useRef(0);
  React.useEffect(() => {
    renderCountRef.current++;
    if (renderCountRef.current % 10 === 0) {
      logger.debug("Browser component render count", { renders: renderCountRef.current }, "browser-perf");
    }
  });

  const navigate = useNavigate();
  const params = useParams<{ targetType: string; targetId: string; "*": string }>();
  const location = useLocation();
  const searchParams = useMemo(() => new URLSearchParams(location.search), [location.search]);
  const currentRoute = useMemo(
    () => parseBrowseRoute({ targetType: params.targetType, targetId: params.targetId, path: params["*"], searchParams }),
    [params.targetType, params.targetId, params["*"], searchParams]
  );
  const theme = useTheme();
  const { t } = useTranslation();
  const initialRecoverySnapshotRef = React.useRef(loadBrowserRecoverySnapshot(location.pathname + location.search));
  const hasHydratedRecoverySnapshotRef = React.useRef(false);
  const hasStartedInitialConnectionLoadRef = React.useRef(false);
  const [recoveryPhase, setRecoveryPhase] = useState<RecoveryPhase>(() =>
    initialRecoverySnapshotRef.current === null ? "ready" : "pending"
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Responsive Design
  // ──────────────────────────────────────────────────────────────────────────

  // Detect screen size and input method for responsive behavior
  const useCompactLayout = useMediaQuery(theme.breakpoints.down("sm"));
  const hasCoarsePrimaryPointer = useMediaQuery("(pointer: coarse)");
  const [quickBarShortcutHintVisibility] = useQuickBarShortcutHintVisibilityPreference();
  const [touchFriendlyFileSelection] = useTouchFriendlyFileSelectionPreference();
  const useTouchSelectionControls = shouldUseTouchSelectionControls(touchFriendlyFileSelection, useCompactLayout, hasCoarsePrimaryPointer);
  const showQuickBarKeyboardHints = useQuickBarKeyboardHints(quickBarShortcutHintVisibility, useCompactLayout);

  // Use explicit layout density rather than pointer heuristics so row sizing stays stable.
  const rowHeight = useCompactLayout
    ? FILE_BROWSER_ROW_HEIGHT.MOBILE_PX
    : useTouchSelectionControls
      ? FILE_BROWSER_ROW_HEIGHT.TOUCH_PX
      : FILE_BROWSER_ROW_HEIGHT.DESKTOP_PX;

  // Track if keyboard is being used for navigation (for proper focus styling)
  // Touch selection controls start without a focus indicator; keyboard layouts show focus on load.
  const [isUsingKeyboard, setIsUsingKeyboard] = useState(!useTouchSelectionControls);

  // ──────────────────────────────────────────────────────────────────────────
  // Global Page State
  // ──────────────────────────────────────────────────────────────────────────

  const [connections, setConnections] = useState<Connection[]>(() => initialRecoverySnapshotRef.current?.connections ?? []);
  const [loadingConnections, setLoadingConnections] = useState(() => initialRecoverySnapshotRef.current === null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const settingsOpen = Boolean(currentRoute.settings) && !useCompactLayout;
  const mobileSettingsOpen = Boolean(currentRoute.settings) && useCompactLayout;
  const settingsInitialCategory =
    currentRoute.settings && currentRoute.settings !== "main" ? currentRoute.settings : DEFAULT_SETTINGS_CATEGORY;
  const mobileSettingsInitialView = currentRoute.settings ?? "main";
  const [showHelp, setShowHelp] = useState(false);
  const [quickBarMode, setQuickBarMode] = useState<"navigate" | "commands" | "file-search">("navigate");
  const [quickBarActivationToken, setQuickBarActivationToken] = useState(0);
  const [quickBarRefreshToken, setQuickBarRefreshToken] = useState(0);
  const [quickBarPaneId, setQuickBarPaneId] = useState<PaneId>("left");
  const [companionHintOpen, setCompanionHintOpen] = useState(false);
  const [unavailableShortcutNotice, setUnavailableShortcutNotice] = useState<UnavailableShortcutNotice | null>(null);
  const [transferNotice, setTransferNotice] = useState("");
  const nativeSharing = useNativeSharing("file-list");
  const [fileShareState, setFileShareState] = useState<FileShareState | null>(null);
  const fileShareRequestRef = React.useRef<{
    controller: AbortController;
    paneId: PaneId;
    location: ContentLocation;
    selectedPaths: string[] | null;
  } | null>(null);
  const pendingUploadPickerRef = React.useRef<HTMLInputElement | null>(null);
  const uploadTriggerRef = React.useRef<HTMLElement | null>(null);
  const uploadMenuFocusRef = React.useRef<HTMLElement | null>(null);
  const uploadMenuOpenId = React.useRef(0);
  const [uploadMenu, setUploadMenu] = useState<{ anchor: HTMLElement; paneId: PaneId; destination: PhysicalLocation } | null>(null);
  const backendAvailability = useBackendAvailability();

  // ── Companion detection & drive management ──────────────────────────────
  const companion = useCompanion();

  /** Server connections merged with companion-provided local drives. */
  const allConnections = useMemo(() => mergeConnections(connections, companion.drives), [connections, companion.drives]);
  const [browserContentServices] = useState(() => createBrowserContentServices(allConnections));
  const { startDownload, cancelDownload, isDownloading, showDownloadNotice, downloadKind } = useBrowserDownload(
    browserContentServices.providers,
    t,
    setTransferNotice
  );
  useSyncExternalStore(browserContentServices.subscribe, browserContentServices.getSnapshot, browserContentServices.getSnapshot);

  useEffect(() => {
    browserContentServices.updateConnections(allConnections);
  }, [allConnections, browserContentServices]);

  useEffect(() => {
    const status =
      companion.status === "paired"
        ? "paired"
        : companion.status === "detecting" || companion.status === "pending_local_approval"
          ? "pairing"
          : companion.status === "unavailable"
            ? "unavailable"
            : "unpaired";
    browserContentServices.updateCompanionSnapshot({
      status,
      revision: companionSession.getSnapshot().revision,
      drives: companion.drives.map((drive) => ({ driveId: drive.id, name: drive.name, path: "" })),
      error: null,
    });
  }, [browserContentServices, companion.drives, companion.status]);

  useEffect(() => () => browserContentServices.dispose(), [browserContentServices]);

  // ──────────────────────────────────────────────────────────────────────────
  // Copy / Move Dialog State
  // ──────────────────────────────────────────────────────────────────────────

  const [copyMoveDialogOpen, setCopyMoveDialogOpen] = useState(false);
  const [copyMoveMode, setCopyMoveMode] = useState<CopyMoveMode>("copy");
  const [copyMoveItems, setCopyMoveItems] = useState<BrowserItem[]>([]);
  const [copyMoveSourcePaneId, setCopyMoveSourcePaneId] = useState<PaneId>("left");
  const [copyMoveDestination, setCopyMoveDestination] = useState<ContentLocation | null>(null);
  const [copyMoveDestinationLabel, setCopyMoveDestinationLabel] = useState("");
  const [copyMoveSameDirectory, setCopyMoveSameDirectory] = useState(false);
  const [copyMoveDestinationPaneId, setCopyMoveDestinationPaneId] = useState<PaneId>("right");
  const [copyMoveProcessing, setCopyMoveProcessing] = useState(false);
  const [copyMoveProgress, setCopyMoveProgress] = useState<{ current: number; total: number } | undefined>();
  const [copyMoveTransferProgress, setCopyMoveTransferProgress] = useState<{
    bytesTransferred: number;
    totalBytes: number | null;
    itemName: string;
  } | null>(null);
  const [copyMoveError, setCopyMoveError] = useState<string | null>(null);
  const [copyMoveWarning, setCopyMoveWarning] = useState<string | null>(null);
  const copyMoveAbortControllerRef = React.useRef<AbortController | null>(null);
  const activeTransferAttemptRef = React.useRef<string | null>(null);

  const [archiveCreateContext, setArchiveCreateContext] = useState<{
    sources: ContentItemHandle[];
    destination: ContentLocation;
    destinationLabel: string;
    destinationPaneId: PaneId;
  } | null>(null);
  const [archiveCreateError, setArchiveCreateError] = useState<string | null>(null);
  const [isCreatingArchive, setIsCreatingArchive] = useState(false);
  const [isCancellingArchiveCreation, setIsCancellingArchiveCreation] = useState(false);
  const archiveCreationExecutionRef = React.useRef<ContentOperationExecution | null>(null);
  const [archiveExtractionContext, setArchiveExtractionContext] = useState<{
    location: VirtualLocation;
    extractionScope: ArchiveExtractionScope;
    destinationParent: PhysicalLocation;
    destinationPaneId: PaneId;
    usesSiblingDirectory: boolean;
    destination: PhysicalLocation | null;
    destinationLabel: string;
    archiveName: string;
    initialDestinationName: string;
  } | null>(null);
  const [archiveExtractionError, setArchiveExtractionError] = useState<string | null>(null);
  const [isExtractingArchive, setIsExtractingArchive] = useState(false);
  const [isCancellingArchiveExtraction, setIsCancellingArchiveExtraction] = useState(false);
  const [archiveExtractionConflicts, setArchiveExtractionConflicts] = useState<ArchiveExtractionConflict[] | null>(null);
  const [archiveExtractionMemberError, setArchiveExtractionMemberError] = useState<{
    memberPath: string;
    targetPath: string;
    message: string;
    partialOutput: boolean;
  } | null>(null);
  const [archiveExtractionProgress, setArchiveExtractionProgress] = useState<ArchiveExtractionSummary | null>(null);
  const [archiveExtractionAllowedActions, setArchiveExtractionAllowedActions] = useState<
    Array<"skip" | "skip_all" | "replace" | "replace_all" | "replace_older" | "rename">
  >([]);
  const [isSubmittingArchiveExtractionDecision, setIsSubmittingArchiveExtractionDecision] = useState(false);
  const archiveExtractionExecutionRef = React.useRef<ArchiveExtractionExecution | null>(null);
  const [archiveExtractionNotice, setArchiveExtractionNotice] = useState<string | null>(null);
  const archiveWorkflowDialogOpen = archiveCreateContext !== null || archiveExtractionContext !== null;

  useEffect(() => {
    void recoverInterruptedArchiveOperation(browserContentServices.archiveOperations).then((interrupted) => {
      if (interrupted) setArchiveExtractionNotice(t("fileBrowser.archive.interruptedAfterReload"));
    });
    void recoverInterruptedPhysicalTransfer();

    const handlePageHide = () => {
      cancelForegroundArchiveOperationOnPageHide(browserContentServices.archiveOperations);
      const extraction = archiveExtractionExecutionRef.current;
      if (extraction) {
        void extraction.cancel();
      } else {
        const operation = loadForegroundArchiveOperation();
        if (operation) requestForegroundArchiveCancellation(operation.operationId);
      }
    };
    const handleBeforeUnload = (event: BeforeUnloadEvent) => {
      if (hasForegroundArchiveOperationWork(browserContentServices.archiveOperations) || hasForegroundArchiveWork()) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("pagehide", handlePageHide);
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("pagehide", handlePageHide);
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [browserContentServices.archiveOperations, t]);

  // Overwrite conflict dialog state
  const [conflictDialogOpen, setConflictDialogOpen] = useState(false);
  const [conflictInfo, setConflictInfo] = useState<ConflictInfo | null>(null);
  const [conflictProgress, setConflictProgress] = useState<{ current: number; total: number; conflictsSoFar: number } | undefined>();
  const [treeConflictAllowsApplyToAll, setTreeConflictAllowsApplyToAll] = useState(false);
  /** Ref holding the resolve function of a Promise used to pause the processing loop while the conflict dialog is open. */
  const conflictResolveRef = React.useRef<((value: ConflictDecision | null) => void) | null>(null);

  // ──────────────────────────────────────────────────────────────────────────
  // Dual-Pane State
  // ──────────────────────────────────────────────────────────────────────────

  /** Layout mode: single pane (default) or side-by-side dual pane. */
  const [paneMode, setPaneMode] = useState<PaneMode>(() => {
    // If the URL contains a p2 query parameter, activate dual mode automatically
    const urlP2 = new URLSearchParams(window.location.search).get(RIGHT_PANE_QUERY_KEY);
    if (urlP2) return "dual";
    return readFileBrowserPaneModePreference();
  });

  /** Which pane is currently active (receives keyboard input and toolbar actions). */
  const [activePaneId, setActivePaneId] = useState<PaneId>(() => {
    // If the URL specifies an active pane, use it
    const urlActive = new URLSearchParams(window.location.search).get(ACTIVE_PANE_QUERY_KEY);
    if (urlActive === "2") return "right";
    if (urlActive === "1") return "left";
    // Otherwise fall back to localStorage
    const saved = localStorage.getItem(ACTIVE_PANE_STORAGE_KEY);
    return saved === "right" ? "right" : "left";
  });

  const companionLifecycleStatus = useMemo(
    () => parseCompanionLifecycleStatus(searchParams.get(COMPANION_STATUS_QUERY_PARAM)),
    [searchParams]
  );
  const resolvedRoute = useMemo(() => resolveBrowseRouteState(currentRoute, allConnections), [allConnections, currentRoute]);

  const leftPathNavigateRef = React.useRef<(path: string) => void>(() => undefined);
  const rightPathNavigateRef = React.useRef<(path: string) => void>(() => undefined);
  const leftConnectionNavigateRef = React.useRef<(connectionId: string) => void>(() => undefined);
  const rightConnectionNavigateRef = React.useRef<(connectionId: string) => void>(() => undefined);
  const leftDirectoryNavigateRef = React.useRef<(connectionId: string, path: string) => void>(() => undefined);
  const rightDirectoryNavigateRef = React.useRef<(connectionId: string, path: string) => void>(() => undefined);
  const leftVirtualLocationNavigateRef = React.useRef<(location: VirtualRouteLocation | null) => void>(() => undefined);
  const rightVirtualLocationNavigateRef = React.useRef<(location: VirtualRouteLocation | null) => void>(() => undefined);
  const leftRouteLocationResolveRef = React.useRef<(path: string, archiveLocation: ArchiveLocation | null) => void>(() => undefined);
  const rightRouteLocationResolveRef = React.useRef<(path: string, archiveLocation: ArchiveLocation | null) => void>(() => undefined);
  const pendingPaneFocusRef = React.useRef<PaneId | null>(null);
  const routeSyncTokenRef = React.useRef(0);
  const openViewerRef = React.useRef<(paneId: PaneId, info: ViewInfo) => void>(() => undefined);

  // WebSocket for real-time directory updates (server)
  const wsRef = React.useRef<WebSocket | null>(null);
  const reconnectTimeoutRef = React.useRef<number | null>(null);
  const serverReconnectAttemptRef = React.useRef(0);
  const triggerServerReconnectRef = React.useRef<(reason: string) => void>(() => undefined);
  const [serverDirectoryWs, setServerDirectoryWs] = useState<WebSocket | null>(null);
  const serverAppliedSubscriptionsRef = React.useRef<Map<string, DirectorySubscription>>(new Map());
  const subscriptionRequestsRef = React.useRef(new Map<string, { socket: WebSocket; requestId: string; timeoutId: number }>());
  const acknowledgedSubscriptionsRef = React.useRef(new Map<string, WebSocket>());

  // WebSocket for real-time directory updates (companion / local drives)
  const companionWsRef = React.useRef<WebSocket | null>(null);
  const companionReconnectRef = React.useRef<number | null>(null);
  const [companionDirectoryWs, setCompanionDirectoryWs] = useState<WebSocket | null>(null);
  const companionAppliedSubscriptionsRef = React.useRef<Map<string, DirectorySubscription>>(new Map());

  // ──────────────────────────────────────────────────────────────────────────
  // Pane Hooks — all per-pane state and logic
  // ──────────────────────────────────────────────────────────────────────────

  // Left pane — always present, synced with URL
  const leftPane = useFileBrowserPane({
    connections: allConnections,
    contentProviders: browserContentServices.providers,
    storageRegistry: browserContentServices.registry,
    history: browserContentServices.history,
    linkTargets: browserContentServices.linkTargets,
    rowHeight,
    disabled: settingsOpen || mobileSettingsOpen,
    isActive: activePaneId === "left",
    onCompanionHint: () => setCompanionHintOpen(true),
    onNavigatePath: (path) => leftPathNavigateRef.current(path),
    onNavigateConnection: (connectionId) => leftConnectionNavigateRef.current(connectionId),
    onNavigateDirectory: (connectionId, path) => leftDirectoryNavigateRef.current(connectionId, path),
    onNavigateVirtualLocation: (location) => leftVirtualLocationNavigateRef.current(location),
    onResolveRouteLocation: (path, archiveLocation) => leftRouteLocationResolveRef.current(path, archiveLocation),
    onOpenViewer: (info) => openViewerRef.current("left", info),
  });

  // Right pane — always instantiated (React hooks rule: no conditional hooks),
  // but only renders in dual mode. Disabled when not in dual mode.
  const rightPane = useFileBrowserPane({
    connections: allConnections,
    contentProviders: browserContentServices.providers,
    storageRegistry: browserContentServices.registry,
    history: browserContentServices.history,
    linkTargets: browserContentServices.linkTargets,
    rowHeight,
    disabled: settingsOpen || mobileSettingsOpen || paneMode === "single",
    isActive: activePaneId === "right" && paneMode === "dual",
    onCompanionHint: () => setCompanionHintOpen(true),
    onNavigatePath: (path) => rightPathNavigateRef.current(path),
    onNavigateConnection: (connectionId) => rightConnectionNavigateRef.current(connectionId),
    onNavigateDirectory: (connectionId, path) => rightDirectoryNavigateRef.current(connectionId, path),
    onNavigateVirtualLocation: (location) => rightVirtualLocationNavigateRef.current(location),
    onResolveRouteLocation: (path, archiveLocation) => rightRouteLocationResolveRef.current(path, archiveLocation),
    onOpenViewer: (info) => openViewerRef.current("right", info),
  });
  const leftPaneRef = React.useRef(leftPane);
  const rightPaneRef = React.useRef(rightPane);
  leftPaneRef.current = leftPane;
  rightPaneRef.current = rightPane;
  const workspace = useWorkspaceNavigation({
    route: currentRoute,
    connections: allConnections,
    services: browserContentServices,
    left: leftPane,
    right: rightPane,
    ready: !loadingConnections && recoveryPhase === "ready",
  });
  const [viewerLeaveGuard, setViewerLeaveGuard] = useState<ViewerLeaveGuard | null>(null);
  const displayedViewerPane = leftPane.viewInfo ? leftPane : rightPane;
  const displayedViewerInfo = displayedViewerPane.viewInfo;
  openViewerRef.current = workspace.openViewer;

  /**
   * Active pane — the pane that receives keyboard input and toolbar actions.
   * In single-pane mode, always the left pane. In dual mode, whichever has focus.
   */
  const isDualMode = paneMode === "dual" && !useCompactLayout;
  const isDualModeRef = React.useRef(isDualMode);
  isDualModeRef.current = isDualMode;
  const effectiveActivePaneId = isDualMode ? activePaneId : "left";
  const effectiveActivePaneIdRef = React.useRef(effectiveActivePaneId);
  effectiveActivePaneIdRef.current = effectiveActivePaneId;
  const activePane = effectiveActivePaneId === "left" ? leftPane : rightPane;
  const getPaneForId = useCallback((paneId: PaneId) => (paneId === "left" ? leftPaneRef.current : rightPaneRef.current), []);
  const cancelFileShare = useCallback(() => {
    fileShareRequestRef.current?.controller.abort();
    fileShareRequestRef.current = null;
    setFileShareState(null);
  }, []);
  useEffect(() => {
    const request = fileShareRequestRef.current;
    if (!request || fileShareState?.status === "sharing") return;
    const pane = request.paneId === "left" ? leftPane : rightPane;
    if (
      !areSameContentLocations(pane.currentLocation, request.location) ||
      (request.selectedPaths &&
        (pane.selectedFiles.size !== request.selectedPaths.length || request.selectedPaths.some((path) => !pane.selectedFiles.has(path))))
    ) {
      cancelFileShare();
    }
  }, [cancelFileShare, fileShareState?.status, leftPane, rightPane]);
  useEffect(
    () => () => {
      fileShareRequestRef.current?.controller.abort();
      fileShareRequestRef.current = null;
    },
    []
  );
  const contentOperationEnvironment = useMemo(
    () => ({
      isCompanionPaired: companion.status === "paired",
      storageRegistry: browserContentServices.registry,
      archiveOperations: browserContentServices.archiveOperations,
      history: browserContentServices.history,
    }),
    [browserContentServices.archiveOperations, browserContentServices.history, browserContentServices.registry, companion.status]
  );
  const {
    startBrowserUpload,
    cancelUpload,
    deferDirectoryChange,
    resolveUploadConflict,
    uploadConflict,
    uploadProgress,
    uploadPreparing,
    uploadSessionActive,
  } = useBrowserUpload({
    blocked: copyMoveDialogOpen || conflictDialogOpen,
    connections: allConnections,
    environment: contentOperationEnvironment,
    getPaneForId,
    registry: browserContentServices.registry,
    resolvePolicy: targetResolutionPolicyForConflictResolution,
    showNotice: setTransferNotice,
    t,
  });
  const getOperationPolicyContext = useCallback(
    (paneId: PaneId = effectiveActivePaneIdRef.current): FileOperationPolicyContext => {
      const pane = getPaneForId(paneId);
      const focusedFile = pane.sortedFiles[pane.focusedIndex];
      const focusedItem = focusedFile ? pane.getItemsByPaths([focusedFile.path])[0] : undefined;
      return { paneId, items: pane.getEffectiveSelection(), focusedItem };
    },
    [getPaneForId]
  );
  const getCapturedDestination = useCallback(
    (paneId: PaneId): CapturedDestination => {
      const destinationPaneId: PaneId = isDualModeRef.current ? (paneId === "left" ? "right" : "left") : paneId;
      return { paneId: destinationPaneId, location: getPaneForId(destinationPaneId).currentLocation };
    },
    [getPaneForId]
  );
  const activateOperationPane = useCallback((paneId: PaneId) => {
    if (isDualModeRef.current) setActivePaneId(paneId);
  }, []);

  const handleFileOperationDialogExited = useCallback(() => {
    if (!useCompactLayout) {
      activePane.listContainerEl?.focus({ preventScroll: true });
    }
  }, [activePane.listContainerEl, useCompactLayout]);
  const quickBarPane = quickBarPaneId === "right" && isDualMode ? rightPane : leftPane;
  const quickBarOtherPane = quickBarPaneId === "right" && isDualMode ? leftPane : rightPane;
  const quickBarInputRef = quickBarPane.searchInputRef;
  const viewerOverlayOpen = Boolean(leftPane.viewInfo || rightPane.viewInfo);
  const browserOverlayOpen =
    settingsOpen ||
    mobileSettingsOpen ||
    drawerOpen ||
    showHelp ||
    viewerOverlayOpen ||
    leftPane.deleteDialogOpen ||
    leftPane.renameDialogOpen ||
    leftPane.createDialogOpen ||
    rightPane.deleteDialogOpen ||
    rightPane.renameDialogOpen ||
    rightPane.createDialogOpen ||
    copyMoveDialogOpen ||
    conflictDialogOpen ||
    uploadConflict !== null ||
    archiveWorkflowDialogOpen;
  const handleBrowserEscape = useCallback(() => {
    activePane.handleClose();
    activePane.listContainerEl?.focus({ preventScroll: true });
  }, [activePane]);
  const handleBrowserKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>) => {
      if (event.key !== "Escape" || event.defaultPrevented || browserOverlayOpen) {
        return;
      }

      const target = event.target;
      if (!(target instanceof Element) || !event.currentTarget.contains(target) || target.closest(TEXT_ENTRY_SELECTOR)) {
        return;
      }

      event.preventDefault();
      handleBrowserEscape();
    },
    [browserOverlayOpen, handleBrowserEscape]
  );
  const isBrowserBrowsing = !settingsOpen && !mobileSettingsOpen && !activePane.viewInfo;
  const quickBarPaneConnection = getConnectionById(allConnections, quickBarPane.connectionId);
  const activePaneFocusedFile = activePane.focusedIndex >= 0 ? activePane.sortedFiles[activePane.focusedIndex] : undefined;
  const quickBarFocusedFile = quickBarPane.focusedIndex >= 0 ? quickBarPane.sortedFiles[quickBarPane.focusedIndex] : undefined;
  const activePaneIsArchive = activePane.archiveLocation !== null;
  const activePaneIsVirtualArchive = activePane.currentLocation.kind === "virtual";
  const archiveExtractionSource = useMemo((): VirtualLocation | null => {
    const location = activePane.currentLocation;
    if (location.kind === "virtual") {
      return activePane.contentCapabilities.extract ? location : null;
    }
    if (activePaneFocusedFile?.type !== "file") {
      return null;
    }
    const providerId = browserContentServices.providers.getVirtualProviderIdForFilename(activePaneFocusedFile.name);
    if (!providerId) {
      return null;
    }
    const source = virtualLocation(
      providerId,
      location.connectionId,
      physicalLocation(location.connectionId, activePaneFocusedFile.path),
      ""
    );
    return browserContentServices.providers.getCapabilities(source).extract ? source : null;
  }, [activePane.contentCapabilities.extract, activePane.currentLocation, activePaneFocusedFile, browserContentServices.providers]);
  const quickBarPaneWritable = quickBarPane.contentCapabilities.mutate && isConnectionWritable(quickBarPaneConnection);
  const activePaneFocusedItem = activePaneFocusedFile ? activePane.getItemsByPaths([activePaneFocusedFile.path])[0] : undefined;
  const quickBarFocusedItem = quickBarFocusedFile ? quickBarPane.getItemsByPaths([quickBarFocusedFile.path])[0] : undefined;
  const activePaneCanOpenInApp = getItemActionAvailability({
    item: activePaneFocusedItem,
    nativeAppCapability: activePane.contentCapabilities.openInNativeApp,
    isCompanionPaired: companion.status === "paired",
    environment: contentOperationEnvironment,
  }).canOpenInNativeApp;
  const quickBarCanOpenInApp = getItemActionAvailability({
    item: quickBarFocusedItem,
    nativeAppCapability: quickBarPane.contentCapabilities.openInNativeApp,
    isCompanionPaired: companion.status === "paired",
    environment: contentOperationEnvironment,
  }).canOpenInNativeApp;
  const quickBarSelection = quickBarPane.getEffectiveSelection();
  const quickBarCanCopyToOtherPane =
    isDualMode &&
    quickBarSelection.length > 0 &&
    quickBarSelection.every(
      (item) =>
        getTransferAvailability(
          { kind: "copy", source: item.handle, destination: quickBarOtherPane.currentLocation },
          contentOperationEnvironment
        ).available
    );
  const quickBarCanMoveToOtherPane =
    isDualMode &&
    quickBarSelection.length > 0 &&
    quickBarSelection.every(
      (item) =>
        getTransferAvailability(
          { kind: "move", source: item.handle, destination: quickBarOtherPane.currentLocation },
          contentOperationEnvironment
        ).available
    );
  const createContainerDestination = isDualMode
    ? (effectiveActivePaneId === "left" ? rightPane : leftPane).currentLocation
    : activePane.currentLocation;
  const activePaneCanCreateArchive = getCreateContainerAvailability(
    { sources: activePane.getEffectiveSelection().map((item) => item.handle), destination: createContainerDestination },
    contentOperationEnvironment
  ).available;
  const getArchiveExtractionShortcutAvailability = useCallback(
    (source: VirtualLocation, destination: ContentLocation): FileListShortcutAvailability => {
      if (destination.kind !== "physical") {
        return unavailableFileListShortcut("unsupported-destination");
      }
      if (isConnectionReadOnly(getConnectionById(allConnections, destination.connectionId))) {
        return unavailableFileListShortcut("read-only-location");
      }
      const availability = getArchiveExtractionAvailability(browserContentServices.providers, source, destination);
      if (availability.available) {
        return AVAILABLE_FILE_LIST_SHORTCUT;
      }
      return unavailableFileListShortcut(availability.reason === "invalid-destination" ? "read-only-location" : "unsupported-source");
    },
    [allConnections, browserContentServices.providers]
  );
  const getArchiveExtractionSourceForContext = useCallback(
    (context: FileOperationPolicyContext): VirtualLocation | null => {
      const focusedItem = context.focusedItem;
      if (!focusedItem || focusedItem.entry.type !== FileType.FILE || focusedItem.handle.kind !== "physical") return null;
      const providerId = browserContentServices.providers.getVirtualProviderIdForFilename(focusedItem.entry.name);
      if (!providerId) return null;
      const source = virtualLocation(
        providerId,
        focusedItem.handle.location.connectionId,
        physicalLocation(focusedItem.handle.location.connectionId, focusedItem.handle.path),
        ""
      );
      return browserContentServices.providers.getCapabilities(source).extract ? source : null;
    },
    [browserContentServices.providers]
  );
  const getFileListShortcutAvailability = useCallback(
    (action: FileListShortcutAction, context: FileOperationPolicyContext = getOperationPolicyContext()): FileListShortcutAvailability => {
      if ((action === "copy" || action === "move") && uploadSessionActive) {
        return unavailableFileListShortcut("interaction-blocked");
      }
      if (action === "refresh") {
        return isBrowserBrowsing ? AVAILABLE_FILE_LIST_SHORTCUT : unavailableFileListShortcut("interaction-blocked");
      }

      const sourcePane = getPaneForId(context.paneId);
      const sourceLocation = sourcePane.currentLocation;
      const sourceIsArchive = sourceLocation.kind === "virtual";
      const sourcePaneReadOnly =
        !sourcePane.contentCapabilities.mutate || isConnectionReadOnly(getConnectionById(allConnections, sourceLocation.connectionId));
      const destination = getCapturedDestination(context.paneId).location;
      const archiveExtractionSource = getArchiveExtractionSourceForContext(context);

      if (action === "delete" || action === "rename") {
        if (sourceIsArchive) return unavailableFileListShortcut("archive-content-immutable");
        if (sourcePaneReadOnly) return unavailableFileListShortcut("read-only-location");
        return context.focusedItem ? AVAILABLE_FILE_LIST_SHORTCUT : unavailableFileListShortcut("no-focused-item");
      }

      if (action === "new-directory" || action === "new-file") {
        if (sourceIsArchive) return unavailableFileListShortcut("archive-content-immutable");
        const availability = getCreateContentItemAvailability(sourceLocation, contentOperationEnvironment);
        return availability.available
          ? AVAILABLE_FILE_LIST_SHORTCUT
          : unavailableFileListShortcut(mapContentOperationReason(availability.reason));
      }

      if (action === "upload") {
        if (uploadSessionActive || copyMoveDialogOpen || conflictDialogOpen) return unavailableFileListShortcut("interaction-blocked");
        if (sourceIsArchive) return unavailableFileListShortcut("archive-content-immutable");
        if (sourcePaneReadOnly) return unavailableFileListShortcut("read-only-location");
        if (sourceLocation.kind !== "physical" || !isConnectionWritable(getConnectionById(allConnections, sourceLocation.connectionId)))
          return unavailableFileListShortcut("unsupported-destination");
        if (isLocalDrive(sourceLocation.connectionId) && !contentOperationEnvironment.isCompanionPaired)
          return unavailableFileListShortcut("companion-unavailable");
        return AVAILABLE_FILE_LIST_SHORTCUT;
      }

      if (action === "share") {
        if (!useCompactLayout || !supportsNativeShare()) return unavailableFileListShortcut("share-unsupported");
        if (fileShareState) return unavailableFileListShortcut("interaction-blocked");
        const selected = context.items.length ? context.items : context.focusedItem ? [context.focusedItem] : [];
        if (!selected.length) return unavailableFileListShortcut("no-selection");
        if (selected.some((item) => item.entry.type !== FileType.FILE || item.entry.link_target?.target?.type === FileType.DIRECTORY))
          return unavailableFileListShortcut("share-files-only");
        if (selected.some((item) => !item.entry.is_readable)) return unavailableFileListShortcut("unsupported-source");
        if (isLocalDrive(sourceLocation.connectionId) && !contentOperationEnvironment.isCompanionPaired)
          return unavailableFileListShortcut("companion-unavailable");
        return sourcePane.contentCapabilities.read ? AVAILABLE_FILE_LIST_SHORTCUT : unavailableFileListShortcut("unsupported-source");
      }

      if (action === "download") {
        if (isDownloading) return unavailableFileListShortcut("interaction-blocked");
        const selected = context.items.length ? context.items : context.focusedItem ? [context.focusedItem] : [];
        if (!selected.length) return unavailableFileListShortcut("no-selection");
        if (selected.some((item) => !item.entry.is_readable)) return unavailableFileListShortcut("unsupported-source");
        if (isLocalDrive(sourceLocation.connectionId) && !contentOperationEnvironment.isCompanionPaired)
          return unavailableFileListShortcut("companion-unavailable");
        if (selected.length === 1 && selected[0]!.entry.type === FileType.FILE) {
          return selected[0]!.handle.kind === "physical" || selected[0]!.handle.location.providerId === "zip"
            ? AVAILABLE_FILE_LIST_SHORTCUT
            : unavailableFileListShortcut("unsupported-source");
        }
        if (selected.some((item) => item.handle.kind !== sourceLocation.kind)) return unavailableFileListShortcut("unsupported-source");
        if (sourceLocation.kind === "virtual") {
          if (
            sourceLocation.providerId !== "zip" ||
            selected.some(
              (item) =>
                item.handle.kind !== "virtual" ||
                item.handle.location.providerId !== "zip" ||
                item.handle.location.source.path !== sourceLocation.source.path ||
                parentPath(item.handle.path) !== sourceLocation.path
            )
          )
            return unavailableFileListShortcut("unsupported-source");
          return AVAILABLE_FILE_LIST_SHORTCUT;
        }
        if (
          selected.some(
            (item) =>
              item.handle.location.connectionId !== sourceLocation.connectionId || parentPath(item.handle.path) !== sourceLocation.path
          )
        )
          return unavailableFileListShortcut("unsupported-source");
        return AVAILABLE_FILE_LIST_SHORTCUT;
      }

      if (action === "copy" && sourceLocation.kind === "virtual" && sourceLocation.providerId === "zip") {
        if (!isDualMode) return unavailableFileListShortcut("dual-pane-required");
        const unavailableMember = context.items.find((item) => !item.entry.is_readable);
        if (unavailableMember)
          return unavailableFileListShortcut(
            unavailableMember.entry.archive_entry_state === "blocked" ? "encrypted-archive-member" : "unsupported-archive-compression"
          );
        if (context.items.length === 0) return unavailableFileListShortcut("no-selection");
        return getArchiveExtractionShortcutAvailability(sourceLocation, destination);
      }

      if (action === "copy" || action === "move") {
        if (!isDualMode) return unavailableFileListShortcut("dual-pane-required");
        if (context.items.length === 0) return unavailableFileListShortcut("no-selection");
        if (action === "move" && sourceIsArchive) return unavailableFileListShortcut("archive-content-immutable");
        const unavailable = context.items
          .map((item) => getTransferAvailability({ kind: action, source: item.handle, destination }, contentOperationEnvironment))
          .find((availability) => !availability.available);
        return unavailable ? unavailableFileListShortcut(mapContentOperationReason(unavailable.reason)) : AVAILABLE_FILE_LIST_SHORTCUT;
      }

      if (action === "create-archive") {
        const availability = getCreateContainerAvailability(
          { sources: context.items.map((item) => item.handle), destination },
          contentOperationEnvironment
        );
        return availability.available
          ? AVAILABLE_FILE_LIST_SHORTCUT
          : unavailableFileListShortcut(mapContentOperationReason(availability.reason));
      }

      if (!context.focusedItem) return unavailableFileListShortcut("no-selection");
      if (sourceIsArchive || archiveExtractionSource === null) return unavailableFileListShortcut("unsupported-source");
      const extractionDestination = isDualMode
        ? destination
        : physicalLocation(archiveExtractionSource.source.connectionId, parentPath(archiveExtractionSource.source.path));
      return getArchiveExtractionShortcutAvailability(archiveExtractionSource, extractionDestination);
    },
    [
      allConnections,
      contentOperationEnvironment,
      conflictDialogOpen,
      copyMoveDialogOpen,
      getArchiveExtractionSourceForContext,
      getArchiveExtractionShortcutAvailability,
      getCapturedDestination,
      getOperationPolicyContext,
      getPaneForId,
      isBrowserBrowsing,
      isDualMode,
      isDownloading,
      fileShareState,
      uploadSessionActive,
      useCompactLayout,
    ]
  );
  const getUnavailableShortcutMessage = useCallback(
    (action: FileListShortcutAction, reason: FileListShortcutUnavailableReason): string => {
      if (reason === "dual-pane-required") return t("fileBrowser.unavailableShortcuts.dualPaneRequired");
      if (reason === "archive-content-immutable") return t("fileBrowser.unavailableShortcuts.archiveContentImmutable");
      if (reason === "encrypted-archive-member") return t("fileBrowser.archiveMembers.encrypted");
      if (reason === "unsupported-archive-compression") return t("fileBrowser.archiveMembers.unsupportedCompression");
      if (reason === "read-only-location") return t("fileBrowser.unavailableShortcuts.readOnlyLocation");
      if (reason === "companion-unavailable") return t("fileBrowser.unavailableShortcuts.companionUnavailable");
      if (reason === "interaction-blocked") return t("fileBrowser.unavailableShortcuts.interactionBlocked");
      if (reason === "share-files-only") return t("fileBrowser.share.filesOnly");
      if (reason === "share-unsupported") return t("viewer.share.unsupported");
      if (reason === "no-focused-item")
        return t(`fileBrowser.unavailableShortcuts.${action === "delete" ? "selectItemToDelete" : "selectItemToRename"}`);
      if (reason === "no-selection") {
        if (action === "share") return t("fileBrowser.share.selectFiles");
        if (action === "download") return t("fileBrowser.unavailableShortcuts.selectItemsToDownload");
        if (action === "create-archive") return t("fileBrowser.unavailableShortcuts.selectItemsToArchive");
        if (action === "extract-archive") return t("fileBrowser.unavailableShortcuts.selectArchiveToExtract");
        return t(`fileBrowser.unavailableShortcuts.${action === "move" ? "selectItemsToMove" : "selectItemsToCopy"}`);
      }
      if (action === "extract-archive" && reason === "unsupported-source")
        return t("fileBrowser.unavailableShortcuts.selectArchiveToExtract");
      if (action === "copy" && (activePaneIsArchive || activePaneIsVirtualArchive))
        return t("fileBrowser.unavailableShortcuts.archiveExtractionUnavailable");
      return t(`fileBrowser.unavailableShortcuts.${reason === "unsupported-destination" ? "destinationUnavailable" : "sourceUnavailable"}`);
    },
    [activePaneIsArchive, activePaneIsVirtualArchive, t]
  );
  const isActiveFileListKeyboardTarget = useCallback((): boolean => {
    if (
      settingsOpen ||
      mobileSettingsOpen ||
      drawerOpen ||
      showHelp ||
      viewerOverlayOpen ||
      activePane.deleteDialogOpen ||
      activePane.renameDialogOpen ||
      activePane.createDialogOpen ||
      copyMoveDialogOpen ||
      conflictDialogOpen ||
      archiveWorkflowDialogOpen
    ) {
      return false;
    }
    const activeElement = document.activeElement;
    const listContainer = activePane.listContainerEl;
    return Boolean(
      listContainer && activeElement instanceof Element && (activeElement === listContainer || listContainer.contains(activeElement))
    );
  }, [
    activePane.createDialogOpen,
    activePane.deleteDialogOpen,
    activePane.listContainerEl,
    activePane.renameDialogOpen,
    archiveWorkflowDialogOpen,
    conflictDialogOpen,
    copyMoveDialogOpen,
    drawerOpen,
    mobileSettingsOpen,
    settingsOpen,
    showHelp,
    viewerOverlayOpen,
  ]);
  const handleUnavailableShortcut = useCallback(
    (action: FileListShortcutAction, event: KeyboardEvent): boolean => {
      if (event.repeat || !isActiveFileListKeyboardTarget()) return false;
      const availability = getFileListShortcutAvailability(action);
      if (availability.available) return false;
      const message = getUnavailableShortcutMessage(action, availability.reason);
      setUnavailableShortcutNotice((current) => ({ id: (current?.id ?? 0) + 1, message }));
      return true;
    },
    [getFileListShortcutAvailability, getUnavailableShortcutMessage, isActiveFileListKeyboardTarget]
  );
  const hasVisibleLocalDrivePane =
    Boolean(leftPane.connectionId && isLocalDrive(leftPane.connectionId)) ||
    Boolean(isDualMode && rightPane.connectionId && isLocalDrive(rightPane.connectionId));

  useEffect(() => {
    if ((!isDualMode || !rightPane.connectionId) && quickBarPaneId === "right") {
      setQuickBarPaneId("left");
    }
  }, [isDualMode, quickBarPaneId, rightPane.connectionId]);

  useEffect(() => {
    const refreshQuickBarHistory = () => {
      if ((quickBarMode === "file-search" || quickBarMode === "navigate") && document.activeElement === quickBarInputRef.current) {
        setQuickBarRefreshToken((current) => current + 1);
      }
    };
    const refreshWhenVisible = () => {
      if (document.visibilityState === "visible") {
        refreshQuickBarHistory();
      }
    };
    window.addEventListener(RECENT_FILES_CHANGED_EVENT, refreshQuickBarHistory);
    window.addEventListener(RECENT_DIRECTORIES_CHANGED_EVENT, refreshQuickBarHistory);
    window.addEventListener("focus", refreshQuickBarHistory);
    document.addEventListener("visibilitychange", refreshWhenVisible);
    return () => {
      window.removeEventListener(RECENT_FILES_CHANGED_EVENT, refreshQuickBarHistory);
      window.removeEventListener(RECENT_DIRECTORIES_CHANGED_EVENT, refreshQuickBarHistory);
      window.removeEventListener("focus", refreshQuickBarHistory);
      document.removeEventListener("visibilitychange", refreshWhenVisible);
    };
  }, [quickBarInputRef, quickBarMode]);

  const refreshVisiblePanesAfterRecovery = useCallback(() => {
    if (leftPane.connectionIdRef.current) {
      void leftPane.reloadCurrentLocation({ forceRefresh: true, preserveVisibleContent: true });
    }

    if (paneMode === "dual" && rightPane.connectionIdRef.current) {
      void rightPane.reloadCurrentLocation({ forceRefresh: true, preserveVisibleContent: true });
    }
  }, [leftPane, paneMode, rightPane]);

  const previousBackendStatusRef = React.useRef(backendAvailability.status);

  useEffect(() => {
    const previousStatus = previousBackendStatusRef.current;
    previousBackendStatusRef.current = backendAvailability.status;

    if (backendAvailability.status !== "available") {
      return;
    }

    if (previousStatus === "available") {
      return;
    }

    refreshVisiblePanesAfterRecovery();
  }, [backendAvailability.status, refreshVisiblePanesAfterRecovery]);

  useEffect(() => {
    return subscribeBackendRecoveryReconnect(({ reason }) => {
      triggerServerReconnectRef.current(reason);
    });
  }, []);

  useEffect(() => {
    return subscribeBackendRecoveryConfirmed(() => {
      refreshVisiblePanesAfterRecovery();
    });
  }, [refreshVisiblePanesAfterRecovery]);

  const restoreInitialRecoverySnapshot = useCallback(() => {
    const snapshot = initialRecoverySnapshotRef.current;
    if (!snapshot || hasHydratedRecoverySnapshotRef.current) {
      return;
    }

    hasHydratedRecoverySnapshotRef.current = true;

    if (snapshot.routeUrl === location.pathname + location.search) {
      if (snapshot.left) leftPane.restoreRecoverySnapshot(snapshot.left);
      if (snapshot.right) rightPane.restoreRecoverySnapshot(snapshot.right);
    }
    setRecoveryPhase("ready");
  }, [leftPane, location.pathname, location.search, rightPane]);

  useEffect(() => {
    restoreInitialRecoverySnapshot();
  }, [restoreInitialRecoverySnapshot]);

  useEffect(() => {
    const leftSnapshot = leftPane.captureRecoverySnapshot();
    if (!leftSnapshot || leftPane.loading || leftPane.error) {
      return;
    }

    const leftTarget = buildBrowseRouteTarget(
      leftSnapshot.connectionId,
      leftSnapshot.path,
      allConnections,
      toVirtualRouteLocation(leftSnapshot.archiveLocation ?? null)
    );
    if (!leftTarget) {
      return;
    }

    const rightSnapshot = paneMode === "dual" && !rightPane.loading && !rightPane.error ? rightPane.captureRecoverySnapshot() : null;
    const rightTarget =
      rightSnapshot === null
        ? null
        : buildBrowseRouteTarget(
            rightSnapshot.connectionId,
            rightSnapshot.path,
            allConnections,
            toVirtualRouteLocation(rightSnapshot.archiveLocation ?? null)
          );

    const paneRoute = { left: leftTarget, right: rightTarget, activePaneId: rightTarget ? activePaneId : ("left" as const) };
    if (
      serializeBrowseRoute(paneRoute) !==
      serializeBrowseRoute({ left: currentRoute.left, right: currentRoute.right, activePaneId: currentRoute.activePaneId })
    )
      return;
    saveBrowserRecoverySnapshot({
      savedAt: Date.now(),
      routeUrl: serializeBrowseRoute(currentRoute),
      activePaneId: rightTarget ? activePaneId : "left",
      paneMode: rightTarget ? "dual" : "single",
      connections,
      left: { ...leftSnapshot, viewInfo: null },
      right: rightSnapshot ? { ...rightSnapshot, viewInfo: null } : null,
    });
  }, [
    activePaneId,
    allConnections,
    connections,
    currentRoute,
    leftPane.error,
    leftPane.loading,
    paneMode,
    rightPane.error,
    rightPane.loading,
    leftPane,
    rightPane,
  ]);

  // ──────────────────────────────────────────────────────────────────────────
  // API & Data Loading (Global)
  // ──────────────────────────────────────────────────────────────────────────

  const navigateToBrowseState = useCallback(
    (nextRoute: BrowseRouteState, options?: { replace?: boolean }) => {
      const nextUrl = serializeBrowseRoute({
        ...nextRoute,
        extraSearch: nextRoute.extraSearch ?? currentRoute.extraSearch,
        ...(options?.replace
          ? { viewer: nextRoute.viewer ?? currentRoute.viewer, settings: nextRoute.settings ?? currentRoute.settings }
          : {}),
      });
      const currentUrl = location.pathname + location.search;
      if (currentUrl === nextUrl) {
        return;
      }

      navigate(nextUrl + location.hash, { replace: options?.replace ?? false, state: location.state });
    },
    [currentRoute, location, navigate]
  );

  const getCurrentLeftTarget = useCallback(() => {
    return buildBrowseRouteTarget(
      leftPane.connectionIdRef.current,
      leftPane.currentPathRef.current,
      allConnections,
      toVirtualRouteLocation(leftPane.archiveLocation)
    );
  }, [allConnections, leftPane]);

  const getCurrentRightTarget = useCallback(() => {
    if (paneMode !== "dual") {
      return null;
    }

    return buildBrowseRouteTarget(
      rightPane.connectionIdRef.current,
      rightPane.currentPathRef.current,
      allConnections,
      toVirtualRouteLocation(rightPane.archiveLocation)
    );
  }, [allConnections, paneMode, rightPane]);

  const getSettledPaneTarget = useCallback(
    (paneId: PaneId) => {
      const pane = paneId === "left" ? leftPane : rightPane;
      if (pane.loading || pane.error) return null;
      const target = paneId === "left" ? getCurrentLeftTarget() : getCurrentRightTarget();
      const routeTarget = paneId === "left" ? currentRoute.left : currentRoute.right;
      if (!target || !routeTarget) return null;
      const serializeTarget = (left: typeof target) => serializeBrowseRoute({ left, right: null, activePaneId: "left" });
      return serializeTarget(target) === serializeTarget(routeTarget) ? target : null;
    },
    [currentRoute.left, currentRoute.right, getCurrentLeftTarget, getCurrentRightTarget, leftPane, rightPane]
  );
  const canOpenLocationInNewTab = !browserOverlayOpen && Boolean(getSettledPaneTarget(effectiveActivePaneId));
  const canOpenQuickBarLocationInNewTab =
    !browserOverlayOpen && Boolean(getSettledPaneTarget(quickBarPaneId === "right" && isDualMode ? "right" : "left"));
  const canMatchPaneLocations = !browserOverlayOpen && isDualMode && Boolean(getSettledPaneTarget("left") && getSettledPaneTarget("right"));

  const handleOpenLocationInNewTab = useCallback(
    (paneId: PaneId) => {
      if (browserOverlayOpen) return;
      const target = getSettledPaneTarget(paneId);
      if (!target) return;
      openExternalUrl(serializeBrowseRoute({ left: target, right: null, activePaneId: "left" }));
    },
    [browserOverlayOpen, getSettledPaneTarget]
  );

  const handleMatchPaneLocation = useCallback(
    (destinationPaneId: PaneId) => {
      if (!canMatchPaneLocations) return;
      if (areSameContentLocations(getPaneForId("left").currentLocation, getPaneForId("right").currentLocation)) return;
      const source = getSettledPaneTarget(destinationPaneId === "left" ? "right" : "left");
      if (!source) return;
      navigateToBrowseState({ left: source, right: source, activePaneId: effectiveActivePaneId });
    },
    [canMatchPaneLocations, effectiveActivePaneId, getPaneForId, getSettledPaneTarget, navigateToBrowseState]
  );

  const handleUnavailableLocationShortcut = useCallback(
    (event: KeyboardEvent, requiresDualPane: boolean): boolean => {
      if (event.repeat || !isActiveFileListKeyboardTarget()) return false;
      const message = t(
        requiresDualPane && !isDualMode
          ? "fileBrowser.unavailableShortcuts.dualPaneRequired"
          : "fileBrowser.unavailableShortcuts.locationUnavailable"
      );
      setUnavailableShortcutNotice((current) => ({ id: (current?.id ?? 0) + 1, message }));
      return true;
    },
    [isActiveFileListKeyboardTarget, isDualMode, t]
  );

  const navigateLeftPane = useCallback(
    (connectionId: string, path: string, options?: { replace?: boolean; activePaneId?: PaneId }) => {
      const leftTarget = buildBrowseRouteTarget(connectionId, path, allConnections);
      if (!leftTarget) {
        navigate("/browse", { replace: options?.replace ?? false });
        return;
      }

      const rightTarget = getCurrentRightTarget();
      navigateToBrowseState(
        {
          left: leftTarget,
          right: rightTarget,
          activePaneId: rightTarget ? (options?.activePaneId ?? activePaneId) : "left",
        },
        options
      );
    },
    [activePaneId, allConnections, getCurrentRightTarget, navigate, navigateToBrowseState]
  );

  const navigateRightPane = useCallback(
    (connectionId: string, path: string, options?: { replace?: boolean; activePaneId?: PaneId }) => {
      const leftTarget = getCurrentLeftTarget();
      const rightTarget = buildBrowseRouteTarget(connectionId, path, allConnections);
      if (!leftTarget || !rightTarget) {
        return;
      }

      navigateToBrowseState(
        {
          left: leftTarget,
          right: rightTarget,
          activePaneId: options?.activePaneId ?? activePaneId,
        },
        options
      );
    },
    [activePaneId, allConnections, getCurrentLeftTarget, navigateToBrowseState]
  );

  const navigateLeftVirtualLocation = useCallback(
    (virtualLocation: VirtualRouteLocation | null) => {
      const leftTarget = buildBrowseRouteTarget(
        leftPane.connectionIdRef.current,
        leftPane.currentPathRef.current,
        allConnections,
        virtualLocation
      );
      if (!leftTarget) {
        return;
      }

      const rightTarget = getCurrentRightTarget();
      navigateToBrowseState({ left: leftTarget, right: rightTarget, activePaneId: "left" });
    },
    [allConnections, getCurrentRightTarget, leftPane, navigateToBrowseState]
  );

  const navigateRightVirtualLocation = useCallback(
    (virtualLocation: VirtualRouteLocation | null) => {
      const leftTarget = getCurrentLeftTarget();
      const rightTarget = buildBrowseRouteTarget(
        rightPane.connectionIdRef.current,
        rightPane.currentPathRef.current,
        allConnections,
        virtualLocation
      );
      if (!leftTarget || !rightTarget) {
        return;
      }

      navigateToBrowseState({ left: leftTarget, right: rightTarget, activePaneId: "right" });
    },
    [allConnections, getCurrentLeftTarget, navigateToBrowseState, rightPane]
  );

  const resolveLeftRouteLocation = useCallback(
    (path: string, archiveLocation: ArchiveLocation | null) => {
      const leftTarget = buildBrowseRouteTarget(
        leftPane.connectionIdRef.current,
        path,
        allConnections,
        toVirtualRouteLocation(archiveLocation)
      );
      if (!leftTarget) {
        return;
      }

      navigateToBrowseState({ left: leftTarget, right: getCurrentRightTarget(), activePaneId }, { replace: true });
    },
    [activePaneId, allConnections, getCurrentRightTarget, leftPane, navigateToBrowseState]
  );

  const resolveRightRouteLocation = useCallback(
    (path: string, archiveLocation: ArchiveLocation | null) => {
      const leftTarget = getCurrentLeftTarget();
      const rightTarget = buildBrowseRouteTarget(
        rightPane.connectionIdRef.current,
        path,
        allConnections,
        toVirtualRouteLocation(archiveLocation)
      );
      if (!leftTarget || !rightTarget) {
        return;
      }

      navigateToBrowseState({ left: leftTarget, right: rightTarget, activePaneId }, { replace: true });
    },
    [activePaneId, allConnections, getCurrentLeftTarget, navigateToBrowseState, rightPane]
  );

  const replaceActivePaneInRoute = useCallback(
    (nextActivePaneId: PaneId) => {
      const leftTarget = getCurrentLeftTarget();
      const rightTarget = getCurrentRightTarget();
      if (!leftTarget || !rightTarget) {
        return;
      }

      setActivePaneId(nextActivePaneId);
      navigateToBrowseState(
        {
          left: leftTarget,
          right: rightTarget,
          activePaneId: nextActivePaneId,
        },
        { replace: true }
      );
    },
    [getCurrentLeftTarget, getCurrentRightTarget, navigateToBrowseState]
  );

  leftPathNavigateRef.current = (path) => {
    const connectionId = leftPane.connectionIdRef.current;
    if (!connectionId) {
      return;
    }

    navigateLeftPane(connectionId, path, { activePaneId: "left" });
  };

  rightPathNavigateRef.current = (path) => {
    const connectionId = rightPane.connectionIdRef.current;
    if (!connectionId) {
      return;
    }

    navigateRightPane(connectionId, path, { activePaneId: "right" });
  };

  leftConnectionNavigateRef.current = (connectionId) => {
    navigateLeftPane(connectionId, "", { activePaneId: paneMode === "dual" ? activePaneId : "left" });
  };

  rightConnectionNavigateRef.current = (connectionId) => {
    navigateRightPane(connectionId, "", { activePaneId: "right" });
  };

  leftDirectoryNavigateRef.current = (connectionId, path) => {
    navigateLeftPane(connectionId, path, { activePaneId: "left" });
  };

  rightDirectoryNavigateRef.current = (connectionId, path) => {
    navigateRightPane(connectionId, path, { activePaneId: "right" });
  };

  leftVirtualLocationNavigateRef.current = navigateLeftVirtualLocation;
  rightVirtualLocationNavigateRef.current = navigateRightVirtualLocation;
  leftRouteLocationResolveRef.current = resolveLeftRouteLocation;
  rightRouteLocationResolveRef.current = resolveRightRouteLocation;

  const leftApplyLocation = leftPane.applyLocation;
  const rightApplyLocation = rightPane.applyLocation;
  const leftListContainerEl = leftPane.listContainerEl;
  const rightListContainerEl = rightPane.listContainerEl;

  const seedRightPaneFromLeftIfSameDirectory = useCallback(() => {
    const leftConnectionId = leftPane.connectionIdRef.current;
    const leftPath = leftPane.currentPathRef.current;

    if (!leftConnectionId || leftPane.loading || leftPane.error) {
      return;
    }

    rightPane.seedDirectorySnapshot(leftConnectionId, leftPath, leftPane.files);
  }, [leftPane.connectionIdRef, leftPane.currentPathRef, leftPane.error, leftPane.files, leftPane.loading, rightPane]);

  const reconcileBootstrapRoute = useCallback(
    (loadedConnections: Connection[], persistedSelectedConnectionId: string | null) => {
      if ((params.targetType || params.targetId) && !currentRoute.left) {
        navigate("/browse", { replace: true });
        return;
      }

      if (currentRoute.left?.kind === "smb" && !loadedConnections.some((connection) => connection.slug === currentRoute.left?.targetId)) {
        navigate("/browse", { replace: true });
        return;
      }

      if (currentRoute.right?.kind === "smb" && !loadedConnections.some((connection) => connection.slug === currentRoute.right?.targetId)) {
        navigateToBrowseState(
          {
            left: currentRoute.left,
            right: null,
            activePaneId: "left",
          },
          { replace: true }
        );
        return;
      }

      if (currentRoute.left) {
        return;
      }

      const savedConnectionId = persistedSelectedConnectionId ?? readSelectedConnectionIdPreference();
      const autoSelectedConnectionId =
        savedConnectionId &&
        (isLocalDrive(savedConnectionId) || loadedConnections.some((connection) => connection.id === savedConnectionId))
          ? savedConnectionId
          : loadedConnections[0]?.id;

      if (autoSelectedConnectionId) {
        navigateToBrowseState(
          {
            left: buildBrowseRouteTarget(autoSelectedConnectionId, "", mergeConnections(loadedConnections, companion.drives)),
            right: null,
            activePaneId: "left",
          },
          { replace: true }
        );
      }
    },
    [companion.drives, currentRoute.left, currentRoute.right, navigate, navigateToBrowseState, params.targetId, params.targetType]
  );

  /**
   * loadConnections
   *
   * `bootstrap` is allowed to change route/loading UI for a cold start.
   * `background-revalidate` refreshes connection metadata without disturbing the current browser UI.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: setConnectionId and setError are stable React state setters from the pane hook
  const loadConnections = useCallback(
    async (mode: "bootstrap" | "background-revalidate") => {
      const preserveVisibleUi = mode === "background-revalidate";

      try {
        if (!preserveVisibleUi) {
          setLoadingConnections(true);
        }

        const token = authSession.getAccessToken();
        if (!token) {
          const { isAuthRequired } = await import("../services/authConfig");
          const authRequired = await isAuthRequired();
          if (authRequired) {
            if (!preserveVisibleUi) {
              navigate(loginPath(window.location.pathname + window.location.search));
            }
            return;
          }
        }

        await logger.initializeBackendTracing();

        await refreshCurrentUserSettings();
        const persistedSelectedConnectionId = getConfirmedCurrentUserSetting("browser.selected_connection_id") ?? null;

        const data = await browserContentServices.connections.getConnections();
        setConnections(data);

        if (preserveVisibleUi) {
          return;
        }

        reconcileBootstrapRoute(data, persistedSelectedConnectionId);
      } catch (err: unknown) {
        logger.error("Error loading connections", { error: err }, "browser");
        if (preserveVisibleUi) return;
        if (isApiError(err)) {
          if (err.response?.status === 401) {
            navigate(loginPath(window.location.pathname + window.location.search));
          } else if (err.response?.status === 403) {
            leftPane.setError("Access denied. Please contact an administrator to configure connections.");
          } else {
            leftPane.setError("Failed to load connections. Please try again.");
          }
        } else {
          leftPane.setError("Failed to load connections. Please try again.");
        }
      } finally {
        if (!preserveVisibleUi) {
          setLoadingConnections(false);
        }
      }
    },
    [navigate, reconcileBootstrapRoute]
  );

  // ──────────────────────────────────────────────────────────────────────────
  // Component Lifecycle Effects
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    scheduleRuntimeWarmup();
  }, []);

  // Initial load - run once on mount.
  // biome-ignore lint/correctness/useExhaustiveDependencies: intentionally run only once on mount to avoid aborting requests
  useEffect(() => {
    if (hasStartedInitialConnectionLoadRef.current) {
      return;
    }

    hasStartedInitialConnectionLoadRef.current = true;
    const initialLoadMode = initialRecoverySnapshotRef.current !== null ? "background-revalidate" : "bootstrap";
    void loadConnections(initialLoadMode);
  }, []);

  useEffect(() => {
    if (loadingConnections || recoveryPhase !== "ready") {
      return;
    }

    const routeSyncToken = routeSyncTokenRef.current + 1;
    routeSyncTokenRef.current = routeSyncToken;

    leftApplyLocation(resolvedRoute.left?.connectionId ?? "", resolvedRoute.left?.path ?? "", routeSyncToken);
    rightApplyLocation(resolvedRoute.right?.connectionId ?? "", resolvedRoute.right?.path ?? "", routeSyncToken);

    const nextPaneMode: PaneMode = resolvedRoute.right ? "dual" : "single";
    const nextActivePaneId: PaneId = resolvedRoute.right ? resolvedRoute.activePaneId : "left";

    setPaneMode((currentPaneMode) => (currentPaneMode === nextPaneMode ? currentPaneMode : nextPaneMode));
    setActivePaneId((currentActivePaneId) => (currentActivePaneId === nextActivePaneId ? currentActivePaneId : nextActivePaneId));

    setFileBrowserPaneModePreference(nextPaneMode);
    localStorage.setItem(ACTIVE_PANE_STORAGE_KEY, nextActivePaneId);

    if (pendingPaneFocusRef.current !== nextActivePaneId) {
      pendingPaneFocusRef.current = null;
    }
  }, [leftApplyLocation, loadingConnections, recoveryPhase, resolvedRoute, rightApplyLocation]);

  useEffect(() => {
    if (pendingPaneFocusRef.current !== activePaneId) {
      return;
    }

    window.setTimeout(() => {
      if (activePaneId === "right") {
        rightListContainerEl?.focus();
      } else {
        leftListContainerEl?.focus();
      }

      pendingPaneFocusRef.current = null;
    }, 0);
  }, [activePaneId, leftListContainerEl, rightListContainerEl]);

  // ──────────────────────────────────────────────────────────────────────────
  // WebSocket Real-Time Updates
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * WebSocket connection for real-time directory change notifications.
   * Features:
   * - Automatic reconnection with an adaptive backoff ladder on disconnect
   * - Cache invalidation when remote changes detected
   * - Selective directory subscription based on current path
   *
   * The socket is tracked in a local variable (`activeWs`) rather than only
   * in `wsRef`, because `wsRef.current` is set inside the async `onopen`
   * callback. If cleanup runs before `onopen` fires (React StrictMode
   * double-mount or Vite HMR), `wsRef.current` would still be `null` and
   * the socket would leak. `disposed` prevents reconnection after unmount.
   */
  const handleRealtimeDirectoryChange = (change: DirectoryChange) => {
    const deferReload = deferDirectoryChange(change.connectionId, change.path);
    leftPane.handleDirectoryChanged(change, { invalidateOnly: deferReload });
    rightPane.handleDirectoryChanged(change, { invalidateOnly: deferReload });
  };

  const handleSubscriptionReply = (ws: WebSocket, message: RealtimeMessage) => {
    if (message.type !== "subscribed" && message.type !== "subscription_error") return;
    const key = getDirectorySubscriptionKey(message.change);
    const request = subscriptionRequestsRef.current.get(key);
    if (request?.socket !== ws || request.requestId !== message.requestId) return;
    const requested = isLocalDrive(message.change.connectionId)
      ? companionAppliedSubscriptionsRef.current
      : serverAppliedSubscriptionsRef.current;
    if (!requested.has(key)) return;
    window.clearTimeout(request.timeoutId);
    if (message.type === "subscribed") {
      acknowledgedSubscriptionsRef.current.set(key, ws);
      leftPaneRef.current.handleDirectorySubscribed?.(message.change);
      rightPaneRef.current.handleDirectorySubscribed?.(message.change);
      return;
    }
    requested.delete(key);
    subscriptionRequestsRef.current.delete(key);
    acknowledgedSubscriptionsRef.current.delete(key);
    if (message.code === "directory_not_found") handleRealtimeDirectoryChange(message.change);
    else {
      leftPaneRef.current.handleDirectorySubscriptionError?.(message.change, message.code);
      rightPaneRef.current.handleDirectorySubscriptionError?.(message.change, message.code);
    }
  };

  const clearSocketSubscriptions = (socket: WebSocket) => {
    for (const [key, request] of subscriptionRequestsRef.current) {
      if (request.socket !== socket) continue;
      window.clearTimeout(request.timeoutId);
      subscriptionRequestsRef.current.delete(key);
      acknowledgedSubscriptionsRef.current.delete(key);
    }
  };

  const requestDirectorySubscription = React.useEffectEvent((socket: WebSocket, sub: DirectorySubscription) => {
    const requestId = crypto.randomUUID();
    const timeoutId = window.setTimeout(
      () =>
        handleSubscriptionReply(socket, {
          type: "subscription_error",
          change: sub,
          requestId,
          code: "directory_timeout",
        }),
      DIRECTORY_SUBSCRIPTION_ACK_TIMEOUT_MS
    );
    subscriptionRequestsRef.current.set(getDirectorySubscriptionKey(sub), { socket, requestId, timeoutId });
    socket.send(JSON.stringify({ action: "subscribe", connection_id: sub.connectionId, path: sub.path, request_id: requestId }));
  });

  // biome-ignore lint/correctness/useExhaustiveDependencies: WebSocket created once on mount. handleDirectoryChanged refs are stable.
  useEffect(() => {
    let disposed = false;
    let activeWs: WebSocket | null = null;

    const clearReconnectTimer = () => {
      if (reconnectTimeoutRef.current !== null) {
        window.clearTimeout(reconnectTimeoutRef.current);
        reconnectTimeoutRef.current = null;
      }
    };

    const scheduleReconnect = (reason: string, immediate = false) => {
      if (disposed) {
        return;
      }

      clearReconnectTimer();
      const delayMs = immediate
        ? 0
        : SERVER_WEBSOCKET_RECONNECT_DELAYS_MS[
            Math.min(serverReconnectAttemptRef.current, SERVER_WEBSOCKET_RECONNECT_DELAYS_MS.length - 1)
          ];

      if (!immediate) {
        serverReconnectAttemptRef.current += 1;
      }

      reconnectTimeoutRef.current = window.setTimeout(() => {
        reconnectTimeoutRef.current = null;
        connectWebSocket(reason);
      }, delayMs);
    };

    const connectWebSocket = (reason = "initial") => {
      if (disposed) return;

      clearReconnectTimer();

      const accessToken = authSession.getAccessToken();
      const wsUrl = buildServerWebSocketUrl(window.location, accessToken);
      const wsLogUrl = getSafeWebSocketLogUrl(wsUrl);

      logger.info("Connecting to WebSocket", { wsUrl: wsLogUrl, reason }, "websocket");
      const ws = new WebSocket(wsUrl);
      activeWs = ws;

      ws.onopen = () => {
        if (disposed || activeWs !== ws) {
          ws.close();
          return;
        }
        serverReconnectAttemptRef.current = 0;
        markBackendAvailable();
        logger.info("WebSocket connected", { wsUrl: wsLogUrl }, "websocket");
        wsRef.current = ws;
        setServerDirectoryWs(ws);
      };

      ws.onmessage = (event) => {
        if (disposed || activeWs !== ws) return;
        const message = parseRealtimeMessage(event.data);
        if (!message) {
          logger.warn("Ignoring malformed WebSocket message", undefined, "websocket");
          return;
        }
        handleSubscriptionReply(ws, message);
        if (
          message.type === "directory_changed" &&
          acknowledgedSubscriptionsRef.current.get(getDirectorySubscriptionKey(message.change)) === ws
        ) {
          handleRealtimeDirectoryChange(message.change);
        } else if (message.type === "transfer_progress") {
          if (message.transferAttemptId === activeTransferAttemptRef.current && message.bytesTransferred >= 0) {
            setCopyMoveTransferProgress({
              bytesTransferred: message.bytesTransferred,
              totalBytes: message.totalBytes,
              itemName: message.itemName,
            });
          }
        }
      };

      ws.onerror = (error) => {
        if (disposed || activeWs !== ws) {
          return;
        }
        logger.error("WebSocket error", { wsUrl: wsLogUrl, error: String(error) }, "websocket");
      };

      ws.onclose = () => {
        clearSocketSubscriptions(ws);
        if (activeWs !== ws) return;
        if (disposed) {
          if (activeWs === ws) {
            activeWs = null;
          }
          wsRef.current = null;
          serverAppliedSubscriptionsRef.current = new Map();
          setServerDirectoryWs((current) => (current === ws ? null : current));
          return;
        }

        logger.warn("WebSocket disconnected", { wsUrl: wsLogUrl, willReconnect: !disposed }, "websocket");
        if (activeWs === ws) {
          activeWs = null;
        }
        wsRef.current = null;
        serverAppliedSubscriptionsRef.current = new Map();
        setServerDirectoryWs((current) => (current === ws ? null : current));

        if (!disposed) {
          scheduleReconnect("socket-close");
        }
      };
    };

    triggerServerReconnectRef.current = (reason: string) => {
      if (disposed) {
        return;
      }

      serverReconnectAttemptRef.current = 0;
      clearReconnectTimer();

      if (activeWs) {
        const previousSocket = activeWs;
        activeWs = null;
        clearSocketSubscriptions(previousSocket);
        previousSocket.close();
        wsRef.current = null;
        serverAppliedSubscriptionsRef.current = new Map();
        setServerDirectoryWs(null);
      }

      scheduleReconnect(reason, true);
    };

    scheduleReconnect("initial", true);

    return () => {
      disposed = true;
      clearReconnectTimer();
      // Close the locally-tracked socket — works even if onopen hasn't fired yet
      if (activeWs) {
        clearSocketSubscriptions(activeWs);
        activeWs.close();
        activeWs = null;
      }
      wsRef.current = null;
      serverAppliedSubscriptionsRef.current = new Map();
      setServerDirectoryWs(null);
      triggerServerReconnectRef.current = () => undefined;
    };
  }, []);

  /**
   * Companion WebSocket for real-time local drive change notifications.
   *
   * Only connects when the companion is paired. Uses HMAC query-param auth
   * since the browser WebSocket API does not support custom headers.
   * Reconnects independently from the server WebSocket.
   */
  // biome-ignore lint/correctness/useExhaustiveDependencies: handleDirectoryChanged refs are stable; companion/local pane state drives connect/disconnect.
  useEffect(() => {
    if (companion.status !== "paired" || !hasVisibleLocalDrivePane) return;

    let disposed = false;
    let activeWs: WebSocket | null = null;
    let connectTimeoutId: number | null = null;

    const clearConnectTimeout = () => {
      if (connectTimeoutId !== null) {
        window.clearTimeout(connectTimeoutId);
        connectTimeoutId = null;
      }
    };

    const scheduleReconnect = () => {
      if (disposed || companionReconnectRef.current !== null) {
        return;
      }

      companionReconnectRef.current = window.setTimeout(() => {
        companionReconnectRef.current = null;
        void connectCompanionWs();
      }, COMPANION_WEBSOCKET_RECONNECT_DELAY_MS);
    };

    const connectCompanionWs = async () => {
      if (disposed) return;

      const wsUrl = await browserContentServices.connections.getCompanionWebSocketUrl();
      if (!wsUrl || disposed) return;

      logger.info("Connecting to companion WebSocket", { wsUrl: getSafeWebSocketLogUrl(wsUrl) }, "websocket");
      const ws = new WebSocket(wsUrl);
      activeWs = ws;

      const connectStartedAt = Date.now();
      clearConnectTimeout();
      connectTimeoutId = window.setTimeout(() => {
        if (disposed || activeWs !== ws || ws.readyState !== WebSocket.CONNECTING) {
          return;
        }

        logger.warn(
          "Companion WebSocket connection attempt timed out; closing stale socket before auth expires",
          {
            elapsedMs: Date.now() - connectStartedAt,
            timeoutMs: COMPANION_WEBSOCKET_CONNECT_TIMEOUT_MS,
          },
          "websocket"
        );
        ws.close();
      }, COMPANION_WEBSOCKET_CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        clearConnectTimeout();
        if (disposed) {
          ws.close();
          return;
        }
        logger.info("Companion WebSocket connected", {}, "websocket");
        companionWsRef.current = ws;
        setCompanionDirectoryWs(ws);
      };

      ws.onmessage = (event) => {
        if (disposed || activeWs !== ws) return;
        const message = parseRealtimeMessage(event.data);
        if (!message) {
          logger.warn("Ignoring malformed companion WebSocket message", undefined, "websocket");
          return;
        }
        handleSubscriptionReply(ws, message);
        if (
          message.type === "directory_changed" &&
          acknowledgedSubscriptionsRef.current.get(getDirectorySubscriptionKey(message.change)) === ws
        ) {
          handleRealtimeDirectoryChange(message.change);
        }
      };

      ws.onerror = (error) => {
        logger.error("Companion WebSocket error", { error: String(error) }, "websocket");
      };

      ws.onclose = () => {
        clearSocketSubscriptions(ws);
        if (activeWs !== ws) return;
        clearConnectTimeout();
        if (disposed) {
          if (activeWs === ws) {
            activeWs = null;
          }
          companionWsRef.current = null;
          companionAppliedSubscriptionsRef.current = new Map();
          setCompanionDirectoryWs((current) => (current === ws ? null : current));
          return;
        }

        logger.warn("Companion WebSocket disconnected", { willReconnect: !disposed }, "websocket");
        if (activeWs === ws) {
          activeWs = null;
        }
        companionWsRef.current = null;
        companionAppliedSubscriptionsRef.current = new Map();
        setCompanionDirectoryWs((current) => (current === ws ? null : current));

        scheduleReconnect();
      };
    };

    void connectCompanionWs();

    return () => {
      disposed = true;
      clearConnectTimeout();
      if (companionReconnectRef.current) {
        clearTimeout(companionReconnectRef.current);
        companionReconnectRef.current = null;
      }
      if (activeWs) {
        clearSocketSubscriptions(activeWs);
        activeWs.close();
        activeWs = null;
      }
      companionWsRef.current = null;
      companionAppliedSubscriptionsRef.current = new Map();
      setCompanionDirectoryWs(null);
    };
  }, [companion.status, hasVisibleLocalDrivePane]);

  useEffect(() => {
    if (!serverDirectoryWs) {
      serverAppliedSubscriptionsRef.current = new Map();
      return;
    }

    return () => {
      if (serverDirectoryWs.readyState === WebSocket.OPEN) {
        for (const sub of serverAppliedSubscriptionsRef.current.values()) {
          serverDirectoryWs.send(JSON.stringify({ action: "unsubscribe", connection_id: sub.connectionId, path: sub.path }));
        }
      }

      serverAppliedSubscriptionsRef.current = new Map();
    };
  }, [serverDirectoryWs]);

  // Subscribe/unsubscribe server-backed pane directories when the server
  // websocket changes or visible SMB targets change.
  useEffect(() => {
    if (serverDirectoryWs?.readyState !== WebSocket.OPEN) {
      return;
    }

    const desiredSubscriptions = collectDirectorySubscriptions({
      left: leftPane.monitoredLocation ?? { connectionId: "", path: "" },
      right: rightPane.monitoredLocation ?? { connectionId: "", path: "" },
      isDualMode,
      includeLocalDrives: false,
    });
    const nextSubscriptions = createDirectorySubscriptionMap(desiredSubscriptions);
    const { removedSubscriptions, addedSubscriptions } = diffDirectorySubscriptions(
      serverAppliedSubscriptionsRef.current,
      nextSubscriptions
    );

    for (const sub of removedSubscriptions) {
      const key = getDirectorySubscriptionKey(sub);
      window.clearTimeout(subscriptionRequestsRef.current.get(key)?.timeoutId);
      subscriptionRequestsRef.current.delete(key);
      acknowledgedSubscriptionsRef.current.delete(key);
      serverDirectoryWs.send(JSON.stringify({ action: "unsubscribe", connection_id: sub.connectionId, path: sub.path }));
    }

    for (const sub of addedSubscriptions) {
      requestDirectorySubscription(serverDirectoryWs, sub);
    }

    serverAppliedSubscriptionsRef.current = nextSubscriptions;
  }, [leftPane.monitoredLocation, rightPane.monitoredLocation, isDualMode, serverDirectoryWs]);

  useEffect(() => {
    if (!companionDirectoryWs) {
      companionAppliedSubscriptionsRef.current = new Map();
      return;
    }

    return () => {
      if (companionDirectoryWs.readyState === WebSocket.OPEN) {
        for (const sub of companionAppliedSubscriptionsRef.current.values()) {
          companionDirectoryWs.send(JSON.stringify({ action: "unsubscribe", connection_id: sub.connectionId, path: sub.path }));
        }
      }

      companionAppliedSubscriptionsRef.current = new Map();
    };
  }, [companionDirectoryWs]);

  // Subscribe/unsubscribe local-drive pane directories when the companion
  // websocket changes or visible local targets change.
  useEffect(() => {
    if (companionDirectoryWs?.readyState !== WebSocket.OPEN) {
      return;
    }

    const desiredSubscriptions = collectDirectorySubscriptions({
      left: leftPane.monitoredLocation ?? { connectionId: "", path: "" },
      right: rightPane.monitoredLocation ?? { connectionId: "", path: "" },
      isDualMode,
      includeLocalDrives: true,
    });
    const nextSubscriptions = createDirectorySubscriptionMap(desiredSubscriptions);
    const { removedSubscriptions, addedSubscriptions } = diffDirectorySubscriptions(
      companionAppliedSubscriptionsRef.current,
      nextSubscriptions
    );

    for (const sub of removedSubscriptions) {
      const key = getDirectorySubscriptionKey(sub);
      window.clearTimeout(subscriptionRequestsRef.current.get(key)?.timeoutId);
      subscriptionRequestsRef.current.delete(key);
      acknowledgedSubscriptionsRef.current.delete(key);
      companionDirectoryWs.send(JSON.stringify({ action: "unsubscribe", connection_id: sub.connectionId, path: sub.path }));
    }

    for (const sub of addedSubscriptions) {
      requestDirectorySubscription(companionDirectoryWs, sub);
    }

    companionAppliedSubscriptionsRef.current = nextSubscriptions;
  }, [leftPane.monitoredLocation, rightPane.monitoredLocation, isDualMode, companionDirectoryWs]);

  // ──────────────────────────────────────────────────────────────────────────
  // Dual-Pane Handlers
  // ──────────────────────────────────────────────────────────────────────────

  /** Toggle between single and dual-pane mode. */
  const handleToggleDualPane = useCallback(() => {
    const leftTarget = getCurrentLeftTarget();
    if (!leftTarget) {
      return;
    }

    if (!resolvedRoute.right) {
      seedRightPaneFromLeftIfSameDirectory();
      pendingPaneFocusRef.current = "right";
      navigateToBrowseState({
        left: leftTarget,
        right: buildBrowseRouteTarget(
          leftPane.connectionIdRef.current,
          leftPane.currentPathRef.current,
          allConnections,
          toVirtualRouteLocation(leftPane.archiveLocation)
        ),
        activePaneId: "right",
      });
    } else {
      pendingPaneFocusRef.current = "left";
      navigateToBrowseState({
        left: leftTarget,
        right: null,
        activePaneId: "left",
      });
    }
  }, [allConnections, getCurrentLeftTarget, leftPane, navigateToBrowseState, resolvedRoute.right, seedRightPaneFromLeftIfSameDirectory]);

  /** Switch focus to the other pane (Tab in dual mode). */
  const handleSwitchPane = useCallback(() => {
    if (!isDualMode) return;
    const currentId = effectiveActivePaneIdRef.current;
    const nextId: PaneId = currentId === "left" ? "right" : "left";
    replaceActivePaneInRoute(nextId);
    const nextPane = nextId === "left" ? leftPane : rightPane;
    setTimeout(() => nextPane.listContainerEl?.focus(), 0);
  }, [isDualMode, leftPane, replaceActivePaneInRoute, rightPane]);

  /** Focus the left pane (Ctrl+1). Opens dual mode from single if Ctrl+2 is used. */
  const handleFocusLeftPane = useCallback(() => {
    if (paneMode === "dual") {
      replaceActivePaneInRoute("left");
    }
    setTimeout(() => leftPane.listContainerEl?.focus(), 0);
  }, [leftPane, paneMode, replaceActivePaneInRoute]);

  /** Focus the right pane (Ctrl+2). Opens dual mode if currently in single. */
  const handleFocusRightPane = useCallback(() => {
    const leftTarget = getCurrentLeftTarget();
    if (!leftTarget) {
      return;
    }

    if (paneMode === "single") {
      seedRightPaneFromLeftIfSameDirectory();
      navigateToBrowseState({
        left: leftTarget,
        right: buildBrowseRouteTarget(
          leftPane.connectionIdRef.current,
          leftPane.currentPathRef.current,
          allConnections,
          toVirtualRouteLocation(leftPane.archiveLocation)
        ),
        activePaneId: "right",
      });
    } else {
      replaceActivePaneInRoute("right");
    }
    setTimeout(() => rightPane.listContainerEl?.focus(), 0);
  }, [
    allConnections,
    getCurrentLeftTarget,
    leftPane,
    navigateToBrowseState,
    paneMode,
    replaceActivePaneInRoute,
    rightPane,
    seedRightPaneFromLeftIfSameDirectory,
  ]);

  // ──────────────────────────────────────────────────────────────────────────
  // Copy / Move Handlers
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Open the copy/move dialog with the effective selection from the active pane.
   * The destination is pre-filled from the other pane's current directory.
   */
  const handleOpenCopyMoveDialog = useCallback(
    (mode: CopyMoveMode, invocation?: FileOperationInvocationContext) => {
      if (!isDualModeRef.current || uploadSessionActive) return;

      const sourcePaneId = invocation?.paneId ?? effectiveActivePaneIdRef.current;
      const sourcePane = getPaneForId(sourcePaneId);
      const capturedDestination = invocation?.destination ?? getCapturedDestination(sourcePaneId);
      const items = invocation?.items ?? sourcePane.getEffectiveSelection();
      const destination = capturedDestination.location;
      if (
        items.length === 0 ||
        !items.every(
          (item) => getTransferAvailability({ kind: mode, source: item.handle, destination }, contentOperationEnvironment).available
        )
      ) {
        return;
      }

      setCopyMoveMode(mode);
      setCopyMoveItems([...items]);
      setCopyMoveSourcePaneId(sourcePaneId);
      setCopyMoveDestination(destination);
      setCopyMoveDestinationLabel(
        getLocationDisplayName(destination, (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId)
      );
      setCopyMoveSameDirectory(areSameContentLocations(sourcePane.currentLocation, destination));
      setCopyMoveDestinationPaneId(capturedDestination.paneId);
      setCopyMoveError(null);
      setCopyMoveWarning(null);
      setCopyMoveProgress(undefined);
      setCopyMoveTransferProgress(null);
      setCopyMoveProcessing(false);
      setCopyMoveDialogOpen(true);
    },
    [allConnections, contentOperationEnvironment, getCapturedDestination, getPaneForId, uploadSessionActive]
  );

  /** Open the move dialog (F6). */
  const handleMoveToOtherPane = useCallback(
    (invocation?: FileOperationInvocationContext) => handleOpenCopyMoveDialog("move", invocation),
    [handleOpenCopyMoveDialog]
  );

  /**
   * Execute the copy/move operation for all selected files sequentially.
   * Shows progress per file. Both panes refresh via WebSocket after completion.
   */
  const handleCopyMoveConfirm = useCallback(
    async (destFileName: string | undefined) => {
      if (copyMoveItems.length === 0 || !copyMoveDestination) return;

      setCopyMoveProcessing(true);
      setCopyMoveError(null);
      setCopyMoveWarning(null);
      setCopyMoveTransferProgress(null);
      setCopyMoveProgress({ current: 0, total: copyMoveItems.length });
      setTreeConflictAllowsApplyToAll(false);
      const abortController = new AbortController();
      copyMoveAbortControllerRef.current = abortController;
      const errors: string[] = [];
      const warnings: string[] = [];
      let effectiveStrategy: CopyMoveConflictPolicy = "ask";
      let conflictCount = 0;
      let operationCancelled = false;
      let outcomeUnknown = false;

      for (let index = 0; index < copyMoveItems.length; index += 1) {
        const item = copyMoveItems[index]!;
        const request = {
          kind: copyMoveMode,
          source: item.handle,
          destination: copyMoveDestination,
          targetName: destFileName,
          signal: abortController.signal,
          onProgress: (bytesTransferred: number, totalBytes: number | null) =>
            setCopyMoveTransferProgress({ bytesTransferred, totalBytes, itemName: item.entry.name }),
          onAttemptStart: (transferAttemptId: string) => {
            activeTransferAttemptRef.current = transferAttemptId;
            setCopyMoveTransferProgress(null);
          },
          onAttemptSettled: (transferAttemptId: string) => {
            if (activeTransferAttemptRef.current === transferAttemptId) {
              activeTransferAttemptRef.current = null;
              setCopyMoveTransferProgress(null);
            }
          },
        } as const;
        let targetName = destFileName;
        const requestConflictDecision = async (
          conflict: ConflictInfo,
          _allowedActions: readonly ConflictDecision["resolution"][],
          treeProgress: { completed: number; discovered: number }
        ) => {
          conflictCount += 1;
          setConflictInfo(conflict);
          setConflictProgress({
            current: treeProgress.completed,
            total: Math.max(treeProgress.completed, treeProgress.discovered, 1),
            conflictsSoFar: conflictCount,
          });
          setTreeConflictAllowsApplyToAll(true);
          try {
            return await new Promise<ConflictDecision | null>((resolve) => {
              conflictResolveRef.current = resolve;
              setConflictDialogOpen(true);
            });
          } finally {
            setConflictDialogOpen(false);
            setTreeConflictAllowsApplyToAll(false);
          }
        };
        const execute = (targetResolutionPolicy: TargetResolutionPolicy = effectiveStrategy) =>
          isDirectory(item)
            ? executeTransferTree(
                {
                  ...request,
                  targetName,
                  targetResolutionPolicy,
                  onConflict: requestConflictDecision,
                  onTreeProgress: (completed, discovered) =>
                    setCopyMoveProgress({ current: completed, total: Math.max(completed, discovered) }),
                  onPolicyChange: (policy) => {
                    effectiveStrategy = policy;
                  },
                },
                contentOperationEnvironment
              )
            : executeTransfer({ ...request, targetName, targetResolutionPolicy }, contentOperationEnvironment);
        const applyTransferResult = (result: ContentTransferResult) => {
          if (result.status === "completed" || result.status === "skipped") return;
          if (result.status === "completed_with_source_retained") {
            warnings.push(`${item.entry.name}: ${result.error.detail}`);
            return;
          }
          if (result.status === "outcome_unknown") {
            outcomeUnknown = true;
            throw new Error("The transfer outcome is unknown. Both locations were refreshed.");
          }
          if (result.status === "failed") {
            throw new Error(`Content transfer failed: ${result.error.code}`);
          }
          throw new Error("Content transfer was cancelled");
        };
        setCopyMoveProgress({ current: index + 1, total: copyMoveItems.length });

        try {
          applyTransferResult(await execute());
        } catch (error) {
          if (outcomeUnknown) {
            errors.push("The transfer outcome is unknown. Both locations were refreshed.");
            break;
          }
          if (abortController.signal.aborted) {
            operationCancelled = true;
            break;
          }
          if (isApiError(error) && error.response?.status === 409) {
            const detail = error.response?.data?.detail;
            let conflict = typeof detail === "object" && detail !== null ? (detail as ConflictInfo) : null;
            if (conflict) {
              let resolutionHandled = false;
              while (conflict) {
                conflictCount += 1;
                setConflictInfo(conflict);
                setConflictProgress({ current: index + 1, total: copyMoveItems.length, conflictsSoFar: conflictCount });
                const decision = await new Promise<ConflictDecision | null>((resolve) => {
                  conflictResolveRef.current = resolve;
                  setConflictDialogOpen(true);
                });
                setConflictDialogOpen(false);
                if (!decision) {
                  operationCancelled = true;
                  break;
                }
                if (decision.applyToAll && decision.resolution !== "rename") {
                  effectiveStrategy = targetResolutionPolicyForConflictResolution(decision.resolution);
                }
                if (decision.resolution === "skip") {
                  resolutionHandled = true;
                  break;
                }
                if (decision.resolution === "rename") {
                  if (!decision.targetName) {
                    errors.push(`A target name is required to ${copyMoveMode} ${item.entry.name}`);
                    logger.error(`${copyMoveMode} rename decision was missing a target name`, { file: item.entry.name }, "browser");
                    resolutionHandled = true;
                    break;
                  }
                  targetName = decision.targetName;
                }
                try {
                  applyTransferResult(await execute(targetResolutionPolicyForConflictResolution(decision.resolution)));
                } catch (retryError) {
                  const retryDetail = isApiError(retryError) ? retryError.response?.data?.detail : null;
                  const retryConflict = typeof retryDetail === "object" && retryDetail !== null ? (retryDetail as ConflictInfo) : null;
                  if (isApiError(retryError) && retryError.response?.status === 409 && retryConflict) {
                    conflict = retryConflict;
                    continue;
                  }
                  const message =
                    (isApiError(retryError) ? retryError.message : undefined) ?? `Failed to ${copyMoveMode} ${item.entry.name}`;
                  errors.push(message);
                  logger.error(`${copyMoveMode} resolution retry failed`, { file: item.entry.name, error: retryError }, "browser");
                }
                resolutionHandled = true;
                break;
              }
              if (operationCancelled || outcomeUnknown) {
                break;
              }
              if (resolutionHandled) {
                continue;
              }
            }
          }

          const message = (isApiError(error) ? error.message : undefined) ?? `Failed to ${copyMoveMode} ${item.entry.name}`;
          errors.push(message);
          logger.error(`${copyMoveMode} failed`, { file: item.entry.name, error }, "browser");
        }
        if (outcomeUnknown) {
          break;
        }
      }

      setCopyMoveProcessing(false);
      activeTransferAttemptRef.current = null;
      setCopyMoveTransferProgress(null);
      if (copyMoveAbortControllerRef.current === abortController) {
        copyMoveAbortControllerRef.current = null;
      }
      const sourcePane = copyMoveSourcePaneId === "left" ? leftPane : rightPane;
      const destinationPane = copyMoveDestinationPaneId === "left" ? leftPane : rightPane;
      void destinationPane.reloadCurrentLocation({ forceRefresh: true });
      void sourcePane.reloadCurrentLocation({ forceRefresh: true });
      if (operationCancelled) {
        setConflictInfo(null);
        setCopyMoveError(null);
        setCopyMoveWarning(null);
        setCopyMoveProgress(undefined);
        setCopyMoveDialogOpen(false);
        return;
      }

      if (errors.length > 0) {
        setCopyMoveError(errors.join("; "));
      }
      if (warnings.length > 0) {
        setCopyMoveWarning(warnings.join("; "));
      }
      if (errors.length === 0 && warnings.length === 0) {
        setCopyMoveDialogOpen(false);
        if (copyMoveMode === "move") {
          sourcePane.removeSelectedPaths(copyMoveItems.map((item) => item.entry.path));
        }
      }
    },
    [
      contentOperationEnvironment,
      copyMoveDestination,
      copyMoveDestinationPaneId,
      copyMoveItems,
      copyMoveMode,
      copyMoveSourcePaneId,
      leftPane,
      rightPane,
    ]
  );

  /** Called when the user resolves an overwrite conflict dialog. */
  const handleConflictResolve = useCallback(
    (decision: ConflictDecision) => {
      if (uploadConflict) {
        resolveUploadConflict(decision);
        return;
      }
      conflictResolveRef.current?.(decision);
      conflictResolveRef.current = null;
    },
    [resolveUploadConflict, uploadConflict]
  );

  const handleConflictCancel = useCallback(() => {
    if (uploadConflict) {
      resolveUploadConflict(null);
      return;
    }
    conflictResolveRef.current?.(null);
    conflictResolveRef.current = null;
  }, [resolveUploadConflict, uploadConflict]);

  /** Cancel the copy/move dialog. */
  const handleCopyMoveCancel = useCallback(() => {
    if (copyMoveProcessing) {
      copyMoveAbortControllerRef.current?.abort();
    } else {
      setCopyMoveDialogOpen(false);
    }
  }, [copyMoveProcessing]);

  const handleOpenSettings = useCallback(() => {
    workspace.openSettings("main");
  }, [workspace.openSettings]);

  const handleSettingsClose = () => {
    workspace.closeSettings();
    // Return focus to active pane's file list after closing settings
    setTimeout(() => {
      activePane.listContainerEl?.focus();
    }, 0);
  };

  const handleOpenDocumentation = useCallback(() => {
    openExternalUrl("https://sambee.net/docs/");
  }, []);

  const openConnectionsSettings = useCallback(() => {
    workspace.openSettings("connections");
  }, [workspace.openSettings]);

  const openLocalDrivesSettings = useCallback(() => {
    workspace.openSettings("local-drives");
  }, [workspace.openSettings]);

  const focusQuickBarInput = useCallback(
    (sourcePaneId: PaneId) => {
      setTimeout(() => {
        const sourcePane = sourcePaneId === "right" && isDualMode ? rightPane : leftPane;
        sourcePane.searchInputRef.current?.focus();
        sourcePane.searchInputRef.current?.select();
      }, 0);
    },
    [isDualMode, leftPane, rightPane]
  );

  const openQuickBarMode = useCallback(
    (mode: "navigate" | "commands" | "file-search") => {
      const sourcePaneId = effectiveActivePaneIdRef.current;
      if (mode === "file-search") (sourcePaneId === "right" ? rightPane : leftPane).handleClearSelection();
      setQuickBarPaneId(sourcePaneId);
      setQuickBarMode(mode);
      setQuickBarActivationToken((current) => current + 1);
      focusQuickBarInput(sourcePaneId);
    },
    [focusQuickBarInput, leftPane, rightPane]
  );

  const switchQuickBarMode = useCallback(
    (mode: "navigate" | "commands" | "file-search") => {
      const sourcePaneId = quickBarPaneId === "right" && isDualMode ? "right" : "left";
      if (mode === "file-search") (sourcePaneId === "right" ? rightPane : leftPane).handleClearSelection();
      setQuickBarPaneId(sourcePaneId);
      setQuickBarMode(mode);
      setQuickBarActivationToken((current) => current + 1);
      focusQuickBarInput(sourcePaneId);
    },
    [focusQuickBarInput, isDualMode, quickBarPaneId, leftPane, rightPane]
  );

  const handleCreateArchiveRequest = useCallback(
    (invocation?: FileOperationInvocationContext) => {
      const context = invocation ?? getOperationPolicyContext();
      const sources = context.items.map((item) => item.handle);
      const capturedDestination = invocation?.destination ?? getCapturedDestination(context.paneId);
      const destinationPaneId = capturedDestination.paneId;
      const destination = capturedDestination.location;
      if (!getCreateContainerAvailability({ sources, destination }, contentOperationEnvironment).available) {
        return;
      }
      setArchiveCreateError(null);
      setArchiveCreateContext({
        sources,
        destination,
        destinationLabel: getLocationDisplayName(
          destination,
          (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId
        ),
        destinationPaneId,
      });
    },
    [allConnections, contentOperationEnvironment, getCapturedDestination, getOperationPolicyContext]
  );

  const handleCreateArchiveConfirm = useCallback(
    async (archiveName: string) => {
      if (!archiveCreateContext) {
        return;
      }
      const execution = startCreateContainer(
        { sources: archiveCreateContext.sources, destination: archiveCreateContext.destination, name: archiveName },
        contentOperationEnvironment
      );
      archiveCreationExecutionRef.current = execution;
      setIsCreatingArchive(true);
      setArchiveCreateError(null);
      try {
        await execution.result;
        setArchiveCreateContext(null);
        (archiveCreateContext.destinationPaneId === "right" ? rightPane : leftPane).handleRefresh();
      } catch (error: unknown) {
        const hasPartialArchiveOutput = isPartialContainerOutputError(error);
        if (execution.isCancellationRequested()) {
          setArchiveCreateContext(null);
          return;
        }
        const detail = hasPartialArchiveOutput
          ? t("fileBrowser.archive.createPartialOutputError")
          : getApiErrorMessage(error, t("fileBrowser.archive.errorGeneric"));
        setArchiveCreateError(detail);
        if (hasPartialArchiveOutput) {
          (archiveCreateContext.destinationPaneId === "right" ? rightPane : leftPane).handleRefresh();
        }
        logger.error(
          "Archive creation failed",
          {
            message: getApiErrorMessage(error, t("fileBrowser.archive.errorGeneric")),
            code: getStorageErrorCode(error),
            status: isApiError(error) ? error.response?.status : undefined,
            archiveName,
            destination: archiveCreateContext.destinationLabel,
          },
          "file-browser"
        );
      } finally {
        archiveCreationExecutionRef.current = null;
        setIsCancellingArchiveCreation(false);
        setIsCreatingArchive(false);
      }
    },
    [archiveCreateContext, contentOperationEnvironment, leftPane, rightPane, t]
  );

  const cancelArchiveCreation = useCallback(async () => {
    const execution = archiveCreationExecutionRef.current;
    if (!execution) {
      return;
    }
    setIsCancellingArchiveCreation(true);
    try {
      await execution.cancel();
    } catch {
      setIsCancellingArchiveCreation(false);
      setArchiveCreateError(t("fileBrowser.archive.errorGeneric"));
    }
  }, [t]);

  const handleArchiveExtractionRequest = useCallback(
    (
      extractionScope: ArchiveExtractionScope = FULL_ARCHIVE_EXTRACTION_SCOPE,
      sourceOverride?: VirtualLocation,
      destinationOverride?: CapturedDestination
    ) => {
      const location = sourceOverride ?? archiveExtractionSource;
      if (
        !location ||
        (extractionScope.kind === "archive" && activePaneIsVirtualArchive) ||
        (extractionScope.kind === "members" && extractionScope.memberPaths.length === 0)
      ) {
        return;
      }
      const destinationPaneId: PaneId =
        destinationOverride?.paneId ??
        (isDualModeRef.current ? (effectiveActivePaneIdRef.current === "left" ? "right" : "left") : effectiveActivePaneIdRef.current);
      const destinationPane = getPaneForId(destinationPaneId);
      const usesSiblingDirectory = !isDualModeRef.current;
      const destination =
        destinationOverride?.location ??
        (usesSiblingDirectory
          ? physicalLocation(location.source.connectionId, parentPath(location.source.path))
          : destinationPane.currentLocation);
      if (!getArchiveExtractionShortcutAvailability(location, destination).available || destination.kind !== "physical") {
        return;
      }
      const archiveName = fileName(location.source.path);
      setArchiveExtractionError(null);
      setArchiveExtractionContext({
        location,
        extractionScope:
          extractionScope.kind === "members"
            ? { kind: "members", memberPaths: [...extractionScope.memberPaths] }
            : FULL_ARCHIVE_EXTRACTION_SCOPE,
        destinationParent: destination,
        destinationPaneId,
        usesSiblingDirectory,
        destination: null,
        destinationLabel: getLocationDisplayName(
          destination,
          (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId
        ),
        archiveName,
        initialDestinationName: archiveName.replace(/\.zip$/i, "") || archiveName,
      });
    },
    [activePaneIsVirtualArchive, allConnections, archiveExtractionSource, getPaneForId, getArchiveExtractionShortcutAvailability]
  );

  const handleArchiveExtractionForContext = useCallback(
    (invocation: FileOperationInvocationContext) => {
      const source = getArchiveExtractionSourceForContext(invocation);
      if (!source) return;
      const destination = isDualModeRef.current
        ? (invocation.destination ?? getCapturedDestination(invocation.paneId))
        : { paneId: invocation.paneId, location: physicalLocation(source.source.connectionId, parentPath(source.source.path)) };
      activateOperationPane(invocation.paneId);
      handleArchiveExtractionRequest(FULL_ARCHIVE_EXTRACTION_SCOPE, source, destination);
    },
    [activateOperationPane, getArchiveExtractionSourceForContext, getCapturedDestination, handleArchiveExtractionRequest]
  );

  const completeArchiveExtraction = useCallback(
    (outcome: ArchiveExtractionOutcome, context: NonNullable<typeof archiveExtractionContext>) => {
      if (outcome.status === "awaiting-decision") {
        setArchiveExtractionConflicts(outcome.conflicts);
        setArchiveExtractionAllowedActions(outcome.allowedActions);
        setArchiveExtractionMemberError(null);
        return;
      }
      if (outcome.status === "awaiting-member-error") {
        setArchiveExtractionConflicts(null);
        setArchiveExtractionAllowedActions([]);
        setArchiveExtractionMemberError(outcome.error);
        return;
      }

      if (outcome.status === "completed") {
        const messages: string[] = [
          outcome.filesSkipped > 0
            ? t("fileBrowser.archive.extractPartialSuccess", { count: outcome.filesSkipped })
            : t("fileBrowser.archive.extractSuccess"),
        ];
        if (outcome.summary.encryptedMembersSkipped) {
          messages.push(t("fileBrowser.archive.extractEncryptedSkipped", { count: outcome.summary.encryptedMembersSkipped }));
        }
        if (outcome.summary.unsupportedCompressionMembersSkipped) {
          messages.push(
            t("fileBrowser.archive.extractUnsupportedCompressionSkipped", { count: outcome.summary.unsupportedCompressionMembersSkipped })
          );
        }
        setArchiveExtractionNotice(messages.join(" "));
      } else if (outcome.status === "cancelled") {
        setArchiveExtractionNotice(t("fileBrowser.archive.extractCancelled"));
      } else {
        setArchiveExtractionNotice(t("fileBrowser.archive.extractInterrupted"));
      }

      archiveExtractionExecutionRef.current = null;
      setArchiveExtractionConflicts(null);
      setArchiveExtractionAllowedActions([]);
      setArchiveExtractionMemberError(null);
      setIsExtractingArchive(false);
      setIsCancellingArchiveExtraction(false);
      setArchiveExtractionProgress(null);
      const destinationPane = context.destinationPaneId === "right" ? rightPane : leftPane;
      destinationPane.handleDirectoryChanged({
        connectionId: context.destinationParent.connectionId,
        path: context.destinationParent.path,
      });
      setArchiveExtractionContext(null);
    },
    [leftPane, rightPane, t]
  );

  const handleArchiveExtractionConfirm = useCallback(
    async (destinationName: string) => {
      if (!archiveExtractionContext) {
        return;
      }
      setIsExtractingArchive(true);
      setArchiveExtractionError(null);
      setArchiveExtractionConflicts(null);
      setArchiveExtractionAllowedActions([]);
      setArchiveExtractionMemberError(null);
      setArchiveExtractionProgress(null);
      const destination = archiveExtractionContext.usesSiblingDirectory
        ? physicalLocation(
            archiveExtractionContext.destinationParent.connectionId,
            joinPath(archiveExtractionContext.destinationParent.path, destinationName)
          )
        : archiveExtractionContext.destinationParent;
      const executionContext = { ...archiveExtractionContext, destination };
      setArchiveExtractionContext(executionContext);
      const execution = startArchiveExtraction(browserContentServices.providers, {
        source: executionContext.location,
        destination,
        selectedMemberPaths: executionContext.extractionScope.kind === "members" ? executionContext.extractionScope.memberPaths : undefined,
      });
      archiveExtractionExecutionRef.current = execution;
      const unsubscribeProgress = execution.onProgress(setArchiveExtractionProgress);
      try {
        completeArchiveExtraction(await execution.result, executionContext);
      } catch (error: unknown) {
        const detail =
          isApiError(error) && error.response?.status === 409
            ? t("fileBrowser.archive.validationDestinationExists")
            : t("fileBrowser.archive.extractError");
        setArchiveExtractionError(detail);
        logger.error("Archive extraction failed", { error, destinationPath: destination.path }, "file-browser");
        archiveExtractionExecutionRef.current = null;
        setIsExtractingArchive(false);
        setIsCancellingArchiveExtraction(false);
        setArchiveExtractionProgress(null);
      } finally {
        unsubscribeProgress();
      }
    },
    [archiveExtractionContext, browserContentServices.providers, completeArchiveExtraction, t]
  );

  const cancelArchiveExtraction = useCallback(async () => {
    const execution = archiveExtractionExecutionRef.current;
    if (!execution || !archiveExtractionContext) return;
    setIsCancellingArchiveExtraction(true);
    try {
      await execution.cancel();
      if (archiveExtractionConflicts || archiveExtractionMemberError) {
        completeArchiveExtraction({ status: "cancelled" }, archiveExtractionContext);
      }
    } catch (error) {
      setIsCancellingArchiveExtraction(false);
      setArchiveExtractionError(t("fileBrowser.archive.extractError"));
      logger.error("Archive extraction cancellation failed", { error }, "file-browser");
    }
  }, [archiveExtractionConflicts, archiveExtractionContext, archiveExtractionMemberError, completeArchiveExtraction, t]);

  const handleArchiveExtractionDecision = useCallback(
    async (action: Parameters<ArchiveExtractionExecution["decide"]>[0], memberPath?: string, targetPath?: string) => {
      const execution = archiveExtractionExecutionRef.current;
      if (!execution || !archiveExtractionContext) return;
      setIsSubmittingArchiveExtractionDecision(true);
      setArchiveExtractionError(null);
      try {
        completeArchiveExtraction(await execution.decide(action, memberPath, targetPath), archiveExtractionContext);
      } catch (error) {
        setArchiveExtractionError(t("fileBrowser.archive.extractError"));
        logger.error("Archive extraction collision decision failed", { error, action, memberPath }, "file-browser");
      } finally {
        setIsSubmittingArchiveExtractionDecision(false);
      }
    },
    [archiveExtractionContext, completeArchiveExtraction, t]
  );

  const handleArchiveExtractionMemberErrorDecision = useCallback(
    async (action: "retry" | "ignore") => {
      const execution = archiveExtractionExecutionRef.current;
      if (!execution || !archiveExtractionContext || !archiveExtractionMemberError) return;
      setIsSubmittingArchiveExtractionDecision(true);
      setArchiveExtractionError(null);
      try {
        completeArchiveExtraction(await execution.decide(action, archiveExtractionMemberError.memberPath), archiveExtractionContext);
      } catch (error) {
        setArchiveExtractionError(t("fileBrowser.archive.extractError"));
        logger.error("Archive extraction member error decision failed", { error }, "file-browser");
      } finally {
        setIsSubmittingArchiveExtractionDecision(false);
      }
    },
    [archiveExtractionContext, archiveExtractionMemberError, completeArchiveExtraction, t]
  );

  /** Route F5 in a ZIP pane to selected-member extraction. */
  const handleCopyToOtherPane = useCallback(
    (invocation?: FileOperationInvocationContext) => {
      const context = invocation ?? getOperationPolicyContext();
      const sourcePane = getPaneForId(context.paneId);
      const location = sourcePane.currentLocation;
      if (location.kind === "virtual" && location.providerId === "zip" && isDualModeRef.current) {
        const selectedMemberPaths = context.items.flatMap((item) =>
          item.handle.kind === "virtual" &&
          item.handle.location.providerId === "zip" &&
          item.handle.location.connectionId === location.connectionId &&
          item.handle.location.source.path === location.source.path &&
          item.entry.is_readable
            ? [item.handle.path]
            : []
        );
        if (selectedMemberPaths.length > 0) {
          handleArchiveExtractionRequest(
            {
              kind: "members",
              memberPaths: selectedMemberPaths,
            },
            undefined,
            invocation?.destination ?? getCapturedDestination(context.paneId)
          );
        }
        return;
      }
      handleOpenCopyMoveDialog("copy", context);
    },
    [getCapturedDestination, getOperationPolicyContext, getPaneForId, handleArchiveExtractionRequest, handleOpenCopyMoveDialog]
  );

  const handleDownloadRequest = useCallback(
    async (context: FileOperationPolicyContext) => {
      const selection = context.items.length ? context.items : context.focusedItem ? [context.focusedItem] : [];
      await startDownload(selection);
    },
    [startDownload]
  );

  const handleFileShareRequest = useCallback(
    async (context: FileOperationPolicyContext, selectionAction: boolean) => {
      const items = selectionAction ? context.items : context.focusedItem ? [context.focusedItem] : [];
      if (!getFileListShortcutAvailability("share", { ...context, items }).available || !items.length) return;
      nativeSharing.clearFailure();

      const controller = new AbortController();
      const request = {
        controller,
        paneId: context.paneId,
        location: getPaneForId(context.paneId).currentLocation,
        selectedPaths: selectionAction ? items.map((item) => item.entry.path) : null,
      };
      fileShareRequestRef.current = request;
      setFileShareState({ status: "preparing", count: items.length });
      try {
        const files: File[] = [];
        for (const item of items) {
          const blob = await readContent(item.handle, { kind: "raw" }, { signal: controller.signal }, browserContentServices.providers);
          if (controller.signal.aborted || fileShareRequestRef.current !== request) return;
          files.push(createShareFile(blob, item.entry.name, item.entry.mime_type));
        }
        setFileShareState({ status: "ready", files });
      } catch (error) {
        if (controller.signal.aborted || fileShareRequestRef.current !== request) return;
        logger.error(
          "Failed to prepare file-list share",
          undefined,
          "file-browser",
          error instanceof Error ? error : new Error(String(error))
        );
        cancelFileShare();
        nativeSharing.preparationFailed();
      }
    },
    [browserContentServices.providers, cancelFileShare, getFileListShortcutAvailability, getPaneForId, nativeSharing]
  );
  const finishFileShare = useCallback(async () => {
    const request = fileShareRequestRef.current;
    if (fileShareState?.status !== "ready" || !request) return;
    const files = fileShareState.files;
    setFileShareState({ status: "sharing", files });
    try {
      await nativeSharing.invoke({ files });
    } finally {
      if (fileShareRequestRef.current === request) cancelFileShare();
    }
  }, [cancelFileShare, fileShareState, nativeSharing]);

  const handleUploadRequest = useCallback(
    (paneId: PaneId, folder = false) => {
      const pane = getPaneForId(paneId);
      const destination = pane.currentLocation;
      const availability = getFileListShortcutAvailability("upload", getOperationPolicyContext(paneId));
      if (destination.kind !== "physical" || uploadSessionActive || !availability.available) return;
      if (pendingUploadPickerRef.current && document.hasFocus() === false) return;
      const picker = document.createElement("input");
      picker.type = "file";
      if (folder) picker.setAttribute("webkitdirectory", "");
      else picker.multiple = true;
      pendingUploadPickerRef.current = picker;
      picker.oncancel = () => {
        if (pendingUploadPickerRef.current === picker) pendingUploadPickerRef.current = null;
      };
      picker.onchange = () => {
        if (pendingUploadPickerRef.current !== picker) return;
        pendingUploadPickerRef.current = null;
        const files = Array.from(picker.files ?? []);
        if (!files.length) return;
        startBrowserUpload(paneId, destination, async () => manifestFromFiles(files, folder));
      };
      picker.click();
    },
    [getFileListShortcutAvailability, getOperationPolicyContext, getPaneForId, startBrowserUpload, uploadSessionActive]
  );

  const openUploadMenu = useCallback(
    (paneId: PaneId) => {
      const anchor = uploadTriggerRef.current;
      if (!anchor?.isConnected || uploadSessionActive) return;
      const pane = getPaneForId(paneId);
      const destination = pane.currentLocation;
      if (
        destination.kind !== "physical" ||
        !pane.contentCapabilities.mutate ||
        !isConnectionWritable(getConnectionById(allConnections, destination.connectionId))
      )
        return;
      uploadMenuFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      uploadMenuOpenId.current += 1;
      setUploadMenu({ anchor, paneId, destination });
    },
    [allConnections, getPaneForId, uploadSessionActive]
  );

  const closeUploadMenu = useCallback(() => {
    setUploadMenu(null);
    const focusTarget = uploadMenuFocusRef.current?.isConnected ? uploadMenuFocusRef.current : uploadTriggerRef.current;
    focusTarget?.focus();
    uploadMenuFocusRef.current = null;
  }, []);

  const handleUploadAnchorChange = useCallback((anchor: HTMLElement | null) => {
    uploadTriggerRef.current = anchor;
  }, []);

  const selectUploadChoice = useCallback(
    (folder: boolean) => {
      if (!uploadMenu) return;
      const { paneId, destination } = uploadMenu;
      closeUploadMenu();
      const pane = getPaneForId(paneId);
      const current = pane.currentLocation;
      if (current.kind !== "physical" || current.connectionId !== destination.connectionId || current.path !== destination.path) {
        setTransferNotice(t("fileBrowser.transfers.uploadDestinationChanged"));
        return;
      }
      handleUploadRequest(paneId, folder);
    },
    [closeUploadMenu, getPaneForId, handleUploadRequest, t, uploadMenu]
  );

  const handlePaneFileDrop = useCallback(
    (paneId: PaneId, event: React.DragEvent<HTMLElement>) => {
      const pane = getPaneForId(paneId);
      const destination = pane.currentLocation;
      const availability = getFileListShortcutAvailability("upload", getOperationPolicyContext(paneId));
      if (destination.kind !== "physical" || uploadSessionActive || !availability.available) {
        setTransferNotice(t("fileBrowser.transfers.dropUnavailable"));
        return;
      }
      try {
        const entries = captureDropEntries(event.dataTransfer.items);
        startBrowserUpload(paneId, destination, (signal) => manifestFromDrop(entries, signal));
      } catch (error) {
        setTransferNotice(error instanceof Error ? error.message : t("fileBrowser.transfers.dropUnsupported"));
      }
    },
    [getFileListShortcutAvailability, getOperationPolicyContext, getPaneForId, startBrowserUpload, t, uploadSessionActive]
  );

  const buildFileOperationActions = useCallback(
    (surface: FileOperationSurface, policyContext?: FileOperationPolicyContext): FileOperationAction[] => {
      const rawContext = policyContext ?? getOperationPolicyContext();
      const context =
        surface === "compact-item-menu" && rawContext.focusedItem ? { ...rawContext, items: [rawContext.focusedItem] } : rawContext;
      const createInvocation = (): FileOperationInvocationContext => {
        const actionContext = policyContext ?? getOperationPolicyContext();
        return { ...actionContext, destination: getCapturedDestination(actionContext.paneId) };
      };
      const runFocusedItemAction = (invocation: FileOperationInvocationContext, handler: (file: FileEntry, index: number) => void) => {
        const sourcePane = getPaneForId(invocation.paneId);
        const item = invocation.focusedItem;
        if (!item) return;
        const index = sourcePane.files.findIndex((file) => file.path === item.entry.path);
        if (index < 0) return;
        activateOperationPane(invocation.paneId);
        handler(item.entry, index);
      };
      const availability = {
        "new-directory": getFileListShortcutAvailability("new-directory", context),
        "new-file": getFileListShortcutAvailability("new-file", context),
        rename: getFileListShortcutAvailability("rename", context),
        delete: getFileListShortcutAvailability("delete", context),
        copy: getFileListShortcutAvailability("copy", context),
        move: getFileListShortcutAvailability("move", context),
        "create-archive": getFileListShortcutAvailability("create-archive", context),
        "extract-archive": getFileListShortcutAvailability("extract-archive", context),
        download: getFileListShortcutAvailability("download", context),
        share: getFileListShortcutAvailability("share", context),
        upload: getFileListShortcutAvailability("upload", context),
        refresh: getFileListShortcutAvailability("refresh", context),
      };

      const actionIds = Object.keys(availability) as FileOperationActionId[];
      const unavailableReasons = Object.fromEntries(
        actionIds.flatMap((action) => {
          const actionAvailability = availability[action];
          return actionAvailability.available ? [] : [[action, getUnavailableShortcutMessage(action, actionAvailability.reason)]];
        })
      ) as Partial<Record<FileOperationActionId, string>>;

      return createFileOperationActions({
        hasTwoPanes: isDualMode,
        surface,
        availability,
        labels: {
          "new-directory": t("fileBrowser.toolbar.newFolder"),
          "new-file": t("fileBrowser.toolbar.newFile"),
          rename: t("common.actions.rename"),
          delete: t("common.actions.delete"),
          copy: t("common.actions.copy"),
          move: t("common.actions.move"),
          "create-archive": t("fileBrowser.toolbar.createArchive"),
          "extract-archive": t("fileBrowser.toolbar.extractArchive"),
          download: t("common.actions.download"),
          share: t("common.actions.share"),
          upload: t("fileBrowser.toolbar.upload"),
          refresh: t("fileBrowser.toolbar.refresh"),
        },
        shortcuts: {
          "new-directory": BROWSER_SHORTCUTS.NEW_DIRECTORY.label,
          "new-file": BROWSER_SHORTCUTS.NEW_FILE.label,
          rename: BROWSER_SHORTCUTS.RENAME_ITEM.label,
          delete: BROWSER_SHORTCUTS.DELETE_ITEM.label,
          copy: COPY_MOVE_SHORTCUTS.COPY_TO_OTHER_PANE.label,
          move: COPY_MOVE_SHORTCUTS.MOVE_TO_OTHER_PANE.label,
          "create-archive": BROWSER_SHORTCUTS.CREATE_ARCHIVE.label,
          "extract-archive": BROWSER_SHORTCUTS.EXTRACT_ARCHIVE.label,
          download: BROWSER_SHORTCUTS.DOWNLOAD.label,
          share: "",
          upload: BROWSER_SHORTCUTS.UPLOAD.label,
          refresh: BROWSER_SHORTCUTS.REFRESH.label,
        },
        unavailableReasons,
        handlers: {
          "new-directory": () => {
            const invocation = createInvocation();
            const sourcePane = getPaneForId(invocation.paneId);
            activateOperationPane(invocation.paneId);
            sourcePane.handleNewDirectoryRequest();
          },
          "new-file": () => {
            const invocation = createInvocation();
            const sourcePane = getPaneForId(invocation.paneId);
            activateOperationPane(invocation.paneId);
            sourcePane.handleNewFileRequest();
          },
          rename: () => {
            const invocation = createInvocation();
            runFocusedItemAction(invocation, getPaneForId(invocation.paneId).handleRenameForFile);
          },
          delete: () => {
            const invocation = createInvocation();
            const sourcePane = getPaneForId(invocation.paneId);
            activateOperationPane(invocation.paneId);
            if (surface === "compact-item-menu") {
              runFocusedItemAction(invocation, sourcePane.handleDeleteForFile);
              return;
            }
            sourcePane.handleDeleteItems(invocation.items);
          },
          copy: () => handleCopyToOtherPane(createInvocation()),
          move: () => handleMoveToOtherPane(createInvocation()),
          "create-archive": () => handleCreateArchiveRequest(createInvocation()),
          "extract-archive": () => handleArchiveExtractionForContext(createInvocation()),
          download: () => {
            const invocation = createInvocation();
            void handleDownloadRequest(
              surface === "compact-item-menu"
                ? { ...invocation, items: invocation.focusedItem ? [invocation.focusedItem] : [] }
                : invocation
            );
          },
          share: () => {
            const invocation = createInvocation();
            void handleFileShareRequest(invocation, surface === "compact-selection-menu");
          },
          upload: () => openUploadMenu(createInvocation().paneId),
          refresh: () => getPaneForId(createInvocation().paneId).handleRefresh(),
        },
      });
    },
    [
      activateOperationPane,
      getCapturedDestination,
      getFileListShortcutAvailability,
      getOperationPolicyContext,
      getPaneForId,
      getUnavailableShortcutMessage,
      handleArchiveExtractionForContext,
      handleCopyToOtherPane,
      handleCreateArchiveRequest,
      handleMoveToOtherPane,
      handleDownloadRequest,
      handleFileShareRequest,
      openUploadMenu,
      isDualMode,
      t,
    ]
  );
  const buildCompactCreateActions = useCallback(
    (context: FileOperationPolicyContext): readonly FileOperationAction[] =>
      buildFileOperationActions("compact-create-menu", context).flatMap((action) => {
        if (action.id !== "upload") return [action];
        const files = { ...action, label: t("fileBrowser.toolbar.uploadFiles"), onClick: () => handleUploadRequest(context.paneId) };
        if (!("webkitdirectory" in document.createElement("input"))) return [files];
        return [
          files,
          { ...action, label: t("fileBrowser.toolbar.uploadFolder"), onClick: () => handleUploadRequest(context.paneId, true) },
        ];
      }),
    [buildFileOperationActions, handleUploadRequest, t]
  );
  const buildCompactItemActions = useCallback(
    (context: FileOperationPolicyContext): readonly CompactItemAction[] => {
      const item = context.focusedItem;
      if (!item) return [];

      const sourcePane = getPaneForId(context.paneId);
      const index = sourcePane.files.findIndex((file) => file.path === item.entry.path);
      if (index < 0) return [];

      const availability = getItemActionAvailability({
        item,
        nativeAppCapability: sourcePane.contentCapabilities.openInNativeApp,
        isCompanionPaired: companion.status === "paired",
        environment: contentOperationEnvironment,
      });
      const isSelected = sourcePane.selectedFiles.has(item.entry.path);
      const actions: CompactItemAction[] = [
        {
          id: isSelected ? "deselect" : "select",
          label: t(isSelected ? "fileBrowser.compactActions.deselect" : "fileBrowser.compactActions.select"),
          onClick: () => (isSelected ? sourcePane.toggleItemSelection(item.entry, index) : sourcePane.selectItem(item.entry, index)),
        },
      ];

      if (availability.canOpenInBrowserViewer) {
        actions.push({
          id: "open-associated-viewer",
          label: t("fileBrowser.row.openInBrowserViewer"),
          onClick: () => sourcePane.handleOpenFileForFile(item.entry, index, "associated-viewer"),
        });
      }
      if (availability.canChooseBrowserViewer) {
        actions.push({
          id: "open-viewer-picker",
          label: t("fileBrowser.row.chooseBrowserViewer"),
          onClick: () => sourcePane.handleOpenFileForFile(item.entry, index, "force-viewer-picker"),
        });
      }
      if (availability.canOpenInNativeApp) {
        actions.push({
          id: "open-associated-native-app",
          label: t("fileBrowser.row.openInNativeApp"),
          onClick: () => void sourcePane.handleOpenInAppForFile(item.entry, index),
        });
      }
      if (availability.canChooseNativeApp) {
        actions.push({
          id: "open-native-picker",
          label: t("fileBrowser.row.chooseNativeApp"),
          onClick: () => void sourcePane.handleOpenInAppForFile(item.entry, index, { forcePicker: true }),
        });
      }

      return [
        ...actions,
        ...buildFileOperationActions("compact-item-menu", context).filter(
          (action) =>
            (action.id !== "extract-archive" || getArchiveExtractionSourceForContext(context) !== null) &&
            (action.id !== "share" || (item.entry.type === FileType.FILE && supportsNativeShare()))
        ),
      ];
    },
    [buildFileOperationActions, companion.status, contentOperationEnvironment, getArchiveExtractionSourceForContext, getPaneForId, t]
  );
  const buildCompactSelectionActions = useCallback(
    (context: FileOperationPolicyContext) =>
      buildFileOperationActions("compact-selection-menu", context).filter(
        (action) => action.id !== "share" || (useCompactLayout && supportsNativeShare())
      ),
    [buildFileOperationActions, useCompactLayout]
  );
  const fileOperationActions = buildFileOperationActions("desktop-toolbar");

  const browserCommandContext = useMemo(
    () => ({
      isDualMode,
      useCompactLayout,
      settingsOpen,
      mobileSettingsOpen,
      helpOpen: showHelp,
      quickBarMode,
      hasFiles: quickBarPane.filesRef.current.length > 0,
      hasFocusedFile: quickBarPane.focusedIndex >= 0 && quickBarPane.filesRef.current[quickBarPane.focusedIndex] !== undefined,
      connectionSelected: quickBarPane.connectionId !== "",
      connectionWritable: quickBarPaneWritable,
      canCreateArchive: activePaneCanCreateArchive,
      canExtractArchive: !activePaneIsVirtualArchive && archiveExtractionSource !== null && archiveExtractionContext === null,
      canOpenFocusedFileInApp: quickBarCanOpenInApp,
      canCopyToOtherPane: quickBarCanCopyToOtherPane,
      canMoveToOtherPane: quickBarCanMoveToOtherPane,
      canOpenLocationInNewTab: canOpenQuickBarLocationInNewTab,
      canMatchPaneLocations,
      openLocationInNewTab: () => handleOpenLocationInNewTab(quickBarPaneId === "right" && isDualMode ? "right" : "left"),
      matchLeftPaneLocation: () => handleMatchPaneLocation("left"),
      matchRightPaneLocation: () => handleMatchPaneLocation("right"),
      openQuickNav: () => openQuickBarMode("navigate"),
      openFileSearch: () => openQuickBarMode("file-search"),
      openCommandMode: () => openQuickBarMode("commands"),
      openSettings: handleOpenSettings,
      openConnectionsSettings,
      openHelp: () => setShowHelp(true),
      refresh: quickBarPane.handleRefresh,
      navigateUp: quickBarPane.handleNavigateUpDirectory,
      openFocusedItem: () => quickBarPane.handleOpenFile({ requireListFocus: false }),
      renameFocusedItem: () => quickBarPane.handleRenameRequest({ requireListFocus: false }),
      deleteFocusedItem: () => quickBarPane.handleDeleteRequest({ requireListFocus: false }),
      newDirectory: quickBarPane.handleNewDirectoryRequest,
      newFile: quickBarPane.handleNewFileRequest,
      createArchive: handleCreateArchiveRequest,
      extractArchive: handleArchiveExtractionRequest,
      openInApp: () => {
        void quickBarPane.handleOpenInApp();
      },
      openInViewerPicker: () => quickBarPane.handleOpenFile({ requireListFocus: false, mode: "force-viewer-picker" }),
      openInNativePicker: () => {
        void quickBarPane.handleOpenInApp({ forcePicker: true });
      },
      toggleDualPane: handleToggleDualPane,
      focusLeftPane: handleFocusLeftPane,
      focusRightPane: handleFocusRightPane,
      switchPane: handleSwitchPane,
      copyToOtherPane: handleCopyToOtherPane,
      moveToOtherPane: handleMoveToOtherPane,
    }),
    [
      canOpenQuickBarLocationInNewTab,
      canMatchPaneLocations,
      handleOpenLocationInNewTab,
      handleMatchPaneLocation,
      quickBarPaneId,
      handleCopyToOtherPane,
      handleCreateArchiveRequest,
      handleArchiveExtractionRequest,
      activePaneIsVirtualArchive,
      archiveExtractionSource,
      handleFocusLeftPane,
      handleFocusRightPane,
      handleMoveToOtherPane,
      handleOpenSettings,
      handleSwitchPane,
      handleToggleDualPane,
      isDualMode,
      mobileSettingsOpen,
      openConnectionsSettings,
      openQuickBarMode,
      quickBarCanCopyToOtherPane,
      activePaneCanCreateArchive,
      archiveExtractionContext,
      quickBarCanMoveToOtherPane,
      quickBarCanOpenInApp,
      quickBarMode,
      quickBarPane,
      quickBarPaneWritable,
      settingsOpen,
      showHelp,
      useCompactLayout,
    ]
  );

  const browserCommandsProvider = useBrowserCommandsProvider({
    commands: getEnabledBrowserCommands(browserCommandContext),
    onSelect: (command) => command.run(browserCommandContext),
  });

  const fileSearchProvider = useFileSearchProvider({
    connectionId: quickBarPane.connectionId,
    currentPath: quickBarPane.currentPath,
    files: quickBarPane.files,
    connectionName: getConnectionById(allConnections, quickBarPane.connectionId)?.name ?? quickBarPane.connectionId,
    resultLimit: 50,
    getConnectionName: (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId,
    onOpenCurrentFile: (file, mode) => {
      const index = quickBarPane.files.findIndex((entry) => entry.name === file.name);
      quickBarPane.handleOpenFileForFile(file, index, mode);
    },
    onOpenRecentFile: (file, mode) => {
      void quickBarPane.handleOpenFileAtPath(file.connection_id, file.path, mode, file.id);
    },
    history: browserContentServices.history,
  });

  const suppressQuickBarDropdown =
    showHelp ||
    settingsOpen ||
    mobileSettingsOpen ||
    copyMoveDialogOpen ||
    archiveExtractionContext !== null ||
    conflictDialogOpen ||
    archiveCreateContext !== null ||
    leftPane.viewInfo !== null ||
    rightPane.viewInfo !== null ||
    leftPane.browserViewerPickerState !== null ||
    rightPane.browserViewerPickerState !== null ||
    quickBarPane.deleteDialogOpen ||
    quickBarPane.renameDialogOpen ||
    quickBarPane.createDialogOpen;

  const quickBarProvider = useMemo(() => {
    if (quickBarMode === "commands") {
      return browserCommandsProvider;
    }

    if (quickBarMode === "file-search") {
      return fileSearchProvider;
    }

    return quickBarPane.directorySearchProvider;
  }, [browserCommandsProvider, fileSearchProvider, quickBarMode, quickBarPane.directorySearchProvider]);

  const quickBarModeOptions = useMemo(
    () => [
      {
        id: "navigate",
        label: t("fileBrowser.search.modes.navigate"),
        onSelect: () => switchQuickBarMode("navigate"),
      },
      {
        id: "file-search",
        label: t("fileBrowser.search.modes.fileSearch"),
        onSelect: () => switchQuickBarMode("file-search"),
      },
      {
        id: "commands",
        label: t("fileBrowser.search.modes.commands"),
        onSelect: () => switchQuickBarMode("commands"),
      },
    ],
    [switchQuickBarMode, t]
  );

  const quickBarQueryValue = undefined;
  const handleQuickBarQueryValueChange = () => {
    if (quickBarMode === "file-search") quickBarPane.handleClearSelection();
  };
  const connectionSelectorButtonRef = React.useRef<HTMLButtonElement | null>(null);
  const handleQuickBarArrowDownToFileList = useCallback(() => {
    if (quickBarPane.filesRef.current.length === 0) {
      return;
    }

    quickBarPane.listContainerEl?.focus();
  }, [quickBarPane]);
  const handleOpenConnectionSelector = useCallback(() => {
    const connectionSelectorButton = connectionSelectorButtonRef.current;
    if (!connectionSelectorButton) {
      return;
    }

    connectionSelectorButton.focus();
    if (connectionSelectorButton.getAttribute("aria-expanded") !== "true") {
      connectionSelectorButton.click();
    }
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Keyboard Shortcuts
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Keyboard shortcuts configuration
   *
   * Defines all browser shortcuts with handlers and enabled conditions.
   * Routes navigation/action shortcuts to the active pane.
   * Includes dual-pane shortcuts (Ctrl+B, Tab, Ctrl+1, Ctrl+2).
   */
  const browserShortcuts = useMemo<KeyboardShortcut[]>(() => {
    // Common condition building blocks to avoid repetition
    const noSettings = !settingsOpen && !mobileSettingsOpen;
    const browsing = isBrowserBrowsing;
    const hasFiles = activePane.filesRef.current.length > 0;
    const hasFocusedFile = activePane.focusedIndex >= 0 && activePane.filesRef.current[activePane.focusedIndex] !== undefined;
    const noDialogOpen = !activePane.deleteDialogOpen && !activePane.renameDialogOpen && !activePane.createDialogOpen;
    const noDialogOrCopyMove = noDialogOpen && !copyMoveDialogOpen;
    const deleteAvailability = getFileListShortcutAvailability("delete");
    const renameAvailability = getFileListShortcutAvailability("rename");
    const copyAvailability = getFileListShortcutAvailability("copy");
    const moveAvailability = getFileListShortcutAvailability("move");
    const newDirectoryAvailability = getFileListShortcutAvailability("new-directory");
    const newFileAvailability = getFileListShortcutAvailability("new-file");
    const createArchiveAvailability = getFileListShortcutAvailability("create-archive");
    const extractArchiveAvailability = getFileListShortcutAvailability("extract-archive");
    const uploadAvailability = getFileListShortcutAvailability("upload");
    const downloadAvailability = getFileListShortcutAvailability("download");
    const refreshAvailability = getFileListShortcutAvailability("refresh");

    return [
      // Navigation - Arrow keys (focus checked inside handlers)
      {
        ...BROWSER_SHORTCUTS.ARROW_DOWN,
        handler: activePane.handleNavigateDown,
        enabled: browsing && hasFiles,
      },
      {
        ...BROWSER_SHORTCUTS.ARROW_UP,
        handler: activePane.handleArrowUp,
        enabled: browsing && hasFiles,
      },
      // Navigation - Home/End (focus checked inside handlers)
      {
        ...COMMON_SHORTCUTS.FIRST_PAGE,
        description: "First file",
        handler: activePane.handleHome,
        enabled: browsing && hasFiles,
      },
      {
        ...COMMON_SHORTCUTS.LAST_PAGE,
        description: "Last file",
        handler: activePane.handleEnd,
        enabled: browsing && hasFiles,
      },
      // Navigation - Page Up/Down (focus checked inside handlers)
      {
        ...COMMON_SHORTCUTS.PAGE_DOWN,
        handler: activePane.handlePageDown,
        enabled: browsing && hasFiles,
      },
      {
        ...COMMON_SHORTCUTS.PAGE_UP,
        handler: activePane.handlePageUp,
        enabled: browsing && hasFiles,
      },
      // Open file/folder (focus checked inside handler)
      {
        ...COMMON_SHORTCUTS.OPEN,
        description: t("fileBrowser.shortcuts.openSelectedItem"),
        handler: () => activePane.handleOpenFile({ mode: "associated-viewer" }),
        enabled: browsing && hasFocusedFile,
      },
      {
        ...BROWSER_SHORTCUTS.OPEN_IN_VIEWER_PICKER,
        handler: () => activePane.handleOpenFile({ mode: "force-viewer-picker" }),
        enabled: browsing && hasFocusedFile,
      },
      // Open in companion app (Ctrl+Enter)
      {
        ...BROWSER_SHORTCUTS.OPEN_IN_APP,
        handler: () => activePane.handleOpenInApp(),
        enabled: browsing && activePaneCanOpenInApp,
      },
      // Choose native app (Ctrl+Alt+Enter)
      {
        ...BROWSER_SHORTCUTS.OPEN_IN_NATIVE_PICKER,
        handler: () => activePane.handleOpenInApp({ forcePicker: true }),
        enabled: browsing && activePaneCanOpenInApp,
      },
      // Navigate up directory
      {
        ...BROWSER_SHORTCUTS.NAVIGATE_UP,
        handler: activePane.handleNavigateUpDirectory,
        enabled: browsing && (activePaneIsArchive || activePane.currentPathRef.current !== ""),
      },
      // Clear selection and search (close action in browser context)
      {
        ...COMMON_SHORTCUTS.CLOSE,
        handler: handleBrowserEscape,
        enabled: !browserOverlayOpen,
      },
      // Refresh (Ctrl+R) — available in both single and dual pane modes
      {
        ...BROWSER_SHORTCUTS.REFRESH,
        handler: activePane.handleRefresh,
        enabled: refreshAvailability.available,
      },
      {
        ...BROWSER_SHORTCUTS.UPLOAD,
        handler: () => openUploadMenu(effectiveActivePaneId),
        enabled: browsing && noDialogOrCopyMove && uploadAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("upload", event),
      },
      {
        ...BROWSER_SHORTCUTS.DOWNLOAD,
        handler: () => void handleDownloadRequest(getOperationPolicyContext()),
        enabled: browsing && noDialogOrCopyMove && downloadAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("download", event),
      },
      // Navigate mode (Ctrl+K) — also focuses the search bar
      {
        ...BROWSER_SHORTCUTS.QUICK_NAVIGATE,
        handler: () => openQuickBarMode("navigate"),
        enabled: browsing,
      },
      // File Search (/)
      {
        ...BROWSER_SHORTCUTS.FILE_SEARCH,
        handler: () => openQuickBarMode("file-search"),
        enabled: browsing && noDialogOrCopyMove,
      },
      // Command palette (Ctrl+P)
      {
        ...BROWSER_SHORTCUTS.COMMAND_PALETTE,
        handler: () => openQuickBarMode("commands"),
        enabled: noSettings,
      },
      // Focus connection selector (Ctrl+Down)
      {
        ...BROWSER_SHORTCUTS.FOCUS_CONNECTION_SELECTOR,
        handler: handleOpenConnectionSelector,
        enabled: !useCompactLayout && noSettings && allConnections.length > 0,
      },
      // Open settings (Ctrl+,)
      {
        ...BROWSER_SHORTCUTS.OPEN_SETTINGS,
        handler: handleOpenSettings,
        enabled: browsing,
      },
      // Show help
      {
        ...BROWSER_SHORTCUTS.SHOW_HELP,
        handler: () => setShowHelp(true),
        enabled: browsing,
      },
      {
        ...BROWSER_SHORTCUTS.SHOW_HELP_ALTERNATE,
        handler: () => setShowHelp(true),
        enabled: browsing,
      },
      // Delete file/directory (focus checked inside handler)
      {
        ...BROWSER_SHORTCUTS.DELETE_ITEM,
        handler: () => activePane.handleDeleteRequest(),
        enabled: browsing && noDialogOpen && deleteAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("delete", event),
      },
      // Rename file/directory (focus checked inside handler)
      {
        ...BROWSER_SHORTCUTS.RENAME_ITEM,
        handler: () => activePane.handleRenameRequest(),
        enabled: browsing && noDialogOpen && renameAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("rename", event),
      },
      // Copy to other pane (F5 in dual mode — takes priority over Refresh)
      {
        ...COPY_MOVE_SHORTCUTS.COPY_TO_OTHER_PANE,
        handler: () => handleCopyToOtherPane(),
        enabled: browsing && noDialogOrCopyMove && copyAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("copy", event),
      },
      // Move to other pane (F6 in dual mode)
      {
        ...COPY_MOVE_SHORTCUTS.MOVE_TO_OTHER_PANE,
        handler: () => handleMoveToOtherPane(),
        enabled: browsing && noDialogOrCopyMove && moveAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("move", event),
      },
      // Create new directory (F7)
      {
        ...BROWSER_SHORTCUTS.NEW_DIRECTORY,
        handler: () => activePane.handleNewDirectoryRequest(),
        enabled: browsing && noDialogOpen && newDirectoryAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("new-directory", event),
      },
      // Create new file (Shift+F7)
      {
        ...BROWSER_SHORTCUTS.NEW_FILE,
        handler: () => activePane.handleNewFileRequest(),
        enabled: browsing && noDialogOpen && newFileAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("new-file", event),
      },
      // Create a ZIP archive from the selected physical entries (Alt+F5)
      {
        ...BROWSER_SHORTCUTS.CREATE_ARCHIVE,
        handler: () => handleCreateArchiveRequest(),
        enabled: browsing && noDialogOpen && createArchiveAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("create-archive", event),
      },
      {
        ...BROWSER_SHORTCUTS.EXTRACT_ARCHIVE,
        handler: () => handleArchiveExtractionRequest(),
        enabled: browsing && noDialogOpen && archiveExtractionContext === null && extractArchiveAvailability.available,
        onUnavailable: (event) => handleUnavailableShortcut("extract-archive", event),
      },
      // ── Selection Shortcuts (Norton Commander multi-select) ──────────────
      // Toggle selection on the focused file (Insert / Space)
      {
        ...SELECTION_SHORTCUTS.TOGGLE_SELECTION,
        handler: () => activePane.handleToggleSelection(),
        enabled: browsing && noDialogOrCopyMove && hasFiles,
      },
      // Select focused file & move down (Alt+Down)
      {
        ...SELECTION_SHORTCUTS.SELECT_DOWN,
        handler: () => activePane.handleSelectDown(),
        enabled: browsing && noDialogOrCopyMove && hasFiles,
        priority: 10,
      },
      // Select focused file & move up (Alt+Up)
      {
        ...SELECTION_SHORTCUTS.SELECT_UP,
        handler: () => activePane.handleSelectUp(),
        enabled: browsing && noDialogOrCopyMove && hasFiles,
        priority: 10,
      },
      {
        ...SELECTION_SHORTCUTS.SELECT_TO_FIRST,
        handler: () => activePane.handleSelectToBoundary("first"),
        enabled: browsing && noDialogOrCopyMove && hasFiles,
        priority: 10,
      },
      {
        ...SELECTION_SHORTCUTS.SELECT_TO_LAST,
        handler: () => activePane.handleSelectToBoundary("last"),
        enabled: browsing && noDialogOrCopyMove && hasFiles,
        priority: 10,
      },
      // Select all files (Ctrl+A)
      {
        ...SELECTION_SHORTCUTS.SELECT_ALL,
        handler: () => activePane.handleSelectAll(),
        enabled: browsing && noDialogOrCopyMove && hasFiles,
      },

      // ── Dual-Pane Shortcuts ──────────────────────────────────────────────
      {
        ...BROWSER_SHORTCUTS.OPEN_LOCATION_IN_NEW_TAB,
        handler: (event) => {
          if (!event?.repeat) handleOpenLocationInNewTab(effectiveActivePaneId);
        },
        enabled: canOpenLocationInNewTab,
        onUnavailable: (event) => handleUnavailableLocationShortcut(event, false),
      },
      {
        ...PANE_SHORTCUTS.MATCH_LEFT_LOCATION,
        handler: () => handleMatchPaneLocation("left"),
        enabled: canMatchPaneLocations,
        onUnavailable: (event) => handleUnavailableLocationShortcut(event, true),
      },
      {
        ...PANE_SHORTCUTS.MATCH_RIGHT_LOCATION,
        handler: () => handleMatchPaneLocation("right"),
        enabled: canMatchPaneLocations,
        onUnavailable: (event) => handleUnavailableLocationShortcut(event, true),
      },
      {
        ...PANE_SHORTCUTS.TOGGLE_DUAL_PANE,
        handler: handleToggleDualPane,
        enabled: noSettings && !useCompactLayout,
      },
      {
        ...PANE_SHORTCUTS.FOCUS_LEFT_PANE,
        handler: handleFocusLeftPane,
        enabled: noSettings && noDialogOrCopyMove,
      },
      {
        ...PANE_SHORTCUTS.FOCUS_RIGHT_PANE,
        handler: handleFocusRightPane,
        enabled: noSettings && noDialogOrCopyMove,
      },
      {
        ...PANE_SHORTCUTS.SWITCH_PANE,
        handler: handleSwitchPane,
        enabled: noSettings && isDualMode && noDialogOrCopyMove,
      },
    ];
  }, [
    canOpenLocationInNewTab,
    canMatchPaneLocations,
    handleOpenLocationInNewTab,
    handleMatchPaneLocation,
    handleUnavailableLocationShortcut,
    activePane,
    activePaneCanOpenInApp,
    activePaneIsArchive,
    browserOverlayOpen,
    effectiveActivePaneId,
    getFileListShortcutAvailability,
    getOperationPolicyContext,
    handleUnavailableShortcut,
    handleDownloadRequest,
    openUploadMenu,
    handleOpenSettings,
    handleOpenConnectionSelector,
    settingsOpen,
    mobileSettingsOpen,
    useCompactLayout,
    isDualMode,
    isBrowserBrowsing,
    copyMoveDialogOpen,
    allConnections.length,
    openQuickBarMode,
    handleToggleDualPane,
    handleSwitchPane,
    handleFocusLeftPane,
    handleFocusRightPane,
    handleCopyToOtherPane,
    handleMoveToOtherPane,
    handleCreateArchiveRequest,
    handleArchiveExtractionRequest,
    handleBrowserEscape,
    archiveExtractionContext,
    t,
  ]);

  useKeyboardShortcuts({
    active: !showHelp && !viewerOverlayOpen && !archiveWorkflowDialogOpen,
    shortcuts: browserShortcuts,
  });

  // ──────────────────────────────────────────────────────────────────────────
  // Accessibility
  // ──────────────────────────────────────────────────────────────────────────

  /**
   * Keyboard vs Mouse/Touch focus tracking
   *
   * Shows focus indicators only during keyboard navigation per WCAG guidelines.
   * Hides focus ring for mouse/touch to reduce visual clutter.
   */
  useLayoutEffect(() => {
    let rafId = 0;

    const handleKeyDown = () => {
      // Cancel any pending pointer-triggered update so a quick
      // key-after-click doesn't get overridden.
      cancelAnimationFrame(rafId);
      setIsUsingKeyboard(true);
    };

    const handlePointerDown = () => {
      // Defer the state update until after the current event cycle.
      // Without this, React assigns SyncLane to the update (pointerdown
      // is a discrete event) and flushes it via microtask between the
      // pointerdown and click events.  The synchronous re-render cascades
      // through non-memoised viewer components, causing DOM mutations
      // (e.g. react-markdown's `node` prop) on the click target that
      // make the browser lose the click.
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => setIsUsingKeyboard(false));
    };

    // Use capture phase to ensure these run before any other handlers
    window.addEventListener("keydown", handleKeyDown, true);
    window.addEventListener("pointerdown", handlePointerDown, true);

    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.removeEventListener("pointerdown", handlePointerDown, true);
      cancelAnimationFrame(rafId);
    };
  }, []);

  // ──────────────────────────────────────────────────────────────────────────
  // Render Helpers
  // ──────────────────────────────────────────────────────────────────────────

  const handleLogout = async () => {
    await signOutCurrentBrowser();
    navigate("/login");
  };

  /**
   * handleConnectionsChanged
   *
   * Called when connections are added, updated, or deleted in settings.
   * Re-fetches connections and applies selection logic:
   * - If current connection still exists: keep it selected
   * - If current connection was removed: select first alphabetically
   * - If no connections remain: show welcome screen
   */
  const handleConnectionsChanged = useCallback(async () => {
    try {
      const data = await browserContentServices.connections.getConnections();
      setConnections(data);

      await companion.refresh();

      let companionDrives: Awaited<ReturnType<typeof browserContentServices.connections.getStoredCompanionDrives>> = [];
      try {
        companionDrives = await browserContentServices.connections.getStoredCompanionDrives();
      } catch (error) {
        logger.warn("Failed to refresh companion drives after settings change", { error }, "companion");
      }

      const availableConnections = mergeConnections(data, companionDrives);
      const hasConnection = (connectionId: string) => availableConnections.some((connection) => connection.id === connectionId);

      // Invalidate caches in both panes since connection properties may have changed
      const leftConnId = leftPane.connectionId;
      if (leftConnId && hasConnection(leftConnId)) {
        leftPane.invalidateConnectionCache(leftConnId);
        void leftPane.reloadCurrentLocation({ forceRefresh: true });
      }
      const rightConnId = rightPane.connectionId;
      if (rightConnId && hasConnection(rightConnId)) {
        rightPane.invalidateConnectionCache(rightConnId);
        void rightPane.reloadCurrentLocation({ forceRefresh: true });
      }

      // Check if left pane's connection still exists
      if (leftConnId && hasConnection(leftConnId)) {
        // Left pane's connection is fine — check right pane too
        if (rightConnId && !hasConnection(rightConnId)) {
          navigateToBrowseState(
            {
              left: buildBrowseRouteTarget(
                leftConnId,
                leftPane.currentPathRef.current,
                availableConnections,
                toVirtualRouteLocation(leftPane.archiveLocation)
              ),
              right: null,
              activePaneId: "left",
            },
            { replace: true }
          );
        }
        return;
      }

      // Left pane's connection removed or no selection - select first alphabetically
      if (availableConnections.length > 0) {
        const sortedByName = [...availableConnections].sort((a, b) => compareLocalizedStrings(a.name, b.name));
        const firstConnection = sortedByName[0];
        if (firstConnection) {
          navigateToBrowseState(
            {
              left: buildBrowseRouteTarget(firstConnection.id, "", availableConnections),
              right: null,
              activePaneId: "left",
            },
            { replace: true }
          );
        }
      } else {
        // No connections remaining - show welcome screen
        leftPane.applyLocation("", "");
        rightPane.applyLocation("", "");
        localStorage.removeItem("selectedConnectionId");
        navigate("/browse", { replace: true });
      }
    } catch (err) {
      logger.error("Error refreshing connections", { error: err }, "browser");
    }
  }, [
    browserContentServices.connections.getConnections,
    browserContentServices.connections.getStoredCompanionDrives,
    companion,
    leftPane,
    navigate,
    navigateToBrowseState,
    rightPane,
  ]);

  // ── Computed values for the active pane (used in toolbar / mobile) ────────
  const activeCurrentPath = activePane.currentPath;
  const activeArchiveLocation = activePane.archiveLocation;
  const activeDisplayPath = activeArchiveLocation?.virtualPath || activeArchiveLocation?.archivePath || activeCurrentPath;
  const pathParts = activeDisplayPath ? activeDisplayPath.split("/") : [];
  const currentDirectoryName = (pathParts.length > 0 && pathParts[pathParts.length - 1]) || "Root";
  const canNavigateUp = activeArchiveLocation !== null || activeCurrentPath !== "";

  // Force single-pane on mobile
  const effectivePaneMode: PaneMode = useCompactLayout ? "single" : paneMode;
  const getPaneDropUnavailableReason = (paneId: PaneId): string | null => {
    const availability = getFileListShortcutAvailability("upload", getOperationPolicyContext(paneId));
    if (uploadSessionActive) return t("fileBrowser.transfers.dropBusy");
    if (!availability.available) {
      if (availability.reason === "interaction-blocked") return t("fileBrowser.transfers.dropBusy");
      if (availability.reason === "companion-unavailable") return t("fileBrowser.unavailableShortcuts.companionUnavailable");
      return t("fileBrowser.transfers.dropUnavailable");
    }
    if (typeof DataTransferItem === "undefined" || !("webkitGetAsEntry" in DataTransferItem.prototype)) {
      return t("fileBrowser.transfers.dropUnsupported");
    }
    return null;
  };

  // ──────────────────────────────────────────────────────────────────────────
  // Component Render
  // ──────────────────────────────────────────────────────────────────────────

  return (
    <OperationNotificationProvider>
      <Box
        sx={getMobileViewportShellSx(useCompactLayout)}
        onKeyDown={handleBrowserKeyDown}
        onDragOverCapture={(event) => {
          if (
            Array.from(event.dataTransfer.types).includes("Files") &&
            !(event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]"))
          )
            event.preventDefault();
        }}
        onDropCapture={(event) => {
          if (
            Array.from(event.dataTransfer.types).includes("Files") &&
            !(event.target instanceof Element && event.target.closest("input, textarea, [contenteditable=true]"))
          )
            event.preventDefault();
        }}
      >
        {/* Hamburger Menu - Mobile Only */}
        <HamburgerMenu
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          connections={allConnections}
          selectedConnectionId={activePane.connectionId}
          onConnectionChange={activePane.handleConnectionChange}
          onNavigateToRoot={() => {
            if (effectiveActivePaneId === "right" && paneMode === "dual") {
              rightPathNavigateRef.current("");
            } else {
              leftPathNavigateRef.current("");
            }
            activePane.setViewInfo(null);
          }}
          onOpenDocumentation={handleOpenDocumentation}
          onOpenSettings={handleOpenSettings}
          onLogout={handleLogout}
        />
        <AppBar position="static" elevation={useCompactLayout ? undefined : 0} sx={mobileSafeAreaAppBarSx}>
          <Toolbar sx={mobileSafeAreaToolbarSx}>
            {useCompactLayout ? (
              <MobileToolbar
                currentDirectoryName={currentDirectoryName}
                onOpenMenu={() => setDrawerOpen(true)}
                onNavigateUp={activePane.handleNavigateUp}
                canNavigateUp={canNavigateUp}
              />
            ) : (
              <DesktopToolbar
                searchProvider={quickBarProvider}
                searchActivationToken={quickBarActivationToken}
                searchRefreshToken={quickBarRefreshToken}
                searchInputRef={quickBarPane.searchInputRef}
                showSearch={activePane.connectionId !== ""}
                onOpenHelp={() => setShowHelp(true)}
                onOpenDocumentation={handleOpenDocumentation}
                onOpenSettings={handleOpenSettings}
                onBlurToFileList={() => quickBarPane.listContainerEl?.focus()}
                searchQueryValue={quickBarQueryValue}
                onSearchQueryValueChange={handleQuickBarQueryValueChange}
                disableSearchDropdown={false}
                suppressSearchDropdown={suppressQuickBarDropdown}
                onSearchArrowDownToFileList={handleQuickBarArrowDownToFileList}
                disableTabFocus={isDualMode}
                modeOptions={quickBarModeOptions}
                showKeyboardHints={showQuickBarKeyboardHints}
              />
            )}
            <FileBrowserStatus
              backendAvailabilityStatus={backendAvailability.status}
              companionLifecycleStatus={companionLifecycleStatus}
              onRetry={activePane.handleRefresh}
              onOpenLocalDrivesSettings={openLocalDrivesSettings}
            />
          </Toolbar>
        </AppBar>
        {/* Secondary action strip — view mode & sort controls for the active pane (desktop only) */}
        {!useCompactLayout && (
          <SecondaryActionStrip
            connections={allConnections}
            selectedConnectionId={activePane.connectionId}
            onConnectionChange={activePane.handleConnectionChange}
            viewMode={activePane.viewMode}
            onViewModeChange={activePane.setViewMode}
            isDualPane={isDualMode}
            onToggleDualPane={handleToggleDualPane}
            sortBy={activePane.sortBy}
            onSortChange={(sortBy) => {
              activePane.handleClearSelection();
              activePane.setSortBy(sortBy);
            }}
            sortDirection={activePane.sortDirection}
            onDirectionChange={() => {
              activePane.handleClearSelection();
              activePane.setSortDirection((direction) => (direction === "asc" ? "desc" : "asc"));
            }}
            hasFiles={activePane.files.length > 0}
            onBlurToFileList={() => activePane.listContainerEl?.focus()}
            disableTabFocus={isDualMode}
            companionStatus={companion.status}
            onOpenConnectionsSettings={openConnectionsSettings}
            connectionButtonRef={connectionSelectorButtonRef}
          />
        )}

        <Container
          maxWidth={false}
          disableGutters
          sx={{
            flex: 1,
            minHeight: 0,
            display: "flex",
            flexDirection: "column",
            pt: 2,
            pb: { xs: SAFE_AREA_INSET.BOTTOM, sm: 0 },
            overflow: "hidden",
            overscrollBehaviorY: "contain",
          }}
        >
          <FileBrowserAlerts
            error={leftPane.connectionId ? null : leftPane.error}
            companionPairingError={leftPane.companionPairingError}
            onOpenLocalDrivesSettings={openLocalDrivesSettings}
            companionLifecycleStatus={companionLifecycleStatus}
            loadingConnections={loadingConnections}
            connectionsCount={connections.length}
            backendAvailabilityStatus={backendAvailability.status}
            hasUsableContent={Boolean(leftPane.connectionId) && !leftPane.directoryUnavailable}
            onReload={() => {
              if (viewerLeaveGuard?.shouldBlock())
                viewerLeaveGuard.requestLeave({ proceed: () => window.location.reload(), reset: () => {} });
              else window.location.reload();
            }}
            onRetry={leftPane.handleRefresh}
            onOpenConnectionsSettings={openConnectionsSettings}
          />

          {/* Pane content area — single or dual-pane layout */}
          {leftPane.connectionId && (
            <>
              <Box
                sx={{
                  display: "flex",
                  flex: 1,
                  minHeight: 0,
                  overflow: "hidden",
                }}
              >
                {/* Left Pane — always visible */}
                <FileBrowserPane
                  pane={leftPane}
                  onOpenLocalDrivesSettings={openLocalDrivesSettings}
                  onReload={() => {
                    if (viewerLeaveGuard?.shouldBlock())
                      viewerLeaveGuard.requestLeave({ proceed: () => window.location.reload(), reset: () => {} });
                    else window.location.reload();
                  }}
                  paneId="left"
                  dropTargetLabel={
                    leftPane.currentLocation.kind === "physical"
                      ? formatConnectionPath(
                          getConnectionById(allConnections, leftPane.currentLocation.connectionId)?.name ?? "",
                          leftPane.currentLocation.path
                        )
                      : undefined
                  }
                  dropUnavailableReason={getPaneDropUnavailableReason("left")}
                  onFileDrop={(event) => handlePaneFileDrop("left", event)}
                  isActive={effectiveActivePaneId === "left"}
                  paneMode={effectivePaneMode}
                  connections={allConnections}
                  useCompactLayout={useCompactLayout}
                  useTouchSelectionControls={useTouchSelectionControls}
                  compactActionsDisabled={browserOverlayOpen}
                  isUsingKeyboard={isUsingKeyboard}
                  onPaneFocus={() => {
                    if (paneMode === "dual" && pendingPaneFocusRef.current === null) {
                      replaceActivePaneInRoute("left");
                    }
                  }}
                  disableTabFocus={isDualMode}
                  searchProvider={quickBarProvider}
                  searchActivationToken={quickBarActivationToken}
                  searchRefreshToken={quickBarRefreshToken}
                  searchQueryValue={quickBarQueryValue}
                  onSearchQueryValueChange={handleQuickBarQueryValueChange}
                  disableSearchDropdown={false}
                  suppressSearchDropdown={suppressQuickBarDropdown}
                  onSearchArrowDownToFileList={handleQuickBarArrowDownToFileList}
                  showKeyboardHints={showQuickBarKeyboardHints}
                  modeOptions={quickBarModeOptions}
                  getCompactCreateActions={buildCompactCreateActions}
                  getCompactItemActions={buildCompactItemActions}
                  getCompactSelectionActions={buildCompactSelectionActions}
                />

                {/* Divider + Right Pane — dual mode only */}
                {isDualMode && rightPane.connectionId && (
                  <>
                    <Divider orientation="vertical" flexItem />
                    <FileBrowserPane
                      pane={rightPane}
                      onOpenLocalDrivesSettings={openLocalDrivesSettings}
                      onReload={() => {
                        if (viewerLeaveGuard?.shouldBlock())
                          viewerLeaveGuard.requestLeave({ proceed: () => window.location.reload(), reset: () => {} });
                        else window.location.reload();
                      }}
                      paneId="right"
                      dropTargetLabel={
                        rightPane.currentLocation.kind === "physical"
                          ? formatConnectionPath(
                              getConnectionById(allConnections, rightPane.currentLocation.connectionId)?.name ?? "",
                              rightPane.currentLocation.path
                            )
                          : undefined
                      }
                      dropUnavailableReason={getPaneDropUnavailableReason("right")}
                      onFileDrop={(event) => handlePaneFileDrop("right", event)}
                      isActive={effectiveActivePaneId === "right"}
                      paneMode={effectivePaneMode}
                      connections={allConnections}
                      useCompactLayout={useCompactLayout}
                      useTouchSelectionControls={useTouchSelectionControls}
                      compactActionsDisabled={browserOverlayOpen}
                      isUsingKeyboard={isUsingKeyboard}
                      onPaneFocus={() => {
                        if (pendingPaneFocusRef.current === null) {
                          replaceActivePaneInRoute("right");
                        }
                      }}
                      disableTabFocus={isDualMode}
                      searchProvider={quickBarProvider}
                      searchActivationToken={quickBarActivationToken}
                      searchRefreshToken={quickBarRefreshToken}
                      searchQueryValue={quickBarQueryValue}
                      onSearchQueryValueChange={handleQuickBarQueryValueChange}
                      disableSearchDropdown={false}
                      suppressSearchDropdown={suppressQuickBarDropdown}
                      onSearchArrowDownToFileList={handleQuickBarArrowDownToFileList}
                      showKeyboardHints={showQuickBarKeyboardHints}
                      modeOptions={quickBarModeOptions}
                      getCompactCreateActions={buildCompactCreateActions}
                      getCompactItemActions={buildCompactItemActions}
                      getCompactSelectionActions={buildCompactSelectionActions}
                    />
                  </>
                )}
              </Box>
              {!useCompactLayout && (
                <FileOperationsToolbar
                  actions={fileOperationActions}
                  moreLabel={t("fileBrowser.toolbar.more")}
                  onUploadTriggerChange={handleUploadAnchorChange}
                />
              )}
              {!useCompactLayout && (
                <Box sx={{ display: "flex", minHeight: 0 }}>
                  <Box sx={{ flex: 1, minWidth: 0 }}>
                    <StatusBar
                      files={leftPane.sortedFiles}
                      focusedIndex={leftPane.focusedIndex}
                      selectedCount={leftPane.selectedFiles.size}
                      canResolveShortcutTargets={leftPane.contentCapabilities.mutate && isLocalDrive(leftPane.connectionId)}
                    />
                  </Box>
                  {isDualMode && rightPane.connectionId && (
                    <>
                      <Divider orientation="vertical" flexItem />
                      <Box sx={{ flex: 1, minWidth: 0 }}>
                        <StatusBar
                          files={rightPane.sortedFiles}
                          focusedIndex={rightPane.focusedIndex}
                          selectedCount={rightPane.selectedFiles.size}
                          canResolveShortcutTargets={rightPane.contentCapabilities.mutate && isLocalDrive(rightPane.connectionId)}
                        />
                      </Box>
                    </>
                  )}
                </Box>
              )}
            </>
          )}
        </Container>
        {/* Settings Dialog (Desktop only) */}
        {!useCompactLayout && (
          <SettingsDialog
            open={settingsOpen}
            onClose={handleSettingsClose}
            initialCategory={settingsInitialCategory}
            category={settingsInitialCategory}
            onNavigate={workspace.openSettings}
            onConnectionsChanged={handleConnectionsChanged}
          />
        )}
        {/* Settings Drawer (Mobile only) */}
        {useCompactLayout && (
          <MobileSettingsDrawer
            open={mobileSettingsOpen}
            onClose={handleSettingsClose}
            onConnectionsChanged={handleConnectionsChanged}
            initialView={mobileSettingsInitialView}
            view={mobileSettingsInitialView}
            onNavigate={workspace.openSettings}
            onBack={workspace.backSettings}
          />
        )}
        {/* Viewer overlay — full-screen, from whichever pane opened it */}
        {viewerLeaveGuard ? <WorkspaceNavigationGuard guard={viewerLeaveGuard} /> : null}
        {workspace.viewerError && currentRoute.viewer ? (
          <ViewerFallbackDialog
            mode="failed"
            path={currentRoute.viewer.file.path}
            error={workspace.viewerError}
            onClose={workspace.closeViewer}
            onRetry={workspace.retryViewer}
          />
        ) : null}
        {displayedViewerInfo && (
          <DynamicViewer
            connectionId={displayedViewerInfo.connectionId ?? displayedViewerPane.connectionId}
            isReadOnly={isConnectionReadOnly(
              getConnectionById(allConnections, displayedViewerInfo.connectionId ?? displayedViewerPane.connectionId)
            )}
            isPending={workspace.viewerLoading}
            viewInfo={displayedViewerInfo}
            navigation={{
              selectionKey: workspace.viewerSelectionKey,
              mode: currentRoute.viewer?.mode ?? "view",
              onModeChange: workspace.changeMode,
              onGuardChange: setViewerLeaveGuard,
            }}
            onClose={workspace.closeViewer}
            onIndexChange={(index) => workspace.changeImage(leftPane.viewInfo ? "left" : "right", index)}
            hasMoreItems={displayedViewerInfo.virtualSource ? displayedViewerPane.archiveHasMore : false}
            isLoadingMoreItems={displayedViewerInfo.virtualSource ? displayedViewerPane.archiveLoadingMore : false}
            onLoadMoreItems={displayedViewerInfo.virtualSource ? displayedViewerPane.loadMoreArchive : undefined}
            contentProviders={browserContentServices.providers}
          />
        )}
        {/* Keyboard Shortcuts Help */}
        <KeyboardShortcutsHelp
          open={showHelp}
          onClose={() => setShowHelp(false)}
          shortcuts={browserShortcuts}
          title={t("keyboardShortcutsHelp.titles.fileBrowser")}
        />
        <NameInputDialog
          open={archiveCreateContext !== null}
          title={t("fileBrowser.archive.createTitle")}
          description={
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("fileBrowser.archive.createDescription", { count: archiveCreateContext?.sources.length ?? 0 })}
            </Typography>
          }
          operationContext={
            <DialogOperationContext
              entries={[
                ...(archiveCreateContext?.sources.length === 1
                  ? [
                      {
                        label: t("fileBrowser.operationContext.sourceItem"),
                        value: fileName(archiveCreateContext.sources[0]!.path),
                        kind: "fileName" as const,
                      },
                    ]
                  : []),
                {
                  label: t("fileBrowser.operationContext.destinationDirectory"),
                  value: archiveCreateContext?.destinationLabel ?? "",
                  kind: "path",
                },
              ]}
            />
          }
          inputLabel={t("fileBrowser.archive.nameLabel")}
          initialValue="archive.zip"
          submitLabel={t("fileBrowser.archive.buttonCreate")}
          submittingLabel={t("fileBrowser.archive.buttonCreating")}
          isSubmitting={isCreatingArchive}
          isCancelling={isCancellingArchiveCreation}
          onCancelSubmitting={isCreatingArchive ? () => void cancelArchiveCreation() : undefined}
          cancelSubmittingLabel={t("fileBrowser.archive.buttonCancelCreation")}
          onClose={() => {
            if (!isCreatingArchive) {
              setArchiveCreateContext(null);
              setArchiveCreateError(null);
            }
          }}
          onConfirm={handleCreateArchiveConfirm}
          apiError={archiveCreateError}
          extraValidate={(name) => (name.toLowerCase().endsWith(".zip") ? null : t("fileBrowser.archive.validationExtension"))}
          autoSelectRange={[0, "archive".length]}
          submittingContent={<ArchiveOperationProgress operation="create" />}
          disableRestoreFocus={!useCompactLayout}
          onTransitionExited={handleFileOperationDialogExited}
        />
        <ArchiveExtractDialog
          archiveName={archiveExtractionContext?.archiveName ?? ""}
          extractionScope={archiveExtractionContext?.extractionScope ?? FULL_ARCHIVE_EXTRACTION_SCOPE}
          initialDestinationName={archiveExtractionContext?.initialDestinationName ?? ""}
          destinationLabel={archiveExtractionContext?.destinationLabel}
          sourcePathPrefix={
            archiveExtractionContext
              ? getLocationDisplayName(
                  archiveExtractionContext.location,
                  (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId
                )
              : undefined
          }
          targetConnectionName={
            archiveExtractionContext
              ? (getConnectionById(
                  allConnections,
                  (archiveExtractionContext.destination ?? archiveExtractionContext.destinationParent).connectionId
                )?.name ?? (archiveExtractionContext.destination ?? archiveExtractionContext.destinationParent).connectionId)
              : undefined
          }
          requiresDestinationName={archiveExtractionContext?.usesSiblingDirectory ?? true}
          open={archiveExtractionContext !== null}
          isExtracting={isExtractingArchive}
          isCancelling={isCancellingArchiveExtraction}
          error={archiveExtractionError}
          memberError={archiveExtractionMemberError}
          progressSummary={archiveExtractionProgress}
          conflicts={archiveExtractionConflicts}
          allowedConflictActions={archiveExtractionAllowedActions}
          isSubmittingConflictDecision={isSubmittingArchiveExtractionDecision || isCancellingArchiveExtraction}
          onClose={() => {
            if (!isExtractingArchive) {
              setArchiveExtractionContext(null);
              setArchiveExtractionError(null);
            }
          }}
          onConfirm={(destinationName) => void handleArchiveExtractionConfirm(destinationName)}
          onCancelExtraction={() => void cancelArchiveExtraction()}
          onMemberErrorDecision={(action) => void handleArchiveExtractionMemberErrorDecision(action)}
          onConflictDecision={(action, memberPath, targetPath) => void handleArchiveExtractionDecision(action, memberPath, targetPath)}
          disableRestoreFocus={!useCompactLayout}
          onTransitionExited={handleFileOperationDialogExited}
        />
        {/* Companion app guidance hint */}
        <OperationNotifications
          notices={
            companionHintOpen
              ? [
                  {
                    id: "companion-hint",
                    message: t("fileBrowser.chrome.alerts.companionLaunchHint"),
                    severity: "info",
                    duration: TRANSFER_NOTICE_AUTOHIDE_MS,
                    onExpire: () => setCompanionHintOpen(false),
                  },
                ]
              : []
          }
          onDismiss={() => setCompanionHintOpen(false)}
        />
        <OperationNotifications
          notices={
            archiveExtractionNotice
              ? [
                  {
                    id: "archive-extraction",
                    message: archiveExtractionNotice,
                    severity: "info",
                    duration: TRANSFER_NOTICE_AUTOHIDE_MS,
                    onExpire: () => setArchiveExtractionNotice(null),
                  },
                ]
              : []
          }
          onDismiss={() => setArchiveExtractionNotice(null)}
        />
        <OperationNotifications
          notices={
            unavailableShortcutNotice
              ? [
                  {
                    id: "unavailable-shortcut",
                    occurrence: unavailableShortcutNotice.id,
                    message: unavailableShortcutNotice.message,
                    severity: "info",
                    duration: TRANSFER_NOTICE_AUTOHIDE_MS,
                    onExpire: () => setUnavailableShortcutNotice(null),
                  },
                ]
              : []
          }
          onDismiss={() => setUnavailableShortcutNotice(null)}
        />
        {/* Copy / Move Dialog (dual-pane F5/F6) */}
        <CopyMoveDialog
          open={copyMoveDialogOpen}
          mode={copyMoveMode}
          files={copyMoveItems.map((item) => item.entry)}
          destinationLabel={copyMoveDestinationLabel}
          isSameDirectory={copyMoveSameDirectory}
          onConfirm={handleCopyMoveConfirm}
          onCancel={handleCopyMoveCancel}
          isProcessing={copyMoveProcessing}
          progress={copyMoveProgress}
          transferProgress={copyMoveTransferProgress}
          error={copyMoveError}
          warning={copyMoveWarning}
          isTerminal={!copyMoveProcessing && Boolean(copyMoveError || copyMoveWarning)}
          disableRestoreFocus={!useCompactLayout}
          onTransitionExited={handleFileOperationDialogExited}
        />
        {/* Overwrite Conflict Dialog (shown per-file during copy/move) */}
        <OverwriteResolutionDialog
          open={conflictDialogOpen || uploadConflict !== null}
          conflict={uploadConflict?.info ?? conflictInfo}
          operation={uploadConflict ? "upload" : copyMoveMode}
          uploadKind={uploadConflict?.kind}
          allowedActions={uploadConflict ? uploadConflict.actions : getCopyMoveConflictActions(conflictInfo)}
          canApplyToAll={treeConflictAllowsApplyToAll ? () => true : undefined}
          progress={conflictProgress}
          sourcePath={
            uploadConflict
              ? uploadConflict.path
              : conflictInfo && copyMoveItems[0]
                ? getLocationDisplayName(
                    {
                      kind: "physical",
                      connectionId: copyMoveItems[0].handle.location.connectionId,
                      path: conflictInfo.incoming_file.path,
                    },
                    (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId
                  )
                : undefined
          }
          targetDirectoryPath={
            (uploadConflict?.info ?? conflictInfo) && (uploadConflict || copyMoveDestination)
              ? getLocationDisplayName(
                  {
                    kind: "physical",
                    connectionId: uploadConflict ? uploadConflict.connectionId : copyMoveDestination!.connectionId,
                    path: parentPath((uploadConflict?.info ?? conflictInfo)!.existing_file.path),
                  },
                  (connectionId) => getConnectionById(allConnections, connectionId)?.name ?? connectionId
                )
              : undefined
          }
          onResolve={handleConflictResolve}
          onCancel={handleConflictCancel}
        />
        <Menu key={uploadMenuOpenId.current} anchorEl={uploadMenu?.anchor} open={Boolean(uploadMenu)} onClose={closeUploadMenu} autoFocus>
          <MenuItem onClick={() => selectUploadChoice(false)}>{t("fileBrowser.toolbar.uploadChoiceFiles")}</MenuItem>
          <MenuItem onClick={() => selectUploadChoice(true)}>{t("fileBrowser.toolbar.uploadChoiceFolder")}</MenuItem>
        </Menu>
        <OperationNotifications
          notices={
            fileShareState
              ? [
                  {
                    id: "file-share",
                    severity: "info",
                    persistent: fileShareState.status !== "sharing",
                    message: fileShareState
                      ? t(
                          fileShareState.status === "preparing"
                            ? "fileBrowser.share.preparing"
                            : fileShareState.status === "ready"
                              ? "fileBrowser.share.ready"
                              : "fileBrowser.share.sharing",
                          { count: fileShareState.status === "preparing" ? fileShareState.count : fileShareState.files.length }
                        )
                      : "",
                    action:
                      fileShareState?.status === "ready" ? (
                        <>
                          <Button color="inherit" onClick={cancelFileShare}>
                            {t("common.actions.cancel")}
                          </Button>
                          <Button color="inherit" onClick={() => void finishFileShare()}>
                            {t("common.actions.share")}
                          </Button>
                        </>
                      ) : fileShareState?.status === "preparing" ? (
                        <Button color="inherit" onClick={cancelFileShare}>
                          {t("common.actions.cancel")}
                        </Button>
                      ) : undefined,
                  },
                ]
              : []
          }
        />
        {nativeSharing.failureDialog}
        <OperationNotifications
          notices={
            uploadProgress || uploadPreparing || showDownloadNotice || transferNotice
              ? [
                  {
                    severity: "info",
                    id: uploadProgress
                      ? "upload-progress"
                      : uploadPreparing
                        ? "upload-preparing"
                        : isDownloading
                          ? "download-progress"
                          : `transfer-${transferNotice}`,
                    persistent: Boolean(uploadProgress || uploadPreparing || showDownloadNotice),
                    duration: TRANSFER_NOTICE_AUTOHIDE_MS,
                    onExpire: () => {
                      if (!uploadProgress && !uploadPreparing && !showDownloadNotice) setTransferNotice("");
                    },
                    message: uploadProgress
                      ? t(
                          uploadProgress.phase === "publishing"
                            ? "fileBrowser.transfers.uploadPublishing"
                            : uploadProgress.bytes === null
                              ? "fileBrowser.transfers.uploadSending"
                              : "fileBrowser.transfers.uploadProgress",
                          {
                            ...uploadProgress,
                            bytes: formatFileSize(uploadProgress.bytes ?? 0),
                            size: formatFileSize(uploadProgress.size),
                          }
                        )
                      : uploadPreparing
                        ? t("fileBrowser.transfers.preparingUpload")
                        : showDownloadNotice
                          ? t(downloadKind === "archive" ? "fileBrowser.transfers.preparingArchive" : "fileBrowser.transfers.downloading")
                          : transferNotice,
                    action:
                      uploadProgress || uploadPreparing || showDownloadNotice ? (
                        <Button
                          color="inherit"
                          onClick={() => {
                            cancelUpload();
                            cancelDownload();
                          }}
                        >
                          {t("common.actions.cancel")}
                        </Button>
                      ) : undefined,
                  },
                ]
              : []
          }
          onDismiss={() => {
            if (!uploadProgress && !uploadPreparing && !showDownloadNotice) setTransferNotice("");
          }}
        />
      </Box>
    </OperationNotificationProvider>
  );
};

export default Browser;
