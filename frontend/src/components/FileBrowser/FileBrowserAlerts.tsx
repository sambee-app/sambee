//
// FileBrowserAlerts
//

import WarningAmber from "@mui/icons-material/WarningAmber";
import { Box, Button, CircularProgress, IconButton, Link, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { BackendAvailabilityStatus } from "../../services/backendAvailability";
import type { CompanionPairingErrorKind } from "../../services/localDrivePairing";
import { BROWSER_NOTICE_DURATION_MS, OperationNotifications } from "../OperationNotifications";
import { EmptyStateIllustration } from "./EmptyStateIllustration";

export type CompanionLifecycleStatus = "renewal_required" | "auth_failed" | "lock_lost" | "recovery_required";

function getCompanionLifecycleMessage(t: TFunction, status: CompanionLifecycleStatus): string {
  switch (status) {
    case "renewal_required":
      return t("fileBrowser.chrome.alerts.companionLifecycle.renewal_required");
    case "auth_failed":
      return t("fileBrowser.chrome.alerts.companionLifecycle.auth_failed");
    case "lock_lost":
      return t("fileBrowser.chrome.alerts.companionLifecycle.lock_lost");
    case "recovery_required":
      return t("fileBrowser.chrome.alerts.companionLifecycle.recovery_required");
  }
}

interface FileBrowserAlertsProps {
  error: string | null;
  companionLifecycleStatus?: CompanionLifecycleStatus | null;
  loadingConnections: boolean;
  connectionsCount: number;
  backendAvailabilityStatus: BackendAvailabilityStatus;
  /** Callback when user wants to open settings with connections tab */
  onOpenConnectionsSettings?: () => void;
  onRetry?: () => void;
  companionPairingError?: CompanionPairingErrorKind | null;
  onOpenLocalDrivesSettings?: () => void;
  paneLabel?: string;
  hasUsableContent?: boolean;
  onReload?: () => void;
}

/**
 * FileBrowserAlerts
 *
 * Displays contextual alerts and messages in the file browser.
 * Includes:
 * - Error messages
 * - Loading states
 * - Welcome/onboarding for new users with no connections
 */
export function FileBrowserAlerts({
  error,
  companionLifecycleStatus,
  loadingConnections,
  connectionsCount,
  backendAvailabilityStatus,
  onOpenConnectionsSettings,
  onRetry,
  companionPairingError,
  onOpenLocalDrivesSettings,
  paneLabel,
  hasUsableContent = false,
  onReload,
}: FileBrowserAlertsProps) {
  const { t } = useTranslation();
  const outage = useRef(0);
  const inOutage = useRef(false);
  const [transitionNotice, setTransitionNotice] = useState<{ message: string; occurrence: number } | null>(null);
  useEffect(() => {
    if (backendAvailabilityStatus !== "available") {
      if (!inOutage.current) {
        outage.current += 1;
        inOutage.current = true;
        setTransitionNotice({ message: t("fileBrowser.chrome.alerts.backendUnavailable"), occurrence: outage.current });
      }
      return;
    }
    setTransitionNotice(null);
    const timer = window.setTimeout(() => {
      inOutage.current = false;
    }, BROWSER_NOTICE_DURATION_MS);
    return () => window.clearTimeout(timer);
  }, [backendAvailabilityStatus, t]);
  const backendMessage =
    backendAvailabilityStatus === "reconnecting"
      ? t("fileBrowser.chrome.alerts.backendReconnecting")
      : t("fileBrowser.chrome.alerts.backendUnavailable");
  const recoveryActions = (
    <Stack direction="row" sx={{ flexWrap: "wrap", justifyContent: "center", gap: 1 }}>
      {onRetry && !companionPairingError && <Button onClick={onRetry}>{t("common.actions.retry")}</Button>}
      {companionPairingError === "signature" && onReload && <Button onClick={onReload}>{t("settings.localDrives.reloadButton")}</Button>}
      {companionPairingError && onOpenLocalDrivesSettings && (
        <Button onClick={onOpenLocalDrivesSettings}>{t("settings.localDrives.headerTitle")}</Button>
      )}
    </Stack>
  );

  if (loadingConnections && !hasUsableContent)
    return (
      <Box sx={{ display: "flex", flex: 1, justifyContent: "center", alignItems: "center" }}>
        <CircularProgress aria-label={t("fileBrowser.chrome.alerts.loadingConnections")} />
      </Box>
    );

  if (!hasUsableContent && (error || backendAvailabilityStatus !== "available")) {
    return (
      <Box
        role="alert"
        sx={{
          flex: 1,
          minHeight: 0,
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          px: 3,
          gap: 2,
          overflowWrap: "anywhere",
        }}
      >
        <Typography>
          {paneLabel ? `${paneLabel}: ` : ""}
          {error ?? backendMessage}
        </Typography>
        {recoveryActions}
      </Box>
    );
  }

  // Show welcome/onboarding when no connections
  if (connectionsCount === 0 && !error && !loadingConnections && backendAvailabilityStatus === "available") {
    return (
      <Box
        sx={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "flex-start",
          pt: "15vh",
          px: 3,
          textAlign: "center",
          flex: 1,
        }}
      >
        <EmptyStateIllustration width={180} sx={{ mb: 3, color: "text.secondary" }} />

        <Typography variant="h5" gutterBottom sx={{ fontWeight: 500 }}>
          {t("fileBrowser.chrome.alerts.welcomeTitle")}
        </Typography>

        <Typography variant="body1" sx={{ maxWidth: 400, color: "text.secondary" }}>
          {t("fileBrowser.chrome.alerts.adminOnboardingPrefix")}
          {onOpenConnectionsSettings ? (
            <Link
              component="button"
              variant="body1"
              onClick={onOpenConnectionsSettings}
              sx={{
                fontWeight: 600,
                cursor: "pointer",
                verticalAlign: "baseline",
              }}
            >
              {t("fileBrowser.chrome.alerts.adminOnboardingLink")}
            </Link>
          ) : (
            t("fileBrowser.chrome.alerts.adminOnboardingLink")
          )}
          {t("fileBrowser.chrome.alerts.adminOnboardingSuffix")}
        </Typography>
      </Box>
    );
  }

  return (
    <OperationNotifications
      notices={[
        ...(hasUsableContent && transitionNotice
          ? [
              {
                id: "backend",
                message: transitionNotice.message,
                severity: "warning" as const,
                occurrence: transitionNotice.occurrence,
                duration: BROWSER_NOTICE_DURATION_MS,
                onDismiss: () => setTransitionNotice(null),
              },
            ]
          : []),
        ...(companionLifecycleStatus
          ? [
              {
                id: "companion-lifecycle",
                message: getCompanionLifecycleMessage(t, companionLifecycleStatus),
                severity: companionLifecycleStatus === "lock_lost" ? ("error" as const) : ("warning" as const),
                action: onOpenLocalDrivesSettings ? (
                  <Button color="inherit" onClick={onOpenLocalDrivesSettings}>
                    {t("settings.localDrives.headerTitle")}
                  </Button>
                ) : undefined,
              },
            ]
          : []),
      ]}
    />
  );
}

