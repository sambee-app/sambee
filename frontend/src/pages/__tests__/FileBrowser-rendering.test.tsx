import { createMockAuthToken } from "../../test/fixtures/users";
/**
 * Browser Component - Rendering Tests
 * Tests for basic rendering, loading states, errors, and empty states
 */

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileBrowserAlerts } from "../../components/FileBrowser/FileBrowserAlerts";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { markBackendAvailable, markBackendReconnecting, resetBackendAvailabilityForTests } from "../../services/backendAvailability";
import { emitBackendRecoveryConfirmed } from "../../services/backendRecoveryEvents";
import { saveBrowserRecoverySnapshot } from "../../services/browserRecoverySnapshot";
import { logger } from "../../services/logger";
import {
  type ApiMock,
  createForbiddenError,
  createMarkdownViewerMock,
  createSettingsDialogMock,
  createTimeoutError,
  setupSuccessfulApiMocks,
} from "../../test/helpers";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import { mockConnections, mockDirectoryListing, renderBrowser, renderBrowserAndFlush } from "./FileBrowser.test.utils";

const expectDirectoryLoad = (connectionId: string, path: string) => {
  expect(api.listDirectory).toHaveBeenCalledWith(
    connectionId,
    path,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    })
  );
};

// Mock the API module
vi.mock("../../services/api");

// Mock components using lazy mock factories
vi.mock("../../components/Viewer/MarkdownViewer", () => createMarkdownViewerMock());
vi.mock("../../components/Settings/SettingsDialog", () => createSettingsDialogMock());
// @tanstack/react-virtual mock - explicitly import the mock
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

