//
// MobileSettingsDrawer
//

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { AppBar, Box, Drawer, IconButton, Toolbar, Typography } from "@mui/material";
import type React from "react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getMobileViewportShellSx,
  mobileFullscreenDrawerPaperSx,
  mobileSafeAreaAppBarSx,
  mobileSafeAreaToolbarSx,
  mobileScrollableContentSx,
} from "../../theme/mobileShell";
import { FORM_SURFACE_CSS_VARIABLE, getOverlaySurfaceTokens, OVERLAY_SURFACE_CSS_VARIABLE } from "../../theme/palette";
import { SettingsCategoryContent } from "../Settings/SettingsCategoryContent";
import { SettingsCategoryList } from "../Settings/SettingsCategoryList";
import { prefetchSettingsDataForItems } from "../Settings/settingsDataSources";
import { getSettingsViewTitle, getVisibleSettingsSections, type MobileSettingsView } from "../Settings/settingsNavigation";
import { settingsCompactTypographyScopeSx } from "../Settings/settingsTypographyStyles";
import { useSettingsAccess } from "../Settings/useSettingsAccess";

interface MobileSettingsDrawerProps {
  open: boolean;
  onClose: () => void;
  /** Callback when connections are added, updated, or deleted */
  onConnectionsChanged?: () => void;
  /** Initial view to show when drawer opens */
  initialView?: MobileSettingsView;
  view?: MobileSettingsView;
  onNavigate?: (view: MobileSettingsView) => void;
  onBack?: () => void;
}

/**
 * MobileSettingsDrawer
 *
 * Full-screen drawer for mobile settings.
 * Preserves underlying page state by using drawer instead of routing.
 */
export const MobileSettingsDrawer: React.FC<MobileSettingsDrawerProps> = ({
  open,
  onClose,
  onConnectionsChanged,
  initialView = "main",
  view,
  onNavigate,
  onBack,
}) => {
  const [localView, setLocalView] = useState<MobileSettingsView>(initialView);
  const currentView = view ?? localView;
  const setCurrentView = onNavigate ?? setLocalView;
  const { isAdmin } = useSettingsAccess(open);
  const { t } = useTranslation();

  // Set view to initialView when drawer opens, reset when closes
  useEffect(() => {
    if (open) {
      if (view === undefined) setLocalView(initialView);
      prefetchSettingsDataForItems(getVisibleSettingsSections(isAdmin).flatMap((section) => section.categories));
    }
  }, [initialView, isAdmin, open, view]);

  const handleBack = () => {
    if (onBack) {
      onBack();
      return;
    }
    if (currentView === "main") {
      onClose();
    } else {
      setCurrentView("main");
    }
  };

  return (
    <Drawer
      anchor="right"
      open={open}
      onClose={onClose}
      slotProps={{
        paper: {
          sx: (theme) => {
            const surfaces = getOverlaySurfaceTokens(theme.palette.background.default, theme.palette.mode);
            return {
              ...mobileFullscreenDrawerPaperSx,
              [OVERLAY_SURFACE_CSS_VARIABLE]: surfaces.paper,
              [FORM_SURFACE_CSS_VARIABLE]: surfaces.form,
            };
          },
        },
      }}
    >
      <Box data-testid="settings-mobile-typography-scope" sx={[getMobileViewportShellSx(), settingsCompactTypographyScopeSx]}>
        {/* AppBar */}
        <AppBar position="static" sx={mobileSafeAreaAppBarSx}>
          <Toolbar sx={mobileSafeAreaToolbarSx}>
            <IconButton edge="start" color="inherit" onClick={handleBack} aria-label={t("common.navigation.goBack")}>
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="h6" component="h1" sx={{ ml: 2 }}>
              {getSettingsViewTitle(currentView)}
            </Typography>
          </Toolbar>
        </AppBar>

        {/* Content */}
        <Box sx={mobileScrollableContentSx}>
          {currentView === "main" && (
            <Box sx={{ height: "100%", bgcolor: "background.default" }}>
              <SettingsCategoryList
                sections={getVisibleSettingsSections(isAdmin)}
                onSelect={setCurrentView}
                showChevron
                showDividers
                wrapItemsInListItem
                listSx={{ py: 0, pt: 1 }}
                sectionSx={{ "&:not(:first-of-type)": { mt: 2 } }}
                subheaderSx={{ bgcolor: "background.default", textTransform: "uppercase", letterSpacing: 0.8 }}
                itemButtonSx={{ py: 2 }}
                itemIconSx={{ color: "primary.main" }}
                primaryTypographyProps={{ sx: { fontWeight: "medium" } }}
              />
            </Box>
          )}

          {currentView !== "main" && (
            <SettingsCategoryContent item={currentView} isAdmin={isAdmin} onConnectionsChanged={onConnectionsChanged} />
          )}
        </Box>
      </Box>
    </Drawer>
  );
};
