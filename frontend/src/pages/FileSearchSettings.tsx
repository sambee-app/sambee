import { Add as AddIcon, Cancel as CancelIcon } from "@mui/icons-material";
import {
  Alert,
  Button,
  Checkbox,
  FormControl,
  FormControlLabel,
  FormGroup,
  FormHelperText,
  FormLabel,
  Stack,
  TextField,
} from "@mui/material";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { CompactBadge as Chip } from "../components/CompactBadge";
import { SettingsFieldHelp } from "../components/Settings/SettingsFieldHelp";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { settingsUtilityButtonSx } from "../components/Settings/settingsButtonStyles";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import {
  SettingPersistenceAdornment,
  SettingPersistenceIndicator,
  useSystemSettingPersistence,
} from "../hooks/useSystemSettingPersistence";
import api from "../services/api";
import { publishRecentDirectoriesChanged } from "../services/recentDirectoriesSync";
import { publishRecentFilesChanged } from "../services/recentFilesSync";
import type { FileSearchSettings as FileSearchSettingsModel, FileSearchSettingsUpdate } from "../types";

const DEFAULT_SETTINGS: FileSearchSettingsModel = {
  retention_limit: 200,
  result_limit: 10,
  excluded_categories: ["images", "temporary_backup"],
  excluded_extensions: [],
};

const EXTENSION_MAX_LENGTH = 255;
const INVALID_EXTENSION_CHARACTERS = /[*?[\]{}\\/,]/;

function normalizeExtension(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith(".") ? trimmed : `.${trimmed}`;
}

function isValidExtension(extension: string): boolean {
  return extension !== "." && extension.length <= EXTENSION_MAX_LENGTH && !INVALID_EXTENSION_CHARACTERS.test(extension);
}

function validateSettings(settings: FileSearchSettingsModel): {
  retention: string | null;
  results: string | null;
  extensions: string | null;
} {
  const retention = Number.isInteger(settings.retention_limit) && settings.retention_limit >= 0 && settings.retention_limit <= 500;
  const results = Number.isInteger(settings.result_limit) && settings.result_limit >= 1 && settings.result_limit <= 50;
  const invalidExtension = settings.excluded_extensions.some((extension) => !isValidExtension(extension));
  return {
    retention: retention ? null : "retention",
    results: results ? null : "results",
    extensions: invalidExtension ? "extensions" : null,
  };
}

