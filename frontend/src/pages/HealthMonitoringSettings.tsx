import CheckCircleOutlineIcon from "@mui/icons-material/CheckCircleOutlined";
import RestartAltIcon from "@mui/icons-material/RestartAlt";
import {
  Alert,
  Box,
  Button,
  FormControl,
  FormControlLabel,
  InputLabel,
  MenuItem,
  Select,
  Stack,
  Switch,
  TextField,
  Typography,
  useMediaQuery,
  useTheme,
} from "@mui/material";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { DialogReadOnlyField } from "../components/Dialog/DialogReadOnlyField";
import {
  type FieldFeedback,
  FormFieldLabel,
  FormGroup,
  FormRow,
  FormSurface,
  formFieldControlSx,
  formOutlinedControlSx,
  formSelectControlSx,
  formSelectMenuProps,
  formSelectSx,
} from "../components/Form/FormLayout";
import { SettingSaveStatus, SettingSaveStatusAdornment } from "../components/Settings/SettingSaveStatus";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import { settingsFormSurfaceUtilityButtonSx } from "../components/Settings/settingsButtonStyles";
import { loadHealthMonitoringSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import { useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import { publishHealthMonitoringSettingsChanged } from "../services/healthMonitoringEvents";
import type {
  CpuTemperatureLimitOrigin,
  CpuTemperatureSourceSettings,
  HealthMonitoringAudience,
  HealthMonitoringIntegerField,
  HealthMonitoringSettings as HealthMonitoringSettingsData,
  HealthMonitoringSettingsUpdate,
} from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

const DECIMAL_ONE_PLACE_RE = /^(\d+)(?:\.(\d))?$/;
const DECIMAL_TWO_PLACES_RE = /^(\d+)(?:\.(\d{1,2}))?$/;
const MAX_SAFE_SCALED_INT = Number.MAX_SAFE_INTEGER;

function parseScaledTenths(raw: string): number | null {
  const trimmed = raw.trim();
  const match = DECIMAL_ONE_PLACE_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const whole = Number(match[1]);
  const tenths = match[2] ? Number(match[2]) : 0;
  if (!Number.isSafeInteger(whole)) {
    return null;
  }
  const scaled = whole * 10 + tenths;
  return Number.isSafeInteger(scaled) ? scaled : null;
}

function parseScaledHundredths(raw: string): number | null {
  const trimmed = raw.trim();
  const match = DECIMAL_TWO_PLACES_RE.exec(trimmed);
  if (!match) {
    return null;
  }
  const whole = Number(match[1]);
  const fracText = match[2] ?? "";
  const hundredths = fracText.length === 0 ? 0 : fracText.length === 1 ? Number(fracText) * 10 : Number(fracText);
  if (!Number.isSafeInteger(whole)) {
    return null;
  }
  const scaled = whole * 100 + hundredths;
  return Number.isSafeInteger(scaled) && scaled <= MAX_SAFE_SCALED_INT ? scaled : null;
}

function parseOverrideMillidegrees(raw: string): { valid: true; value: number | null } | { valid: false } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return { valid: true, value: null };
  }
  const tenths = parseScaledTenths(trimmed);
  if (tenths === null || tenths < 1) {
    return { valid: false };
  }
  const millidegrees = tenths * 100;
  if (!Number.isSafeInteger(millidegrees)) {
    return { valid: false };
  }
  return { valid: true, value: millidegrees };
}

function formatTenthsInput(tenths: number): string {
  return (tenths / 10).toFixed(1);
}

function formatHundredthsInput(hundredths: number): string {
  return (hundredths / 100).toFixed(2);
}

function formatMillidegreesInput(millidegrees: number | null): string {
  return millidegrees === null ? "" : (millidegrees / 1000).toFixed(1);
}

interface HealthMonitoringFieldUpdate {
  field: string;
  value: boolean | HealthMonitoringAudience | number | null;
  payload: HealthMonitoringSettingsUpdate;
}

