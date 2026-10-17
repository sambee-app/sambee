import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import IosShareIcon from "@mui/icons-material/IosShare";
import NotesIcon from "@mui/icons-material/Notes";
import { CircularProgress, IconButton, ListItemIcon, ListItemText, Menu, MenuItem } from "@mui/material";
import { useId } from "react";
import { useTranslation } from "react-i18next";
import { usePillButtonMenu } from "../../hooks/usePillButtonMenu";
import { secondaryToolbarMenuPaperSx } from "../../theme/commonStyles";

interface ViewerShareMenuProps {
  onFile: () => void;
  onText: () => void;
  fileDisabled?: boolean;
  filePreparing?: boolean;
  textDisabled?: boolean;
  disabled?: boolean;
}

export function ViewerShareMenu({ onFile, onText, fileDisabled, filePreparing, textDisabled, disabled }: ViewerShareMenuProps) {
  const { t } = useTranslation();
  const menuId = useId();
  const menu = usePillButtonMenu(undefined, { restoreFocus: true });
  return (
    <>
      <IconButton
        color="inherit"
        size="small"
        disabled={disabled}
        aria-label={t("common.actions.share")}
        title={t("common.actions.share")}
        aria-controls={menu.open ? menuId : undefined}
        aria-expanded={menu.open}
        aria-haspopup="menu"
        onClick={menu.handleClick}
        onKeyDown={menu.handleKeyDown}
        onKeyUp={menu.handleKeyUp}
      >
        <IosShareIcon fontSize="small" />
      </IconButton>
      <Menu
        id={menuId}
        open={menu.open}
        anchorEl={menu.anchorEl}
        onClose={menu.handleClose}
        anchorOrigin={{ vertical: "bottom", horizontal: "right" }}
        transformOrigin={{ vertical: "top", horizontal: "right" }}
        slotProps={{ paper: { sx: secondaryToolbarMenuPaperSx } }}
      >
        <MenuItem
          disabled={fileDisabled}
          aria-busy={filePreparing || undefined}
          onClick={() => {
            menu.handleClose();
            onFile();
          }}
        >
          <ListItemIcon>
            {filePreparing ? (
              <CircularProgress size={20} aria-label={t("viewer.share.preparing")} />
            ) : (
              <DescriptionOutlinedIcon fontSize="small" />
            )}
          </ListItemIcon>
          <ListItemText primary={t("viewer.share.asFile")} />
        </MenuItem>
        <MenuItem
          disabled={textDisabled}
          onClick={() => {
            menu.handleClose();
            onText();
          }}
        >
          <ListItemIcon>
            <NotesIcon fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={t("viewer.share.asText")} />
        </MenuItem>
      </Menu>
    </>
  );
}
