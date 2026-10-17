import { ThemeProvider } from "@mui/material";
import CssBaseline from "@mui/material/CssBaseline";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { Navigate, Route, BrowserRouter as Router, Routes } from "react-router-dom";
import AppUpdatePrompt from "./components/AppUpdatePrompt";
import ErrorBoundary from "./components/ErrorBoundary";
import { SettingsLayout } from "./components/Settings/SettingsLayout";
import { useBackendRecoveryMonitor } from "./hooks/useBackendRecoveryMonitor";
import { useDraftRecoveryCleanup } from "./hooks/useDraftRecoveryCleanup";
import { useFocusTrap } from "./hooks/useFocusTrap";
import { translate } from "./i18n";
import { CompanionLocalizationSync } from "./i18n/CompanionLocalizationSync";
import { LocalePreferencesProvider } from "./i18n/LocalePreferencesProvider";
import { AccountSettings } from "./pages/AccountSettings";
import { AdvancedSettings } from "./pages/AdvancedSettings";
import { AuthenticationSettings } from "./pages/AuthenticationSettings";
import { ConnectionsSettings } from "./pages/ConnectionsSettings";
import { FileBrowserSettings } from "./pages/FileBrowserSettings";
import { LocalDrivesSettings } from "./pages/LocalDrivesSettings";
import { NetworkSettings } from "./pages/NetworkSettings";
import PasswordChange, { PasswordChangeGate } from "./pages/PasswordChange";
import { AppearanceSettings } from "./pages/PreferencesSettings";
import { TextEditorSettings } from "./pages/TextEditorSettings";
import { UserManagementSettings } from "./pages/UserManagementSettings";
import { startControlledReauthentication } from "./services/api";
import { authSession } from "./services/authSession";
import { useBackendAvailability } from "./services/backendAvailability";
import { emitBackendRecoveryConfirmed, emitBackendRecoveryReconnect } from "./services/backendRecoveryEvents";
import { SambeeThemeProvider, useSambeeTheme } from "./theme";

// Lazy load route components for better code splitting
const Login = lazy(() => import("./pages/Login"));
const OidcCallback = lazy(() => import("./pages/OidcCallback"));
const FileBrowser = lazy(() => import("./pages/FileBrowser"));

//
// AppContent
//

/**
 * Inner app component that uses the theme
 */
function AppContent() {
  const { muiTheme } = useSambeeTheme();
  const appRef = useRef<HTMLDivElement>(null);
  const [authBootstrapComplete, setAuthBootstrapComplete] = useState(authSession.isBootstrapComplete());
  const backendAvailability = useBackendAvailability();
  useFocusTrap(appRef);
  useDraftRecoveryCleanup();

  useEffect(() => {
    const unsubscribe = authSession.subscribeToBootstrap(() => setAuthBootstrapComplete(true));
    void authSession.bootstrap().finally(() => setAuthBootstrapComplete(true));
    return unsubscribe;
  }, []);

  useBackendRecoveryMonitor({
    status: backendAvailability.status,
    onReconnectNow: (reason) => {
      emitBackendRecoveryReconnect(reason);
    },
    onAuthenticationFailure: startControlledReauthentication,
    onRecovered: (_reason, wasRecovering) => {
      if (wasRecovering) {
        return;
      }

      emitBackendRecoveryConfirmed("health-probe-success");
    },
  });

  return (
    <ThemeProvider theme={muiTheme}>
      <CssBaseline />
      <AppUpdatePrompt />
      <CompanionLocalizationSync />
      <div ref={appRef}>
        <Router>
          <Suspense fallback={<div>{translate("app.loading")}</div>}>
            <Routes>
              <Route path="/login" element={<Login />} />
              <Route path="/login/oidc/callback" element={<OidcCallback />} />
              <Route path="/change-password" element={<PasswordChange />} />
              <Route element={<PasswordChangeGate ready={authBootstrapComplete} />}>
                <Route
                  path="/browse/:targetType/:targetId/*"
                  element={authBootstrapComplete ? <FileBrowser /> : <div>{translate("app.loading")}</div>}
                />
                <Route path="/browse" element={authBootstrapComplete ? <FileBrowser /> : <div>{translate("app.loading")}</div>} />
                <Route path="/settings" element={authBootstrapComplete ? <SettingsLayout /> : <div>{translate("app.loading")}</div>}>
                  <Route index element={<Navigate to="/settings/appearance" replace />} />
                  <Route path="appearance" element={<AppearanceSettings />} />
                  <Route path="account" element={<AccountSettings />} />
                  <Route path="sessions" element={<Navigate to="/settings/account" replace />} />
                  <Route path="file-browser" element={<FileBrowserSettings />} />
                  <Route path="text-editor" element={<TextEditorSettings />} />
                  <Route path="preferences" element={<Navigate to="/settings/appearance" replace />} />
                  <Route path="connections" element={<ConnectionsSettings />} />
                  <Route path="connections/local-drives" element={<LocalDrivesSettings />} />
                  <Route path="connections/smb" element={<Navigate to="/settings/connections" replace />} />
                  <Route path="admin/users" element={<UserManagementSettings />} />
                  <Route path="admin/authentication" element={<AuthenticationSettings />} />
                  <Route path="admin/network" element={<NetworkSettings />} />
                  <Route path="admin/system" element={<AdvancedSettings />} />
                </Route>
                <Route path="/" element={<Navigate to="/browse" replace />} />
              </Route>
            </Routes>
          </Suspense>
        </Router>
      </div>
    </ThemeProvider>
  );
}

//
// App
//

function App() {
  return (
    <ErrorBoundary>
      <LocalePreferencesProvider>
        <SambeeThemeProvider>
          <AppContent />
        </SambeeThemeProvider>
      </LocalePreferencesProvider>
    </ErrorBoundary>
  );
}

export default App;
