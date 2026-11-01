import { Refresh as RefreshIcon, Sync as SyncIcon } from "@mui/icons-material";
import { Alert, Box, Button, FormControl, FormHelperText, InputAdornment, MenuItem, Stack, TextField } from "@mui/material";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import { settingsUtilityButtonSx } from "../components/Settings/settingsButtonStyles";
import { loadAdvancedSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { SettingPersistenceIndicator, useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import { translate } from "../i18n";
import api from "../services/api";
import companionService from "../services/companion";
import type { CompanionDirectoryPolicyStatus } from "../types";
import {
  type AdvancedSystemSettings,
  type AdvancedSystemSettingsUpdate,
  DIRECTORY_INDEX_POLICY_FIELDS,
  type DirectoryIndexPolicyField,
  type DirectoryIndexPolicyScope,
  type DirectoryIndexSettings,
  type DirectoryIndexSettingUpdate,
  type IntegerSystemSetting,
  isApiError,
} from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";
import { formatLocalizedNumber } from "../utils/localeFormatting";

interface AdvancedSettingsProps {
  dialogSafeHeader?: boolean;
}

interface AdvancedSettingsFormState {
  temporaryArchiveDownloadSizeBytes: number | null;
  imagemagickMaxFileSizeBytes: number | null;
  imagemagickTimeoutSeconds: number | null;
  pdfCacheQuotaBytes: number | null;
  pdfCacheInactivityTtlSeconds: number | null;
  pdfMaxSourceSizeBytes: number | null;
  pdfMaxOutputSizeBytes: number | null;
  pdfAddressSpaceBytes: number | null;
  pdfTemporaryDiskBytes: number | null;
  pdfTimeoutSeconds: number | null;
  pdfCpuTimeSeconds: number | null;
  pdfMaxConcurrent: number | null;
  pdfQueueWaitSeconds: number | null;
  pdfScreenDerivativeEnabled: number | null;
  pdfScreenMaxDecodedPixels: number | null;
}

const DESKTOP_FIELD_ROW_MAX_WIDTH = 440;
const DESKTOP_VALUE_FIELD_MAX_WIDTH = 220;
const DESKTOP_UNIT_FIELD_WIDTH = 120;
const DESKTOP_NUMERIC_FIELD_MAX_WIDTH = 240;

const BYTE_UNITS = [
  { label: "B", factor: 1 },
  { label: "KiB", factor: 1024 },
  { label: "MiB", factor: 1024 * 1024 },
  { label: "GiB", factor: 1024 * 1024 * 1024 },
] as const;

type ByteUnitLabel = (typeof BYTE_UNITS)[number]["label"];

function formatInteger(value: number): string {
  return formatLocalizedNumber(value);
}

function formatByteSize(bytes: number): string {
  const matchingUnit = [...BYTE_UNITS].reverse().find((unit) => bytes >= unit.factor && bytes % unit.factor === 0) ?? BYTE_UNITS[0];
  return `${formatInteger(bytes / matchingUnit.factor)} ${matchingUnit.label}`;
}

function formatBytesWithExactValue(bytes: number): string {
  return `${formatByteSize(bytes)} (${formatInteger(bytes)} bytes)`;
}

function getPreferredByteUnit(bytes: number): ByteUnitLabel {
  return ([...BYTE_UNITS].reverse().find((unit) => bytes >= unit.factor && bytes % unit.factor === 0) ?? BYTE_UNITS[0]).label;
}

function getByteUnitFactor(unitLabel: ByteUnitLabel): number {
  return BYTE_UNITS.find((unit) => unit.label === unitLabel)?.factor ?? 1;
}

function createFormState(settings: AdvancedSystemSettings): AdvancedSettingsFormState {
  return {
    temporaryArchiveDownloadSizeBytes: settings.temporary_archive_download_size_bytes?.value ?? null,
    imagemagickMaxFileSizeBytes: settings.preprocessors["imagemagick"]?.max_file_size_bytes.value ?? null,
    imagemagickTimeoutSeconds: settings.preprocessors["imagemagick"]?.timeout_seconds.value ?? null,
    pdfCacheQuotaBytes: settings.pdf?.cache_quota_bytes.value ?? null,
    pdfCacheInactivityTtlSeconds: settings.pdf?.cache_inactivity_ttl_seconds.value ?? null,
    pdfMaxSourceSizeBytes: settings.pdf?.max_source_size_bytes.value ?? null,
    pdfMaxOutputSizeBytes: settings.pdf?.max_output_size_bytes.value ?? null,
    pdfAddressSpaceBytes: settings.pdf?.address_space_bytes.value ?? null,
    pdfTemporaryDiskBytes: settings.pdf?.temporary_disk_bytes.value ?? null,
    pdfTimeoutSeconds: settings.pdf?.timeout_seconds.value ?? null,
    pdfCpuTimeSeconds: settings.pdf?.cpu_time_seconds.value ?? null,
    pdfMaxConcurrent: settings.pdf?.max_concurrent.value ?? null,
    pdfQueueWaitSeconds: settings.pdf?.queue_wait_seconds.value ?? null,
    pdfScreenDerivativeEnabled: settings.pdf?.screen_derivative_enabled.value ?? null,
    pdfScreenMaxDecodedPixels: settings.pdf?.screen_max_decoded_pixels.value ?? null,
  };
}

function validateIntegerSetting(setting: IntegerSystemSetting, value: number | null, unitLabel?: string): string | null {
  if (value === null) {
    return translate("settings.advanced.validation.enterLabel", { label: setting.label });
  }

  if (!Number.isInteger(value)) {
    return translate("settings.advanced.validation.wholeNumber", { label: setting.label });
  }

  if (value < setting.min_value || value > setting.max_value) {
    if (unitLabel) {
      return translate("settings.advanced.validation.betweenRangeWithUnit", {
        label: setting.label,
        min: formatInteger(setting.min_value),
        max: formatInteger(setting.max_value),
        unit: unitLabel,
      });
    }

    return translate("settings.advanced.validation.betweenRange", {
      label: setting.label,
      min: formatInteger(setting.min_value),
      max: formatInteger(setting.max_value),
    });
  }

  return null;
}

function validateByteSizeSetting(setting: IntegerSystemSetting, value: number | null): string | null {
  if (value === null) {
    return translate("settings.advanced.validation.enterLabel", { label: setting.label });
  }

  if (!Number.isInteger(value)) {
    return translate("settings.advanced.validation.wholeNumber", { label: setting.label });
  }

  if (value < setting.min_value || value > setting.max_value) {
    return translate("settings.advanced.validation.betweenRange", {
      label: setting.label,
      min: formatByteSize(setting.min_value),
      max: formatByteSize(setting.max_value),
    });
  }

  return null;
}

function SettingField({
  setting,
  value,
  onChange,
  onCommit,
  persistenceError,
  pending,
  saved,
  unitAdornment,
}: {
  setting: IntegerSystemSetting;
  value: number | null;
  onChange: (value: number | null) => void;
  onCommit: (value: number) => void;
  persistenceError?: string;
  pending: boolean;
  saved: boolean;
  unitAdornment?: string;
}) {
  const { t } = useTranslation();
  const [displayValue, setDisplayValue] = useState<string>(value === null ? "" : String(value));
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    setDisplayValue(value === null ? "" : String(value));
  }, [value]);

  const validationError = validateIntegerSetting(setting, value, unitAdornment);
  const errorText = persistenceError ?? (touched ? validationError : null);
  const helperText = errorText
    ? errorText
    : t("settings.advanced.helperText.integer", {
        description: setting.description,
        defaultValue: setting.default_value,
        minValue: setting.min_value,
        maxValue: setting.max_value,
      });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, py: 1.5 }}>
      <TextField
        type="text"
        label={setting.label}
        value={displayValue}
        onChange={(event) => {
          const nextValue = event.target.value;
          if (!/^\d*$/.test(nextValue)) {
            return;
          }

          setDisplayValue(nextValue);
          onChange(nextValue ? Number(nextValue) : null);
        }}
        onBlur={() => {
          setTouched(true);
          if (!validationError && value !== null) onCommit(value);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            setTouched(true);
            if (!validationError && value !== null) onCommit(value);
          }
        }}
        variant="outlined"
        sx={{ width: "100%", maxWidth: { xs: "100%", sm: DESKTOP_NUMERIC_FIELD_MAX_WIDTH } }}
        disabled={pending}
        error={Boolean(errorText)}
        slotProps={{
          htmlInput: { inputMode: "numeric", pattern: "[0-9]*" },
          input:
            unitAdornment || pending || saved
              ? {
                  endAdornment: (
                    <InputAdornment position="end">
                      {unitAdornment}
                      <SettingPersistenceIndicator
                        pending={pending}
                        saved={saved}
                        savingLabel="Saving setting"
                        savedLabel="Setting saved"
                      />
                    </InputAdornment>
                  ),
                }
              : undefined,
        }}
        helperText={helperText}
      />
    </Box>
  );
}

