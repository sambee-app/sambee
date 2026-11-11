import { Alert, Box, Button, TextField } from "@mui/material";
import { useCallback, useEffect, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { formSelectMenuProps, formSelectSx } from "../components/Form/FormLayout";
import { ByteSizeSettingField, SettingField } from "../components/Settings/IntegerSettingFields";
import { SettingsFieldHelp } from "../components/Settings/SettingsFieldHelp";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsSelectMenuItem } from "../components/Settings/SettingsSelectMenuItem";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import { loadAdvancedSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import { SettingPersistenceAdornment, useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import type { AdvancedSystemSettings, AdvancedSystemSettingsUpdate, ImageConversionPreference, IntegerSystemSetting } from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

const IMAGE_PREFERENCE_CONTROL_MAX_WIDTH = 240;

interface AdvancedSettingsProps {
  dialogSafeHeader?: boolean;
  category?: "admin-system" | "admin-image-viewer" | "admin-pdf-viewer";
}

interface AdvancedSettingsFormState {
  imageConversionThresholdBytes: number | null;
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

function createFormState(settings: AdvancedSystemSettings): AdvancedSettingsFormState {
  return {
    imageConversionThresholdBytes: settings.image_conversion_threshold_bytes?.value ?? null,
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

function applyIntegerSettingUpdate(setting: IntegerSystemSetting, update: AdvancedSystemSettingsUpdate): IntegerSystemSetting {
  return setting.key === update.field && typeof update.value === "number"
    ? { ...setting, value: update.value, source: "database" }
    : setting;
}

function applyAdvancedSettingUpdate(settings: AdvancedSystemSettings, update: AdvancedSystemSettingsUpdate): AdvancedSystemSettings {
  if (typeof update.value === "string") {
    return {
      ...settings,
      image_conversion_preference: { ...settings.image_conversion_preference, value: update.value, source: "database" },
    };
  }
  const updateSetting = (setting: IntegerSystemSetting) => applyIntegerSettingUpdate(setting, update);
  const imagemagick = settings.preprocessors["imagemagick"];
  return {
    ...settings,
    image_conversion_threshold_bytes: settings.image_conversion_threshold_bytes
      ? updateSetting(settings.image_conversion_threshold_bytes)
      : undefined,
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

export function AdvancedSettings({ dialogSafeHeader = false, category = "admin-system" }: AdvancedSettingsProps) {
  const { t } = useTranslation();
  const preferenceId = useId();
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
  const preference = settings?.image_conversion_preference;
  const preferenceKey = "image_viewer.conversion_preference";
  const restorePreferenceFocus = useRestoreFocusAfterPending(persistence.isPending(preferenceKey));
  const persistPreference = async (value: ImageConversionPreference) => {
    const result = await persistence.persist({ field: preferenceKey, value }, preference?.value);
    if (result.status === "completed") {
      setCachedSettings((current) => (current ? applyAdvancedSettingUpdate(current, result.update) : current));
    }
  };
  const pdf = settings?.pdf;

  return (
    <SettingsPage
      category={category}
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
          {category === "admin-system" && settings.temporary_archive_download_size_bytes && (
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
          {category === "admin-image-viewer" && (
            <SettingsGroup>
              {settings.image_conversion_threshold_bytes && (
                <ByteSizeSettingField
                  setting={settings.image_conversion_threshold_bytes}
                  value={formState.imageConversionThresholdBytes}
                  onChange={(value) => updateFormField("imageConversionThresholdBytes", value, settings.image_conversion_threshold_bytes!)}
                  {...getFieldPersistenceProps(settings.image_conversion_threshold_bytes)}
                />
              )}
              {preference && (
                <Box sx={{ display: "flex", flexDirection: "column", gap: 1.5, py: 1.5 }}>
                  <TextField
                    id={preferenceId}
                    select
                    sx={{ width: "100%", maxWidth: { xs: "100%", sm: IMAGE_PREFERENCE_CONTROL_MAX_WIDTH } }}
                    label={t("settings.advanced.imageConversion.label")}
                    value={preference.value}
                    onFocus={() => restorePreferenceFocus()}
                    onChange={(event) => void persistPreference(event.target.value as ImageConversionPreference)}
                    disabled={persistence.isPending(preferenceKey)}
                    error={Boolean(persistence.fieldErrors[preferenceKey])}
                    slotProps={{
                      select: {
                        sx: formSelectSx,
                        MenuProps: formSelectMenuProps,
                        SelectDisplayProps: {
                          "aria-describedby": `${preferenceId}-description`,
                        },
                        renderValue: (value) =>
                          value === "size" ? t("settings.advanced.imageConversion.size") : t("settings.advanced.imageConversion.speed"),
                      },
                      input: {
                        endAdornment: (
                          <SettingPersistenceAdornment
                            pending={persistence.isPending(preferenceKey)}
                            saved={persistence.isSaved(preferenceKey)}
                            savingLabel={t("settings.saveStatus.saving")}
                            savedLabel={t("settings.saveStatus.saved")}
                          />
                        ),
                      },
                    }}
                  >
                    <SettingsSelectMenuItem
                      value="speed"
                      label={t("settings.advanced.imageConversion.speed")}
                      description={t("settings.advanced.imageConversion.speedDescription")}
                    />
                    <SettingsSelectMenuItem
                      value="size"
                      label={t("settings.advanced.imageConversion.size")}
                      description={t("settings.advanced.imageConversion.sizeDescription")}
                    />
                  </TextField>
                  <SettingsFieldHelp
                    id={`${preferenceId}-description`}
                    error={Boolean(persistence.fieldErrors[preferenceKey])}
                    sx={{ mx: 0 }}
                  >
                    {persistence.fieldErrors[preferenceKey] ?? t("settings.advanced.imageConversion.description")}
                  </SettingsFieldHelp>
                </Box>
              )}
              {imagemagick && (
                <>
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
                </>
              )}
            </SettingsGroup>
          )}
          {category === "admin-pdf-viewer" && pdf && (
            <SettingsGroup>
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
        </SettingsSectionList>
      )}
    </SettingsPage>
  );
}
