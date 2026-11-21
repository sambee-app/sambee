import { createInstance } from "i18next";
import { DEFAULT_LANGUAGE, resources } from "./resources";

export { DEFAULT_LANGUAGE };

const i18n = createInstance();
const catalogs = import.meta.glob<Record<string, unknown>>("./catalogs/*.json", { eager: true, import: "default" });
const drafts = import.meta.env.DEV ? import.meta.glob<Record<string, unknown>>("./drafts/*.json", { eager: true, import: "default" }) : {};
const bundledResources = {
  ...resources,
  ...Object.fromEntries(
    Object.entries({ ...drafts, ...catalogs }).map(([path, translation]) => [
      path.slice(path.lastIndexOf("/") + 1, -".json".length),
      { translation },
    ])
  ),
};

export const LOCALE_STORAGE_KEY = "sambee.locale";
export const REGIONAL_LOCALE_STORAGE_KEY = "sambee.regional-locale";
export const REGIONAL_LOCALE_CHANGED_EVENT = "sambee:regional-locale-changed";
export const PREVIEW_TEXT_EXPANSION_CHANGED_EVENT = "sambee:preview-text-expansion-changed";

const PREVIEW_WORD_EXPANSION_RATIO = 0.4;
const PREVIEW_EXPANDABLE_WORD = /[\p{L}\p{M}]{4,}/gu;

export interface CompanionLocalizationState {
  language: string;
  regional_locale: string;
  updated_at: string;
  source_origin: string;
}

let localeSideEffectsRegistered = false;
let currentRegionalLocale = DEFAULT_LANGUAGE;
let previewTextExpansionEnabled = false;

function hasLanguage(language: string): boolean {
  return Object.keys(bundledResources).includes(language);
}

function readStoredLanguage(): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  try {
    const storedLanguage = window.localStorage.getItem(LOCALE_STORAGE_KEY);
    return storedLanguage && hasLanguage(storedLanguage) ? storedLanguage : undefined;
  } catch {
    return undefined;
  }
}

export function canonicalizeLocale(locale?: string | null): string | null {
  if (!locale || locale.toLowerCase() === "browser") {
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
    window.localStorage.setItem(LOCALE_STORAGE_KEY, language);
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

  document.documentElement.lang = language;
  document.documentElement.dir = i18n.dir(language);
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

function getDeviceRegionalLocale(): string {
  return canonicalizeLocale(typeof navigator === "undefined" ? undefined : navigator.language) ?? DEFAULT_LANGUAGE;
}

function updateRegionalLocale(locale: string): void {
  currentRegionalLocale = locale;
  persistRegionalLocale(currentRegionalLocale);

  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(REGIONAL_LOCALE_CHANGED_EVENT, {
        detail: { regionalLocale: currentRegionalLocale },
      })
    );
  }
}

export function getCurrentLanguage(): string {
  return i18n.resolvedLanguage ?? i18n.language ?? DEFAULT_LANGUAGE;
}

export function getAvailableLanguages(): string[] {
  return Object.keys(bundledResources).sort();
}

export function getCurrentRegionalLocale(): string {
  return currentRegionalLocale;
}

const initialLanguage = readStoredLanguage() ?? DEFAULT_LANGUAGE;
currentRegionalLocale = readStoredRegionalLocale() ?? getDeviceRegionalLocale();

registerLocaleSideEffects();
syncDocumentLanguage(initialLanguage);

const initialization = i18n.init({
  resources: bundledResources,
  lng: initialLanguage,
  fallbackLng: DEFAULT_LANGUAGE,
  load: "currentOnly",
  defaultNS: "translation",
  interpolation: {
    escapeValue: false,
  },
  returnNull: false,
});

function expandPreviewText(text: string): string {
  return text.replace(PREVIEW_EXPANDABLE_WORD, (word) => {
    const characters = Array.from(word);
    const finalCharacter = characters[characters.length - 1];
    if (!finalCharacter) {
      return word;
    }

    const extraLength = Math.ceil(characters.length * PREVIEW_WORD_EXPANSION_RATIO);
    return `${word}${finalCharacter.repeat(extraLength)}`;
  });
}

export function setPreviewTextExpansion(enabled: boolean): void {
  if (previewTextExpansionEnabled === enabled) {
    return;
  }

  previewTextExpansionEnabled = enabled;
  if (typeof window !== "undefined") {
    window.dispatchEvent(new Event(PREVIEW_TEXT_EXPANSION_CHANGED_EVENT));
  }
}

export function translate(...args: Parameters<typeof i18n.t>): string {
  const translatedText = i18n.t(...args) as string;
  return previewTextExpansionEnabled ? expandPreviewText(translatedText) : translatedText;
}

export async function setLocale(language: string): Promise<void> {
  await initialization;
  if (!hasLanguage(language)) throw new Error(`Catalog not bundled: ${language}`);
  await i18n.changeLanguage(language);
}

export async function applyCompanionLocalization(state: CompanionLocalizationState): Promise<void> {
  const locale = canonicalizeLocale(state.regional_locale);
  if (!locale) throw new Error(`Invalid synced regional locale: ${state.regional_locale}`);
  await setLocale(state.language);
  updateRegionalLocale(locale);
}

export async function clearCompanionLocalization(): Promise<void> {
  await setLocale(DEFAULT_LANGUAGE);
  updateRegionalLocale(getDeviceRegionalLocale());
}

export default i18n;
