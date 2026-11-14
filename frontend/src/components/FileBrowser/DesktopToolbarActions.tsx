import SettingsIcon from "@mui/icons-material/Settings";
import { Box } from "@mui/material";
import { BROWSER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { withShortcut } from "../../hooks/useKeyboardShortcuts";
import { translate } from "../../i18n";
import type { AggregateHealthSeverity } from "../../types";
import { createEscapeHandler } from "../../utils/keyboardUtils";
import { HealthMonitorIcon } from "../HealthMonitoring/HealthStatusIcon";
import { HelpMenu } from "./HelpMenu";
import { ToolbarIconButton } from "./ToolbarIconButton";

export interface ToolbarSystemHealthAction {
  visible: boolean;
  severity: AggregateHealthSeverity;
  headline: string;
  onOpen: () => void;
}

//
// DesktopToolbarActions
//

interface DesktopToolbarActionsProps {
  onOpenHelp: () => void;
  onOpenDocumentation: () => void;
  onOpenSettings: () => void;
  systemHealth?: ToolbarSystemHealthAction;
  /** Called when ESC is pressed on the settings button */
  onEscape?: () => void;
  /** Remove from Tab order (dual-pane mode uses Tab for pane switching) */
  disableTabFocus?: boolean;
}

export function DesktopToolbarActions({
  onOpenHelp,
  onOpenDocumentation,
  onOpenSettings,
  systemHealth,
  onEscape,
  disableTabFocus,
}: DesktopToolbarActionsProps) {
  const healthStatusText = systemHealth ? translate(`systemHealth.statuses.${systemHealth.severity}`) : "";
  const healthLabel = systemHealth?.visible
    ? translate("fileBrowser.chrome.toolbar.systemHealthTooltip", {
        status: healthStatusText,
        headline: systemHealth.headline,
      })
    : "";

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 0.5 }}>
      <HelpMenu
        menuId="help-menu"
        onOpenHelp={onOpenHelp}
        onOpenDocumentation={onOpenDocumentation}
        onEscape={onEscape}
        tabIndex={disableTabFocus ? -1 : undefined}
      />
      <ToolbarIconButton
        label={translate("fileBrowser.chrome.toolbar.openSettings")}
        tooltip={withShortcut(BROWSER_SHORTCUTS.OPEN_SETTINGS)}
        onClick={onOpenSettings}
        onKeyDown={createEscapeHandler(onEscape)}
        tabIndex={disableTabFocus ? -1 : undefined}
      >
        <SettingsIcon />
      </ToolbarIconButton>
      {systemHealth?.visible && (
        <ToolbarIconButton
          label={healthLabel}
          tooltip={healthLabel}
          onClick={systemHealth.onOpen}
          onKeyDown={createEscapeHandler(onEscape)}
          tabIndex={disableTabFocus ? -1 : undefined}
        >
          <HealthMonitorIcon status={systemHealth.severity} />
        </ToolbarIconButton>
      )}
    </Box>
  );
}
