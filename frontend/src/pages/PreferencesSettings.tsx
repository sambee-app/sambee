import ContentCopyIcon from "@mui/icons-material/ContentCopy";
import DeleteIcon from "@mui/icons-material/Delete";
import EditIcon from "@mui/icons-material/Edit";
import StarIcon from "@mui/icons-material/Star";
import { Box, Button, FormControl, InputLabel, MenuItem, Radio, Select, Typography } from "@mui/material";
import type { SelectChangeEvent } from "@mui/material/Select";
import axios from "axios";
import type { TFunction } from "i18next";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { CompactBadge as Chip } from "../components/CompactBadge";
import { ResponsiveDialogShell } from "../components/Dialog/ResponsiveDialogShell";
import { formSelectMenuProps, formSelectSx } from "../components/Form/FormLayout";
import { SettingSaveStatus } from "../components/Settings/SettingSaveStatus";
import { SettingsFieldHelp } from "../components/Settings/SettingsFieldHelp";
import { SettingsGroup } from "../components/Settings/SettingsGroup";
import { SettingsPage } from "../components/Settings/SettingsPage";
import { SettingsSectionList } from "../components/Settings/SettingsSectionList";
import { settingsDestructiveButtonSx, settingsUtilityButtonSx } from "../components/Settings/settingsButtonStyles";
import { getSettingsPageSurfaceColor } from "../components/Settings/settingsSurface";
import { ThemeEditorDialog } from "../components/Settings/ThemeEditorDialog";
import { useRestoreFocusAfterPending } from "../hooks/useRestoreFocusAfterPending";
import { getAvailableLanguages } from "../i18n";
import { useLocalePreferences } from "../i18n/LocalePreferencesProvider";
import { LANGUAGE_NAMES, type SupportedLanguage } from "../i18n/languages";
import { PSEUDO_LANGUAGE } from "../i18n/resources";
import api, { getThemeRequestError } from "../services/api";
import { useCurrentUserSetting } from "../services/userSettingsStore";
import { useSambeeTheme } from "../theme";
import { resolveThemePalette } from "../theme/palette";
import { editableDefinition, getThemeCopyName } from "../theme/themeDefinition";
import type { ThemeConfig } from "../theme/types";
import type { LanguagePreference } from "../types";
import { formatLocalizedDateTime, formatLocalizedNumber } from "../utils/localeFormatting";

const REGIONAL_LOCALE_OPTIONS = [
  "en-US",
  "en-GB",
  "de-DE",
  "fr-FR",
  "ja-JP",
  "zh-CN",
  "nl-NL",
  "it-IT",
  "ko-KR",
  "pl-PL",
  "pt-PT",
  "es-ES",
  "sv-SE",
] as const;
const REGIONAL_LOCALE_LABEL_KEYS = {
  "en-US": "settings.appearancePage.regionalLocaleOptions.enUS",
  "en-GB": "settings.appearancePage.regionalLocaleOptions.enGB",
  "de-DE": "settings.appearancePage.regionalLocaleOptions.deDE",
  "fr-FR": "settings.appearancePage.regionalLocaleOptions.frFR",
  "ja-JP": "settings.appearancePage.regionalLocaleOptions.jaJP",
  "zh-CN": "settings.appearancePage.regionalLocaleOptions.zhCN",
  "nl-NL": "settings.appearancePage.regionalLocaleOptions.nlNL",
  "it-IT": "settings.appearancePage.regionalLocaleOptions.itIT",
  "ko-KR": "settings.appearancePage.regionalLocaleOptions.koKR",
  "pl-PL": "settings.appearancePage.regionalLocaleOptions.plPL",
  "pt-PT": "settings.appearancePage.regionalLocaleOptions.ptPT",
  "es-ES": "settings.appearancePage.regionalLocaleOptions.esES",
  "sv-SE": "settings.appearancePage.regionalLocaleOptions.svSE",
} as const satisfies Record<(typeof REGIONAL_LOCALE_OPTIONS)[number], string>;
const THEME_SCOPE_LABEL_KEYS = {
  user: "settings.appearancePage.themeScopes.personal",
  site: "settings.appearancePage.themeScopes.site",
  "built-in": "settings.appearancePage.themeScopes.builtIn",
} as const satisfies Record<"user" | "site" | "built-in", string>;
const PREVIEW_DATE = new Date("2026-03-22T14:35:00Z");

