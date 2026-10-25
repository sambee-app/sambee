import { Refresh } from "@mui/icons-material";
import { Alert, Box, Button, CircularProgress, Dialog, useMediaQuery, useTheme } from "@mui/material";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { useTranslation } from "react-i18next";
import { BROWSER_SHORTCUTS, CODEMIRROR_EDITOR_SHORTCUTS, COMMON_SHORTCUTS, VIEWER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { checkIsTransientError, getTransientErrorMessage, useApiRetry } from "../../hooks/useApiRetry";
import { useKeyboardShortcuts, withShortcut } from "../../hooks/useKeyboardShortcuts";
import { useRoutedViewerEditing } from "../../hooks/useRoutedViewerEditing";
import { useViewerSharing } from "../../hooks/useViewerSharing";
import {
  beginViewerTextEdit,
  type ContentEditSession,
  readViewerContent,
  readVirtualContent,
  useContentProviderRegistry,
} from "../../pages/FileBrowser/contentProviders";
import { useTextEditorMaxFileSizeBytesPreference, useTextEditorWordWrapPreference } from "../../pages/FileBrowser/preferences";
import { clearDraft, type DraftSnapshot, loadDraft, registerDraftSnapshot, saveDraft } from "../../services/draftRecovery";
import { error as logError, info as logInfo } from "../../services/logger";
import { ExpiredEditLockError } from "../../services/storageContracts";
import { useSambeeTheme } from "../../theme";
import { getSearchHighlightColors } from "../../theme/commonStyles";
import {
  CODEMIRROR_EDITOR_CONTENT_PADDING,
  CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE,
  getViewerColors,
  VIEWER_SCROLL_END_PADDING,
} from "../../theme/viewerStyles";
import { isApiError } from "../../types";
import { getApiErrorMessage } from "../../utils/apiErrors";
import { openExternalUrl } from "../../utils/externalLinks";
import type { ViewerComponentProps } from "../../utils/FileTypeRegistry";
import { blurActiveToolbarControl } from "../../utils/keyboardUtils";
import { createShareFile, supportsNativeShare } from "../../utils/nativeShare";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { HelpMenu } from "../FileBrowser/HelpMenu";
import { KeyboardShortcutsHelp } from "../KeyboardShortcutsHelp";
import { settingsUtilityButtonSx } from "../Settings/settingsButtonStyles";
import { ViewerShareMenu } from "../Sharing/ViewerShareMenu";
import { CodeMirrorFindReplacePopover } from "./CodeMirrorFindReplacePopover";
import { scheduleRetriableFocusRestore } from "./focusRestoration";
import MarkdownEditorErrorBoundary from "./MarkdownEditorErrorBoundary";
import { RecoveredDraftDialog } from "./RecoveredDraftDialog";
import { TextCodeEditor, type TextCodeEditorHandle, type TextCodeEditorSearchState } from "./TextCodeEditor";
import { useMarkdownEditSession } from "./useMarkdownEditSession";
import { VIEWER_SEARCH_INPUT_ATTRIBUTE, ViewerControls, ViewerFilenameBadge, type ViewerToolbarAction } from "./ViewerControls";
import {
  useViewerLockNotice,
  useViewerOperationError,
  VIEWER_EDIT_HEARTBEAT_MS,
  ViewerEditAcquisitionStatus,
  type ViewerNotice,
  ViewerNotifications,
  type ViewerReadOnlyReason,
} from "./ViewerNotifications";
import { downloadViewerBlob } from "./viewerContent";
import { createSaveToolbarAction } from "./viewerToolbarActions";

type PendingUnsavedChangesAction = "stay-edit" | "navigate" | "close";
type TextSearchCloseReason = "escape" | "toggle";
type TextReadOnlyReason = ViewerReadOnlyReason;

const DRAFT_SNAPSHOT_DEBOUNCE_MS = 250;

function withOpacity(color: string, opacity: number): string {
  const normalizedOpacity = Math.max(0, Math.min(1, opacity));
  const hex = color.trim().replace(/^#/, "");

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${normalizedOpacity})`;
  }

  return color;
}

function isViewerSearchInputFocused(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  return document.activeElement instanceof HTMLElement && document.activeElement.getAttribute(VIEWER_SEARCH_INPUT_ATTRIBUTE) === "true";
}

function isTextEditorTextInputFocused(): boolean {
  if (typeof document === "undefined") {
    return false;
  }

  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  if (!activeElement.closest(".sambee-text-editor")) {
    return false;
  }

  return activeElement.matches("textarea, [contenteditable='true']");
}

function preserveTextEditorSelection(editorRef: React.RefObject<TextCodeEditorHandle | null>): void {
  editorRef.current?.preserveSelection();
}

function areTextEditorSearchStatesEqual(left: TextCodeEditorSearchState, right: TextCodeEditorSearchState): boolean {
  return (
    left.searchText === right.searchText &&
    left.searchMatches === right.searchMatches &&
    left.currentMatch === right.currentMatch &&
    left.isSearchOpen === right.isSearchOpen &&
    left.isSearchable === right.isSearchable &&
    left.isValid === right.isValid &&
    left.pending === right.pending &&
    left.error === right.error &&
    left.viewMode === right.viewMode
  );
}

export const TextEditor: React.FC<ViewerComponentProps> = ({
  connectionId,
  path,
  fileSize,
  fileModifiedAt,
  onClose,
  isReadOnly: connectionIsReadOnly = false,
  virtualSource,
  navigation,
  isTransitioning = false,
}) => {
  const isReadOnly = connectionIsReadOnly || virtualSource !== undefined;
  const contentProviders = useContentProviderRegistry();
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError, editErrorOccurrence] = useViewerOperationError();
  const [shareRevision, setShareRevision] = useState(0);
  const [draftStorageWarning, setDraftStorageWarning] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<DraftSnapshot | null>(null);
  const [isResumingRecoveryDraft, setIsResumingRecoveryDraft] = useState(false);
  const [showEditorHelp, setShowEditorHelp] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAcquiring, setIsAcquiring] = useState(false);
  const [readOnlyReason, setReadOnlyReason] = useState<TextReadOnlyReason | null>(null);
  const [lockNoticeOccurrence, setLockNoticeOccurrence] = useState(0);
  const [heartbeatWarning, setHeartbeatWarning] = useState(false);
  const [conflict, setConflict] = useState<{ serverContent: string; draftContent: string } | null>(null);
  const acquisitionPending = useRef(false);
  const editActivation = useRef(0);
  const hasActivatedEditorRef = useRef(false);
  const [editSession, setEditSession] = useState<ContentEditSession | null>(null);
  const [searchCaseSensitive, setSearchCaseSensitive] = useState(false);
  const [searchFocusTarget, setSearchFocusTarget] = useState<"find" | "replace" | null>(null);
  const [searchMode, setSearchMode] = useState<"find" | "replace">("find");
  const [searchRegexp, setSearchRegexp] = useState(false);
  const [searchReplaceText, setSearchReplaceText] = useState("");
  const [searchText, setSearchText] = useState("");
  const [searchWholeWord, setSearchWholeWord] = useState(false);
  const [searchMatches, setSearchMatches] = useState(0);
  const [currentSearchMatch, setCurrentSearchMatch] = useState(0);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [searchAutoNavigate, setSearchAutoNavigate] = useState(true);
  const [editorBoundaryKey, setEditorBoundaryKey] = useState(0);
  const [pendingUnsavedChangesAction, setPendingUnsavedChangesAction] = useState<PendingUnsavedChangesAction | null>(null);
  const [editorSearchState, setEditorSearchState] = useState<TextCodeEditorSearchState>({
    searchText: "",
    searchMatches: 0,
    currentMatch: 0,
    isSearchOpen: false,
    isSearchable: true,
    isValid: true,
    viewMode: "source",
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<TextCodeEditorHandle | null>(null);
  const unsavedChangesCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const editBaselineContentRef = useRef("");
  const editSessionRef = useRef<ContentEditSession | null>(null);
  const releasePromise = useRef<Promise<void> | null>(null);
  const isEditingRef = useRef(false);
  const translationRef = useRef(t);
  const fetchWithRetry = useApiRetry();

  const { currentTheme } = useSambeeTheme();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const shareEnabled = isMobile && supportsNativeShare();
  const { viewerBg, toolbarBg, toolbarText, viewerText, linkColor } = getViewerColors(currentTheme, "markdown");
  const searchHighlightColors = useMemo(() => getSearchHighlightColors(muiTheme, currentTheme), [currentTheme, muiTheme]);
  const filename = path.split("/").pop() || path;
  const [maxFileSizeBytes] = useTextEditorMaxFileSizeBytesPreference();
  const [wordWrapEnabled, setWordWrapEnabled] = useTextEditorWordWrapPreference(false);
  const contentSizeBytes = useMemo(() => new Blob([content]).size, [content]);
  const exceedsEditorLimit = !loading && !error && contentSizeBytes > maxFileSizeBytes;
  const textEditorTheme = useMemo(
    () => ({
      accentColor: linkColor,
      activeLineBackground: muiTheme.palette.action.selected,
      borderColor: withOpacity(viewerText, muiTheme.palette.mode === "dark" ? 0.32 : 0.16),
      currentSearchMatchBackground: searchHighlightColors.currentMatch,
      isDarkMode: muiTheme.palette.mode === "dark",
      otherSearchMatchBackground: searchHighlightColors.otherMatches,
      selectionBackground: withOpacity(linkColor, muiTheme.palette.mode === "dark" ? 0.3 : 0.18),
      surfaceBackground: viewerBg,
      textColor: viewerText,
    }),
    [
      linkColor,
      muiTheme.palette.action.selected,
      muiTheme.palette.mode,
      searchHighlightColors.currentMatch,
      searchHighlightColors.otherMatches,
      viewerBg,
      viewerText,
    ]
  );

  const handleEditorSearchStateChange = useCallback((nextState: TextCodeEditorSearchState) => {
    setEditorSearchState((previousState) => (areTextEditorSearchStatesEqual(previousState, nextState) ? previousState : nextState));
  }, []);

  const setEditBaselineContent = useCallback((nextContent: string) => {
    editBaselineContentRef.current = nextContent;
  }, []);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    translationRef.current = t;
  }, [t]);

  const restoreEditingFocus = useCallback(() => {
    if (!isEditing) {
      return;
    }

    return scheduleRetriableFocusRestore({
      delaysMs: [0, 16, 48, 96],
      attemptRestore: () => {
        if (editorRef.current?.restorePreservedSelection() === true) {
          return true;
        }

        editorRef.current?.focus();
        return isTextEditorTextInputFocused();
      },
    });
  }, [isEditing]);

  const unsavedChangesDialogOpen = pendingUnsavedChangesAction !== null;
  const hasUnsavedChanges = isEditing && draftContent !== editBaselineContentRef.current;
  const editorShouldBeReadOnly = !isEditing || isAcquiring || readOnlyReason !== null || Boolean(isSaving && pendingUnsavedChangesAction);

  const {
    beginBaselineSyncWindow,
    clearBaselineSyncWindow,
    clearPendingBaselineSync,
    handleEditorChange,
    handleEditorUserEdit,
    getEditGeneration,
    markEditSessionPristine,
    requestRestoreEditingFocus,
  } = useMarkdownEditSession({
    isEditing,
    isSaving,
    contentRef,
    hasPendingUnsavedChangesAction: unsavedChangesDialogOpen,
    restoreEditingFocus,
    setDraftContent,
    setEditBaselineContent,
  });

  useEffect(() => {
    const abortController = new AbortController();

    const loadContent = async () => {
      try {
        setLoading(true);
        setError(null);
        const data = await fetchWithRetry(
          () =>
            readViewerContent(
              connectionId,
              path,
              { kind: "text" },
              { signal: abortController.signal, virtualSource },
              contentProviders
            ).then((blob) => blob.text()),
          {
            signal: abortController.signal,
            maxRetries: 1,
            retryDelay: 1000,
          }
        );
        if (abortController.signal.aborted) return;
        setContent(data);
        if (!isEditingRef.current && !isReadOnly) {
          const recoveredDraft = loadDraft(connectionId, path, "text");
          setDraftContent(data);
          setEditBaselineContent(data);
          setRecoveryDraft(recoveredDraft && recoveredDraft.content !== recoveredDraft.baseline ? recoveredDraft : null);
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          return;
        }

        if (checkIsTransientError(err)) {
          setError(getTransientErrorMessage());
        } else {
          setError(getApiErrorMessage(err, translationRef.current("viewer.text.loadFailed"), { includeOriginalMessage: true }));
        }
      } finally {
        if (!abortController.signal.aborted) {
          setLoading(false);
        }
      }
    };

    void loadContent();

    return () => {
      abortController.abort();
    };
  }, [connectionId, contentProviders, fetchWithRetry, isReadOnly, path, setEditBaselineContent, virtualSource]);

  const snapshotDraft = useCallback(() => {
    if (!isEditingRef.current) {
      return;
    }

    try {
      const editor = editorRef.current;
      if (!editor) throw new Error("The text editor is not mounted");
      const latestContent = editor.captureSnapshotSync().serialize();
      if (latestContent === editBaselineContentRef.current) {
        clearDraft(connectionId, path, "text");
        setDraftStorageWarning(null);
      } else {
        const result = saveDraft(connectionId, path, "text", editBaselineContentRef.current, latestContent);
        if (result.saved || result.reason === "no-user") {
          setDraftStorageWarning(null);
        } else {
          setDraftStorageWarning(
            result.reason === "too-large" ? t("viewer.edit.recovery.tooLargeWarning") : t("viewer.edit.recovery.storageUnavailableWarning")
          );
        }
      }
    } catch (error) {
      logError("Text recovery snapshot failed; keep the editor open and save the file", { error, connectionId, path });
    }
  }, [connectionId, path, t]);

  useEffect(() => {
    if (!isEditing) return;
    if (draftContent === editBaselineContentRef.current) {
      snapshotDraft();
      return;
    }
    const timeoutId = window.setTimeout(snapshotDraft, DRAFT_SNAPSHOT_DEBOUNCE_MS);
    return () => window.clearTimeout(timeoutId);
  }, [draftContent, isEditing, snapshotDraft]);

  useEffect(() => {
    const unregister = registerDraftSnapshot(snapshotDraft);
    window.addEventListener("pagehide", snapshotDraft);
    return () => {
      unregister();
      window.removeEventListener("pagehide", snapshotDraft);
    };
  }, [snapshotDraft]);

  const releaseEditSession = useCallback((): Promise<void> => {
    if (releasePromise.current) return releasePromise.current;
    const session = editSessionRef.current;
    if (!session) {
      return Promise.resolve();
    }
    editSessionRef.current = null;
    const pending = session
      .release()
      .catch((err) => {
        logError("Failed to release text edit lock", { error: err, path, connectionId });
      })
      .finally(() => {
        setEditSession((current) => (current === session ? null : current));
        releasePromise.current = null;
      });
    releasePromise.current = pending;
    return pending;
  }, [connectionId, path]);

  useEffect(() => {
    if (!isEditing || !editSession) {
      return;
    }

    let active = true;
    const intervalId = window.setInterval(() => {
      void editSession
        .heartbeat()
        .then(() => {
          if (active) setHeartbeatWarning(false);
        })
        .catch((err) => {
          if (!active) return;
          if (err instanceof ExpiredEditLockError || (isApiError(err) && err.response?.status === 403)) {
            snapshotDraft();
            setReadOnlyReason(err instanceof ExpiredEditLockError ? "lost" : "permission-denied");
            void releaseEditSession();
          } else {
            setHeartbeatWarning(true);
          }
          logError("Failed to refresh text edit lock", { error: err, path, connectionId });
        });
    }, VIEWER_EDIT_HEARTBEAT_MS);

    return () => {
      active = false;
      window.clearInterval(intervalId);
    };
  }, [connectionId, editSession, isEditing, path, releaseEditSession, snapshotDraft]);

  useEffect(() => {
    return () => {
      editActivation.current += 1;
      if (editSessionRef.current) {
        void editSessionRef.current.release().catch((err) => {
          logError("Failed to release text edit lock during cleanup", { error: err, path, connectionId });
        });
      }
    };
  }, [connectionId, path]);

  const loadShareFile = useCallback(
    (signal: AbortSignal) =>
      readViewerContent(connectionId, path, { kind: "raw" }, { signal, virtualSource }, contentProviders).then((blob) =>
        createShareFile(blob, filename)
      ),
    [connectionId, contentProviders, filename, path, virtualSource]
  );
  const nativeSharing = useViewerSharing({
    entryPoint: "text",
    identity: `${connectionId}:${path}:${fileModifiedAt}:${shareRevision}`,
    enabled: shareEnabled && !loading && !isSaving && !error,
    loadFile: loadShareFile,
  });

  const handleDownload = useCallback(async (): Promise<void> => {
    try {
      if (virtualSource) {
        downloadViewerBlob(await readVirtualContent(virtualSource, path, { download: true }, contentProviders), filename);
        return;
      }
      downloadViewerBlob(await readViewerContent(connectionId, path, { kind: "raw" }, { download: true }, contentProviders), filename);
    } catch (err) {
      logError("Failed to download file", { error: err, path, connectionId });
    }
  }, [connectionId, contentProviders, filename, path, virtualSource]);

  useEffect(() => {
    setSearchMatches(editorSearchState.searchMatches);
    setCurrentSearchMatch(editorSearchState.currentMatch);

    if (searchPanelOpen && !editorSearchState.isSearchable) {
      setSearchPanelOpen(false);
    }
  }, [editorSearchState.currentMatch, editorSearchState.isSearchable, editorSearchState.searchMatches, searchPanelOpen]);

  const exitEditMode = useCallback(
    async (nextContent = content) => {
      clearPendingBaselineSync();
      clearBaselineSyncWindow();
      await releaseEditSession();
      setDraftContent(nextContent);
      setEditBaselineContent(nextContent);
      markEditSessionPristine();
      setEditError(null);
      setEditorBoundaryKey((previousKey) => previousKey + 1);
      setIsEditing(false);
      setPendingUnsavedChangesAction(null);
    },
    [
      clearBaselineSyncWindow,
      clearPendingBaselineSync,
      content,
      markEditSessionPristine,
      releaseEditSession,
      setEditBaselineContent,
      setEditError,
    ]
  );

  const closeViewer = useCallback(async () => {
    clearPendingBaselineSync();
    clearBaselineSyncWindow();
    await releaseEditSession();
    setPendingUnsavedChangesAction(null);
    onClose();
  }, [clearBaselineSyncWindow, clearPendingBaselineSync, onClose, releaseEditSession]);

  const handleEnterEditMode = useCallback(
    async (initialDraft?: string): Promise<boolean> => {
      if (editSessionRef.current || acquisitionPending.current) return Boolean(editSessionRef.current);
      if (isReadOnly || loading || error || exceedsEditorLimit || isTransitioning) {
        return false;
      }

      setEditError(null);
      const activation = ++editActivation.current;
      acquisitionPending.current = true;
      setIsAcquiring(true);
      let acquiredSession: ContentEditSession | null = null;

      try {
        await releasePromise.current;
        if (activation !== editActivation.current) return false;
        const editResult = await beginViewerTextEdit(connectionId, path, contentProviders);
        if (editResult.kind !== "acquired") {
          if (activation === editActivation.current) {
            setReadOnlyReason(editResult.kind);
            setLockNoticeOccurrence((previous) => previous + 1);
            if (initialDraft !== undefined) setEditError(t(`viewer.text.readOnlyReasons.${editResult.kind}`));
          }
          return false;
        }
        acquiredSession = editResult.session;
        if (activation !== editActivation.current) {
          await acquiredSession.release();
          acquiredSession = null;
          return false;
        }
        const freshContent = await readViewerContent(connectionId, path, { kind: "text" }, undefined, contentProviders).then((blob) =>
          blob.text()
        );
        if (activation !== editActivation.current) {
          await editResult.session.release();
          acquiredSession = null;
          return false;
        }
        if (new Blob([freshContent]).size > maxFileSizeBytes) {
          await acquiredSession.release();
          acquiredSession = null;
          setContent(freshContent);
          return false;
        }
        editSessionRef.current = editResult.session;
        setEditSession(editResult.session);

        const retainedDraft = initialDraft ?? (hasUnsavedChanges ? draftContent : undefined);
        const previousBaseline = initialDraft === undefined ? editBaselineContentRef.current : (recoveryDraft?.baseline ?? content);
        const needsConflictDecision = retainedDraft !== undefined && freshContent !== previousBaseline && retainedDraft !== freshContent;
        setContent(freshContent);
        setDraftContent(retainedDraft ?? freshContent);
        setEditBaselineContent(needsConflictDecision ? previousBaseline : freshContent);
        setReadOnlyReason(needsConflictDecision ? "conflict" : null);
        setHeartbeatWarning(false);
        setConflict(needsConflictDecision ? { serverContent: freshContent, draftContent: retainedDraft! } : null);
        clearPendingBaselineSync();
        beginBaselineSyncWindow();
        markEditSessionPristine();
        setSearchAutoNavigate(true);
        if (hasActivatedEditorRef.current || initialDraft !== undefined) {
          setEditorBoundaryKey((previousKey) => previousKey + 1);
        }
        hasActivatedEditorRef.current = true;
        requestRestoreEditingFocus();
        setIsEditing(true);
        return true;
      } catch (err) {
        if (acquiredSession && editSessionRef.current !== acquiredSession) {
          await acquiredSession
            .release()
            .catch((releaseError) => logError("Failed to release unused text edit lock", { error: releaseError, connectionId, path }));
        }
        if (activation !== editActivation.current) return false;
        setReadOnlyReason(isApiError(err) && err.response?.status === 403 ? "permission-denied" : "unavailable");
        const message = getApiErrorMessage(err, t("viewer.text.lockFailedReason"), { includeOriginalMessage: true });
        setEditError(t("viewer.text.lockFailed", { message }));
        logError("Failed to enter text edit mode", { error: err, path, connectionId });
        return false;
      } finally {
        acquisitionPending.current = false;
        setIsAcquiring(false);
      }
    },
    [
      beginBaselineSyncWindow,
      clearPendingBaselineSync,
      connectionId,
      contentProviders,
      content,
      draftContent,
      hasUnsavedChanges,
      recoveryDraft,
      error,
      exceedsEditorLimit,
      isReadOnly,
      isTransitioning,
      loading,
      markEditSessionPristine,
      maxFileSizeBytes,
      path,
      requestRestoreEditingFocus,
      setEditBaselineContent,
      t,
      setEditError,
    ]
  );

  const routedEditing = useRoutedViewerEditing({
    automatic: true,
    navigation,
    isEditing,
    isSaving,
    isAcquiring,
    loading: loading || Boolean(recoveryDraft) || isTransitioning,
    dirty: hasUnsavedChanges,
    enterEdit: handleEnterEditMode,
    exitEdit: exitEditMode,
    cancelAcquisition: () => {
      editActivation.current += 1;
    },
    requestUnsavedChanges: () => {
      preserveTextEditorSelection(editorRef);
      setPendingUnsavedChangesAction("navigate");
    },
  });

  const handleResumeRecoveryDraft = useCallback(() => {
    const recoveredDraft = recoveryDraft;
    if (!recoveredDraft || isResumingRecoveryDraft) {
      return;
    }

    setIsResumingRecoveryDraft(true);
    void handleEnterEditMode(recoveredDraft.content)
      .then((enteredEditMode) => {
        if (enteredEditMode) {
          setRecoveryDraft(null);
        }
      })
      .finally(() => setIsResumingRecoveryDraft(false));
  }, [handleEnterEditMode, isResumingRecoveryDraft, recoveryDraft]);

  const handleDiscardRecoveryDraft = useCallback(() => {
    clearDraft(connectionId, path, "text");
    setDraftContent(content);
    setEditBaselineContent(content);
    setEditError(null);
    setRecoveryDraft(null);
  }, [connectionId, content, path, setEditBaselineContent, setEditError]);

  const persistDraft = useCallback(
    async (afterSave: PendingUnsavedChangesAction = "stay-edit") => {
      if (!isEditing || isReadOnly || readOnlyReason !== null || isAcquiring) {
        return false;
      }

      if (afterSave === "stay-edit") {
        requestRestoreEditingFocus();
        editorRef.current?.preserveSelection();
      }

      setEditError(null);
      setIsSaving(true);

      try {
        const editor = editorRef.current;
        if (!editor) throw new Error("Text editor is no longer available for saving");
        const saveGeneration = getEditGeneration();
        const snapshot = await editor.captureSnapshot();
        const savedContent = snapshot.serialize();

        if (!editSession) throw new Error("Edit session is no longer active");
        await editSession.writeText(savedContent, { reacquireExpiredLock: false });
        const hasNewerEdits = getEditGeneration() !== saveGeneration && editor.getCanonicalText() !== savedContent;
        setContent(savedContent);
        setShareRevision((revision) => revision + 1);
        setEditBaselineContent(savedContent);
        clearBaselineSyncWindow();
        if (!hasNewerEdits) {
          setDraftContent(savedContent);
          markEditSessionPristine();
          clearDraft(connectionId, path, "text");
        }

        if (afterSave === "close" && !hasNewerEdits) {
          await closeViewer();
        }

        return !hasNewerEdits;
      } catch (err) {
        if (err instanceof ExpiredEditLockError || (isApiError(err) && [403, 409].includes(err.response?.status ?? 0))) {
          snapshotDraft();
          setReadOnlyReason(err instanceof ExpiredEditLockError ? "lost" : err.response?.status === 403 ? "permission-denied" : "locked");
          await releaseEditSession();
        }
        setEditError(getApiErrorMessage(err, t("viewer.text.saveFailed"), { includeOriginalMessage: true }));
        logError("Failed to save text file", { error: err, path, connectionId });
        return false;
      } finally {
        setIsSaving(false);
        if (afterSave === "stay-edit") {
          window.requestAnimationFrame(() => {
            restoreEditingFocus();
          });
        }
      }
    },
    [
      clearBaselineSyncWindow,
      closeViewer,
      connectionId,
      editSession,
      getEditGeneration,
      isEditing,
      isReadOnly,
      isAcquiring,
      readOnlyReason,
      releaseEditSession,
      snapshotDraft,
      markEditSessionPristine,
      path,
      requestRestoreEditingFocus,
      restoreEditingFocus,
      setEditBaselineContent,
      t,
      setEditError,
    ]
  );

  const handleSave = useCallback(async () => {
    await persistDraft("stay-edit");
  }, [persistDraft]);

  const handleRequestClose = useCallback(async () => {
    if (isSaving) return;
    editActivation.current += 1;
    if (hasUnsavedChanges) {
      preserveTextEditorSelection(editorRef);
      setPendingUnsavedChangesAction("close");
      return;
    }

    await closeViewer();
  }, [closeViewer, hasUnsavedChanges, isSaving]);

  const closeSearchPanel = useCallback(({ preserveQuery, restoreEditorFocus }: { preserveQuery: boolean; restoreEditorFocus: boolean }) => {
    setSearchPanelOpen(false);
    setSearchFocusTarget(null);
    setSearchMode("find");

    if (!preserveQuery) {
      setSearchText("");
      setSearchAutoNavigate(true);
    }

    if (!restoreEditorFocus) {
      return;
    }

    editorRef.current?.focusCurrentSearchResult();
  }, []);

  const handleEscape = useCallback(() => {
    if (searchPanelOpen || isViewerSearchInputFocused()) {
      closeSearchPanel({ preserveQuery: true, restoreEditorFocus: true });
    } else if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      void handleRequestClose();
    }
  }, [closeSearchPanel, handleRequestClose, searchPanelOpen]);

  const handleOpenSearch = useCallback(() => {
    if (loading || error || exceedsEditorLimit || !editorSearchState.isSearchable) {
      return;
    }

    const selectedText = editorRef.current?.getPrimarySelectionText() ?? "";
    setSearchAutoNavigate(false);
    setSearchMode("find");
    setSearchFocusTarget("find");
    setSearchText(selectedText);
    setSearchReplaceText("");
    setSearchPanelOpen(true);
  }, [editorSearchState.isSearchable, error, exceedsEditorLimit, loading]);

  const handleOpenReplace = useCallback(() => {
    if (loading || error || exceedsEditorLimit || editorShouldBeReadOnly || isSaving || !editorSearchState.isSearchable) {
      return;
    }

    const selectedText = editorRef.current?.getPrimarySelectionText() ?? "";
    setSearchAutoNavigate(false);
    setSearchMode("replace");
    setSearchFocusTarget(selectedText.trim().length > 0 ? "replace" : "find");
    setSearchText(selectedText);
    setSearchReplaceText("");

    setSearchPanelOpen(true);
  }, [editorSearchState.isSearchable, error, exceedsEditorLimit, editorShouldBeReadOnly, isSaving, loading]);

  const handleSearchChange = useCallback((text: string) => {
    setSearchAutoNavigate(false);
    setSearchText(text);
  }, []);

  const handleSearchPanelToggle = useCallback(
    (open: boolean) => {
      if (open) {
        setSearchText("");
        setSearchReplaceText("");
        setSearchFocusTarget("find");
        setSearchPanelOpen(true);
        return;
      }

      closeSearchPanel({ preserveQuery: true, restoreEditorFocus: false });
    },
    [closeSearchPanel]
  );

  const handleSearchClose = useCallback(
    (reason: TextSearchCloseReason) => {
      closeSearchPanel({ preserveQuery: true, restoreEditorFocus: reason === "escape" });
    },
    [closeSearchPanel]
  );

  const handleSearchNext = useCallback(() => {
    if (searchMatches === 0 && !editorSearchState.pending && !editorSearchState.error) {
      return;
    }

    editorRef.current?.focusCurrentSearchResult();
    editorRef.current?.nextSearchResult();
  }, [searchMatches, editorSearchState.pending, editorSearchState.error]);

  const handleSearchPrevious = useCallback(() => {
    if (searchMatches === 0 && !editorSearchState.pending && !editorSearchState.error) {
      return;
    }

    editorRef.current?.focusCurrentSearchResult();
    editorRef.current?.previousSearchResult();
  }, [searchMatches, editorSearchState.pending, editorSearchState.error]);

  const handleReplaceCurrent = useCallback(() => {
    if (editorShouldBeReadOnly || isSaving) {
      return;
    }

    setSearchAutoNavigate(false);
    editorRef.current?.replaceCurrentSearchResult();
  }, [editorShouldBeReadOnly, isSaving]);

  const handleReplaceAll = useCallback(() => {
    if (editorShouldBeReadOnly || isSaving) {
      return;
    }

    setSearchAutoNavigate(false);
    editorRef.current?.replaceAllSearchResults();
  }, [editorShouldBeReadOnly, isSaving]);

  const handlePaperKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (unsavedChangesDialogOpen || event.key !== "Escape" || event.defaultPrevented) {
        return;
      }

      event.preventDefault();
      event.stopPropagation();

      if (isTextEditorTextInputFocused()) {
        handleEscape();
        return;
      }

      if (blurActiveToolbarControl(contentRef)) {
        return;
      }

      handleEscape();
    },
    [handleEscape, unsavedChangesDialogOpen]
  );

  const handleToggleFullscreen = useCallback(() => {
    if (!dialogRef.current) {
      return;
    }

    if (!document.fullscreenElement) {
      dialogRef.current.requestFullscreen().catch((err) => {
        logError("Failed to enable fullscreen", { error: err });
      });
    } else {
      document.exitFullscreen();
    }
  }, []);

  const handleOpenDocumentation = useCallback(() => {
    openExternalUrl("https://sambee.net/docs/");
  }, []);

  const textEditorShortcuts = useMemo(
    () => [
      { ...COMMON_SHORTCUTS.DOWNLOAD, handler: handleDownload },
      {
        ...COMMON_SHORTCUTS.RETRY_EDITING,
        handler: (): void => void handleEnterEditMode(),
        enabled:
          (readOnlyReason === "locked" || readOnlyReason === "unavailable" || readOnlyReason === "lost") &&
          !isAcquiring &&
          !isTransitioning,
      },
      { ...VIEWER_SHORTCUTS.FULLSCREEN, handler: handleToggleFullscreen },
      {
        ...COMMON_SHORTCUTS.SEARCH,
        handler: handleOpenSearch,
        enabled: !loading && !error && !exceedsEditorLimit && editorSearchState.isSearchable,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE,
        handler: handleOpenReplace,
        enabled: !editorShouldBeReadOnly && !isSaving && !exceedsEditorLimit && editorSearchState.isSearchable,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_CURRENT,
        handler: handleReplaceCurrent,
        enabled: !editorShouldBeReadOnly && !isSaving && !exceedsEditorLimit && searchMode === "replace" && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_ALL,
        handler: handleReplaceAll,
        enabled: !editorShouldBeReadOnly && !isSaving && !exceedsEditorLimit && searchMode === "replace" && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_CASE_SENSITIVE,
        handler: () => setSearchCaseSensitive((enabled) => !enabled),
        enabled: searchPanelOpen && !exceedsEditorLimit,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WHOLE_WORD,
        handler: () => setSearchWholeWord((enabled) => !enabled),
        enabled: searchPanelOpen && !exceedsEditorLimit,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_REGULAR_EXPRESSION,
        handler: () => setSearchRegexp((enabled) => !enabled),
        enabled: searchPanelOpen && !exceedsEditorLimit,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WORD_WRAP,
        handler: () => setWordWrapEnabled(!wordWrapEnabled),
        enabled: !loading && !error && !exceedsEditorLimit,
      },
      {
        ...COMMON_SHORTCUTS.NEXT_MATCH,
        handler: handleSearchNext,
        enabled: searchMatches > 0 || Boolean(editorSearchState.pending || editorSearchState.error),
      },
      {
        ...COMMON_SHORTCUTS.PREVIOUS_MATCH,
        handler: handleSearchPrevious,
        enabled: searchMatches > 0 || Boolean(editorSearchState.pending || editorSearchState.error),
      },
      {
        ...COMMON_SHORTCUTS.SAVE,
        handler: (): void => void handleSave(),
        allowInInput: true,
        enabled: !editorShouldBeReadOnly && !isSaving,
      },
      { ...COMMON_SHORTCUTS.CLOSE, handler: handleEscape, allowInInput: false, enabled: !unsavedChangesDialogOpen },
      { ...BROWSER_SHORTCUTS.SHOW_HELP_ALTERNATE, handler: () => setShowEditorHelp(true) },
    ],
    [
      editorSearchState.isSearchable,
      editorSearchState.pending,
      editorSearchState.error,
      error,
      exceedsEditorLimit,
      handleDownload,
      handleEnterEditMode,
      handleEscape,
      handleOpenSearch,
      handleOpenReplace,
      handleReplaceAll,
      handleReplaceCurrent,
      handleSave,
      handleSearchNext,
      handleSearchPrevious,
      handleToggleFullscreen,
      editorShouldBeReadOnly,
      isSaving,
      isAcquiring,
      isTransitioning,
      readOnlyReason,
      loading,
      searchMatches,
      searchMode,
      searchPanelOpen,
      setWordWrapEnabled,
      unsavedChangesDialogOpen,
      wordWrapEnabled,
    ]
  );

  useKeyboardShortcuts({
    active: !showEditorHelp,
    shortcuts: textEditorShortcuts,
    inputSelector: "input, textarea",
  });

  const toolbarActions = useMemo(() => {
    const actions: ViewerToolbarAction[] = isEditing
      ? [
          createSaveToolbarAction({
            id: "save-text",
            onClick: () => {
              void handleSave();
            },
            isMobile,
            disabled: editorShouldBeReadOnly || isSaving || exceedsEditorLimit,
          }),
        ]
      : [];
    if (readOnlyReason === "locked" || readOnlyReason === "unavailable" || readOnlyReason === "lost") {
      actions.push({
        id: "retry-editing",
        kind: "icon",
        icon: <Refresh fontSize={isMobile ? "small" : "medium"} />,
        label: t("viewer.text.retryEditing"),
        title: withShortcut(COMMON_SHORTCUTS.RETRY_EDITING),
        disabled: isAcquiring || isTransitioning,
        onClick: () => void handleEnterEditMode(),
      });
    }
    return actions;
  }, [
    editorShouldBeReadOnly,
    exceedsEditorLimit,
    handleEnterEditMode,
    handleSave,
    isAcquiring,
    isEditing,
    isMobile,
    isSaving,
    isTransitioning,
    readOnlyReason,
    t,
  ]);

  const unsavedChangesIndicator = hasUnsavedChanges ? (
    <Box
      component="span"
      role="status"
      aria-label={t("viewer.edit.unsavedIndicatorAria")}
      title={t("viewer.edit.unsavedIndicator")}
      sx={{
        width: isMobile ? 7 : 8,
        height: isMobile ? 7 : 8,
        borderRadius: "50%",
        backgroundColor: toolbarText,
        opacity: 1,
        flexShrink: 0,
        alignSelf: "flex-start",
        mt: "-0.26em",
      }}
    />
  ) : null;

  const readOnlyIndicator =
    isReadOnly || readOnlyReason !== null || exceedsEditorLimit ? (
      <ViewerFilenameBadge label={t("settings.connectionDialog.accessMode.readOnlyLabel")} toolbarText={toolbarText} />
    ) : null;

  const filenameAdornment = (
    <Box sx={{ display: "flex", alignItems: "center", gap: isMobile ? 0.75 : 1 }}>
      <ViewerEditAcquisitionStatus acquiring={isAcquiring && !isTransitioning} />
      {unsavedChangesIndicator}
      {readOnlyIndicator}
    </Box>
  );

  const lockNotice = useViewerLockNotice(readOnlyReason, editError, editErrorOccurrence + lockNoticeOccurrence);
  const notices: ViewerNotice[] = [];
  if (lockNotice) notices.push(lockNotice);
  else if (editError) notices.push({ id: "edit-error", message: editError, severity: "error", occurrence: editErrorOccurrence });
  if (heartbeatWarning && readOnlyReason === null)
    notices.push({ id: "heartbeat", message: t("viewer.text.heartbeatFailed"), severity: "warning" });
  if (draftStorageWarning) notices.push({ id: "draft-storage", message: draftStorageWarning, severity: "warning" });

  const handleDialogClose = useCallback(
    (_event: unknown, reason: string) => {
      if (reason === "escapeKeyDown") {
        return;
      }

      void handleRequestClose();
    },
    [handleRequestClose]
  );

  useEffect(() => {
    logInfo("Text editor opened", { filename, path });
  }, [filename, path]);

  useEffect(() => {
    return () => {
      logInfo("Text editor closed");
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    };
  }, []);

  return (
    <>
      <Dialog
        inert={isTransitioning}
        open={true}
        onClose={handleDialogClose}
        maxWidth={false}
        fullScreen
        ref={dialogRef}
        disableEnforceFocus
        disableRestoreFocus
        sx={{
          "& .MuiDialog-container": {
            alignItems: "stretch",
            justifyContent: "stretch",
          },
        }}
        slotProps={{
          paper: {
            onKeyDown: handlePaperKeyDown,
            sx: {
              margin: 0,
              width: "100dvw",
              maxWidth: "100dvw",
              height: "100dvh",
              maxHeight: "100dvh",
              display: "flex",
              flexDirection: "column",
              backgroundColor: viewerBg,
            },
          },
        }}
      >
        <Box
          sx={{
            position: "relative",
            width: "100%",
            height: "100%",
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            boxSizing: "border-box",
          }}
        >
          <Box sx={{ flexShrink: 0, zIndex: 1 }}>
            <ViewerControls
              filename={filename}
              filenameAdornment={filenameAdornment}
              toolbarBackground={toolbarBg}
              toolbarText={toolbarText}
              actions={toolbarActions}
              toolbarAccessory={
                <HelpMenu
                  menuId="text-editor-help-menu"
                  onOpenHelp={() => setShowEditorHelp(true)}
                  onOpenDocumentation={handleOpenDocumentation}
                />
              }
              config={{ download: true, share: shareEnabled, search: !exceedsEditorLimit }}
              onClose={() => {
                void handleRequestClose();
              }}
              search={{
                searchText,
                onSearchChange: handleSearchChange,
                searchMatches,
                currentMatch: currentSearchMatch,
                onSearchNext: handleSearchNext,
                onSearchPrevious: handleSearchPrevious,
                searchPanelOpen,
                onSearchPanelToggle: handleSearchPanelToggle,
                onSearchClose: handleSearchClose,
                clearSearchOnClose: false,
                hideSearchPanel: true,
                isSearchable: !exceedsEditorLimit && editorSearchState.isSearchable,
                searchUnavailableTitle: exceedsEditorLimit ? t("viewer.text.limitSearchUnavailable") : undefined,
              }}
              onDownload={handleDownload}
              shareControl={
                <ViewerShareMenu
                  onFile={nativeSharing.shareFile}
                  onText={() =>
                    nativeSharing.shareText(() => (isEditing ? (editorRef.current?.getCanonicalText() ?? draftContent) : content))
                  }
                  fileDisabled={!nativeSharing.ready || isSaving}
                  filePreparing={nativeSharing.preparing}
                  textDisabled={loading || Boolean(error)}
                  disabled={nativeSharing.sharing}
                />
              }
            />
          </Box>

          <CodeMirrorFindReplacePopover
            caseSensitive={searchCaseSensitive}
            currentMatch={currentSearchMatch}
            disabled={isSaving}
            focusTarget={searchFocusTarget}
            isReplaceMode={searchMode === "replace" && !editorShouldBeReadOnly}
            isSearchValid={editorSearchState.isValid}
            searchPending={editorSearchState.pending}
            searchError={editorSearchState.error}
            onCaseSensitiveChange={setSearchCaseSensitive}
            onClose={() => closeSearchPanel({ preserveQuery: true, restoreEditorFocus: true })}
            onFindNext={handleSearchNext}
            onFindPrevious={handleSearchPrevious}
            onFocusHandled={() => setSearchFocusTarget(null)}
            onRegexChange={setSearchRegexp}
            onReplaceAll={handleReplaceAll}
            onReplaceChange={setSearchReplaceText}
            onReplaceCurrent={handleReplaceCurrent}
            onSearchChange={handleSearchChange}
            onWholeWordChange={setSearchWholeWord}
            open={searchPanelOpen}
            regex={searchRegexp}
            replaceText={searchReplaceText}
            searchMatches={searchMatches}
            searchText={searchText}
            wholeWord={searchWholeWord}
          />

          <ViewerNotifications
            key={JSON.stringify([connectionId, path])}
            notices={notices}
            toolbarBackground={toolbarBg}
            toolbarText={toolbarText}
            suppressed={Boolean(unsavedChangesDialogOpen || recoveryDraft || conflict)}
          />
          {nativeSharing.failureDialog}

          <Box
            ref={contentRef}
            data-testid="text-viewer-content"
            tabIndex={0}
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
              minHeight: 0,
              width: "100%",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              backgroundColor: viewerBg,
              "&:focus": { outline: "none" },
            }}
          >
            {loading ? (
              <Box sx={{ display: "flex", justifyContent: "center", alignItems: "center", height: "100%" }}>
                <CircularProgress />
              </Box>
            ) : error ? (
              <Box sx={{ p: 2 }}>
                <Alert severity="error">{error}</Alert>
              </Box>
            ) : exceedsEditorLimit ? (
              <Box sx={{ p: 2, pb: VIEWER_SCROLL_END_PADDING, overflow: "auto" }}>
                <Alert severity="warning" sx={{ mb: 2 }}>
                  {t("viewer.text.limitMessage", {
                    currentSizeMb: (contentSizeBytes / (1024 * 1024)).toFixed(1),
                    maxSizeMb: (maxFileSizeBytes / (1024 * 1024)).toFixed(0),
                  })}
                </Alert>
                <Box
                  component="pre"
                  sx={{ m: 0, whiteSpace: "pre-wrap", wordBreak: "break-word", color: viewerText, fontFamily: "monospace" }}
                >
                  {content}
                </Box>
              </Box>
            ) : (
              <Box
                sx={{
                  p: 0,
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  overflow: "hidden",
                  "& .sambee-text-editor": {
                    flex: 1,
                    minHeight: 0,
                    [CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE]: muiTheme.spacing(CODEMIRROR_EDITOR_CONTENT_PADDING.xs),
                    [muiTheme.breakpoints.up("sm")]: {
                      [CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE]: muiTheme.spacing(CODEMIRROR_EDITOR_CONTENT_PADDING.sm),
                    },
                  },
                  "& .sambee-text-editor .cm-content": {
                    pt: CODEMIRROR_EDITOR_CONTENT_PADDING,
                    pb: VIEWER_SCROLL_END_PADDING,
                  },
                }}
              >
                <MarkdownEditorErrorBoundary
                  key={editorBoundaryKey}
                  title={t("viewer.text.editorCrashTitle")}
                  description={t("viewer.text.editorCrashMessage")}
                  retryLabel={t("viewer.edit.retryEditor")}
                  returnToPreviewLabel={t("common.actions.close")}
                  onError={(editorError) =>
                    logError("Text editor crashed; retry the editor or close the file", { error: editorError, connectionId, path })
                  }
                  onRetry={() => {
                    setEditError(null);
                    setEditorBoundaryKey((previousKey) => previousKey + 1);
                  }}
                  onReturnToPreview={() => {
                    void handleRequestClose();
                  }}
                >
                  <TextCodeEditor
                    ref={editorRef}
                    className="sambee-text-editor"
                    text={isEditing ? draftContent : content}
                    filename={filename}
                    theme={textEditorTheme}
                    onChange={handleEditorChange}
                    onUserEdit={handleEditorUserEdit}
                    ariaLabel={t("viewer.text.editorLabel")}
                    autoFocus={true}
                    readOnly={editorShouldBeReadOnly || routedEditing.isExiting || isTransitioning}
                    lineWrapping={wordWrapEnabled}
                    searchText={searchPanelOpen ? searchText : ""}
                    searchOpen={searchPanelOpen}
                    searchAutoNavigate={searchAutoNavigate}
                    searchCaseSensitive={searchCaseSensitive}
                    onSearchStateChange={handleEditorSearchStateChange}
                    searchRegexp={searchRegexp}
                    searchReplaceText={searchReplaceText}
                    searchWholeWord={searchWholeWord}
                  />
                </MarkdownEditorErrorBoundary>
              </Box>
            )}
          </Box>
        </Box>
      </Dialog>

      <RecoveredDraftDialog
        draft={recoveryDraft}
        fileSize={fileSize}
        fileModifiedAt={fileModifiedAt}
        error={editError}
        isResuming={isResumingRecoveryDraft}
        onDiscard={handleDiscardRecoveryDraft}
        onResume={handleResumeRecoveryDraft}
      />

      <ResponsiveDialogShell
        open={unsavedChangesDialogOpen}
        onClose={() => {
          routedEditing.cancelNavigation();
          setPendingUnsavedChangesAction(null);
        }}
        title={t("viewer.edit.unsavedChangesTitle")}
        description={t("viewer.edit.unsavedChangesExitMessage")}
        actionNotice={
          editError || lockNotice ? (
            <Alert severity={editError ? "error" : "info"} role={editError ? "alert" : "status"}>
              {editError || lockNotice?.message}
            </Alert>
          ) : null
        }
        maxWidth="xs"
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        actions={
          <>
            <Button
              ref={unsavedChangesCancelButtonRef}
              onClick={() => {
                routedEditing.cancelNavigation();
                setPendingUnsavedChangesAction(null);
              }}
              disabled={isSaving}
              autoFocus
              variant="outlined"
              sx={settingsUtilityButtonSx}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button
              onClick={() => {
                clearDraft(connectionId, path, "text");
                flushSync(() => {
                  setDraftContent(editBaselineContentRef.current);
                  markEditSessionPristine();
                });
                if (pendingUnsavedChangesAction === "navigate") void routedEditing.completeNavigation();
                else if (pendingUnsavedChangesAction === "close") {
                  clearDraft(connectionId, path, "text");
                  void closeViewer();
                } else void exitEditMode();
              }}
              disabled={isSaving}
              color="error"
              variant="contained"
            >
              {t("common.actions.discard")}
            </Button>
            <Button
              onClick={() => {
                if (pendingUnsavedChangesAction) {
                  if (pendingUnsavedChangesAction === "navigate") {
                    void persistDraft("stay-edit").then((saved) => {
                      if (saved) void routedEditing.completeNavigation();
                    });
                  } else void persistDraft(pendingUnsavedChangesAction);
                }
              }}
              disabled={isSaving || readOnlyReason !== null || isAcquiring}
              variant="contained"
            >
              {t("common.actions.save")}
            </Button>
          </>
        }
      >
        {null}
      </ResponsiveDialogShell>

      <ResponsiveDialogShell
        open={conflict !== null}
        onClose={() => {}}
        disableClose
        title={t("viewer.text.conflictTitle")}
        description={t("viewer.text.conflictDescription")}
        maxWidth="xs"
        actions={
          conflict ? (
            <>
              <Button
                variant="outlined"
                autoFocus
                onClick={() => {
                  setDraftContent(conflict.serverContent);
                  setEditBaselineContent(conflict.serverContent);
                  clearDraft(connectionId, path, "text");
                  markEditSessionPristine();
                  setConflict(null);
                  setReadOnlyReason((reason) => (reason === "conflict" ? null : reason));
                }}
              >
                {t("viewer.text.useSavedFile")}
              </Button>
              <Button
                variant="contained"
                onClick={() => {
                  setDraftContent(conflict.draftContent);
                  setEditBaselineContent(conflict.serverContent);
                  setConflict(null);
                  setReadOnlyReason((reason) => (reason === "conflict" ? null : reason));
                }}
              >
                {t("viewer.text.keepDraft")}
              </Button>
            </>
          ) : null
        }
      >
        {null}
      </ResponsiveDialogShell>
      <KeyboardShortcutsHelp
        open={showEditorHelp}
        onClose={() => setShowEditorHelp(false)}
        shortcuts={textEditorShortcuts}
        title={t("keyboardShortcutsHelp.titles.textEditor")}
      />
    </>
  );
};

export default memo(TextEditor);
