import { Refresh } from "@mui/icons-material";
import { Box, CircularProgress, Tooltip } from "@mui/material";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { NOTICE_DURATION_MS, type OperationNotice as ViewerNotice } from "../OperationNotifications";

export {
  type OperationNotice as ViewerNotice,
  OperationNotifications as ViewerNotifications,
  useOperationError as useViewerOperationError,
} from "../OperationNotifications";

export type ViewerReadOnlyReason = "read-only" | "locked" | "permission-denied" | "unsupported" | "unavailable" | "lost" | "conflict";

export const VIEWER_LOCK_NOTICE_DURATION_MS = NOTICE_DURATION_MS.editor;
export const VIEWER_EDIT_HEARTBEAT_MS = 30_000;
export const VIEWER_EDIT_HEARTBEAT_FAILURE_THRESHOLD = 3;
const ACQUISITION_FEEDBACK_DELAY_MS = 200;
const ACQUISITION_STATUS_SLOT_SIZE = 20;
const ACQUISITION_SPINNER_SIZE = 16;

export function useViewerLockNotice(reason: ViewerReadOnlyReason | null, error: string | null, occurrence: number): ViewerNotice | null {
  const { t } = useTranslation();
  if (reason === null || reason === "conflict") return null;
  const reasonMessage = t(`viewer.text.readOnlyReasons.${reason}`);
  return {
    id: "edit-lock",
    message: error || reasonMessage,
    severity: error ? "error" : "info",
    occurrence,
    duration: VIEWER_LOCK_NOTICE_DURATION_MS,
    content: (
      <>
        {reason === "locked" ? (
          <Trans
            i18nKey="viewer.text.lockedNotification"
            components={{
              retryIcon: <Refresh fontSize="inherit" titleAccess={t("viewer.text.retryEditing")} sx={{ verticalAlign: "text-bottom" }} />,
            }}
          />
        ) : (
          reasonMessage
        )}
        {error && error !== reasonMessage ? <Box>{error}</Box> : null}
      </>
    ),
  };
}

export function ViewerEditAcquisitionStatus({ acquiring }: { acquiring: boolean }) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (!acquiring) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), ACQUISITION_FEEDBACK_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [acquiring]);
  return (
    <Box
      data-testid="text-editor-acquisition-slot"
      sx={{
        width: ACQUISITION_STATUS_SLOT_SIZE,
        height: ACQUISITION_STATUS_SLOT_SIZE,
        flexShrink: 0,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
      }}
    >
      {acquiring && visible ? (
        <Tooltip title={t("viewer.text.acquiring")}>
          <Box component="span" role="status" aria-label={t("viewer.text.acquiring")} sx={{ display: "flex" }}>
            <CircularProgress
              size={ACQUISITION_SPINNER_SIZE}
              color="inherit"
              aria-hidden="true"
              sx={{ "@media (prefers-reduced-motion: reduce)": { "&, & .MuiCircularProgress-circle": { animation: "none" } } }}
            />
          </Box>
        </Tooltip>
      ) : null}
    </Box>
  );
}