export function FileBrowserStatus({
  backendAvailabilityStatus,
  companionLifecycleStatus,
  onRetry,
  onOpenLocalDrivesSettings,
}: Pick<FileBrowserAlertsProps, "backendAvailabilityStatus" | "companionLifecycleStatus" | "onRetry" | "onOpenLocalDrivesSettings">) {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const backendUnavailable = backendAvailabilityStatus !== "available";
  if (!backendUnavailable && !companionLifecycleStatus) return null;
  const label =
    companionLifecycleStatus && !backendUnavailable ? t("common.actions.companionRecovery") : t("common.actions.connectionStatus");
  return (
    <>
      <Tooltip title={label}>
        <IconButton
          color="inherit"
          aria-label={label}
          aria-haspopup="menu"
          aria-expanded={Boolean(anchor)}
          onClick={(event) => setAnchor(event.currentTarget)}
          sx={{ minWidth: 44, minHeight: 44, flexShrink: 0 }}
        >
          <WarningAmber />
        </IconButton>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={Boolean(anchor)}
        onClose={() => setAnchor(null)}
        slotProps={{ paper: { sx: { maxWidth: "min(360px, calc(100vw - 32px))" } } }}
      >
        {backendUnavailable && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onRetry?.();
            }}
            sx={{ whiteSpace: "normal" }}
          >
            <ListItemText
              primary={t(
                backendAvailabilityStatus === "reconnecting"
                  ? "fileBrowser.chrome.alerts.backendReconnecting"
                  : "fileBrowser.chrome.alerts.backendUnavailable"
              )}
              secondary={t("common.actions.retry")}
            />
          </MenuItem>
        )}
        {companionLifecycleStatus && (
          <MenuItem
            onClick={() => {
              setAnchor(null);
              onOpenLocalDrivesSettings?.();
            }}
            sx={{ whiteSpace: "normal" }}
          >
            <ListItemText
              primary={getCompanionLifecycleMessage(t, companionLifecycleStatus)}
              secondary={t("settings.localDrives.headerTitle")}
            />
          </MenuItem>
        )}
      </Menu>
    </>
  );
}
