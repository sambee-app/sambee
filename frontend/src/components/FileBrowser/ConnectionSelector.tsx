import ComputerIcon from "@mui/icons-material/Computer";
import LanIcon from "@mui/icons-material/Lan";
import { Box, Button, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Typography } from "@mui/material";
import { useTranslation } from "react-i18next";
import { BROWSER_SHORTCUTS } from "../../config/keyboardShortcuts";
import type { CompanionStatus } from "../../hooks/useCompanion";
import { usePillButtonMenu } from "../../hooks/usePillButtonMenu";
import { CONNECTION_TYPE_LOCAL, isLocalDrive } from "../../services/backendRouter";
import {
  secondaryStripButtonContentSx,
  secondaryStripButtonIconSx,
  secondaryStripButtonLabelSx,
  secondaryStripButtonSx,
  secondaryToolbarMenuPaperSx,
} from "../../theme/commonStyles";
import type { Connection } from "../../types";
import { LOCAL_DRIVES_MENU_ACTION_LABEL } from "../Settings/localDrivesCopy";
import { PillButtonTooltip } from "./PillButtonTooltip";

interface ConnectionSelectorProps {
  connections: Connection[];
  selectedConnectionId: string;
  onConnectionChange: (connectionId: string) => void;
  /** Called when menu closes or ESC is pressed on button */
  onAfterChange?: () => void;
  /** Remove from Tab order (dual-pane mode uses Tab for pane switching) */
  disableTabFocus?: boolean;
  /** Companion pairing status — when unavailable or unpaired, shows management entry. */
  companionStatus?: CompanionStatus;
  /** Callback to open the consolidated Connections settings page. */
  onOpenConnectionsSettings?: () => void;
  /** Optional ref to the trigger button for keyboard focus management. */
  buttonRef?: React.Ref<HTMLButtonElement>;
}

//
// ConnectionSelector
//
export function ConnectionSelector({
  connections,
  selectedConnectionId,
  onConnectionChange,
  onAfterChange,
  disableTabFocus,
  companionStatus,
  onOpenConnectionsSettings,
  buttonRef,
}: ConnectionSelectorProps) {
  const { t } = useTranslation();
  const { anchorEl, open, handleClick, handleKeyDown, handleKeyUp, handleClose } = usePillButtonMenu(onAfterChange);

  if (connections.length === 0) {
    return null;
  }

  const selectedConnection = connections.find((conn) => conn.id === selectedConnectionId);
  const isSelectedLocal = selectedConnection ? isLocalDrive(selectedConnection.id) : false;
  const connectionSelectorLabel = t("fileBrowser.chrome.mobileMenu.selectConnectionAriaLabel");

  /** Icon for the pill button — reflects whether the active connection is local or SMB. */
  const ActiveIcon = isSelectedLocal ? ComputerIcon : LanIcon;

  const handleSelect = (connectionId: string) => {
    onConnectionChange(connectionId);
    handleClose();
  };

  const handleOpenConnectionsSettings = () => {
    handleClose();
    onOpenConnectionsSettings?.();
  };

  // Split connections into SMB and local groups for visual separation
  const smbConnections = connections.filter((c) => c.type !== CONNECTION_TYPE_LOCAL);
  const localConnections = connections.filter((c) => c.type === CONNECTION_TYPE_LOCAL);
  const showDivider = smbConnections.length > 0 && localConnections.length > 0;

  return (
    <>
      <PillButtonTooltip label={connectionSelectorLabel} shortcut={BROWSER_SHORTCUTS.FOCUS_CONNECTION_SELECTOR}>
        <Button
          ref={buttonRef}
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          role="combobox"
          size="small"
          aria-label={connectionSelectorLabel}
          aria-expanded={open}
          aria-haspopup="listbox"
          aria-controls={open ? "connection-menu" : undefined}
          tabIndex={disableTabFocus ? -1 : undefined}
          sx={{
            ...secondaryStripButtonSx,
            color: "text.secondary",
          }}
        >
          <Box sx={secondaryStripButtonContentSx}>
            <ActiveIcon sx={secondaryStripButtonIconSx} />
            <Typography sx={secondaryStripButtonLabelSx}>
              {selectedConnection?.name || t("fileBrowser.chrome.connectionSelector.placeholder")}
            </Typography>
          </Box>
        </Button>
      </PillButtonTooltip>
      <Menu
        id="connection-menu"
        anchorEl={anchorEl}
        open={open}
        onClose={handleClose}
        anchorOrigin={{
          vertical: "bottom",
          horizontal: "right",
        }}
        transformOrigin={{
          vertical: "top",
          horizontal: "right",
        }}
        slotProps={{
          list: {
            role: "listbox",
          },
          paper: {
            sx: secondaryToolbarMenuPaperSx,
          },
        }}
      >
        {/* SMB connections */}
        {smbConnections.map((conn: Connection) => (
          <MenuItem key={conn.id} onClick={() => handleSelect(conn.id)} selected={conn.id === selectedConnectionId}>
            <ListItemIcon>
              <LanIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>
              {conn.name} ({conn.host}/{conn.share_name})
            </ListItemText>
          </MenuItem>
        ))}

        {/* Divider between SMB and local drives */}
        {showDivider && <Divider />}

        {/* Local drives */}
        {localConnections.map((conn: Connection) => (
          <MenuItem key={conn.id} onClick={() => handleSelect(conn.id)} selected={conn.id === selectedConnectionId}>
            <ListItemIcon>
              <ComputerIcon fontSize="small" />
            </ListItemIcon>
            <ListItemText>{conn.name}</ListItemText>
          </MenuItem>
        ))}

        {/* Local drives management action */}
        {/* Connections settings shortcut for local-drive management */}
        {(companionStatus === "unpaired" ||
          companionStatus === "unavailable" ||
          companionStatus === "reconnecting" ||
          companionStatus === "pending_local_approval" ||
          companionStatus === "needs_repair" ||
          companionStatus === "update_required") && (
          <>
            <Divider />
            <MenuItem onClick={handleOpenConnectionsSettings}>
              <ListItemIcon>
                <ComputerIcon fontSize="small" />
              </ListItemIcon>
              <ListItemText>{String(LOCAL_DRIVES_MENU_ACTION_LABEL)}</ListItemText>
            </MenuItem>
          </>
        )}
      </Menu>
    </>
  );
}
