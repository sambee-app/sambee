import type { SxProps, Theme } from "@mui/material";
import { COMPACT_LAYOUT_SIZE } from "../../theme/constants";

/** Shared emphasis for non-heading titles in settings list rows. */
export const settingsListItemTitleSx: SxProps<Theme> = {
  fontWeight: 600,
};

/** Compact typography policy for the full-page settings shells only. */
export const settingsCompactTypographyScopeSx = ((theme: Theme) => ({
  [theme.breakpoints.down("sm")]: {
    "& .MuiAppBar-root .MuiTypography-h6": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_APP_BAR_TITLE_PX}px`,
    },
    "& .MuiTypography-h5": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_PAGE_TITLE_PX}px`,
    },
    "& .MuiTypography-h6": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_SECTION_TITLE_PX}px`,
    },
    "& .MuiTypography-subtitle1": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_SUBSECTION_TITLE_PX}px`,
    },
    "& .MuiTypography-body1, & .MuiListItemText-primary, & .MuiFormControlLabel-label, & .MuiButton-root, & .MuiInputBase-input, & .MuiSelect-select":
      {
        fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_PRIMARY_TEXT_PX}px`,
      },
    "& .MuiTypography-body2, & .MuiListItemText-secondary, & .MuiFormHelperText-root, & .MuiAlert-message": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_SECONDARY_TEXT_PX}px`,
    },
    "& .MuiInputLabel-root": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_LABEL_PX}px`,
    },
    "& .MuiTypography-caption, & .MuiChip-label, & .MuiListSubheader-root": {
      fontSize: `${COMPACT_LAYOUT_SIZE.SETTINGS_METADATA_TEXT_PX}px`,
    },
  },
})) satisfies SxProps<Theme>;
