import { Alert, Box, Button, CircularProgress, Dialog, GlobalStyles, useMediaQuery, useTheme } from "@mui/material";
import type { Root as MarkdownRoot } from "mdast";
import {
  createRef,
  type ErrorInfo,
  type ForwardRefExoticComponent,
  memo,
  type RefAttributes,
  type RefObject,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useTranslation } from "react-i18next";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import {
  BROWSER_SHORTCUTS,
  CODEMIRROR_EDITOR_SHORTCUTS,
  COMMON_SHORTCUTS,
  MARKDOWN_EDITOR_SHORTCUTS,
  VIEWER_SHORTCUTS,
} from "../../config/keyboardShortcuts";
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
import { useTextEditorWordWrapPreference } from "../../pages/FileBrowser/preferences";
import { clearDraft, type DraftSnapshot, loadDraft, registerDraftSnapshot, saveDraft } from "../../services/draftRecovery";
import { error as logError, info as logInfo } from "../../services/logger";
import { useSambeeTheme } from "../../theme";
import { getSearchHighlightColors } from "../../theme/commonStyles";
import { getSyntaxVariables } from "../../theme/syntaxStyles";
import {
  CODEMIRROR_EDITOR_CONTENT_PADDING,
  CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE,
  getMarkdownContentStyles,
  getMarkdownTableSurfaceColors,
  getViewerColors,
  MARKDOWN_VIEWER_PRINT_STYLES,
  VIEWER_SCROLL_END_PADDING,
} from "../../theme/viewerStyles";
import { isApiError } from "../../types";
import { getApiErrorMessage } from "../../utils/apiErrors";
import { openExternalUrl } from "../../utils/externalLinks";
import type { ViewerComponentProps } from "../../utils/FileTypeRegistry";
import { highlightingService } from "../../utils/highlightingService";
import { blurActiveToolbarControl } from "../../utils/keyboardUtils";
import { normalizeMarkdownSource } from "../../utils/markdownCodePreparation";
import { rehypeMarkdownHeadingLinks } from "../../utils/markdownHeadingLinks";
import { remarkPreparedMarkdownTree } from "../../utils/markdownPreparedTree";
import {
  recordMarkdownPreparation,
  rehypeMeasureMarkdownPreparation,
  remarkCollectMarkdownCodeBlocks,
  remarkMeasureMarkdownPreparation,
} from "../../utils/markdownSyntax";
import { publishMarkdownSyntax } from "../../utils/markdownSyntaxPublication";
import { prepareMarkdownSyntax } from "../../utils/markdownSyntaxWorker";
import { createShareFile, supportsNativeShare } from "../../utils/nativeShare";
import type { CodeBlockRequest } from "../../utils/syntaxHighlighting";
import { createViewportDomTextSearch } from "../../utils/viewportDomTextSearch";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { HelpMenu } from "../FileBrowser/HelpMenu";
import { KeyboardShortcutsHelp } from "../KeyboardShortcutsHelp";
import { settingsUtilityButtonSx } from "../Settings/settingsButtonStyles";
import { ViewerShareMenu } from "../Sharing/ViewerShareMenu";
import { CodeMirrorFindReplacePopover } from "./CodeMirrorFindReplacePopover";
import { scheduleRetriableFocusRestore } from "./focusRestoration";
import { loadMarkdownRichEditor } from "./loadMarkdownRichEditor";
import MarkdownEditorErrorBoundary from "./MarkdownEditorErrorBoundary";
import type { MarkdownRichEditorHandle, MarkdownRichEditorProps, MarkdownRichEditorSearchState } from "./MarkdownRichEditor";
import { emitMarkdownDebugTrace } from "./markdownDebugTrace";
import {
  MARKDOWN_EDITOR_AUTOFOCUS_RETRY_DELAYS_MS,
  MARKDOWN_VIEWER_CONTENT_AUTOFOCUS_DELAY_MS,
  MARKDOWN_VIEWER_ENTER_EDIT_FOCUS_DELAYS_MS,
  MARKDOWN_VIEWER_RESTORE_FOCUS_DELAYS_MS,
  MARKDOWN_VIEWER_UNSAVED_DIALOG_AUTOFOCUS_DELAYS_MS,
  MARKDOWN_VIEWER_UNSAVED_DIALOG_RESTORE_FOCUS_DELAY_MS,
} from "./markdownEditorConstants";
import { areMarkdownSearchStatesEqual } from "./markdownSearchState";
import { normalizeMarkdownTableCellLineBreaks, remarkRenderMarkdownTableCellLineBreaks } from "./markdownTableCellLineBreaks";
import { RecoveredDraftDialog } from "./RecoveredDraftDialog";
import { RetainedMarkdownPreview } from "./RetainedMarkdownPreview";
import { useMarkdownEditSession } from "./useMarkdownEditSession";
import { VIEWER_SEARCH_INPUT_ATTRIBUTE, ViewerControls, ViewerFilenameBadge } from "./ViewerControls";
import { downloadViewerBlob } from "./viewerContent";
import { createEditToolbarAction, createPrintToolbarAction, createSaveToolbarAction } from "./viewerToolbarActions";

const MARKDOWN_SEARCH_ROOT_SELECTOR = '[data-markdown-search-root="true"]';
const USE_RETAINED_MARKDOWN_PREVIEW = import.meta.env.MODE === "test-preview";
const MARKDOWN_HASH_PREFIX = "#";
const MARKDOWN_SUPPORTED_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const MARKDOWN_VIEWER_EDIT_FOCUS_RETRY_DELAYS_MS = [
  ...MARKDOWN_VIEWER_ENTER_EDIT_FOCUS_DELAYS_MS,
  ...MARKDOWN_EDITOR_AUTOFOCUS_RETRY_DELAYS_MS,
];

type MarkdownRichEditorComponent = ForwardRefExoticComponent<MarkdownRichEditorProps & RefAttributes<MarkdownRichEditorHandle>>;

interface MarkdownPreviewGeneration {
  id: number;
  source: string;
  tree?: MarkdownRoot;
  requests: RefObject<readonly CodeBlockRequest[] | null>;
}

const MarkdownPreview = memo(function MarkdownPreview({
  generation,
  onExternalLink,
}: {
  generation: MarkdownPreviewGeneration;
  onExternalLink: () => void;
}) {
  const content = generation.source;
  const preparation = useMemo(() => ({ source: content, hastReady: 0, requests: [] as CodeBlockRequest[] }), [content]);
  useLayoutEffect(() => {
    generation.requests.current = preparation.requests;
    if (preparation.source === content && preparation.hastReady)
      recordMarkdownPreparation("hast-ready-to-layout-effect", preparation.hastReady);
  }, [content, generation, preparation]);
  return (
    <ReactMarkdown
      remarkPlugins={[
        remarkGfm,
        remarkMeasureMarkdownPreparation,
        [remarkPreparedMarkdownTree, generation.tree],
        [
          remarkCollectMarkdownCodeBlocks,
          (requests: CodeBlockRequest[]) => {
            preparation.requests = requests;
          },
        ],
        remarkRenderMarkdownTableCellLineBreaks,
      ]}
      rehypePlugins={[
        rehypeMarkdownHeadingLinks,
        [
          rehypeMeasureMarkdownPreparation,
          () => {
            preparation.hastReady = performance.now();
          },
        ],
      ]}
      components={{
        a: ({ href, node: _node, ...props }) => {
          if (typeof href !== "string") return <a {...props} />;
          const resolvedHref = resolveMarkdownLinkHref(href);
          if (!resolvedHref) return <span>{props.children}</span>;
          const opensNewTab = !resolvedHref.startsWith(MARKDOWN_HASH_PREFIX);
          return (
            <a
              {...props}
              href={resolvedHref}
              rel={opensNewTab ? "noopener noreferrer" : undefined}
              target={opensNewTab ? "_blank" : undefined}
              onClick={
                opensNewTab
                  ? (event) => {
                      event.preventDefault();
                      openExternalUrl(resolvedHref);
                      onExternalLink();
                    }
                  : undefined
              }
            />
          );
        },
      }}
    >
      {content}
    </ReactMarkdown>
  );
});

