import { Alert, Box, Button, CircularProgress, MenuItem, TextField } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { loadSmbSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import { SettingPersistenceAdornment, useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import type { SmbAuthenticationMode, SmbEncryptionMode, SmbSettings as SmbSettingsData, SmbSettingsUpdate } from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

interface SmbSettingsProps {
  dialogSafeHeader?: boolean;
}

type SmbSettingField = SmbSettingsUpdate["field"];

function getSettingsAfterUpdate(settings: SmbSettingsData, update: SmbSettingsUpdate): SmbSettingsData {
  switch (update.field) {
    case "authentication_mode":
      return { ...settings, policy: { ...settings.policy, authentication_mode: update.value } };
    case "encryption_mode":
      return { ...settings, policy: { ...settings.policy, encryption_mode: update.value } };
    case "connection_timeout_seconds":
      return { ...settings, policy: { ...settings.policy, connection_timeout_seconds: update.value } };
    case "read_chunk_size_bytes":
      return { ...settings, read_chunk_size_bytes: { ...settings.read_chunk_size_bytes, value: update.value } };
  }
}

function getConfirmedSettingValue(settings: SmbSettingsData | null, field: SmbSettingField): unknown {
  if (!settings) return undefined;
  switch (field) {
    case "authentication_mode":
      return settings.policy.authentication_mode;
    case "encryption_mode":
      return settings.policy.encryption_mode;
    case "connection_timeout_seconds":
      return settings.policy.connection_timeout_seconds;
    case "read_chunk_size_bytes":
      return settings.read_chunk_size_bytes.value;
  }
}

export function SmbSettings({ dialogSafeHeader = false }: SmbSettingsProps) {
  const { t } = useTranslation();
  const [connectionTimeoutSeconds, setConnectionTimeoutSeconds] = useState("");
  const [readChunkSizeBytes, setReadChunkSizeBytes] = useState("");
  const [touchedFields, setTouchedFields] = useState<Partial<Record<SmbSettingField, boolean>>>({});
  const [loadError, setLoadError] = useState<string | null>(null);
  const persistence = useSystemSettingPersistence<SmbSettingsUpdate>(
    (update, options) => api.updateSmbSettings(update, options),
    (saveError) => getApiErrorMessage(saveError, t("settings.smbSettings.saveFailed"))
  );
  const restoreAuthenticationModeFocus = useRestoreFocusAfterPending(persistence.isPending("authentication_mode"));
  const restoreEncryptionModeFocus = useRestoreFocusAfterPending(persistence.isPending("encryption_mode"));
  const handleLoadError = useCallback(
    (loadError: unknown) => setLoadError(getApiErrorMessage(loadError, t("settings.smbSettings.loadFailed"))),
    [t]
  );
  const {
    data: settings,
    loading,
    refresh,
    setData: setSettings,
  } = useCachedAsyncData<SmbSettingsData>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.adminSmb,
    load: loadSmbSettingsData,
    onError: handleLoadError,
  });

  useEffect(() => {
    if (!settings) {
      return;
    }
    setConnectionTimeoutSeconds(String(settings.policy.connection_timeout_seconds));
    setReadChunkSizeBytes(String(settings.read_chunk_size_bytes.value));
  }, [settings]);

  const persistField = async (update: SmbSettingsUpdate) => {
    const result = await persistence.persist(update, getConfirmedSettingValue(settings, update.field));
    if (result.status === "completed") {
      setSettings((current) => (current ? getSettingsAfterUpdate(current, result.update) : current));
    }
  };

  const getStatusAdornment = (field: SmbSettingField) => {
    if (!persistence.isPending(field) && !persistence.isSaved(field)) return null;
    return (
      <SettingPersistenceAdornment
        pending={persistence.isPending(field)}
        saved={persistence.isSaved(field)}
        savingLabel={t("settings.smbSettings.saving")}
        savedLabel={t("settings.smbSettings.saved")}
      />
    );
  };

  const connectionTimeout = Number(connectionTimeoutSeconds);
  const hasValidConnectionTimeout = Number.isInteger(connectionTimeout) && connectionTimeout >= 5 && connectionTimeout <= 120;
  const readChunkSize = Number(readChunkSizeBytes);
  const hasValidReadChunkSize =
    Number.isInteger(readChunkSize) &&
    settings !== null &&
    readChunkSize >= settings.read_chunk_size_bytes.min_value &&
    readChunkSize <= settings.read_chunk_size_bytes.max_value;

  const retryLoad = async () => {
    setLoadError(null);
    await refresh(true);
  };

  return (
    <SettingsPage category="admin-smb" dialogSafeHeader={dialogSafeHeader}>
      {loading && !settings ? (
        <Box sx={{ display: "flex", justifyContent: "center", pt: 5 }}>
          <CircularProgress aria-label={t("settings.smbSettings.loadFailed")} />
        </Box>
      ) : null}
      {loadError && !settings ? (
        <Box sx={{ pt: 3 }}>
          <Alert
            severity="error"
            action={
              <Button onClick={() => void retryLoad()} disabled={loading}>
                {t("common.actions.retry")}
              </Button>
            }
          >
            {loadError}
          </Alert>
        </Box>
      ) : null}
      {settings ? (
        <SettingsSectionList>
          <SettingsGroup title={t("settings.smbSettings.sections.protection")}>
            <TextField
              select
              fullWidth
              label={t("settings.smbSettings.fields.authenticationMode")}
              value={settings.policy.authentication_mode}
              onChange={(event) => void persistField({ field: "authentication_mode", value: event.target.value as SmbAuthenticationMode })}
              onFocus={() => restoreAuthenticationModeFocus()}
              disabled={persistence.isPending("authentication_mode")}
              error={Boolean(persistence.fieldErrors["authentication_mode"])}
              helperText={persistence.fieldErrors["authentication_mode"] ?? t("settings.smbSettings.helper.authenticationMode")}
              slotProps={{ input: { endAdornment: getStatusAdornment("authentication_mode") } }}
            >
              <MenuItem value="negotiate">{t("settings.smbSettings.options.negotiate")}</MenuItem>
              <MenuItem value="kerberos_required">{t("settings.smbSettings.options.kerberosRequired")}</MenuItem>
            </TextField>
            <TextField
              select
              fullWidth
              label={t("settings.smbSettings.fields.encryptionMode")}
              value={settings.policy.encryption_mode}
              onChange={(event) => void persistField({ field: "encryption_mode", value: event.target.value as SmbEncryptionMode })}
              onFocus={() => restoreEncryptionModeFocus()}
              disabled={persistence.isPending("encryption_mode")}
              error={Boolean(persistence.fieldErrors["encryption_mode"])}
              helperText={persistence.fieldErrors["encryption_mode"] ?? t("settings.smbSettings.helper.encryptionMode")}
              slotProps={{ input: { endAdornment: getStatusAdornment("encryption_mode") } }}
            >
              <MenuItem value="signing_only">{t("settings.smbSettings.options.signingOnly")}</MenuItem>
              <MenuItem value="encryption_required">{t("settings.smbSettings.options.encryptionRequired")}</MenuItem>
            </TextField>
          </SettingsGroup>
          <SettingsGroup title={t("settings.smbSettings.sections.connectionBehavior")}>
            <TextField
              fullWidth
              type="number"
              label={t("settings.smbSettings.fields.connectionTimeout")}
              value={connectionTimeoutSeconds}
              onChange={(event) => {
                setConnectionTimeoutSeconds(event.target.value);
                persistence.clearFieldFeedback("connection_timeout_seconds");
              }}
              onBlur={() => {
                setTouchedFields((current) => ({ ...current, connection_timeout_seconds: true }));
                if (hasValidConnectionTimeout) void persistField({ field: "connection_timeout_seconds", value: connectionTimeout });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              disabled={persistence.isPending("connection_timeout_seconds")}
              error={
                Boolean(persistence.fieldErrors["connection_timeout_seconds"]) ||
                Boolean(touchedFields.connection_timeout_seconds && !hasValidConnectionTimeout)
              }
              helperText={
                persistence.fieldErrors["connection_timeout_seconds"] ??
                (touchedFields.connection_timeout_seconds && !hasValidConnectionTimeout
                  ? t("settings.smbSettings.connectionTimeoutError")
                  : t("settings.smbSettings.helper.connectionTimeout"))
              }
              slotProps={{
                htmlInput: { min: 5, max: 120, step: 1 },
                input: { endAdornment: getStatusAdornment("connection_timeout_seconds") },
              }}
            />
          </SettingsGroup>
          <SettingsGroup title={t("settings.smbSettings.sections.fileStreaming")}>
            <TextField
              fullWidth
              type="number"
              label={t("settings.smbSettings.fields.readChunkSize")}
              value={readChunkSizeBytes}
              onChange={(event) => {
                setReadChunkSizeBytes(event.target.value);
                persistence.clearFieldFeedback("read_chunk_size_bytes");
              }}
              onBlur={() => {
                setTouchedFields((current) => ({ ...current, read_chunk_size_bytes: true }));
                if (hasValidReadChunkSize) void persistField({ field: "read_chunk_size_bytes", value: readChunkSize });
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
              }}
              disabled={persistence.isPending("read_chunk_size_bytes")}
              error={
                Boolean(persistence.fieldErrors["read_chunk_size_bytes"]) ||
                Boolean(touchedFields.read_chunk_size_bytes && !hasValidReadChunkSize)
              }
              helperText={
                persistence.fieldErrors["read_chunk_size_bytes"] ??
                (touchedFields.read_chunk_size_bytes && !hasValidReadChunkSize
                  ? t("settings.smbSettings.readChunkSizeError")
                  : t("settings.smbSettings.helper.readChunkSize"))
              }
              slotProps={{
                htmlInput: {
                  min: settings.read_chunk_size_bytes.min_value,
                  max: settings.read_chunk_size_bytes.max_value,
                  step: settings.read_chunk_size_bytes.step,
                },
                input: { endAdornment: getStatusAdornment("read_chunk_size_bytes") },
              }}
            />
          </SettingsGroup>
        </SettingsSectionList>
      ) : null}
    </SettingsPage>
  );
}
