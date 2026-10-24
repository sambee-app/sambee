//
// FileBrowserAlerts
//

import { Alert, Box, Button, Link, Stack, Typography } from "@mui/material";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import type { BackendAvailabilityStatus } from "../../services/backendAvailability";
import type { CompanionPairingErrorKind } from "../../services/localDrivePairing";
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
  onDismissCompanionLifecycleStatus?: () => void;
  onRetry?: () => void;
  companionPairingError?: CompanionPairingErrorKind | null;
  onOpenLocalDrivesSettings?: () => void;
  paneLabel?: string;
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
  onDismissCompanionLifecycleStatus,
  onRetry,
  companionPairingError,
  onOpenLocalDrivesSettings,
  paneLabel,
}: FileBrowserAlertsProps) {
  const { t } = useTranslation();

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
    <>
      {error && (
        <Alert
          severity="error"
          sx={{ mb: 2, mx: 2 }}
          action={
            companionPairingError && onOpenLocalDrivesSettings ? (
              <Stack direction="row" sx={{ flexWrap: "wrap" }}>
                {companionPairingError === "signature" && (
                  <Button color="inherit" size="small" onClick={() => window.location.reload()}>
                    {t("settings.localDrives.reloadButton")}
                  </Button>
                )}
                <Button color="inherit" size="small" onClick={onOpenLocalDrivesSettings}>
                  {t("settings.localDrives.headerTitle")}
                </Button>
              </Stack>
            ) : onRetry ? (
              <Button color="inherit" size="small" onClick={onRetry}>
                {t("common.actions.retry")}
              </Button>
            ) : undefined
          }
        >
          {paneLabel && <strong>{paneLabel}: </strong>}
          {error}
        </Alert>
      )}

      {companionLifecycleStatus && !error && (
        <Alert
          severity={companionLifecycleStatus === "lock_lost" ? "error" : "warning"}
          sx={{ mb: 2, mx: 2 }}
          action={
            onDismissCompanionLifecycleStatus ? (
              <Button color="inherit" size="small" onClick={onDismissCompanionLifecycleStatus}>
                {t("common.actions.close")}
              </Button>
            ) : undefined
          }
        >
          {getCompanionLifecycleMessage(t, companionLifecycleStatus)}
        </Alert>
      )}

      {backendAvailabilityStatus === "unavailable" && (
        <Alert severity="warning" sx={{ mb: 2, mx: 2 }}>
          {t("fileBrowser.chrome.alerts.backendUnavailable")}
        </Alert>
      )}

      {backendAvailabilityStatus === "reconnecting" && (
        <Alert severity="info" sx={{ mb: 2, mx: 2 }}>
          {t("fileBrowser.chrome.alerts.backendReconnecting")}
        </Alert>
      )}

      {loadingConnections && !error && (
        <Alert severity="info" sx={{ mb: 2, mx: 2 }}>
          {t("fileBrowser.chrome.alerts.loadingConnections")}
        </Alert>
      )}
    </>
  );
}
