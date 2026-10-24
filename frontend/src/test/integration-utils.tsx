/**
 * Integration Test Utilities
 *
 * Helper functions for integration testing with MSW and React Testing Library.
 * These utilities make it easier to test complete user workflows.
 */

import { createTheme, ThemeProvider } from "@mui/material";
import CssBaseline from "@mui/material/CssBaseline";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import type { ReactElement } from "react";
import { Suspense } from "react";
import { MemoryRouter, Navigate, Route, Routes } from "react-router-dom";
import { expect } from "vitest";
import FileBrowser from "../pages/FileBrowser";
import Login from "../pages/Login";
import { server } from "./mocks/server";

const theme = createTheme({
  palette: {
    mode: "light",
    primary: {
      main: "#1976d2",
    },
    secondary: {
      main: "#dc004e",
    },
  },
});

/**
 * Render the full App with MemoryRouter for integration testing
 */
export function renderApp(initialRoute = "/") {
  return render(
    <ThemeProvider theme={theme}>
      <CssBaseline />
      <MemoryRouter initialEntries={[initialRoute]}>
        <Suspense fallback={<div>Loading...</div>}>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/browse/:targetType/:targetId/*" element={<FileBrowser />} />
            <Route path="/browse" element={<FileBrowser />} />
            <Route path="/" element={<Navigate to="/browse" replace />} />
          </Routes>
        </Suspense>
      </MemoryRouter>
    </ThemeProvider>
  );
}

/**
 * Render a component with React Router
 */
export function renderWithRouter(ui: ReactElement, { initialRoute = "/" } = {}) {
  return render(<MemoryRouter initialEntries={[initialRoute]}>{ui}</MemoryRouter>);
}

/**
 * Login helper for integration tests
 * Fills in the login form and submits it
 */
export async function loginUser(username = "testuser", password = "testpass") {
  const user = userEvent.setup();

  // Find and fill login form
  const usernameInput = screen.getByLabelText(/username/i);
  const passwordInput = screen.getByLabelText(/password/i);
  const loginButton = screen.getByRole("button", { name: /log in/i });

  await user.type(usernameInput, username);
  await user.type(passwordInput, password);
  await user.click(loginButton);

  // Wait for login to complete (redirect or token storage)
  await waitFor(
    () => {
      expect(screen.queryByRole("button", { name: /log in/i })).not.toBeInTheDocument();
    },
    { timeout: 3000 }
  );
}

/**
 * Login as admin helper
 */
export async function loginAsAdmin() {
  return loginUser("admin", "admin");
}

/**
 * Wait for loading to finish
 */
export async function waitForLoadingToFinish() {
  await waitFor(() => {
    expect(screen.queryByText(/loading/i)).not.toBeInTheDocument();
  });
}

/**
 * Create mock file list for testing
 */
export function createMockFiles(count = 5, prefix = "file") {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i + 1}.txt`,
    type: "file" as const,
    size: 1024 * (i + 1),
    modified: Date.now() - i * 1000,
  }));
}

/**
 * Create mock directory list
 */
export function createMockDirectories(count = 3, prefix = "folder") {
  return Array.from({ length: count }, (_, i) => ({
    name: `${prefix}-${i + 1}`,
    type: "directory" as const,
    size: 0,
    modified: Date.now() - i * 1000,
  }));
}

/**
 * Create mock connection
 */
export function createMockConnection(
  id: number,
  name: string,
  options: Partial<{
    host: string;
    share: string;
    username: string;
  }> = {}
) {
  return {
    id,
    name,
    host: options.host || `192.168.1.${100 + id}`,
    share: options.share || "SharedFolder",
    username: options.username || "testuser",
  };
}

/**
 * MSW Scenario Helpers
 * These functions override MSW handlers to simulate different scenarios
 */

/**
 * Mock successful API responses
 */
export function mockApiSuccess() {
  // Default handlers are already success scenarios
  server.resetHandlers();
}

/**
 * Mock API failure for specific endpoint
 */
export function mockApiError(endpoint: string, status = 500) {
  // Convert relative paths to absolute URLs for MSW matching
  const fullEndpoint = endpoint.startsWith("http") ? endpoint : `http://localhost:3000${endpoint}`;
  server.use(
    http.all(fullEndpoint, () => {
      return HttpResponse.json({ error: "Internal server error", detail: "Mocked error" }, { status });
    })
  );
}

/**
 * Mock network error
 */
export function mockNetworkError(endpoint: string) {
  // Convert relative paths to absolute URLs for MSW matching
  const fullEndpoint = endpoint.startsWith("http") ? endpoint : `http://localhost:3000${endpoint}`;
  server.use(
    http.all(fullEndpoint, () => {
      return HttpResponse.error();
    })
  );
}

/**
 * Mock slow network (delayed response)
 */
export function mockSlowNetwork(endpoint: string, delay = 3000) {
  server.use(
    http.all(endpoint, async () => {
      await new Promise((resolve) => setTimeout(resolve, delay));
      return HttpResponse.json({ success: true });
    })
  );
}

/**
 * Mock unauthorized response
 */
export function mockUnauthorized(endpoint: string) {
  const fullEndpoint = endpoint.startsWith("http") ? endpoint : `http://localhost:3000${endpoint}`;
  server.use(
    http.all(fullEndpoint, () => {
      return HttpResponse.json({ error: "Unauthorized" }, { status: 401 });
    })
  );
}

/**
 * Mock empty connections list
 */
export function mockNoConnections() {
  server.use(
    http.get("http://localhost:8000/api/connections", () => {
      return HttpResponse.json([]);
    })
  );
}

/**
 * Mock empty directory
 */
export function mockEmptyDirectory() {
  server.use(
    http.post("http://localhost:8000/api/browse", async ({ request }) => {
      const body = (await request.json()) as { path: string };
      return HttpResponse.json({
        path: body.path || "/",
        files: [],
      });
    })
  );
}

/**
 * Mock specific connections
 */
export function mockConnections(
  connections: Array<{
    id: number;
    name: string;
    host: string;
    share: string;
    username: string;
  }>
) {
  server.use(
    http.get("http://localhost:8000/api/connections", () => {
      return HttpResponse.json(connections);
    })
  );
}

/**
 * Mock specific files/directories
 */
export function mockBrowseFiles(
  files: Array<{
    name: string;
    type: "file" | "directory";
    size: number;
    modified: number;
  }>
) {
  server.use(
    http.post("http://localhost:8000/api/browse", async ({ request }) => {
      const body = (await request.json()) as { path: string };
      return HttpResponse.json({
        path: body.path || "/",
        files,
      });
    })
  );
}

/**
 * Mock file viewer content
 */
export function mockFileView(content: string, mimeType = "text/plain") {
  server.use(
    http.get("http://localhost:8000/api/viewer/:connectionId/file", () => {
      return HttpResponse.text(content, {
        headers: {
          "Content-Type": mimeType,
        },
      });
    })
  );
}

/**
 * Wait for element and get it
 */
export async function waitForElement(role: string, options?: { name?: RegExp | string }) {
  return await screen.findByRole(role, options);
}

/**
 * Check if element exists (without throwing)
 */
export function elementExists(role: string, options?: { name?: RegExp | string }) {
  return screen.queryByRole(role, options) !== null;
}

/**
 * Debug helper - prints current DOM
 */
export function debugScreen() {
  screen.debug(undefined, 100000); // Large limit to see full DOM
}

/**
 * Assert no errors are displayed
 */
export function assertNoErrors() {
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(screen.queryByText(/error/i)).not.toBeInTheDocument();
}

/**
 * Assert error is displayed
 */
export async function assertErrorShown(errorText?: string | RegExp) {
  if (errorText) {
    await waitFor(() => {
      expect(screen.getByText(errorText)).toBeInTheDocument();
    });
  } else {
    await waitFor(() => {
      const alert = screen.queryByRole("alert");
      const errorMessage = screen.queryByText(/error/i);
      expect(alert || errorMessage).toBeInTheDocument();
    });
  }
}

/**
 * Simulate typing in a search box
 */
export async function searchFor(query: string) {
  const user = userEvent.setup();
  const searchInput = screen.getByRole("searchbox");
  await user.clear(searchInput);
  await user.type(searchInput, query);
}

/**
 * Navigate to a route (for testing with MemoryRouter)
 */
export async function navigateTo(path: string) {
  // This would need to be implemented based on your routing setup
  // For now, it's a placeholder
  window.history.pushState({}, "", path);
}
