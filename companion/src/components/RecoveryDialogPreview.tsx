import { useMemo, useState } from "preact/hooks";
import { DialogPreviewLayout, type PreviewThemeMode } from "./DialogPreviewLayout";
import { type LeftoverInfo, RecoveryDialog } from "./RecoveryDialog";
import { usePreviewSettings } from "./usePreviewSettings";

type PreviewActionResult = "success" | "error" | "reauth";
type PreviewCount = "one" | "three";

const PREVIEW_LEFTOVERS: LeftoverInfo[] = [
  {
    operation_dir: "preview-operation-1",
    filename: "Meeting Notes.md",
    server_url: "https://sambee.local",
    remote_path: "/Team/Meetings/Meeting Notes.md",
    connection_id: "preview-connection-1",
    local_modified: "today at 12:16",
  },
  {
    operation_dir: "preview-operation-2",
    filename: "Budget 2026.xlsx",
    server_url: "https://sambee.local",
    remote_path: "/Finance/Budget 2026.xlsx",
    connection_id: "preview-connection-1",
    local_modified: "today at 11:43",
  },
  {
    operation_dir: "preview-operation-3",
    filename: "Campaign Brief.docx",
    server_url: "https://sambee.local",
    remote_path: "/Marketing/Campaign Brief.docx",
    connection_id: "preview-connection-2",
    local_modified: "yesterday at 18:22",
  },
];
const LONG_PREVIEW_LEFTOVERS: LeftoverInfo[] = [
  {
    operation_dir: "preview-long-operation-1",
    filename: "Jahresabschlusszusammenstellungsdokumentation_2026.xlsx",
    server_url: "https://sambee.local",
    remote_path:
      "/AbteilungsübergreifendeZusammenarbeitsdokumentation/Finanzplanung/Jahresabschlusszusammenstellungsdokumentation_2026.xlsx",
    connection_id: "preview-connection-1",
    local_modified: "today at 12:16",
  },
  {
    operation_dir: "preview-long-operation-2",
    filename: "Unternehmenssteuererklärungsvorbereitungsunterlagen.docx",
    server_url: "https://sambee.local",
    remote_path: "/Finanzen/Unternehmenssteuererklärungsvorbereitungsunterlagen.docx",
    connection_id: "preview-connection-1",
    local_modified: "today at 11:43",
  },
  {
    operation_dir: "preview-long-operation-3",
    filename: "AbteilungsübergreifendeZusammenarbeitsdokumentation.md",
    server_url: "https://sambee.local",
    remote_path: "/Team/AbteilungsübergreifendeZusammenarbeitsdokumentation.md",
    connection_id: "preview-connection-2",
    local_modified: "yesterday at 18:22",
  },
];

/** Browser-only preview for the leftover recovery dialog. */
export function RecoveryDialogPreview() {
  const previewSettings = usePreviewSettings();
  const [themeMode, setThemeMode] = useState<PreviewThemeMode>("light");
  const [actionResult, setActionResult] = useState<PreviewActionResult>("success");
  const [count, setCount] = useState<PreviewCount>("three");
  const [visible, setVisible] = useState(true);
  const [instanceKey, setInstanceKey] = useState(0);

  const previewLeftovers = previewSettings.dataVariant === "long" ? LONG_PREVIEW_LEFTOVERS : PREVIEW_LEFTOVERS;
  const leftovers = count === "one" ? previewLeftovers.slice(0, 1) : previewLeftovers;

  const uploadActionHandler = useMemo(
    () => async () => {
      if (actionResult === "reauth") {
        return { status: "auth_retry" as const, reason: "upload" as const };
      }

      if (actionResult === "error") {
        throw new Error("Mock preview error: the recovery action failed.");
      }
    },
    [actionResult]
  );

  const simpleActionHandler = useMemo(
    () => async () => {
      if (actionResult === "error") {
        throw new Error("Mock preview error: the recovery action failed.");
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
      title="Recovery Dialog"
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
      onReset={resetPreview}
      settings={previewSettings}
      controls={[
        <label class="dialog-preview__field" key="count">
          <span>Items</span>
          <select value={count} onChange={(event) => setCount((event.target as HTMLSelectElement).value as PreviewCount)}>
            <option value="one">1 item</option>
            <option value="three">3 items</option>
          </select>
        </label>,
        <label class="dialog-preview__field" key="result">
          <span>Action result</span>
          <select
            value={actionResult}
            onChange={(event) => setActionResult((event.target as HTMLSelectElement).value as PreviewActionResult)}
          >
            <option value="success">Success</option>
            <option value="error">Error</option>
            <option value="reauth">Reauthenticate and retry</option>
          </select>
        </label>,
      ]}
    >
      {visible ? (
        <div key={`${instanceKey}-${previewSettings.dataVariant}`}>
          <RecoveryDialog
            leftovers={leftovers}
            onDone={() => setVisible(false)}
            onUploadAction={uploadActionHandler}
            onDiscardAction={simpleActionHandler}
            onDismissAction={simpleActionHandler}
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
