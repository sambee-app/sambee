/**
 * Mock Factories - API Mock Setup Helpers
 * Reusable factory functions for common API mock patterns
 */

import type { Mock } from "vitest";
import { vi } from "vitest";
import type { LocalArchiveExecution } from "../../services/api";
import type { Connection, CurrentUserSettings, DirectoryListing, User } from "../../types";
import { mockConnections, mockDirectoryListing, mockEmptyDirectory, mockNestedDirectory } from "../fixtures";

export function createMockCurrentUserSettings(overrides: Partial<CurrentUserSettings> = {}): CurrentUserSettings {
  return {
    appearance: { theme_id: "sambee-light", custom_themes: [] },
    localization: { language: "browser", regional_locale: "browser" },
    browser: {
      quick_nav_include_dot_directories: false,
      quick_bar_shortcut_hint_visibility: "auto",
      touch_friendly_file_selection: "auto",
      file_browser_view_mode: "list",
      pane_mode: "single",
      selected_connection_id: null,
      viewer_associations: {},
    },
    text_editor: { max_file_size_bytes: 52428800, word_wrap_enabled: null },
    ...overrides,
  };
}

export function createMockLocalArchiveExecution(overrides: Partial<LocalArchiveExecution> = {}): LocalArchiveExecution {
  return {
    contract_version: "v2",
    execution_id: "test-execution",
    kind: "extract",
    phase: "streaming",
    revision: 1,
    progress: { completedMembers: 0, skippedMembers: 0, failedMembers: 0 },
    cancellation_requested: false,
    ...overrides,
  };
}

/**
 * API Mock Factory Interface
 */
export interface ApiMock {
  getConnections: Mock;
  listDirectory: Mock;
  listArchiveDirectory: Mock;
  listLocalLinkTargets: Mock;
  getCurrentUser: Mock;
  getCurrentUserSettings: Mock;
  testConnection: Mock;
  createConnection: Mock;
  updateConnection: Mock;
  deleteConnection: Mock;
  deleteItem: Mock;
  renameItem: Mock;
  getFileInfo: Mock;
  getImageBlob: Mock;
  searchDirectories: Mock;
  searchRecentDirectories: Mock;
  searchRecentFiles: Mock;
  recordRecentDirectory: Mock;
  recordRecentFile: Mock;
}

function setupStandardDirectoryListingMock(api: ApiMock): void {
  api.listDirectory.mockImplementation((_connectionId: string, path: string) => {
    if (path === "" || path === "/") {
      return Promise.resolve(mockDirectoryListing);
    }
    if (path === "/Documents" || path === "Documents") {
      return Promise.resolve(mockNestedDirectory);
    }
    return Promise.resolve(mockEmptyDirectory);
  });
}

/**
 * Setup default successful API mocks
 * Common scenario: API calls succeed with standard test data
 */
export function setupSuccessfulApiMocks(api: ApiMock): void {
  const defaultUserSettings: CurrentUserSettings = {
    appearance: { theme_id: "sambee-light", custom_themes: [] },
    localization: {
      language: "browser",
      regional_locale: "browser",
    },
    browser: {
      quick_nav_include_dot_directories: false,
      quick_bar_shortcut_hint_visibility: "auto",
      touch_friendly_file_selection: "auto",
      file_browser_view_mode: "list",
      pane_mode: "single",
      selected_connection_id: null,
      viewer_associations: {},
    },
    text_editor: {
      max_file_size_bytes: 52428800,
      word_wrap_enabled: null,
    },
  };

  api.getConnections.mockResolvedValue(mockConnections);
  setupStandardDirectoryListingMock(api);
  api.listArchiveDirectory.mockResolvedValue({
    archive: { path: "archive.zip", size: 0 },
    path: "",
    items: [],
    total: 0,
    page_size: 100,
  });
  api.listLocalLinkTargets.mockResolvedValue({ items: [] });
  api.getCurrentUser.mockResolvedValue({
    username: "admin",
    role: "admin",
  });
  api.getCurrentUserSettings.mockResolvedValue(defaultUserSettings);
  api.testConnection.mockResolvedValue({
    success: true,
    message: "Connection successful",
  });
  api.createConnection.mockImplementation((data: Partial<Connection>) => Promise.resolve({ id: "new-conn", ...data } as Connection));
  api.updateConnection.mockImplementation((_id: string, data: Partial<Connection>) =>
    Promise.resolve({ id: "conn-1", ...data } as Connection)
  );
  api.deleteConnection.mockResolvedValue(undefined);
  api.deleteItem.mockResolvedValue(undefined);

  // Mock renameItem to return a renamed FileInfo
  api.renameItem.mockImplementation((_connId: string, path: string, newName: string) =>
    Promise.resolve({
      name: newName,
      path: path.replace(/[^/]+$/, newName),
      type: "file",
      size: 1024,
      is_readable: true,
      is_hidden: false,
    })
  );
  api.getFileInfo.mockImplementation(async (_connectionId: string, path: string) => ({
    type: path.toLowerCase().endsWith(".zip") ? "file" : "directory",
  }));

  // Mock getImageBlob to return a fake blob
  api.getImageBlob.mockResolvedValue(new Blob(["fake-image-data"], { type: "image/png" }));

  // Mock searchDirectories for directory cache search
  api.searchDirectories.mockResolvedValue({
    results: [],
    total_matches: 0,
    cache_state: "ready",
    directory_count: 0,
  });
  api.searchRecentDirectories.mockResolvedValue({ results: [], result_limit: 10 });
  api.searchRecentFiles.mockResolvedValue({ results: [] });
  api.recordRecentDirectory.mockResolvedValue(null);
  api.recordRecentFile.mockResolvedValue(null);
}

