import { Alert, Button, Stack } from "@mui/material";
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ByteSizeSettingField, SettingField } from "../components/Settings/IntegerSettingFields";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import { loadAdvancedSettingsData, SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import type { AdvancedSystemSettings, AdvancedSystemSettingsUpdate, IntegerSystemSetting } from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

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
        </SettingsSectionList>
      )}
    </SettingsPage>
  );
}
