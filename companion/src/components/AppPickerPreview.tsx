import { useEffect, useRef, useState } from "preact/hooks";
import { applyTheme, getDefaultTheme } from "../lib/theme";
import type { NativeApp } from "../types";
import { APP_PICKER_FALLBACK_WIDTH, AppPickerView, type AppPickerViewState } from "./AppPicker";
import { PreviewIndexLink } from "./PreviewIndexLink";
import { PreviewLocalizationControls } from "./PreviewLocalizationControls";
import { usePreviewSettings } from "./usePreviewSettings";
import "../styles/app-picker-preview.css";

const PREVIEW_TITLEBAR_HEIGHT = 38;

type PreviewThemeMode = "light" | "dark";
type PreviewStatus = "loaded" | "loading" | "empty" | "error";

const PREVIEW_ERROR_MESSAGE = "Mock backend error: failed to enumerate registered handlers for this file type.";
const PREVIEW_BROWSED_APP_PATH = "C:\\Program Files\\Custom Office\\Spreadsheet Studio.exe";
const PREVIEW_EXTENSIONS = ["xlsx", "docx", "png", "csv"] as const;
const LONG_PREVIEW_APP_SUFFIX = "Jahresabschlusszusammenstellungsprogramm";
const PREVIEW_APPS: NativeApp[] = [
  {
    name: "Editor",
    executable: "C:\\Program Files\\WindowsApps\\Microsoft.WindowsNotepad_11.2501.31.0_x64__8wekyb3d8bbwe\\Notepad\\Notepad.exe",
    icon: null,
    is_default: true,
    is_recommended: true,
  },
  {
    name: "LibreOffice Writer",
    executable: "C:\\Program Files\\LibreOffice\\program\\swriter.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "LibreOffice Calc",
    executable: "C:\\Program Files\\LibreOffice\\program\\scalc.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "WordPad Classic",
    executable: "C:\\Program Files\\Windows NT\\Accessories\\wordpad.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "Notepad++",
    executable: "C:\\Program Files\\Notepad++\\notepad++.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "Visual Studio Code",
    executable: "C:\\Users\\demo\\AppData\\Local\\Programs\\Microsoft VS Code\\Code.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "Paint",
    executable: "C:\\Windows\\System32\\mspaint.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "Photos",
    executable: "C:\\Program Files\\WindowsApps\\Microsoft.Windows.Photos_2025.11030.3001.0_x64__8wekyb3d8bbwe\\PhotosApp.exe",
    icon: null,
    is_default: false,
    is_recommended: true,
  },
  {
    name: "OnlyOffice Desktop Editors",
    executable: "C:\\Users\\demo\\AppData\\Local\\Programs\\ONLYOFFICE\\DesktopEditors\\DesktopEditors.exe",
    icon: null,
    is_default: false,
    is_recommended: false,
  },
  {
    name: "OpenOffice",
    executable: "C:\\Program Files\\OpenOffice 4\\program\\soffice.exe",
    icon: null,
    is_default: false,
    is_recommended: false,
  },
  {
    name: "CSV Toolkit",
    executable: "C:\\Tools\\csv-toolkit.exe",
    icon: null,
    is_default: false,
    is_recommended: false,
  },
  {
    name: "Hex Workshop",
    executable: "C:\\Program Files\\BreakPoint Software\\Hex Workshop\\hworks32.exe",
    icon: null,
    is_default: false,
    is_recommended: false,
  },
  {
    name: "Archive Viewer",
    executable: "C:\\Program Files\\Archive Viewer\\archive-viewer.exe",
    icon: null,
    is_default: false,
    is_recommended: false,
  },
  {
    name: "ImageMagick Display",
    executable: "C:\\Program Files\\ImageMagick-7.1.1-Q16\\display.exe",
    icon: null,
    is_default: false,
    is_recommended: false,
  },
];
const LONG_PREVIEW_APPS: NativeApp[] = PREVIEW_APPS.map((app) => ({
  ...app,
  name: `${app.name} ${LONG_PREVIEW_APP_SUFFIX}`,
  executable: `C:\\Program Files\\Unternehmenskommunikationssoftware\\${app.name}\\${LONG_PREVIEW_APP_SUFFIX}.exe`,
}));

function buildPreviewState(status: PreviewStatus, apps: NativeApp[]): AppPickerViewState {
  switch (status) {
    case "loading":
      return { kind: "loading" };
    case "empty":
      return { kind: "loaded", apps: [] };
    case "error":
      return { kind: "error", message: PREVIEW_ERROR_MESSAGE };
    default:
      return { kind: "loaded", apps };
  }
}