describe("Browser Component - Rendering", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetBackendAvailabilityForTests();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    localStorage.removeItem("selectedConnectionId");
    sessionStorage.clear();

    // Use mock factory for successful API responses
    setupSuccessfulApiMocks(api as unknown as ApiMock);
  });

  it("restores the previous pane snapshot without showing connection bootstrap loading", async () => {
    saveBrowserRecoverySnapshot({
      savedAt: Date.now(),
      routeUrl: "/browse/smb/test-server-1",
      activePaneId: "left",
      paneMode: "single",
      connections: mockConnections,
      left: {
        connectionId: "conn-1",
        path: "",
        items: mockDirectoryListing.items,
        sortBy: "name",
        sortDirection: "asc",
        viewMode: "details",
        focusedIndex: 0,
        focusedFileName: "Documents",
        selectedFileNames: [],
        viewInfo: null,
        scrollOffset: 0,
      },
      right: null,
    });

    renderBrowser("/browse/smb/test-server-1");

    expect((await screen.findAllByText("Documents")).length).toBeGreaterThan(0);
    expect(screen.queryByText(/Loading connections/i)).not.toBeInTheDocument();
  });

  it.each([new Error("offline"), createForbiddenError()])(
    "keeps a recovered listing visible when background connections fail: %s",
    async (failure) => {
      saveBrowserRecoverySnapshot({
        savedAt: Date.now(),
        routeUrl: "/browse/smb/test-server-1",
        activePaneId: "left",
        paneMode: "single",
        connections: mockConnections,
        left: {
          connectionId: "conn-1",
          path: "",
          items: mockDirectoryListing.items,
          sortBy: "name",
          sortDirection: "asc",
          viewMode: "details",
          focusedIndex: 0,
          focusedFileName: "Documents",
          selectedFileNames: [],
          viewInfo: null,
          scrollOffset: 0,
        },
        right: null,
      });
      vi.mocked(api.getConnections).mockRejectedValueOnce(failure);
      const logSpy = vi.spyOn(logger, "error");

      await renderBrowserAndFlush("/browse/smb/test-server-1");
      await waitFor(() => expect(logSpy).toHaveBeenCalledWith("Error loading connections", { error: failure }, "browser"));
      expect((await screen.findAllByText("Documents")).length).toBeGreaterThan(0);
      expect(screen.queryByText(/Failed to load connections|Access denied/i)).not.toBeInTheDocument();
      logSpy.mockRestore();
    }
  );

  it("ignores stale recovery navigation and legacy viewer state for an explicit URL", async () => {
    saveBrowserRecoverySnapshot({
      savedAt: Date.now(),
      routeUrl: "/browse/smb/test-server-1",
      activePaneId: "left",
      paneMode: "single",
      connections: mockConnections,
      left: {
        connectionId: "conn-1",
        path: "",
        items: mockDirectoryListing.items,
        sortBy: "name",
        sortDirection: "asc",
        viewMode: "details",
        focusedIndex: 0,
        focusedFileName: "Documents",
        selectedFileNames: [],
        viewInfo: {
          path: "readme.md",
          mimeType: "text/markdown",
          viewerId: "markdown",
          sessionId: "recovered-viewer",
        },
        scrollOffset: 0,
      },
      right: null,
    });

    await renderBrowserAndFlush("/browse/smb/test-server-1/Documents");

    await waitFor(() => {
      expectDirectoryLoad("conn-1", "Documents");
    });
    expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Documents");
    expect(screen.queryByTestId("markdown-viewer")).not.toBeInTheDocument();
  });

  it("displays connection selector with available connections", async () => {
    await renderBrowserAndFlush();

    // Optimized: Use findByRole instead of waitFor + getByRole
    const combobox = await screen.findByRole("combobox");
    expect(combobox).toBeInTheDocument();
  });

  it("shows breadcrumb navigation", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    // Now shows connection name in breadcrumb instead of "Root"
    // Use getAllByText and filter to avoid collision with connection selector combobox
    const serverNameElements = await screen.findAllByText("Test Server 1");
    const breadcrumbElement = serverNameElements.find((el) => el.tagName === "P" && el.className.includes("MuiTypography"));
    expect(breadcrumbElement).toBeInTheDocument();
  });

  it("renders file and folder list", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    // Wait for connections to load first
    await waitFor(() => {
      expect(api.getConnections).toHaveBeenCalled();
    });

    // Wait for directory listing to be called
    await waitFor(() => {
      expectDirectoryLoad("conn-1", "");
    });

    // Wait for directories and files to render
    // Use getAllByText since "Documents" may appear multiple times (e.g., in status bar)
    await waitFor(() => {
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });
    expect(screen.getByText("Pictures")).toBeInTheDocument();
    expect(screen.getByText("readme.txt")).toBeInTheDocument();
  });

  it("renders one toolbar without cross-pane commands in single-pane mode", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await screen.findAllByText("Documents");

    expect(screen.getAllByTestId("file-operations-toolbar")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "New folder" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Move" })).not.toBeInTheDocument();
    expect(screen.getAllByTestId("status-bar-focused-file-name")).toHaveLength(1);
  });

  it("renders one toolbar with transfer commands and an aligned status bar for each dual pane", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");

    await waitFor(() => {
      expectDirectoryLoad("conn-1", "");
      expectDirectoryLoad("conn-2", "");
    });

    expect(screen.getAllByTestId("file-operations-toolbar")).toHaveLength(1);
    expect(screen.getByRole("button", { name: "Copy" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
    expect(screen.getAllByTestId("status-bar-focused-file-name")).toHaveLength(2);
  });

  it("keeps permitted creation and refresh commands available in an empty directory", async () => {
    vi.mocked(api.listDirectory).mockResolvedValue({ items: [], path: "", total: 0 });

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    expect(await screen.findByText(/This directory is empty/i)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "New folder" })).toBeEnabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
    expect(screen.queryByTestId("status-bar-focused-file-name")).not.toBeInTheDocument();
  });

  it("keeps the toolbar visible while mutation commands are disabled on a read-only connection", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([{ ...mockConnections[0], access_mode: "read_only" }]);

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await screen.findAllByText("Documents");
    expect(screen.getByRole("button", { name: "New folder" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rename" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  });

  it("hides the toolbar and status bars in compact layout", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      expect(screen.queryByTestId("file-operations-toolbar")).not.toBeInTheDocument();
      expect(screen.queryByTestId("status-bar-focused-file-name")).not.toBeInTheDocument();
      await screen.findByRole("button", { name: "Create new item" });
      fireEvent.click(screen.getByRole("button", { name: "Create new item" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "New folder" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("enters and exits compact selection mode through explicit controls", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));

    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findByRole("button", { name: "More actions for readme.txt" });
      fireEvent.click(screen.getByRole("button", { name: "More actions for readme.txt" }));
      fireEvent.click(screen.getByRole("menuitem", { name: "Select" }));
      expect(screen.getAllByText("1 item selected").length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: /folder: documents/i }));
      expect(screen.getAllByText("2 items selected").length).toBeGreaterThan(0);

      fireEvent.click(screen.getByRole("button", { name: "Clear selection" }));
      expect(await screen.findByRole("button", { name: "Create new item" })).toBeInTheDocument();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("enables parent navigation at an archive root in compact layout", async () => {
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = vi.fn().mockImplementation((query: string) => ({
      matches: /max-width/.test(query),
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    }));
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "archive.zip", size: 1 },
      path: "",
      items: [{ name: "inside.txt", path: "inside.txt", type: "file", state: "readable", is_hidden: false }],
      total: 1,
      page_size: 100,
    } as never);

    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1/archive.zip");

      await screen.findByRole("button", { name: /file: inside\.txt/i });
      expect(screen.getByText("archive.zip")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Navigate to parent directory" })).toBeEnabled();
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it("displays loading state while fetching files", async () => {
    // Mock a delayed response
    vi.mocked(api.listDirectory).mockImplementation(() => new Promise<typeof mockDirectoryListing>(() => {}));

    renderBrowser("/browse/smb/test-server-1");

    // Loading should appear briefly
    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalled();
    });
  });

  it("shows reconnecting banner while backend realtime connection is recovering", () => {
    render(
      <SambeeThemeProvider>
        <FileBrowserAlerts
          error={null}
          companionLifecycleStatus={null}
          loadingConnections={false}
          connectionsCount={1}
          backendAvailabilityStatus="reconnecting"
        />
      </SambeeThemeProvider>
    );

    expect(screen.getByText(/reconnecting to backend/i)).toBeInTheDocument();
  });

  it("gives a standard user the linked connection onboarding when no connections are available", () => {
    const openConnectionsSettings = vi.fn();

    render(
      <SambeeThemeProvider>
        <FileBrowserAlerts
          error={null}
          companionLifecycleStatus={null}
          loadingConnections={false}
          connectionsCount={0}
          backendAvailabilityStatus="available"
          onOpenConnectionsSettings={openConnectionsSettings}
        />
      </SambeeThemeProvider>
    );

    const connectionLink = screen.getByRole("button", { name: "adding your first SMB network share" });
    fireEvent.click(connectionLink);

    expect(openConnectionsSettings).toHaveBeenCalledOnce();
    expect(screen.queryByText(/Please contact an administrator/i)).not.toBeInTheDocument();
  });

  it("shows error state when API fails", async () => {
    vi.mocked(api.listDirectory).mockRejectedValue({
      response: { data: { detail: "Connection failed" } },
    });

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await waitFor(() => expect(screen.getByText("Failed to load directory contents. Please try again.")).toBeInTheDocument());
    expect(screen.queryByText(/This directory is empty/i)).not.toBeInTheDocument();
  });

  it("shows a typed companion lifecycle alert from the route query", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?companion_status=renewal_required");

    await waitFor(() =>
      expect(screen.getByText(/The companion edit session expired before the file could be finished/i)).toBeInTheDocument()
    );
  });

  it("shows the auth-failed companion lifecycle alert from the route query", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?companion_status=auth_failed");

    await waitFor(() => expect(screen.getByText(/The companion could not finish signing in to the Sambee backend/i)).toBeInTheDocument());
  });

  it("shows the recovery-required companion lifecycle alert from the route query", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?companion_status=recovery_required");

    await waitFor(() => expect(screen.getByText(/The companion has an unfinished recovery item for this file/i)).toBeInTheDocument());
  });

  it("ignores unknown companion lifecycle statuses in the route query", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?companion_status=not_real");

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalled();
    });

    expect(screen.queryByText(/The companion /i)).not.toBeInTheDocument();
  });

  it("dismisses the typed companion lifecycle alert while retaining recovery access", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?companion_status=lock_lost");

    await waitFor(() => expect(screen.getByText(/The companion lost the active edit lock for this file/i)).toBeInTheDocument());

    screen.getByRole("button", { name: "Close" }).click();

    await waitFor(() => {
      expect(screen.queryByText(/The companion lost the active edit lock for this file/i)).not.toBeInTheDocument();
    });
    expect(screen.getByRole("button", { name: "Companion recovery" })).toBeInTheDocument();
  });

  it("refreshes the visible pane automatically when backend availability recovers", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(1);
    });

    act(() => {
      markBackendReconnecting("socket closed");
    });

    act(() => {
      markBackendAvailable();
    });

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(2);
    });
    expectDirectoryLoad("conn-1", "");
  });

  it("keeps the previous file list visible if the recovery refresh times out", async () => {
    vi.mocked(api.listDirectory).mockResolvedValueOnce(mockDirectoryListing).mockRejectedValueOnce(createTimeoutError());

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    expect((await screen.findAllByText("Documents")).length).toBeGreaterThan(0);

    act(() => {
      markBackendReconnecting("socket closed");
    });

    act(() => {
      markBackendAvailable();
    });

    expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
    expect(screen.queryByText(/This directory is empty/i)).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByText(/Directory listing timed out. The remote share took too long to respond/i)).toBeInTheDocument()
    );
    expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
  });

  it("refreshes both visible panes automatically when dual-pane backend availability recovers", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2&active=2");

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(2);
    });
    expectDirectoryLoad("conn-1", "");
    expectDirectoryLoad("conn-2", "");

    act(() => {
      markBackendReconnecting("socket closed");
    });

    act(() => {
      markBackendAvailable();
    });

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(4);
    });
    expectDirectoryLoad("conn-1", "");
    expectDirectoryLoad("conn-2", "");
  });

  it("refreshes the visible pane when a proactive recovery probe succeeds without a status transition", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(1);
    });

    act(() => {
      emitBackendRecoveryConfirmed("health-probe-success");
    });

    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalledTimes(2);
    });
    expectDirectoryLoad("conn-1", "");
  });

  it("shows retryable timeout state when directory loading times out", async () => {
    vi.mocked(api.listDirectory).mockRejectedValueOnce(createTimeoutError()).mockResolvedValueOnce(mockDirectoryListing);

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    await waitFor(() =>
      expect(screen.getByText(/Directory listing timed out. The remote share took too long to respond/i)).toBeInTheDocument()
    );

    const retryButton = screen.getByRole("button", { name: "Retry" });
    retryButton.click();

    expect((await screen.findAllByText("Documents")).length).toBeGreaterThan(0);
    expect(api.listDirectory).toHaveBeenCalledTimes(2);
  });

  it("shows message when no connections are configured", async () => {
    vi.mocked(api.getConnections).mockResolvedValue([]);

    await renderBrowserAndFlush();

    // Optimized: Use findByText instead of waitFor + getByText
    expect(await screen.findByText(/adding your first SMB network share/i)).toBeInTheDocument();
  });

  it("displays empty directory message when folder is empty", async () => {
    vi.mocked(api.listDirectory).mockResolvedValue({
      items: [],
      path: "",
      total: 0,
    });

    await renderBrowserAndFlush("/browse/smb/test-server-1");

    // Optimized: Use findByText instead of waitFor + getByText
    expect(await screen.findByText(/This directory is empty/i)).toBeInTheDocument();
  });
});
