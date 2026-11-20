import { useEffect, useState } from "preact/hooks";
import { DEFAULT_LANGUAGE, getAvailableLanguages, setLocale, setPreviewTextExpansion } from "../i18n";
import { useI18n } from "../i18n/useI18n";

export type PreviewDirection = "auto" | "ltr" | "rtl";
export type PreviewDataVariant = "standard" | "long";

export interface PreviewSettings {
  availableLanguages: string[];
  dataVariant: PreviewDataVariant;
  direction: PreviewDirection;
  language: string;
  languageError: string | null;
  textExpansion: boolean;
  onDataVariantChange: (variant: PreviewDataVariant) => void;
  onDirectionChange: (direction: PreviewDirection) => void;
  onLanguageChange: (language: string) => void;
  onTextExpansionChange: (enabled: boolean) => void;
  reset: () => Promise<void>;
}

const AVAILABLE_LANGUAGES = getAvailableLanguages();

export function usePreviewSettings(): PreviewSettings {
  const { language } = useI18n();
  const [direction, setDirection] = useState<PreviewDirection>("auto");
  const [dataVariant, setDataVariant] = useState<PreviewDataVariant>("standard");
  const [textExpansion, setTextExpansion] = useState(false);
  const [languageError, setLanguageError] = useState<string | null>(null);

  useEffect(() => {
    setPreviewTextExpansion(textExpansion);
    return () => setPreviewTextExpansion(false);
  }, [textExpansion]);

  const changeLanguage = async (nextLanguage: string) => {
    setLanguageError(null);
    try {
      await setLocale(nextLanguage);
    } catch (error) {
      setLanguageError(error instanceof Error ? error.message : "Could not change the preview language.");
    }
  };

  return {
    availableLanguages: AVAILABLE_LANGUAGES,
    dataVariant,
    direction,
    language,
    languageError,
    textExpansion,
    onDataVariantChange: setDataVariant,
    onDirectionChange: setDirection,
    onLanguageChange: (nextLanguage) => {
      void changeLanguage(nextLanguage);
    },
    onTextExpansionChange: setTextExpansion,
    reset: async () => {
      setDirection("auto");
      setDataVariant("standard");
      setTextExpansion(false);
      await changeLanguage(DEFAULT_LANGUAGE);
    },
  };
}
