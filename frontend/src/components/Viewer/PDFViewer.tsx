import { Visibility, VisibilityOff } from "@mui/icons-material";
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  Fade,
  IconButton,
  InputAdornment,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { animated, useSpring } from "@react-spring/web";
import { useDrag } from "@use-gesture/react";
import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { memo, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Document, Page, pdfjs } from "react-pdf";
import { PreviewUnavailableError } from "../../services/previewPolicy";
import "react-pdf/dist/Page/AnnotationLayer.css";
import "react-pdf/dist/Page/TextLayer.css";
import { BROWSER_SHORTCUTS, COMMON_SHORTCUTS, VIEWER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { checkIsTransientError, getTransientErrorMessage, useApiRetry } from "../../hooks/useApiRetry";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useViewerSharing } from "../../hooks/useViewerSharing";
import {
  type ContentProviderRegistry,
  invalidateViewerPdfDerivative,
  readViewerContent,
  readVirtualContent,
  useContentProviderRegistry,
  verifyViewerSourceAfterFailure,
} from "../../pages/FileBrowser/contentProviders";
import { error as logError } from "../../services/logger";
import { useSambeeTheme } from "../../theme";
import { getSearchHighlightColors } from "../../theme/commonStyles";
import { getViewerColors } from "../../theme/viewerStyles";
import { isApiError } from "../../types";
import { getApiErrorMessage } from "../../utils/apiErrors";
import {
  activateDomTextSearchMatch,
  applyDomTextSearchHighlights,
  clearDomTextSearchHighlights,
  DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE,
  DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR,
  type DomTextSearchMatch,
} from "../../utils/domTextSearch";
import type { ViewerComponentProps } from "../../utils/FileTypeRegistry";
import { blurActiveToolbarControl } from "../../utils/keyboardUtils";
import { createDisplayedShareFile, supportsNativeShare } from "../../utils/nativeShare";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { KeyboardShortcutsHelp } from "../KeyboardShortcutsHelp";
import { settingsUtilityButtonSx } from "../Settings/settingsButtonStyles";
import { ViewerControls, ViewerFilenameBadge } from "./ViewerControls";
import { downloadViewerBlob } from "./viewerContent";

const PDFJS_ASSET_BASE_URL = `${import.meta.env.BASE_URL}pdfjs/`;
pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const PDF_DOCUMENT_OPTIONS = {
  cMapPacked: true,
  cMapUrl: `${PDFJS_ASSET_BASE_URL}cmaps/`,
  iccUrl: `${PDFJS_ASSET_BASE_URL}iccs/`,
  standardFontDataUrl: `${PDFJS_ASSET_BASE_URL}standard_fonts/`,
  wasmUrl: `${PDFJS_ASSET_BASE_URL}wasm/`,
};

type ZoomMode = "fit-page" | "fit-width" | number;
type PdfSourceVariant = "original" | "normalized";
type PdfPasswordCallback = (password: string | null) => void;

const SWIPE_COMMIT_DISTANCE_RATIO = 0.22;
const SWIPE_COMMIT_VELOCITY = 0.5;
const SWIPE_EDGE_RESISTANCE = 0.2;
const SWIPE_SPRING_CONFIG = {
  tension: 320,
  friction: 32,
};
const CAROUSEL_CENTER_OFFSET = "-33.333333%";
const SCREEN_DERIVATIVE_ZOOM_PERCENT = 200;
const FULL_ROTATION_DEGREES = 360;
const PDF_LOADING_TEXT_DELAY_MS = 500;
const PDF_LOADING_PHASE_DELAY_MS = 2000;
const PDF_LOADING_SLOW_DELAY_MS = 5000;
const PDF_REVEAL_DURATION_MS = 160;
const PDF_LOADING_SPINNER_SIZE = 40;
const PDF_LOAD_CANCELED_MESSAGE = "PDF loading was canceled. You can still download the original file.";

type PdfLoadPhase = "downloading" | "parsing" | "rendering" | "ready" | "error";
type PdfLoadingStage = "spinner" | "loading" | "phase" | "slow";

interface ActivePdfLoad {
  connectionId: string;
  path: string;
  sourceVariant: PdfSourceVariant;
  loadAttempt: number;
  virtualSource: ViewerComponentProps["virtualSource"];
  contentProviders: ContentProviderRegistry;
  abortController: AbortController;
  cleanupTimeoutId: number | null;
}

function getPdfLoadPhaseMessage(phase: PdfLoadPhase): string {
  switch (phase) {
    case "parsing":
      return "Preparing PDF";
    case "rendering":
      return "Rendering page 1";
    default:
      return "Loading PDF";
  }
}

function normalizeRotation(rotation: number): number {
  return ((rotation % FULL_ROTATION_DEGREES) + FULL_ROTATION_DEGREES) % FULL_ROTATION_DEGREES;
}

function getScreenProfile(): { width: number; height: number; zoomPercent: number } {
  const pixelRatio = window.devicePixelRatio || 1;
  return {
    width: Math.min(16384, Math.max(320, Math.ceil(window.innerWidth * pixelRatio))),
    height: Math.min(16384, Math.max(320, Math.ceil(window.innerHeight * pixelRatio))),
    zoomPercent: SCREEN_DERIVATIVE_ZOOM_PERCENT,
  };
}

/**
 * Match location within extracted PDF text.
 */
interface MatchLocation {
  page: number;
  index: number;
  length: number;
}

interface PdfInternalLinkTarget {
  dest?: unknown;
  pageIndex?: number;
  pageNumber?: number;
}

/**
 * PDF Viewer Component
 * Displays PDF files with navigation, zoom, and search capabilities.
 * Uses react-pdf for client-side rendering to enable text search.
 * Fetches PDFs via API with authentication headers, then creates blob URLs.
 */
