import { Box, CircularProgress } from "@mui/material";
import { lazy, Suspense } from "react";
import { useTranslation } from "react-i18next";
import ErrorBoundary from "../ErrorBoundary";
import { SettingsCategoryDescription } from "./SettingsCategoryDescription";
import { getSettingsNavItemLabel, type SettingsNavItem } from "./settingsNavigation";

const AboutSettings = lazy(() => import("../../pages/AboutSettings").then((module) => ({ default: module.AboutSettings })));
const AccountSettings = lazy(() => import("../../pages/AccountSettings").then((module) => ({ default: module.AccountSettings })));
const AdvancedSettings = lazy(() => import("../../pages/AdvancedSettings").then((module) => ({ default: module.AdvancedSettings })));
const AuthenticationSettings = lazy(() =>
  import("../../pages/AuthenticationSettings").then((module) => ({ default: module.AuthenticationSettings }))
);
const ConnectionsSettings = lazy(() =>
  import("../../pages/ConnectionsSettings").then((module) => ({ default: module.ConnectionsSettings }))
);
const FileBrowserSettings = lazy(() =>
  import("../../pages/FileBrowserSettings").then((module) => ({ default: module.FileBrowserSettings }))
);
const FileSearchSettings = lazy(() => import("../../pages/FileSearchSettings").then((module) => ({ default: module.FileSearchSettings })));
const LocalDrivesSettings = lazy(() =>
  import("../../pages/LocalDrivesSettings").then((module) => ({ default: module.LocalDrivesSettings }))
);
const NetworkSettings = lazy(() => import("../../pages/NetworkSettings").then((module) => ({ default: module.NetworkSettings })));
const AppearanceSettings = lazy(() => import("../../pages/PreferencesSettings").then((module) => ({ default: module.AppearanceSettings })));
const SmbSettings = lazy(() => import("../../pages/SmbSettings").then((module) => ({ default: module.SmbSettings })));
const TextEditorSettings = lazy(() => import("../../pages/TextEditorSettings").then((module) => ({ default: module.TextEditorSettings })));
const UserManagementSettings = lazy(() =>
  import("../../pages/UserManagementSettings").then((module) => ({ default: module.UserManagementSettings }))
);

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