export function FileSearchSettings() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<FileSearchSettingsModel>(DEFAULT_SETTINGS);
  const [confirmedSettings, setConfirmedSettings] = useState<FileSearchSettingsModel>(DEFAULT_SETTINGS);
  const [extensionInput, setExtensionInput] = useState("");
  const [extensionInputError, setExtensionInputError] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const persistence = useSystemSettingPersistence<FileSearchSettingsUpdate>(
    (update, options) => api.updateFileSearchSettings(update, options),
    () => t("settings.fileSearch.saveFailed")
  );
  const restoreCategoryFocus = useRestoreFocusAfterPending(persistence.isPending("excluded_categories"));
  const restoreExtensionFocus = useRestoreFocusAfterPending(persistence.isPending("excluded_extensions"));
  const validation = validateSettings(settings);

  useEffect(() => {
    void api
      .getFileSearchSettings()
      .then((response) => {
        setSettings(response.settings);
        setConfirmedSettings(response.settings);
        setExtensionInput("");
        setExtensionInputError(null);
        setLoadError(null);
      })
      .catch(() => setLoadError(t("settings.fileSearch.loadFailed")));
  }, [t]);

  const persistField = async (update: FileSearchSettingsUpdate) => {
    const result = await persistence.persist(update, confirmedSettings[update.field]);
    if (result.status === "completed") {
      setConfirmedSettings((current) => ({ ...current, [result.update.field]: result.update.value }));
      setSettings((current) => ({ ...current, [result.update.field]: result.update.value }));
      publishRecentFilesChanged();
      if (result.update.field === "retention_limit" || result.update.field === "result_limit") {
        publishRecentDirectoriesChanged();
      }
    }
  };

  const updateCategories = (category: "images" | "temporary_backup", checked: boolean) => {
    const excluded_categories = checked
      ? [...new Set([...settings.excluded_categories, category])]
      : settings.excluded_categories.filter((entry) => entry !== category);
    setSettings((current) => ({ ...current, excluded_categories }));
    void persistField({ field: "excluded_categories", value: excluded_categories });
  };

  const addExtension = () => {
    const normalizedExtension = normalizeExtension(extensionInput);
    if (!isValidExtension(normalizedExtension)) {
      setExtensionInputError(t("settings.fileSearch.excludedExtensionsError"));
      return;
    }
    if (settings.excluded_extensions.includes(normalizedExtension)) {
      setExtensionInputError(t("settings.fileSearch.excludedExtensionsDuplicateError"));
      return;
    }
    setSettings((current) => ({ ...current, excluded_extensions: [...current.excluded_extensions, normalizedExtension] }));
    void persistField({ field: "excluded_extensions", value: [...settings.excluded_extensions, normalizedExtension] });
    setExtensionInput("");
    setExtensionInputError(null);
  };

  const removeExtension = (extension: string) => {
    const excluded_extensions = settings.excluded_extensions.filter((entry) => entry !== extension);
    setSettings((current) => ({ ...current, excluded_extensions }));
    void persistField({ field: "excluded_extensions", value: excluded_extensions });
  };

  const normalizedExtensionPreview = extensionInput.trim() ? normalizeExtension(extensionInput) : null;

  return (
    <SettingsPage category="admin-file-search" contextualNotice={loadError ? <Alert severity="error">{loadError}</Alert> : null}>
      <SettingsGroup title={t("settings.fileSearch.title")}>
        <Stack spacing={2} sx={{ maxWidth: 480 }}>
          <TextField
            label={t("settings.fileSearch.retentionLimit")}
            type="number"
            value={Number.isNaN(settings.retention_limit) ? "" : settings.retention_limit}
            error={Boolean(validation.retention)}
            helperText={
              persistence.fieldErrors["retention_limit"] ??
              (validation.retention ? t("settings.fileSearch.retentionLimitError") : undefined)
            }
            onChange={(event) => {
              persistence.clearFieldFeedback("retention_limit");
              setSettings((current) => ({
                ...current,
                retention_limit: event.target.value === "" ? Number.NaN : Number(event.target.value),
              }));
            }}
            onBlur={() => {
              if (!validation.retention) void persistField({ field: "retention_limit", value: settings.retention_limit });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            disabled={persistence.isPending("retention_limit")}
            slotProps={{
              htmlInput: { min: 0, max: 500 },
              input: {
                endAdornment:
                  persistence.isPending("retention_limit") || persistence.isSaved("retention_limit") ? (
                    <SettingPersistenceAdornment
                      pending={persistence.isPending("retention_limit")}
                      saved={persistence.isSaved("retention_limit")}
                      savingLabel="Saving recent-files retention"
                      savedLabel="Recent-files retention saved"
                    />
                  ) : null,
              },
            }}
          />
          <TextField
            label={t("settings.fileSearch.resultLimit")}
            type="number"
            value={Number.isNaN(settings.result_limit) ? "" : settings.result_limit}
            error={Boolean(validation.results)}
            helperText={
              persistence.fieldErrors["result_limit"] ?? (validation.results ? t("settings.fileSearch.resultLimitError") : undefined)
            }
            onChange={(event) => {
              persistence.clearFieldFeedback("result_limit");
              setSettings((current) => ({
                ...current,
                result_limit: event.target.value === "" ? Number.NaN : Number(event.target.value),
              }));
            }}
            onBlur={() => {
              if (!validation.results) void persistField({ field: "result_limit", value: settings.result_limit });
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
            }}
            disabled={persistence.isPending("result_limit")}
            slotProps={{
              htmlInput: { min: 1, max: 50 },
              input: {
                endAdornment:
                  persistence.isPending("result_limit") || persistence.isSaved("result_limit") ? (
                    <SettingPersistenceAdornment
                      pending={persistence.isPending("result_limit")}
                      saved={persistence.isSaved("result_limit")}
                      savingLabel="Saving result limit"
                      savedLabel="Result limit saved"
                    />
                  ) : null,
              },
            }}
          />
          <FormControl
            component="fieldset"
            variant="standard"
            sx={{
              border: 1,
              borderColor: "divider",
              borderRadius: 1,
              px: 1.5,
              py: 1,
            }}
          >
            <FormLabel component="legend" sx={{ color: "text.primary", fontSize: "0.875rem", fontWeight: 500 }}>
              <Stack direction="row" spacing={1} sx={{ alignItems: "center" }}>
                {t("settings.fileSearch.excludedCategories")}
                <SettingPersistenceIndicator
                  pending={persistence.isPending("excluded_categories")}
                  saved={persistence.isSaved("excluded_categories")}
                  savingLabel="Saving excluded categories"
                  savedLabel="Excluded categories saved"
                />
              </Stack>
            </FormLabel>
            <SettingsFieldHelp>{t("settings.fileSearch.excludedCategoriesHelp")}</SettingsFieldHelp>
            <FormGroup sx={{ gap: 0.25, mt: 0.5 }}>
              <FormControlLabel
                control={
                  <Checkbox
                    checked={settings.excluded_categories.includes("images")}
                    onChange={(event) => updateCategories("images", event.target.checked)}
                    onFocus={() => restoreCategoryFocus()}
                    disabled={persistence.isPending("excluded_categories")}
                  />
                }
                label={t("settings.fileSearch.excludeImages")}
              />
              <FormControlLabel
                control={
                  <Checkbox
                    checked={settings.excluded_categories.includes("temporary_backup")}
                    onChange={(event) => updateCategories("temporary_backup", event.target.checked)}
                    onFocus={() => restoreCategoryFocus()}
                    disabled={persistence.isPending("excluded_categories")}
                  />
                }
                label={t("settings.fileSearch.excludeTemporaryBackup")}
              />
            </FormGroup>
            {persistence.fieldErrors["excluded_categories"] ? (
              <FormHelperText error>{persistence.fieldErrors["excluded_categories"]}</FormHelperText>
            ) : null}
          </FormControl>
          <Stack spacing={1}>
            <TextField
              label={t("settings.fileSearch.excludedExtensionsInputLabel")}
              value={extensionInput}
              error={Boolean(validation.extensions || extensionInputError)}
              helperText={
                extensionInputError ??
                persistence.fieldErrors["excluded_extensions"] ??
                (validation.extensions
                  ? t("settings.fileSearch.excludedExtensionsError")
                  : normalizedExtensionPreview && isValidExtension(normalizedExtensionPreview)
                    ? t("settings.fileSearch.excludedExtensionsNormalization", { extension: normalizedExtensionPreview })
                    : t("settings.fileSearch.excludedExtensionsHelp"))
              }
              onChange={(event) => {
                setExtensionInput(event.target.value);
                setExtensionInputError(null);
                persistence.clearFieldFeedback("excluded_extensions");
              }}
              onFocus={() => restoreExtensionFocus()}
              disabled={persistence.isPending("excluded_extensions")}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  addExtension();
                }
              }}
            />
            <Button
              variant="outlined"
              startIcon={<AddIcon />}
              disabled={!extensionInput.trim() || persistence.isPending("excluded_extensions")}
              onClick={addExtension}
              onFocus={() => restoreExtensionFocus()}
              sx={[settingsUtilityButtonSx, { alignSelf: "flex-start" }]}
            >
              {t("settings.fileSearch.excludedExtensionsAdd")}
            </Button>
            {settings.excluded_extensions.length > 0 ? (
              <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: "wrap" }}>
                {settings.excluded_extensions.map((extension) => (
                  <Chip
                    key={extension}
                    label={extension}
                    disabled={persistence.isPending("excluded_extensions")}
                    onDelete={() => removeExtension(extension)}
                    onFocus={() => restoreExtensionFocus()}
                    deleteIcon={<CancelIcon aria-label={t("settings.fileSearch.excludedExtensionsRemove", { extension })} />}
                  />
                ))}
              </Stack>
            ) : null}
          </Stack>
        </Stack>
      </SettingsGroup>
    </SettingsPage>
  );
}
