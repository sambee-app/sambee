import { Refresh as RefreshIcon, Sync as SyncIcon } from "@mui/icons-material";
import { Alert, Box, Button, Stack } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useCachedAsyncData } from "../../hooks/useCachedAsyncData";
import api from "../../services/api";
import companionService from "../../services/companion";
import { type CompanionDirectoryPolicyStatus, type DirectoryIndexSettings, isApiError } from "../../types";
import { getApiErrorMessage } from "../../utils/apiErrors";
import { SettingsGroup } from "./SettingsGroup";
import { SettingsLoadingState } from "./SettingsState";
import { settingsUtilityButtonSx } from "./settingsButtonStyles";
import { SETTINGS_DATA_CACHE_KEYS } from "./settingsDataSources";

const POLICY_APPROVAL_POLL_MS = 500;
const POLICY_APPROVAL_TIMEOUT_MS = 110_000;
const loadDesiredPolicy = () => api.getDirectoryIndexSettings("companion");

export function CompanionDirectoryStatus({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [loadError, setLoadError] = useState<string | null>(null);
  const handleLoadError = useCallback(
    (error: unknown) => setLoadError(getApiErrorMessage(error, t("settings.directorySearch.loadFailed"))),
    [t]
  );
  const { data, loading, refresh } = useCachedAsyncData<DirectoryIndexSettings>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.directoryIndexCompanion,
    load: loadDesiredPolicy,
    enabled: isAdmin,
    refreshCachedDataOnMount: true,
    onError: handleLoadError,
  });
  const desired = isAdmin ? data : null;
  return (
    <SettingsGroup title={t("settings.directorySearch.deviceTitle")}>
      {isAdmin && loadError && !desired && (
        <Alert
          severity="error"
          action={
            <Button
              disabled={loading}
              onClick={() => {
                setLoadError(null);
                void refresh(true);
              }}
            >
              {t("common.actions.retry")}
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}
      {isAdmin && loading && !desired ? (
        <SettingsLoadingState />
      ) : (
        <CompanionPolicyDelivery
          key={`${isAdmin}:${desired?.backend_identity}:${desired?.revision}`}
          desiredRevision={desired?.revision}
          backendIdentity={desired?.backend_identity}
        />
      )}
    </SettingsGroup>
  );
}

export function CompanionPolicyDelivery({ desiredRevision, backendIdentity }: { desiredRevision?: number; backendIdentity?: string }) {
  const { t } = useTranslation();
  const canApply = desiredRevision !== undefined && backendIdentity !== undefined;
  const [status, setStatus] = useState<CompanionDirectoryPolicyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<"offline" | "legacy" | "authorization" | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const setFailure = useCallback(
    (failure: unknown) => {
      if (failure instanceof Error && failure.name === "Error") {
        setUnavailable(null);
        setError(failure.message);
        return;
      }
      const status = isApiError(failure) ? failure.response?.status : undefined;
      setUnavailable(status === 404 ? "legacy" : status === 401 || status === 403 ? "authorization" : "offline");
      setError(getApiErrorMessage(failure, t("settings.directorySearch.unavailable")));
    },
    [t]
  );
  const refresh = useCallback(async () => {
    if (controller.current) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setRefreshing(true);
    setError(null);
    try {
      const result = await companionService.getDirectoryPolicyStatus({ signal: request.signal });
      if (!request.signal.aborted) {
        setStatus(result);
        setUnavailable(null);
      }
    } catch (failure) {
      if (!request.signal.aborted) setFailure(failure);
    } finally {
      if (controller.current === request) {
        controller.current = null;
        if (!request.signal.aborted) {
          setBusy(false);
          setRefreshing(false);
        }
      }
    }
  }, [setFailure]);
  useEffect(() => {
    setStatus((current) =>
      current && current.backend_identity === backendIdentity && current.effective_revision === desiredRevision ? current : null
    );
    setUnavailable(null);
    void refresh();
    return () => {
      controller.current?.abort();
      controller.current = null;
    };
  }, [refresh, desiredRevision, backendIdentity]);
  const apply = async () => {
    if (controller.current || !canApply) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(null);
    try {
      let challenge = await companionService.requestDirectoryPolicyChallenge({ signal: request.signal });
      if (request.signal.aborted) return;
      setStatus(challenge);
      const deadline = Date.now() + POLICY_APPROVAL_TIMEOUT_MS;
      const expected = challenge.challenge;
      while (!challenge.approved) {
        if (request.signal.aborted) return;
        if (Date.now() >= deadline || challenge.status === "denied" || !expected || challenge.challenge !== expected)
          throw new Error(t("settings.directorySearch.approvalExpired"));
        await new Promise<void>((resolve) => {
          const finish = () => {
            clearTimeout(timeout);
            request.signal.removeEventListener("abort", finish);
            resolve();
          };
          const timeout = setTimeout(finish, POLICY_APPROVAL_POLL_MS);
          request.signal.addEventListener("abort", finish, { once: true });
        });
        if (request.signal.aborted) return;
        challenge = await companionService.getDirectoryPolicyStatus({ signal: request.signal });
        if (request.signal.aborted) return;
        setStatus(challenge);
      }
      if (!challenge.challenge || challenge.status === "owner_conflict") throw new Error(t("settings.directorySearch.ownerConflict"));
      const grant = await api.issueDirectoryPolicyGrant(
        { companion_id: challenge.companion_id, challenge: challenge.challenge, origin: window.location.origin },
        { signal: request.signal }
      );
      if (request.signal.aborted) return;
      const applied = await companionService.redeemDirectoryPolicyGrant(grant.grant, { signal: request.signal });
      if (request.signal.aborted) return;
      if (
        applied.status !== "applied" ||
        applied.effective_revision !== grant.revision ||
        applied.backend_identity !== grant.backend_identity ||
        applied.owner_origin !== window.location.origin
      )
        throw new Error(t("settings.directorySearch.confirmationMismatch"));
      setStatus(applied);
      setUnavailable(null);
    } catch (failure) {
      if (!request.signal.aborted) setFailure(failure);
    } finally {
      if (controller.current === request) {
        controller.current = null;
        if (!request.signal.aborted) setBusy(false);
      }
    }
  };
  const conflict =
    status?.status === "owner_conflict" ||
    Boolean(backendIdentity && status?.backend_identity && status.backend_identity !== backendIdentity) ||
    Boolean(status?.owner_origin && status.owner_origin !== window.location.origin);
  const applied = !conflict && status?.status === "applied" && (!canApply || status.effective_revision === desiredRevision);
  const message =
    unavailable === "legacy"
      ? t("settings.directorySearch.legacy")
      : unavailable === "authorization"
        ? t("settings.directorySearch.authorization")
        : conflict
          ? t("settings.directorySearch.ownerConflict")
          : busy
            ? refreshing
              ? t("settings.directorySearch.refreshing")
              : status?.status === "pending_local_approval"
                ? t("settings.directorySearch.waitingApproval")
                : t("settings.directorySearch.delivering")
            : applied
              ? t("settings.directorySearch.active")
              : unavailable === "offline"
                ? t("settings.directorySearch.offline")
                : t(canApply ? "settings.directorySearch.pending" : "settings.directorySearch.notApplied");
  return (
    <Stack spacing={1.5}>
      <Alert severity={error || conflict ? "warning" : "info"} role="status">
        {unavailable ? message : (error ?? status?.message ?? message)}
      </Alert>
      <Box sx={{ typography: "caption", color: "text.secondary" }}>
        {canApply && t("settings.directorySearch.desiredRevision", { revision: desiredRevision })}{" "}
        {t("settings.directorySearch.activeRevision", { revision: status?.effective_revision ?? t("settings.directorySearch.noRevision") })}
      </Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        {canApply && (
          <Button
            variant="outlined"
            startIcon={<SyncIcon />}
            sx={settingsUtilityButtonSx}
            onClick={() => void apply()}
            disabled={busy || (!status && !unavailable) || conflict || unavailable === "legacy" || applied}
          >
            {t("settings.directorySearch.apply")}
          </Button>
        )}
        <Button variant="outlined" startIcon={<RefreshIcon />} sx={settingsUtilityButtonSx} onClick={() => void refresh()} disabled={busy}>
          {t("settings.directorySearch.refresh")}
        </Button>
      </Stack>
    </Stack>
  );
}
