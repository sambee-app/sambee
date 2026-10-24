//
// SearchBar
//

import ClearIcon from "@mui/icons-material/Clear";
import SearchIcon from "@mui/icons-material/Search";
import { IconButton, InputAdornment, Paper, TextField } from "@mui/material";
import type React from "react";
import { useTranslation } from "react-i18next";

interface SearchBarProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
  useCompactLayout?: boolean;
  /** Called when ESC is pressed on an empty search field */
  onBlurToFileList?: () => void;
}

/**
 * Search bar component for filtering files
 * Shows clear button when there's text, with mobile-optimized touch targets
 *
 * ESC key behavior:
 * - If the field has content, ESC clears it
 * - If the field is empty, ESC moves focus to the file list
 */
//
// SearchBar
//
export function SearchBar({ value, onChange, inputRef, useCompactLayout = false, onBlurToFileList }: SearchBarProps) {
  const { t } = useTranslation();

  //
  // handleKeyDown
  //
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Escape") {
      if (value) {
        // Clear the search field if it has content
        onChange("");
      } else if (onBlurToFileList) {
        // Move focus to file list if field is already empty
        onBlurToFileList();
      }
      e.preventDefault();
    }
  };
  return (
    <Paper
      elevation={2}
      sx={{
        mb: useCompactLayout ? 2 : 0,
        mt: useCompactLayout ? { xs: 1, sm: 0 } : 0,
        mx: useCompactLayout ? { xs: 2, sm: 3, md: 4 } : 0,
        position: useCompactLayout ? "sticky" : "relative",
        top: 0,
        zIndex: 10,
        backgroundColor: "background.default",
      }}
    >
      <TextField
        fullWidth
        size="small"
        placeholder={t("common.search.placeholder")}
        value={value}
        onChange={(e: React.ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        inputRef={inputRef}
        sx={{
          "& .MuiInputBase-root": {
            fontSize: { xs: "16px", sm: "14px" }, // Prevent zoom on iOS
          },
          "& .MuiInputBase-root.Mui-focused": {
            outline: (theme) => `3px solid ${theme.palette.appBar?.focus}`,
            outlineOffset: `0`,
          },
          "& .MuiInputBase-input": {
            padding: { xs: "10px 14px", sm: "8.5px 14px" }, // Ensure min 44px touch target
          },
          "& .MuiOutlinedInput-notchedOutline": {
            border: "none",
          },
          "&:hover .MuiOutlinedInput-notchedOutline": {
            border: "none",
          },
          "& .Mui-focused .MuiOutlinedInput-notchedOutline": {
            border: "none",
          },
        }}
        slotProps={{
          input: {
            startAdornment: (
              <InputAdornment position="start">
                <SearchIcon fontSize={useCompactLayout ? "medium" : "small"} />
              </InputAdornment>
            ),
            endAdornment: value && (
              <InputAdornment position="end">
                <IconButton
                  size="small"
                  onClick={() => onChange("")}
                  edge="end"
                  sx={{
                    minWidth: { xs: 44, sm: "auto" },
                    minHeight: { xs: 44, sm: "auto" },
                  }}
                  aria-label={t("common.search.clear")}
                >
                  <ClearIcon fontSize={useCompactLayout ? "medium" : "small"} />
                </IconButton>
              </InputAdornment>
            ),
          },
        }}
      />
    </Paper>
  );
}