function resolveMarkdownLinkHref(href: string): string | null {
  const trimmedHref = href.trim();

  if (!trimmedHref) {
    return null;
  }

  if (trimmedHref.startsWith(MARKDOWN_HASH_PREFIX)) {
    return trimmedHref;
  }

  try {
    const resolvedUrl = new URL(trimmedHref, window.location.href);
    return MARKDOWN_SUPPORTED_LINK_PROTOCOLS.has(resolvedUrl.protocol) ? resolvedUrl.toString() : null;
  } catch {
    return null;
  }
}

function isViewerSearchInputFocused(): boolean {
  return document.activeElement instanceof HTMLElement && document.activeElement.getAttribute(VIEWER_SEARCH_INPUT_ATTRIBUTE) === "true";
}

function isMarkdownEditorTextInputFocused(): boolean {
  const activeElement = document.activeElement;

  if (!(activeElement instanceof HTMLElement)) {
    return false;
  }

  if (!activeElement.closest(".sambee-markdown-editor")) {
    return false;
  }

  return activeElement.matches('textarea, [contenteditable="true"]');
}

function getEditorErrorMessage(error: unknown, fallbackMessage: string): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }

  return fallbackMessage;
}

function withOpacity(color: string, opacity: number): string {
  const normalizedOpacity = Math.max(0, Math.min(1, opacity));
  const hex = color.trim().replace(/^#/, "");

  if (/^[0-9a-fA-F]{3}$/.test(hex)) {
    const redHex = hex.slice(0, 1);
    const greenHex = hex.slice(1, 2);
    const blueHex = hex.slice(2, 3);
    const red = Number.parseInt(redHex + redHex, 16);
    const green = Number.parseInt(greenHex + greenHex, 16);
    const blue = Number.parseInt(blueHex + blueHex, 16);
    return `rgba(${red}, ${green}, ${blue}, ${normalizedOpacity})`;
  }

  if (/^[0-9a-fA-F]{6}$/.test(hex)) {
    const red = Number.parseInt(hex.slice(0, 2), 16);
    const green = Number.parseInt(hex.slice(2, 4), 16);
    const blue = Number.parseInt(hex.slice(4, 6), 16);
    return `rgba(${red}, ${green}, ${blue}, ${normalizedOpacity})`;
  }

  const rgbMatch = color.match(/rgba?\(([^)]+)\)/i);

  if (rgbMatch) {
    const channels = (rgbMatch[1] ?? "").split(",").map((value) => value.trim());
    const [red = "0", green = "0", blue = "0"] = channels;
    return `rgba(${red}, ${green}, ${blue}, ${normalizedOpacity})`;
  }

  return color;
}

type PendingUnsavedChangesAction = "cancel-edit" | "stay-edit" | "navigate";
type MarkdownSearchCloseReason = "escape" | "toggle";
type EditorModuleLoadState = "idle" | "loading" | "loaded" | "failed";

const DRAFT_SNAPSHOT_DEBOUNCE_MS = 250;

function preserveMarkdownEditorSelection(editorRef: React.RefObject<MarkdownRichEditorHandle | null>): void {
  editorRef.current?.preserveSelection();
}

/**
 * Markdown Viewer Component
 * Displays markdown files with syntax highlighting and GitHub-flavored markdown support.
 * Integrated with ViewerControls and keyboard shortcuts system.
 */
