import ArrowUpwardIcon from "@mui/icons-material/ArrowUpward";
import { Box, IconButton } from "@mui/material";
import type React from "react";
import { useTranslation } from "react-i18next";
import { SambeeLogo } from "../SambeeLogo";
import type { ToolbarQuickBarProps } from "./DesktopToolbar";
import { UnifiedSearchBar } from "./UnifiedSearchBar";

interface MobileToolbarProps extends ToolbarQuickBarProps {
  onOpenMenu: () => void;
  onNavigateUp: () => void;
  canNavigateUp: boolean;
  /** Optional status recovery icon rendered before Navigate Up so edge="end" stays on the rightmost control */
  statusAction?: React.ReactNode;
}

//
// MobileToolbar
//
export function MobileToolbar({
  onOpenMenu,
  onNavigateUp,
  canNavigateUp,
  statusAction,
  searchProvider,
  searchActivationToken,
  searchRefreshToken,
  searchInputRef,
  showSearch,
  onBlurToFileList,
  searchQueryValue,
  onSearchQueryValueChange,
  disableSearchDropdown,
  suppressSearchDropdown,
  onSearchArrowDownToFileList,
  disableTabFocus,
  modeOptions,
  showKeyboardHints,
  navigationControls,
  liveSearchControls,
}: MobileToolbarProps) {
  const { t } = useTranslation();

  return (
    <>
      <IconButton
        color="inherit"
        edge="start"
        onClick={onOpenMenu}
        sx={{
          mr: 1,
          minWidth: 44,
          minHeight: 44,
          flexShrink: 0,
        }}
        aria-label={t("fileBrowser.chrome.mobileToolbar.openMenu")}
      >
        <SambeeLogo />
      </IconButton>

      {showSearch ? (
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <UnifiedSearchBar
            provider={searchProvider}
            activationToken={searchActivationToken}
            refreshToken={searchRefreshToken}
            inputRef={searchInputRef}
            useCompactLayout={true}
            onBlurToFileList={onBlurToFileList}
            queryValue={searchQueryValue}
            onQueryValueChange={onSearchQueryValueChange}
            disableDropdown={disableSearchDropdown}
            suppressDropdown={suppressSearchDropdown}
            onArrowDownToFileList={onSearchArrowDownToFileList}
            disableTabFocus={disableTabFocus}
            modeOptions={modeOptions}
            showKeyboardHints={showKeyboardHints}
            navigationControls={navigationControls}
            liveSearchControls={liveSearchControls}
          />
        </Box>
      ) : (
        <Box sx={{ flex: 1 }} />
      )}

      {statusAction ? <Box sx={{ display: "flex", alignItems: "center", ml: 0.5, flexShrink: 0 }}>{statusAction}</Box> : null}

      <IconButton
        color="inherit"
        onClick={onNavigateUp}
        disabled={!canNavigateUp}
        title={t("fileBrowser.chrome.mobileToolbar.navigateUpTitle")}
        aria-label={t("fileBrowser.chrome.mobileToolbar.navigateUpAriaLabel")}
        sx={{
          // Compensate for ArrowUpwardIcon's 4 px internal viewBox side margins so optical ink gaps
          // match SambeeLogo on the left (18 px to the Quick Bar and 6 px to the viewport edge).
          ml: statusAction ? -0.5 : 0.5,
          mr: -2,
          minWidth: 44,
          minHeight: 44,
          flexShrink: 0,
        }}
      >
        <ArrowUpwardIcon />
      </IconButton>
    </>
  );
}
