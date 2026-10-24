import type { Extension, TransactionSpec } from "@codemirror/state";
import type { Command, EditorView, ViewUpdate } from "@codemirror/view";

export interface SourceTextSnapshot {
  readonly revision: number;
  serialize(): string;
}

export interface SourceTextEditorProps {
  value: string;
  extensions?: Extension[];
  readOnly?: boolean;
  autoFocus?: boolean;
  ariaLabel: string;
  contentAttributes?: Record<string, string>;
  className?: string;
  onChange: (value: string, viewUpdate: ViewUpdate) => void;
  onUserEdit?: (viewUpdate: ViewUpdate) => void;
  onUpdate?: (viewUpdate: ViewUpdate, view: EditorView) => void;
}

export interface SourceTextEditorHandle {
  focus: () => void;
  captureSnapshot: () => SourceTextSnapshot;
  getValue: () => string;
  getPrimarySelectionText: () => string;
  getView: () => EditorView | null;
  preserveSelection: () => void;
  restorePreservedSelection: () => boolean;
  dispatch: (...specs: TransactionSpec[]) => void;
  runCommand: (command: Command) => boolean;
}