function ByteSizeSettingField({
  setting,
  fixedUnit,
  value,
  onChange,
  onCommit,
  persistenceError,
  pending,
  saved,
}: {
  setting: IntegerSystemSetting;
  fixedUnit?: ByteUnitLabel;
  value: number | null;
  onChange: (value: number | null) => void;
  onCommit: (value: number) => void;
  persistenceError?: string;
  pending: boolean;
  saved: boolean;
}) {
  const { t } = useTranslation();
  const [unit, setUnit] = useState<ByteUnitLabel>(() => fixedUnit ?? getPreferredByteUnit(value ?? setting.min_value));
  const [displayValue, setDisplayValue] = useState<string>(() =>
    value === null ? "" : String(value / getByteUnitFactor(fixedUnit ?? getPreferredByteUnit(value)))
  );
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (value === null) {
      setDisplayValue("");
      return;
    }

    const factor = getByteUnitFactor(unit);
    if (!fixedUnit && factor > value && value > 0) {
      const nextUnit = getPreferredByteUnit(value);
      setUnit(nextUnit);
      setDisplayValue(String(value / getByteUnitFactor(nextUnit)));
      return;
    }

    setDisplayValue(String(value / factor));
  }, [fixedUnit, unit, value]);

  const factor = getByteUnitFactor(unit);
  const validationError =
    validateByteSizeSetting(setting, value) ??
    (fixedUnit && value !== null && value % setting.step !== 0 ? `${setting.label} must use whole ${fixedUnit} increments` : null);
  const errorText = persistenceError ?? (touched ? validationError : null);

  const handleValueChange = (nextValue: string) => {
    if (!/^\d*$/.test(nextValue)) {
      return;
    }

    setDisplayValue(nextValue);

    if (!nextValue) {
      onChange(null);
      return;
    }

    onChange(Number(nextValue) * factor);
  };

  const handleValueBlur = () => {
    setTouched(true);
    if (!validationError && value !== null) onCommit(value);
  };

  const handleUnitChange = (nextUnit: ByteUnitLabel) => {
    setUnit(nextUnit);
  };

  const availableUnits = BYTE_UNITS.filter((option) =>
    fixedUnit ? option.label === fixedUnit : value === null || value % option.factor === 0 || option.label === unit
  );
  const helperMessage = errorText
    ? errorText
    : t("settings.advanced.helperText.byteSize", {
        description: setting.description,
        defaultValue: formatBytesWithExactValue(setting.default_value),
        minValue: formatByteSize(setting.min_value),
        maxValue: formatByteSize(setting.max_value),
      });

  return (
    <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, py: 1.5 }}>
      <FormControl error={Boolean(errorText)} sx={{ width: "100%", maxWidth: { xs: "100%", sm: DESKTOP_FIELD_ROW_MAX_WIDTH } }}>
        <Stack direction={{ xs: "column", sm: "row" }} spacing={1.5}>
          <TextField
            type="text"
            label={setting.label}
            value={displayValue}
            onChange={(event) => handleValueChange(event.target.value)}
            onBlur={handleValueBlur}
            slotProps={{
              htmlInput: { inputMode: "numeric", pattern: "[0-9]*" },
              input:
                pending || saved
                  ? {
                      endAdornment: (
                        <InputAdornment position="end">
                          <SettingPersistenceIndicator
                            pending={pending}
                            saved={saved}
                            savingLabel="Saving setting"
                            savedLabel="Setting saved"
                          />
                        </InputAdornment>
                      ),
                    }
                  : undefined,
            }}
            variant="outlined"
            sx={{ width: "100%", maxWidth: { xs: "100%", sm: DESKTOP_VALUE_FIELD_MAX_WIDTH } }}
            disabled={pending}
            error={Boolean(errorText)}
          />
          <TextField
            select
            label={t("settings.advanced.fields.unit")}
            value={unit}
            onChange={(event) => handleUnitChange(event.target.value as ByteUnitLabel)}
            variant="outlined"
            disabled={pending || Boolean(fixedUnit)}
            error={Boolean(errorText)}
            sx={{ width: { xs: "100%", sm: DESKTOP_UNIT_FIELD_WIDTH } }}
          >
            {availableUnits.map((option) => (
              <MenuItem key={option.label} value={option.label}>
                {option.label}
              </MenuItem>
            ))}
          </TextField>
        </Stack>
        <FormHelperText sx={{ mt: 1, mx: 0 }}>{helperMessage}</FormHelperText>
      </FormControl>
    </Box>
  );
}

