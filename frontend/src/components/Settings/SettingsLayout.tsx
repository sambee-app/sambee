//
// SettingsLayout
//

import ArrowBackIcon from "@mui/icons-material/ArrowBack";
import { AppBar, Box, IconButton, Toolbar, Typography, useMediaQuery, useTheme } from "@mui/material";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  getMobileViewportShellSx,
  mobileSafeAreaAppBarSx,
  mobileSafeAreaToolbarSx,
  mobileScrollableContentSx,
} from "../../theme/mobileShell";
import { SettingsSidebar } from "./SettingsSidebar";
import { prefetchSettingsDataForItems } from "./settingsDataSources";
import {
  getSettingsMobileBackTarget,
  getSettingsNavItemByPath,
  getSettingsViewTitle,
  getVisibleSettingsNavItems,
} from "./settingsNavigation";
import { settingsCompactTypographyScopeSx } from "./settingsTypographyStyles";
import { SettingsAccessProvider, useSettingsAccess } from "./useSettingsAccess";

/**
 * SettingsLayout
 *
 * Responsive layout wrapper for settings pages.
 * Desktop: Shows persistent sidebar with content area on right.
 * Mobile: Shows full-page routes with AppBar.
 */
export function SettingsLayout() {
  const theme = useTheme();
  const isDesktop = useMediaQuery(theme.breakpoints.up("sm"));
  const navigate = useNavigate();
  const location = useLocation();
  const { isAdmin, canWrite } = useSettingsAccess();
  const { t } = useTranslation();

  useEffect(() => {
    prefetchSettingsDataForItems(getVisibleSettingsNavItems(isAdmin));
  }, [isAdmin]);

  // Get page title from current route
  const getPageTitle = () => {
    const item = getSettingsNavItemByPath(location.pathname);
    if (item) {
      return getSettingsViewTitle(item);
    }
    return getSettingsViewTitle("main");
  };

  const handleMobileBack = () => {
    const backTarget = getSettingsMobileBackTarget(location.pathname);
    if (backTarget) {
      navigate(backTarget);
      return;
    }

    navigate("/browse", { replace: true });
  };

  if (isDesktop) {
    // Desktop: Sidebar + Content Area
    return (
      <SettingsAccessProvider value={{ isAdmin, canWrite }}>
        <Box sx={{ display: "flex", height: "100vh" }}>
          <SettingsSidebar />
          <Box
            sx={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              overflow: "hidden",
            }}
          >
            <Outlet />
          </Box>
        </Box>
      </SettingsAccessProvider>
    );
  }

  // Mobile: Full-page with AppBar (edge-to-edge layout)
  return (
    <SettingsAccessProvider value={{ isAdmin, canWrite }}>
      <Box data-testid="settings-mobile-typography-scope" sx={[getMobileViewportShellSx(true), settingsCompactTypographyScopeSx]}>
        <AppBar position="static" sx={mobileSafeAreaAppBarSx}>
          <Toolbar sx={mobileSafeAreaToolbarSx}>
            <IconButton edge="start" color="inherit" onClick={handleMobileBack} aria-label={t("common.navigation.goBack")}>
              <ArrowBackIcon />
            </IconButton>
            <Typography variant="h6" component="h1" sx={{ ml: 2 }}>
              {getPageTitle()}
            </Typography>
          </Toolbar>
        </AppBar>
        <Box sx={mobileScrollableContentSx}>
          <Outlet />
        </Box>
      </Box>
    </SettingsAccessProvider>
  );
}
