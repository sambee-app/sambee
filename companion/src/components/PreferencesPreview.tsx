import { clearMocks, mockIPC } from "@tauri-apps/api/mocks";
import { useEffect, useRef, useState } from "preact/hooks";
import type { CompanionLocalizationState } from "../i18n";
import { DialogPreviewLayout, type PreviewThemeMode } from "./DialogPreviewLayout";
import { Preferences } from "./Preferences";
import { usePreviewSettings } from "./usePreviewSettings";

type SyncState = "synchronized" | "waiting" | "failed" | "unpaired";

export function PreferencesPreview() {
  const settings = usePreviewSettings();
  const [themeMode, setThemeMode] = useState<PreviewThemeMode>("light");
  const [customTheme, setCustomTheme] = useState(false);
  const [syncState, setSyncState] = useState<SyncState>("synchronized");
  const [resetCount, setResetCount] = useState(0);
  const [open, setOpen] = useState(true);
  const [ready, setReady] = useState(false);
  const origin = settings.dataVariant === "long" ? "https://files.example-with-a-long-server-name.example" : "https://files.example.test";
  const fixture = useRef({ origin, syncState, language: settings.language });
  fixture.current = { origin, syncState, language: settings.language };
  const unpaired = useRef<string | null>(null);

  useEffect(() => {
    mockIPC(
      (command, args) => {
        const { origin: currentOrigin, syncState: currentState, language } = fixture.current;
        const authority = currentState === "unpaired" || unpaired.current === currentOrigin ? null : currentOrigin;
        const synchronized = currentState === "synchronized" && authority !== null;
        switch (command) {
          case "plugin:store|load":
            return 1;
          case "plugin:store|get":
            return [null, false];
          case "plugin:autostart|is_enabled":
            return false;
          case "get_paired_origins":
            return authority ? [authority] : [];
          case "get_synced_localization":
            return synchronized
              ? ({
                  language,
                  regional_locale: "de-CH",
                  source_origin: currentOrigin,
                  updated_at: "2026-11-20T14:00:00Z",
                } satisfies CompanionLocalizationState)
              : null;
          case "get_native_directory_policy_status":
            return {
              authoritative_origin: authority,
              results: { localization: synchronized ? "synchronized" : currentState === "failed" ? "delivery_failed" : "defaults_active" },
              sections: authority
                ? {
                    directory_index: { marker: "0" },
                    ...(synchronized ? { localization: { result: "synchronized", origin: authority } } : {}),
                  }
                : {},
              message:
                currentState === "failed"
                  ? "The server sent unresolved localization settings. Update the Sambee server, then sync again."
                  : null,
            };
          case "unpair_origin":
            unpaired.current = currentOrigin;
            return;
          case "check_for_companion_update":
            return { available: false, currentVersion: "3.0.0" };
          case "plugin:store|set":
          case "plugin:store|save":
          case "plugin:autostart|enable":
          case "plugin:autostart|disable":
            return;
          default:
            throw new Error(`Preferences preview has no response for ${command} (${JSON.stringify(args ?? {})})`);
        }
      },
      { shouldMockEvents: true }
    );
    setReady(true);
    return clearMocks;
  }, []);

  return (
    <DialogPreviewLayout
      title="Preferences theme"
      themeMode={themeMode}
      previewAccent={customTheme ? "#50C7CC" : themeMode === "dark" ? "#D4A020" : undefined}
      onThemeModeChange={setThemeMode}
      settings={settings}
      onReset={() => {
        unpaired.current = null;
        setSyncState("synchronized");
        setThemeMode("light");
        setCustomTheme(false);
        setResetCount((value) => value + 1);
        setOpen(true);
      }}
      controls={
        <>
          <label class="dialog-preview__field">
            <span>Accent</span>
            <select value={customTheme ? "custom" : "default"} onChange={(event) => setCustomTheme(event.currentTarget.value === "custom")}>
              <option value="default">Sambee</option>
              <option value="custom">Custom teal</option>
            </select>
          </label>
          <label class="dialog-preview__field">
            <span>Localization state</span>
            <select
              value={syncState}
              onChange={(event) => {
                const value = event.currentTarget.value;
                if (value === "synchronized" || value === "waiting" || value === "failed" || value === "unpaired") {
                  unpaired.current = null;
                  setSyncState(value);
                }
              }}
            >
              <option value="synchronized">Synchronized</option>
              <option value="waiting">Waiting</option>
              <option value="failed">Failed</option>
              <option value="unpaired">Unpaired</option>
            </select>
          </label>
        </>
      }
    >
      <div class="dialog-preview__inline-window dialog-preview__inline-window--preferences">
        {ready && open ? (
          <Preferences key={`${origin}:${settings.language}:${syncState}:${resetCount}`} onClose={() => setOpen(false)} />
        ) : (
          <button type="button" class="dialog-preview__toolbar-btn" onClick={() => setOpen(true)}>
            Open Preferences
          </button>
        )}
      </div>
    </DialogPreviewLayout>
  );
}