function applyIntegerSettingUpdate(setting: IntegerSystemSetting, update: AdvancedSystemSettingsUpdate): IntegerSystemSetting {
  return setting.key === update.field ? { ...setting, value: update.value, source: "database" } : setting;
}

function applyAdvancedSettingUpdate(settings: AdvancedSystemSettings, update: AdvancedSystemSettingsUpdate): AdvancedSystemSettings {
  const updateSetting = (setting: IntegerSystemSetting) => applyIntegerSettingUpdate(setting, update);
  const imagemagick = settings.preprocessors["imagemagick"];
  return {
    ...settings,
    temporary_archive_download_size_bytes: settings.temporary_archive_download_size_bytes
      ? updateSetting(settings.temporary_archive_download_size_bytes)
      : undefined,
    preprocessors: {
      ...settings.preprocessors,
      ...(imagemagick
        ? {
            imagemagick: {
              max_file_size_bytes: updateSetting(imagemagick.max_file_size_bytes),
              timeout_seconds: updateSetting(imagemagick.timeout_seconds),
            },
          }
        : {}),
    },
    ...(settings.pdf
      ? {
          pdf: {
            cache_quota_bytes: updateSetting(settings.pdf.cache_quota_bytes),
            cache_inactivity_ttl_seconds: updateSetting(settings.pdf.cache_inactivity_ttl_seconds),
            max_source_size_bytes: updateSetting(settings.pdf.max_source_size_bytes),
            max_output_size_bytes: updateSetting(settings.pdf.max_output_size_bytes),
            address_space_bytes: updateSetting(settings.pdf.address_space_bytes),
            temporary_disk_bytes: updateSetting(settings.pdf.temporary_disk_bytes),
            timeout_seconds: updateSetting(settings.pdf.timeout_seconds),
            cpu_time_seconds: updateSetting(settings.pdf.cpu_time_seconds),
            max_concurrent: updateSetting(settings.pdf.max_concurrent),
            queue_wait_seconds: updateSetting(settings.pdf.queue_wait_seconds),
            screen_derivative_enabled: updateSetting(settings.pdf.screen_derivative_enabled),
            screen_max_decoded_pixels: updateSetting(settings.pdf.screen_max_decoded_pixels),
          },
        }
      : {}),
  };
}

