import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import ComputerIcon from "@mui/icons-material/Computer";
import DownloadIcon from "@mui/icons-material/Download";
import LinkOffIcon from "@mui/icons-material/LinkOff";
import OpenInNewIcon from "@mui/icons-material/OpenInNew";
import RadioButtonUncheckedIcon from "@mui/icons-material/RadioButtonUnchecked";
import RefreshIcon from "@mui/icons-material/Refresh";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import UsbIcon from "@mui/icons-material/Usb";
import { alpha, Box, Button, Stack, Typography } from "@mui/material";
import { type ReactNode, useCallback, useEffect, useMemo, useState } from "react";
import { CompactBadge as Chip } from "../components/CompactBadge";
import CompanionPairingDialog from "../components/FileBrowser/CompanionPairingDialog";
import { FormRow, FormSurface } from "../components/Form/FormLayout";
import { LOCAL_DRIVES_PAGE_COPY } from "../components/Settings/localDrivesCopy";
import { SettingsInlineAlert, SettingsNotificationSnackbar, type SettingsNotificationState } from "../components/Settings/SettingsFeedback";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import {
  settingsDestructiveButtonSx,
  settingsFormSurfaceUtilityButtonSx,
  settingsMetadataChipSx,
  settingsPrimaryButtonSx,
} from "../components/Settings/settingsButtonStyles";
import {
  type LocalDrivesSettingsData,
  loadLocalDrivesSettingsData,
  SETTINGS_DATA_CACHE_KEYS,
} from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import companionService, { clearStoredSecret, hasStoredSecret, isCompanionAuthSignatureMismatch } from "../services/companion";
import { canSignCompanionRequests } from "../services/companionSession";
import { logger } from "../services/logger";
import type { CompanionDownloadPlatform } from "../types";

const COMPANION_PLATFORM_LABELS: Record<CompanionDownloadPlatform, string> = {
  "windows-x64": "Windows (x64)",
  "windows-arm64": "Windows (ARM64)",
  "macos-arm64": "macOS (Apple Silicon)",
  "linux-x64": "Linux (x64)",
};

const COMPANION_PLATFORM_ORDER: CompanionDownloadPlatform[] = ["windows-x64", "windows-arm64", "macos-arm64", "linux-x64"];
const LOCAL_DRIVES_PENDING_STATUS_POLL_INTERVAL_MS = 1_000;
const LOCAL_DRIVES_ACTIVE_STATUS_POLL_INTERVAL_MS = 5_000;
const LOCAL_DRIVES_STEADY_STATUS_POLL_INTERVAL_MS = 15_000;
const IOS_USER_AGENT_TOKENS = ["iphone", "ipad", "ipod"] as const;
const MAC_PLATFORM_TOKEN = "macintel";
const ANDROID_USER_AGENT_TOKEN = "android";

function getLocalDrivesStatusPollInterval(
  companionAvailable: boolean,
  pairStatus: NonNullable<LocalDrivesSettingsData["currentPairStatus"]>["status"] | null
): number {
  if (pairStatus === "pending_local_approval") {
    return LOCAL_DRIVES_PENDING_STATUS_POLL_INTERVAL_MS;
  }

  if (!companionAvailable || pairStatus === "unpaired") {
    return LOCAL_DRIVES_ACTIVE_STATUS_POLL_INTERVAL_MS;
  }

  return LOCAL_DRIVES_STEADY_STATUS_POLL_INTERVAL_MS;
}

function detectCurrentPlatform(): CompanionDownloadPlatform | null {
  const userAgent = window.navigator.userAgent.toLowerCase();
  if (userAgent.includes("windows")) {
    return userAgent.includes("arm") ? "windows-arm64" : "windows-x64";
  }
  if (userAgent.includes("mac os x") || userAgent.includes("macintosh")) {
    return "macos-arm64";
  }
  if (userAgent.includes("linux") && !userAgent.includes("android")) {
    return "linux-x64";
  }
  return null;
}

function isUnsupportedMobileCompanionPlatform(): boolean {
  const userAgent = window.navigator.userAgent.toLowerCase();
  const platform = window.navigator.platform.toLowerCase();
  const maxTouchPoints = window.navigator.maxTouchPoints;

  const isAndroid = userAgent.includes(ANDROID_USER_AGENT_TOKEN);
  const isIos = IOS_USER_AGENT_TOKENS.some((token) => userAgent.includes(token));
  const isIpadOs = platform === MAC_PLATFORM_TOKEN && maxTouchPoints > 1;

  return isAndroid || isIos || isIpadOs;
}

