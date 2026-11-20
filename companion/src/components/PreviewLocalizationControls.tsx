import type { PreviewSettings } from "./usePreviewSettings";
import "../styles/preview-localization-controls.css";

const LANGUAGE_DISPLAY_NAMES = new Intl.DisplayNames(["en"], { type: "language" });

function getLanguageLabel(language: string): string {
  if (language === "en-XA") {
    return "Pseudo-English (en-XA)";
  }

  return `${LANGUAGE_DISPLAY_NAMES.of(language) ?? language} (${language})`;
}

interface PreviewLocalizationControlsProps {
  settings: PreviewSettings;
}

export function PreviewLocalizationControls({ settings }: PreviewLocalizationControlsProps) {
  return (
    <div class="preview-localization-controls">
      <label class="preview-localization-controls__field">
        <span>Language</span>
        <select value={settings.language} onChange={(event) => settings.onLanguageChange((event.target as HTMLSelectElement).value)}>
          {settings.availableLanguages.map((language) => (
            <option key={language} value={language}>
              {getLanguageLabel(language)}
            </option>
          ))}
        </select>
      </label>

      <label class="preview-localization-controls__field">
        <span>Direction</span>
        <select
          value={settings.direction}
          onChange={(event) => settings.onDirectionChange((event.target as HTMLSelectElement).value as PreviewSettings["direction"])}
        >
          <option value="auto">Auto (language)</option>
          <option value="ltr">Left to right</option>
          <option value="rtl">Right to left (layout only)</option>
        </select>
      </label>

      <label class="preview-localization-controls__field">
        <span>Text length</span>
        <select
          value={settings.textExpansion ? "expanded" : "normal"}
          onChange={(event) => settings.onTextExpansionChange((event.target as HTMLSelectElement).value === "expanded")}
        >
          <option value="normal">Normal</option>
          <option value="expanded">Expanded words</option>
        </select>
      </label>

      <label class="preview-localization-controls__field">
        <span>Mock data</span>
        <select
          value={settings.dataVariant}
          onChange={(event) => settings.onDataVariantChange((event.target as HTMLSelectElement).value as PreviewSettings["dataVariant"])}
        >
          <option value="standard">Standard</option>
          <option value="long">Long names and paths</option>
        </select>
      </label>

      {settings.languageError && (
        <p class="preview-localization-controls__error" role="alert">
          {settings.languageError}
        </p>
      )}
    </div>
  );
}
