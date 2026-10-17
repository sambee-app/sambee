import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import { Alert, Box, Button, IconButton, Snackbar, Tooltip } from "@mui/material";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FOCUS_OUTLINE_OFFSET_PX, FOCUS_OUTLINE_WIDTH_PX } from "../../theme/constants";
import {
  createShareDiagnostic,
  type ShareDiagnostic,
  type ShareOptions,
  type ShareSource,
  shareNativeContent,
} from "../../utils/nativeShare";
import { ResponsiveDialogShell } from "../Dialog/ResponsiveDialogShell";
import { downloadViewerBlob } from "../Viewer/viewerContent";

interface ShareFailure {
  diagnostic: ShareDiagnostic;
  files: readonly File[];
  entryPoint: string;
  source: ShareSource;
  mode: "file" | "text";
  retry?: () => void;
}

export function useNativeSharing(entryPoint: string, source: ShareSource = "saved-file") {
  const { t } = useTranslation();
  const [failure, setFailure] = useState<ShareFailure | null>(null);
  const [details, setDetails] = useState(false);
  const [copyState, setCopyState] = useState<"success" | "error" | null>(null);
  const [downloadIndex, setDownloadIndex] = useState(0);
  const [downloadError, setDownloadError] = useState(false);
  const [sharing, setSharing] = useState(false);
  const active = useRef(true);
  const busy = useRef(false);
  const generation = useRef(0);
  const detailsButtonRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
      generation.current += 1;
    };
  }, []);

  const clearFailure = () => {
    generation.current += 1;
    setFailure(null);
    setDetails(false);
    setCopyState(null);
    setDownloadIndex(0);
    setDownloadError(false);
  };
  const presentFailure = (diagnostic: ShareDiagnostic, options: ShareOptions, retry?: () => void) => {
    setDetails(false);
    setCopyState(null);
    setDownloadIndex(0);
    setDownloadError(false);
    setFailure({
      diagnostic,
      files: options.files ?? (options.file ? [options.file] : []),
      entryPoint,
      source,
      mode: options.text !== undefined ? "text" : "file",
      retry,
    });
  };
  const preparationFailed = (options: ShareOptions = {}, retry?: () => void) =>
    presentFailure({ ...createShareDiagnostic(options), reason: "preparation-failed" }, options, retry);
  const invoke = async (options: ShareOptions) => {
    if (busy.current) return;
    busy.current = true;
    clearFailure();
    const attempt = generation.current;
    setSharing(true);
    let diagnostic = createShareDiagnostic(options);
    try {
      const result = await shareNativeContent({
        ...options,
        onDiagnostic: (snapshot) => {
          diagnostic = snapshot;
        },
      });
      if (active.current && generation.current === attempt && result === "unsupported") presentFailure(diagnostic, options);
    } catch {
      if (active.current && generation.current === attempt) presentFailure(diagnostic, options);
    } finally {
      busy.current = false;
      if (active.current) setSharing(false);
    }
  };

  const report = failure
    ? JSON.stringify(
        {
          ...failure.diagnostic,
          entryPoint: failure.entryPoint,
          source: failure.source,
          mode: failure.mode,
          attachmentCount: failure.diagnostic.attachments.length,
        },
        null,
        2
      )
    : "";
  const copyReport = async () => {
    const snapshot = failure;
    try {
      await navigator.clipboard.writeText(report);
      if (active.current && snapshot === failureRef.current) setCopyState("success");
    } catch {
      if (active.current && snapshot === failureRef.current) setCopyState("error");
    }
  };
  const failureRef = useRef(failure);
  failureRef.current = failure;
  const download = () => {
    const file = failure?.files[downloadIndex];
    if (!file) return;
    try {
      downloadViewerBlob(file, file.name);
      setDownloadIndex(downloadIndex + 1);
      setDownloadError(false);
    } catch {
      setDownloadError(true);
    }
  };
  const message =
    failure?.diagnostic.reason === "api-unavailable"
      ? t("viewer.share.unsupported")
      : failure?.diagnostic.reason === "payload-unsupported"
        ? t("viewer.share.payloadUnsupported")
        : t(failure?.mode === "text" ? "viewer.share.failedText" : "viewer.share.failed");
  const detailsOpen = Boolean(failure) && details;
  const failureDialog = (
    <>
      <Snackbar open={Boolean(failure) && !details} anchorOrigin={{ vertical: "top", horizontal: "center" }}>
        <Alert severity="error" sx={{ maxWidth: "100%", overflowWrap: "anywhere", "& .MuiAlert-message": { minWidth: 0 } }}>
          {downloadError ? t("fileBrowser.share.downloadFailed") : message}
          {failure && failure.files.length > 0 && <Box sx={{ mt: 1 }}>{t("viewer.share.downloadSuggestion")}</Box>}
          <Box
            sx={{
              display: "flex",
              flexWrap: "wrap",
              gap: 1,
              mt: 1,
              p: `${FOCUS_OUTLINE_WIDTH_PX + FOCUS_OUTLINE_OFFSET_PX}px`,
            }}
          >
            <Button ref={detailsButtonRef} color="inherit" onClick={() => setDetails(true)}>
              {t("viewer.share.detailsAction")}
            </Button>
            {failure?.retry && (
              <Button
                color="inherit"
                onClick={() => {
                  const retry = failure.retry;
                  clearFailure();
                  retry?.();
                }}
              >
                {t("common.actions.retry")}
              </Button>
            )}
            {failure && downloadIndex < failure.files.length && (
              <Button color="inherit" onClick={download}>
                {failure.files.length === 1
                  ? t("common.actions.download")
                  : t("fileBrowser.share.downloadNext", { current: downloadIndex + 1, count: failure.files.length })}
              </Button>
            )}
            <Button color="inherit" onClick={clearFailure}>
              {t("common.actions.close")}
            </Button>
          </Box>
        </Alert>
      </Snackbar>
      <ResponsiveDialogShell
        open={detailsOpen}
        onClose={() => setDetails(false)}
        title={t("viewer.share.details")}
        onTransitionExited={() => detailsButtonRef.current?.focus()}
        actionNotice={
          copyState ? (
            <Alert severity={copyState}>{t(copyState === "success" ? "viewer.share.copySuccess" : "viewer.share.copyError")}</Alert>
          ) : undefined
        }
        actions={
          <Button variant="contained" onClick={() => setDetails(false)}>
            {t("common.actions.close")}
          </Button>
        }
      >
        {typeof navigator.clipboard?.writeText === "function" && (
          <Box sx={{ display: "flex", justifyContent: "flex-end" }}>
            <Tooltip title={t("viewer.share.copyDetails")}>
              <IconButton aria-label={t("viewer.share.copyDetails")} onClick={() => void copyReport()}>
                <ContentCopyIcon />
              </IconButton>
            </Tooltip>
          </Box>
        )}
        <Box component="pre" sx={{ m: 0, whiteSpace: "pre-wrap", overflowWrap: "anywhere", userSelect: "text", fontSize: "0.8125rem" }}>
          {report}
        </Box>
      </ResponsiveDialogShell>
    </>
  );
  return { invoke, preparationFailed, clearFailure, sharing, detailsOpen, failureDialog };
}
