import { Alert, Box, Button, CircularProgress, Dialog, useMediaQuery, useTheme } from "@mui/material";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { BROWSER_SHORTCUTS, CODEMIRROR_EDITOR_SHORTCUTS, COMMON_SHORTCUTS, VIEWER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { checkIsTransientError, getTransientErrorMessage, useApiRetry } from "../../hooks/useApiRetry";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
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
import { useSambeeTheme } from "../../theme";
import { getSearchHighlightColors } from "../../theme/commonStyles";
import {
  CODEMIRROR_EDITOR_CONTENT_PADDING,
  CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE,
  getViewerColors,
  VIEWER_SCROLL_END_PADDING,
} from "../../theme/viewerStyles";
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
import { VIEWER_SEARCH_INPUT_ATTRIBUTE, ViewerControls, ViewerFilenameBadge } from "./ViewerControls";
import { downloadViewerBlob } from "./viewerContent";
import { createEditToolbarAction, createSaveToolbarAction } from "./viewerToolbarActions";

type PendingUnsavedChangesAction = "cancel-edit" | "stay-edit" | "navigate";
type TextSearchCloseReason = "escape" | "toggle";

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
    left.viewMode === right.viewMode
  );
}

export const TextViewer: React.FC<ViewerComponentProps> = ({
  connectionId,
  path,
  fileSize,
  fileModifiedAt,
  onClose,
  isReadOnly: connectionIsReadOnly = false,
  virtualSource,
  navigation,
}) => {
  const isReadOnly = connectionIsReadOnly || virtualSource !== undefined;
  const contentProviders = useContentProviderRegistry();
  const { t } = useTranslation();
  const [content, setContent] = useState("");
  const [draftContent, setDraftContent] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [shareRevision, setShareRevision] = useState(0);
  const [draftStorageWarning, setDraftStorageWarning] = useState<string | null>(null);
  const [recoveryDraft, setRecoveryDraft] = useState<DraftSnapshot | null>(null);
  const [isResumingRecoveryDraft, setIsResumingRecoveryDraft] = useState(false);
  const [resumedRecoveryDraft, setResumedRecoveryDraft] = useState(false);
  const [showViewerHelp, setShowViewerHelp] = useState(false);
  const [showEditorHelp, setShowEditorHelp] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isAcquiring, setIsAcquiring] = useState(false);
  const editActivation = useRef(0);
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
  const editorShouldBeReadOnly = !isEditing || Boolean(isSaving && pendingUnsavedChangesAction);

  const {
    beginBaselineSyncWindow,
    clearBaselineSyncWindow,
    clearPendingBaselineSync,
    handleEditorChange,
    handleEditorUserEdit,
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
        setContent(data);
        if (!isEditingRef.current && !isReadOnly) {
          const recoveredDraft = loadDraft(connectionId, path, "text");
          setDraftContent(data);
          setEditBaselineContent(data);
          setResumedRecoveryDraft(false);
          setRecoveryDraft(recoveredDraft && recoveredDraft.content !== recoveredDraft.baseline ? recoveredDraft : null);
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          return;
        }

        if (checkIsTransientError(err)) {
          setError(getTransientErrorMessage(err, translationRef.current("errors.failedToLoadFile")));
        } else {
          setError(getApiErrorMessage(err, translationRef.current("errors.failedToLoadFile"), { includeOriginalMessage: true }));
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

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    if (draftContent === editBaselineContentRef.current) {
      clearDraft(connectionId, path, "text");
      setDraftStorageWarning(null);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      const result = saveDraft(connectionId, path, "text", editBaselineContentRef.current, draftContent);
      if (result.saved || result.reason === "no-user") {
        setDraftStorageWarning(null);
        return;
      }

      setDraftStorageWarning(
        result.reason === "too-large" ? t("viewer.edit.recovery.tooLargeWarning") : t("viewer.edit.recovery.storageUnavailableWarning")
      );
    }, DRAFT_SNAPSHOT_DEBOUNCE_MS);

    return () => window.clearTimeout(timeoutId);
  }, [connectionId, draftContent, isEditing, path, t]);

  useEffect(() => {
    const snapshot = () => {
      if (!isEditingRef.current) {
        return;
      }

      if (draftContent === editBaselineContentRef.current) {
        clearDraft(connectionId, path, "text");
      } else {
        saveDraft(connectionId, path, "text", editBaselineContentRef.current, draftContent);
      }
    };
    const unregister = registerDraftSnapshot(snapshot);
    window.addEventListener("pagehide", snapshot);
    return () => {
      unregister();
      window.removeEventListener("pagehide", snapshot);
    };
  }, [connectionId, draftContent, path]);

  const releaseEditSession = useCallback(async () => {
    const session = editSessionRef.current;
    if (!session) {
      return;
    }
    editSessionRef.current = null;
    try {
      await session.release();
    } catch (err) {
      logError("Failed to release text edit lock", { error: err, path, connectionId });
    } finally {
      setEditSession(null);
    }
  }, [connectionId, path]);

  useEffect(() => {
    if (!isEditing || !editSession) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void editSession.heartbeat().catch((err) => {
        logError("Failed to refresh text edit lock", { error: err, path, connectionId });
      });
    }, 30_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [connectionId, editSession, isEditing, path]);

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

  const handleDownload = useCallback(async () => {
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
    [clearBaselineSyncWindow, clearPendingBaselineSync, content, markEditSessionPristine, releaseEditSession, setEditBaselineContent]
  );

  const closeViewer = useCallback(async () => {
    clearPendingBaselineSync();
    clearBaselineSyncWindow();
    await releaseEditSession();
    setPendingUnsavedChangesAction(null);
    onClose();
  }, [clearBaselineSyncWindow, clearPendingBaselineSync, onClose, releaseEditSession]);

  const handleEnterEditMode = useCallback(
    async (initialDraft = content): Promise<boolean> => {
      if (editSessionRef.current || isAcquiring) return Boolean(editSessionRef.current);
      if (isReadOnly || loading || error || exceedsEditorLimit) {
        return false;
      }

      setEditError(null);
      const activation = ++editActivation.current;
      setIsAcquiring(true);

      try {
        const editResult = await beginViewerTextEdit(connectionId, path, contentProviders);
        if (editResult.kind !== "acquired") throw new Error(`Editing is ${editResult.kind}`);
        if (activation !== editActivation.current) {
          await editResult.session.release();
          return false;
        }
        editSessionRef.current = editResult.session;
        setEditSession(editResult.session);

        setDraftContent(initialDraft);
        setEditBaselineContent(content);
        clearPendingBaselineSync();
        beginBaselineSyncWindow();
        markEditSessionPristine();
        setSearchAutoNavigate(true);
        setEditorBoundaryKey((previousKey) => previousKey + 1);
        setIsEditing(true);
        navigation?.onModeChange("edit");
        return true;
      } catch (err) {
        const message = getApiErrorMessage(err, t("viewer.text.lockFailedReason"), { includeOriginalMessage: true });
        setEditError(t("viewer.text.lockFailed", { message }));
        logError("Failed to enter text edit mode", { error: err, path, connectionId });
        return false;
      } finally {
        setIsAcquiring(false);
      }
    },
    [
      beginBaselineSyncWindow,
      clearPendingBaselineSync,
      connectionId,
      contentProviders,
      content,
      error,
      exceedsEditorLimit,
      isReadOnly,
      isAcquiring,
      loading,
      markEditSessionPristine,
      path,
      setEditBaselineContent,
      t,
      navigation,
    ]
  );

  const routedEditing = useRoutedViewerEditing({
    navigation,
    isEditing,
    isSaving,
    isAcquiring,
    loading,
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
          setResumedRecoveryDraft(true);
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
  }, [connectionId, content, path, setEditBaselineContent]);

  const handleCancelEdit = useCallback(async () => {
    if (navigation) {
      navigation.onModeChange("view");
      return;
    }
    if (hasUnsavedChanges) {
      preserveTextEditorSelection(editorRef);
      setPendingUnsavedChangesAction("cancel-edit");
      return;
    }

    await exitEditMode();
  }, [exitEditMode, hasUnsavedChanges, navigation]);

  const persistDraft = useCallback(
    async (afterSave: PendingUnsavedChangesAction = "stay-edit") => {
      if (!isEditing || isReadOnly) {
        return false;
      }

      if (afterSave === "stay-edit") {
        requestRestoreEditingFocus();
        editorRef.current?.preserveSelection();
      }

      setEditError(null);
      setIsSaving(true);

      try {
        let savedContent = draftContent;
        if (editorRef.current) {
          await editorRef.current.flushPendingEdits();
          savedContent = editorRef.current.getCanonicalText();
        }

        if (!editSession) throw new Error("Edit session is no longer active");
        await editSession.writeText(savedContent);
        setContent(savedContent);
        setShareRevision((revision) => revision + 1);
        setDraftContent(savedContent);
        setEditBaselineContent(savedContent);
        clearBaselineSyncWindow();
        markEditSessionPristine();
        clearDraft(connectionId, path, "text");

        if (afterSave === "cancel-edit") {
          await exitEditMode(savedContent);
        }

        return true;
      } catch (err) {
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
      connectionId,
      draftContent,
      editSession,
      exitEditMode,
      isEditing,
      isReadOnly,
      markEditSessionPristine,
      path,
      requestRestoreEditingFocus,
      restoreEditingFocus,
      setEditBaselineContent,
      t,
    ]
  );

  const handleSave = useCallback(async () => {
    await persistDraft("stay-edit");
  }, [persistDraft]);

  const handleRequestClose = useCallback(async () => {
    if (isEditing) {
      await handleCancelEdit();
      return;
    }

    await closeViewer();
  }, [closeViewer, handleCancelEdit, isEditing]);

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
    } else if (isEditing) {
      void handleCancelEdit();
    } else if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      void handleRequestClose();
    }
  }, [closeSearchPanel, handleCancelEdit, handleRequestClose, isEditing, searchPanelOpen]);

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
    if (loading || error || exceedsEditorLimit || !isEditing || isSaving || !editorSearchState.isSearchable) {
      return;
    }

    const selectedText = editorRef.current?.getPrimarySelectionText() ?? "";
    setSearchAutoNavigate(false);
    setSearchMode("replace");
    setSearchFocusTarget(selectedText.trim().length > 0 ? "replace" : "find");
    setSearchText(selectedText);
    setSearchReplaceText("");

    setSearchPanelOpen(true);
  }, [editorSearchState.isSearchable, error, exceedsEditorLimit, isEditing, isSaving, loading]);

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
    if (searchMatches === 0) {
      return;
    }

    editorRef.current?.focusCurrentSearchResult();
    editorRef.current?.nextSearchResult();
  }, [searchMatches]);

  const handleSearchPrevious = useCallback(() => {
    if (searchMatches === 0) {
      return;
    }

    editorRef.current?.focusCurrentSearchResult();
    editorRef.current?.previousSearchResult();
  }, [searchMatches]);

  const handleReplaceCurrent = useCallback(() => {
    if (!isEditing || isSaving) {
      return;
    }

    setSearchAutoNavigate(false);
    editorRef.current?.replaceCurrentSearchResult();
  }, [isEditing, isSaving]);

  const handleReplaceAll = useCallback(() => {
    if (!isEditing || isSaving) {
      return;
    }

    setSearchAutoNavigate(false);
    editorRef.current?.replaceAllSearchResults();
  }, [isEditing, isSaving]);

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

  const textViewerShortcuts = useMemo(
    () => [
      { ...COMMON_SHORTCUTS.DOWNLOAD, handler: handleDownload, enabled: !isEditing },
      {
        ...COMMON_SHORTCUTS.SEARCH,
        handler: handleOpenSearch,
        enabled: !isEditing && !loading && !error && !exceedsEditorLimit && editorSearchState.isSearchable,
      },
      { ...COMMON_SHORTCUTS.NEXT_MATCH, handler: handleSearchNext, enabled: !isEditing && searchMatches > 0 },
      { ...COMMON_SHORTCUTS.PREVIOUS_MATCH, handler: handleSearchPrevious, enabled: !isEditing && searchMatches > 0 },
      { ...COMMON_SHORTCUTS.EDIT, handler: () => void handleEnterEditMode(), enabled: !isEditing && !isReadOnly && !exceedsEditorLimit },
      { ...VIEWER_SHORTCUTS.FULLSCREEN, handler: handleToggleFullscreen, enabled: !isEditing },
      { ...COMMON_SHORTCUTS.CLOSE, handler: handleEscape, allowInInput: false, enabled: !isEditing && !unsavedChangesDialogOpen },
      { ...BROWSER_SHORTCUTS.SHOW_HELP, handler: () => setShowViewerHelp(true), enabled: !isEditing },
      { ...BROWSER_SHORTCUTS.SHOW_HELP_ALTERNATE, handler: () => setShowViewerHelp(true), enabled: !isEditing },
    ],
    [
      editorSearchState.isSearchable,
      error,
      exceedsEditorLimit,
      handleDownload,
      handleEnterEditMode,
      handleEscape,
      handleOpenSearch,
      handleSearchNext,
      handleSearchPrevious,
      handleToggleFullscreen,
      isEditing,
      isReadOnly,
      loading,
      searchMatches,
      unsavedChangesDialogOpen,
    ]
  );

  const textEditorShortcuts = useMemo(
    () => [
      { ...COMMON_SHORTCUTS.DOWNLOAD, handler: handleDownload, enabled: isEditing },
      {
        ...COMMON_SHORTCUTS.SEARCH,
        handler: handleOpenSearch,
        enabled: isEditing && !loading && !error && !exceedsEditorLimit && editorSearchState.isSearchable,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE,
        handler: handleOpenReplace,
        enabled: isEditing && !isSaving && !exceedsEditorLimit && editorSearchState.isSearchable,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_CURRENT,
        handler: handleReplaceCurrent,
        enabled: isEditing && !isSaving && !exceedsEditorLimit && searchMode === "replace" && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_ALL,
        handler: handleReplaceAll,
        enabled: isEditing && !isSaving && !exceedsEditorLimit && searchMode === "replace" && searchPanelOpen,
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
      { ...COMMON_SHORTCUTS.NEXT_MATCH, handler: handleSearchNext, enabled: isEditing && searchMatches > 0 },
      { ...COMMON_SHORTCUTS.PREVIOUS_MATCH, handler: handleSearchPrevious, enabled: isEditing && searchMatches > 0 },
      { ...COMMON_SHORTCUTS.SAVE, handler: () => void handleSave(), allowInInput: true, enabled: isEditing && !isSaving },
      { ...COMMON_SHORTCUTS.CLOSE, handler: handleEscape, allowInInput: false, enabled: isEditing && !unsavedChangesDialogOpen },
      { ...BROWSER_SHORTCUTS.SHOW_HELP_ALTERNATE, handler: () => setShowEditorHelp(true), enabled: isEditing },
    ],
    [
      editorSearchState.isSearchable,
      error,
      exceedsEditorLimit,
      handleDownload,
      handleEscape,
      handleOpenSearch,
      handleOpenReplace,
      handleReplaceAll,
      handleReplaceCurrent,
      handleSave,
      handleSearchNext,
      handleSearchPrevious,
      isEditing,
      isSaving,
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
    active: !showViewerHelp && !showEditorHelp,
    shortcuts: [...textViewerShortcuts, ...textEditorShortcuts],
    inputSelector: "input, textarea",
  });

  const toolbarActions = useMemo(
    () =>
      isEditing
        ? [
            createSaveToolbarAction({
              id: "save-text",
              onClick: () => {
                void handleSave();
              },
              isMobile,
              disabled: isSaving || exceedsEditorLimit,
            }),
          ]
        : [
            ...(isReadOnly
              ? []
              : [
                  createEditToolbarAction({
                    id: "edit-text",
                    onClick: () => {
                      void handleEnterEditMode();
                    },
                    isMobile,
                    disabled: loading || !!error || exceedsEditorLimit,
                  }),
                ]),
          ],
    [error, exceedsEditorLimit, handleEnterEditMode, handleSave, isEditing, isMobile, isReadOnly, isSaving, loading]
  );

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

  const readOnlyIndicator = isReadOnly ? (
    <ViewerFilenameBadge label={t("settings.connectionDialog.accessMode.readOnlyLabel")} toolbarText={toolbarText} />
  ) : null;

  const filenameAdornment =
    unsavedChangesIndicator || readOnlyIndicator ? (
      <Box sx={{ display: "flex", alignItems: "center", gap: isMobile ? 0.75 : 1 }}>
        {unsavedChangesIndicator}
        {readOnlyIndicator}
      </Box>
    ) : null;

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
    logInfo("Text viewer opened", { filename, path });
  }, [filename, path]);

  useEffect(() => {
    return () => {
      logInfo("Text viewer closed");
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    };
  }, []);

  return (
    <>
      <Dialog
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
                isEditing ? (
                  <HelpMenu
                    menuId="text-editor-help-menu"
                    onOpenHelp={() => setShowEditorHelp(true)}
                    onOpenDocumentation={handleOpenDocumentation}
                  />
                ) : undefined
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
            isReplaceMode={searchMode === "replace"}
            isSearchValid={editorSearchState.isValid}
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

          {editError ? (
            <Alert severity="error" sx={{ m: 2, flexShrink: 0 }}>
              {editError}
            </Alert>
          ) : null}
          {nativeSharing.failureDialog}
          {draftStorageWarning ? (
            <Alert severity="warning" sx={{ m: 2, flexShrink: 0 }}>
              {draftStorageWarning}
            </Alert>
          ) : null}

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
                  returnToPreviewLabel={t("viewer.edit.returnToPreview")}
                  onError={() => {}}
                  onRetry={() => {
                    setEditError(null);
                    setEditorBoundaryKey((previousKey) => previousKey + 1);
                  }}
                  onReturnToPreview={() => {
                    void handleCancelEdit();
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
                    readOnly={editorShouldBeReadOnly || routedEditing.isExiting}
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
                if (resumedRecoveryDraft) {
                  clearDraft(connectionId, path, "text");
                }
                if (pendingUnsavedChangesAction === "navigate") void routedEditing.completeNavigation();
                else void exitEditMode();
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
              disabled={isSaving}
              variant="contained"
            >
              {t("common.actions.save")}
            </Button>
          </>
        }
      >
        {null}
      </ResponsiveDialogShell>

      <KeyboardShortcutsHelp
        open={showViewerHelp}
        onClose={() => setShowViewerHelp(false)}
        shortcuts={textViewerShortcuts}
        title={t("keyboardShortcutsHelp.titles.textViewer")}
      />
      <KeyboardShortcutsHelp
        open={showEditorHelp}
        onClose={() => setShowEditorHelp(false)}
        shortcuts={textEditorShortcuts}
        title={t("keyboardShortcutsHelp.titles.textEditor")}
      />
    </>
  );
};

export default memo(TextViewer);
