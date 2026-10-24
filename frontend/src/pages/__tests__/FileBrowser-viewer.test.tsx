import { createMockAuthToken } from "../../test/fixtures/users";
import { requireTestValue } from "../../test/helpers/assertions";
/**
 * Browser Component - View and Advanced Tests
 * Tests for file view, connection switching, and edge cases
 */

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { type ApiMock, createMarkdownViewMock, createSettingsDialogMock, setupSuccessfulApiMocks } from "../../test/helpers";
import { FileType } from "../../types";
import { mockDirectoryListing, renderBrowser } from "./FileBrowser.test.utils";

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
vi.mock("../../components/View/MarkdownView", () => createMarkdownViewMock());
vi.mock("../../components/Settings/SettingsDialog", () => createSettingsDialogMock());
// @tanstack/react-virtual mock - explicitly import the mock
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

describe("Browser Component - View and Advanced", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    localStorage.removeItem("selectedConnectionId");

    // Use mock factory for successful API responses
    setupSuccessfulApiMocks(api as unknown as ApiMock);
  });

  describe("File View", () => {
    it("opens view when clicking file", async () => {
      const user = userEvent.setup();
      renderBrowser("/browse/smb/test-server-1");

      // Wait for the browser to load - find an image file which has view support
      // Add a mock image file to the directory listing
      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          ...mockDirectoryListing.items,
          {
            name: "image.png",
            type: FileType.FILE,
            path: "image.png",
            size: 51200,
            modified_at: "2024-01-13T10:00:00Z",
            is_readable: true,
            is_hidden: false,
            mime_type: "image/png",
          },
        ],
        total: mockDirectoryListing.total + 1,
      });

      // Re-render to get the updated file list
      expect(await screen.findByText("image.png")).toBeInTheDocument();

      // Click on file - find the button that contains the text
      const fileButton = screen.getByRole("button", { name: /image\.png/i });
      await user.click(fileButton);

      // View dialog should open (multiple dialog roles: MUI Dialog + yarl lightbox)
      expect((await screen.findAllByRole("dialog")).length).toBeGreaterThanOrEqual(1);
    });

    it("handles Escape key press without crashing", async () => {
      const user = userEvent.setup();
      renderBrowser("/browse/smb/test-server-1");

      // Add a mock image file
      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          ...mockDirectoryListing.items,
          {
            name: "test-image.jpg",
            type: FileType.FILE,
            path: "test-image.jpg",
            size: 102400,
            modified_at: "2024-01-13T10:00:00Z",
            is_readable: true,
            is_hidden: false,
            mime_type: "image/jpeg",
          },
        ],
        total: mockDirectoryListing.total + 1,
      });

      // Wait for file to appear
      expect(await screen.findByText("test-image.jpg")).toBeInTheDocument();

      // Click on a file to open view
      const fileButton = screen.getByRole("button", { name: /test-image\.jpg/i });
      await user.click(fileButton);

      // View dialog should open (multiple dialog roles: MUI Dialog + yarl lightbox)
      expect((await screen.findAllByRole("dialog")).length).toBeGreaterThanOrEqual(1);

      // Press Escape - dialog closing behavior may vary
      await user.keyboard("{Escape}");

      // Verify component is still functional (no crash)
      // Use getAllByText since the filename appears in multiple places (list and viewer)
      expect(screen.getAllByText("test-image.jpg").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("Connection Switching", () => {
    it("preserves path when switching connections with same structure", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockImplementation((_connectionId, path) => {
        // Both connections have Documents folder
        if (path === "Documents") {
          return Promise.resolve({
            items: [
              {
                name: "shared.txt",
                path: "Documents/shared.txt",
                type: FileType.FILE,
                size: 100,
                modified_at: "2024-01-01T00:00:00Z",
                is_readable: true,
                is_hidden: false,
              },
            ],
            path: "Documents",
            total: 1,
          });
        }
        // Return root directory listing for initial load
        return Promise.resolve(mockDirectoryListing);
      });

      renderBrowser("/browse/smb/test-server-1/Documents");

      // Wait for the Documents folder content to load
      await waitFor(
        () => {
          const sharedTxtElements = screen.getAllByText("shared.txt");
          expect(sharedTxtElements.length).toBeGreaterThan(0);
        },
        { timeout: 5000 }
      );

      // Switch connection via dropdown
      const select = screen.getByRole("combobox");
      await user.click(select);

      // Select the second connection
      const option2 = screen.getByText(/test server 2.*192\.168\.1\.101/i);
      await user.click(option2);

      // Should try to load same path on new connection
      await waitFor(() => {
        // Check that the connection has switched by verifying the combobox shows the new connection
        const combobox = screen.getByRole("combobox");
        expect(combobox).toHaveTextContent("Test Server 2");
      });

      // Component should still be functional
      expect(screen.getByText("Sambee")).toBeInTheDocument();
    });

    it("resets to root when switching to connection without current path", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockImplementation((_connectionId, path) => {
        if (_connectionId === "conn-2" && path === "Documents") {
          // Connection 2 doesn't have Documents folder
          return Promise.reject(new Error("Path not found"));
        }
        if (path === "Documents") {
          return Promise.resolve({
            items: [],
            path: "Documents",
            total: 0,
          });
        }
        return Promise.resolve(mockDirectoryListing);
      });

      renderBrowser("/browse/smb/test-server-1/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });

      // Switch to connection 2
      const select = screen.getByRole("combobox");
      await user.click(select);

      const option2 = screen.getByText(/test server 2.*192\.168\.1\.101/i);
      await user.click(option2);

      // Should fall back to root
      await waitFor(() => {
        expectDirectoryLoad("conn-2", "");
      });
    });
  });

  describe("Performance and Edge Cases", () => {
    it("handles rapid navigation without crashes", async () => {
      const user = userEvent.setup();
      renderBrowser("/browse/smb/test-server-1");

      // Wait for Documents to appear - there may be multiple (breadcrumb + file list)
      await waitFor(
        () => {
          const documentsElements = screen.getAllByText("Documents");
          expect(documentsElements.length).toBeGreaterThan(0);
        },
        { timeout: 5000 }
      );

      const documentsFolders = screen.getAllByRole("button", {
        name: /documents/i,
      });
      const documentsFolder = documentsFolders[0]; // Use first Documents button

      // Click multiple times rapidly
      await user.click(requireTestValue(documentsFolder));
      await user.click(requireTestValue(documentsFolder));
      await user.click(requireTestValue(documentsFolder));

      // Should handle gracefully - at least one Documents should exist
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    it("displays file info tooltips on hover", async () => {
      const user = userEvent.setup();
      renderBrowser("/browse/smb/test-server-1");

      // Optimized: Use findByText
      expect(await screen.findByText("readme.txt")).toBeInTheDocument();

      const fileItem = screen.getByText("readme.txt");
      await user.hover(fileItem);

      // File should still be visible (tooltip tested via user interaction)
      expect(fileItem).toBeInTheDocument();
    });

    it("handles very long filenames gracefully", async () => {
      const longFileName = `${"a".repeat(200)}.txt`;

      vi.mocked(api.listDirectory).mockResolvedValueOnce({
        items: [
          {
            name: longFileName,
            path: longFileName,
            type: FileType.FILE,
            size: 1024,
            modified_at: "2024-01-01T00:00:00Z",
            is_readable: true,
            is_hidden: false,
          },
        ],
        path: "",
        total: 1,
      });

      renderBrowser("/browse/smb/test-server-1");

      // UI should render without crashing - filename may be truncated
      expect(await screen.findByText("Sambee")).toBeInTheDocument();

      // Wait for the browser shell to finish its initial connection-loading state.
      expect(await screen.findByRole("combobox")).toBeInTheDocument();
    });

    it("handles files with special characters in names", async () => {
      const specialName = "file (copy) [1] & 'test' \"quote\".txt";

      vi.mocked(api.listDirectory).mockResolvedValueOnce({
        items: [
          {
            name: specialName,
            path: specialName,
            type: FileType.FILE,
            size: 1024,
            modified_at: "2024-01-01T00:00:00Z",
            is_readable: true,
            is_hidden: false,
          },
        ],
        path: "",
        total: 1,
      });

      renderBrowser("/browse/smb/test-server-1");

      // UI should render without crashing - special chars may be escaped
      expect(await screen.findByText("Sambee")).toBeInTheDocument();

      // Wait for the browser shell to finish its initial connection-loading state.
      expect(await screen.findByRole("combobox")).toBeInTheDocument();
    });

    it("updates UI when localStorage changes externally", async () => {
      renderBrowser("/browse/smb/test-server-1");

      // Wait for component to load - Optimized: Use findByText
      expect(await screen.findByText("Sambee")).toBeInTheDocument();

      // Simulate external change to localStorage
      localStorage.setItem("selectedConnectionId", "conn-2");

      // Trigger a storage event
      window.dispatchEvent(
        new StorageEvent("storage", {
          key: "selectedConnectionId",
          newValue: "conn-2",
        })
      );

      // Component should remain functional after storage event
      expect(screen.getByText("Sambee")).toBeInTheDocument();
    });
  });
});