const PDFViewer: React.FC<ViewerComponentProps> = ({
  isTransitioning = false,
  connectionId,
  path,
  onClose,
  isReadOnly: connectionIsReadOnly = false,
  virtualSource,
}) => {
  const isReadOnly = connectionIsReadOnly || virtualSource !== undefined;
  const contentProviders = useContentProviderRegistry();
  const checkedDecodeLoadRef = useRef<ActivePdfLoad | null>(null);
  const { t } = useTranslation();
  const [numPages, setNumPages] = useState<number>(0);
  const [currentPage, setCurrentPage] = useState<number>(1);
  const [scale, setScale] = useState<ZoomMode>("fit-page");
  const [pdfUrl, setPdfUrl] = useState<string | null>(null);
  const [shareFile, setShareFile] = useState<File | null>(null);
  const [pdfLoadPhase, setPdfLoadPhase] = useState<PdfLoadPhase>("downloading");
  const [pdfLoadingStage, setPdfLoadingStage] = useState<PdfLoadingStage>("spinner");
  const [pdfLoadSession, setPdfLoadSession] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);
  const [pdfSourceVariant, setPdfSourceVariant] = useState<PdfSourceVariant>("original");
  const [documentFailure, setDocumentFailure] = useState<string | null>(null);
  const [pdfPasswordCallback, setPdfPasswordCallback] = useState<PdfPasswordCallback | null>(null);
  const [pdfPassword, setPdfPassword] = useState("");
  const pdfPasswordFormId = useId();
  const [showPdfPassword, setShowPdfPassword] = useState(false);
  const [searchText, setSearchText] = useState<string>("");
  const [currentMatch, setCurrentMatch] = useState<number>(0);
  const [containerWidth, setContainerWidth] = useState<number>(0);
  const [containerHeight, setContainerHeight] = useState<number>(0);
  const [pdfPageWidth, setPdfPageWidth] = useState<number>(612); // Default to US Letter
  const [pdfPageHeight, setPdfPageHeight] = useState<number>(792);
  const [userRotation, setUserRotation] = useState<number>(0); // 0, 90, 180, 270
  const [pageIntrinsicRotations, setPageIntrinsicRotations] = useState<Map<number, number>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pendingSwipePageRef = useRef<number | null>(null);
  const swipeTransitionIdRef = useRef(0);
  const numPagesRef = useRef(0);
  const searchHighlightsRef = useRef<DomTextSearchMatch[]>([]);
  const currentMatchRef = useRef(0);
  const matchLocationsRef = useRef<MatchLocation[]>([]);
  const pageTextsRef = useRef<Map<number, string>>(new Map());
  const searchedPageTextsRef = useRef<Map<number, string> | null>(null);
  const searchTextRef = useRef("");
  const pdfLoadPhaseRef = useRef<PdfLoadPhase>(pdfLoadPhase);
  const pdfLoadSessionRef = useRef(pdfLoadSession);
  const activePdfAbortControllerRef = useRef<AbortController | null>(null);
  const activePdfUrlRef = useRef<string | null>(null);
  const pendingPdfUrlReleaseTimeoutRef = useRef<number | null>(null);
  const activePdfLoadRef = useRef<ActivePdfLoad | null>(null);
  const pdfLoadCanceledRef = useRef(false);

  // Search state
  const [pageTexts, setPageTexts] = useState<Map<number, string>>(new Map());
  const [matchLocations, setMatchLocations] = useState<MatchLocation[]>([]);
  const [_extractingText, setExtractingText] = useState(false);
  const [searchPanelOpen, setSearchPanelOpen] = useState(false);
  const [isSearchable, setIsSearchable] = useState(true); // Assume searchable until proven otherwise
  const [showHelp, setShowHelp] = useState(false);
  const [renderedTextLayerPage, setRenderedTextLayerPage] = useState<number | null>(null);
  const [isSwipeTransitioning, setIsSwipeTransitioning] = useState(false);
  const [{ carouselX }, carouselApi] = useSpring(() => ({ carouselX: 0 }));
  const fetchWithRetry = useApiRetry();

  const { currentTheme } = useSambeeTheme();
  const muiTheme = useTheme();
  const searchHighlightColors = useMemo(() => getSearchHighlightColors(muiTheme, currentTheme), [currentTheme, muiTheme]);
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const revealDuration = prefersReducedMotion ? 0 : PDF_REVEAL_DURATION_MS;
  const swipeNavigationEnabled = isMobile && scale === "fit-page" && userRotation % 180 === 0;
  const shareEnabled = isMobile && supportsNativeShare();
  const nativeSharing = useViewerSharing({
    entryPoint: "pdf",
    identity: `${connectionId}:${path}:${pdfSourceVariant}`,
    enabled: shareEnabled,
    file: pdfLoadPhase === "ready" ? shareFile : null,
    source: pdfSourceVariant === "normalized" ? "displayed-derivative" : "displayed-original",
  });
  const { viewerBg, toolbarBg, toolbarText } = getViewerColors(currentTheme, "pdf");
  const readOnlyIndicator = isReadOnly ? (
    <ViewerFilenameBadge label={t("settings.connectionDialog.accessMode.readOnlyLabel")} toolbarText={toolbarText} />
  ) : null;

  // Extract filename from path
  const filename = path.split("/").pop() || path;

  const isPdfLoading = pdfLoadPhase !== "ready" && pdfLoadPhase !== "error";

  useEffect(() => {
    if (pendingPdfUrlReleaseTimeoutRef.current !== null) {
      window.clearTimeout(pendingPdfUrlReleaseTimeoutRef.current);
      pendingPdfUrlReleaseTimeoutRef.current = null;
    }

    return () => {
      const activePdfUrl = activePdfUrlRef.current;
      if (!activePdfUrl || pendingPdfUrlReleaseTimeoutRef.current !== null) {
        return;
      }

      pendingPdfUrlReleaseTimeoutRef.current = window.setTimeout(() => {
        pendingPdfUrlReleaseTimeoutRef.current = null;
        if (activePdfUrlRef.current === activePdfUrl) {
          activePdfUrlRef.current = null;
          URL.revokeObjectURL(activePdfUrl);
        }
      }, 0);
    };
  }, []);

  useEffect(() => {
    pdfLoadPhaseRef.current = pdfLoadPhase;
  }, [pdfLoadPhase]);

  useEffect(() => {
    const loadingSession = pdfLoadSession;
    pdfLoadSessionRef.current = loadingSession;
    setPdfLoadingStage("spinner");

    const updateLoadingStage = (stage: PdfLoadingStage) => {
      if (pdfLoadSessionRef.current === loadingSession && pdfLoadPhaseRef.current !== "ready" && pdfLoadPhaseRef.current !== "error") {
        setPdfLoadingStage(stage);
      }
    };

    const loadingTimer = window.setTimeout(() => updateLoadingStage("loading"), PDF_LOADING_TEXT_DELAY_MS);
    const phaseTimer = window.setTimeout(() => updateLoadingStage("phase"), PDF_LOADING_PHASE_DELAY_MS);
    const slowTimer = window.setTimeout(() => updateLoadingStage("slow"), PDF_LOADING_SLOW_DELAY_MS);

    return () => {
      window.clearTimeout(loadingTimer);
      window.clearTimeout(phaseTimer);
      window.clearTimeout(slowTimer);
    };
  }, [pdfLoadSession]);

  const cancelSwipeTransition = useCallback(() => {
    swipeTransitionIdRef.current += 1;
    pendingSwipePageRef.current = null;
    carouselApi.stop();
    carouselApi.set({ carouselX: 0 });
    setIsSwipeTransitioning(false);
  }, [carouselApi]);

  const disposePdfLoad = useCallback((load: ActivePdfLoad) => {
    if (load.cleanupTimeoutId !== null) {
      window.clearTimeout(load.cleanupTimeoutId);
      load.cleanupTimeoutId = null;
    }
    load.abortController.abort();
    if (activePdfAbortControllerRef.current === load.abortController) {
      activePdfAbortControllerRef.current = null;
    }
    if (activePdfLoadRef.current === load) {
      activePdfLoadRef.current = null;
    }
  }, []);

  const schedulePdfLoadDisposal = useCallback(
    (load: ActivePdfLoad) => {
      if (load.cleanupTimeoutId !== null) {
        return;
      }
      load.cleanupTimeoutId = window.setTimeout(() => disposePdfLoad(load), 0);
    },
    [disposePdfLoad]
  );

  // Rotation handlers
  const handleRotateLeft = useCallback((_event?: KeyboardEvent) => {
    setUserRotation((rotation) => normalizeRotation(rotation - 90));
  }, []);

  const handleRotateRight = useCallback((_event?: KeyboardEvent) => {
    setUserRotation((rotation) => normalizeRotation(rotation + 90));
  }, []);

  // Fetch PDF via API with auth header, then create blob URL
  useEffect(() => {
    const previousLoad = activePdfLoadRef.current;
    if (previousLoad && previousLoad.cleanupTimeoutId !== null) {
      window.clearTimeout(previousLoad.cleanupTimeoutId);
      previousLoad.cleanupTimeoutId = null;
    }

    const reusesActiveLoad =
      previousLoad !== null &&
      previousLoad.connectionId === connectionId &&
      previousLoad.path === path &&
      previousLoad.sourceVariant === pdfSourceVariant &&
      previousLoad.loadAttempt === loadAttempt &&
      previousLoad.virtualSource === virtualSource &&
      previousLoad.contentProviders === contentProviders;
    if (reusesActiveLoad && previousLoad) {
      return () => schedulePdfLoadDisposal(previousLoad);
    }

    if (previousLoad) {
      disposePdfLoad(previousLoad);
    }

    const abortController = new AbortController();
    const activeLoad: ActivePdfLoad = {
      connectionId,
      path,
      sourceVariant: pdfSourceVariant,
      loadAttempt,
      virtualSource,
      contentProviders,
      abortController,
      cleanupTimeoutId: null,
    };
    activePdfLoadRef.current = activeLoad;
    activePdfAbortControllerRef.current = abortController;

    const fetchPdf = async () => {
      try {
        cancelSwipeTransition();
        pdfLoadCanceledRef.current = false;
        setPdfLoadPhase("downloading");
        setPdfLoadingStage("spinner");
        const nextPdfLoadSession = pdfLoadSessionRef.current + 1;
        pdfLoadSessionRef.current = nextPdfLoadSession;
        setPdfLoadSession(nextPdfLoadSession);
        setError(null);
        setShareFile(null);
        const previousPdfUrl = activePdfUrlRef.current;
        activePdfUrlRef.current = null;
        setPdfUrl(null);
        if (previousPdfUrl) {
          window.setTimeout(() => URL.revokeObjectURL(previousPdfUrl), 0);
        }
        numPagesRef.current = 0;
        setNumPages(0);
        setCurrentPage(1);
        setRenderedTextLayerPage(null);
        setPageIntrinsicRotations(new Map());
        pageTextsRef.current = new Map();
        searchedPageTextsRef.current = null;
        setPageTexts(new Map());
        matchLocationsRef.current = [];
        currentMatchRef.current = 0;
        setMatchLocations([]);
        setCurrentMatch(0);

        const blob = await fetchWithRetry(
          () =>
            readViewerContent(
              connectionId,
              path,
              pdfSourceVariant === "normalized"
                ? { kind: "pdf", variant: "normalized", screenProfile: getScreenProfile() }
                : { kind: "pdf" },
              { signal: abortController.signal, virtualSource },
              contentProviders
            ),
          {
            signal: abortController.signal,
            maxRetries: 1,
            retryDelay: 1000,
          }
        );

        if (!blob || blob.size === 0) {
          throw new Error("Received empty PDF blob");
        }

        if (activePdfLoadRef.current !== activeLoad || abortController.signal.aborted) return;

        const blobUrl = URL.createObjectURL(blob);
        activePdfUrlRef.current = blobUrl;
        setPdfUrl(blobUrl);
        setShareFile(createDisplayedShareFile(blob, filename));
        setPdfLoadPhase("parsing");
      } catch (err) {
        if (activePdfLoadRef.current !== activeLoad || abortController.signal.aborted) return;

        // Show "server busy" only for actual transient/network errors
        const errorMessage = checkIsTransientError(err)
          ? getTransientErrorMessage()
          : getApiErrorMessage(err, "Failed to load PDF", { includeOriginalMessage: true });

        logError("Failed to fetch PDF", {
          path,
          error: err,
          detail: isApiError(err) ? err.response?.data?.detail : undefined,
          status: isApiError(err) ? err.response?.status : undefined,
        });
        setError(
          err instanceof PreviewUnavailableError
            ? err.message
            : pdfSourceVariant === "normalized"
              ? "PDF compatibility processing could not make this file viewable. You can still download the original file."
              : errorMessage
        );
        setPdfLoadPhase("error");
      }
    };

    fetchPdf();

    return () => {
      schedulePdfLoadDisposal(activeLoad);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    connectionId,
    path,
    fetchWithRetry,
    filename,
    cancelSwipeTransition,
    loadAttempt,
    pdfSourceVariant,
    virtualSource,
    contentProviders,
    disposePdfLoad,
    schedulePdfLoadDisposal,
  ]);

  const handleRetryLoad = useCallback(() => {
    setPdfSourceVariant("original");
    setDocumentFailure(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const handleCompatibilityRetry = useCallback(() => {
    setPdfSourceVariant("normalized");
    setDocumentFailure(null);
    setError(null);
    setLoadAttempt((attempt) => attempt + 1);
  }, []);

  const handleDocumentPassword = useCallback((callback: PdfPasswordCallback) => {
    setPdfPassword("");
    setShowPdfPassword(false);
    setPdfPasswordCallback(() => callback);
  }, []);

  const handlePdfPasswordSubmit = useCallback(() => {
    if (!pdfPasswordCallback || !pdfPassword) {
      return;
    }
    pdfPasswordCallback(pdfPassword);
    setPdfPassword("");
    setShowPdfPassword(false);
    setPdfPasswordCallback(null);
  }, [pdfPassword, pdfPasswordCallback]);

  const handlePdfPasswordCancel = useCallback(() => {
    pdfPasswordCallback?.(null);
    setPdfPassword("");
    setShowPdfPassword(false);
    setPdfPasswordCallback(null);
    setError("This PDF is password-protected. Download the original file to open it elsewhere.");
  }, [pdfPasswordCallback]);

  // Measure container dimensions with ResizeObserver
  // Trigger after PDF loads to ensure container is in DOM
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfUrl) {
      return;
    }

    const resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect;
        setContainerWidth(width);
        setContainerHeight(height);
      }
    });

    resizeObserver.observe(container);

    return () => {
      resizeObserver.disconnect();
    };
  }, [pdfUrl]);

  // Auto-focus content area after load for keyboard navigation
  // Skip if search panel is open to avoid stealing focus from search input
  useEffect(() => {
    if (isPdfLoading || error || searchPanelOpen || !containerRef.current) {
      return;
    }

    containerRef.current.focus();
  }, [isPdfLoading, error, searchPanelOpen]);

  // Calculate page scale based on zoom mode
  const { pageScale, pageWidth } = useMemo(() => {
    if (scale === "fit-page") {
      // Wait for container dimensions to be measured
      if (containerWidth === 0 || containerHeight === 0) {
        return {
          pageScale: 1.0,
          pageWidth: undefined,
        };
      }

      // Fit entire page in viewport (like object-fit: contain)
      const widthRatio = containerWidth / pdfPageWidth;
      const heightRatio = containerHeight / pdfPageHeight;
      const finalScale = Math.min(widthRatio, heightRatio);

      return {
        pageScale: finalScale,
        pageWidth: undefined,
      };
    }

    if (scale === "fit-width") {
      // Fit width, allow vertical scrolling - use full container width
      return {
        pageScale: undefined,
        pageWidth: Math.max(100, containerWidth),
      };
    }

    // Numeric zoom level
    return {
      pageScale: scale,
      pageWidth: undefined,
    };
  }, [scale, containerWidth, containerHeight, pdfPageWidth, pdfPageHeight]);

  // Handle document load success
  const handleDocumentLoadSuccess = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: PDF.js document type not fully typed
    (pdf: any) => {
      if (pdfLoadCanceledRef.current) {
        return;
      }

      numPagesRef.current = pdf.numPages;
      setNumPages(pdf.numPages);
      setCurrentPage(1);
      setPdfLoadPhase("rendering");

      // Extract text from all pages for search functionality
      const extractAllText = async () => {
        setExtractingText(true);
        const texts = new Map<number, string>();
        let hasText = false;

        try {
          for (let i = 1; i <= pdf.numPages; i++) {
            const page = await pdf.getPage(i);
            const textContent = await page.getTextContent();

            // Match PDF.js text-layer semantics: adjacent items form one text
            // stream, while hasEOL becomes a line break in the rendered layer.
            let fullText = "";

            for (const textItem of textContent.items) {
              // biome-ignore lint/suspicious/noExplicitAny: PDF.js text item type not fully typed
              const item = textItem as any;
              fullText += item.str;
              if (item.hasEOL) {
                fullText += "\n";
              }
            }

            texts.set(i, fullText);

            // Check if this page has any non-whitespace text
            if (fullText.trim().length > 0) {
              hasText = true;
            }
          }

          pageTextsRef.current = texts;
          setPageTexts(texts);
          setIsSearchable(hasText);

          if (!hasText) {
            logError("PDF contains no extractable text - search disabled", {
              message: "This PDF may be a scanned image without OCR text layer",
            });
          }
        } catch (err) {
          logError("Failed to extract text from PDF", { error: err });
          setIsSearchable(false);
        } finally {
          setExtractingText(false);
        }
      };

      extractAllText();
    },
    []
  );

  // Handle document load error
  const handleDocumentLoadError = useCallback(
    async (err: Error) => {
      logError("PDF load error", { error: err.message });
      if (pdfLoadCanceledRef.current) {
        return;
      }

      const activeLoad = activePdfLoadRef.current;
      if (activeLoad && checkedDecodeLoadRef.current === activeLoad) return;
      if (activeLoad && checkedDecodeLoadRef.current !== activeLoad) {
        checkedDecodeLoadRef.current = activeLoad;
        const sourceFailure = await verifyViewerSourceAfterFailure(
          connectionId,
          path,
          virtualSource,
          contentProviders,
          () => activePdfLoadRef.current === activeLoad && !pdfLoadCanceledRef.current,
          activeLoad.abortController.signal
        );
        if (activePdfLoadRef.current !== activeLoad || activeLoad.abortController.signal.aborted || pdfLoadCanceledRef.current) return;
        if (sourceFailure) {
          setDocumentFailure(sourceFailure);
          setError(sourceFailure);
          setPdfLoadPhase("error");
          return;
        }
      }

      const failureMessage = getApiErrorMessage(err, "Failed to load PDF", { includeOriginalMessage: true });

      if (/password|encrypted/i.test(err.message)) {
        setPdfLoadPhase("error");
        setDocumentFailure(failureMessage);
        setError("This PDF is password-protected. Download the original file to open it elsewhere.");
        return;
      }

      if (pdfSourceVariant === "original" && /InvalidPDFException|Invalid PDF structure/i.test(err.message)) {
        setPdfLoadPhase("downloading");
        setPdfSourceVariant("normalized");
        setDocumentFailure(null);
        setLoadAttempt((attempt) => attempt + 1);
        return;
      }

      if (pdfSourceVariant === "normalized") {
        void invalidateViewerPdfDerivative(connectionId, path, getScreenProfile(), virtualSource, contentProviders).catch(
          (invalidationError: unknown) => {
            logError("Failed to invalidate PDF compatibility derivative", { error: invalidationError, path });
          }
        );
      }
      setDocumentFailure(failureMessage);
      setError(
        pdfSourceVariant === "normalized"
          ? "PDF compatibility processing could not make this file viewable. You can still download the original file."
          : failureMessage
      );
      setPdfLoadPhase("error");
    },
    [connectionId, contentProviders, path, pdfSourceVariant, virtualSource]
  );

  const handlePageRenderError = useCallback(
    (err: Error) => {
      logError("PDF page render error", { error: err.message });
      if (pdfLoadCanceledRef.current) {
        return;
      }

      setPdfLoadPhase("error");
      const failureMessage = getApiErrorMessage(err, "Failed to render PDF page", { includeOriginalMessage: true });
      if (pdfSourceVariant === "normalized") {
        void invalidateViewerPdfDerivative(connectionId, path, getScreenProfile(), virtualSource, contentProviders).catch(
          (invalidationError: unknown) => {
            logError("Failed to invalidate PDF compatibility derivative", { error: invalidationError, path });
          }
        );
      }
      setDocumentFailure(failureMessage);
      setError(
        pdfSourceVariant === "normalized"
          ? "PDF compatibility processing could not make this file viewable. You can still download the original file."
          : failureMessage
      );
    },
    [connectionId, contentProviders, path, pdfSourceVariant, virtualSource]
  );

  const handlePageLoadSuccess = useCallback(
    // biome-ignore lint/suspicious/noExplicitAny: PDF.js page type not fully typed
    (pageNumber: number, isActive: boolean, page: any) => {
      const intrinsicRotation = normalizeRotation(page.rotate ?? 0);
      const effectiveRotation = normalizeRotation(intrinsicRotation + userRotation);
      setPageIntrinsicRotations((rotations) => {
        if (rotations.get(pageNumber) === intrinsicRotation) {
          return rotations;
        }
        const nextRotations = new Map(rotations);
        nextRotations.set(pageNumber, intrinsicRotation);
        return nextRotations;
      });

      if (!isActive) {
        return;
      }

      const viewport = page.getViewport({ scale: 1.0, rotation: effectiveRotation });
      setPdfPageWidth((width) => (width === viewport.width ? width : viewport.width));
      setPdfPageHeight((height) => (height === viewport.height ? height : viewport.height));
    },
    [userRotation]
  );

  const handleActiveTextLayerRenderSuccess = useCallback(() => {
    setRenderedTextLayerPage(currentPage);
  }, [currentPage]);

  const handleInitialPageRenderSuccess = useCallback(
    (pageNumber: number, isActive: boolean) => {
      if (isActive && pageNumber === currentPage) {
        setPdfLoadPhase("ready");
      }
    },
    [currentPage]
  );

  // Page navigation
  const handlePageChange = useCallback(
    (page: number, preserveSwipeTransition = false) => {
      if (!preserveSwipeTransition) {
        cancelSwipeTransition();
      }

      const totalPages = numPagesRef.current;

      if (page >= 1 && page <= totalPages) {
        if (page !== currentPage) {
          setRenderedTextLayerPage(null);
          setCurrentPage(page);
        }
      }
    },
    [cancelSwipeTransition, currentPage]
  );

  useEffect(() => {
    if (!swipeNavigationEnabled) {
      cancelSwipeTransition();
    }
  }, [cancelSwipeTransition, swipeNavigationEnabled]);

  useLayoutEffect(() => {
    if (pendingSwipePageRef.current !== currentPage) {
      return;
    }

    carouselApi.set({ carouselX: 0 });
    pendingSwipePageRef.current = null;
    setIsSwipeTransitioning(false);
  }, [carouselApi, currentPage]);

  const bindSwipeDrag = useDrag(
    ({ active, movement: [movementX], velocity: [velocityX] }) => {
      if (!swipeNavigationEnabled || isSwipeTransitioning || containerWidth === 0) {
        return;
      }

      if (active) {
        const pageDelta = movementX < 0 ? 1 : -1;
        const targetPage = currentPage + pageDelta;
        const resistance = targetPage < 1 || targetPage > numPages ? SWIPE_EDGE_RESISTANCE : 1;

        carouselApi.start({
          carouselX: movementX * resistance,
          immediate: true,
        });
        return;
      }

      const pageDelta = movementX < 0 ? 1 : -1;
      const targetPage = currentPage + pageDelta;
      const hasTargetPage = targetPage >= 1 && targetPage <= numPages;
      const hasReachedDistanceThreshold = Math.abs(movementX) >= containerWidth * SWIPE_COMMIT_DISTANCE_RATIO;
      const hasReachedVelocityThreshold = Math.abs(velocityX) >= SWIPE_COMMIT_VELOCITY;

      if (hasTargetPage && (hasReachedDistanceThreshold || hasReachedVelocityThreshold)) {
        const transitionId = swipeTransitionIdRef.current + 1;
        swipeTransitionIdRef.current = transitionId;
        pendingSwipePageRef.current = targetPage;
        setIsSwipeTransitioning(true);
        carouselApi.start({
          carouselX: -pageDelta * containerWidth,
          config: {
            ...SWIPE_SPRING_CONFIG,
            velocity: -pageDelta * velocityX,
          },
          onRest: () => {
            if (swipeTransitionIdRef.current === transitionId) {
              handlePageChange(targetPage, true);
            }
          },
        });
        return;
      }

      carouselApi.start({
        carouselX: 0,
        config: SWIPE_SPRING_CONFIG,
      });
    },
    {
      axis: "x",
      enabled: swipeNavigationEnabled && !isSwipeTransitioning,
      filterTaps: true,
      pointer: { capture: false },
    }
  );

  const renderPdfPage = (pageNumber: number, isActive: boolean) => {
    const intrinsicRotation = pageIntrinsicRotations.get(pageNumber);
    const effectiveRotation = intrinsicRotation === undefined ? undefined : normalizeRotation(intrinsicRotation + userRotation);

    return (
      <div key={pageNumber} style={{ position: "relative", display: "inline-block" }} data-page-number={isActive ? pageNumber : undefined}>
        <Page
          pageNumber={pageNumber}
          scale={pageScale || undefined}
          width={pageWidth || undefined}
          rotate={effectiveRotation}
          renderTextLayer={isActive}
          renderAnnotationLayer={isActive}
          loading={null}
          onLoadSuccess={(page) => handlePageLoadSuccess(pageNumber, isActive, page)}
          onRenderError={isActive ? handlePageRenderError : undefined}
          onRenderSuccess={isActive ? () => handleInitialPageRenderSuccess(pageNumber, isActive) : undefined}
          onRenderTextLayerSuccess={isActive ? handleActiveTextLayerRenderSuccess : undefined}
        />
      </div>
    );
  };

  const handleInternalLinkNavigation = useCallback(
    ({ dest, pageIndex, pageNumber }: PdfInternalLinkTarget) => {
      const totalPages = numPagesRef.current;
      const resolvedPageNumber =
        typeof pageNumber === "number" && Number.isInteger(pageNumber)
          ? pageNumber
          : typeof pageIndex === "number" && Number.isInteger(pageIndex)
            ? pageIndex + 1
            : null;

      if (resolvedPageNumber === null || resolvedPageNumber < 1 || resolvedPageNumber > totalPages) {
        logError("Failed to resolve internal PDF link target", {
          dest,
          pageIndex,
          pageNumber,
          numPages: totalPages,
        });
        return;
      }

      handlePageChange(resolvedPageNumber);
    },
    [handlePageChange]
  );

  // Zoom controls
  const handleScaleChange = useCallback((newScale: ZoomMode) => {
    setScale(newScale);
  }, []);

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

  const releasePdfUrl = useCallback(() => {
    if (activePdfUrlRef.current) {
      URL.revokeObjectURL(activePdfUrlRef.current);
      activePdfUrlRef.current = null;
    }
  }, []);

  const handleCancelPdfLoad = useCallback(() => {
    pdfLoadCanceledRef.current = true;
    const nextPdfLoadSession = pdfLoadSessionRef.current + 1;
    pdfLoadSessionRef.current = nextPdfLoadSession;
    setPdfLoadSession(nextPdfLoadSession);
    const activeLoad = activePdfLoadRef.current;
    if (activeLoad) {
      disposePdfLoad(activeLoad);
    } else {
      activePdfAbortControllerRef.current?.abort();
      activePdfAbortControllerRef.current = null;
    }

    releasePdfUrl();

    setPdfUrl(null);
    setShareFile(null);
    setDocumentFailure(null);
    setPdfLoadPhase("error");
    setError(PDF_LOAD_CANCELED_MESSAGE);
  }, [disposePdfLoad, releasePdfUrl]);

  /**
   * Perform search across all extracted page texts using simple regex approach.
   * Finds matches and stores reference to containing text item for positioning.
   */
  const performSearch = useCallback(
    (query: string) => {
      const extractedPageTexts = pageTextsRef.current;
      if (!query.trim() || extractedPageTexts.size === 0) {
        matchLocationsRef.current = [];
        currentMatchRef.current = 0;
        setMatchLocations([]);
        setCurrentMatch(0);
        return;
      }

      // Escape regex special characters
      const escapedQuery = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const regex = new RegExp(escapedQuery, "gi");
      const matches: MatchLocation[] = [];

      // Search through all pages
      for (let pageNum = 1; pageNum <= numPagesRef.current; pageNum++) {
        const fullText = extractedPageTexts.get(pageNum);
        if (!fullText) continue;

        let match: RegExpExecArray | null;
        // biome-ignore lint/suspicious/noAssignInExpressions: Standard regex iteration pattern
        while ((match = regex.exec(fullText)) !== null) {
          matches.push({
            page: pageNum,
            index: match.index,
            length: match[0].length,
          });
        }
      }

      matchLocationsRef.current = matches;
      setMatchLocations(matches);

      // Navigate to first match if any found
      if (matches.length > 0) {
        currentMatchRef.current = 1;
        setCurrentMatch(1);
        if (matches[0]) {
          handlePageChange(matches[0].page);
        }
      } else {
        currentMatchRef.current = 0;
        setCurrentMatch(0);
      }
    },
    [handlePageChange]
  );

  useEffect(() => {
    if (pageTexts.size === 0 || searchedPageTextsRef.current === pageTexts) {
      return;
    }

    searchedPageTextsRef.current = pageTexts;
    const query = searchTextRef.current;
    if (query.trim()) {
      performSearch(query);
    }
  }, [pageTexts, performSearch]);

  // Debounced search handler
  const searchTimeoutRef = useRef<number | null>(null);

  const handleSearchChange = useCallback(
    (text: string) => {
      searchTextRef.current = text;
      setSearchText(text);

      // Clear existing timeout
      if (searchTimeoutRef.current) {
        clearTimeout(searchTimeoutRef.current);
      }

      // Debounce search by 300ms
      searchTimeoutRef.current = window.setTimeout(() => {
        performSearch(text);
      }, 300);
    },
    [performSearch]
  );

  // Search matches count is simply the total from extracted text
  const searchMatches = matchLocations.length;

  const handleSearchNext = useCallback(
    (_event?: KeyboardEvent) => {
      const latestMatchLocations = matchLocationsRef.current;
      if (latestMatchLocations.length === 0) return;

      const nextMatch = currentMatchRef.current >= latestMatchLocations.length ? 1 : currentMatchRef.current + 1;
      currentMatchRef.current = nextMatch;
      setCurrentMatch(nextMatch);
      const nextLocation = latestMatchLocations[nextMatch - 1];
      if (nextLocation) {
        handlePageChange(nextLocation.page);
      }
    },
    [handlePageChange]
  );

  const handleSearchPrevious = useCallback(
    (_event?: KeyboardEvent) => {
      const latestMatchLocations = matchLocationsRef.current;
      if (latestMatchLocations.length === 0) return;

      const prevMatch = currentMatchRef.current <= 1 ? latestMatchLocations.length : currentMatchRef.current - 1;
      currentMatchRef.current = prevMatch;
      setCurrentMatch(prevMatch);
      const prevLocation = latestMatchLocations[prevMatch - 1];
      if (prevLocation) {
        handlePageChange(prevLocation.page);
      }
    },
    [handlePageChange]
  );

  const getCurrentPageMatchIndex = useCallback(() => {
    if (currentMatch <= 0) {
      return 0;
    }

    const activeMatch = matchLocations[currentMatch - 1];
    if (!activeMatch || activeMatch.page !== currentPage) {
      return 0;
    }

    let pageMatchIndex = 0;
    for (let index = 0; index < currentMatch; index += 1) {
      if (matchLocations[index]?.page === currentPage) {
        pageMatchIndex += 1;
      }
    }

    return pageMatchIndex;
  }, [currentMatch, currentPage, matchLocations]);

  // Rebuild highlights after react-pdf reports the active text layer is ready.
  useEffect(() => {
    const textLayers = document.querySelectorAll(".react-pdf__Page__textContent");
    for (const layer of textLayers) {
      clearDomTextSearchHighlights(layer);
    }
    searchHighlightsRef.current = [];

    if (!searchText.trim() || matchLocations.length === 0 || renderedTextLayerPage !== currentPage) {
      return;
    }

    const pageContainer = document.querySelector(`[data-page-number="${currentPage}"]`);
    if (!pageContainer) {
      return;
    }

    const textLayer = pageContainer.querySelector(".react-pdf__Page__textContent");
    if (!(textLayer instanceof HTMLElement) || !textLayer.textContent?.trim()) {
      return;
    }

    const highlights = applyDomTextSearchHighlights(textLayer, searchText);
    searchHighlightsRef.current = highlights;
    activateDomTextSearchMatch(highlights, getCurrentPageMatchIndex());

    return () => {
      clearDomTextSearchHighlights(textLayer);
      searchHighlightsRef.current = [];
    };
  }, [currentPage, getCurrentPageMatchIndex, matchLocations, renderedTextLayerPage, searchText]);

  useEffect(() => {
    activateDomTextSearchMatch(searchHighlightsRef.current, getCurrentPageMatchIndex());
  }, [getCurrentPageMatchIndex]);

  // Keyboard shortcuts - centralized configuration
  const handleOpenSearch = useCallback((_event?: KeyboardEvent) => {
    setSearchPanelOpen(true);
    // Focus will be handled by ViewerControls via ref
  }, []);

  const handleZoomIn = useCallback(
    (_event?: KeyboardEvent) => {
      if (typeof scale === "number") {
        handleScaleChange(scale + 0.25);
      } else {
        const currentScale = pageScale || 1.0;
        handleScaleChange(currentScale + 0.25);
      }
    },
    [scale, pageScale, handleScaleChange]
  );

  const handleZoomOut = useCallback(
    (_event?: KeyboardEvent) => {
      if (typeof scale === "number") {
        handleScaleChange(Math.max(scale - 0.25, 0.1));
      } else {
        const currentScale = pageScale || 1.0;
        handleScaleChange(Math.max(currentScale - 0.25, 0.1));
      }
    },
    [scale, pageScale, handleScaleChange]
  );

  const handleZoomReset = useCallback((_event?: KeyboardEvent) => {
    setScale("fit-page");
  }, []);

  const handleToggleFullscreen = useCallback((_event?: KeyboardEvent) => {
    if (!dialogRef.current) return;

    if (!document.fullscreenElement) {
      dialogRef.current.requestFullscreen().catch((err) => {
        logError(`Error attempting to enable fullscreen: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  }, []);

  /**
   * Context-aware Escape action shared by the shortcut and dialog handlers.
   * - If search panel is open: close search and clear results
   * - Otherwise: close the entire viewer
   */
  const handleEscape = useCallback(
    (_event?: KeyboardEvent) => {
      if (searchPanelOpen) {
        setSearchPanelOpen(false);
        // Clear search results and highlights when closing search panel
        setSearchText("");
        matchLocationsRef.current = [];
        currentMatchRef.current = 0;
        setMatchLocations([]);
        setCurrentMatch(0);
      } else {
        releasePdfUrl();
        onClose();
      }
    },
    [searchPanelOpen, onClose, releasePdfUrl]
  );

  /**
   * Handles Escape not already consumed by a capture-phase shortcut or child.
   * 1. If a toolbar button/input has focus → blur it (hide focus ring)
   * 2. If search panel is open → close search and clear results
   * 3. Otherwise → close the viewer
   */
  const handlePaperKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (blurActiveToolbarControl(containerRef)) return;
      handleEscape();
    },
    [handleEscape]
  );

  const handleShowHelp = useCallback(() => {
    setShowHelp(true);
  }, []);

  const pdfShortcuts = useMemo(
    () => [
      // Download
      {
        ...COMMON_SHORTCUTS.DOWNLOAD,
        handler: handleDownload,
      },
      // Search
      {
        ...COMMON_SHORTCUTS.SEARCH,
        handler: handleOpenSearch,
      },
      {
        ...COMMON_SHORTCUTS.NEXT_MATCH,
        handler: handleSearchNext,
      },
      {
        ...COMMON_SHORTCUTS.PREVIOUS_MATCH,
        handler: handleSearchPrevious,
      },
      // Navigation
      {
        ...COMMON_SHORTCUTS.NEXT_ARROW,
        description: "Next page",
        handler: () => handlePageChange(currentPage + 1),
        enabled: numPages > 1 && currentPage < numPages,
      },
      {
        ...COMMON_SHORTCUTS.PREVIOUS_ARROW,
        description: "Previous page",
        handler: () => handlePageChange(currentPage - 1),
        enabled: numPages > 1 && currentPage > 1,
      },
      {
        ...COMMON_SHORTCUTS.FIRST_PAGE,
        handler: () => handlePageChange(1),
        allowInInput: true,
        enabled: numPages > 1,
      },
      {
        ...COMMON_SHORTCUTS.LAST_PAGE,
        handler: () => handlePageChange(numPages),
        allowInInput: true,
        enabled: numPages > 1,
      },
      {
        ...COMMON_SHORTCUTS.PAGE_DOWN,
        handler: () => handlePageChange(currentPage + 1),
        allowInInput: true,
        enabled: currentPage < numPages,
      },
      {
        ...COMMON_SHORTCUTS.PAGE_UP,
        handler: () => handlePageChange(currentPage - 1),
        allowInInput: true,
        enabled: currentPage > 1,
      },
      // Zoom
      {
        ...VIEWER_SHORTCUTS.ZOOM_IN,
        handler: handleZoomIn,
      },
      {
        ...VIEWER_SHORTCUTS.ZOOM_OUT,
        handler: handleZoomOut,
      },
      {
        ...VIEWER_SHORTCUTS.ZOOM_RESET,
        handler: handleZoomReset,
      },
      // Rotation
      {
        ...VIEWER_SHORTCUTS.ROTATE_RIGHT,
        handler: handleRotateRight,
      },
      {
        ...VIEWER_SHORTCUTS.ROTATE_LEFT,
        handler: handleRotateLeft,
      },
      // Fullscreen
      {
        ...VIEWER_SHORTCUTS.FULLSCREEN,
        handler: handleToggleFullscreen,
      },
      // Close viewer or search panel on Escape
      {
        ...COMMON_SHORTCUTS.CLOSE,
        handler: handleEscape,
      },
      // Show help
      {
        ...BROWSER_SHORTCUTS.SHOW_HELP,
        handler: handleShowHelp,
      },
      {
        ...BROWSER_SHORTCUTS.SHOW_HELP_ALTERNATE,
        handler: handleShowHelp,
      },
    ],
    [
      handleDownload,
      handleOpenSearch,
      handleSearchNext,
      handleSearchPrevious,
      handlePageChange,
      currentPage,
      numPages,
      handleZoomIn,
      handleZoomOut,
      handleZoomReset,
      handleRotateRight,
      handleRotateLeft,
      handleToggleFullscreen,
      handleEscape,
      handleShowHelp,
    ]
  );

  useKeyboardShortcuts({
    active: !showHelp,
    shortcuts: pdfShortcuts,
  });

  const handleDialogClose = useCallback(
    (_event: unknown, reason: string) => {
      if (reason === "escapeKeyDown") {
        return;
      }

      releasePdfUrl();
      onClose();
    },
    [onClose, releasePdfUrl]
  );

  return (
    <Dialog
      aria-busy={isTransitioning}
      open
      onClose={handleDialogClose}
      maxWidth={false}
      fullScreen
      ref={dialogRef}
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
            backgroundColor: viewerBg,
            boxShadow: "none",
            margin: 0,
            width: "100dvw",
            maxWidth: "100dvw",
            height: "100dvh",
            maxHeight: "100dvh",
            overflow: "hidden",
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
        {/* Controls toolbar */}
        <Box
          sx={{
            flexShrink: 0,
            zIndex: 1,
          }}
        >
          <ViewerControls
            filename={filename}
            filenameAdornment={readOnlyIndicator}
            toolbarBackground={toolbarBg}
            toolbarText={toolbarText}
            config={{
              pageNavigation: true,
              zoom: true,
              rotation: true,
              search: true,
              download: true,
              share: shareEnabled,
            }}
            onClose={() => {
              releasePdfUrl();
              onClose();
            }}
            pageNavigation={{
              currentPage,
              totalPages: numPages,
              onPageChange: handlePageChange,
            }}
            zoom={{
              onZoomIn: () => {
                if (typeof scale === "number") {
                  handleScaleChange(scale + 0.25);
                } else {
                  handleScaleChange((pageScale || 1.0) + 0.25);
                }
              },
              onZoomOut: () => {
                if (typeof scale === "number") {
                  handleScaleChange(Math.max(scale - 0.25, 0.1));
                } else {
                  handleScaleChange(Math.max((pageScale || 1.0) - 0.25, 0.1));
                }
              },
            }}
            rotation={{
              onRotateLeft: handleRotateLeft,
              onRotateRight: handleRotateRight,
            }}
            search={{
              searchText,
              onSearchChange: handleSearchChange,
              searchMatches,
              currentMatch,
              onSearchNext: handleSearchNext,
              onSearchPrevious: handleSearchPrevious,
              searchPanelOpen,
              onSearchPanelToggle: setSearchPanelOpen,
              isSearchable,
            }}
            onDownload={handleDownload}
            onShare={nativeSharing.shareFile}
            shareDisabled={nativeSharing.sharing || !nativeSharing.ready}
            controlsDisabled={isPdfLoading || Boolean(error)}
            downloadDisabled={isPdfLoading}
          />
        </Box>

        {nativeSharing.failureDialog}

        {/* PDF content area */}
        <Box
          ref={containerRef}
          data-testid="pdf-viewer-content"
          tabIndex={0}
          {...bindSwipeDrag()}
          sx={{
            flex: 1,
            position: "relative",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            overflow: swipeNavigationEnabled ? "hidden" : "auto",
            touchAction: swipeNavigationEnabled ? "pan-y" : "auto",
            userSelect: swipeNavigationEnabled ? "none" : "auto",
            WebkitUserSelect: swipeNavigationEnabled ? "none" : "auto",
            minHeight: 0,
            backgroundColor: viewerBg,
            "&:focus": {
              outline: "none",
            },
          }}
        >
          {/* Loading state */}
          {!error && !pdfPasswordCallback && (
            <Fade in={isPdfLoading} appear={false} timeout={{ enter: 0, exit: revealDuration }} unmountOnExit>
              <Box
                data-testid="pdf-loading-overlay"
                aria-hidden={!isPdfLoading}
                inert={!isPdfLoading}
                sx={{
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  position: "absolute",
                  inset: 0,
                  zIndex: 3,
                  pointerEvents: isPdfLoading ? "auto" : "none",
                }}
              >
                <CircularProgress size={PDF_LOADING_SPINNER_SIZE} />
                {pdfLoadingStage !== "spinner" && (
                  <Box
                    role="status"
                    aria-live="polite"
                    data-testid="pdf-loading-status"
                    sx={{
                      position: "absolute",
                      top: `calc(50% + ${PDF_LOADING_SPINNER_SIZE / 2}px)`,
                      insetInline: 0,
                      maxHeight: `calc(50% - ${PDF_LOADING_SPINNER_SIZE / 2}px)`,
                      overflow: "auto",
                      textAlign: "center",
                      px: 2,
                      pt: 1,
                    }}
                  >
                    <Typography>{pdfLoadingStage === "loading" ? "Loading PDF" : getPdfLoadPhaseMessage(pdfLoadPhase)}</Typography>
                    {pdfLoadingStage === "slow" && (
                      <>
                        <Typography variant="body2">This PDF is taking longer than usual.</Typography>
                        <Button color="inherit" size="small" onClick={handleCancelPdfLoad}>
                          Cancel
                        </Button>
                      </>
                    )}
                  </Box>
                )}
              </Box>
            </Fade>
          )}

          {/* Error state */}
          {error && (
            <Box sx={{ p: 2 }}>
              <Alert
                severity="error"
                action={
                  pdfSourceVariant === "original" ? (
                    documentFailure ? (
                      <Button color="inherit" size="small" onClick={handleCompatibilityRetry}>
                        Try compatibility mode
                      </Button>
                    ) : (
                      <Button color="inherit" size="small" onClick={handleRetryLoad}>
                        {t("common.actions.retry")}
                      </Button>
                    )
                  ) : undefined
                }
              >
                {error}
              </Alert>
            </Box>
          )}

          {/* PDF Document */}
          {!error && pdfUrl && containerWidth > 0 && containerHeight > 0 && (
            <Box
              data-testid="pdf-document-presentation"
              aria-hidden={isPdfLoading}
              inert={isPdfLoading}
              sx={{
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                width: "100%",
                height: "100%",
                opacity: isPdfLoading ? 0 : 1,
                visibility: isPdfLoading ? "hidden" : "visible",
                transition: isPdfLoading ? "none" : `opacity ${revealDuration}ms ease-in-out`,
                // Override any padding/margin from react-pdf
                "& .react-pdf__Document": {
                  padding: 0,
                  margin: 0,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  width: "100%",
                  height: "100%",
                },
                "& .react-pdf__Page": {
                  padding: 0,
                  margin: 0,
                },
                // Only constrain canvas size in fit-page/fit-width modes
                ...(typeof scale !== "number" && {
                  "& .react-pdf__Page__canvas": {
                    maxWidth: "100%",
                    maxHeight: "100%",
                  },
                }),
                // Hide text layer text but keep it functional for search highlighting
                "& .react-pdf__Page__textContent": {
                  "& span": {
                    color: "transparent !important",
                    // Make sure text itself is invisible
                    WebkitTextFillColor: "transparent !important",
                  },
                },
                [`& .react-pdf__Page__textContent ${DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR}`]: {
                  backgroundColor: searchHighlightColors.otherMatches,
                  borderRadius: "2px",
                  color: "transparent !important",
                  WebkitTextFillColor: "transparent !important",
                  padding: 0,
                },
                [`& .react-pdf__Page__textContent ${DOM_TEXT_SEARCH_HIGHLIGHT_SELECTOR}[${DOM_TEXT_SEARCH_CURRENT_MATCH_ATTRIBUTE}="true"]`]:
                  {
                    backgroundColor: searchHighlightColors.currentMatch,
                  },
              }}
            >
              <Document
                file={pdfUrl}
                options={PDF_DOCUMENT_OPTIONS}
                suspense={false}
                onItemClick={handleInternalLinkNavigation}
                onLoadSuccess={handleDocumentLoadSuccess}
                onLoadError={handleDocumentLoadError}
                onPassword={handleDocumentPassword}
                loading={null}
                error={
                  <Box sx={{ p: 2 }}>
                    <Alert severity="error">Failed to load PDF document</Alert>
                  </Box>
                }
              >
                {numPages > 0 &&
                  (swipeNavigationEnabled ? (
                    <Box data-testid="pdf-swipe-viewport" sx={{ width: "100%", height: "100%", overflow: "hidden" }}>
                      <animated.div
                        data-testid="pdf-swipe-track"
                        style={{
                          display: "flex",
                          width: "300%",
                          height: "100%",
                          transform: carouselX.to((offset) => `translate3d(calc(${CAROUSEL_CENTER_OFFSET} + ${offset}px), 0, 0)`),
                          willChange: "transform",
                        }}
                      >
                        {[-1, 0, 1].map((pageOffset) => {
                          const pageNumber = currentPage + pageOffset;
                          const isPageAvailable = pageNumber >= 1 && pageNumber <= numPages;

                          return (
                            <Box
                              key={pageOffset}
                              sx={{
                                flex: "0 0 33.333333%",
                                display: "flex",
                                alignItems: "center",
                                justifyContent: "center",
                                minWidth: 0,
                                height: "100%",
                              }}
                            >
                              {isPageAvailable && renderPdfPage(pageNumber, pageOffset === 0)}
                            </Box>
                          );
                        })}
                      </animated.div>
                    </Box>
                  ) : (
                    renderPdfPage(currentPage, true)
                  ))}
              </Document>
            </Box>
          )}

          {pdfPasswordCallback && (
            <ResponsiveDialogShell
              open
              onClose={handlePdfPasswordCancel}
              title="Unlock PDF"
              description="Enter the password to view this PDF."
              maxWidth="xs"
              actions={
                <>
                  <Button onClick={handlePdfPasswordCancel} variant="outlined" sx={settingsUtilityButtonSx}>
                    Cancel
                  </Button>
                  <Button type="submit" form={pdfPasswordFormId} variant="contained" disabled={!pdfPassword}>
                    Open PDF
                  </Button>
                </>
              }
            >
              <Box
                component="form"
                id={pdfPasswordFormId}
                onSubmit={(event) => {
                  event.preventDefault();
                  handlePdfPasswordSubmit();
                }}
              >
                <Typography sx={{ mt: 1, overflowWrap: "anywhere" }}>{filename}</Typography>
                <TextField
                  autoFocus
                  fullWidth
                  label="PDF password"
                  type={showPdfPassword ? "text" : "password"}
                  autoComplete="current-password"
                  value={pdfPassword}
                  onChange={(event) => setPdfPassword(event.target.value)}
                  slotProps={{
                    input: {
                      endAdornment: (
                        <InputAdornment position="end">
                          <Tooltip title={showPdfPassword ? "Hide password" : "Show password"}>
                            <IconButton
                              aria-label={showPdfPassword ? "Hide password" : "Show password"}
                              edge="end"
                              onClick={() => setShowPdfPassword((visible) => !visible)}
                            >
                              {showPdfPassword ? <VisibilityOff /> : <Visibility />}
                            </IconButton>
                          </Tooltip>
                        </InputAdornment>
                      ),
                    },
                  }}
                  sx={{ mt: 3 }}
                />
              </Box>
            </ResponsiveDialogShell>
          )}
        </Box>
      </Box>
      <KeyboardShortcutsHelp
        open={showHelp}
        onClose={() => setShowHelp(false)}
        shortcuts={pdfShortcuts}
        title={t("keyboardShortcutsHelp.titles.pdfViewer")}
      />
    </Dialog>
  );
};

export default memo(PDFViewer);