function getLanguageOptionLabel(t: TFunction, language: SupportedLanguage): string {
  return language === PSEUDO_LANGUAGE ? t("settings.appearancePage.pseudoLanguageShortLabel") : LANGUAGE_NAMES[language];
}

function ThemePreview({ theme }: { theme: ThemeConfig }) {
  const colors = resolveThemePalette(theme);
  return (
    <Box sx={{ display: "flex", gap: 1, mt: 1.5 }}>
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: 1,
          bgcolor: colors.background.default,
          border: "1px solid",
          borderColor: "divider",
        }}
      />
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: 1,
          bgcolor: colors.text.primary,
          border: "1px solid",
          borderColor: "divider",
        }}
      />
      <Box sx={{ width: 40, height: 40, borderRadius: 1, bgcolor: theme.primary.main }} />
      <Box
        sx={{
          width: 40,
          height: 40,
          borderRadius: 1,
          bgcolor: colors.link.main,
          border: "1px solid",
          borderColor: "divider",
        }}
      />
    </Box>
  );
}

export function AppearanceSettings() {
  const {
    currentTheme,
    availableThemes,
    storedThemes = [],
    siteDefaultId = "sambee-light",
    isAdmin = false,
    refreshThemes,
  } = useSambeeTheme();
  const themeSetting = useCurrentUserSetting("appearance.theme_id");
  const languageSetting = useCurrentUserSetting("localization.language");
  const regionalLocaleSetting = useCurrentUserSetting("localization.regional_locale");
  const [pendingThemeId, setPendingThemeId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ThemeConfig | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [themeActionPending, setThemeActionPending] = useState(false);
  const [themeActionError, setThemeActionError] = useState<string | null>(null);
  const languageDescriptionId = useId();
  const restoreThemeFocus = useRestoreFocusAfterPending(themeSetting.pending || pendingThemeId !== null);
  const restoreLanguageFocus = useRestoreFocusAfterPending(languageSetting.pending);
  const restoreRegionalLocaleFocus = useRestoreFocusAfterPending(regionalLocaleSetting.pending);
  const { t } = useTranslation();
  const { languageLoadFailed, languagePreference, regionalLocalePreference, setLanguagePreference, setRegionalLocalePreference } =
    useLocalePreferences();
  const availableLanguages = getAvailableLanguages();
  const selectedLanguage = languagePreference === "browser" || availableLanguages.includes(languagePreference) ? languagePreference : "en";
  const languageError = languageSetting.error ?? (languageLoadFailed ? t("settings.appearancePage.languageLoadFailed") : null);
  const languageOptions = useMemo(
    () => [
      { value: "browser", label: t("settings.appearancePage.browserDefaultOption") },
      ...availableLanguages.map((language) => ({
        value: language,
        label: getLanguageOptionLabel(t, language),
      })),
    ],
    [availableLanguages, t]
  );

  const regionalLocaleOptions = useMemo(() => {
    const options: Array<{ value: string; label: string }> = [
      {
        value: "browser",
        label: t("settings.appearancePage.browserDefaultOption"),
      },
      ...REGIONAL_LOCALE_OPTIONS.map((locale) => ({
        value: locale,
        label: t(REGIONAL_LOCALE_LABEL_KEYS[locale]),
      })),
    ];

    if (regionalLocalePreference !== "browser" && !options.some((option) => option.value === regionalLocalePreference)) {
      options.push({ value: regionalLocalePreference, label: regionalLocalePreference });
    }

    return options;
  }, [regionalLocalePreference, t]);

  const handleLanguageChange = (event: SelectChangeEvent<string>) => {
    const nextLanguagePreference = event.target.value as LanguagePreference;
    languageSetting.clearError();
    void setLanguagePreference(nextLanguagePreference).catch(() => undefined);
  };

  const handleRegionalLocaleChange = (event: SelectChangeEvent<string>) => {
    const nextRegionalLocalePreference = event.target.value;
    regionalLocaleSetting.clearError();
    void setRegionalLocalePreference(nextRegionalLocalePreference).catch(() => undefined);
  };

  const handleThemeSelect = (themeId: string) => {
    if (!themeSetting.pending && pendingThemeId === null) {
      setPendingThemeId(themeId);
      themeSetting.clearError();
      void themeSetting
        .commit(themeId)
        .catch(() => undefined)
        .finally(() => setPendingThemeId(null));
    }
  };

  const selectedThemeId = pendingThemeId ?? currentTheme.id;
  const themeSelectionPending = themeSetting.pending || pendingThemeId !== null;
  const selectedTile = availableThemes.find((themeOption) => themeOption.id === selectedThemeId);
  const selectedStored = storedThemes.find((entry) => entry.id === selectedTile?.id);
  const selectedWritable = Boolean(selectedStored && (selectedStored.scope === "user" || isAdmin));

  const runThemeAction = async (action: () => Promise<void>) => {
    setThemeActionPending(true);
    setThemeActionError(null);
    try {
      await action();
      await refreshThemes?.();
    } catch (error) {
      setThemeActionError(getThemeRequestError(error));
    } finally {
      setThemeActionPending(false);
    }
  };

  const copyTheme = () => {
    if (!selectedTile) return;
    const scope = selectedWritable && selectedStored ? selectedStored.scope : "user";
    void runThemeAction(async () => {
      const name = getThemeCopyName(
        selectedTile.name,
        storedThemes.filter((candidate) => candidate.scope === scope).map((candidate) => candidate.definition.name),
        true
      );
      await api.createTheme({ ...editableDefinition(selectedTile), name }, scope);
    });
  };

  return (
    <SettingsPage category="appearance">
      <SettingsSectionList>
        <SettingsGroup title={t("settings.appearancePage.themeTitle")}>
          {(["user", "site", "built-in"] as const).map((scope) => {
            const options = availableThemes.filter(
              (option) =>
                (storedThemes.find((entry) => entry.id === option.id)?.scope ?? (option.id.startsWith("sambee-") ? "built-in" : "user")) ===
                scope
            );
            if (!options.length) return null;
            return (
              <Box key={scope} sx={{ mb: 2 }}>
                <Typography variant="subtitle1" sx={{ mb: 1 }}>
                  {t(THEME_SCOPE_LABEL_KEYS[scope])}
                </Typography>
                <Box
                  sx={{
                    display: "grid",
                    gridTemplateColumns: { xs: "1fr", sm: "repeat(2, minmax(0, 1fr))", md: "repeat(3, minmax(0, 1fr))" },
                    gap: 2,
                  }}
                >
                  {options.map((themeOption) => (
                    <Box
                      key={themeOption.id}
                      onClick={() => handleThemeSelect(themeOption.id)}
                      sx={{
                        position: "relative",
                        p: 3,
                        border: 2,
                        borderColor: selectedTile?.id === themeOption.id ? "primary.main" : "divider",
                        borderRadius: 1,
                        cursor: themeSelectionPending ? "default" : "pointer",
                        transition: "all 0.2s",
                        ...(themeSelectionPending
                          ? {}
                          : {
                              "&:hover": {
                                borderColor: selectedTile?.id === themeOption.id ? "primary.main" : "text.secondary",
                                bgcolor: "action.selected",
                              },
                            }),
                      }}
                    >
                      {siteDefaultId === themeOption.id && (
                        <Chip
                          label={t("settings.appearancePage.themeDefaultBadge")}
                          title={t("settings.appearancePage.themeSiteDefaultTitle")}
                          size="small"
                          variant="outlined"
                          sx={{ position: "absolute", top: 8, right: 8, bgcolor: "background.paper" }}
                        />
                      )}
                      <Box sx={{ display: "flex", alignItems: "center", mb: 1, minWidth: 0 }}>
                        <Radio
                          checked={selectedThemeId === themeOption.id}
                          disabled={themeSelectionPending}
                          slotProps={{ input: { "aria-label": themeOption.name } }}
                          onFocus={() => restoreThemeFocus()}
                          onClick={(event) => {
                            event.stopPropagation();
                            handleThemeSelect(themeOption.id);
                          }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              handleThemeSelect(themeOption.id);
                            }
                          }}
                        />
                        <Typography
                          component="span"
                          variant="subtitle1"
                          sx={{
                            ml: 1,
                            minWidth: 0,
                            overflowWrap: "anywhere",
                          }}
                        >
                          {themeOption.name}
                        </Typography>
                        {selectedThemeId === themeOption.id ? (
                          <Box sx={{ ml: "auto" }}>
                            <SettingSaveStatus
                              pending={themeSelectionPending}
                              saved={themeSetting.saved}
                              savingLabel={t("settings.saveStatus.saving")}
                              savedLabel={t("settings.saveStatus.saved")}
                            />
                          </Box>
                        ) : null}
                      </Box>
                      {themeOption.description && (
                        <Typography variant="body2" sx={{ mb: 2, color: "text.secondary" }}>
                          {themeOption.description}
                        </Typography>
                      )}
                      <ThemePreview theme={themeOption} />
                    </Box>
                  ))}
                </Box>
              </Box>
            );
          })}
          <Box sx={{ display: "flex", gap: 1, flexWrap: "wrap" }}>
            <Button
              variant="outlined"
              sx={settingsUtilityButtonSx}
              startIcon={<ContentCopyIcon />}
              onClick={copyTheme}
              disabled={!selectedTile || themeActionPending}
            >
              {t("common.actions.copy")}
            </Button>
            <Button
              variant="outlined"
              sx={settingsUtilityButtonSx}
              startIcon={<EditIcon />}
              onClick={() => selectedTile && setEditing(selectedTile)}
              disabled={!selectedTile || themeActionPending}
            >
              {t("common.actions.edit")}
            </Button>
            <Button
              variant="outlined"
              sx={settingsDestructiveButtonSx}
              startIcon={<DeleteIcon />}
              onClick={() => setConfirmDelete(true)}
              disabled={!selectedWritable || themeActionPending}
            >
              {t("common.actions.delete")}
            </Button>
            <Button
              variant="outlined"
              sx={settingsUtilityButtonSx}
              startIcon={<StarIcon />}
              onClick={() =>
                selectedTile &&
                void runThemeAction(async () => {
                  await api.setSiteDefaultTheme(selectedTile.id);
                })
              }
              disabled={
                !isAdmin ||
                !selectedTile ||
                Boolean(selectedStored?.scope === "user") ||
                siteDefaultId === selectedTile?.id ||
                themeActionPending
              }
            >
              {t("settings.appearancePage.themeSetDefault")}
            </Button>
          </Box>
          {themeActionError && <SettingsFieldHelp sx={{ color: "error.main" }}>{themeActionError}</SettingsFieldHelp>}
          {themeSetting.error ? <SettingsFieldHelp sx={{ color: "error.main" }}>{themeSetting.error}</SettingsFieldHelp> : null}
          {editing && (
            <ThemeEditorDialog
              key={editing.id}
              theme={editing}
              stored={storedThemes.find((entry) => entry.id === editing.id)}
              storedThemes={storedThemes}
              isAdmin={isAdmin}
              onClose={() => setEditing(null)}
              onSaved={async (themeId, isCopy) => {
                await refreshThemes?.();
                if (!isCopy && editing.id === selectedThemeId && themeId !== selectedThemeId) await themeSetting.commit(themeId);
              }}
            />
          )}
          <ResponsiveDialogShell
            open={confirmDelete}
            onClose={() => setConfirmDelete(false)}
            title={t("settings.appearancePage.themeDeleteTitle")}
            actions={
              <>
                <Button onClick={() => setConfirmDelete(false)} variant="outlined" sx={settingsUtilityButtonSx}>
                  {t("common.actions.cancel")}
                </Button>
                <Button
                  color="error"
                  variant="contained"
                  onClick={() => {
                    const target = selectedStored;
                    if (!target) return;
                    void runThemeAction(async () => {
                      try {
                        await api.deleteTheme(target);
                      } catch (error) {
                        if (axios.isAxiosError(error) && error.response?.status === 409) {
                          setConfirmDelete(false);
                          await refreshThemes?.();
                        }
                        throw error;
                      }
                      setConfirmDelete(false);
                    });
                  }}
                >
                  {t("common.actions.delete")}
                </Button>
              </>
            }
          >
            {selectedTile && (
              <Typography>{t("settings.appearancePage.themeDeleteDescription", { themeName: selectedTile.name })}</Typography>
            )}
          </ResponsiveDialogShell>
        </SettingsGroup>

        <SettingsGroup title={t("settings.appearancePage.localizationTitle")}>
          <Box sx={{ display: "grid", gridTemplateColumns: { xs: "1fr", md: "repeat(2, minmax(0, 1fr))" }, gap: 2.5 }}>
            <FormControl fullWidth>
              <InputLabel id="appearance-language-label">{t("settings.appearancePage.languageLabel")}</InputLabel>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                <Select
                  labelId="appearance-language-label"
                  value={selectedLanguage}
                  label={t("settings.appearancePage.languageLabel")}
                  onChange={handleLanguageChange}
                  onFocus={() => restoreLanguageFocus()}
                  disabled={languageSetting.pending}
                  error={Boolean(languageError)}
                  aria-describedby={languageDescriptionId}
                  sx={{ ...formSelectSx, flex: 1, minWidth: 0 }}
                  MenuProps={formSelectMenuProps}
                >
                  {languageOptions.map((option) => (
                    <MenuItem
                      key={option.value}
                      value={option.value}
                      aria-label={option.value === PSEUDO_LANGUAGE ? t("settings.appearancePage.pseudoLanguageOption") : undefined}
                    >
                      <span lang={option.value === "browser" || option.value === PSEUDO_LANGUAGE ? undefined : option.value}>
                        {option.label}
                      </span>
                    </MenuItem>
                  ))}
                </Select>
                <Box sx={{ width: 24, height: 24, flex: "0 0 24px" }}>
                  <SettingSaveStatus
                    pending={languageSetting.pending}
                    saved={languageSetting.saved}
                    savingLabel={t("settings.saveStatus.saving")}
                    savedLabel={t("settings.saveStatus.saved")}
                  />
                </Box>
              </Box>
              <SettingsFieldHelp id={languageDescriptionId} sx={languageError ? { color: "error.main" } : undefined}>
                {languageError ??
                  t(
                    selectedLanguage === PSEUDO_LANGUAGE
                      ? "settings.appearancePage.pseudoLanguageDescription"
                      : "settings.appearancePage.languageDescription"
                  )}
              </SettingsFieldHelp>
            </FormControl>

            <FormControl fullWidth>
              <InputLabel id="appearance-regional-locale-label">{t("settings.appearancePage.regionalLocaleLabel")}</InputLabel>
              <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
                <Select
                  labelId="appearance-regional-locale-label"
                  value={regionalLocalePreference}
                  label={t("settings.appearancePage.regionalLocaleLabel")}
                  onChange={handleRegionalLocaleChange}
                  onFocus={() => restoreRegionalLocaleFocus()}
                  disabled={regionalLocaleSetting.pending}
                  error={Boolean(regionalLocaleSetting.error)}
                  sx={{ ...formSelectSx, flex: 1, minWidth: 0 }}
                  MenuProps={formSelectMenuProps}
                >
                  {regionalLocaleOptions.map((option) => (
                    <MenuItem key={option.value} value={option.value}>
                      {option.label}
                    </MenuItem>
                  ))}
                </Select>
                <Box sx={{ width: 24, height: 24, flex: "0 0 24px" }}>
                  <SettingSaveStatus
                    pending={regionalLocaleSetting.pending}
                    saved={regionalLocaleSetting.saved}
                    savingLabel={t("settings.saveStatus.saving")}
                    savedLabel={t("settings.saveStatus.saved")}
                  />
                </Box>
              </Box>
              <SettingsFieldHelp sx={regionalLocaleSetting.error ? { color: "error.main" } : undefined}>
                {regionalLocaleSetting.error ?? t("settings.appearancePage.regionalLocaleDescription")}
              </SettingsFieldHelp>
            </FormControl>
          </Box>

          <FormControl
            fullWidth
            role="group"
            aria-labelledby="appearance-regional-preview-label"
            sx={{
              mt: 2.5,
            }}
          >
            <InputLabel id="appearance-regional-preview-label" shrink sx={{ px: 0.5, bgcolor: getSettingsPageSurfaceColor }}>
              {t("settings.appearancePage.regionalSettingsPreviewTitle")}
            </InputLabel>
            <Box
              sx={{
                p: 2,
                borderRadius: 1,
                border: "1px solid",
                borderColor: "divider",
              }}
            >
              <Typography variant="body2" sx={{ color: "text.secondary" }}>
                {formatLocalizedDateTime(PREVIEW_DATE, {
                  dateStyle: "full",
                  timeStyle: "short",
                })}
              </Typography>
              <Typography variant="body2" sx={{ mt: 0.75, color: "text.secondary" }}>
                {formatLocalizedNumber(1234567.89, {
                  maximumFractionDigits: 2,
                })}
              </Typography>
            </Box>
          </FormControl>
        </SettingsGroup>
      </SettingsSectionList>
    </SettingsPage>
  );
}
