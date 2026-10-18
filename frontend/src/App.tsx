import { ThemeProvider } from "@mui/material";
import CssBaseline from "@mui/material/CssBaseline";
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createBrowserRouter, createRoutesFromElements, Navigate, Outlet, Route, RouterProvider, useOutletContext } from "react-router-dom";
import AppUpdatePrompt from "./components/AppUpdatePrompt";
import ErrorBoundary from "./components/ErrorBoundary";
import { SettingsCategoryContent } from "./components/Settings/SettingsCategoryContent";
import { SettingsLayout } from "./components/Settings/SettingsLayout";
import { SETTINGS_CATEGORY_ORDER, SETTINGS_ROUTE_BY_CATEGORY, type SettingsCategory } from "./components/Settings/settingsNavigation";
import { useSettingsAccess } from "./components/Settings/useSettingsAccess";
import { useBackendRecoveryMonitor } from "./hooks/useBackendRecoveryMonitor";
import { useDraftRecoveryCleanup } from "./hooks/useDraftRecoveryCleanup";
import { useFocusTrap } from "./hooks/useFocusTrap";
import { translate } from "./i18n";
import { CompanionLocalizationSync } from "./i18n/CompanionLocalizationSync";
import { LocalePreferencesProvider } from "./i18n/LocalePreferencesProvider";
import PasswordChange, { PasswordChangeGate } from "./pages/PasswordChange";
import { startControlledReauthentication } from "./services/api";
import { authSession } from "./services/authSession";
import { useBackendAvailability } from "./services/backendAvailability";
import { emitBackendRecoveryConfirmed, emitBackendRecoveryReconnect } from "./services/backendRecoveryEvents";
import { SambeeThemeProvider, useSambeeTheme } from "./theme";

// Lazy load route components for better code splitting
const Login = lazy(() => import("./pages/Login"));
const OidcCallback = lazy(() => import("./pages/OidcCallback"));
const FileBrowser = lazy(() => import("./pages/FileBrowser"));

function SettingsRoutePage({ item }: { item: SettingsCategory }) {
  const { isAdmin } = useSettingsAccess();
  return <SettingsCategoryContent item={item} isAdmin={isAdmin} />;
}

function ProtectedRoutes() {
  const ready = useOutletContext<boolean>();
  return <PasswordChangeGate ready={ready} />;
}

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
        <Suspense fallback={<div>{translate("app.loading")}</div>}>
          <Outlet context={authBootstrapComplete} />
        </Suspense>
      </div>
    </ThemeProvider>
  );
}

//
// App
//

const router = createBrowserRouter(
  createRoutesFromElements(
    <Route element={<AppContent />}>
      <Route path="/login" element={<Login />} />
      <Route path="/login/oidc/callback" element={<OidcCallback />} />
      <Route path="/change-password" element={<PasswordChange />} />
      <Route element={<ProtectedRoutes />}>
        <Route path="/browse/:targetType/:targetId/*" element={<FileBrowser />} />
        <Route path="/browse" element={<FileBrowser />} />
        <Route path="/settings" element={<SettingsLayout />}>
          <Route index element={<Navigate to="/settings/appearance" replace />} />
          {SETTINGS_CATEGORY_ORDER.map((item) => (
            <Route
              key={item}
              path={SETTINGS_ROUTE_BY_CATEGORY[item].slice("/settings/".length)}
              element={<SettingsRoutePage item={item} />}
            />
          ))}
          <Route path="sessions" element={<Navigate to="/settings/account" replace />} />
          <Route path="preferences" element={<Navigate to="/settings/appearance" replace />} />
          <Route path="connections/smb" element={<Navigate to="/settings/connections" replace />} />
        </Route>
        <Route path="/" element={<Navigate to="/browse" replace />} />
      </Route>
      <Route path="*" element={null} />
    </Route>
  )
);

function App() {
  return (
    <ErrorBoundary>
      <LocalePreferencesProvider>
        <SambeeThemeProvider>
          <RouterProvider router={router} />
        </SambeeThemeProvider>
      </LocalePreferencesProvider>
    </ErrorBoundary>
  );
}

export default App;
