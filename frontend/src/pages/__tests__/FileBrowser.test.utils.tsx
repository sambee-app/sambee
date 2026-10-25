/**
 * Shared test utilities for FileBrowser component tests
 * Used by: FileBrowser-rendering.test.tsx, FileBrowser-navigation.test.tsx,
 *          FileBrowser-interactions.test.tsx, FileBrowser-viewer.test.tsx
 */

import { act, render } from "@testing-library/react";
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from "react-router-dom";
import { LocalePreferencesProvider } from "../../i18n/LocalePreferencesProvider";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import FileBrowser from "../FileBrowser";

const RouterLocationProbe = () => {
  const location = useLocation();
  return <output data-testid="router-location" hidden>{`${location.pathname}${location.search}`}</output>;
};

// Re-export test fixtures from centralized location
export {
  mockConnections,
  mockDirectoryListing,
  mockEmptyDirectory,
  mockFiles,
  mockFolders,
  mockNestedDirectory,
} from "../../test/fixtures";

// Helper function to render FileBrowser component with routing
export const renderBrowser = (initialPath = "/browse") => {
  const router = createMemoryRouter(
    [
      {
        element: (
          <>
            <RouterLocationProbe />
            <Outlet />
          </>
        ),
        children: [
          { path: "/browse/:targetType/:targetId/*", element: <FileBrowser /> },
          { path: "/browse", element: <FileBrowser /> },
          { path: "/login", element: <div>Login Page</div> },
        ],
      },
    ],
    { initialEntries: [initialPath] }
  );
  return {
    ...render(
      <LocalePreferencesProvider>
        <SambeeThemeProvider>
          <RouterProvider router={router} />
        </SambeeThemeProvider>
      </LocalePreferencesProvider>
    ),
    router,
  };
};

export const renderBrowserAndFlush = async (initialPath = "/browse") => {
  let result: ReturnType<typeof renderBrowser> | undefined;
  await act(async () => {
    result = renderBrowser(initialPath);
  });
  if (!result) throw new Error("FileBrowser did not mount during act");
  return result;
};
