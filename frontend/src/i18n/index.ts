import i18n from "i18next";
import { initReactI18next } from "react-i18next";
import { isCatalogLanguage, LANGUAGE_NAMES, matchBrowserLanguage, SHIPPING_LANGUAGES, type SupportedLanguage } from "./languages";
import { DEFAULT_LANGUAGE, PSEUDO_LANGUAGE, resources } from "./resources";

export const LOCALE_STORAGE_KEY = "sambee.locale";
export const REGIONAL_LOCALE_STORAGE_KEY = "sambee.regional-locale";
export const BROWSER_LANGUAGE_PREFERENCE = "browser";
export const BROWSER_REGIONAL_LOCALE_PREFERENCE = "browser";
export const DEFAULT_LANGUAGE_PREFERENCE = BROWSER_LANGUAGE_PREFERENCE;
export const DEFAULT_REGIONAL_LOCALE_PREFERENCE = BROWSER_REGIONAL_LOCALE_PREFERENCE;
export const LANGUAGE_PREFERENCE_CHANGED_EVENT = "sambee:language-preference-changed";
export const REGIONAL_LOCALE_CHANGED_EVENT = "sambee:regional-locale-changed";

export type LanguagePreference = SupportedLanguage | typeof BROWSER_LANGUAGE_PREFERENCE;
export type RegionalLocalePreference = string;

let localeSideEffectsRegistered = false;
let currentLanguagePreference: LanguagePreference = DEFAULT_LANGUAGE_PREFERENCE;
let currentRegionalLocalePreference: RegionalLocalePreference = DEFAULT_REGIONAL_LOCALE_PREFERENCE;
let currentRegionalLocale = DEFAULT_LANGUAGE;
let languageRequest = 0;
const catalogLoaders = import.meta.glob<{ default: Record<string, unknown> }>("./catalogs/*.json");
const draftLoaders = import.meta.env.DEV ? import.meta.glob<{ default: Record<string, unknown> }>("./drafts/*.json") : {};

export function isPseudoLanguageEnabled(isDevelopment: boolean = import.meta.env.DEV): boolean {
  return isDevelopment;
}

export function getAvailableLanguages(isDevelopment: boolean = import.meta.env.DEV): SupportedLanguage[] {
  if (!isPseudoLanguageEnabled(isDevelopment)) return [...SHIPPING_LANGUAGES];
  const drafts = Object.keys(LANGUAGE_NAMES).filter(
    (language) =>
      isCatalogLanguage(language) && !SHIPPING_LANGUAGES.includes(language) && Object.hasOwn(draftLoaders, `./drafts/${language}.json`)
  );
  return [...SHIPPING_LANGUAGES, ...drafts.filter(isCatalogLanguage), PSEUDO_LANGUAGE];
}

function getBrowserLocales(): string[] {
  if (typeof navigator === "undefined") {
    return [];
  }

  const locales = Array.isArray(navigator.languages) ? navigator.languages : [];
  if (locales.length > 0) {
    return locales.filter((locale): locale is string => Boolean(locale));
  }

  return navigator.language ? [navigator.language] : [];
}

function canonicalizeLocale(locale: string): string | null {
  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
  }
}

function resolveLanguage(language: string | undefined): SupportedLanguage {
  return language && (language === PSEUDO_LANGUAGE || isCatalogLanguage(language)) ? language : DEFAULT_LANGUAGE;
}

export function getBrowserLanguage() {
  return matchBrowserLanguage(getBrowserLocales());
}

function resolveRegionalLocalePreference(locale?: string | null): RegionalLocalePreference {
  if (!locale || locale === BROWSER_REGIONAL_LOCALE_PREFERENCE) {
    return DEFAULT_REGIONAL_LOCALE_PREFERENCE;
  }

  return canonicalizeLocale(locale) ?? DEFAULT_REGIONAL_LOCALE_PREFERENCE;
}

function resolveRegionalLocale(localePreference: RegionalLocalePreference): string {
  if (localePreference !== BROWSER_REGIONAL_LOCALE_PREFERENCE) {
    return canonicalizeLocale(localePreference) ?? DEFAULT_LANGUAGE;
  }

  for (const locale of getBrowserLocales()) {
    const canonicalized = canonicalizeLocale(locale);
    if (canonicalized) {
      return canonicalized;
    }
  }

  return DEFAULT_LANGUAGE;
}

