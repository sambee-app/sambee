import { Alert, Box, Button, TextField, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useCallback, useId, useState } from "react";
import { useTranslation } from "react-i18next";
import { FormFieldLabel, FormGroup, FormRow, FormSurface, formFieldControlSx, formOutlinedControlSx } from "../components/Form/FormLayout";
import { SettingSaveStatusAdornment } from "../components/Settings/SettingSaveStatus";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import { SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import { useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import {
  FILESYSTEM_SEARCH_POLICY_FIELDS,
  type FilesystemSearchPolicyField,
  type FilesystemSearchSettingUpdate,
  isApiError,
  type FilesystemSearchSettings as SettingsData,
} from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

const loadSettings = () => api.getFilesystemSearchSettings();

function PolicyField({
  field,
  setting,
  onSaved,
}: {
  field: FilesystemSearchPolicyField;
  setting: SettingsData["fields"][FilesystemSearchPolicyField];
  onSaved: (update: FilesystemSearchSettingUpdate) => void;
}) {
  const { t } = useTranslation();
  const desktop = useMediaQuery(useTheme().breakpoints.up("md"));
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [touched, setTouched] = useState(false);
  const persistence = useSystemSettingPersistence<FilesystemSearchSettingUpdate>(
    (update, options) => api.updateFilesystemSearchSettings(update, options),
    (error) => getApiErrorMessage(error, t("settings.filesystemSearch.saveFailed"))
  );
  const pending = persistence.isPending(field);
  const restoreFocus = useRestoreFocusAfterPending(pending);
  const raw = draft ?? String(setting.value);
  const value = Number(raw);
  const valid = /^\d+$/.test(raw) && Number.isSafeInteger(value) && value >= setting.min_value && value <= setting.max_value;
  const label = t(`settings.filesystemSearch.${field}.label`);
  const description = t("settings.filesystemSearch.bounds", {
    description: t(`settings.filesystemSearch.${field}.description`),
    defaultValue: setting.default_value,
    min: setting.min_value,
    max: setting.max_value,
  });
  const error =
    persistence.fieldErrors[field] ??
    (touched && !valid
      ? t("settings.filesystemSearch.validation", {
          min: setting.min_value,
          max: setting.max_value,
        })
      : null);
  const commit = async () => {
    setTouched(true);
    if (!valid) return;
    const result = await persistence.persist({ field, value }, setting.value);
    if (result.status === "completed") {
      onSaved(result.update);
      setDraft(String(result.update.value));
    }
  };
  return (
    <FormRow>
      {desktop && (
        <FormFieldLabel
          label={label}
          description={description}
          htmlFor={id}
          descriptionId={`${id}-help`}
          feedback={error ? { severity: "error", message: error } : null}
        />
      )}
      <Box sx={formFieldControlSx}>
        <TextField
          id={id}
          label={desktop ? undefined : label}
          size={desktop ? "small" : "medium"}
          value={raw}
          onChange={(event) => {
            setDraft(event.target.value);
            persistence.clearFieldFeedback(field);
          }}
          onFocus={restoreFocus}
          onBlur={() => void commit()}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void commit();
            }
          }}
          disabled={pending}
          error={Boolean(error)}
          helperText={desktop ? undefined : (error ?? description)}
          sx={[formOutlinedControlSx, { width: "100%" }]}
          slotProps={{
            htmlInput: { inputMode: "numeric", "aria-describedby": `${id}-help` },
            formHelperText: { id: `${id}-help` },
            input: {
              endAdornment: (
                <SettingSaveStatusAdornment
                  pending={pending}
                  saved={persistence.isSaved(field)}
                  savingLabel={t("settings.healthMonitoring.saving")}
                  savedLabel={t("settings.healthMonitoring.saved")}
                />
              ),
            },
          }}
        />
      </Box>
    </FormRow>
  );
}

export function FilesystemSearchSettings({ dialogSafeHeader = false }: { dialogSafeHeader?: boolean }) {
  const { t } = useTranslation();
  const [loadError, setLoadError] = useState<string | null>(null);
  const handleError = useCallback(
    (error: unknown) =>
      setLoadError(
        isApiError(error) && error.response?.status === 404
          ? t("settings.filesystemSearch.updateRequired")
          : getApiErrorMessage(error, t("settings.filesystemSearch.loadFailed"))
      ),
    [t]
  );
  const { data, loading, refresh, setData } = useCachedAsyncData<SettingsData>({
    cacheKey: SETTINGS_DATA_CACHE_KEYS.filesystemSearch,
    load: loadSettings,
    onError: handleError,
  });
  const onSaved = (update: FilesystemSearchSettingUpdate) => {
    setData((current) =>
      current
        ? {
            ...current,
            policy: { ...current.policy, [update.field]: update.value },
            fields: { ...current.fields, [update.field]: { ...current.fields[update.field], value: update.value, source: "database" } },
          }
        : current
    );
  };
  return (
    <SettingsPage category="admin-filesystem-search" dialogSafeHeader={dialogSafeHeader}>
      <SettingsSectionList>
        <SettingsGroup title={t("settings.filesystemSearch.group")}>
          <Typography variant="body2">{t("settings.filesystemSearch.changeNote")}</Typography>
          {loadError && (
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
          {loading && !data && <SettingsLoadingState />}
          {data && (
            <FormSurface>
              <FormGroup edge="both">
                {FILESYSTEM_SEARCH_POLICY_FIELDS.map((field) => (
                  <PolicyField key={field} field={field} setting={data.fields[field]} onSaved={onSaved} />
                ))}
              </FormGroup>
            </FormSurface>
          )}
        </SettingsGroup>
      </SettingsSectionList>
    </SettingsPage>
  );
}
