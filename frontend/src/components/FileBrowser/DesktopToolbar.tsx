import { Box, Typography } from "@mui/material";
import type React from "react";
import { SambeeLogo } from "../SambeeLogo";
import { DesktopToolbarActions } from "./DesktopToolbarActions";
import type { SearchProvider } from "./search/types";
import type { UnifiedSearchBarModeOption } from "./UnifiedSearchBar";
import { UnifiedSearchBar } from "./UnifiedSearchBar";

interface DesktopToolbarProps {
  searchProvider: SearchProvider;
  searchActivationToken?: number;
  searchRefreshToken?: number;
  searchInputRef?: React.RefObject<HTMLInputElement | null>;
  showSearch: boolean;
  onOpenHelp: () => void;
  onOpenDocumentation: () => void;
  onOpenSettings: () => void;
  /** Called when ESC is pressed on controls or when menus close, to focus file list */
  onBlurToFileList?: () => void;
  searchQueryValue?: string;
  onSearchQueryValueChange?: (value: string) => void;
  disableSearchDropdown?: boolean;
  suppressSearchDropdown?: boolean;
  onSearchArrowDownToFileList?: () => void;
  /** Remove toolbar controls from Tab order (dual-pane mode uses Tab for pane switching) */
  disableTabFocus?: boolean;
  modeOptions?: UnifiedSearchBarModeOption[];
  showKeyboardHints?: boolean;
}

//
// DesktopToolbar
//
export function DesktopToolbar({
  searchProvider,
  searchActivationToken,
  searchRefreshToken,
  searchInputRef,
  showSearch,
  onOpenHelp,
  onOpenDocumentation,
  onOpenSettings,
  onBlurToFileList,
  searchQueryValue,
  onSearchQueryValueChange,
  disableSearchDropdown,
  suppressSearchDropdown,
  onSearchArrowDownToFileList,
  disableTabFocus,
  modeOptions,
  showKeyboardHints,
}: DesktopToolbarProps) {
  return (
    <>
      <SambeeLogo sx={{ mr: 2 }} />

      <Typography variant="h6" component="div">
        Sambee
      </Typography>

      <Box sx={{ flexGrow: 1 }} />

      {showSearch && (
        <Box sx={{ flexGrow: 0, width: "100%", maxWidth: { sm: 400, md: 500, lg: 600 }, mx: 2 }}>
          <UnifiedSearchBar
            provider={searchProvider}
            activationToken={searchActivationToken}
            refreshToken={searchRefreshToken}
            inputRef={searchInputRef}
            useCompactLayout={false}
            onBlurToFileList={onBlurToFileList}
            queryValue={searchQueryValue}
            onQueryValueChange={onSearchQueryValueChange}
            disableDropdown={disableSearchDropdown}
            suppressDropdown={suppressSearchDropdown}
            onArrowDownToFileList={onSearchArrowDownToFileList}
            disableTabFocus={disableTabFocus}
            modeOptions={modeOptions}
            showKeyboardHints={showKeyboardHints}
          />
        </Box>
      )}

      <Box sx={{ flexGrow: 1 }} />

      <Box sx={{ ml: 1 }}>
        <DesktopToolbarActions
          onOpenHelp={onOpenHelp}
          onOpenDocumentation={onOpenDocumentation}
          onOpenSettings={onOpenSettings}
          onEscape={onBlurToFileList}
          disableTabFocus={disableTabFocus}
        />
      </Box>
    </>
  );
}