/** Browser-only preview for iterating on the app picker dialog without Tauri. */
export function AppPickerPreview() {
  const previewSettings = usePreviewSettings();
  const [themeMode, setThemeMode] = useState<PreviewThemeMode>("light");
  const [status, setStatus] = useState<PreviewStatus>("loaded");
  const [extension, setExtension] = useState<string>(PREVIEW_EXTENSIONS[0]);
  const [alwaysUse, setAlwaysUse] = useState(false);
  const [apps, setApps] = useState<NativeApp[]>(PREVIEW_APPS);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [previewHeight, setPreviewHeight] = useState(320);
  const panelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    applyTheme(getDefaultTheme(themeMode));
  }, [themeMode]);

  useEffect(() => {
    if (status !== "loaded") {
      setSelectedIndex(-1);
      return;
    }

    setSelectedIndex((currentIndex) => {
      if (apps.length === 0) {
        return -1;
      }

      return currentIndex >= 0 && currentIndex < apps.length ? currentIndex : 0;
    });
  }, [apps, status]);

  useEffect(() => {
    setApps(previewSettings.dataVariant === "long" ? LONG_PREVIEW_APPS : PREVIEW_APPS);
    setSelectedIndex(0);
  }, [previewSettings.dataVariant]);

  useEffect(() => {
    const panel = panelRef.current;
    if (!panel) {
      return;
    }

    const updatePreviewHeight = () => {
      const styles = window.getComputedStyle(panel);
      const borderTopWidth = Number.parseFloat(styles.borderTopWidth || "0");
      const borderBottomWidth = Number.parseFloat(styles.borderBottomWidth || "0");
      setPreviewHeight(Math.ceil(panel.scrollHeight + borderTopWidth + borderBottomWidth));
    };

    updatePreviewHeight();

    if (typeof ResizeObserver === "undefined") {
      return;
    }

    const observer = new ResizeObserver(() => {
      updatePreviewHeight();
    });

    observer.observe(panel);
    return () => {
      observer.disconnect();
    };
  }, [alwaysUse, apps, extension, selectedIndex, status, themeMode]);

  const previewState = buildPreviewState(status, apps);

  return (
    <main
      class={`app-picker-preview app-picker-preview--${status}`}
      dir={previewSettings.direction === "auto" ? undefined : previewSettings.direction}
      data-text-expansion={previewSettings.textExpansion ? "expanded" : "normal"}
      style={{
        "--app-picker-preview-width": `${APP_PICKER_FALLBACK_WIDTH}px`,
        "--app-picker-preview-height": `${previewHeight}px`,
        "--app-picker-preview-window-height": `${previewHeight + PREVIEW_TITLEBAR_HEIGHT}px`,
      }}
    >
      <header class="app-picker-preview__controls">
        <div class="app-picker-preview__nav">
          <PreviewIndexLink />
        </div>
        <div class="app-picker-preview__toolbar">
          <div class="app-picker-preview__group">
            <label class="app-picker-preview__field">
              <span>File extension</span>
              <select value={extension} onChange={(event) => setExtension((event.target as HTMLSelectElement).value)}>
                {PREVIEW_EXTENSIONS.map((value) => (
                  <option key={value} value={value}>
                    .{value}
                  </option>
                ))}
              </select>
            </label>

            <label class="app-picker-preview__field">
              <span>State</span>
              <select value={status} onChange={(event) => setStatus((event.target as HTMLSelectElement).value as PreviewStatus)}>
                <option value="loaded">Loaded</option>
                <option value="loading">Loading</option>
                <option value="empty">Empty</option>
                <option value="error">Error</option>
              </select>
            </label>

            <label class="app-picker-preview__field">
              <span>Theme</span>
              <select value={themeMode} onChange={(event) => setThemeMode((event.target as HTMLSelectElement).value as PreviewThemeMode)}>
                <option value="light">Light</option>
                <option value="dark">Dark</option>
              </select>
            </label>
            <PreviewLocalizationControls settings={previewSettings} />
          </div>

          <button
            type="button"
            class="app-picker-preview__toolbar-btn"
            onClick={() => {
              setThemeMode("light");
              setAlwaysUse(false);
              setSelectedIndex(0);
              setStatus("loaded");
              void previewSettings.reset();
            }}
          >
            Reset Preview
          </button>
        </div>
      </header>

      <div class="app-picker-preview__viewport">
        <div class="app-picker-preview__window">
          <div class="app-picker-preview__titlebar" aria-hidden="true">
            <div class="app-picker-preview__titlebar-label">Sambee Companion — Choose Application</div>
            <div class="app-picker-preview__titlebar-controls">
              <button type="button" class="app-picker-preview__titlebar-btn app-picker-preview__titlebar-btn--disabled" tabIndex={-1}>
                <span class="app-picker-preview__titlebar-icon app-picker-preview__titlebar-icon--minimize" />
              </button>
              <button type="button" class="app-picker-preview__titlebar-btn" tabIndex={-1}>
                <span class="app-picker-preview__titlebar-icon app-picker-preview__titlebar-icon--close" />
              </button>
            </div>
          </div>
          <div class="app-picker-preview__window-meta">
            {APP_PICKER_FALLBACK_WIDTH} x {previewHeight + PREVIEW_TITLEBAR_HEIGHT}
          </div>
          <AppPickerView
            extension={extension}
            state={previewState}
            selectedIndex={selectedIndex}
            alwaysUse={alwaysUse}
            onSelectIndex={setSelectedIndex}
            onAlwaysUseChange={setAlwaysUse}
            onOpen={() => {}}
            onCancel={() => {}}
            onBrowse={() => {
              setStatus("loaded");
              setApps((currentApps) => {
                const existingIndex = currentApps.findIndex((app) => app.executable === PREVIEW_BROWSED_APP_PATH);
                if (existingIndex >= 0) {
                  setSelectedIndex(existingIndex);
                  return currentApps;
                }

                const updatedApps = [
                  ...currentApps,
                  {
                    name: "Spreadsheet Studio",
                    executable: PREVIEW_BROWSED_APP_PATH,
                    icon: null,
                    is_default: false,
                    is_recommended: false,
                  },
                ];
                setSelectedIndex(updatedApps.length - 1);
                return updatedApps;
              });
            }}
            panelRef={panelRef}
          />
        </div>
      </div>
    </main>
  );
}
