import { useEffect, useState } from "preact/hooks";
import i18n, { getCurrentLanguage, PREVIEW_TEXT_EXPANSION_CHANGED_EVENT, REGIONAL_LOCALE_CHANGED_EVENT, translate } from "./index";

export function useI18n() {
  const [, setRevision] = useState(0);

  useEffect(() => {
    const handleLanguageChanged = () => {
      setRevision((current) => current + 1);
    };

    i18n.on("languageChanged", handleLanguageChanged);
    window.addEventListener(PREVIEW_TEXT_EXPANSION_CHANGED_EVENT, handleLanguageChanged);
    window.addEventListener(REGIONAL_LOCALE_CHANGED_EVENT, handleLanguageChanged);

    return () => {
      i18n.off("languageChanged", handleLanguageChanged);
      window.removeEventListener(PREVIEW_TEXT_EXPANSION_CHANGED_EVENT, handleLanguageChanged);
      window.removeEventListener(REGIONAL_LOCALE_CHANGED_EVENT, handleLanguageChanged);
    };
  }, []);

  return {
    language: getCurrentLanguage(),
    t: translate as typeof translate,
  };
}