export const MarkdownViewer: React.FC<ViewerComponentProps> = ({
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
  const [content, setContent] = useState<string>("");
  const [preparedPreview, setPreparedPreview] = useState<{ source: string; tree: MarkdownRoot } | null>(null);
  const [draftContent, setDraftContent] = useState<string>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editError, setEditError] = useState<string | null>(null);
  const [printError, setPrintError] = useState(false);
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
  const [viewerSearchText, setViewerSearchText] = useState("");
  const [editorSearchCaseSensitive, setEditorSearchCaseSensitive] = useState(false);
  const [editorSearchFocusTarget, setEditorSearchFocusTarget] = useState<"find" | "replace" | null>(null);
  const [editorSearchMode, setEditorSearchMode] = useState<"find" | "replace">("find");
  const [editorSearchRegexp, setEditorSearchRegexp] = useState(false);
  const [editorSearchReplaceText, setEditorSearchReplaceText] = useState("");
  const [editorSearchText, setEditorSearchText] = useState("");
  const [editorSearchWholeWord, setEditorSearchWholeWord] = useState(false);
  const [searchMatches, setSearchMatches] = useState(0);
  const [currentSearchMatch, setCurrentSearchMatch] = useState(0);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [editorSearchAutoNavigate, setEditorSearchAutoNavigate] = useState(true);
  const [editorBoundaryKey, setEditorBoundaryKey] = useState(0);
  const [editorFailed, setEditorFailed] = useState(false);
  const [editorLoadState, setEditorLoadState] = useState<EditorModuleLoadState>("idle");
  const [editorLoadError, setEditorLoadError] = useState<Error | null>(null);
  const [editorLoadNonce, setEditorLoadNonce] = useState(0);
  const [EditorComponent, setEditorComponent] = useState<MarkdownRichEditorComponent | null>(null);
  const [pendingUnsavedChangesAction, setPendingUnsavedChangesAction] = useState<PendingUnsavedChangesAction | null>(null);
  const [wordWrapEnabled, setWordWrapEnabled] = useTextEditorWordWrapPreference(true);
  const [editorSearchState, setEditorSearchState] = useState<MarkdownRichEditorSearchState>({
    searchText: "",
    searchMatches: 0,
    currentMatch: 0,
    isSearchOpen: false,
    isSearchable: true,
    isValid: true,
    viewMode: "rich-text",
  });
  const contentRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MarkdownRichEditorHandle | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const unsavedChangesCancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const editSessionRef = useRef<ContentEditSession | null>(null);
  const previewSearchRef = useRef<ReturnType<typeof createViewportDomTextSearch> | null>(null);
  const [previewSearchRevision, setPreviewSearchRevision] = useState(0);
  const previewGenerationCounter = useRef(0);
  const previewGeneration = useMemo<MarkdownPreviewGeneration>(
    () => ({
      id: ++previewGenerationCounter.current,
      source: content,
      tree: preparedPreview?.source === content ? preparedPreview.tree : undefined,
      requests: createRef<readonly CodeBlockRequest[]>(),
    }),
    [content, preparedPreview]
  );
  const previewRevision = `${previewGeneration.id}:plain`;
  const latestPreviewGeneration = useRef(previewGeneration);
  latestPreviewGeneration.current = previewGeneration;
  const activeMatchRef = useRef(currentSearchMatch);
  activeMatchRef.current = currentSearchMatch;
  const lastPreviewSearch = useRef<{ generation: number; query: string } | null>(null);
  const editBaselineContentRef = useRef("");
  const isEditingRef = useRef(false);
  const editorLoadStateRef = useRef<EditorModuleLoadState>("idle");
  const fetchWithRetry = useApiRetry();

  const { currentTheme } = useSambeeTheme();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const shareEnabled = isMobile && supportsNativeShare();
  const { viewerBg, toolbarBg, toolbarText, viewerText, linkColor, linkHoverColor } = getViewerColors(currentTheme, "markdown");
  const markdownTableSurfaceColors = getMarkdownTableSurfaceColors(muiTheme);
  const searchHighlightColors = useMemo(() => getSearchHighlightColors(muiTheme, currentTheme), [currentTheme, muiTheme]);
  const markdownEditorTheme = useMemo(
    () => ({
      activeLineBackground: muiTheme.palette.action.selected,
      borderColor: withOpacity(viewerText, muiTheme.palette.mode === "dark" ? 0.32 : 0.16),
      currentSearchMatchBackground: searchHighlightColors.currentMatch,
      isDarkMode: muiTheme.palette.mode === "dark",
      linkColor,
      otherSearchMatchBackground: searchHighlightColors.otherMatches,
      selectionBackground: withOpacity(linkColor, muiTheme.palette.mode === "dark" ? 0.3 : 0.18),
      surfaceBackground: viewerBg,
      tableAlternateRowBackground: markdownTableSurfaceColors.alternateRowBackground,
      tableBackground: markdownTableSurfaceColors.tableBackground,
      tableBorderColor: markdownTableSurfaceColors.border,
      tableHeaderBackground: markdownTableSurfaceColors.headerBackground,
      tableHeaderText: markdownTableSurfaceColors.headerText,
      textColor: viewerText,
    }),
    [
      linkColor,
      markdownTableSurfaceColors.alternateRowBackground,
      markdownTableSurfaceColors.border,
      markdownTableSurfaceColors.headerBackground,
      markdownTableSurfaceColors.headerText,
      markdownTableSurfaceColors.tableBackground,
      muiTheme.palette.action.selected,
      muiTheme.palette.mode,
      searchHighlightColors.currentMatch,
      searchHighlightColors.otherMatches,
      viewerBg,
      viewerText,
    ]
  );
  const currentSearchText = isEditing ? editorSearchText : viewerSearchText;
  const activeViewerSearchText = !isEditing && searchPanelOpen ? viewerSearchText : "";

  // Extract filename from path
  const filename = path.split("/").pop() || path;

  const focusViewerContent = useCallback(() => {
    if (isEditing) {
      return;
    }

    contentRef.current?.focus({ preventScroll: true });
  }, [isEditing]);

  useEffect(() => {
    const viewport = contentRef.current;
    if (isEditing || loading || error || !viewport) return;
    let restore: (() => void) | undefined;
    let frame: number | undefined;
    const beforePrint = () => {
      if (frame !== undefined) cancelAnimationFrame(frame);
      const scroll = [viewport, ...viewport.querySelectorAll("pre, table")].map((element) => ({
        element,
        top: element.scrollTop,
        left: element.scrollLeft,
      }));
      const selection = window.getSelection();
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
      const focus = document.activeElement;
      restore = () => {
        if (focus instanceof HTMLElement && focus.isConnected) focus.focus({ preventScroll: true });
        if (selection && ranges.every((range) => range.startContainer.isConnected && range.endContainer.isConnected)) {
          selection.removeAllRanges();
          for (const range of ranges) selection.addRange(range);
        }
        for (const { element, top, left } of scroll) {
          element.scrollTop = top;
          element.scrollLeft = left;
        }
      };
    };
    const afterPrint = () => {
      frame = requestAnimationFrame(() => {
        restore?.();
        restore = undefined;
        frame = undefined;
      });
    };
    window.addEventListener("beforeprint", beforePrint);
    window.addEventListener("afterprint", afterPrint);
    return () => {
      window.removeEventListener("beforeprint", beforePrint);
      window.removeEventListener("afterprint", afterPrint);
      if (frame !== undefined) cancelAnimationFrame(frame);
    };
  }, [error, isEditing, loading]);

  const restoreEditingFocus = useCallback(() => {
    if (!isEditing) {
      return;
    }

    return scheduleRetriableFocusRestore({
      delaysMs: MARKDOWN_VIEWER_RESTORE_FOCUS_DELAYS_MS,
      attemptRestore: () => {
        if (editorRef.current?.restorePreservedSelection() === true) {
          return true;
        }

        if (isMarkdownEditorTextInputFocused()) {
          return true;
        }

        editorRef.current?.focus();
        return isMarkdownEditorTextInputFocused();
      },
    });
  }, [isEditing]);

  const unsavedChangesDialogOpen = pendingUnsavedChangesAction !== null;
  const editBaselineContent = editBaselineContentRef.current;

  const setEditBaselineContent = useCallback((nextContent: string) => {
    editBaselineContentRef.current = nextContent;
  }, []);

  useEffect(() => {
    isEditingRef.current = isEditing;
  }, [isEditing]);

  useEffect(() => {
    editorLoadStateRef.current = editorLoadState;
  }, [editorLoadState]);

  const handleEditorSearchStateChange = useCallback((nextState: MarkdownRichEditorSearchState) => {
    setEditorSearchState((previousState) => (areMarkdownSearchStatesEqual(previousState, nextState) ? previousState : nextState));
  }, []);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    // Do not key this effect off editorLoadState. It sets that state itself,
    // and including it here causes the cleanup to cancel the in-flight load.
    if (EditorComponent || editorLoadStateRef.current === "loading") {
      return;
    }

    let cancelled = false;

    setEditorLoadState("loading");
    setEditorLoadError(null);

    void (async () => {
      try {
        const module = await loadMarkdownRichEditor();

        if (cancelled) {
          return;
        }

        setEditorComponent(() => module.default as MarkdownRichEditorComponent);
        setEditorLoadState("loaded");
      } catch (error) {
        if (cancelled) {
          return;
        }

        const resolvedError = error instanceof Error ? error : new Error(t("viewer.edit.editorLoadFailedReason"));
        setEditorLoadError(resolvedError);
        setEditorLoadState("failed");
        logError(
          "Markdown editor failed to load",
          {
            error,
            path,
            connectionId,
            nonce: editorLoadNonce,
          },
          "viewer",
          resolvedError
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [EditorComponent, connectionId, editorLoadNonce, isEditing, path, t]);

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

  // Load markdown content only when the viewed file changes.
  // Entering edit mode is a local UI transition and must not re-trigger loading,
  // otherwise the editor subtree is briefly replaced by the loading state.
  useEffect(() => {
    const abortController = new AbortController();

    const loadContent = async () => {
      let sourceLoaded = false;
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
            ).then(async (blob) => {
              const start = performance.now();
              try {
                return await blob.text();
              } finally {
                recordMarkdownPreparation("decode-elapsed", start);
              }
            }),
          {
            signal: abortController.signal,
            maxRetries: 1,
            retryDelay: 1000,
          }
        );
        sourceLoaded = true;
        const normalizationStart = performance.now();
        let tree: MarkdownRoot | undefined;
        const normalizedData = await normalizeMarkdownSource(data, abortController.signal, (prepared) => {
          tree = prepared;
        });
        if (abortController.signal.aborted) return;
        recordMarkdownPreparation("load-normalization-elapsed", normalizationStart);
        setPreparedPreview(tree ? { source: normalizedData, tree } : null);
        setContent(normalizedData);
        if (!isEditingRef.current && !isReadOnly) {
          const recoveredDraft = loadDraft(connectionId, path, "markdown");
          setDraftContent(normalizedData);
          setEditBaselineContent(normalizedData);
          setResumedRecoveryDraft(false);
          setRecoveryDraft(recoveredDraft && recoveredDraft.content !== recoveredDraft.baseline ? recoveredDraft : null);
        }
      } catch (err) {
        if (abortController.signal.aborted) {
          return;
        }

        // Show "server busy" only for actual transient/network errors
        const errorMessage =
          !sourceLoaded && checkIsTransientError(err)
            ? getTransientErrorMessage()
            : getApiErrorMessage(err, "Failed to load markdown file", { includeOriginalMessage: true });

        setError(errorMessage);
        logError("Error loading markdown:", {
          error: err,
          path,
          connectionId,
          detail: isApiError(err) ? err.response?.data?.detail : undefined,
        });
      } finally {
        setLoading(false);
      }
    };

    loadContent();

    return () => {
      abortController.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connectionId, contentProviders, fetchWithRetry, isReadOnly, path, setEditBaselineContent, virtualSource]);

  const snapshotDraft = useCallback(() => {
    if (!isEditingRef.current) {
      return;
    }

    try {
      const editor = editorRef.current;
      if (!editor) throw new Error("The Markdown editor is not mounted");
      const latestContent = editor.captureSnapshotSync().serialize();
      if (latestContent === editBaselineContentRef.current) {
        clearDraft(connectionId, path, "markdown");
        setDraftStorageWarning(null);
      } else {
        const result = saveDraft(connectionId, path, "markdown", editBaselineContentRef.current, latestContent);
        if (result.saved || result.reason === "no-user") {
          setDraftStorageWarning(null);
        } else {
          setDraftStorageWarning(
            result.reason === "too-large" ? t("viewer.edit.recovery.tooLargeWarning") : t("viewer.edit.recovery.storageUnavailableWarning")
          );
        }
      }
    } catch (error) {
      logError("Markdown recovery snapshot failed; keep the editor open and save the file", {
        error,
        connectionId,
        path,
      });
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

  // Auto-focus the content when loaded so keyboard scrolling works
  useEffect(() => {
    if (loading || error || isEditing || !contentRef.current) {
      return;
    }

    // Small delay to ensure dialog transition is complete.
    const timeoutId = window.setTimeout(() => {
      if (isViewerSearchInputFocused()) return;
      focusViewerContent();
    }, MARKDOWN_VIEWER_CONTENT_AUTOFOCUS_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [error, focusViewerContent, isEditing, loading]);

  useEffect(() => {
    if (!isEditing || editorLoadState !== "loaded" || editorLoadError || !EditorComponent || searchPanelOpen) {
      return;
    }

    const timeoutIds = MARKDOWN_VIEWER_EDIT_FOCUS_RETRY_DELAYS_MS.map((delayMs) =>
      window.setTimeout(() => {
        if (isViewerSearchInputFocused()) {
          return;
        }

        editorRef.current?.focus();
      }, delayMs)
    );

    return () => {
      for (const timeoutId of timeoutIds) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [EditorComponent, editorLoadError, editorLoadState, isEditing, searchPanelOpen]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [isEditing]);

  const hasUnsavedChanges = isEditing && draftContent !== editBaselineContent;
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

  const releaseEditSession = useCallback(async () => {
    const session = editSessionRef.current;
    if (!session) {
      return;
    }
    editSessionRef.current = null;
    try {
      await session.release();
    } catch (err) {
      logError("Failed to release markdown edit lock", { error: err, path, connectionId });
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
        logError("Failed to refresh markdown edit lock", { error: err, path, connectionId });
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
          logError("Failed to release markdown edit lock during cleanup", { error: err, path, connectionId });
        });
      }
    };
  }, [connectionId, path]);

  // Download handler
  const handleDownload = useCallback(
    async (_event?: KeyboardEvent) => {
      try {
        if (virtualSource) {
          downloadViewerBlob(await readVirtualContent(virtualSource, path, { download: true }, contentProviders), filename);
          return;
        }
        downloadViewerBlob(await readViewerContent(connectionId, path, { kind: "raw" }, { download: true }, contentProviders), filename);
      } catch (err) {
        logError("Failed to download file", { error: err, path, connectionId });
      }
    },
    [connectionId, contentProviders, path, filename, virtualSource]
  );

  const loadShareFile = useCallback(
    (signal: AbortSignal) =>
      readViewerContent(connectionId, path, { kind: "raw" }, { signal, virtualSource }, contentProviders).then((blob) =>
        createShareFile(blob, filename)
      ),
    [connectionId, contentProviders, filename, path, virtualSource]
  );
  const nativeSharing = useViewerSharing({
    entryPoint: "markdown",
    identity: `${connectionId}:${path}:${fileModifiedAt}:${shareRevision}`,
    enabled: shareEnabled && !loading && !isSaving && !error,
    loadFile: loadShareFile,
  });

  useEffect(() => {
    const requests = previewGeneration.requests.current;
    if (isEditing || loading || error || !requests?.length) return;
    const controller = new AbortController();
    let dispose: (() => void) | undefined;
    void prepareMarkdownSyntax(requests, controller.signal)
      .then((results) => {
        if (controller.signal.aborted || latestPreviewGeneration.current !== previewGeneration) return;
        const viewport = contentRef.current;
        const root = viewport?.querySelector<HTMLElement>(MARKDOWN_SEARCH_ROOT_SELECTOR);
        if (viewport && root) {
          dispose = publishMarkdownSyntax(root, viewport, { requests, results }, controller.signal);
        }
      })
      .catch((failure: unknown) => {
        if (!controller.signal.aborted)
          logError(
            "Markdown syntax preparation failed; retaining plain text",
            { operation: "prepare" },
            "MarkdownViewer",
            failure instanceof Error ? failure : undefined
          );
      });
    return () => {
      controller.abort();
      dispose?.();
    };
  }, [error, isEditing, loading, previewGeneration]);

  useLayoutEffect(() => {
    const viewport = contentRef.current;
    const markdownRoot = viewport?.querySelector(MARKDOWN_SEARCH_ROOT_SELECTOR);
    if (isEditing || loading || error || !viewport || !(markdownRoot instanceof HTMLElement)) return;
    if (markdownRoot?.getAttribute("data-markdown-preview-revision") !== previewRevision) return;
    const search = createViewportDomTextSearch(markdownRoot, viewport, () => setPreviewSearchRevision((revision) => revision + 1));
    previewSearchRef.current = search;
    if (!search.supported) {
      logInfo(
        "Preview search highlighting is unavailable in this browser; counts and navigation remain available. Use a browser supporting CSS Highlights for visible matches."
      );
    }
    return () => {
      search.dispose();
      if (previewSearchRef.current === search) previewSearchRef.current = null;
    };
  }, [error, isEditing, loading, previewRevision]);

  useLayoutEffect(() => {
    const search = previewSearchRef.current;
    if (isEditing || !activeViewerSearchText.trim() || loading || error) {
      search?.setQuery("", previewSearchRevision);
      setSearchMatches(0);
      setCurrentSearchMatch(0);
      return;
    }

    if (!search) {
      setSearchMatches(0);
      setCurrentSearchMatch(0);
      return;
    }

    const count = search.setQuery(activeViewerSearchText, previewSearchRevision);
    const unchangedSearch =
      lastPreviewSearch.current?.generation === previewGeneration.id && lastPreviewSearch.current.query === activeViewerSearchText;
    const initialMatch = count > 0 ? (unchangedSearch ? Math.max(1, Math.min(activeMatchRef.current, count)) : 1) : 0;
    lastPreviewSearch.current = { generation: previewGeneration.id, query: activeViewerSearchText };
    setSearchMatches(count);
    setCurrentSearchMatch(initialMatch);
    search.activate(initialMatch, !unchangedSearch);
  }, [activeViewerSearchText, error, isEditing, loading, previewGeneration.id, previewSearchRevision]);

  useEffect(() => {
    previewSearchRef.current?.activate(currentSearchMatch);
  }, [currentSearchMatch]);

  useEffect(() => {
    if (!isEditing || !editorFailed) {
      return;
    }

    setSearchMatches(0);
    setCurrentSearchMatch(0);
  }, [editorFailed, isEditing]);

  useEffect(() => {
    if (!isEditing) {
      return;
    }

    setSearchMatches(editorSearchState.searchMatches);
    setCurrentSearchMatch(editorSearchState.currentMatch);

    if (searchPanelOpen && !editorSearchState.isSearchable) {
      setSearchPanelOpen(false);
    }
  }, [editorSearchState.currentMatch, editorSearchState.isSearchable, editorSearchState.searchMatches, isEditing, searchPanelOpen]);

  const exitEditMode = useCallback(
    async (nextContent = content) => {
      clearPendingBaselineSync();
      clearBaselineSyncWindow();
      await releaseEditSession();
      if (searchPanelOpen) {
        setViewerSearchText(editorSearchText);
      } else {
        setViewerSearchText("");
      }
      setDraftContent(nextContent);
      setEditBaselineContent(nextContent);
      markEditSessionPristine();
      setEditError(null);
      setEditorLoadError(null);
      setEditorFailed(false);
      setEditorBoundaryKey((previousKey) => previousKey + 1);
      setIsEditing(false);
      setPendingUnsavedChangesAction(null);
    },
    [
      clearBaselineSyncWindow,
      clearPendingBaselineSync,
      content,
      editorSearchText,
      markEditSessionPristine,
      releaseEditSession,
      searchPanelOpen,
      setEditBaselineContent,
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
    async (initialDraft = content): Promise<boolean> => {
      if (editSessionRef.current || isAcquiring) return Boolean(editSessionRef.current);
      if (isReadOnly || loading || error) {
        return false;
      }

      setEditError(null);
      setEditorLoadError(null);
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

        setDraftContent(normalizeMarkdownTableCellLineBreaks(initialDraft));
        setEditBaselineContent(content);
        setEditorSearchText(searchPanelOpen ? viewerSearchText : "");
        setEditorSearchAutoNavigate(true);
        clearPendingBaselineSync();
        beginBaselineSyncWindow();
        markEditSessionPristine();
        setEditorLoadState((previousState) => {
          if (EditorComponent) {
            return "loaded";
          }

          return previousState === "failed" ? "idle" : previousState;
        });
        setEditorFailed(false);
        setEditorBoundaryKey((previousKey) => previousKey + 1);
        setIsEditing(true);
        navigation?.onModeChange("edit");
        return true;
      } catch (err) {
        const message = getApiErrorMessage(err, t("viewer.edit.lockFailedReason"), { includeOriginalMessage: true });
        setEditError(t("viewer.edit.lockFailed", { message }));
        logError("Failed to enter markdown edit mode", { error: err, path, connectionId });
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
      EditorComponent,
      error,
      isReadOnly,
      isAcquiring,
      loading,
      markEditSessionPristine,
      path,
      searchPanelOpen,
      setEditBaselineContent,
      t,
      viewerSearchText,
      navigation,
    ]
  );

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
      preserveMarkdownEditorSelection(editorRef);
      setPendingUnsavedChangesAction("navigate");
    },
  });

  const handleDiscardRecoveryDraft = useCallback(() => {
    clearDraft(connectionId, path, "markdown");
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
      preserveMarkdownEditorSelection(editorRef);
      setPendingUnsavedChangesAction("cancel-edit");
      return;
    }

    await exitEditMode();
  }, [exitEditMode, hasUnsavedChanges, navigation]);

  const persistDraft = useCallback(
    async (afterSave: PendingUnsavedChangesAction = "stay-edit") => {
      emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:start", {
        afterSave,
        isEditing,
        isReadOnly,
        draftContentLength: draftContent.length,
      });

      if (!isEditing) {
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:skipped", { reason: "not-editing" });
        return false;
      }

      if (isReadOnly) {
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:skipped", { reason: "read-only" });
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
        if (!editor) throw new Error("Markdown editor is no longer available for saving");
        const saveGeneration = getEditGeneration();
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:flush-start");
        const snapshot = await editor.captureSnapshot();
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:flush-resolved");
        const savedContent = normalizeMarkdownTableCellLineBreaks(snapshot.serialize());
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:getCanonicalMarkdown", {
          savedContentLength: savedContent.length,
          revision: snapshot.revision,
        });

        if (!editSession) throw new Error("Edit session is no longer active");
        await editSession.writeText(savedContent, { mimeType: "text/markdown;charset=utf-8" });
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:save-resolved", {
          savedContentLength: savedContent.length,
        });
        const hasNewerEdits =
          getEditGeneration() !== saveGeneration && normalizeMarkdownTableCellLineBreaks(editor.getCanonicalMarkdown()) !== savedContent;
        clearPendingBaselineSync();
        if (hasNewerEdits) clearBaselineSyncWindow();
        else beginBaselineSyncWindow();
        setPreparedPreview((prepared) => (prepared?.source === savedContent ? prepared : null));
        setContent(savedContent);
        setShareRevision((revision) => revision + 1);
        setEditBaselineContent(savedContent);
        if (!hasNewerEdits) {
          setDraftContent(savedContent);
          markEditSessionPristine();
          clearDraft(connectionId, path, "markdown");
        }

        if (afterSave === "cancel-edit" && !hasNewerEdits) {
          await exitEditMode(savedContent);
        }

        return !hasNewerEdits;
      } catch (err) {
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:error", {
          message: err instanceof Error ? err.message : String(err),
        });
        setEditError(getApiErrorMessage(err, t("viewer.edit.saveFailed"), { includeOriginalMessage: true }));
        logError("Failed to save markdown", { error: err, path, connectionId });
        return false;
      } finally {
        emitMarkdownDebugTrace("MarkdownViewer", "persistDraft:finally", {
          afterSave,
        });
        setIsSaving(false);

        if (afterSave === "stay-edit") {
          window.requestAnimationFrame(() => {
            restoreEditingFocus();
          });
        }
      }
    },
    [
      beginBaselineSyncWindow,
      clearBaselineSyncWindow,
      clearPendingBaselineSync,
      connectionId,
      draftContent,
      editSession,
      exitEditMode,
      getEditGeneration,
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

  const handleUnsavedChangesDialogClose = useCallback(() => {
    routedEditing.cancelNavigation();
    setPendingUnsavedChangesAction(null);
  }, [routedEditing]);

  useEffect(() => {
    if (!unsavedChangesDialogOpen) {
      return;
    }

    return scheduleRetriableFocusRestore({
      delaysMs: MARKDOWN_VIEWER_UNSAVED_DIALOG_AUTOFOCUS_DELAYS_MS,
      attemptRestore: () => {
        const cancelButton = unsavedChangesCancelButtonRef.current;

        if (!cancelButton || cancelButton.disabled) {
          return false;
        }

        if (document.activeElement === cancelButton) {
          return true;
        }

        cancelButton.focus();
        return document.activeElement === cancelButton;
      },
    });
  }, [unsavedChangesDialogOpen]);

  const handleUnsavedChangesDialogExited = useCallback(() => {
    const cleanupFocus = restoreEditingFocus();

    if (!cleanupFocus) {
      return;
    }

    window.setTimeout(() => {
      cleanupFocus();
    }, MARKDOWN_VIEWER_UNSAVED_DIALOG_RESTORE_FOCUS_DELAY_MS);
  }, [restoreEditingFocus]);

  const handleUnsavedChangesDialogEntered = useCallback(() => {
    const focusCancelButton = () => {
      unsavedChangesCancelButtonRef.current?.focus();
    };

    focusCancelButton();
    window.requestAnimationFrame(focusCancelButton);
  }, []);

  const handleUnsavedChangesDiscard = useCallback(async () => {
    if (resumedRecoveryDraft) {
      clearDraft(connectionId, path, "markdown");
    }

    if (pendingUnsavedChangesAction === "navigate") await routedEditing.completeNavigation();
    else await exitEditMode();
  }, [connectionId, exitEditMode, path, resumedRecoveryDraft, pendingUnsavedChangesAction, routedEditing]);

  const handleUnsavedChangesSave = useCallback(async () => {
    if (!pendingUnsavedChangesAction) {
      return;
    }

    if (pendingUnsavedChangesAction === "navigate") {
      if (await persistDraft("stay-edit")) await routedEditing.completeNavigation();
    } else await persistDraft(pendingUnsavedChangesAction);
  }, [pendingUnsavedChangesAction, persistDraft, routedEditing]);

  // Toggle fullscreen mode
  const handleToggleFullscreen = useCallback(() => {
    if (!dialogRef.current) return;

    if (!document.fullscreenElement) {
      dialogRef.current.requestFullscreen().catch((err) => {
        logError("Failed to enable fullscreen", { error: err });
      });
    } else {
      document.exitFullscreen();
    }
  }, []);

  const closeSearchPanel = useCallback(
    ({ preserveQuery, restoreEditorFocus }: { preserveQuery: boolean; restoreEditorFocus: boolean }) => {
      setSearchPanelOpen(false);

      if (isEditing) {
        setEditorSearchFocusTarget(null);
        setEditorSearchMode("find");
      }

      if (!preserveQuery) {
        if (isEditing) {
          setEditorSearchText("");
          setEditorSearchAutoNavigate(true);
        } else {
          setViewerSearchText("");
        }
      }

      if (!restoreEditorFocus || !isEditing) {
        return;
      }

      const restoreFocusToEditorMatch = () => {
        if (editorRef.current?.focusCurrentSearchResult() === true) {
          return true;
        }

        editorRef.current?.focus();
        return false;
      };

      if (restoreFocusToEditorMatch()) {
        return;
      }

      window.requestAnimationFrame(() => {
        restoreFocusToEditorMatch();
      });
    },
    [isEditing]
  );

  const handleEscape = useCallback(
    (_event?: KeyboardEvent) => {
      if (searchPanelOpen || isViewerSearchInputFocused()) {
        closeSearchPanel({ preserveQuery: isEditing, restoreEditorFocus: isEditing });
      } else if (isEditing) {
        void handleCancelEdit();
      } else if (document.fullscreenElement) {
        document.exitFullscreen();
      } else {
        void handleRequestClose();
      }
    },
    [closeSearchPanel, handleCancelEdit, handleRequestClose, isEditing, searchPanelOpen]
  );

  const handleOpenSearch = useCallback(
    (_event?: KeyboardEvent) => {
      if (loading || error || (isEditing && !editorSearchState.isSearchable)) {
        return;
      }

      if (isEditing) {
        const selectedText = editorRef.current?.getPrimarySelectionText() ?? "";

        setEditorSearchAutoNavigate(false);
        setEditorSearchMode("find");
        setEditorSearchFocusTarget("find");
        setEditorSearchText(selectedText);
        setEditorSearchReplaceText("");
      }

      setSearchPanelOpen(true);
    },
    [editorSearchState.isSearchable, error, isEditing, loading]
  );

  const handleOpenReplace = useCallback(() => {
    if (loading || error || !isEditing || !editorSearchState.isSearchable) {
      return;
    }

    const selectedText = editorRef.current?.getPrimarySelectionText() ?? "";
    setEditorSearchAutoNavigate(false);
    setEditorSearchMode("replace");
    setEditorSearchFocusTarget(selectedText.trim().length > 0 ? "replace" : "find");
    setEditorSearchText(selectedText);
    setEditorSearchReplaceText("");

    setSearchPanelOpen(true);
  }, [editorSearchState.isSearchable, error, isEditing, loading]);

  const handleSearchChange = useCallback(
    (text: string) => {
      if (isEditing) {
        setEditorSearchAutoNavigate(false);
        setEditorSearchText(text);
        return;
      }

      setViewerSearchText(text);
    },
    [isEditing]
  );

  const activeEditorSearchText = isEditing && searchPanelOpen ? editorSearchText : "";
  const editorShouldBeReadOnly = Boolean(isSaving && pendingUnsavedChangesAction);

  const handleSearchPanelToggle = useCallback(
    (open: boolean) => {
      if (open) {
        if (isEditing) {
          setEditorSearchText("");
          setEditorSearchReplaceText("");
          setEditorSearchFocusTarget("find");
        }
        setSearchPanelOpen(true);
        return;
      }

      closeSearchPanel({ preserveQuery: isEditing, restoreEditorFocus: false });
    },
    [closeSearchPanel, isEditing]
  );

  const handleSearchClose = useCallback(
    (reason: MarkdownSearchCloseReason) => {
      closeSearchPanel({ preserveQuery: isEditing, restoreEditorFocus: isEditing && reason === "escape" });
    },
    [closeSearchPanel, isEditing]
  );

  const runEditorCommand = useCallback(
    (commandLabel: string, command: () => void) => {
      if (!isEditing || editorFailed || editorLoadState !== "loaded" || editorLoadError || !EditorComponent) {
        return;
      }

      setEditError(null);

      try {
        command();
      } catch (err) {
        const message = getEditorErrorMessage(err, t("viewer.edit.commandFailedReason"));
        setEditError(t("viewer.edit.commandFailed", { action: commandLabel, message }));
        logError("Markdown editor command failed", { error: err, path, connectionId, command: commandLabel });
      }
    },
    [EditorComponent, connectionId, editorFailed, editorLoadError, editorLoadState, isEditing, path, t]
  );

  const handleReplaceCurrent = useCallback(() => {
    setEditorSearchAutoNavigate(false);
    runEditorCommand(t("viewer.edit.replace"), () => {
      editorRef.current?.replaceCurrentSearchResult();
    });
  }, [runEditorCommand, t]);

  const handleReplaceAll = useCallback(() => {
    setEditorSearchAutoNavigate(false);
    runEditorCommand(t("viewer.edit.replaceAll"), () => {
      editorRef.current?.replaceAllSearchResults();
    });
  }, [runEditorCommand, t]);

  const handleEditorCrashed = useCallback(
    (error: Error, errorInfo: ErrorInfo) => {
      setEditorFailed(true);
      logError("Markdown editor crashed", { error, path, connectionId, componentStack: errorInfo.componentStack }, "viewer");
    },
    [connectionId, path]
  );

  const handleRetryEditor = useCallback(() => {
    setEditError(null);
    setEditorFailed(false);
    setEditorLoadError(null);

    if (editorLoadState === "failed") {
      setEditorComponent(null);
      setEditorLoadState("idle");
      setEditorLoadNonce((previousValue) => previousValue + 1);
      return;
    }

    setEditorBoundaryKey((previousKey) => previousKey + 1);
  }, [editorLoadState]);

  const handleToggleInlineCode = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.inlineCode"), () => {
      editorRef.current?.toggleInlineCode();
    });
  }, [runEditorCommand, t]);

  const handleToggleBold = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.bold"), () => {
      editorRef.current?.toggleBold();
    });
  }, [runEditorCommand, t]);

  const handleToggleItalic = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.italic"), () => {
      editorRef.current?.toggleItalic();
    });
  }, [runEditorCommand, t]);

  const handleCreateLink = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.createLink"), () => {
      editorRef.current?.createLink();
    });
  }, [runEditorCommand, t]);

  const handleInsertTable = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.insertTable"), () => {
      editorRef.current?.insertTable();
    });
  }, [runEditorCommand, t]);

  const handleInsertThematicBreak = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.insertThematicBreak"), () => {
      editorRef.current?.insertThematicBreak();
    });
  }, [runEditorCommand, t]);

  const handleInsertCodeBlock = useCallback(() => {
    runEditorCommand(t("viewer.shortcuts.insertCodeBlock"), () => {
      editorRef.current?.insertCodeBlock();
    });
  }, [runEditorCommand, t]);

  const handleSearchNext = useCallback(
    (_event?: KeyboardEvent) => {
      if (isEditing) {
        runEditorCommand(t("common.search.nextMatch"), () => {
          editorRef.current?.focusCurrentSearchResult();
          editorRef.current?.nextSearchResult();
        });
        return;
      }

      if (searchMatches === 0) {
        return;
      }

      setCurrentSearchMatch((previousMatch) => (previousMatch >= searchMatches ? 1 : previousMatch + 1));
    },
    [isEditing, runEditorCommand, searchMatches, t]
  );

  const handleSearchPrevious = useCallback(
    (_event?: KeyboardEvent) => {
      if (isEditing) {
        runEditorCommand(t("common.search.previousMatch"), () => {
          editorRef.current?.focusCurrentSearchResult();
          editorRef.current?.previousSearchResult();
        });
        return;
      }

      if (searchMatches === 0) {
        return;
      }

      setCurrentSearchMatch((previousMatch) => (previousMatch <= 1 ? searchMatches : previousMatch - 1));
    },
    [isEditing, runEditorCommand, searchMatches, t]
  );

  /**
   * Handles Escape not already consumed by a capture-phase shortcut or child.
   * 1. If a toolbar button/input has focus → blur it (hide focus ring)
   * 2. If in fullscreen → exit fullscreen
   * 3. Otherwise → close the viewer
   */
  const handlePaperKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (unsavedChangesDialogOpen) {
        return;
      }

      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      if (isMarkdownEditorTextInputFocused()) {
        handleEscape();
        return;
      }
      if (blurActiveToolbarControl(contentRef)) return;
      handleEscape();
    },
    [handleEscape, unsavedChangesDialogOpen]
  );

  const handleShowViewerHelp = useCallback(() => {
    setShowViewerHelp(true);
  }, []);

  const handleShowEditorHelp = useCallback(() => {
    setShowEditorHelp(true);
  }, []);

  const handleOpenDocumentation = useCallback(() => {
    openExternalUrl("https://sambee.net/docs/");
  }, []);

  const markdownViewerShortcuts = useMemo(
    () => [
      {
        ...COMMON_SHORTCUTS.DOWNLOAD,
        handler: handleDownload,
        enabled: !isEditing,
      },
      {
        ...COMMON_SHORTCUTS.SEARCH,
        handler: handleOpenSearch,
        enabled: !isEditing && !loading && !error,
      },
      {
        ...COMMON_SHORTCUTS.NEXT_MATCH,
        handler: handleSearchNext,
        enabled: !isEditing && searchMatches > 0,
      },
      {
        ...COMMON_SHORTCUTS.PREVIOUS_MATCH,
        handler: handleSearchPrevious,
        enabled: !isEditing && searchMatches > 0,
      },
      {
        ...COMMON_SHORTCUTS.EDIT,
        handler: () => {
          void handleEnterEditMode();
        },
        enabled: !isEditing && !isReadOnly,
      },
      {
        ...VIEWER_SHORTCUTS.FULLSCREEN,
        handler: handleToggleFullscreen,
        enabled: !isEditing,
      },
      {
        ...COMMON_SHORTCUTS.CLOSE,
        handler: handleEscape,
        allowInInput: false,
        enabled: !isEditing && !unsavedChangesDialogOpen,
      },
      {
        ...BROWSER_SHORTCUTS.SHOW_HELP,
        handler: handleShowViewerHelp,
        enabled: !isEditing,
      },
      {
        ...BROWSER_SHORTCUTS.SHOW_HELP_ALTERNATE,
        handler: handleShowViewerHelp,
        enabled: !isEditing,
      },
    ],
    [
      handleDownload,
      handleEnterEditMode,
      handleEscape,
      handleOpenSearch,
      handleSearchNext,
      handleSearchPrevious,
      handleShowViewerHelp,
      handleToggleFullscreen,
      error,
      isEditing,
      isReadOnly,
      loading,
      searchMatches,
      unsavedChangesDialogOpen,
    ]
  );

  const markdownEditorShortcuts = useMemo(
    () => [
      {
        ...COMMON_SHORTCUTS.DOWNLOAD,
        handler: handleDownload,
        enabled: isEditing,
      },
      {
        ...COMMON_SHORTCUTS.SEARCH,
        handler: handleOpenSearch,
        enabled: isEditing && !loading && !error && editorSearchState.isSearchable,
      },
      {
        ...COMMON_SHORTCUTS.NEXT_MATCH,
        handler: handleSearchNext,
        enabled: isEditing && (searchMatches > 0 || Boolean(editorSearchState.pending || editorSearchState.error)),
      },
      {
        ...COMMON_SHORTCUTS.PREVIOUS_MATCH,
        handler: handleSearchPrevious,
        enabled: isEditing && (searchMatches > 0 || Boolean(editorSearchState.pending || editorSearchState.error)),
      },
      {
        ...COMMON_SHORTCUTS.SAVE,
        handler: () => {
          void handleSave();
        },
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.BOLD,
        handler: handleToggleBold,
        enabled: isEditing && !isSaving,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE,
        handler: handleOpenReplace,
        enabled: isEditing && !isSaving,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_CURRENT,
        handler: handleReplaceCurrent,
        enabled: isEditing && !isSaving && editorSearchMode === "replace" && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.REPLACE_ALL,
        handler: handleReplaceAll,
        enabled: isEditing && !isSaving && editorSearchMode === "replace" && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_CASE_SENSITIVE,
        handler: () => setEditorSearchCaseSensitive((enabled) => !enabled),
        enabled: isEditing && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WHOLE_WORD,
        handler: () => setEditorSearchWholeWord((enabled) => !enabled),
        enabled: isEditing && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_REGULAR_EXPRESSION,
        handler: () => setEditorSearchRegexp((enabled) => !enabled),
        enabled: isEditing && searchPanelOpen,
      },
      {
        ...CODEMIRROR_EDITOR_SHORTCUTS.TOGGLE_WORD_WRAP,
        handler: () => setWordWrapEnabled(!wordWrapEnabled),
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.ITALIC,
        handler: handleToggleItalic,
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.CREATE_LINK,
        handler: handleCreateLink,
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.INSERT_TABLE,
        handler: handleInsertTable,
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.INSERT_THEMATIC_BREAK,
        handler: handleInsertThematicBreak,
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.INLINE_CODE,
        handler: handleToggleInlineCode,
        enabled: isEditing && !isSaving,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.CODE_BLOCK,
        handler: handleInsertCodeBlock,
        enabled: isEditing && !isSaving,
      },
      {
        ...COMMON_SHORTCUTS.CLOSE,
        handler: handleEscape,
        allowInInput: false,
        enabled: isEditing && !unsavedChangesDialogOpen,
      },
      {
        ...MARKDOWN_EDITOR_SHORTCUTS.SHOW_HELP,
        handler: handleShowEditorHelp,
        enabled: isEditing,
      },
    ],
    [
      editorSearchState.isSearchable,
      error,
      handleCreateLink,
      handleDownload,
      handleEscape,
      handleInsertCodeBlock,
      handleInsertTable,
      handleInsertThematicBreak,
      handleOpenSearch,
      handleOpenReplace,
      handleReplaceAll,
      handleReplaceCurrent,
      handleSave,
      handleSearchNext,
      handleSearchPrevious,
      handleShowEditorHelp,
      handleToggleBold,
      handleToggleInlineCode,
      handleToggleItalic,
      isEditing,
      isSaving,
      loading,
      editorSearchMode,
      editorSearchState.pending,
      editorSearchState.error,
      searchPanelOpen,
      searchMatches,
      setWordWrapEnabled,
      unsavedChangesDialogOpen,
      wordWrapEnabled,
    ]
  );

  const isSearchable = isEditing
    ? !editorFailed && editorLoadState === "loaded" && !editorLoadError && editorSearchState.isSearchable
    : !loading && !error && content.trim().length > 0;

  useKeyboardShortcuts({
    active: !showViewerHelp && !showEditorHelp,
    shortcuts: [...markdownViewerShortcuts, ...markdownEditorShortcuts],
    inputSelector: "input, textarea",
  });

  const toolbarActions = useMemo(
    () =>
      isEditing
        ? [
            createSaveToolbarAction({
              id: "save-markdown",
              onClick: () => {
                void handleSave();
              },
              isMobile,
              disabled: isSaving || editorLoadState !== "loaded" || !!editorLoadError,
            }),
          ]
        : [
            createPrintToolbarAction({
              id: "print-markdown",
              isMobile,
              disabled: loading || !!error,
              onClick: () => {
                setPrintError(false);
                try {
                  window.print();
                } catch (error) {
                  logError("Unable to open Markdown print dialog", { error });
                  setPrintError(true);
                }
              },
            }),
            ...(isReadOnly
              ? []
              : [
                  createEditToolbarAction({
                    id: "edit-markdown",
                    onClick: () => {
                      void handleEnterEditMode();
                    },
                    isMobile,
                    disabled: loading || !!error,
                  }),
                ]),
          ],
    [editorLoadError, editorLoadState, error, handleEnterEditMode, handleSave, isEditing, isMobile, isReadOnly, isSaving, loading]
  );

  // Log when markdown viewer opens
  useEffect(() => {
    logInfo("Markdown viewer opened", { filename, path });
  }, [filename, path]);

  // Cleanup when component unmounts
  useEffect(() => {
    return () => {
      logInfo("Markdown viewer closed");
      // Exit fullscreen if still active when component unmounts
      if (document.fullscreenElement) {
        document.exitFullscreen();
      }
    };
  }, []);

  const handleDialogClose = useCallback(
    (_event: unknown, reason: string) => {
      if (reason === "escapeKeyDown") {
        return;
      }

      void handleRequestClose();
    },
    [handleRequestClose]
  );

  return (
    <>
      {!isEditing && !loading && !error && <GlobalStyles styles={MARKDOWN_VIEWER_PRINT_STYLES} />}
      <Dialog
        data-markdown-print-viewer={!isEditing && !loading && !error ? "true" : undefined}
        inert={isTransitioning}
        open={true}
        onClose={handleDialogClose}
        maxWidth={false}
        fullScreen
        ref={dialogRef}
        disableEnforceFocus
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
              width: "100%",
              maxWidth: "100%",
              height: "100%",
              maxHeight: "100%",
              display: "flex",
              flexDirection: "column",
              backgroundColor: viewerBg,
            },
          },
        }}
      >
        <Box
          data-markdown-print-frame="true"
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
          {/* Markdown Controls Overlay */}
          <Box
            data-markdown-print-controls="true"
            sx={{
              flexShrink: 0,
              zIndex: 1,
            }}
          >
            <ViewerControls
              filename={filename}
              filenameAdornment={filenameAdornment}
              toolbarBackground={toolbarBg}
              toolbarText={toolbarText}
              actions={toolbarActions}
              toolbarAccessory={
                isEditing ? (
                  <HelpMenu
                    menuId="markdown-editor-help-menu"
                    onOpenHelp={handleShowEditorHelp}
                    onOpenDocumentation={handleOpenDocumentation}
                  />
                ) : undefined
              }
              config={{
                download: true,
                share: shareEnabled,
                search: true,
              }}
              onClose={() => {
                void handleRequestClose();
              }}
              search={{
                searchText: currentSearchText,
                onSearchChange: handleSearchChange,
                searchMatches,
                currentMatch: currentSearchMatch,
                onSearchNext: handleSearchNext,
                onSearchPrevious: handleSearchPrevious,
                searchPanelOpen,
                onSearchPanelToggle: handleSearchPanelToggle,
                onSearchClose: handleSearchClose,
                clearSearchOnClose: !isEditing,
                isSearchable,
                searchUnavailableTitle: isEditing ? t("viewer.edit.searchUnavailable") : undefined,
                hideSearchPanel: isEditing,
              }}
              onDownload={handleDownload}
              shareControl={
                <ViewerShareMenu
                  onFile={nativeSharing.shareFile}
                  onText={() =>
                    nativeSharing.shareText(() => (isEditing ? (editorRef.current?.getCanonicalMarkdown() ?? draftContent) : content))
                  }
                  fileDisabled={!nativeSharing.ready || isSaving}
                  filePreparing={nativeSharing.preparing}
                  textDisabled={loading || Boolean(error)}
                  disabled={nativeSharing.sharing}
                />
              }
            />
          </Box>

          {isEditing && (
            <CodeMirrorFindReplacePopover
              caseSensitive={editorSearchCaseSensitive}
              currentMatch={currentSearchMatch}
              disabled={isSaving || editorLoadState !== "loaded" || Boolean(editorLoadError) || editorFailed}
              focusTarget={editorSearchFocusTarget}
              isReplaceMode={editorSearchMode === "replace"}
              isSearchValid={editorSearchState.isValid}
              searchPending={editorSearchState.pending}
              searchError={editorSearchState.error}
              onCaseSensitiveChange={setEditorSearchCaseSensitive}
              onClose={() => closeSearchPanel({ preserveQuery: true, restoreEditorFocus: true })}
              onFindNext={handleSearchNext}
              onFindPrevious={handleSearchPrevious}
              onFocusHandled={() => setEditorSearchFocusTarget(null)}
              onRegexChange={setEditorSearchRegexp}
              onReplaceAll={handleReplaceAll}
              onReplaceChange={setEditorSearchReplaceText}
              onReplaceCurrent={handleReplaceCurrent}
              onSearchChange={handleSearchChange}
              onWholeWordChange={setEditorSearchWholeWord}
              open={searchPanelOpen}
              regex={editorSearchRegexp}
              replaceText={editorSearchReplaceText}
              searchMatches={searchMatches}
              searchText={editorSearchText}
              wholeWord={editorSearchWholeWord}
            />
          )}

          {editError && (
            <Alert severity="error" sx={{ m: 2, flexShrink: 0 }}>
              {editError}
            </Alert>
          )}

          {printError && (
            <Alert severity="error" sx={{ m: 2, flexShrink: 0 }}>
              {t("viewer.printError")}
            </Alert>
          )}

          {nativeSharing.failureDialog}

          {draftStorageWarning && (
            <Alert severity="warning" sx={{ m: 2, flexShrink: 0 }}>
              {draftStorageWarning}
            </Alert>
          )}

          {/* Markdown content area - flex grows to fill remaining space */}
          <Box
            ref={contentRef}
            data-testid="markdown-viewer-content"
            tabIndex={0}
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflowY: isEditing ? "hidden" : "auto",
              overflowX: "hidden",
              minHeight: 0,
              width: "100%",
              paddingBottom: "env(safe-area-inset-bottom, 0px)",
              backgroundColor: viewerBg,
              "&:focus": {
                outline: "none",
              },
            }}
          >
            {loading ? (
              <Box
                sx={{
                  display: "flex",
                  justifyContent: "center",
                  alignItems: "center",
                  height: "100%",
                }}
              >
                <CircularProgress />
              </Box>
            ) : error ? (
              <Box sx={{ p: 2 }}>
                <Alert severity="error">{error}</Alert>
              </Box>
            ) : isEditing ? (
              <Box
                sx={{
                  p: 0,
                  flex: 1,
                  minHeight: 0,
                  display: "flex",
                  overflow: "hidden",
                  "& .sambee-markdown-editor": {
                    flex: 1,
                    minHeight: 0,
                    [CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE]: muiTheme.spacing(CODEMIRROR_EDITOR_CONTENT_PADDING.xs),
                    [muiTheme.breakpoints.up("sm")]: {
                      [CODEMIRROR_EDITOR_HORIZONTAL_INSET_CSS_VARIABLE]: muiTheme.spacing(CODEMIRROR_EDITOR_CONTENT_PADDING.sm),
                    },
                  },
                  "& .sambee-markdown-editor .cm-content": {
                    pt: CODEMIRROR_EDITOR_CONTENT_PADDING,
                    pb: VIEWER_SCROLL_END_PADDING,
                  },
                }}
              >
                {editorLoadState === "loading" ? (
                  <Box
                    sx={{
                      display: "flex",
                      justifyContent: "center",
                      alignItems: "center",
                      height: "100%",
                    }}
                  >
                    <CircularProgress />
                  </Box>
                ) : editorLoadError ? (
                  <Box sx={{ display: "flex", flexDirection: "column", gap: 2, py: 2 }}>
                    <Alert severity="error">
                      <Box component="div" sx={{ fontWeight: 600, mb: 0.5 }}>
                        {t("viewer.edit.editorLoadTitle")}
                      </Box>
                      {t("viewer.edit.editorLoadMessage")}
                    </Alert>
                    <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
                      <Button variant="contained" onClick={handleRetryEditor}>
                        {t("viewer.edit.retryEditor")}
                      </Button>
                      <Button
                        variant="outlined"
                        onClick={() => {
                          void handleCancelEdit();
                        }}
                      >
                        {t("viewer.edit.returnToPreview")}
                      </Button>
                    </Box>
                  </Box>
                ) : EditorComponent ? (
                  <MarkdownEditorErrorBoundary
                    key={editorBoundaryKey}
                    title={t("viewer.edit.editorCrashTitle")}
                    description={t("viewer.edit.editorCrashMessage")}
                    retryLabel={t("viewer.edit.retryEditor")}
                    returnToPreviewLabel={t("viewer.edit.returnToPreview")}
                    onError={handleEditorCrashed}
                    onRetry={handleRetryEditor}
                    onReturnToPreview={() => {
                      void handleCancelEdit();
                    }}
                  >
                    <EditorComponent
                      ref={editorRef}
                      className="sambee-markdown-editor"
                      markdown={draftContent}
                      diffMarkdown={content}
                      theme={markdownEditorTheme}
                      lineWrapping={wordWrapEnabled}
                      onChange={handleEditorChange}
                      onUserEdit={handleEditorUserEdit}
                      ariaLabel={t("viewer.edit.editorLabel")}
                      autoFocus={true}
                      readOnly={editorShouldBeReadOnly || routedEditing.isExiting}
                      searchText={activeEditorSearchText}
                      searchOpen={searchPanelOpen}
                      searchAutoNavigate={editorSearchAutoNavigate}
                      searchCaseSensitive={editorSearchCaseSensitive}
                      onSearchStateChange={handleEditorSearchStateChange}
                      searchRegexp={editorSearchRegexp}
                      searchReplaceText={editorSearchReplaceText}
                      searchWholeWord={editorSearchWholeWord}
                    />
                  </MarkdownEditorErrorBoundary>
                ) : null}
              </Box>
            ) : (
              <Box
                key={previewRevision}
                data-markdown-search-root="true"
                data-markdown-preview-revision={previewRevision}
                style={getSyntaxVariables(muiTheme, linkColor)}
                sx={{
                  ...getMarkdownContentStyles(viewerText, linkColor, linkHoverColor),
                  "--sambee-search-other": searchHighlightColors.otherMatches,
                  "--sambee-search-current": searchHighlightColors.currentMatch,
                  "--sambee-search-foreground": viewerText,
                }}
              >
                <MarkdownPreview generation={previewGeneration} onExternalLink={focusViewerContent} />
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
        onClose={handleUnsavedChangesDialogClose}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            handleUnsavedChangesDialogClose();
          }
        }}
        title={t("viewer.edit.unsavedChangesTitle")}
        description={t("viewer.edit.unsavedChangesExitMessage")}
        maxWidth="xs"
        disableAutoFocus
        disableEnforceFocus
        disableRestoreFocus
        onTransitionEntered={handleUnsavedChangesDialogEntered}
        onTransitionExited={handleUnsavedChangesDialogExited}
        actions={
          <>
            <Button
              ref={unsavedChangesCancelButtonRef}
              onClick={handleUnsavedChangesDialogClose}
              disabled={isSaving}
              autoFocus
              variant="outlined"
              sx={settingsUtilityButtonSx}
            >
              {t("common.actions.cancel")}
            </Button>
            <Button onClick={() => void handleUnsavedChangesDiscard()} disabled={isSaving} color="error" variant="contained">
              {t("common.actions.discard")}
            </Button>
            <Button onClick={() => void handleUnsavedChangesSave()} disabled={isSaving} variant="contained">
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
        shortcuts={markdownViewerShortcuts}
        title={t("keyboardShortcutsHelp.titles.markdownViewer")}
      />
      <KeyboardShortcutsHelp
        open={showEditorHelp}
        onClose={() => setShowEditorHelp(false)}
        shortcuts={markdownEditorShortcuts}
        title={t("keyboardShortcutsHelp.titles.markdownEditor")}
      />
    </>
  );
};

export default memo(MarkdownViewer);
