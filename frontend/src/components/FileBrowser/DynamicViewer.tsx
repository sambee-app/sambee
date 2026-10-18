import CloseIcon from "@mui/icons-material/Close";
import {
  Alert,
  Box,
  Button,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Stack,
  Typography,
} from "@mui/material";
import { memo, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { ViewerNavigation } from "../../hooks/useRoutedViewerEditing";
import { translate } from "../../i18n";
import {
  type ContentProviderRegistry,
  ContentProviderRegistryContext,
  type VirtualItemHandle,
} from "../../pages/FileBrowser/contentProviders";
import { logger } from "../../services/logger";
import type { ViewerComponentLoadResult, ViewerComponent as ViewerComponentType } from "../../utils/FileTypeRegistry";
import { getViewerComponentLoadResult, getViewerLoadErrorDiagnostics } from "../../utils/FileTypeRegistry";
import { settingsSubduedIconButtonSx, settingsUtilityButtonSx } from "../Settings/settingsButtonStyles";

interface DynamicViewerProps {
  connectionId: string;
  isReadOnly?: boolean;
  viewInfo: {
    path: string;
    fileSize?: number;
    fileModifiedAt?: string;
    mimeType: string;
    viewerId?: "image" | "markdown" | "pdf" | "text";
    virtualSource?: VirtualItemHandle;
    images?: string[];
    currentIndex?: number;
    sessionId: string;
  };
  onClose: () => void;
  onIndexChange?: (index: number) => void;
  hasMoreItems?: boolean;
  isLoadingMoreItems?: boolean;
  onLoadMoreItems?: () => void;
  contentProviders: ContentProviderRegistry;
  navigation?: ViewerNavigation;
}

type DynamicViewerLoadState =
  | { status: "loading" }
  | { status: "loaded"; component: ViewerComponentType }
  | { status: "unsupported" }
  | { status: "failed"; error: unknown };

function getViewerLoadFailureMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return translate("viewer.fallback.failedMessageWithError", { message: error.message.trim() });
  }

  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) {
      return translate("viewer.fallback.failedMessageWithError", { message: message.trim() });
    }
  }

  return translate("viewer.fallback.failedMessageGeneric");
}

interface ViewerFallbackDialogProps {
  mode: "unsupported" | "failed" | "loading";
  path: string;
  error?: unknown;
  onClose: () => void;
  onRetry?: () => void;
}

export function ViewerFallbackDialog({ mode, path, error, onClose, onRetry }: ViewerFallbackDialogProps) {
  const { t } = useTranslation();
  const filename = path.split("/").pop() || path;
  const message = mode === "failed" ? getViewerLoadFailureMessage(error) : t("viewer.fallback.unsupportedMessage");

  return (
    <Dialog open={true} onClose={onClose} fullScreen disableRestoreFocus aria-labelledby="viewer-fallback-title">
      <DialogTitle id="viewer-fallback-title" sx={{ pr: 7 }}>
        {mode === "loading"
          ? t("common.status.loading")
          : mode === "failed"
            ? t("viewer.fallback.failedTitle")
            : t("viewer.fallback.unsupportedTitle")}
        <IconButton
          aria-label={t("viewer.fallback.closeAriaLabel")}
          onClick={onClose}
          size="small"
          sx={{ position: "absolute", top: 12, right: 12, ...settingsSubduedIconButtonSx }}
        >
          <CloseIcon />
        </IconButton>
      </DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ maxWidth: 640, pt: 1 }}>
          <Typography variant="h6">{filename}</Typography>
          {mode === "loading" ? <LinearProgress /> : <Alert severity={mode === "failed" ? "warning" : "info"}>{message}</Alert>}
          <Box>
            <Typography variant="body2" sx={{ color: "text.secondary" }}>
              {t("viewer.fallback.stillAvailable")}
            </Typography>
          </Box>
        </Stack>
      </DialogContent>
      <DialogActions>
        {mode === "failed" && onRetry ? (
          <Button onClick={onRetry} variant="outlined" sx={settingsUtilityButtonSx}>
            {t("viewer.fallback.retry")}
          </Button>
        ) : null}
        <Button variant="contained" onClick={onClose}>
          {t("common.actions.close")}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

