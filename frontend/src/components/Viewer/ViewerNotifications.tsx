import { Refresh } from "@mui/icons-material";
import { Alert, Box, CircularProgress, Snackbar, Tooltip } from "@mui/material";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";

export type ViewerReadOnlyReason = "read-only" | "locked" | "permission-denied" | "unsupported" | "unavailable" | "lost" | "conflict";

export const VIEWER_LOCK_NOTICE_DURATION_MS = 15_000;
export const VIEWER_EDIT_HEARTBEAT_MS = 30_000;
const ACQUISITION_FEEDBACK_DELAY_MS = 200;
const ACQUISITION_STATUS_SLOT_SIZE = 20;
const ACQUISITION_SPINNER_SIZE = 16;
const NOTICE_PRIORITY = { error: 0, warning: 1, info: 2 } as const;

export interface ViewerNotice {
  id: string;
  message: string;
  severity: keyof typeof NOTICE_PRIORITY;
  occurrence?: number;
  duration?: number;
  content?: ReactNode;
}

function noticeKey(notice: ViewerNotice): string {
  return JSON.stringify([notice.id, notice.message, notice.occurrence ?? 0]);
}

export function ViewerNotifications({
  notices,
  toolbarBackground,
  toolbarText,
  suppressed = false,
}: {
  notices: readonly ViewerNotice[];
  toolbarBackground: string;
  toolbarText: string;
  suppressed?: boolean;
}) {
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(new Set());
  const activeKeys = JSON.stringify(notices.map(noticeKey));

  useEffect(() => {
    const active = new Set<string>(JSON.parse(activeKeys));
    setDismissed((previous) => {
      const next = new Set([...previous].filter((key) => active.has(key)));
      return next.size === previous.size ? previous : next;
    });
  }, [activeKeys]);

  const notice = notices
    .filter((candidate) => !dismissed.has(noticeKey(candidate)))
    .sort((left, right) => NOTICE_PRIORITY[left.severity] - NOTICE_PRIORITY[right.severity])[0];
  if (!notice || suppressed) return null;

  const key = noticeKey(notice);
  const dismiss = () => setDismissed((previous) => new Set([...previous, key]));
  return (
    <Snackbar
      key={key}
      open
      autoHideDuration={notice.duration ?? null}
      anchorOrigin={{ vertical: "bottom", horizontal: "center" }}
      onClose={(_event, reason) => {
        if (reason !== "clickaway") dismiss();
      }}
      sx={{
        bottom: "max(24px, env(safe-area-inset-bottom))",
        left: { xs: 16, sm: "50%" },
        right: { xs: 16, sm: "auto" },
        maxWidth: "calc(100% - 32px)",
      }}
    >
      <Alert
        severity={notice.severity}
        role={notice.severity === "error" ? "alert" : "status"}
        onClose={dismiss}
        sx={{
          width: "100%",
          maxHeight: "50dvh",
          overflowY: "auto",
          overflowWrap: "anywhere",
          "& .MuiAlert-message": { minWidth: 0 },
          "&&":
            notice.severity === "info"
              ? { backgroundColor: toolbarBackground, color: toolbarText, "& .MuiAlert-icon": { color: "inherit" } }
              : {},
        }}
      >
        {notice.content ?? notice.message}
      </Alert>
    </Snackbar>
  );
}

export function useViewerOperationError() {
  const [failure, setFailure] = useState<{ message: string | null; occurrence: number }>({ message: null, occurrence: 0 });
  const setError = useCallback((message: string | null) => {
    setFailure((previous) => ({ message, occurrence: previous.occurrence + (message === null ? 0 : 1) }));
  }, []);
  return [failure.message, setError, failure.occurrence] as const;
}

export function useViewerLockNotice(reason: ViewerReadOnlyReason | null, error: string | null, occurrence: number): ViewerNotice | null {
  const { t } = useTranslation();
  if (reason === null || reason === "conflict") return null;
  const reasonMessage = t(`viewer.text.readOnlyReasons.${reason}`);
  return {
    id: "edit-lock",
    message: error || reasonMessage,
    severity: error ? "error" : "info",
    occurrence,
    duration: error ? undefined : VIEWER_LOCK_NOTICE_DURATION_MS,
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
