import i18n from "i18next";
import { DEFAULT_LANGUAGE, resources, SUPPORTED_LANGUAGES, type SupportedLanguage } from "./resources";

export const LOCALE_STORAGE_KEY = "sambee.locale";
export const REGIONAL_LOCALE_STORAGE_KEY = "sambee.regional-locale";
export const REGIONAL_LOCALE_CHANGED_EVENT = "sambee:regional-locale-changed";

export interface CompanionLocalizationState {
  language: string;
  regional_locale: string;
  updated_at: string;
  source_origin: string;
}

let localeSideEffectsRegistered = false;
let currentRegionalLocale = DEFAULT_LANGUAGE;

function resolveLanguage(language?: string | null): SupportedLanguage {
  if (!language) {
    return DEFAULT_LANGUAGE;
  }

  const exactMatch = SUPPORTED_LANGUAGES.find((supportedLanguage) => supportedLanguage.toLowerCase() === language.toLowerCase());
  if (exactMatch) {
    return exactMatch;
  }

  const baseLanguage = language.split("-")[0]?.toLowerCase();
  const fallbackMatch = SUPPORTED_LANGUAGES.find((supportedLanguage) => supportedLanguage.toLowerCase() === baseLanguage);

  return fallbackMatch ?? DEFAULT_LANGUAGE;
}

function readStoredLanguage(): SupportedLanguage | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const storedLanguage = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return storedLanguage ? resolveLanguage(storedLanguage) : undefined;
  } catch {
    return undefined;
  }
}

function canonicalizeLocale(locale?: string | null): string | null {
  if (!locale) {
    return null;
  }

  try {
    return Intl.getCanonicalLocales(locale)[0] ?? null;
  } catch {
    return null;
  }
}

function readStoredRegionalLocale(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const storedLocale = window.localStorage.getItem(REGIONAL_LOCALE_STORAGE_KEY);
    return canonicalizeLocale(storedLocale) ?? undefined;
  } catch {
    return undefined;
  }
}

function persistLanguage(language: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, resolveLanguage(language));
  } catch {
    // Ignore storage failures; locale changes should still work for the current session.
  }
}

function persistRegionalLocale(locale: string): void {
  if (typeof window === "undefined") {
    return;
  }

  try {
    window.localStorage.setItem(REGIONAL_LOCALE_STORAGE_KEY, canonicalizeLocale(locale) ?? locale);
  } catch {
    // Ignore storage failures; locale changes should still work for the current session.
  }
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
    persistLanguage(language);
    syncDocumentLanguage(language);
  });
}

function resolveRegionalLocale(locale?: string | null): string {
  return (
    canonicalizeLocale(locale) ?? canonicalizeLocale(typeof navigator === "undefined" ? undefined : navigator.language) ?? DEFAULT_LANGUAGE
  );
}

function updateRegionalLocale(locale: string): void {
  currentRegionalLocale = resolveRegionalLocale(locale);
  persistRegionalLocale(currentRegionalLocale);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(REGIONAL_LOCALE_CHANGED_EVENT, {
        detail: { regionalLocale: currentRegionalLocale },
      })
    );
  }
}

export function getCurrentLanguage(): SupportedLanguage {
  return resolveLanguage(i18n.resolvedLanguage ?? i18n.language);
}

export function getCurrentRegionalLocale(): string {
  return currentRegionalLocale;
}

const initialLanguage = readStoredLanguage() ?? resolveLanguage(typeof navigator === "undefined" ? undefined : navigator.language);
currentRegionalLocale =
  readStoredRegionalLocale() ?? resolveRegionalLocale(typeof navigator === "undefined" ? undefined : navigator.language);

registerLocaleSideEffects();
syncDocumentLanguage(initialLanguage);

if (!i18n.isInitialized) {
  void i18n.init({
    resources,
    lng: initialLanguage,
    fallbackLng: DEFAULT_LANGUAGE,
    supportedLngs: SUPPORTED_LANGUAGES,
    defaultNS: "translation",
    interpolation: {
      escapeValue: false,
    },
    returnNull: false,
  });
}

export function translate(...args: Parameters<typeof i18n.t>): string {
  return i18n.t(...args) as string;
}

export async function setLocale(language: string): Promise<void> {
  await i18n.changeLanguage(resolveLanguage(language));
}

export async function applyCompanionLocalization(state: CompanionLocalizationState): Promise<void> {
  const systemLocale = typeof navigator === "undefined" ? DEFAULT_LANGUAGE : navigator.language;
  updateRegionalLocale(state.regional_locale === "browser" ? systemLocale : state.regional_locale);
  await setLocale(state.language === "browser" ? systemLocale : state.language);
}

export default i18n;