function toFieldUpdate(payload: HealthMonitoringSettingsUpdate): HealthMonitoringFieldUpdate {
  if ("source_id" in payload) {
    const prefix = payload.field === "cpu_temp_warning_override" ? "cpu_warn" : "cpu_err";
    return { field: `${prefix}:${payload.source_id}`, value: payload.value_millidegrees, payload };
  }
  return { field: payload.field, value: payload.value, payload };
}

interface HealthMonitoringSettingsProps {
  dialogSafeHeader?: boolean;
}

export function HealthMonitoringSettings({ dialogSafeHeader = false }: HealthMonitoringSettingsProps) {
  const { t } = useTranslation();
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("md"));
  const baseId = useId();

  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState<Record<string, boolean>>({});
  const confirmedDraftsRef = useRef<Record<string, string>>({});
  const [cpuRefreshVersion, setCpuRefreshVersion] = useState(0);
  const [cpuRefreshError, setCpuRefreshError] = useState<string | null>(null);
  const persistence = useSystemSettingPersistence(
    async (update: HealthMonitoringFieldUpdate, options) =>
      toFieldUpdate(await api.updateHealthMonitoringSettings(update.payload, options)),
    (error) => getApiErrorMessage(error, t("settings.healthMonitoring.saveFailed"))
  );
  const { fieldErrors, clearFieldFeedback: clearFeedback } = persistence;

  const handleLoadError = useCallback(
    (error: unknown) => setLoadError(getApiErrorMessage(error, t("settings.healthMonitoring.loadFailed"))),
    [t]
  );

  const {
    data: settings,
    loading,
    refresh,
    setData: setSettings,
  } = useCachedAsyncData<HealthMonitoringSettingsData>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.adminHealthMonitoring,
    load: loadHealthMonitoringSettingsData,
    onError: handleLoadError,
  });

  const restoreEnabledFocus = useRestoreFocusAfterPending(persistence.isPending("enabled"));
  const restoreAudienceFocus = useRestoreFocusAfterPending(persistence.isPending("audience"));

  useEffect(() => {
    if (cpuRefreshVersion === 0) return;
    const controller = new AbortController();
    setCpuRefreshError(null);
    void api.getHealthMonitoringSettings({ signal: controller.signal }).then(
      (fresh) => {
        if (controller.signal.aborted) return;
        setSettings((current) =>
          current
            ? {
                ...current,
                cpu_sources: fresh.cpu_sources,
                cpu_sensor_discovery_status: fresh.cpu_sensor_discovery_status,
                cpu_sensor_discovery_message: fresh.cpu_sensor_discovery_message,
              }
            : current
        );
      },
      (error: unknown) => {
        if (!controller.signal.aborted) {
          setCpuRefreshError(
            `${t("settings.healthMonitoring.cpuRefreshFailed")} ${getApiErrorMessage(error, t("settings.healthMonitoring.loadFailed"))}`
          );
        }
      }
    );
    return () => controller.abort();
  }, [cpuRefreshVersion, setSettings, t]);

  useEffect(() => {
    if (!settings) {
      return;
    }
    const nextDrafts: Record<string, string> = {
      memory_warning_tenths_percent: formatTenthsInput(settings.policy.memory_warning_tenths_percent),
      memory_error_tenths_percent: formatTenthsInput(settings.policy.memory_error_tenths_percent),
      load_warning_hundredths: formatHundredthsInput(settings.policy.load_warning_hundredths),
      load_error_hundredths: formatHundredthsInput(settings.policy.load_error_hundredths),
      available_space_warning_tenths_percent: formatTenthsInput(settings.policy.available_space_warning_tenths_percent),
      available_space_error_tenths_percent: formatTenthsInput(settings.policy.available_space_error_tenths_percent),
    };
    for (const src of settings.cpu_sources) {
      nextDrafts[`cpu_warn:${src.source_id}`] = formatMillidegreesInput(src.warning_override_millidegrees);
      nextDrafts[`cpu_err:${src.source_id}`] = formatMillidegreesInput(src.error_override_millidegrees);
    }
    const previousConfirmed = confirmedDraftsRef.current;
    confirmedDraftsRef.current = nextDrafts;
    setDrafts((current) => {
      const merged = { ...nextDrafts };
      for (const key of Object.keys(nextDrafts)) {
        if (current[key] !== undefined && current[key] !== previousConfirmed[key]) {
          merged[key] = current[key];
        }
      }
      return merged;
    });
  }, [settings]);

  const commitSetting = async (
    fieldKey: string,
    payload: HealthMonitoringSettingsUpdate,
    options?: { skipUnchangedCheck?: boolean; currentValue?: unknown }
  ) => {
    const result = await persistence.persist(
      { ...toFieldUpdate(payload), field: fieldKey },
      options?.skipUnchangedCheck ? undefined : options?.currentValue
    );
    if (result.status !== "completed") return;
    const confirmed = result.update.payload;
    publishHealthMonitoringSettingsChanged();
    if ("source_id" in confirmed) {
      setCpuRefreshVersion((version) => version + 1);
      return;
    }
    setSettings((current) => {
      if (!current) return current;
      const policy = { ...current.policy, [confirmed.field]: confirmed.value };
      if (confirmed.field === "enabled") {
        return { ...current, policy, enabled: confirmed.value, enabled_source: "database" };
      }
      if (confirmed.field === "audience") {
        return { ...current, policy, audience: confirmed.value, audience_source: "database" };
      }
      return {
        ...current,
        policy,
        fields: {
          ...current.fields,
          [confirmed.field]: { ...current.fields[confirmed.field], value: confirmed.value, source: "database" },
        },
      };
    });
  };

  const validateIntegerField = (
    field: HealthMonitoringIntegerField,
    rawValue: string
  ): { valid: true; scaled: number } | { valid: false; error: string } => {
    if (!settings) {
      return { valid: false, error: "" };
    }
    if (field === "memory_warning_tenths_percent" || field === "memory_error_tenths_percent") {
      const scaled = parseScaledTenths(rawValue);
      if (scaled === null || scaled < 1 || scaled > 1000) {
        return { valid: false, error: t("settings.healthMonitoring.validation.memoryRange") };
      }
      if (field === "memory_warning_tenths_percent" && scaled > settings.policy.memory_error_tenths_percent) {
        return {
          valid: false,
          error: t("settings.healthMonitoring.validation.memoryPairWarningAboveError", {
            other: formatTenthsInput(settings.policy.memory_error_tenths_percent),
          }),
        };
      }
      if (field === "memory_error_tenths_percent" && scaled < settings.policy.memory_warning_tenths_percent) {
        return {
          valid: false,
          error: t("settings.healthMonitoring.validation.memoryPairErrorBelowWarning", {
            other: formatTenthsInput(settings.policy.memory_warning_tenths_percent),
          }),
        };
      }
      return { valid: true, scaled };
    }

    if (field === "load_warning_hundredths" || field === "load_error_hundredths") {
      const scaled = parseScaledHundredths(rawValue);
      if (scaled === null || scaled < 1) {
        return { valid: false, error: t("settings.healthMonitoring.validation.loadRange") };
      }
      if (field === "load_warning_hundredths" && scaled > settings.policy.load_error_hundredths) {
        return {
          valid: false,
          error: t("settings.healthMonitoring.validation.loadPairWarningAboveError", {
            other: formatHundredthsInput(settings.policy.load_error_hundredths),
          }),
        };
      }
      if (field === "load_error_hundredths" && scaled < settings.policy.load_warning_hundredths) {
        return {
          valid: false,
          error: t("settings.healthMonitoring.validation.loadPairErrorBelowWarning", {
            other: formatHundredthsInput(settings.policy.load_warning_hundredths),
          }),
        };
      }
      return { valid: true, scaled };
    }

    const scaled = parseScaledTenths(rawValue);
    if (scaled === null || scaled < 0 || scaled > 999) {
      return { valid: false, error: t("settings.healthMonitoring.validation.spaceRange") };
    }
    if (field === "available_space_warning_tenths_percent" && scaled < settings.policy.available_space_error_tenths_percent) {
      return {
        valid: false,
        error: t("settings.healthMonitoring.validation.spacePairWarningBelowError", {
          other: formatTenthsInput(settings.policy.available_space_error_tenths_percent),
        }),
      };
    }
    if (field === "available_space_error_tenths_percent" && scaled > settings.policy.available_space_warning_tenths_percent) {
      return {
        valid: false,
        error: t("settings.healthMonitoring.validation.spacePairErrorAboveWarning", {
          other: formatTenthsInput(settings.policy.available_space_warning_tenths_percent),
        }),
      };
    }
    return { valid: true, scaled };
  };

  const renderOriginText = (origin: CpuTemperatureLimitOrigin | null): string => {
    switch (origin) {
      case "hardware":
        return t("settings.healthMonitoring.fields.originHardware");
      case "kernel_policy":
        return t("settings.healthMonitoring.fields.originKernelPolicy");
      case "admin_override":
        return t("settings.healthMonitoring.fields.originAdminOverride");
      default:
        return "";
    }
  };

  const formatDetectedLimit = (millidegrees: number | null, origin: CpuTemperatureLimitOrigin | null): string => {
    if (millidegrees === null) {
      return t("settings.healthMonitoring.fields.notAvailable");
    }
    const originText = renderOriginText(origin);
    return originText ? `${(millidegrees / 1000).toFixed(1)} °C (${originText})` : `${(millidegrees / 1000).toFixed(1)} °C`;
  };

  const renderNumericRow = (field: HealthMonitoringIntegerField, label: string, description: string, step: string) => {
    if (!settings) return null;
    const inputId = `${baseId}-${field}`;
    const descId = `${baseId}-${field}-desc`;
    const draftValue = drafts[field] ?? "";
    const check = validateIntegerField(field, draftValue);
    const localError = touched[field] && !check.valid ? check.error : undefined;
    const activeError = fieldErrors[field] ?? localError;
    const pending = persistence.isPending(field);
    const saved = persistence.isSaved(field);
    const feedback: FieldFeedback = activeError ? { message: activeError, severity: "error" } : null;

    return (
      <FormRow key={field}>
        {isDesktop && (
          <FormFieldLabel htmlFor={inputId} label={label} description={description} descriptionId={descId} feedback={feedback} />
        )}
        <Box sx={formFieldControlSx}>
          <TextField
            id={inputId}
            fullWidth
            size={isDesktop ? "small" : "medium"}
            label={isDesktop ? undefined : label}
            value={draftValue}
            disabled={pending}
            error={Boolean(activeError)}
            helperText={isDesktop ? undefined : (activeError ?? description)}
            onChange={(event) => {
              setDrafts((prev) => ({ ...prev, [field]: event.target.value }));
              clearFeedback(field);
            }}
            onBlur={() => {
              setTouched((prev) => ({ ...prev, [field]: true }));
              const nextCheck = validateIntegerField(field, drafts[field] ?? "");
              if (nextCheck.valid) {
                void commitSetting(field, { field, value: nextCheck.scaled }, { currentValue: settings.policy[field] });
              }
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            sx={formOutlinedControlSx}
            slotProps={{
              htmlInput: {
                inputMode: "decimal",
                step,
                "aria-describedby": descId,
              },
              input: {
                endAdornment:
                  pending || saved ? (
                    <SettingSaveStatusAdornment
                      pending={pending}
                      saved={saved}
                      savingLabel={t("settings.healthMonitoring.saving")}
                      savedLabel={t("settings.healthMonitoring.saved")}
                    />
                  ) : undefined,
              },
            }}
          />
        </Box>
      </FormRow>
    );
  };

  const renderCpuOverrideRow = (src: CpuTemperatureSourceSettings, kind: "warning" | "error") => {
    const key = kind === "warning" ? `cpu_warn:${src.source_id}` : `cpu_err:${src.source_id}`;
    const updateField = kind === "warning" ? "cpu_temp_warning_override" : "cpu_temp_error_override";
    const confirmedOverride = kind === "warning" ? src.warning_override_millidegrees : src.error_override_millidegrees;
    const detectedSame = kind === "warning" ? src.detected_warning_millidegrees : src.detected_error_millidegrees;
    const otherEffective = kind === "warning" ? src.effective_error_millidegrees : src.effective_warning_millidegrees;
    const exceedsDetected = kind === "warning" ? src.warning_exceeds_detected : src.error_exceeds_detected;

    const label =
      kind === "warning"
        ? t("settings.healthMonitoring.fields.cpuWarningOverride")
        : t("settings.healthMonitoring.fields.cpuErrorOverride");
    const description =
      kind === "warning"
        ? t("settings.healthMonitoring.fields.cpuWarningOverrideDescription")
        : t("settings.healthMonitoring.fields.cpuErrorOverrideDescription");

    const draftVal = drafts[key] ?? "";
    const parsed = parseOverrideMillidegrees(draftVal);
    let localError: string | undefined;
    if (touched[key]) {
      if (!parsed.valid) {
        localError = t("settings.healthMonitoring.validation.cpuRange");
      } else if (parsed.value !== null && otherEffective !== null) {
        if (kind === "warning" && parsed.value > otherEffective) {
          localError = t("settings.healthMonitoring.validation.cpuPairWarningAboveError", {
            other: `${(otherEffective / 1000).toFixed(1)} °C`,
          });
        } else if (kind === "error" && parsed.value < otherEffective) {
          localError = t("settings.healthMonitoring.validation.cpuPairErrorBelowWarning", {
            other: `${(otherEffective / 1000).toFixed(1)} °C`,
          });
        }
      }
    }

    const activeError = fieldErrors[key] ?? localError;
    const exceedWarningText =
      !activeError && exceedsDetected && confirmedOverride !== null && detectedSame !== null
        ? t(
            kind === "warning"
              ? "settings.healthMonitoring.fields.exceedsDetectedWarning"
              : "settings.healthMonitoring.fields.exceedsDetectedError",
            {
              override: `${(confirmedOverride / 1000).toFixed(1)} °C`,
              detected: `${(detectedSame / 1000).toFixed(1)} °C`,
            }
          )
        : undefined;

    const feedback: FieldFeedback = activeError
      ? { message: activeError, severity: "error" }
      : exceedWarningText
        ? { message: exceedWarningText, severity: "warning" }
        : null;

    const inputId = `${baseId}-${key}`;
    const descId = `${baseId}-${key}-desc`;
    const pending = persistence.isPending(key);
    const saved = persistence.isSaved(key);

    return (
      <FormRow key={key}>
        {isDesktop && (
          <FormFieldLabel htmlFor={inputId} label={label} description={description} descriptionId={descId} feedback={feedback} />
        )}
        <Stack spacing={1} sx={{ width: "100%", alignItems: { md: "flex-end" } }}>
          <TextField
            id={inputId}
            fullWidth
            size={isDesktop ? "small" : "medium"}
            label={isDesktop ? undefined : label}
            placeholder={t("settings.healthMonitoring.fields.automaticPlaceholder")}
            value={draftVal}
            disabled={pending}
            error={Boolean(activeError)}
            helperText={isDesktop ? undefined : (activeError ?? exceedWarningText ?? description)}
            onChange={(event) => {
              setDrafts((prev) => ({ ...prev, [key]: event.target.value }));
              clearFeedback(key);
            }}
            onBlur={() => {
              setTouched((prev) => ({ ...prev, [key]: true }));
              const nextParsed = parseOverrideMillidegrees(drafts[key] ?? "");
              if (!nextParsed.valid) {
                return;
              }
              if (nextParsed.value === confirmedOverride) {
                return;
              }
              void commitSetting(
                key,
                {
                  field: updateField,
                  source_id: src.source_id,
                  value_millidegrees: nextParsed.value,
                },
                { skipUnchangedCheck: true }
              );
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.currentTarget.blur();
              }
            }}
            sx={formOutlinedControlSx}
            slotProps={{
              htmlInput: {
                inputMode: "decimal",
                "aria-describedby": descId,
              },
              inputLabel: { shrink: true },
              input: {
                endAdornment:
                  pending || saved ? (
                    <SettingSaveStatusAdornment
                      pending={pending}
                      saved={saved}
                      savingLabel={t("settings.healthMonitoring.saving")}
                      savedLabel={t("settings.healthMonitoring.saved")}
                    />
                  ) : undefined,
              },
            }}
          />
          {confirmedOverride !== null && (
            <Box sx={{ display: "flex", flexWrap: "wrap", gap: 1, justifyContent: { md: "flex-end" } }}>
              {(src.override_state === "review_required" || src.override_state === "conflict") && (
                <Button
                  variant="outlined"
                  size="small"
                  startIcon={<CheckCircleOutlineIcon />}
                  disabled={pending}
                  sx={settingsFormSurfaceUtilityButtonSx}
                  onClick={() => {
                    void commitSetting(
                      key,
                      {
                        field: updateField,
                        source_id: src.source_id,
                        value_millidegrees: confirmedOverride,
                      },
                      { skipUnchangedCheck: true }
                    );
                  }}
                >
                  {t("settings.healthMonitoring.fields.reconfirmOverride")}
                </Button>
              )}
              <Button
                variant="outlined"
                size="small"
                startIcon={<RestartAltIcon />}
                disabled={pending}
                sx={settingsFormSurfaceUtilityButtonSx}
                onClick={() => {
                  setDrafts((prev) => ({ ...prev, [key]: "" }));
                  void commitSetting(
                    key,
                    {
                      field: updateField,
                      source_id: src.source_id,
                      value_millidegrees: null,
                    },
                    { skipUnchangedCheck: true }
                  );
                }}
              >
                {t("settings.healthMonitoring.fields.returnToAutomatic")}
              </Button>
            </Box>
          )}
        </Stack>
      </FormRow>
    );
  };

  return (
    <SettingsPage category="admin-health-monitoring" dialogSafeHeader={dialogSafeHeader}>
      {loading && !settings && <SettingsLoadingState />}
      {cpuRefreshError && (
        <Alert
          severity="warning"
          role="status"
          action={<Button onClick={() => setCpuRefreshVersion((version) => version + 1)}>{t("common.actions.retry")}</Button>}
        >
          {cpuRefreshError}
        </Alert>
      )}
      {loadError && !settings && (
        <Box sx={{ pt: 2 }}>
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
        </Box>
      )}
      {settings && (
        <SettingsSectionList>
          <SettingsGroup title={t("settings.healthMonitoring.sections.visibility")}>
            <FormSurface>
              <FormGroup edge="both">
                <FormRow>
                  {isDesktop && (
                    <FormFieldLabel
                      htmlFor={`${baseId}-enabled`}
                      label={t("settings.healthMonitoring.fields.enabled")}
                      description={t("settings.healthMonitoring.fields.enabledDescription")}
                      descriptionId={`${baseId}-enabled-desc`}
                      feedback={fieldErrors["enabled"] ? { message: fieldErrors["enabled"], severity: "error" } : null}
                    />
                  )}
                  <Box sx={{ display: "flex", flexDirection: "column", alignItems: { md: "flex-end" } }}>
                    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1 }}>
                      <FormControlLabel
                        sx={{ m: 0 }}
                        control={
                          <Switch
                            id={`${baseId}-enabled`}
                            checked={settings.enabled}
                            disabled={persistence.isPending("enabled")}
                            onFocus={() => restoreEnabledFocus()}
                            onChange={(event) => {
                              void commitSetting(
                                "enabled",
                                { field: "enabled", value: event.target.checked },
                                { currentValue: settings.enabled }
                              );
                            }}
                            slotProps={{
                              input: {
                                "aria-label": t("settings.healthMonitoring.fields.enabled"),
                                "aria-describedby": `${baseId}-enabled-desc`,
                              },
                            }}
                          />
                        }
                        label={
                          isDesktop
                            ? settings.enabled
                              ? t("settings.healthMonitoring.fields.stateOn")
                              : t("settings.healthMonitoring.fields.stateOff")
                            : `${t("settings.healthMonitoring.fields.enabled")} (${
                                settings.enabled
                                  ? t("settings.healthMonitoring.fields.stateOn")
                                  : t("settings.healthMonitoring.fields.stateOff")
                              })`
                        }
                      />
                      <Box sx={{ width: 24, height: 24 }}>
                        <SettingSaveStatus
                          pending={persistence.isPending("enabled")}
                          saved={persistence.isSaved("enabled")}
                          savingLabel={t("settings.healthMonitoring.saving")}
                          savedLabel={t("settings.healthMonitoring.saved")}
                        />
                      </Box>
                    </Box>
                    {!isDesktop && (
                      <Typography
                        id={`${baseId}-enabled-desc`}
                        variant="caption"
                        sx={{ mt: 0.5, color: fieldErrors["enabled"] ? "error.main" : "text.secondary" }}
                      >
                        {fieldErrors["enabled"] ?? t("settings.healthMonitoring.fields.enabledDescription")}
                      </Typography>
                    )}
                  </Box>
                </FormRow>

                <FormRow>
                  {isDesktop && (
                    <FormFieldLabel
                      id={`${baseId}-audience-label`}
                      label={t("settings.healthMonitoring.fields.audience")}
                      description={t("settings.healthMonitoring.fields.audienceDescription")}
                      descriptionId={`${baseId}-audience-desc`}
                      feedback={fieldErrors["audience"] ? { message: fieldErrors["audience"], severity: "error" } : null}
                    />
                  )}
                  <Box sx={{ display: "flex", flexDirection: "column", alignItems: { md: "flex-end" }, width: "100%" }}>
                    <Box sx={{ display: "inline-flex", alignItems: "center", gap: 1, width: { xs: "100%", md: "auto" } }}>
                      <FormControl
                        size={isDesktop ? "small" : "medium"}
                        fullWidth={!isDesktop}
                        error={Boolean(fieldErrors["audience"])}
                        sx={[formOutlinedControlSx, isDesktop ? formSelectControlSx : {}]}
                      >
                        {!isDesktop && (
                          <InputLabel id={`${baseId}-audience-label`}>{t("settings.healthMonitoring.fields.audience")}</InputLabel>
                        )}
                        <Select
                          labelId={`${baseId}-audience-label`}
                          label={isDesktop ? undefined : t("settings.healthMonitoring.fields.audience")}
                          value={settings.audience}
                          disabled={persistence.isPending("audience")}
                          onFocus={() => restoreAudienceFocus()}
                          onChange={(event) => {
                            void commitSetting(
                              "audience",
                              { field: "audience", value: event.target.value as HealthMonitoringAudience },
                              { currentValue: settings.audience }
                            );
                          }}
                          sx={formSelectSx}
                          MenuProps={formSelectMenuProps}
                          inputProps={{ "aria-describedby": `${baseId}-audience-desc` }}
                        >
                          <MenuItem value="admins">{t("settings.healthMonitoring.fields.audienceOptions.admins")}</MenuItem>
                          <MenuItem value="editors">{t("settings.healthMonitoring.fields.audienceOptions.editors")}</MenuItem>
                          <MenuItem value="both">{t("settings.healthMonitoring.fields.audienceOptions.both")}</MenuItem>
                        </Select>
                      </FormControl>
                      <Box sx={{ width: 24, height: 24 }}>
                        <SettingSaveStatus
                          pending={persistence.isPending("audience")}
                          saved={persistence.isSaved("audience")}
                          savingLabel={t("settings.healthMonitoring.saving")}
                          savedLabel={t("settings.healthMonitoring.saved")}
                        />
                      </Box>
                    </Box>
                    {!isDesktop && (
                      <Typography
                        id={`${baseId}-audience-desc`}
                        variant="caption"
                        sx={{ mt: 0.5, color: fieldErrors["audience"] ? "error.main" : "text.secondary" }}
                      >
                        {fieldErrors["audience"] ?? t("settings.healthMonitoring.fields.audienceDescription")}
                      </Typography>
                    )}
                  </Box>
                </FormRow>
              </FormGroup>
            </FormSurface>
          </SettingsGroup>

          <SettingsGroup title={t("settings.healthMonitoring.sections.memoryThresholds")}>
            <FormSurface>
              <FormGroup edge="both">
                {renderNumericRow(
                  "memory_warning_tenths_percent",
                  t("settings.healthMonitoring.fields.memoryWarning"),
                  t("settings.healthMonitoring.fields.memoryWarningDescription"),
                  "0.1"
                )}
                {renderNumericRow(
                  "memory_error_tenths_percent",
                  t("settings.healthMonitoring.fields.memoryError"),
                  t("settings.healthMonitoring.fields.memoryErrorDescription"),
                  "0.1"
                )}
              </FormGroup>
            </FormSurface>
          </SettingsGroup>

          <SettingsGroup title={t("settings.healthMonitoring.sections.loadThresholds")}>
            <FormSurface>
              <FormGroup edge="both">
                {renderNumericRow(
                  "load_warning_hundredths",
                  t("settings.healthMonitoring.fields.loadWarning"),
                  t("settings.healthMonitoring.fields.loadWarningDescription"),
                  "0.01"
                )}
                {renderNumericRow(
                  "load_error_hundredths",
                  t("settings.healthMonitoring.fields.loadError"),
                  t("settings.healthMonitoring.fields.loadErrorDescription"),
                  "0.01"
                )}
              </FormGroup>
            </FormSurface>
          </SettingsGroup>

          <SettingsGroup title={t("settings.healthMonitoring.sections.storageThresholds")}>
            <FormSurface>
              <FormGroup edge="both">
                {renderNumericRow(
                  "available_space_warning_tenths_percent",
                  t("settings.healthMonitoring.fields.spaceWarning"),
                  t("settings.healthMonitoring.fields.spaceWarningDescription"),
                  "0.1"
                )}
                {renderNumericRow(
                  "available_space_error_tenths_percent",
                  t("settings.healthMonitoring.fields.spaceError"),
                  t("settings.healthMonitoring.fields.spaceErrorDescription"),
                  "0.1"
                )}
              </FormGroup>
            </FormSurface>
          </SettingsGroup>

          <SettingsGroup title={t("settings.healthMonitoring.sections.cpuTemperature")}>
            {settings.cpu_sources.length === 0 ? (
              <FormSurface>
                <Typography variant="body2" sx={{ color: "text.secondary" }}>
                  {settings.cpu_sensor_discovery_message ?? t("settings.healthMonitoring.fields.notAvailable")}
                </Typography>
              </FormSurface>
            ) : (
              <Stack spacing={2}>
                {settings.cpu_sources.map((src) => (
                  <FormSurface key={src.source_id}>
                    <Typography variant="subtitle2" sx={{ fontWeight: 600, mb: 1 }}>
                      {src.label} ({src.driver})
                    </Typography>
                    {src.override_notice && (
                      <Alert
                        severity={src.override_state === "conflict" ? "error" : "warning"}
                        role={src.override_state === "conflict" ? "alert" : "status"}
                        sx={{ mb: 2 }}
                      >
                        {src.override_notice}
                      </Alert>
                    )}
                    <FormGroup edge="both">
                      <FormRow>
                        <DialogReadOnlyField
                          label={t("settings.healthMonitoring.fields.cpuDetectedWarning")}
                          value={formatDetectedLimit(src.detected_warning_millidegrees, src.detected_limit_origin)}
                        />
                        <DialogReadOnlyField
                          label={t("settings.healthMonitoring.fields.cpuDetectedError")}
                          value={formatDetectedLimit(src.detected_error_millidegrees, src.detected_limit_origin)}
                        />
                      </FormRow>
                      {renderCpuOverrideRow(src, "warning")}
                      {renderCpuOverrideRow(src, "error")}
                    </FormGroup>
                  </FormSurface>
                ))}
              </Stack>
            )}
          </SettingsGroup>
        </SettingsSectionList>
      )}
    </SettingsPage>
  );
}
