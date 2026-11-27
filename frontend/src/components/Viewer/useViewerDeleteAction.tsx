import DeleteIcon from "@mui/icons-material/Delete";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { VIEWER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { withShortcut } from "../../hooks/useKeyboardShortcuts";
import type { ViewerToolbarAction } from "./ViewerControls";

export function useViewerDeleteAction(onDeleteRequest?: () => void) {
  const { t } = useTranslation();
  const label = t("fileBrowser.confirmDelete.titleFile");
  return useMemo(() => {
    if (!onDeleteRequest) return null;
    const shortcut = { ...VIEWER_SHORTCUTS.DELETE_FILE, description: label, handler: onDeleteRequest };
    const action: ViewerToolbarAction = {
      id: shortcut.id,
      kind: "icon",
      icon: <DeleteIcon />,
      label,
      title: withShortcut(shortcut),
      onClick: onDeleteRequest,
    };
    return { action, shortcut };
  }, [label, onDeleteRequest]);
}
