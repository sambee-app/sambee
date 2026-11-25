import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, onTestFinished, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";
import { createMockAuthToken } from "../../test/fixtures/users";
import { type ApiMock, createMarkdownViewerMock, setupSuccessfulApiMocks } from "../../test/helpers";
import { FileType } from "../../types";
import { QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY } from "../FileBrowser/preferences";

export const expectDirectoryLoad = (connectionId: string, path: string) => {
  expect(api.listDirectory).toHaveBeenCalledWith(
    connectionId,
    path,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    })
  );
};

export const completedTransferResult = {
  status: "completed",
  replaced: false,
  effects: { source: "unchanged", destination: "mutated" },
} as const;

export const cancelledTransferResult = {
  status: "cancelled",
  replaced: false,
  effects: { source: "unchanged", destination: "unchanged" },
} as const;

export const regularTransferTestItems = [
  {
    name: "Documents",
    path: "Documents",
    type: FileType.FILE,
    size: 1024,
    modified_at: "2024-01-13T10:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
  {
    name: "Pictures",
    path: "Pictures",
    type: FileType.FILE,
    size: 2048,
    modified_at: "2024-01-14T10:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
];

export const setupRegularFileTransferListing = () => {
  vi.mocked(api.listDirectory).mockImplementation((_connectionId, path = "") =>
    Promise.resolve(
      path === "" || path === "/"
        ? { path: "", items: regularTransferTestItems, total: regularTransferTestItems.length }
        : { path, items: [], total: 0 }
    )
  );
};

export function setupCompactNativeShare() {
  const originalMatchMedia = window.matchMedia;
  const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
  const originalCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare");
  const share = vi.fn().mockResolvedValue(undefined);
  const canShare = vi.fn().mockReturnValue(true);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: /max-width/.test(query),
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(navigator, "share", { configurable: true, value: share });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare });

  let restored = false;
  const restore = () => {
    if (restored) return;
    restored = true;
    window.matchMedia = originalMatchMedia;
    if (originalShare) Object.defineProperty(navigator, "share", originalShare);
    else Reflect.deleteProperty(navigator, "share");
    if (originalCanShare) Object.defineProperty(navigator, "canShare", originalCanShare);
    else Reflect.deleteProperty(navigator, "canShare");
  };
  // A timeout does not stop the test body; its late finally must not restore another test's mocks.
  onTestFinished(restore);
  return { share, canShare, restore };
}

// Mock the API module
vi.mock("../../services/api");

// Mock components using lazy mock factories
vi.mock("../../components/Viewer/MarkdownViewer", () => createMarkdownViewerMock());
// @tanstack/react-virtual mock - explicitly import the mock
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

export function setupFileBrowserInteractions() {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.copyItem).mockReset();
    vi.mocked(api.moveItem).mockReset();
    resetCurrentUserSettingsStoreForTests();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    localStorage.removeItem("selectedConnectionId");
    localStorage.removeItem(QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY);

    // Use mock factory for successful API responses
    setupSuccessfulApiMocks(api as unknown as ApiMock);
    vi.mocked(api.updateCurrentUserSettings).mockImplementation(async (update) => update as never);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });
}
