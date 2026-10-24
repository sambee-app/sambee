import { Edit, Print, Save } from "@mui/icons-material";
import { COMMON_SHORTCUTS } from "../../config/keyboardShortcuts";
import { withShortcut } from "../../hooks/useKeyboardShortcuts";
import { translate } from "../../i18n";
import type { ViewerToolbarAction } from "./ViewerControls";

interface CommonViewerToolbarActionOptions {
  onClick: () => void;
  isMobile: boolean;
  disabled?: boolean;
  id?: string;
}

function getToolbarIconFontSize(isMobile: boolean): "small" | "medium" {
  return isMobile ? "small" : "medium";
}

function createIconToolbarAction({
  id,
  label,
  icon,
  onClick,
  disabled,
  title,
}: {
  id: string;
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}): ViewerToolbarAction {
  return {
    id,
    kind: "icon",
    label,
    icon,
    onClick,
    disabled,
    title,
  };
}

export function createEditToolbarAction({
  onClick,
  isMobile,
  disabled,
  id = "edit",
}: CommonViewerToolbarActionOptions): ViewerToolbarAction {
  return createIconToolbarAction({
    id,
    label: translate("common.actions.edit"),
    icon: <Edit fontSize={getToolbarIconFontSize(isMobile)} />,
    onClick,
    disabled,
    title: withShortcut(COMMON_SHORTCUTS.EDIT),
  });
}

export function createSaveToolbarAction({
  onClick,
  isMobile,
  disabled,
  id = "save",
}: CommonViewerToolbarActionOptions): ViewerToolbarAction {
  return createIconToolbarAction({
    id,
    label: translate("common.actions.save"),
    icon: <Save fontSize={getToolbarIconFontSize(isMobile)} />,
    onClick,
    disabled,
    title: withShortcut(COMMON_SHORTCUTS.SAVE),
  });
}

export function createPrintToolbarAction({
  onClick,
  isMobile,
  disabled,
  id = "print",
}: CommonViewerToolbarActionOptions): ViewerToolbarAction {
  return createIconToolbarAction({
    id,
    label: translate("common.actions.print"),
    icon: <Print fontSize={getToolbarIconFontSize(isMobile)} />,
    onClick,
    disabled,
    title: translate("viewer.printTitle"),
  });
}
