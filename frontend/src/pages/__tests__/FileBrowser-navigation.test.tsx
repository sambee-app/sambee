import { createMockAuthToken } from "../../test/fixtures/users";
import { requireTestValue, uninitializedTestCallback } from "../../test/helpers/assertions";
/**
 * Browser Component - Navigation Tests
 * Tests for directory navigation, breadcrumbs, URL handling, and connection switching
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { type ApiMock, createMarkdownViewerMock, createSettingsDialogMock, setupNavigationApiMocks } from "../../test/helpers";
import { createMockCurrentUserSettings } from "../../test/helpers/mockFactories";
import type { FileInfo } from "../../types";
import { FileType } from "../../types";
import { mockDirectoryListing, renderBrowserAndFlush } from "./FileBrowser.test.utils";

const expectDirectoryLoad = (connectionId: string, path: string) => {
  expect(api.listDirectory).toHaveBeenCalledWith(
    connectionId,
    path,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    })
  );
};

const createDirectoryEntry = (name: string, path: string): FileInfo => ({
  name,
  path,
  type: FileType.DIRECTORY,
  size: undefined,
  modified_at: "2024-01-12T10:00:00Z",
  is_readable: true,
  is_hidden: false,
});

const createFileEntry = (name: string, path: string): FileInfo => ({
  name,
  path,
  type: FileType.FILE,
  size: 512,
  modified_at: "2024-01-12T10:00:00Z",
  is_readable: true,
  is_hidden: false,
});

// Mock the API module
vi.mock("../../services/api");

// Mock components using lazy mock factories
vi.mock("../../components/Viewer/MarkdownViewer", () => createMarkdownViewerMock());
vi.mock("../../components/Settings/SettingsDialog", () => createSettingsDialogMock());
// @tanstack/react-virtual mock - explicitly import the mock
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

describe("Browser Component - Navigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    localStorage.removeItem("selectedConnectionId");

    // Use navigation mock factory for directory navigation tests
    setupNavigationApiMocks(api as unknown as ApiMock);
  });

  it("navigates into folder when clicking directory", async () => {
    const subfolderFiles: FileInfo[] = [
      {
        name: "file1.txt",
        path: "Documents/file1.txt",
        type: FileType.FILE,
        size: 512,
        modified_at: "2024-01-12T10:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    // Setup mock to return different results for different paths
    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path) => {
      if (path === "") {
        return mockDirectoryListing;
      }
      if (path === "Documents") {
        return {
          items: subfolderFiles,
          path: "Documents",
          total: subfolderFiles.length,
        };
      }
      return mockDirectoryListing; // fallback
    });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    // Wait for Documents to load (may appear multiple times in UI)
    await waitFor(() => {
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    // Click on Documents folder - get the button role to be more specific
    const documentsFolders = screen.getAllByRole("button", { name: /documents/i });
    await user.click(requireTestValue(documentsFolders[0]));

    // Should load files from Documents directory
    await waitFor(() => {
      expectDirectoryLoad("conn-1", "Documents");
    });
    await waitFor(() => {
      const file1Elements = screen.getAllByText("file1.txt");
      expect(file1Elements.length).toBeGreaterThan(0);
      expect(screen.getByTestId("file-list-container")).toHaveFocus();
    });
  });

  it("starts a fresh typeahead search immediately after a delayed keyboard directory navigation", async () => {
    const destinationFiles = [createFileEntry("Alpha.txt", "Destination/Alpha.txt"), createFileEntry("Zebra.txt", "Destination/Zebra.txt")];
    const rootFiles = [createDirectoryEntry("Destination", "Destination"), createFileEntry("Other.txt", "Other.txt")];
    let resolveDestination: ((value: { items: FileInfo[]; path: string; total: number }) => void) | undefined;

    vi.mocked(api.listDirectory).mockImplementation((_connectionId, path) => {
      if (path === "Destination") {
        return new Promise((resolve) => {
          resolveDestination = resolve;
        });
      }

      return Promise.resolve({ items: rootFiles, path: "", total: rootFiles.length });
    });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    const listContainer = await screen.findByTestId("file-list-container");
    listContainer.focus();
    await user.keyboard("d");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /folder: destination/i })).toHaveAttribute("data-selected", "true");
    });

    await user.keyboard("{Enter}");
    await waitFor(() => {
      expectDirectoryLoad("conn-1", "Destination");
      expect(screen.getByRole("progressbar")).toBeInTheDocument();
    });

    resolveDestination?.({ items: destinationFiles, path: "Destination", total: destinationFiles.length });

    const destinationList = await screen.findByTestId("file-list-container");
    expect(destinationList).toHaveFocus();

    await user.keyboard("z");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /file: zebra\.txt/i })).toHaveAttribute("data-selected", "true");
    });
  });

  it("clears the typeahead search when a file-list item consumes Escape", async () => {
    const rootFiles = [createDirectoryEntry("Destination", "Destination"), createFileEntry("Other.txt", "Other.txt")];
    vi.mocked(api.listDirectory).mockResolvedValue({ items: rootFiles, path: "", total: rootFiles.length });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    const listContainer = await screen.findByTestId("file-list-container");
    listContainer.focus();
    await user.keyboard("d");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /folder: destination/i })).toHaveAttribute("data-selected", "true");
    });

    const destinationButton = screen.getByRole("button", { name: /folder: destination/i });
    destinationButton.focus();
    destinationButton.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.stopPropagation();
      }
    });

    await user.keyboard("{Escape}o");
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /file: other\.txt/i })).toHaveAttribute("data-selected", "true");
    });
  });

  it("retains typeahead focus when revisiting a cached directory with the same item count", async () => {
    const destinationFiles = [createFileEntry("Alpha.txt", "Destination/Alpha.txt"), createFileEntry("Zebra.txt", "Destination/Zebra.txt")];
    const rootFiles = [createDirectoryEntry("Destination", "Destination"), createFileEntry("Other.txt", "Other.txt")];

    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path) => {
      if (path === "Destination") {
        return { items: destinationFiles, path, total: destinationFiles.length };
      }

      return { items: rootFiles, path: "", total: rootFiles.length };
    });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    const focusDestinationAndOpen = async () => {
      const listContainer = await screen.findByTestId("file-list-container");
      listContainer.focus();
      await user.keyboard("d");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /folder: destination/i })).toHaveAttribute("data-selected", "true");
      });
      await user.keyboard("{Enter}");
      return screen.findByRole("button", { name: /file: zebra\.txt/i });
    };

    await focusDestinationAndOpen();

    await user.click(screen.getByRole("button", { name: /navigate to root directory/i }));
    await screen.findByRole("button", { name: /folder: destination/i });

    await focusDestinationAndOpen();
    const cachedDestinationList = screen.getByTestId("file-list-container");
    expect(cachedDestinationList).toHaveFocus();

    await user.keyboard("z");

    await waitFor(() => {
      expect(screen.getByRole("button", { name: /file: zebra\.txt/i })).toHaveAttribute("data-selected", "true");
    });

    const destinationLoads = vi.mocked(api.listDirectory).mock.calls.filter(([_connectionId, path]) => path === "Destination");
    expect(destinationLoads).toHaveLength(1);
  });

  it("does not repaint the previous directory contents while loading a child directory", async () => {
    const user = userEvent.setup();
    const subfolderFiles: FileInfo[] = [
      {
        name: "file1.txt",
        path: "Documents/file1.txt",
        type: FileType.FILE,
        size: 512,
        modified_at: "2024-01-12T10:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    let resolveSubfolder: (value: { items: FileInfo[]; path: string; total: number }) => void = uninitializedTestCallback;

    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path) => {
      if (path === "Documents") {
        return new Promise((resolve) => {
          resolveSubfolder = resolve as (value: { items: FileInfo[]; path: string; total: number }) => void;
        });
      }

      return mockDirectoryListing;
    });

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    expect(await screen.findByText("readme.txt")).toBeInTheDocument();

    const documentsFolders = screen.getAllByRole("button", { name: /documents/i });
    await user.click(requireTestValue(documentsFolders[0]));

    await waitFor(() => {
      expectDirectoryLoad("conn-1", "Documents");
    });

    expect(screen.queryByText("readme.txt")).not.toBeInTheDocument();
    expect(screen.getByRole("progressbar")).toBeInTheDocument();

    resolveSubfolder?.({
      items: subfolderFiles,
      path: "Documents",
      total: subfolderFiles.length,
    });

    const fileEntries = await screen.findAllByText("file1.txt");
    expect(fileEntries.length).toBeGreaterThan(0);
  });

  it("navigates using breadcrumb links", async () => {
    // Start in a nested path
    const nestedFiles: FileInfo[] = [
      {
        name: "nested.txt",
        path: "Documents/Subfolder/nested.txt",
        type: FileType.FILE,
        size: 256,
        modified_at: "2024-01-11T10:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path) => {
      if (path === "Documents/Subfolder") {
        return {
          items: nestedFiles,
          path: "Documents/Subfolder",
          total: nestedFiles.length,
        };
      }
      return mockDirectoryListing; // root path
    });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1/Documents/Subfolder");

    // Optimized: Use findByText
    expect(await screen.findByText("Subfolder")).toBeInTheDocument();

    // Click on connection name breadcrumb (replaces "Root") - use getAllByText and filter to find the link, not the combobox
    const rootLinks = screen.getAllByText("Test Server 1");
    // The breadcrumb link should be in a button with component="button" (from MUI Link)
    const rootLink = rootLinks.find((el) => el.tagName === "BUTTON" && el.getAttribute("role") !== "combobox");
    expect(rootLink).toBeDefined();
    await user.click(rootLink!);

    // Should navigate back to root
    await waitFor(() => {
      expectDirectoryLoad("conn-1", "");
      expect(screen.getByTestId("file-list-container")).toHaveFocus();
    });
  });

  it("loads connection from URL parameter", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-2");

    // Wait for connections to load and URL to be processed
    await waitFor(() => {
      expect(api.getConnections).toHaveBeenCalled();
    });

    await waitFor(() => {
      expectDirectoryLoad("conn-2", "");
    });
  });

  it("loads nested path from URL", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1/Documents/Subfolder");

    // Wait for connections to load
    await waitFor(() => {
      expect(api.getConnections).toHaveBeenCalled();
    });

    await waitFor(() => {
      expectDirectoryLoad("conn-1", "Documents/Subfolder");
    });
  });

  it("uses the persisted user setting for the default connection when no URL param", async () => {
    vi.mocked(api.getCurrentUserSettings).mockResolvedValue(
      createMockCurrentUserSettings({
        appearance: { theme_id: "sambee-light", custom_themes: [] },
        localization: {
          language: "browser",
          regional_locale: "browser",
        },
        browser: {
          quick_bar_shortcut_hint_visibility: "auto",
          touch_friendly_file_selection: "auto",
          quick_nav_include_dot_directories: false,
          file_browser_view_mode: "list",
          pane_mode: "single",
          selected_connection_id: "conn-1",
          viewer_associations: {},
        },
      })
    );

    await renderBrowserAndFlush("/browse");

    await waitFor(() => {
      expectDirectoryLoad("conn-1", "");
    });
  });

  it("falls back to first connection when no saved preference", async () => {
    localStorage.removeItem("selectedConnectionId");

    await renderBrowserAndFlush("/browse");

    await waitFor(() => {
      expectDirectoryLoad("conn-1", "");
    });
  });

  it("switches connections using dropdown", async () => {
    const conn2Files: FileInfo[] = [
      {
        name: "Server2File.txt",
        path: "Server2File.txt",
        type: FileType.FILE,
        size: 2048,
        modified_at: "2024-01-10T10:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    vi.mocked(api.listDirectory).mockResolvedValueOnce(mockDirectoryListing);

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    // Wait for Documents to load (may appear multiple times in UI)
    await waitFor(() => {
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    // Change connection
    vi.mocked(api.listDirectory).mockResolvedValueOnce({
      items: conn2Files,
      path: "",
      total: conn2Files.length,
    });

    const select = screen.getByRole("combobox");
    await user.click(select);

    const option = await screen.findByText(/Test Server 2/);
    await user.click(option);

    // Should load files from new connection
    await waitFor(() => {
      expectDirectoryLoad("conn-2", "");
    });
  });

  it("ignores stale directory responses after switching connections", async () => {
    const user = userEvent.setup();

    let resolveConn1: (value: typeof mockDirectoryListing) => void = uninitializedTestCallback;
    let resolveConn2: (value: { items: FileInfo[]; path: string; total: number }) => void = uninitializedTestCallback;

    const conn2Files: FileInfo[] = [
      {
        name: "conn2-only.txt",
        path: "conn2-only.txt",
        type: FileType.FILE,
        size: 2048,
        modified_at: "2024-01-10T10:00:00Z",
        is_readable: true,
        is_hidden: false,
      },
    ];

    vi.mocked(api.listDirectory).mockImplementation((connectionId) => {
      if (connectionId === "conn-1") {
        return new Promise((resolve) => {
          resolveConn1 = resolve as (value: typeof mockDirectoryListing) => void;
        });
      }

      if (connectionId === "conn-2") {
        return new Promise((resolve) => {
          resolveConn2 = resolve as (value: { items: FileInfo[]; path: string; total: number }) => void;
        });
      }

      return Promise.resolve(mockDirectoryListing);
    });

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    const select = await screen.findByRole("combobox");
    await user.click(select);

    const option = await screen.findByText(/Test Server 2/);
    await user.click(option);

    resolveConn2?.({
      items: conn2Files,
      path: "",
      total: conn2Files.length,
    });

    const conn2OnlyElements = await screen.findAllByText("conn2-only.txt");
    expect(conn2OnlyElements.length).toBeGreaterThan(0);

    resolveConn1?.(mockDirectoryListing);

    await waitFor(() => {
      expect(screen.getAllByText("conn2-only.txt").length).toBeGreaterThan(0);
    });

    expect(screen.queryByText("readme.txt")).not.toBeInTheDocument();
  });
});