const DIRECTORY_INDEX_LOADERS = {
  backend: () => api.getDirectoryIndexSettings("backend"),
  companion: () => api.getDirectoryIndexSettings("companion"),
} as const;

const POLICY_APPROVAL_POLL_MS = 500;
const POLICY_APPROVAL_TIMEOUT_MS = 110_000;

function CompanionPolicyDelivery({ desiredRevision, backendIdentity }: { desiredRevision: number; backendIdentity: string }) {
  const [status, setStatus] = useState<CompanionDirectoryPolicyStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<"offline" | "legacy" | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const controller = useRef<AbortController | null>(null);
  const setFailure = useCallback((failure: unknown) => {
    if (failure instanceof Error && failure.name === "Error") {
      setUnavailable(null);
      setError(failure.message);
      return;
    }
    setUnavailable(isApiError(failure) && failure.response?.status === 404 ? "legacy" : "offline");
    setError(getApiErrorMessage(failure, "Companion policy is unavailable. Check pairing and the companion connection, then retry."));
  }, []);
  useEffect(() => {
    const request = new AbortController();
    companionService.getDirectoryPolicyStatus({ signal: request.signal }).then(
      (result) => {
        if (!request.signal.aborted) setStatus(result);
      },
      (failure) => {
        if (!request.signal.aborted) setFailure(failure);
      }
    );
    return () => {
      request.abort();
      controller.current?.abort();
    };
  }, [setFailure]);
  const refresh = async () => {
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
  };
  const apply = async () => {
    if (controller.current) return;
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
          throw new Error("Local policy approval was denied or expired. Request a new approval.");
        await new Promise<void>((resolve) => setTimeout(resolve, POLICY_APPROVAL_POLL_MS));
        if (request.signal.aborted) return;
        challenge = await companionService.getDirectoryPolicyStatus({ signal: request.signal });
        if (request.signal.aborted) return;
        setStatus(challenge);
      }
      if (!challenge.challenge || challenge.status === "owner_conflict")
        throw new Error("Another backend owns companion policy. Reset that owner in native Preferences.");
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
        throw new Error("Companion policy confirmation does not match the issued grant. Refresh its status before retrying.");
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
    Boolean(status?.backend_identity && status.backend_identity !== backendIdentity) ||
    Boolean(status?.owner_origin && status.owner_origin !== window.location.origin);
  const applied = status?.status === "applied" && status.effective_revision === desiredRevision;
  const message =
    unavailable === "legacy"
      ? "Companion update required. Desired policy is saved, but this companion has no policy approval support."
      : conflict
        ? "Another backend owns companion policy. Reset that owner in native Preferences."
        : busy
          ? refreshing
            ? "Refreshing companion policy status."
            : status?.status === "pending_local_approval"
              ? "Waiting for local companion approval."
              : "Delivering approved companion policy."
          : applied
            ? "Companion policy is active."
            : unavailable === "offline"
              ? "Companion is offline or unavailable. Its last approved policy remains active."
              : "Desired policy is saved. Companion approval or delivery is pending.";
  return (
    <Stack spacing={1.5}>
      <Alert severity={error || conflict ? "warning" : "info"} role="status">
        {error ?? status?.message ?? message}
      </Alert>
      <Box sx={{ typography: "caption", color: "text.secondary" }}>
        Desired revision: {desiredRevision}. Active revision: {status?.effective_revision ?? "not applied"}.
      </Box>
      <Stack direction="row" spacing={1} sx={{ flexWrap: "wrap", gap: 1 }}>
        <Button
          variant="outlined"
          startIcon={<SyncIcon />}
          sx={settingsUtilityButtonSx}
          onClick={() => void apply()}
          disabled={busy || conflict || unavailable === "legacy" || applied}
        >
          Apply To This Companion
        </Button>
        <Button variant="outlined" startIcon={<RefreshIcon />} sx={settingsUtilityButtonSx} onClick={() => void refresh()} disabled={busy}>
          Refresh Status
        </Button>
      </Stack>
    </Stack>
  );
}

