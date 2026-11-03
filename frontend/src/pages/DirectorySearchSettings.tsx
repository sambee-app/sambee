import { Alert, Button } from "@mui/material";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ByteSizeSettingField, SettingField } from "../components/Settings/IntegerSettingFields";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { SettingsLoadingState } from "../components/Settings/SettingsState";
import { SETTINGS_DATA_CACHE_KEYS } from "../components/Settings/settingsDataSources";
import { useCachedAsyncData } from "../hooks/useCachedAsyncData";
import { useSystemSettingPersistence } from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import {
  DIRECTORY_INDEX_POLICY_FIELDS,
  type DirectoryIndexPolicyField,
  type DirectoryIndexPolicyScope,
  type DirectoryIndexSettings,
  type DirectoryIndexSettingUpdate,
} from "../types";
import { getApiErrorMessage } from "../utils/apiErrors";

const DIRECTORY_INDEX_LOADERS = {
  backend: () => api.getDirectoryIndexSettings("backend"),
  companion: () => api.getDirectoryIndexSettings("companion"),
} as const;

function DirectoryIndexPolicyGroup({ scope }: { scope: DirectoryIndexPolicyScope }) {
  const { t } = useTranslation();
  const [loadError, setLoadError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<DirectoryIndexPolicyField, number | null>>>({});
  const handleLoadError = useCallback(
    (error: unknown) => setLoadError(getApiErrorMessage(error, t("settings.directorySearch.loadFailed"))),
    [t]
  );
  const { data, loading, refresh, setData } = useCachedAsyncData<DirectoryIndexSettings>({
    cacheKey: scope === "backend" ? SETTINGS_DATA_CACHE_KEYS.directoryIndexBackend : SETTINGS_DATA_CACHE_KEYS.directoryIndexCompanion,
    load: DIRECTORY_INDEX_LOADERS[scope],
    onError: handleLoadError,
  });
  const persistence = useSystemSettingPersistence<DirectoryIndexSettingUpdate>(
    (update, options) => api.updateDirectoryIndexSettings(scope, update, options),
    (error) => getApiErrorMessage(error, t("settings.directorySearch.saveFailed"))
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
    <SettingsGroup title={t(scope === "backend" ? "settings.directorySearch.backendTitle" : "settings.directorySearch.companionTitle")}>
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

export function DirectorySearchSettings({ dialogSafeHeader = false }: { dialogSafeHeader?: boolean }) {
  return (
    <SettingsPage category="admin-directory-search" dialogSafeHeader={dialogSafeHeader}>
      <SettingsSectionList>
        <DirectoryIndexPolicyGroup scope="backend" />
        <DirectoryIndexPolicyGroup scope="companion" />
      </SettingsSectionList>
    </SettingsPage>
  );
}