export const DynamicViewer = memo(function DynamicViewer({
  connectionId,
  isReadOnly,
  viewInfo,
  onClose,
  onIndexChange,
  hasMoreItems = false,
  isLoadingMoreItems = false,
  onLoadMoreItems,
  contentProviders,
  navigation,
}: DynamicViewerProps) {
  const [loadState, setLoadState] = useState<DynamicViewerLoadState>({ status: "loading" });
  const [retryToken, setRetryToken] = useState(0);
  const latestViewInfoRef = useRef(viewInfo);

  latestViewInfoRef.current = viewInfo;

  useEffect(() => {
    let mounted = true;
    const loadAttempt = retryToken;
    const requestedPath = latestViewInfoRef.current.path;
    const requestedSessionId = latestViewInfoRef.current.sessionId;
    setLoadState((current) => (current.status === "loading" ? current : { status: "loading" }));

    logger.info(
      "DynamicViewer: Loading viewer component",
      {
        loadAttempt,
        mimeType: viewInfo.mimeType,
        sessionId: requestedSessionId,
      },
      "viewer"
    );

    getViewerComponentLoadResult(viewInfo.mimeType, viewInfo.viewerId).then((result: ViewerComponentLoadResult) => {
      if (mounted) {
        logger.info("DynamicViewer: Viewer component loaded", {
          mimeType: viewInfo.mimeType,
          viewerId: viewInfo.viewerId,
          componentFound: result.status === "loaded",
          resultStatus: result.status,
          sessionId: requestedSessionId,
        });
        if (result.status === "loaded") {
          setLoadState({ status: "loaded", component: result.component });
        } else if (result.status === "failed") {
          logger.error(
            "DynamicViewer: Viewer component failed to load",
            {
              loadAttempt,
              mimeType: viewInfo.mimeType,
              path: requestedPath,
              sessionId: requestedSessionId,
              viewerId: viewInfo.viewerId,
              online: typeof navigator !== "undefined" ? navigator.onLine : undefined,
              pageUrl: typeof window !== "undefined" ? window.location.href : undefined,
              ...getViewerLoadErrorDiagnostics(result.error),
            },
            "viewer",
            result.error instanceof Error ? result.error : undefined
          );
          setLoadState({ status: "failed", error: result.error });
        } else {
          setLoadState({ status: "unsupported" });
        }
      }
    });

    return () => {
      mounted = false;
    };
  }, [retryToken, viewInfo.mimeType, viewInfo.viewerId]);

  useEffect(() => {
    if (loadState.status !== "loaded") {
      return;
    }

    logger.debug(
      "DynamicViewer: Rendering viewer component",
      {
        index: viewInfo.currentIndex,
        path: viewInfo.path,
        mimeType: viewInfo.mimeType,
        sessionId: viewInfo.sessionId,
      },
      "viewer"
    );
  }, [loadState, viewInfo.mimeType, viewInfo.path, viewInfo.currentIndex, viewInfo.sessionId]);

  if (loadState.status === "failed") {
    return (
      <ViewerFallbackDialog
        mode="failed"
        path={viewInfo.path}
        error={loadState.error}
        onClose={onClose}
        onRetry={() => setRetryToken((value) => value + 1)}
      />
    );
  }

  if (loadState.status === "unsupported") {
    return <ViewerFallbackDialog mode="unsupported" path={viewInfo.path} onClose={onClose} />;
  }

  if (loadState.status !== "loaded") {
    logger.debug(
      "DynamicViewer: Viewer component still loading",
      {
        mimeType: viewInfo.mimeType,
        sessionId: viewInfo.sessionId,
      },
      "viewer"
    );
    return <ViewerFallbackDialog mode="loading" path={viewInfo.path} onClose={onClose} />;
  }

  const ViewerComponent = loadState.component;

  return (
    <ContentProviderRegistryContext.Provider value={contentProviders}>
      <ViewerComponent
        key={viewInfo.viewerId === "text" || viewInfo.viewerId === "markdown" ? `${connectionId}:${viewInfo.path}` : undefined}
        connectionId={connectionId}
        path={viewInfo.path}
        fileSize={viewInfo.fileSize}
        fileModifiedAt={viewInfo.fileModifiedAt}
        onClose={onClose}
        isReadOnly={isReadOnly}
        virtualSource={viewInfo.virtualSource}
        hasMoreItems={hasMoreItems}
        isLoadingMoreItems={isLoadingMoreItems}
        onLoadMoreItems={onLoadMoreItems}
        images={viewInfo.images}
        currentIndex={viewInfo.currentIndex}
        onCurrentIndexChange={onIndexChange}
        sessionId={viewInfo.sessionId}
        navigation={navigation}
      />
    </ContentProviderRegistryContext.Provider>
  );
});
