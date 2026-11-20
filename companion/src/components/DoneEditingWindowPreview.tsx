import { useState } from "preact/hooks";
import { translate } from "../i18n";
import { DialogPreviewLayout, type PreviewThemeMode } from "./DialogPreviewLayout";
import {
  type DoneEditingButtonHandlers,
  type DoneEditingContext,
  type DoneEditingFileStatus,
  DoneEditingWindowView,
} from "./DoneEditingWindow";
import { usePreviewSettings } from "./usePreviewSettings";

const PREVIEW_TITLEBAR_HEIGHT = 38;

type PreviewFileState = "unchanged" | "modified";
type PreviewWindowState = "idle" | "processing" | "error" | "reauth";

const PREVIEW_CONTEXT: DoneEditingContext = {
  operation_id: "preview-done-editing",
  filename: "Quarterly Budget.xlsx",
  app_name: "LibreOffice Calc",
  server_url: "https://sambee.example.test",
};
const LONG_PREVIEW_CONTEXT: DoneEditingContext = {
  ...PREVIEW_CONTEXT,
  filename: "Jahresabschlusszusammenstellungsdokumentation_Quartalsbudget_2026.xlsx",
  app_name: "LibreOffice Tabellenkalkulationsprogramm für Unternehmensfinanzen",
};

const NOOP_BUTTON_HANDLERS: DoneEditingButtonHandlers = {
  onMouseDown: () => {},
  onMouseUp: () => {},
  onMouseLeave: () => {},
  onKeyDown: () => {},
  onKeyUp: () => {},
};

/** Browser-only preview for the Done Editing window. */
export function DoneEditingWindowPreview() {
  const previewSettings = usePreviewSettings();
  const [themeMode, setThemeMode] = useState<PreviewThemeMode>("light");
  const [fileState, setFileState] = useState<PreviewFileState>("modified");
  const [windowState, setWindowState] = useState<PreviewWindowState>("idle");

  const fileStatus: DoneEditingFileStatus =
    fileState === "modified"
      ? {
          kind: "modified",
          modifiedAt: "today at 12:34",
        }
      : { kind: "unchanged" };

  const isModified = fileStatus.kind === "modified";
  const processing = windowState === "processing";
  const notice = windowState === "reauth" ? translate("doneEditing.authRefreshedRetryUpload") : null;
  const error = windowState === "error" ? "Mock preview error: uploading the edited file failed." : null;

  const doneButtonLabel = processing
    ? isModified
      ? translate("doneEditing.buttons.uploading")
      : translate("doneEditing.buttons.closing")
    : isModified
      ? notice
        ? translate("doneEditing.buttons.retryUpload")
        : translate("doneEditing.buttons.doneUpload")
      : translate("doneEditing.buttons.doneClose");

  return (
    <DialogPreviewLayout
      title="Done Editing Window"
      themeMode={themeMode}
      onThemeModeChange={setThemeMode}
      settings={previewSettings}
      onReset={() => {
        setThemeMode("light");
        setFileState("modified");
        setWindowState("idle");
      }}
      controls={[
        <label class="dialog-preview__field" key="file-state">
          <span>File state</span>
          <select value={fileState} onChange={(event) => setFileState((event.target as HTMLSelectElement).value as PreviewFileState)}>
            <option value="unchanged">Unchanged</option>
            <option value="modified">Modified</option>
          </select>
        </label>,
        <label class="dialog-preview__field" key="window-state">
          <span>Window state</span>
          <select value={windowState} onChange={(event) => setWindowState((event.target as HTMLSelectElement).value as PreviewWindowState)}>
            <option value="idle">Idle</option>
            <option value="processing">Processing</option>
            <option value="error">Error</option>
            <option value="reauth">Reauthenticate and retry</option>
          </select>
        </label>,
      ]}
    >
      <div class="dialog-preview__inline-window dialog-preview__inline-window--done-editing">
        <div class="dialog-preview__titlebar" aria-hidden="true">
          <div class="dialog-preview__titlebar-label">Sambee Companion — Editing</div>
          <div class="dialog-preview__titlebar-controls">
            <button type="button" class="dialog-preview__titlebar-btn dialog-preview__titlebar-btn--disabled" tabIndex={-1}>
              <span class="dialog-preview__titlebar-icon dialog-preview__titlebar-icon--minimize" />
            </button>
            <button type="button" class="dialog-preview__titlebar-btn dialog-preview__titlebar-btn--disabled" tabIndex={-1}>
              <span class="dialog-preview__titlebar-icon dialog-preview__titlebar-icon--close" />
            </button>
          </div>
        </div>
        <div class="dialog-preview__window-meta">340 x {260 + PREVIEW_TITLEBAR_HEIGHT}</div>
        <DoneEditingWindowView
          context={previewSettings.dataVariant === "long" ? LONG_PREVIEW_CONTEXT : PREVIEW_CONTEXT}
          fileStatus={fileStatus}
          processing={processing}
          uploadProgress={0.62}
          notice={notice}
          error={error}
          conflict={null}
          holdProgress={0}
          discardHoldProgress={0}
          doneButtonLabel={doneButtonLabel}
          doneAriaLabel={
            isModified
              ? translate("doneEditing.aria.confirmUpload", { seconds: 1.5 })
              : translate("doneEditing.aria.confirmClose", { seconds: 1.5 })
          }
          discardAriaLabel={translate("doneEditing.aria.discardChanges", { seconds: 1.5 })}
          doneHandlers={NOOP_BUTTON_HANDLERS}
          discardHandlers={NOOP_BUTTON_HANDLERS}
          autoFocusPrimary
          onConflictResolved={() => {}}
        />
      </div>
    </DialogPreviewLayout>
  );
}
