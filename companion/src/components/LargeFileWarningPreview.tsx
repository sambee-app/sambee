import { useMemo, useState } from "preact/hooks";
import { DialogPreviewLayout, type PreviewThemeMode } from "./DialogPreviewLayout";
import { type LargeFileInfo, LargeFileWarning } from "./LargeFileWarning";
import { usePreviewSettings } from "./usePreviewSettings";

type PreviewActionResult = "success" | "error";

const PREVIEW_INFO: LargeFileInfo = {
  confirm_id: "preview-large-file",
  filename: "Raw Drone Footage.mov",
  size_mb: 842,
  limit_mb: 250,
};
const LONG_PREVIEW_INFO: LargeFileInfo = {
  ...PREVIEW_INFO,
  filename: "Jahresabschlusszusammenstellungsdokumentation_Quartalsbudget_2026.mov",
};

/** Browser-only preview for the large file warning dialog. */
export function LargeFileWarningPreview() {
  const previewSettings = usePreviewSettings();
  const [themeMode, setThemeMode] = useState<PreviewThemeMode>("light");
  const [actionResult, setActionResult] = useState<PreviewActionResult>("success");
  const [visible, setVisible] = useState(true);
  const [instanceKey, setInstanceKey] = useState(0);

  const respondAction = useMemo(
    () => async () => {
      if (actionResult === "error") {
        throw new Error("Mock preview error: confirming the large download failed.");
      }
    },
    [actionResult]
  );

  const resetPreview = () => {
    setVisible(true);
    setInstanceKey((current) => current + 1);
  };

  return (
    <DialogPreviewLayout
      title="Large File Warning"
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
      onReset={resetPreview}
      settings={previewSettings}
      controls={
        <label class="dialog-preview__field">
          <span>Action result</span>
          <select
            value={actionResult}
            onChange={(event) => setActionResult((event.target as HTMLSelectElement).value as PreviewActionResult)}
          >
            <option value="success">Success</option>
            <option value="error">Error</option>
          </select>
        </label>
      }
    >
      {visible ? (
        <div key={`${instanceKey}-${previewSettings.dataVariant}`}>
          <LargeFileWarning
            info={previewSettings.dataVariant === "long" ? LONG_PREVIEW_INFO : PREVIEW_INFO}
            onResolved={() => setVisible(false)}
            onRespondAction={respondAction}
          />
        </div>
      ) : (
        <div class="dialog-preview__dismissed-card">
          <p>Dialog dismissed. Use Reset Preview to reopen it.</p>
        </div>
      )}
    </DialogPreviewLayout>
  );
}