interface LocalDrivesSettingsProps {
  onConnectionsChanged?: () => void;
  sectionTitle?: string;
  sectionDescription?: ReactNode;
}

type LocalDrivesViewState =
  | "secure_context_required"
  | "unavailable"
  | "unpaired"
  | "pending_local_approval"
  | "needs_repair"
  | "verification_unavailable"
  | "update_required"
  | "browser_update_required"
  | "paired";
type PairingTestResult = {
  severity: "success" | "error";
  message: string;
  authMismatch?: boolean;
};

const EMPTY_LOCAL_DRIVES_STATE: LocalDrivesSettingsData = {
  companionAvailable: false,
  currentPairStatus: null,
  authProtocolStatus: null,
  pairingVerified: null,
  downloadMetadata: null,
  downloadError: null,
};

/**
 * LocalDrivesSettings
 *
 * Browser-side management UI for the Sambee Companion pairing that exposes
 * local drives inside the file browser.
 */
export function LocalDrivesSettings({ onConnectionsChanged, sectionTitle, sectionDescription }: LocalDrivesSettingsProps) {
  const companionUnsupportedOnCurrentDevice = useMemo(() => isUnsupportedMobileCompanionPlatform(), []);
  const companionSigningAvailable = canSignCompanionRequests();
  const [testing, setTesting] = useState(false);
  const [pairingTestResult, setPairingTestResult] = useState<PairingTestResult | null>(null);
  const [pairingDialogOpen, setPairingDialogOpen] = useState(false);
  const [unpairing, setUnpairing] = useState(false);
  const [notification, setNotification] = useState<SettingsNotificationState>({
    open: false,
    message: "",
    severity: "info",
  });

  const currentOrigin = window.location.origin;
  const browserHasStoredSecret = hasStoredSecret();
  const currentPlatform = useMemo(() => detectCurrentPlatform(), []);
  const {
    data: cachedState,
    loading,
    hasResolved,
    refresh,
  } = useCachedAsyncData<LocalDrivesSettingsData>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.localDrives,
    load: loadLocalDrivesSettingsData,
    enabled: !companionUnsupportedOnCurrentDevice,
  });
  const state = cachedState ?? EMPTY_LOCAL_DRIVES_STATE;
  const statusPollInterval = getLocalDrivesStatusPollInterval(state.companionAvailable, state.currentPairStatus?.status ?? null);

  const showNotification = useCallback((message: string, severity: "success" | "error" | "info") => {
    setNotification({ open: true, message, severity });
  }, []);

  useEffect(() => {
    if (companionUnsupportedOnCurrentDevice) {
      return;
    }

    let timeoutId: number | null = null;
    let cancelled = false;

    const stopPolling = () => {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    };

    const scheduleNextRefresh = () => {
      if (cancelled || document.visibilityState !== "visible" || timeoutId !== null) {
        return;
      }

      timeoutId = window.setTimeout(() => {
        timeoutId = null;
        void refresh().finally(() => {
          scheduleNextRefresh();
        });
      }, statusPollInterval);
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        void refresh();
        scheduleNextRefresh();
        return;
      }

      stopPolling();
    };

    handleVisibilityChange();
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", handleVisibilityChange);
      stopPolling();
    };
  }, [companionUnsupportedOnCurrentDevice, refresh, statusPollInterval]);

  const handleConfirmPairing = useCallback(
    async (pairingId: string) => {
      await companionService.confirmPairing(pairingId);
      setPairingTestResult(null);
      await refresh();
      onConnectionsChanged?.();
      showNotification(LOCAL_DRIVES_PAGE_COPY.pairingCreated, "success");
    },
    [onConnectionsChanged, refresh, showNotification]
  );

  const handleCancelPairing = useCallback(
    async (pairingId: string) => {
      try {
        await companionService.cancelPairing(pairingId);
        await refresh();
      } catch (error) {
        logger.warn("Failed to cancel pending browser pairing", { error, pairingId }, "companion");
      }
    },
    [refresh]
  );

  const handleTestPairing = useCallback(async () => {
    setTesting(true);
    setPairingTestResult(null);
    try {
      await companionService.testPairing();
      await refresh();
      setPairingTestResult({ severity: "success", message: LOCAL_DRIVES_PAGE_COPY.pairingTestSucceeded });
    } catch (error) {
      logger.error("Companion pairing test failed", { error }, "companion");
      const authMismatch = isCompanionAuthSignatureMismatch(error);
      setPairingTestResult({
        severity: "error",
        message: authMismatch ? LOCAL_DRIVES_PAGE_COPY.pairingTestFailed : LOCAL_DRIVES_PAGE_COPY.pairingTestUnavailable,
        authMismatch,
      });
    } finally {
      setTesting(false);
    }
  }, [refresh]);

  const handleUnpairCurrentBrowser = useCallback(async () => {
    setUnpairing(true);

    try {
      await companionService.unpairCurrentOrigin();
      clearStoredSecret();
      await refresh();
      onConnectionsChanged?.();
      showNotification(LOCAL_DRIVES_PAGE_COPY.pairingRemoved, "success");
    } catch (error) {
      logger.error("Failed to remove current browser companion pairing", { error, origin: currentOrigin }, "companion");
      showNotification(LOCAL_DRIVES_PAGE_COPY.pairingRemoveFailed, "error");
    } finally {
      setUnpairing(false);
    }
  }, [currentOrigin, onConnectionsChanged, refresh, showNotification]);

  const viewState: LocalDrivesViewState = useMemo(() => {
    if (!companionSigningAvailable) return "secure_context_required";
    if (!state.companionAvailable) {
      return "unavailable";
    }

    if (state.authProtocolStatus === "companion_update_required") {
      return "update_required";
    }

    if (state.authProtocolStatus === "browser_update_required") {
      return "browser_update_required";
    }

    if (state.currentPairStatus === null) {
      return "verification_unavailable";
    }

    if (state.currentPairStatus?.status === "pending_local_approval") {
      return "pending_local_approval";
    }

    if (state.currentPairStatus?.status === "paired") {
      if (!browserHasStoredSecret || state.pairingVerified === false || pairingTestResult?.authMismatch) return "needs_repair";
      if (state.pairingVerified !== true || pairingTestResult?.severity === "error") return "verification_unavailable";
      return "paired";
    }

    return "unpaired";
  }, [
    companionSigningAvailable,
    browserHasStoredSecret,
    pairingTestResult,
    state.authProtocolStatus,
    state.companionAvailable,
    state.currentPairStatus,
    state.pairingVerified,
  ]);
  const downloadEntries = useMemo(
    () =>
      COMPANION_PLATFORM_ORDER.flatMap((platformKey) => {
        const assetUrl = state.downloadMetadata?.assets[platformKey];
        return assetUrl ? [[platformKey, assetUrl] as const] : [];
      }),
    [state.downloadMetadata]
  );
  const primaryDownload = useMemo(() => {
    if (downloadEntries.length === 0) {
      return null;
    }
    if (!currentPlatform) {
      return downloadEntries[0] ?? null;
    }
    return downloadEntries.find(([platformKey]) => platformKey === currentPlatform) ?? downloadEntries[0] ?? null;
  }, [currentPlatform, downloadEntries]);
  const alternateDownloads = useMemo(
    () => downloadEntries.filter(([platformKey]) => platformKey !== primaryDownload?.[0]),
    [downloadEntries, primaryDownload]
  );
  const showUnpairAction = viewState === "paired";
  const showStatusContent = hasResolved || cachedState !== null;
  const actionControlSx = {
    display: "flex",
    flexWrap: "wrap",
    gap: 1,
    alignItems: "center",
    alignSelf: "flex-start",
    justifyContent: { md: "flex-end" },
    mt: { xs: 2, md: 0 },
  };

  const downloadSourceLabel =
    state.downloadMetadata?.source === "pin"
      ? LOCAL_DRIVES_PAGE_COPY.downloadPinSourceLabel
      : LOCAL_DRIVES_PAGE_COPY.downloadFeedSourceLabel;
  const statusChecklist = useMemo(
    () => [
      {
        label: LOCAL_DRIVES_PAGE_COPY.companionRunningChecklistLabel,
        complete: viewState !== "unavailable",
      },
      {
        label: LOCAL_DRIVES_PAGE_COPY.browserFullyPairedChecklistLabel,
        complete: viewState === "paired",
      },
    ],
    [viewState]
  );
  const summaryState = useMemo(() => {
    switch (viewState) {
      case "secure_context_required":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "warning" as const,
          title: LOCAL_DRIVES_PAGE_COPY.secureContextTitle,
          message: LOCAL_DRIVES_PAGE_COPY.secureContextMessage,
        };
      case "unavailable":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelUnavailable,
          badgeVariant: "warning" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryUnavailableTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusUnavailable,
        };
      case "paired":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelReady,
          badgeVariant: "success" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryReadyTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusPaired,
        };
      case "pending_local_approval":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "themed" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryPendingApprovalTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusPendingApproval,
        };
      case "needs_repair":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "themed" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryRepairTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusRecoverable,
        };
      case "verification_unavailable":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "themed" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryVerificationUnavailableTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusVerificationUnavailable,
        };
      case "update_required":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "themed" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryUpdateRequiredTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusUpdateRequired,
        };
      case "browser_update_required":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "themed" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryBrowserUpdateRequiredTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusBrowserUpdateRequired,
        };
      case "unpaired":
        return {
          badgeLabel: LOCAL_DRIVES_PAGE_COPY.statusLabelActionRequired,
          badgeVariant: "themed" as const,
          title: LOCAL_DRIVES_PAGE_COPY.summaryPairingRequiredTitle,
          message: LOCAL_DRIVES_PAGE_COPY.statusUnpaired,
        };
    }
  }, [viewState]);
  const summaryBadgeSx =
    summaryState.badgeVariant === "themed"
      ? settingsMetadataChipSx
      : {
          ...settingsMetadataChipSx,
          color: `${summaryState.badgeVariant}.main`,
          borderColor: `${summaryState.badgeVariant}.main`,
          bgcolor: (theme: import("@mui/material").Theme) =>
            summaryState.badgeVariant === "success"
              ? alpha(theme.palette.success.main, theme.palette.mode === "dark" ? 0.16 : 0.08)
              : alpha(theme.palette.warning.main, theme.palette.mode === "dark" ? 0.16 : 0.08),
        };
  const shouldShowInstallSection =
    showStatusContent && !loading && ["secure_context_required", "unavailable", "update_required"].includes(viewState);
  const shouldShowPairingSection =
    showStatusContent && !loading && ["unpaired", "pending_local_approval", "needs_repair"].includes(viewState);
  const shouldShowVerificationSection =
    showStatusContent && !loading && browserHasStoredSecret && ["paired", "needs_repair", "verification_unavailable"].includes(viewState);

  return (
    <SettingsPage
      category="local-drives"
      title={sectionTitle ?? LOCAL_DRIVES_PAGE_COPY.headerTitle}
      description={sectionDescription ?? LOCAL_DRIVES_PAGE_COPY.headerDescription}
    >
      {companionUnsupportedOnCurrentDevice ? (
        <SettingsGroup title={LOCAL_DRIVES_PAGE_COPY.unsupportedMobileTitle} sx={{ mb: 0 }}>
          <SettingsInlineAlert severity="info" sx={{ mb: 0 }}>
            {LOCAL_DRIVES_PAGE_COPY.unsupportedMobileAlert}
          </SettingsInlineAlert>
        </SettingsGroup>
      ) : (
        <SettingsSectionList>
          <SettingsGroup title={LOCAL_DRIVES_PAGE_COPY.summaryTitle}>
            <FormSurface testId="local-drives-summary-surface">
              {showStatusContent ? (
                <Stack spacing={2.5}>
                  <Stack direction={{ xs: "column", sm: "row" }} spacing={1} sx={{ alignItems: { xs: "flex-start", sm: "center" } }}>
                    <Chip label={summaryState.badgeLabel} size="small" variant="outlined" sx={summaryBadgeSx} />
                  </Stack>

                  <Box>
                    <Typography variant="subtitle1" sx={{ fontWeight: 500 }}>
                      {summaryState.title}
                    </Typography>
                    {viewState === "secure_context_required" ? (
                      <SettingsInlineAlert severity="warning" sx={{ mt: 1 }}>
                        {summaryState.message}
                      </SettingsInlineAlert>
                    ) : (
                      <Typography variant="body2" sx={{ mt: 0.75, maxWidth: 720, color: "text.secondary" }}>
                        {summaryState.message}
                      </Typography>
                    )}
                  </Box>

                  {viewState !== "secure_context_required" && (
                    <Stack spacing={1}>
                      {statusChecklist.map((item) => (
                        <Stack key={item.label} direction="row" spacing={1.25} sx={{ alignItems: "center" }}>
                          {item.complete ? (
                            <CheckCircleOutlineIcon color="success" fontSize="small" />
                          ) : (
                            <RadioButtonUncheckedIcon sx={{ color: "text.disabled" }} fontSize="small" />
                          )}
                          <Typography variant="body2" sx={{ color: item.complete ? "text.primary" : "text.secondary" }}>
                            {item.label}
                          </Typography>
                        </Stack>
                      ))}
                    </Stack>
                  )}
                  {viewState === "verification_unavailable" && !browserHasStoredSecret && (
                    <Button
                      variant="outlined"
                      startIcon={<RefreshIcon />}
                      onClick={() => void refresh()}
                      disabled={loading}
                      sx={settingsFormSurfaceUtilityButtonSx}
                    >
                      {LOCAL_DRIVES_PAGE_COPY.retryButton}
                    </Button>
                  )}
                  {viewState === "browser_update_required" && (
                    <Button
                      variant="outlined"
                      startIcon={<RestartAltIcon />}
                      onClick={() => window.location.reload()}
                      sx={settingsFormSurfaceUtilityButtonSx}
                    >
                      {LOCAL_DRIVES_PAGE_COPY.reloadButton}
                    </Button>
                  )}
                </Stack>
              ) : (
                <SettingsLoadingState compact />
              )}
            </FormSurface>
          </SettingsGroup>

          {shouldShowInstallSection && (
            <SettingsGroup title={LOCAL_DRIVES_PAGE_COPY.downloadSectionTitle}>
              <FormSurface testId="local-drives-download-surface">
                {state.downloadMetadata ? (
                  <>
                    <FormRow sx={{ py: 0 }}>
                      <Stack spacing={1}>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          {LOCAL_DRIVES_PAGE_COPY.downloadVersionLabel}: {state.downloadMetadata.version}
                        </Typography>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          {LOCAL_DRIVES_PAGE_COPY.downloadSectionSourcePrefix}: {downloadSourceLabel}
                        </Typography>
                      </Stack>

                      {primaryDownload && (
                        <Stack spacing={1} sx={{ alignItems: { md: "flex-end" }, mt: { xs: 2, md: 0 }, minWidth: 0 }}>
                          <Chip
                            label={LOCAL_DRIVES_PAGE_COPY.downloadRecommendedLabel}
                            size="small"
                            variant="outlined"
                            sx={settingsMetadataChipSx}
                          />
                          <Button
                            component="a"
                            href={primaryDownload[1]}
                            target="_blank"
                            rel="noopener noreferrer"
                            variant="contained"
                            startIcon={<DownloadIcon />}
                            sx={[settingsPrimaryButtonSx, { whiteSpace: "normal", textAlign: "center" }]}
                          >
                            {LOCAL_DRIVES_PAGE_COPY.downloadPrimaryButton} ({COMPANION_PLATFORM_LABELS[primaryDownload[0]]})
                          </Button>
                        </Stack>
                      )}
                    </FormRow>

                    {alternateDownloads.length > 0 && (
                      <FormRow sx={{ py: 0, mt: 2 }}>
                        <Typography variant="body2" sx={{ color: "text.secondary" }}>
                          {LOCAL_DRIVES_PAGE_COPY.downloadOtherPlatformsLabel}
                        </Typography>
                        <Box sx={actionControlSx}>
                          {alternateDownloads.map(([platformKey, assetUrl]) => (
                            <Button
                              key={platformKey}
                              component="a"
                              href={assetUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              variant="outlined"
                              startIcon={<OpenInNewIcon />}
                              sx={settingsFormSurfaceUtilityButtonSx}
                            >
                              {COMPANION_PLATFORM_LABELS[platformKey]}
                            </Button>
                          ))}
                        </Box>
                      </FormRow>
                    )}
                  </>
                ) : state.downloadError ? (
                  <SettingsInlineAlert severity="warning" sx={{ mb: 0 }}>
                    {state.downloadError}
                  </SettingsInlineAlert>
                ) : (
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {LOCAL_DRIVES_PAGE_COPY.downloadUnavailable}
                  </Typography>
                )}
              </FormSurface>
            </SettingsGroup>
          )}

          {shouldShowPairingSection && (
            <SettingsGroup title={LOCAL_DRIVES_PAGE_COPY.pairingSectionTitle}>
              <FormSurface testId="local-drives-pairing-surface">
                <FormRow sx={{ py: 0 }}>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {viewState === "pending_local_approval"
                      ? LOCAL_DRIVES_PAGE_COPY.pairingSectionPendingApproval
                      : viewState === "needs_repair"
                        ? LOCAL_DRIVES_PAGE_COPY.pairingSectionRepair
                        : LOCAL_DRIVES_PAGE_COPY.pairingSectionRequired}
                  </Typography>
                  <Box sx={actionControlSx}>
                    {viewState === "needs_repair" && browserHasStoredSecret && (
                      <Button
                        variant="outlined"
                        startIcon={<RestartAltIcon />}
                        onClick={() => window.location.reload()}
                        sx={settingsFormSurfaceUtilityButtonSx}
                      >
                        {LOCAL_DRIVES_PAGE_COPY.reloadButton}
                      </Button>
                    )}
                    <Button
                      variant="contained"
                      startIcon={<UsbIcon />}
                      onClick={() => setPairingDialogOpen(true)}
                      disabled={viewState === "pending_local_approval"}
                      sx={settingsPrimaryButtonSx}
                    >
                      {viewState === "pending_local_approval"
                        ? LOCAL_DRIVES_PAGE_COPY.waitingForApprovalButton
                        : LOCAL_DRIVES_PAGE_COPY.pairThisBrowserButton}
                    </Button>
                  </Box>
                </FormRow>
              </FormSurface>
            </SettingsGroup>
          )}

          {shouldShowVerificationSection && (
            <SettingsGroup title={LOCAL_DRIVES_PAGE_COPY.verificationSectionTitle}>
              <FormSurface testId="local-drives-verification-surface">
                <Stack spacing={2}>
                  <FormRow sx={{ py: 0 }}>
                    <Typography variant="body2" sx={{ color: "text.secondary" }}>
                      {LOCAL_DRIVES_PAGE_COPY.verificationSectionReady}
                    </Typography>
                    <Box sx={actionControlSx}>
                      <Button
                        variant="outlined"
                        startIcon={<ComputerIcon />}
                        onClick={() => void handleTestPairing()}
                        disabled={testing}
                        sx={settingsFormSurfaceUtilityButtonSx}
                      >
                        {testing ? LOCAL_DRIVES_PAGE_COPY.testingButton : LOCAL_DRIVES_PAGE_COPY.testCurrentPairingButton}
                      </Button>
                    </Box>
                  </FormRow>
                  {pairingTestResult && (
                    <SettingsInlineAlert
                      role={pairingTestResult.severity === "success" ? "status" : "alert"}
                      severity={pairingTestResult.severity}
                      sx={{ mb: 0 }}
                    >
                      {pairingTestResult.message}
                    </SettingsInlineAlert>
                  )}
                </Stack>
              </FormSurface>
            </SettingsGroup>
          )}

          {showUnpairAction && (
            <SettingsGroup title={LOCAL_DRIVES_PAGE_COPY.troubleshootingSectionTitle}>
              <FormSurface testId="local-drives-troubleshooting-surface">
                <FormRow sx={{ py: 0 }}>
                  <Typography variant="body2" sx={{ color: "text.secondary" }}>
                    {LOCAL_DRIVES_PAGE_COPY.troubleshootingSectionReady}
                  </Typography>
                  <Box sx={actionControlSx}>
                    <Button
                      color="error"
                      variant="outlined"
                      startIcon={<LinkOffIcon />}
                      onClick={() => void handleUnpairCurrentBrowser()}
                      disabled={unpairing}
                      sx={settingsDestructiveButtonSx}
                    >
                      {unpairing ? LOCAL_DRIVES_PAGE_COPY.unpairingButton : LOCAL_DRIVES_PAGE_COPY.unpairThisBrowserButton}
                    </Button>
                  </Box>
                </FormRow>
              </FormSurface>
            </SettingsGroup>
          )}
        </SettingsSectionList>
      )}
      {!companionUnsupportedOnCurrentDevice && companionSigningAvailable && (
        <CompanionPairingDialog
          open={pairingDialogOpen}
          onClose={() => setPairingDialogOpen(false)}
          onInitiate={companionService.initiatePairing}
          onConfirm={handleConfirmPairing}
          onCancel={handleCancelPairing}
        />
      )}

      <SettingsNotificationSnackbar
        notification={notification}
        onClose={() => setNotification((current) => ({ ...current, open: false }))}
      />
    </SettingsPage>
  );
}