function DirectoryIndexPolicyGroup({ scope }: { scope: DirectoryIndexPolicyScope }) {
  const { t } = useTranslation();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<DirectoryIndexPolicyField, number | null>>>({});
  const { data, loading, refresh, setData } = useCachedAsyncData<DirectoryIndexSettings>({
    cacheKey: scope === "backend" ? SETTINGS_DATA_CACHE_KEYS.directoryIndexBackend : SETTINGS_DATA_CACHE_KEYS.directoryIndexCompanion,
    load: DIRECTORY_INDEX_LOADERS[scope],
    onError: (error) => setLoadError(getApiErrorMessage(error, t("settings.advanced.loadFailed"))),
  });
  const persistence = useSystemSettingPersistence<DirectoryIndexSettingUpdate>(
    (update, options) => api.updateDirectoryIndexSettings(scope, update, options),
    (error) => getApiErrorMessage(error, t("settings.advanced.saveFailed"))
  );
  const persistField = async (field: DirectoryIndexPolicyField, value: number) => {
    const result = await persistence.persist({ field, value }, data?.policy[field]);
    if (result.status !== "completed") return;
    setData((current) =>
      current
        ? {
            ...current,
            policy: { ...current.policy, [field]: result.update.value },
            fields: { ...current.fields, [field]: { ...current.fields[field], value: result.update.value, source: "db" } },
          }
        : current
    );
    setDrafts((current) => ({ ...current, [field]: result.update.value }));
    void refresh();
  };
  return (
    <SettingsGroup title={scope === "backend" ? "Backend Directory Indexes" : "Companion Directory Indexes"}>
      {loadError && (
        <Alert
          severity="error"
          action={
            <Button
              onClick={() => {
                setLoadError(null);
                void refresh(true);
              }}
              disabled={loading}
            >
              {t("common.actions.retry")}
            </Button>
          }
        >
          {loadError}
        </Alert>
      )}
      {loading && !data && <SettingsLoadingState />}
      {scope === "companion" && data && <CompanionPolicyDelivery desiredRevision={data.revision} backendIdentity={data.backend_identity} />}
      {data &&
        DIRECTORY_INDEX_POLICY_FIELDS.map((field) => {
          const setting = data.fields[field];
          const value = Object.hasOwn(drafts, field) ? (drafts[field] ?? null) : data.policy[field];
          const props = {
            setting,
            value,
            onChange: (next: number | null) => {
              setDrafts((current) => ({ ...current, [field]: next }));
              persistence.clearFieldFeedback(field);
            },
            onCommit: (next: number) => void persistField(field, next),
            persistenceError: persistence.fieldErrors[field],
            pending: persistence.isPending(field),
            saved: persistence.isSaved(field),
          };
          return field === "disk_budget_bytes" ? (
            <ByteSizeSettingField key={field} {...props} fixedUnit="MiB" />
          ) : (
            <SettingField
              key={field}
              {...props}
              unitAdornment={
                field === "page_cache_kib" ? "KiB" : field.endsWith("seconds") ? t("settings.advanced.fields.seconds") : undefined
              }
            />
          );
        })}
    </SettingsGroup>
  );
}

