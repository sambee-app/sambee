import type { ComponentChildren } from "preact";
import { useEffect } from "preact/hooks";
import { applyTheme, getDefaultTheme } from "../lib/theme";
import { PreviewIndexLink } from "./PreviewIndexLink";
import { PreviewLocalizationControls } from "./PreviewLocalizationControls";
import type { PreviewSettings } from "./usePreviewSettings";
import "../styles/dialog-preview.css";

export type PreviewThemeMode = "light" | "dark";

interface DialogPreviewLayoutProps {
  title: string;
  themeMode: PreviewThemeMode;
  onThemeModeChange: (mode: PreviewThemeMode) => void;
  onReset: () => void;
  settings: PreviewSettings;
  controls?: ComponentChildren;
  children: ComponentChildren;
}

/** Shared browser-only layout for companion dialog previews. */
export function DialogPreviewLayout({
  title,
  themeMode,
  onThemeModeChange,
  onReset,
  settings,
  controls,
  children,
}: DialogPreviewLayoutProps) {
  useEffect(() => {
    applyTheme(getDefaultTheme(themeMode));
  }, [themeMode]);

  return (
    <main
      class="dialog-preview"
      dir={settings.direction === "auto" ? undefined : settings.direction}
      data-text-expansion={settings.textExpansion ? "expanded" : "normal"}
    >
      <header class="dialog-preview__controls">
        <div class="dialog-preview__nav">
          <PreviewIndexLink />
        </div>
        <div class="dialog-preview__toolbar">
          <div class="dialog-preview__group">
            <label class="dialog-preview__field">
              <span>{title}</span>
              <select
                value={themeMode}
                onChange={(event) => onThemeModeChange((event.target as HTMLSelectElement).value as PreviewThemeMode)}
              >
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            {controls}
            <PreviewLocalizationControls settings={settings} />
          </div>
          <button
            type="button"
            class="dialog-preview__toolbar-btn"
            onClick={() => {
              onReset();
              void settings.reset();
            }}
          >
            Reset Preview
          </button>
        </div>
      </header>

      <div class="dialog-preview__viewport">{children}</div>
    </main>
  );
}