/**
 * Setup empty state API mocks
 * Scenario: No connections or files available
 */
export function setupEmptyStateApiMocks(api: ApiMock): void {
  api.getConnections.mockResolvedValue([]);
  api.listDirectory.mockResolvedValue(mockEmptyDirectory);
}

/**
 * Setup error API mocks
 * Scenario: API calls fail with errors
 */
export function setupErrorApiMocks(api: ApiMock, status = 500): void {
  const error = {
    response: {
      data: { detail: "Internal server error" },
      status,
    },
  };

  api.getConnections.mockRejectedValue(error);
  api.listDirectory.mockRejectedValue(error);
  api.getCurrentUser.mockRejectedValue(error);
  api.testConnection.mockRejectedValue(error);
  api.createConnection.mockRejectedValue(error);
  api.updateConnection.mockRejectedValue(error);
  api.deleteConnection.mockRejectedValue(error);
  api.getImageBlob.mockRejectedValue(error);
}

/**
 * Setup navigation API mocks
 * Scenario: Supports multiple directory levels
 */
export function setupNavigationApiMocks(api: ApiMock): void {
  const defaultUserSettings: CurrentUserSettings = {
    appearance: { theme_id: "sambee-light", custom_themes: [] },
    localization: {
      language: "browser",
      regional_locale: "browser",
    },
    browser: {
      quick_nav_include_dot_directories: false,
      quick_bar_shortcut_hint_visibility: "auto",
      touch_friendly_file_selection: "auto",
      file_browser_view_mode: "list",
      pane_mode: "single",
      selected_connection_id: null,
      viewer_associations: {},
    },
    text_editor: {
      max_file_size_bytes: 52428800,
      word_wrap_enabled: null,
    },
  };

  api.getConnections.mockResolvedValue(mockConnections);
  api.getCurrentUserSettings.mockResolvedValue(defaultUserSettings);
  setupStandardDirectoryListingMock(api);
}

/**
 * Create a mock for unauthorized errors (401)
 */
export function createUnauthorizedError() {
  return {
    response: {
      data: { detail: "Unauthorized" },
      status: 401,
    },
  };
}

/**
 * Create a mock for forbidden errors (403)
 */
export function createForbiddenError() {
  return {
    response: {
      data: { detail: "Forbidden" },
      status: 403,
    },
  };
}

/**
 * Create a mock for not found errors (404)
 */
export function createNotFoundError() {
  return {
    response: {
      data: { detail: "Connection not found" },
      status: 404,
    },
  };
}

/**
 * Create a mock for network errors
 */
export function createNetworkError() {
  const error = new Error("Network Error") as Error & { code?: string };
  // Add additional properties to make it identifiable
  error.code = "ECONNREFUSED";
  return error;
}

/**
 * Create a mock for client timeout errors
 */
export function createTimeoutError() {
  const error = new Error("timeout of 40000ms exceeded") as Error & { code?: string };
  error.code = "ECONNABORTED";
  return error;
}

/**
 * Mock API factory - creates a fresh set of vi.fn() mocks
 */
export function createMockApi(): ApiMock {
  return {
    getConnections: vi.fn(),
    listDirectory: vi.fn(),
    listArchiveDirectory: vi.fn(),
    listLocalLinkTargets: vi.fn(),
    getCurrentUser: vi.fn(),
    getCurrentUserSettings: vi.fn(),
    testConnection: vi.fn(),
    createConnection: vi.fn(),
    updateConnection: vi.fn(),
    deleteConnection: vi.fn(),
    deleteItem: vi.fn(),
    renameItem: vi.fn(),
    getFileInfo: vi.fn(),
    getImageBlob: vi.fn(),
    searchDirectories: vi.fn(),
    searchRecentDirectories: vi.fn(),
    searchRecentFiles: vi.fn(),
    recordRecentDirectory: vi.fn(),
    recordRecentFile: vi.fn(),
  };
}

/**
 * Setup connection test mocks
 * Scenario: Testing connection functionality
 */
export function setupConnectionTestMocks(api: ApiMock, options: { success?: boolean; message?: string } = {}): void {
  const { success = true, message = "Connection successful" } = options;

  api.testConnection.mockResolvedValue({
    success,
    message,
  });
}

/**
 * Setup directory listing by path
 * Helper for creating custom navigation scenarios
 */
export function setupDirectoryListingByPath(api: ApiMock, pathMap: Record<string, DirectoryListing>): void {
  api.listDirectory.mockImplementation((_connectionId: string, path: string) => {
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    return Promise.resolve(pathMap[normalizedPath] || mockEmptyDirectory);
  });
}

/**
 * Setup admin user mock
 */
export function setupAdminUserMock(api: ApiMock, user?: Partial<User>): void {
  api.getCurrentUser.mockResolvedValue({
    username: "admin",
    role: "admin",
    ...user,
  });
}

/**
 * Setup regular user mock
 */
export function setupRegularUserMock(api: ApiMock, user?: Partial<User>): void {
  api.getCurrentUser.mockResolvedValue({
    username: "testuser",
    role: "editor",
    ...user,
  });
}
