import type { ComponentType } from "preact";
import { AppPickerPreview } from "./components/AppPickerPreview";
import { ConflictDialogPreview } from "./components/ConflictDialogPreview";
import { DoneEditingWindowPreview } from "./components/DoneEditingWindowPreview";
import { LargeFileWarningPreview } from "./components/LargeFileWarningPreview";
import { RecoveryDialogPreview } from "./components/RecoveryDialogPreview";

export interface CompanionPreviewDefinition {
  path: string;
  title: string;
  description: string;
  component: ComponentType;
}

export const COMPANION_PREVIEWS: CompanionPreviewDefinition[] = [
  {
    path: "/preview/app-picker",
    title: "App Picker",
    description: "Preview the native app picker with theme, state, language, direction, text-length, and long-data controls.",
    component: AppPickerPreview,
  },
  {
    path: "/preview/conflict-dialog",
    title: "Conflict Dialog",
    description: "Preview the inline conflict dialog with theme, result, language, direction, text-length, and long-data controls.",
    component: ConflictDialogPreview,
  },
  {
    path: "/preview/done-editing",
    title: "Done Editing Window",
    description: "Preview the Done Editing window with theme, file-state, language, direction, text-length, and long-data controls.",
    component: DoneEditingWindowPreview,
  },
  {
    path: "/preview/large-file-warning",
    title: "Large File Warning",
    description: "Preview the large-file warning with theme, result, language, direction, text-length, and long-data controls.",
    component: LargeFileWarningPreview,
  },
  {
    path: "/preview/recovery-dialog",
    title: "Recovery Dialog",
    description: "Preview recovery with theme, item-count, result, language, direction, text-length, and long-data controls.",
    component: RecoveryDialogPreview,
  },
];