export function AdvancedSettings({ dialogSafeHeader = false }: AdvancedSettingsProps) {
  const { t } = useTranslation();
  const [pageError, setPageError] = useState<string | null>(null);
  const handleAdvancedSettingsLoadError = useCallback(
    (loadError: unknown) => {
      setPageError(getApiErrorMessage(loadError, t("settings.advanced.loadFailed")));
    },
    [t]
  );
  const {
    data: settings,
    loading,
    refresh,
    setData: setCachedSettings,
  } = useCachedAsyncData<AdvancedSystemSettings>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.adminSystem,
    load: loadAdvancedSettingsData,
    onError: handleAdvancedSettingsLoadError,
  });
  const [formState, setFormState] = useState<AdvancedSettingsFormState | null>(null);
  const persistence = useSystemSettingPersistence<AdvancedSystemSettingsUpdate>(
    (update, options) => api.updateAdvancedSettings(update, options),
    (saveError) => getApiErrorMessage(saveError, t("settings.advanced.saveFailed"))
  );

  useEffect(() => {
    if (!settings) {
      return;
    }

    setPageError(null);
    setFormState((current) => current ?? createFormState(settings));
  }, [settings]);

  const updateFormField = <Field extends keyof AdvancedSettingsFormState>(
    field: Field,
    value: AdvancedSettingsFormState[Field],
    setting: IntegerSystemSetting
  ) => {
    setFormState((current) => (current ? { ...current, [field]: value } : current));
    persistence.clearFieldFeedback(setting.key);
  };

  const persistField = async (setting: IntegerSystemSetting, value: number) => {
    const result = await persistence.persist({ field: setting.key, value }, setting.value);
    if (result.status === "completed") {
      setCachedSettings((current) => (current ? applyAdvancedSettingUpdate(current, result.update) : current));
    }
  };

  const getFieldPersistenceProps = (setting: IntegerSystemSetting) => ({
    onCommit: (value: number) => void persistField(setting, value),
    persistenceError: persistence.fieldErrors[setting.key],
    pending: persistence.isPending(setting.key),
    saved: persistence.isSaved(setting.key),
  });

  const retryLoad = () => {
    setPageError(null);
    void refresh(true);
  };

  const imagemagick = settings?.preprocessors["imagemagick"];
  const pdf = settings?.pdf;

  return (
    <SettingsPage
      category="admin-system"
      dialogSafeHeader={dialogSafeHeader}
      contextualNotice={
        pageError ? (
          <Alert
            severity="error"
            action={
              <Button onClick={retryLoad} disabled={loading}>
                {t("common.actions.retry")}
              </Button>
            }
          >
            {pageError}
          </Alert>
        ) : null
      }
    >
      {loading && !settings && <SettingsLoadingState />}

      {settings && formState && (
        <SettingsSectionList>
          {settings.temporary_archive_download_size_bytes && (
            <SettingsGroup title={t("settings.advanced.sections.archiveDownloads")}>
              <ByteSizeSettingField
                setting={settings.temporary_archive_download_size_bytes}
                fixedUnit="MiB"
                value={formState.temporaryArchiveDownloadSizeBytes}
                onChange={(value) =>
                  updateFormField("temporaryArchiveDownloadSizeBytes", value, settings.temporary_archive_download_size_bytes!)
                }
                {...getFieldPersistenceProps(settings.temporary_archive_download_size_bytes)}
              />
            </SettingsGroup>
          )}
          <SettingsGroup title={t("settings.advanced.sections.preprocessors")}>
            <Stack spacing={3.5}>
              {imagemagick && (
                <SettingsGroup title={t("settings.advanced.sections.imageMagick")} level="subsection">
                  <ByteSizeSettingField
                    setting={imagemagick.max_file_size_bytes}
                    value={formState.imagemagickMaxFileSizeBytes}
                    onChange={(value) => updateFormField("imagemagickMaxFileSizeBytes", value, imagemagick.max_file_size_bytes)}
                    {...getFieldPersistenceProps(imagemagick.max_file_size_bytes)}
                  />
                  <SettingField
                    setting={imagemagick.timeout_seconds}
                    value={formState.imagemagickTimeoutSeconds}
                    onChange={(value) => updateFormField("imagemagickTimeoutSeconds", value, imagemagick.timeout_seconds)}
                    unitAdornment={t("settings.advanced.fields.seconds")}
                    {...getFieldPersistenceProps(imagemagick.timeout_seconds)}
                  />
                </SettingsGroup>
              )}
              {pdf && (
                <SettingsGroup title={t("settings.advanced.sections.pdfCompatibility")} level="subsection">
                  <ByteSizeSettingField
                    setting={pdf.cache_quota_bytes}
                    value={formState.pdfCacheQuotaBytes}
                    onChange={(value) => updateFormField("pdfCacheQuotaBytes", value, pdf.cache_quota_bytes)}
                    {...getFieldPersistenceProps(pdf.cache_quota_bytes)}
                  />
                  <SettingField
                    setting={pdf.cache_inactivity_ttl_seconds}
                    value={formState.pdfCacheInactivityTtlSeconds}
                    onChange={(value) => updateFormField("pdfCacheInactivityTtlSeconds", value, pdf.cache_inactivity_ttl_seconds)}
                    unitAdornment={t("settings.advanced.fields.seconds")}
                    {...getFieldPersistenceProps(pdf.cache_inactivity_ttl_seconds)}
                  />
                  <ByteSizeSettingField
                    setting={pdf.max_source_size_bytes}
                    value={formState.pdfMaxSourceSizeBytes}
                    onChange={(value) => updateFormField("pdfMaxSourceSizeBytes", value, pdf.max_source_size_bytes)}
                    {...getFieldPersistenceProps(pdf.max_source_size_bytes)}
                  />
                  <ByteSizeSettingField
                    setting={pdf.max_output_size_bytes}
                    value={formState.pdfMaxOutputSizeBytes}
                    onChange={(value) => updateFormField("pdfMaxOutputSizeBytes", value, pdf.max_output_size_bytes)}
                    {...getFieldPersistenceProps(pdf.max_output_size_bytes)}
                  />
                  <ByteSizeSettingField
                    setting={pdf.address_space_bytes}
                    value={formState.pdfAddressSpaceBytes}
                    onChange={(value) => updateFormField("pdfAddressSpaceBytes", value, pdf.address_space_bytes)}
                    {...getFieldPersistenceProps(pdf.address_space_bytes)}
                  />
                  <ByteSizeSettingField
                    setting={pdf.temporary_disk_bytes}
                    value={formState.pdfTemporaryDiskBytes}
                    onChange={(value) => updateFormField("pdfTemporaryDiskBytes", value, pdf.temporary_disk_bytes)}
                    {...getFieldPersistenceProps(pdf.temporary_disk_bytes)}
                  />
                  <SettingField
                    setting={pdf.timeout_seconds}
                    value={formState.pdfTimeoutSeconds}
                    onChange={(value) => updateFormField("pdfTimeoutSeconds", value, pdf.timeout_seconds)}
                    unitAdornment={t("settings.advanced.fields.seconds")}
                    {...getFieldPersistenceProps(pdf.timeout_seconds)}
                  />
                  <SettingField
                    setting={pdf.cpu_time_seconds}
                    value={formState.pdfCpuTimeSeconds}
                    onChange={(value) => updateFormField("pdfCpuTimeSeconds", value, pdf.cpu_time_seconds)}
                    unitAdornment={t("settings.advanced.fields.seconds")}
                    {...getFieldPersistenceProps(pdf.cpu_time_seconds)}
                  />
                  <SettingField
                    setting={pdf.max_concurrent}
                    value={formState.pdfMaxConcurrent}
                    onChange={(value) => updateFormField("pdfMaxConcurrent", value, pdf.max_concurrent)}
                    {...getFieldPersistenceProps(pdf.max_concurrent)}
                  />
                  <SettingField
                    setting={pdf.queue_wait_seconds}
                    value={formState.pdfQueueWaitSeconds}
                    onChange={(value) => updateFormField("pdfQueueWaitSeconds", value, pdf.queue_wait_seconds)}
                    unitAdornment={t("settings.advanced.fields.seconds")}
                    {...getFieldPersistenceProps(pdf.queue_wait_seconds)}
                  />
                  <SettingField
                    setting={pdf.screen_derivative_enabled}
                    value={formState.pdfScreenDerivativeEnabled}
                    onChange={(value) => updateFormField("pdfScreenDerivativeEnabled", value, pdf.screen_derivative_enabled)}
                    {...getFieldPersistenceProps(pdf.screen_derivative_enabled)}
                  />
                  <SettingField
                    setting={pdf.screen_max_decoded_pixels}
                    value={formState.pdfScreenMaxDecodedPixels}
                    onChange={(value) => updateFormField("pdfScreenMaxDecodedPixels", value, pdf.screen_max_decoded_pixels)}
                    {...getFieldPersistenceProps(pdf.screen_max_decoded_pixels)}
                  />
                </SettingsGroup>
              )}
            </Stack>
          </SettingsGroup>
          <DirectoryIndexPolicyGroup scope="backend" />
          <DirectoryIndexPolicyGroup scope="companion" />
        </SettingsSectionList>
      )}
    </SettingsPage>
  );
}
