import ViewList from "@mui/icons-material/ViewList";
import ViewModule from "@mui/icons-material/ViewModule";
import { Box, Button, Divider, Menu, MenuItem, Typography } from "@mui/material";
import { BROWSER_SHORTCUTS } from "../../config/keyboardShortcuts";
import { formatShortcut } from "../../hooks/useKeyboardShortcuts";
import { usePillButtonMenu } from "../../hooks/usePillButtonMenu";
import type { ViewMode } from "../../pages/FileBrowser/types";
import {
  getSecondaryToolbarMenuPaperStyle,
  secondaryStripButtonContentSx,
  secondaryStripButtonIconSx,
  secondaryStripButtonLabelSx,
  secondaryStripButtonSx,
} from "../../theme/commonStyles";
import { PillButtonTooltip } from "./PillButtonTooltip";
import { VIEW_MODE_SELECTOR_STRINGS } from "./viewModeSelectorStrings";

interface ViewModeSelectorProps {
  viewMode: ViewMode;
  onViewModeChange: (mode: ViewMode) => void;
  onAfterChange?: () => void;
  /** Remove from Tab order (dual-pane mode uses Tab for pane switching) */
  disableTabFocus?: boolean;
}

//
// ViewModeSelector
//
export function ViewModeSelector({ viewMode, onViewModeChange, onAfterChange, disableTabFocus }: ViewModeSelectorProps) {
  const { anchorEl, open, handleClick, handleKeyDown, handleKeyUp, handleClose } = usePillButtonMenu(onAfterChange);

  const handleModeChange = (mode: ViewMode) => {
    onViewModeChange(mode);
    handleClose();
  };

  const currentLabel = VIEW_MODE_SELECTOR_STRINGS.optionLabel(viewMode);
  const icon = viewMode === "list" ? <ViewList sx={secondaryStripButtonIconSx} /> : <ViewModule sx={secondaryStripButtonIconSx} />;

  const renderOption = (mode: ViewMode, Icon: typeof ViewList, shortcut: Parameters<typeof formatShortcut>[0]) => (
    <MenuItem onClick={() => handleModeChange(mode)} selected={viewMode === mode} sx={{ display: "flex", gap: 1 }}>
      <Icon fontSize="small" sx={{ display: "flex" }} />
      {VIEW_MODE_SELECTOR_STRINGS.optionLabel(mode)}
      <Typography component="kbd" variant="caption" sx={{ marginInlineStart: "auto", color: "text.secondary", whiteSpace: "nowrap" }}>
        {formatShortcut(shortcut)}
      </Typography>
    </MenuItem>
  );

  return (
    <Box sx={{ display: "flex", alignItems: "center", gap: 1 }}>
      <PillButtonTooltip label={VIEW_MODE_SELECTOR_STRINGS.ARIA_LABEL}>
        <Button
          onClick={handleClick}
          onKeyDown={handleKeyDown}
          onKeyUp={handleKeyUp}
          size="small"
          tabIndex={disableTabFocus ? -1 : undefined}
          sx={{
            ...secondaryStripButtonSx,
            color: "text.secondary",
          }}
          aria-label={VIEW_MODE_SELECTOR_STRINGS.ARIA_LABEL}
          aria-controls={open ? "view-mode-menu" : undefined}
          aria-haspopup="true"
          aria-expanded={open ? "true" : undefined}
        >
          <Box sx={secondaryStripButtonContentSx}>
            {icon}
            <Typography sx={secondaryStripButtonLabelSx}>{currentLabel}</Typography>
          </Box>
        </Button>
      </PillButtonTooltip>
      <Menu
        id="view-mode-menu"
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
          paper: {
            sx: (theme) => ({
              ...getSecondaryToolbarMenuPaperStyle(theme),
              minWidth: 160,
            }),
          },
        }}
      >
        {renderOption("list", ViewList, BROWSER_SHORTCUTS.SHOW_LIST_VIEW)}
        <Divider />
        {renderOption("details", ViewModule, BROWSER_SHORTCUTS.SHOW_DETAILS_VIEW)}
      </Menu>
    </Box>
  );
}
