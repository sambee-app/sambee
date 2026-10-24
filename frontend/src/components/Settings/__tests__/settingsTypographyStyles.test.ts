import { createTheme } from "@mui/material";
import { describe, expect, it } from "vitest";
import { requireTestValue } from "../../../test/helpers/assertions";
import { COMPACT_LAYOUT_SIZE } from "../../../theme/constants";
import { settingsCompactTypographyScopeSx } from "../settingsTypographyStyles";

describe("settings compact typography", () => {
  it("defines a readable mobile settings scale", () => {
    expect(COMPACT_LAYOUT_SIZE).toMatchObject({
      SETTINGS_APP_BAR_TITLE_PX: 18,
      SETTINGS_PAGE_TITLE_PX: 22,
      SETTINGS_SECTION_TITLE_PX: 20,
      SETTINGS_SUBSECTION_TITLE_PX: 18,
      SETTINGS_PRIMARY_TEXT_PX: 17,
      SETTINGS_SECONDARY_TEXT_PX: 16,
      SETTINGS_LABEL_PX: 16,
      SETTINGS_METADATA_TEXT_PX: 14,
      SETTINGS_CATEGORY_ICON_PX: 28,
    });
  });

  it("limits settings typography overrides to the compact breakpoint", () => {
    const theme = createTheme();
    if (typeof settingsCompactTypographyScopeSx !== "function") {
      throw new Error("Settings compact typography must remain theme-aware.");
    }

    const styles = requireTestValue(settingsCompactTypographyScopeSx(theme));
    const compactStyles = styles[theme.breakpoints.down("sm")];

    expect(compactStyles).toMatchObject({
      "& .MuiAppBar-root .MuiTypography-h6": { fontSize: "18px" },
      "& .MuiTypography-h5": { fontSize: "22px" },
      "& .MuiTypography-h6": { fontSize: "20px" },
      "& .MuiTypography-subtitle1": { fontSize: "18px" },
      "& .MuiTypography-body1, & .MuiListItemText-primary, & .MuiFormControlLabel-label, & .MuiButton-root, & .MuiInputBase-input, & .MuiSelect-select":
        {
          fontSize: "17px",
        },
      "& .MuiTypography-body2, & .MuiListItemText-secondary, & .MuiFormHelperText-root, & .MuiAlert-message": {
        fontSize: "16px",
      },
      "& .MuiInputLabel-root": { fontSize: "16px" },
      "& .MuiTypography-caption, & .MuiChip-label, & .MuiListSubheader-root": { fontSize: "14px" },
    });
  });
});
