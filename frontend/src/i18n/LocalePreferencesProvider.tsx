import { createContext, type ReactNode, useContext, useEffect, useMemo, useReducer, useState } from "react";
import { useCurrentUserSetting } from "../services/userSettingsStore";
import type { LanguagePreference, RegionalLocalePreference } from "../types";
import i18n, {
  setLanguagePreference as applyLanguagePreference,
  setRegionalLocalePreference as applyRegionalLocalePreference,
  DEFAULT_LANGUAGE_PREFERENCE,
  DEFAULT_REGIONAL_LOCALE_PREFERENCE,
  getCurrentLanguagePreference,
  getCurrentRegionalLocale,
  getCurrentRegionalLocalePreference,
  LANGUAGE_PREFERENCE_CHANGED_EVENT,
  REGIONAL_LOCALE_CHANGED_EVENT,
} from "./index";

interface LocalePreferencesContextValue {
  languagePreference: LanguagePreference;
  languageLoadFailed: boolean;
  regionalLocale: string;
  regionalLocalePreference: RegionalLocalePreference;
  setLanguagePreference: (languagePreference: LanguagePreference) => Promise<void>;
  setRegionalLocalePreference: (regionalLocalePreference: RegionalLocalePreference) => Promise<void>;
}

const LocalePreferencesContext = createContext<LocalePreferencesContextValue | undefined>(undefined);

export function LocalePreferencesProvider({ children }: { children: ReactNode }) {
  const languageSetting = useCurrentUserSetting("localization.language");
  const regionalLocaleSetting = useCurrentUserSetting("localization.regional_locale");
  const [languagePreference, setLanguagePreferenceState] = useState<LanguagePreference>(() => getCurrentLanguagePreference());
  const [languageLoadFailed, setLanguageLoadFailed] = useState(false);
  const [languageRetry, retryLanguageLoad] = useReducer((attempt: number) => attempt + 1, 0);
  const [regionalLocalePreference, setRegionalLocalePreferenceState] = useState<RegionalLocalePreference>(() =>
    getCurrentRegionalLocalePreference()
  );
  const [regionalLocale, setRegionalLocaleState] = useState<string>(() => getCurrentRegionalLocale());

  useEffect(() => {
    const syncFromI18n = () => {
      setLanguagePreferenceState(getCurrentLanguagePreference());
      setRegionalLocalePreferenceState(getCurrentRegionalLocalePreference());
      setRegionalLocaleState(getCurrentRegionalLocale());
    };

    i18n.on("languageChanged", syncFromI18n);
    window.addEventListener(LANGUAGE_PREFERENCE_CHANGED_EVENT, syncFromI18n);
    window.addEventListener(REGIONAL_LOCALE_CHANGED_EVENT, syncFromI18n);
    syncFromI18n();

    return () => {
      i18n.off("languageChanged", syncFromI18n);
      window.removeEventListener(LANGUAGE_PREFERENCE_CHANGED_EVENT, syncFromI18n);
      window.removeEventListener(REGIONAL_LOCALE_CHANGED_EVENT, syncFromI18n);
    };
  }, []);

  const requestedLanguage = languageSetting.confirmedValue ?? DEFAULT_LANGUAGE_PREFERENCE;
  // biome-ignore lint/correctness/useExhaustiveDependencies: Reapply after a failed catalog load.
  useEffect(() => {
    let revision = 0;
    const apply = () => {
      const request = ++revision;
      void applyLanguagePreference(requestedLanguage).then(
        () => {
          if (request === revision) setLanguageLoadFailed(false);
        },
        () => {
          if (request === revision) setLanguageLoadFailed(true);
        }
      );
    };
    apply();
    if (requestedLanguage === DEFAULT_LANGUAGE_PREFERENCE) window.addEventListener("languagechange", apply);
    return () => {
      revision += 1;
      window.removeEventListener("languagechange", apply);
    };
  }, [requestedLanguage, languageRetry]);

  const requestedRegion = regionalLocaleSetting.confirmedValue ?? DEFAULT_REGIONAL_LOCALE_PREFERENCE;
  useEffect(() => {
    const apply = () => {
      void applyRegionalLocalePreference(requestedRegion);
    };
    apply();
    if (requestedRegion === DEFAULT_REGIONAL_LOCALE_PREFERENCE) window.addEventListener("languagechange", apply);
    return () => window.removeEventListener("languagechange", apply);
  }, [requestedRegion]);

  const value = useMemo<LocalePreferencesContextValue>(
    () => ({
      languagePreference,
      languageLoadFailed,
      regionalLocale,
      regionalLocalePreference,
      setLanguagePreference: async (preference) => {
        await languageSetting.commit(preference);
        if (preference === requestedLanguage && languageLoadFailed) retryLanguageLoad();
      },
      setRegionalLocalePreference: regionalLocaleSetting.commit,
    }),
    [
      languageLoadFailed,
      languagePreference,
      languageSetting,
      regionalLocale,
      regionalLocalePreference,
      regionalLocaleSetting,
      requestedLanguage,
    ]
  );

  return <LocalePreferencesContext.Provider value={value}>{children}</LocalePreferencesContext.Provider>;
}

export function useLocalePreferences(): LocalePreferencesContextValue {
  const context = useContext(LocalePreferencesContext);
  if (!context) {
    throw new Error("useLocalePreferences must be used within a LocalePreferencesProvider");
  }

  return context;
}