function syncDocumentLanguage(language: string): void {
  if (typeof document === "undefined") {
    return;
  }

  const resolvedLanguage = resolveLanguage(language);
  document.documentElement.lang = resolvedLanguage;
  document.documentElement.dir = i18n.dir(resolvedLanguage);
}

function registerLocaleSideEffects(): void {
  if (localeSideEffectsRegistered) {
    return;
  }

  localeSideEffectsRegistered = true;
  i18n.on("languageChanged", (language) => {
    syncDocumentLanguage(language);
  });
}

export function getCurrentLanguage(): SupportedLanguage {
  return resolveLanguage(i18n.resolvedLanguage ?? i18n.language);
}

export function getCurrentLanguagePreference(): LanguagePreference {
  return currentLanguagePreference;
}

export function getCurrentRegionalLocalePreference(): RegionalLocalePreference {
  return currentRegionalLocalePreference;
}

export function getCurrentRegionalLocale(): string {
  return currentRegionalLocale;
}

function updateResolvedRegionalLocale(): void {
  currentRegionalLocale = resolveRegionalLocale(currentRegionalLocalePreference);
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(REGIONAL_LOCALE_CHANGED_EVENT, {
        detail: {
          regionalLocale: currentRegionalLocale,
          preference: currentRegionalLocalePreference,
        },
      })
    );
  }
}

currentRegionalLocale = resolveRegionalLocale(currentRegionalLocalePreference);

registerLocaleSideEffects();
syncDocumentLanguage(DEFAULT_LANGUAGE);

const initialization = i18n.isInitialized
  ? Promise.resolve()
  : i18n.use(initReactI18next).init({
      resources,
      lng: DEFAULT_LANGUAGE,
      fallbackLng: DEFAULT_LANGUAGE,
      load: "currentOnly",
      defaultNS: "translation",
      interpolation: {
        escapeValue: false,
      },
      react: {
        useSuspense: false,
      },
      returnNull: false,
    });

export function translate(...args: Parameters<typeof i18n.t>): string {
  return i18n.t(...args) as string;
}

export async function setLanguagePreference(languagePreference: string): Promise<void> {
  const request = ++languageRequest;
  const preference = languagePreference === BROWSER_LANGUAGE_PREFERENCE ? languagePreference : resolveLanguage(languagePreference);
  const language = preference === BROWSER_LANGUAGE_PREFERENCE ? getBrowserLanguage() : preference;
  await initialization;
  try {
    if (!i18n.hasResourceBundle(language, "translation")) {
      const load = catalogLoaders[`./catalogs/${language}.json`] ?? draftLoaders[`./drafts/${language}.json`];
      if (!load) throw new Error(`Catalog not found: ${language}`);
      const { default: catalog } = await load();
      i18n.addResourceBundle(language, "translation", catalog);
    }
  } catch (error) {
    console.warn("Could not load Sambee UI translations", { language, error });
    if (request !== languageRequest) return;
    await i18n.changeLanguage(DEFAULT_LANGUAGE);
    throw error;
  }
  if (request !== languageRequest) return;
  const preferenceChanged = currentLanguagePreference !== preference;
  currentLanguagePreference = preference;
  if (preferenceChanged && typeof window !== "undefined") {
    window.dispatchEvent(new Event(LANGUAGE_PREFERENCE_CHANGED_EVENT));
  }
  if (i18n.language !== language) {
    await i18n.changeLanguage(language);
  }
}

export async function setRegionalLocalePreference(regionalLocalePreference: string): Promise<void> {
  currentRegionalLocalePreference = resolveRegionalLocalePreference(regionalLocalePreference);
  updateResolvedRegionalLocale();
}

export async function setLocale(language: string): Promise<void> {
  await setLanguagePreference(language);
}

void setLanguagePreference(DEFAULT_LANGUAGE_PREFERENCE).catch(() => {
  // Loading already logged the failure and selected English.
});

export default i18n;
