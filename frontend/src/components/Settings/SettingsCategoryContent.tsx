import { Box, CircularProgress } from "@mui/material";
import { lazy, Suspense, useEffect } from "react";
import { useTranslation } from "react-i18next";
import ErrorBoundary from "../ErrorBoundary";
import { SettingsCategoryDescription } from "./SettingsCategoryDescription";
import { getSettingsNavItemLabel, getVisibleSettingsNavItems, type SettingsNavItem } from "./settingsNavigation";
import { SETTINGS_PAGE_LOADERS, scheduleSettingsPagePrefetch } from "./settingsPageLoaders";

const AboutSettings = lazy(SETTINGS_PAGE_LOADERS["admin-about"]);
const AccountSettings = lazy(SETTINGS_PAGE_LOADERS.account);
const AdvancedSettings = lazy(SETTINGS_PAGE_LOADERS["admin-system"]);
const AuthenticationSettings = lazy(SETTINGS_PAGE_LOADERS["admin-authentication"]);
const ConnectionsSettings = lazy(SETTINGS_PAGE_LOADERS.connections);
const FileBrowserSettings = lazy(SETTINGS_PAGE_LOADERS["file-browser"]);
const FileSearchSettings = lazy(SETTINGS_PAGE_LOADERS["admin-file-search"]);
const LocalDrivesSettings = lazy(SETTINGS_PAGE_LOADERS["local-drives"]);
const NetworkSettings = lazy(SETTINGS_PAGE_LOADERS["admin-network"]);
const AppearanceSettings = lazy(SETTINGS_PAGE_LOADERS.appearance);
const SmbSettings = lazy(SETTINGS_PAGE_LOADERS["admin-smb"]);
const TextEditorSettings = lazy(SETTINGS_PAGE_LOADERS["text-editor"]);
const UserManagementSettings = lazy(SETTINGS_PAGE_LOADERS["admin-users"]);

interface SettingsCategoryContentProps {
  item: SettingsNavItem;
  isAdmin: boolean;
  onConnectionsChanged?: () => void;
  dialogSafeHeader?: boolean;
  forceDesktopLayout?: boolean;
  setMobileBackHandler?: (handler: (() => void) | null) => void;
}

export function SettingsCategoryContent(props: SettingsCategoryContentProps) {
  const { t } = useTranslation();

  return (
    <ErrorBoundary key={props.item}>
      <Suspense
        fallback={
          <Box role="status" aria-label={t("app.loading")} sx={{ display: "flex", justifyContent: "center", p: 3 }}>
            <CircularProgress size={24} />
          </Box>
        }
      >
        <SettingsCategoryPage {...props} />
      </Suspense>
    </ErrorBoundary>
  );
}

function SettingsCategoryPage({
  item,
  isAdmin,
  onConnectionsChanged,
  dialogSafeHeader = false,
  forceDesktopLayout = false,
}: SettingsCategoryContentProps) {
  useEffect(() => {
    return scheduleSettingsPagePrefetch(getVisibleSettingsNavItems(isAdmin).filter((category) => category !== item));
  }, [isAdmin, item]);

  switch (item) {
    case "appearance":
      return <AppearanceSettings />;
    case "account":
      return <AccountSettings dialogSafe={dialogSafeHeader} />;
    case "file-browser":
      return <FileBrowserSettings />;
    case "text-editor":
      return <TextEditorSettings />;
    case "connections":
      return (
        <ConnectionsSettings
          isAdmin={isAdmin}
          onConnectionsChanged={onConnectionsChanged}
          dialogSafeHeader={dialogSafeHeader}
          forceDesktopLayout={forceDesktopLayout}
        />
      );
    case "local-drives":
      return (
        <LocalDrivesSettings
          onConnectionsChanged={onConnectionsChanged}
          sectionTitle={getSettingsNavItemLabel("local-drives")}
          sectionDescription={<SettingsCategoryDescription category="local-drives" />}
        />
      );
    case "admin-network":
      return isAdmin ? <NetworkSettings /> : null;
    case "admin-authentication":
      return isAdmin ? <AuthenticationSettings /> : null;
    case "admin-smb":
      return isAdmin ? <SmbSettings dialogSafeHeader={dialogSafeHeader} /> : null;
    case "admin-file-search":
      return isAdmin ? <FileSearchSettings /> : null;
    case "admin-system":
      return isAdmin ? <AdvancedSettings dialogSafeHeader={dialogSafeHeader} /> : null;
    case "admin-about":
      return isAdmin ? <AboutSettings dialogSafeHeader={dialogSafeHeader} /> : null;
    case "admin-users":
      return isAdmin ? <UserManagementSettings dialogSafeHeader={dialogSafeHeader} /> : null;
  }
}
