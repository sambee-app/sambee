import { useMemo, useState } from "preact/hooks";
import { ConflictDialog, type ConflictInfo } from "./ConflictDialog";
import { DialogPreviewLayout, type PreviewThemeMode } from "./DialogPreviewLayout";
import { usePreviewSettings } from "./usePreviewSettings";

type PreviewActionResult = "success" | "error";

const PREVIEW_CONFLICT: ConflictInfo = {
  operation_id: "preview-conflict-operation",
  filename: "Quarterly Budget.xlsx",
  download_modified: "2026-04-24 12:14:03",
  server_modified: "2026-04-24 12:21:47",
  server_url: "https://sambee.example.test",
};
const LONG_PREVIEW_CONFLICT: ConflictInfo = {
  ...PREVIEW_CONFLICT,
  filename: "Jahresabschlusszusammenstellungsdokumentation_Quartalsbudget_2026.xlsx",
};

/** Browser-only preview for the conflict dialog. */
export function ConflictDialogPreview() {
  const previewSettings = usePreviewSettings();
  const [themeMode, setThemeMode] = useState<PreviewThemeMode>("light");
  const [actionResult, setActionResult] = useState<PreviewActionResult>("success");
  const [visible, setVisible] = useState(true);
  const [instanceKey, setInstanceKey] = useState(0);

  const actionHandler = useMemo(
    () => async () => {
      if (actionResult === "error") {
        throw new Error("Mock preview error: the conflict action failed.");
      }
      setVisible(false);
      return undefined;
    },
    [actionResult]
  );

  const resetPreview = () => {
    setVisible(true);
    setInstanceKey((current) => current + 1);
  };

  return (
    <DialogPreviewLayout
      title="Conflict Dialog"
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
          <ConflictDialog
            conflict={previewSettings.dataVariant === "long" ? LONG_PREVIEW_CONFLICT : PREVIEW_CONFLICT}
            onResolved={() => {
              setVisible(false);
            }}
            onOverwriteAction={actionHandler}
            onSaveCopyAction={actionHandler}
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
