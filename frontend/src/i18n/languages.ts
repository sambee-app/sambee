export const LANGUAGE_NAMES = {
  en: "English",
  "zh-Hans": "简体中文",
  nl: "Nederlands",
  fr: "Français",
  de: "Deutsch",
  it: "Italiano",
  ko: "한국어",
  ja: "日本語",
  pl: "Polski",
  pt: "Português",
  es: "Español",
  sv: "Svenska",
} as const;

export type CatalogLanguage = keyof typeof LANGUAGE_NAMES;
export type SupportedLanguage = CatalogLanguage | "en-XA";

// Add a language only after both apps pass the localization release checks.
export const SHIPPING_LANGUAGES: readonly CatalogLanguage[] = ["en", "zh-Hans", "nl", "fr", "de", "it", "ko", "ja", "pl", "pt", "es", "sv"];

export function isCatalogLanguage(value: string): value is CatalogLanguage {
  return Object.hasOwn(LANGUAGE_NAMES, value);
}

export function matchBrowserLanguage(
  locales: readonly string[],
  supported: readonly CatalogLanguage[] = SHIPPING_LANGUAGES
): CatalogLanguage {
  for (const tag of locales) {
    try {
      const { language, script, region } = new Intl.Locale(tag);
      const candidate =
        language === "zh"
          ? script === "Hans" || (!script && (!region || region === "CN" || region === "SG"))
            ? "zh-Hans"
            : null
          : language;
      if (candidate && isCatalogLanguage(candidate) && supported.includes(candidate)) return candidate;
    } catch {
      // Ignore malformed entries and check the next browser preference.
    }
  }
  return "en";
}
