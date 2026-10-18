import { Box, Button, CircularProgress, Dialog, Typography, useMediaQuery, useTheme } from "@mui/material";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Lightbox, { type Slide } from "yet-another-react-lightbox";
import Fullscreen from "yet-another-react-lightbox/plugins/fullscreen";
import Zoom from "yet-another-react-lightbox/plugins/zoom";
import "yet-another-react-lightbox/styles.css";
import "./ImageViewer.css";

import { BROWSER_SHORTCUTS, COMMON_SHORTCUTS, VIEWER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { useCachedImageGallery } from "../../hooks/useCachedImageGallery";
import { useKeyboardShortcuts } from "../../hooks/useKeyboardShortcuts";
import { useViewerSharing } from "../../hooks/useViewerSharing";
import { readViewerContent, readVirtualContent, useContentProviderRegistry } from "../../pages/FileBrowser/contentProviders";
import { error as logError, info as logInfo } from "../../services/logger";
import { useSambeeTheme } from "../../theme";
import { getViewerColors } from "../../theme/viewerStyles";
import type { ViewerComponentProps } from "../../utils/FileTypeRegistry";
import { blurActiveToolbarControl } from "../../utils/keyboardUtils";
import { createDisplayedShareFile, supportsNativeShare } from "../../utils/nativeShare";
import { KeyboardShortcutsHelp } from "../KeyboardShortcutsHelp";
import { ViewerControls, ViewerFilenameBadge } from "./ViewerControls";
import { downloadViewerBlob } from "./viewerContent";

type ZoomRef = import("yet-another-react-lightbox").ZoomRef;
type FullscreenRef = import("yet-another-react-lightbox").FullscreenRef;
interface LightboxImageSlide extends Slide {
  imageIndex: number;
  originalPath: string;
}

type ImageLoadingFeedbackStage = "spinner" | "phase" | "slow";

const isTouchDevice = () => {
  if (typeof window === "undefined") {
    return false;
  }

  const nav = typeof navigator === "undefined" ? undefined : navigator;
  return (
    "ontouchstart" in window ||
    (nav?.maxTouchPoints ?? 0) > 0 ||
    ((nav as unknown as { msMaxTouchPoints?: number })?.msMaxTouchPoints ?? 0) > 0
  );
};

const activeViewerSessions = new Set<string>();
const viewerSessionCloseTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Slide spacing for mobile-style transitions where both slides are visible
const SLIDE_GAP_PX = 32;

// Number of slides to preload in each direction (matches Lightbox carousel.preload)
const PRELOAD_COUNT = 5;

// Number of slides to cache in each direction (we cache aggressively)
const CACHE_COUNT = 20;
const IMAGE_LOADING_PHASE_DELAY_MS = 2000;
const IMAGE_LOADING_SLOW_DELAY_MS = 5000;

// Transparent 1x1 pixel PNG as placeholder to avoid broken image icon while loading
const TRANSPARENT_PIXEL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

const ImageViewer: React.FC<ViewerComponentProps> = ({
  connectionId,
  path,
  onClose,
  isReadOnly = false,
  isTransitioning = false,
  navigation,
  virtualSource,
  hasMoreItems = false,
  isLoadingMoreItems = false,
  onLoadMoreItems,
  images = [path],
  currentIndex: initialIndex = 0,
  onCurrentIndexChange,
  sessionId,
}) => {
  const contentProviders = useContentProviderRegistry();
  const { t } = useTranslation();
  const [rotate, setRotate] = useState(0);
  const [hideControls, setHideControls] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const zoomRef = useRef<ZoomRef | null>(null);
  const fullscreenRef = useRef<FullscreenRef | null>(null);

  // Callback-ref + state ensures the Lightbox only renders once the portal
  // container is mounted.  Without this, portalRef.current is null on the
  // first render and yarl falls back to document.body, setting "inert" on
  // siblings — including the MUI Dialog root — which disables our toolbar
  // and keyboard handling until a re-render moves the portal.
  const [portalElement, setPortalElement] = useState<HTMLDivElement | null>(null);
  const portalRef = useCallback((node: HTMLDivElement | null) => {
    setPortalElement(node);
  }, []);

  const { currentTheme } = useSambeeTheme();
  const muiTheme = useTheme();
  const isMobile = useMediaQuery(muiTheme.breakpoints.down("sm"));
  const shareEnabled = isMobile && supportsNativeShare();
  const { viewerBg, toolbarBg, toolbarText } = getViewerColors(currentTheme, "image");
  const readOnlyIndicator =
    isReadOnly || virtualSource ? (
      <ViewerFilenameBadge label={t("settings.connectionDialog.accessMode.readOnlyLabel")} toolbarText={toolbarText} />
    ) : null;

  const loadImageBlob = useCallback(
    (imagePath: string, options: { signal: AbortSignal; viewportWidth?: number; viewportHeight?: number }) =>
      readViewerContent(
        connectionId,
        imagePath,
        {
          kind: "image",
          viewportWidth: options.viewportWidth,
          viewportHeight: options.viewportHeight,
        },
        { signal: options.signal, virtualSource },
        contentProviders
      ),
    [connectionId, contentProviders, virtualSource]
  );

  const {
    currentIndex,
    setCurrentIndex,
    currentPath,
    filename,
    getCachedImageSrc,
    getCachedImageBlob,
    errorStates,
    currentImageLoadPhase,
    showLoadingSpinner,
    canRetryCurrentImage,
    markImageAsDecoded,
    markImageDecodeFailed,
    cancelCurrentImageLoad,
    retryCurrentImage,
  } = useCachedImageGallery({
    connectionId,
    images,
    gallerySourceKey: virtualSource
      ? `${virtualSource.location.providerId}:${virtualSource.location.connectionId}:${virtualSource.location.source.path}`
      : undefined,
    loadImageBlob,
    initialIndex,
    selectionKey: navigation?.selectionKey,
    onIndexChange: onCurrentIndexChange,
    isTouchDevice: isTouchDevice(),
    preloadRange: PRELOAD_COUNT,
    cacheRange: CACHE_COUNT,
  });
  const viewerSessionMetaRef = useRef({
    filename,
    gallerySize: images.length,
  });
  const [imageLoadingFeedbackStage, setImageLoadingFeedbackStage] = useState<ImageLoadingFeedbackStage>("spinner");
  const isCurrentImageLoading = currentImageLoadPhase === "fetching" || currentImageLoadPhase === "decoding";
  const isCurrentImageReady = currentImageLoadPhase === "ready";
  const currentImageError = errorStates.get(currentIndex) ?? null;
  const displayedBlob = isCurrentImageReady ? getCachedImageBlob(currentIndex) : undefined;
  const displayedShareFile = useMemo(
    () => (displayedBlob ? createDisplayedShareFile(displayedBlob, filename) : null),
    [displayedBlob, filename]
  );
  const nativeSharing = useViewerSharing({
    entryPoint: "image",
    identity: `${connectionId}:${currentPath}`,
    enabled: shareEnabled,
    file: displayedShareFile,
    source: "displayed-resource",
  });

  useEffect(() => {
    viewerSessionMetaRef.current = {
      filename,
      gallerySize: images.length,
    };
  }, [filename, images.length]);

  useEffect(() => {
    if (currentIndex < 0) {
      return;
    }

    setRotate(0);
    setHideControls(false);
    zoomRef.current?.changeZoom(1, true);
  }, [currentIndex]);

  // The active image index deliberately restarts the staged feedback timer.
  // biome-ignore lint/correctness/useExhaustiveDependencies: currentIndex is an intentional timer reset trigger.
  useEffect(() => {
    setImageLoadingFeedbackStage("spinner");
    const phaseTimer = window.setTimeout(() => setImageLoadingFeedbackStage("phase"), IMAGE_LOADING_PHASE_DELAY_MS);
    const slowTimer = window.setTimeout(() => setImageLoadingFeedbackStage("slow"), IMAGE_LOADING_SLOW_DELAY_MS);

    return () => {
      window.clearTimeout(phaseTimer);
      window.clearTimeout(slowTimer);
    };
  }, [currentIndex]);

  useEffect(() => {
    const meta = viewerSessionMetaRef.current;

    if (sessionId) {
      const pendingTimer = viewerSessionCloseTimers.get(sessionId);
      if (pendingTimer !== undefined) {
        clearTimeout(pendingTimer);
        viewerSessionCloseTimers.delete(sessionId);
      }

      if (!activeViewerSessions.has(sessionId)) {
        activeViewerSessions.add(sessionId);
        logInfo("Image viewer opened", meta);
      }
    } else {
      logInfo("Image viewer opened", meta);
    }

    return () => {
      if (sessionId) {
        const timer = setTimeout(() => {
          logInfo("Image viewer closed");
          viewerSessionCloseTimers.delete(sessionId);
          activeViewerSessions.delete(sessionId);
        }, 0);
        viewerSessionCloseTimers.set(sessionId, timer);
      } else {
        logInfo("Image viewer closed");
      }
    };
  }, [sessionId]);

  const slides: LightboxImageSlide[] = images.map((imagePath, index) => ({
    type: "image",
    src: getCachedImageSrc(index) ?? TRANSPARENT_PIXEL,
    alt: imagePath.split("/").pop() ?? imagePath,
    imageIndex: index,
    originalPath: imagePath,
  }));

  const handleClose = useCallback(() => {
    onClose();
  }, [onClose]);

  /** Closes the viewer when the capture-phase shortcut can handle Escape. */
  const handleEscape = useCallback(
    (_event?: KeyboardEvent) => {
      onClose();
    },
    [onClose]
  );

  /**
   * Handles Escape not already consumed by a capture-phase shortcut or child.
   * 1. If a toolbar button/input has focus → blur it (hide focus ring)
   * 2. Otherwise → close the viewer
   */
  const handlePaperKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault();
      if (blurActiveToolbarControl()) return;
      onClose();
    },
    [onClose]
  );

  const handleViewChange = useCallback(
    ({ index }: { index: number }) => {
      // Lightbox handles its own navigation - sync our state with it
      if (index !== currentIndex) {
        setCurrentIndex(index);
      }
    },
    [currentIndex, setCurrentIndex]
  );

  const handleZoomChange = useCallback(({ zoom }: { zoom: number }) => {
    // Auto-hide controls when zoomed in, but only if in fullscreen mode
    // On desktop (non-fullscreen), keep controls visible so user can zoom out via toolbar
    const isFullscreen = fullscreenRef.current?.fullscreen ?? false;

    if (zoom > 1.01 && isFullscreen) {
      setHideControls(true);
    } else if (zoom <= 1.01) {
      setHideControls(false);
    }
  }, []);

  const handleDownload = useCallback(async () => {
    try {
      if (virtualSource) {
        downloadViewerBlob(await readVirtualContent(virtualSource, currentPath, { download: true }, contentProviders), filename);
        return;
      }
      downloadViewerBlob(
        await readViewerContent(connectionId, currentPath, { kind: "raw" }, { download: true }, contentProviders),
        filename
      );
    } catch (err) {
      logError("Failed to download file", { error: err, path: currentPath, connectionId });
    }
  }, [connectionId, contentProviders, currentPath, filename, virtualSource]);

  const handleRotateLeft = useCallback(() => {
    setRotate((value) => value - 90);
  }, []);

  const handleRotateRight = useCallback(() => {
    setRotate((value) => value + 90);
  }, []);

  const handleZoomIn = useCallback(() => {
    zoomRef.current?.zoomIn();
  }, []);

  const handleZoomOut = useCallback(() => {
    zoomRef.current?.zoomOut();
  }, []);

  const handleZoomReset = useCallback(() => {
    zoomRef.current?.changeZoom(1, true);
    setHideControls(false);
  }, []);

  const handleShowHelp = useCallback(() => {
    setShowHelp(true);
  }, []);

  const handleNavigateNext = useCallback(() => {
    if (currentIndex < images.length - 1) {
      setCurrentIndex(currentIndex + 1);
      return;
    }

    if (hasMoreItems && !isLoadingMoreItems) {
      onLoadMoreItems?.();
    }
  }, [currentIndex, hasMoreItems, images.length, isLoadingMoreItems, onLoadMoreItems, setCurrentIndex]);

  const handleNavigatePrevious = useCallback(() => {
    if (currentIndex > 0) {
      setCurrentIndex(currentIndex - 1);
    }
  }, [currentIndex, setCurrentIndex]);

  useEffect(() => {
    if (currentIndex === images.length - 1 && hasMoreItems && !isLoadingMoreItems) {
      onLoadMoreItems?.();
    }
  }, [currentIndex, hasMoreItems, images.length, isLoadingMoreItems, onLoadMoreItems]);

  const handleToggleFullscreen = useCallback(() => {
    if (fullscreenRef.current?.fullscreen) {
      fullscreenRef.current?.exit();
    } else {
      fullscreenRef.current?.enter();
    }
  }, []);

  const renderSlideContainer = useCallback(
    ({ children }: { children?: React.ReactNode }) => (
      <Box
        sx={{
          width: "100%",
          height: "100%",
          transform: `rotate(${rotate}deg)`,
        }}
      >
        {children}
      </Box>
    ),
    [rotate]
  );

  const renderSlideHeader = useCallback(
    ({ slide }: { slide: Slide }) => {
      const typedSlide = slide as LightboxImageSlide;
      const imageIndex = typedSlide.imageIndex;
      const isCurrentSlide = imageIndex === currentIndex;

      return (
        <>
          {isCurrentSlide && isCurrentImageLoading && showLoadingSpinner && (
            <Box
              data-testid="image-loading-overlay"
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 3,
                color: toolbarText,
              }}
            >
              <CircularProgress sx={{ color: toolbarText }} />
              {imageLoadingFeedbackStage !== "spinner" && (
                <Box
                  role="status"
                  aria-live="polite"
                  data-testid="image-loading-status"
                  sx={{
                    position: "absolute",
                    top: "calc(50% + 28px)",
                    textAlign: "center",
                    px: 2,
                  }}
                >
                  <Typography>{currentImageLoadPhase === "decoding" ? "Rendering image" : "Preparing image"}</Typography>
                  {imageLoadingFeedbackStage === "slow" && (
                    <>
                      <Typography variant="body2">This image is taking longer than usual.</Typography>
                      <Button color="inherit" size="small" onClick={cancelCurrentImageLoad}>
                        Cancel
                      </Button>
                    </>
                  )}
                </Box>
              )}
            </Box>
          )}

          {isCurrentSlide && currentImageError && (
            <Box
              sx={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                zIndex: 3,
                pointerEvents: "none",
              }}
            >
              <Box
                sx={{
                  color: "error.main",
                  textAlign: "center",
                  px: 2,
                  pointerEvents: "auto",
                }}
              >
                <Typography>{currentImageError}</Typography>
                {canRetryCurrentImage && (
                  <Button color="inherit" size="small" onClick={retryCurrentImage}>
                    {t("common.actions.retry")}
                  </Button>
                )}
              </Box>
            </Box>
          )}
        </>
      );
    },
    [
      cancelCurrentImageLoad,
      canRetryCurrentImage,
      currentImageError,
      currentImageLoadPhase,
      currentIndex,
      imageLoadingFeedbackStage,
      isCurrentImageLoading,
      retryCurrentImage,
      showLoadingSpinner,
      t,
      toolbarText,
    ]
  );

  const imageProps = useCallback(
    (slide: Slide) => {
      const typedSlide = slide as LightboxImageSlide;
      const source = getCachedImageSrc(typedSlide.imageIndex);

      return {
        style: {
          maxWidth: "100%",
          maxHeight: "100%",
        },
        onLoadCapture: () => {
          if (source && typedSlide.src === source) {
            markImageAsDecoded(typedSlide.imageIndex, source);
          }
        },
        onErrorCapture: () => {
          if (source && typedSlide.src === source) {
            markImageDecodeFailed(typedSlide.imageIndex, source);
          }
        },
      };
    },
    [getCachedImageSrc, markImageAsDecoded, markImageDecodeFailed]
  );

  const imageShortcuts = useMemo(
    () => [
      {
        ...COMMON_SHORTCUTS.DOWNLOAD,
        handler: handleDownload,
        enabled: isCurrentImageReady,
      },
      {
        ...VIEWER_SHORTCUTS.ZOOM_IN,
        handler: handleZoomIn,
        enabled: isCurrentImageReady,
      },
      {
        ...VIEWER_SHORTCUTS.ZOOM_OUT,
        handler: handleZoomOut,
        enabled: isCurrentImageReady,
      },
      {
        ...VIEWER_SHORTCUTS.ZOOM_RESET,
        handler: handleZoomReset,
        enabled: isCurrentImageReady,
      },
      {
        ...VIEWER_SHORTCUTS.ROTATE_RIGHT,
        handler: handleRotateRight,
        enabled: isCurrentImageReady,
      },
      {
        ...VIEWER_SHORTCUTS.ROTATE_LEFT,
        handler: handleRotateLeft,
        enabled: isCurrentImageReady,
      },
      {
        ...VIEWER_SHORTCUTS.FULLSCREEN,
        handler: handleToggleFullscreen,
        enabled: isCurrentImageReady,
      },
      {
        ...COMMON_SHORTCUTS.CLOSE,
        handler: handleEscape,
      },
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
      handleEscape,
      handleRotateLeft,
      handleRotateRight,
      handleShowHelp,
      handleToggleFullscreen,
      handleZoomIn,
      handleZoomOut,
      handleZoomReset,
      isCurrentImageReady,
    ]
  );

  useKeyboardShortcuts({
    active: !showHelp,
    shortcuts: imageShortcuts,
  });

  const handleDialogClose = useCallback(
    (_event: unknown, reason: string) => {
      if (reason === "escapeKeyDown") {
        return;
      }

      handleClose();
    },
    [handleClose]
  );

  return (
    <>
      {/* Full-screen dialog overlay — consistent with PDFViewer and MarkdownViewer.
          Provides built-in focus trapping, aria-modal, and portal isolation. */}
      <Dialog
        inert={isTransitioning}
        open={true}
        onClose={handleDialogClose}
        maxWidth={false}
        fullScreen
        disableEnforceFocus // yarl lightbox manages its own focus
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
              display: "flex",
              flexDirection: "column",
            },
          },
        }}
      >
        {/* Our toolbar at top */}
        {!hideControls && (
          <Box
            sx={{
              flexShrink: 0,
              zIndex: 10,
            }}
          >
            <ViewerControls
              filename={filename}
              filenameAdornment={readOnlyIndicator}
              toolbarBackground={toolbarBg}
              toolbarText={toolbarText}
              config={{
                navigation: images.length > 1,
                zoom: true,
                rotation: true,
                download: true,
                share: shareEnabled,
              }}
              onClose={handleClose}
              navigation={
                images.length > 1
                  ? {
                      currentIndex,
                      totalItems: images.length,
                      onNext: handleNavigateNext,
                      onPrevious: handleNavigatePrevious,
                    }
                  : undefined
              }
              zoom={{
                onZoomIn: handleZoomIn,
                onZoomOut: handleZoomOut,
              }}
              rotation={{
                onRotateLeft: handleRotateLeft,
                onRotateRight: handleRotateRight,
              }}
              onDownload={handleDownload}
              onShare={nativeSharing.shareFile}
              shareDisabled={nativeSharing.sharing || !nativeSharing.ready}
              controlsDisabled={!isCurrentImageReady}
              navigationDisabled={false}
              downloadDisabled={isCurrentImageLoading}
            />
          </Box>
        )}

        {nativeSharing.failureDialog}

        {/* Lightbox container - fills remaining space below toolbar */}
        <Box
          ref={portalRef}
          className={currentImageError ? "image-viewer-load-error" : undefined}
          onKeyDownCapture={(event) => {
            if (event.altKey && (event.key === "ArrowLeft" || event.key === "ArrowRight")) event.stopPropagation();
          }}
          sx={{
            flex: 1,
            position: "relative",
          }}
        >
          {portalElement && (
            <Lightbox
              open={true}
              close={handleClose}
              index={currentIndex}
              slides={slides}
              portal={{ root: portalElement }}
              noScroll={{ disabled: true }} // Dialog handles scroll lock
              render={{
                slideContainer: renderSlideContainer,
                slideHeader: renderSlideHeader,
                buttonPrev: () => null,
                buttonNext: () => null,
                buttonClose: () => null,
                iconPrev: () => null,
                iconNext: () => null,
                controls: () => null, // Controls rendered in our custom toolbar
              }}
              toolbar={{ buttons: [] }}
              controller={{ focus: true, closeOnEscape: false }} // The viewer owns Escape dismissal.
              carousel={{
                finite: true,
                padding: 0,
                spacing: SLIDE_GAP_PX,
                imageFit: "contain",
                preload: PRELOAD_COUNT,
                imageProps,
              }}
              animation={{
                fade: 0,
                swipe: 400,
              }}
              styles={{
                root: {
                  backgroundColor: `${viewerBg} !important`,
                  position: "absolute",
                  top: 0,
                  bottom: 0,
                  left: 0,
                  right: 0,
                },
                navigationPrev: {
                  backgroundColor: `${viewerBg} !important`,
                },
                navigationNext: {
                  backgroundColor: `${viewerBg} !important`,
                },
                toolbar: {
                  display: "none", // Hide library's default toolbar
                },
                slide: {
                  // Allow images to scale up to fill viewport (removes library's default max-width/max-height limits)
                  maxWidth: "100% !important",
                  maxHeight: "100% !important",
                },
              }}
              on={{
                view: handleViewChange,
                zoom: handleZoomChange,
              }}
              plugins={[Fullscreen, Zoom]}
              fullscreen={{
                ref: fullscreenRef,
              }}
              zoom={{
                ref: zoomRef,
                scrollToZoom: true, // Allow scroll wheel to zoom
                pinchZoomV4: true,
                maxZoomPixelRatio: 3, // Allow up to 3x upscaling for closer inspection
              }}
            />
          )}
        </Box>
      </Dialog>

      <KeyboardShortcutsHelp
        open={showHelp}
        onClose={() => setShowHelp(false)}
        shortcuts={imageShortcuts}
        title={t("keyboardShortcutsHelp.titles.imageViewer")}
      />
    </>
  );
};
export default memo(ImageViewer);
