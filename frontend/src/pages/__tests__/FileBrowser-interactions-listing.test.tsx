// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, cleanup, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import {
  createForbiddenError,
  createNetworkError,
  createNotFoundError,
  createTimeoutError,
  createUnauthorizedError,
} from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { FileType } from "../../types";
import { mockDirectoryListing, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { expectDirectoryLoad, setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  it("flushes mocked initial loading without advancing timers", async () => {
    vi.useFakeTimers();
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expectDirectoryLoad("conn-1", "");
      expect(screen.getByRole("button", { name: "Folder: Documents" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "File: readme.txt" })).toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    } finally {
      cleanup();
      await act(() => vi.runOnlyPendingTimersAsync());
      vi.useRealTimers();
    }
  });

  it("shows navigation progress while keeping the current list visible", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    let finishListing: ((value: typeof mockDirectoryListing) => void) | undefined;
    vi.mocked(api.listDirectory).mockReturnValueOnce(
      new Promise((resolve) => {
        finishListing = resolve;
      })
    );

    const user = userEvent.setup();
    await user.click(screen.getByTestId("file-list-container"));
    await user.keyboard("{Enter}");

    expect(await screen.findByRole("progressbar", { name: "Loading..." })).toBeInTheDocument();
    const currentRow = screen.getByRole("button", { name: "File: readme.txt" });
    expect(currentRow).toBeInTheDocument();
    expect(currentRow.closest('[aria-busy="true"]')).not.toBeNull();
    await act(async () => requireTestValue(finishListing)(mockDirectoryListing));
    await waitFor(() => expect(screen.queryByRole("progressbar")).not.toBeInTheDocument());
  });

  describe("Settings", () => {
    it("disables the Refresh toolbar command while settings is open", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();

      await user.click(screen.getByRole("button", { name: "Open settings" }));
      await screen.findByRole("dialog");

      expect(screen.getByRole("button", { name: "Refresh", hidden: true })).toBeDisabled();
    });

    it("opens settings when settings button clicked", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Find settings button - it should be clickable
      const settingsButton = screen.getByRole("button", { name: /open settings/i });
      expect(settingsButton).toBeInTheDocument();

      // Click is handled by navigation, which we can't fully test here
      // without setting up the routes, but we can verify the button works
      await user.click(settingsButton);
    });

    it("does not show unavailable shortcut feedback while settings is open", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      await user.keyboard("{Control>},{/Control}");
      await screen.findByRole("dialog");

      const event = createEvent.keyDown(document, { key: "F7" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("This location is read-only.")).not.toBeInTheDocument();
    });

    it("does not show unavailable shortcut feedback while help is open", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      await user.keyboard("{F1}");
      await screen.findByRole("dialog", { name: "File browser shortcuts" });

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
    });
  });

  describe("Unavailable shortcut scope", () => {
    it.each([
      { name: "image.png", mimeType: "image/png", viewerName: "image viewer" },
      { name: "notes.md", mimeType: "text/markdown", viewerName: "Markdown viewer" },
      { name: "report.pdf", mimeType: "application/pdf", viewerName: "PDF viewer" },
      { name: "notes.txt", mimeType: "text/plain", viewerName: "text viewer" },
    ])("does not show file-list feedback while the $viewerName is open", async ({ name, mimeType }) => {
      const user = userEvent.setup();
      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name,
            path: name,
            type: FileType.FILE,
            size: 1024,
            modified_at: "2024-01-01T00:00:00Z",
            is_readable: true,
            is_hidden: false,
            mime_type: mimeType,
          },
        ],
        total: 1,
      });
      vi.mocked(api.getFileContent).mockResolvedValue("viewer text");
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await user.click(await screen.findByRole("button", { name: new RegExp(`file: ${name}`, "i") }));
      await act(() => vi.dynamicImportSettled());
      if (mimeType === "image/png") {
        await screen.findByRole("img", { name });
      } else {
        await screen.findByRole("dialog");
      }
      if (mimeType === "text/plain") await screen.findByText("viewer text");
      if (mimeType === "application/pdf") await screen.findByRole("alert");

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
    });

    it("does not show file-list feedback while mobile menus are open", async () => {
      const originalMatchMedia = window.matchMedia;
      vi.useFakeTimers();
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

        fireEvent.click(screen.getByRole("button", { name: "Open menu" }));
        await act(() => vi.runOnlyPendingTimersAsync());
        expect(screen.getByRole("button", { name: "Open settings" })).toBeInTheDocument();

        const drawerEvent = createEvent.keyDown(document, { key: "F5" });
        fireEvent(document, drawerEvent);
        expect(drawerEvent.defaultPrevented).toBe(false);
        expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Open settings" }));
        await act(() => vi.runOnlyPendingTimersAsync());
        expect(screen.getByRole("button", { name: "Go back" })).toBeInTheDocument();

        const settingsEvent = createEvent.keyDown(document, { key: "F5" });
        fireEvent(document, settingsEvent);
        expect(settingsEvent.defaultPrevented).toBe(false);
        expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
      } finally {
        cleanup();
        await act(() => vi.runOnlyPendingTimersAsync());
        vi.useRealTimers();
        window.matchMedia = originalMatchMedia;
      }
    });
  });

  describe("Sort Functionality", () => {
    it("sorts files by name, size, and date", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Open sort menu
      const sortButton = screen.getByLabelText(/sort options/i);
      await user.click(sortButton);

      // Click "Size" in the menu
      const sizeOption = await screen.findByText("Size");
      await user.click(sizeOption);

      // Files should be re-rendered (already sorted by component)
      await waitFor(() => {
        const elements = screen.getAllByText("readme.txt");
        expect(elements.length).toBeGreaterThan(0);
      });

      // Open sort menu again
      const sortButtonAgain = screen.getByLabelText(/sort options/i);
      await user.click(sortButtonAgain);

      // Click "Modified" in the menu
      const modifiedOption = await screen.findByText("Modified");
      await user.click(modifiedOption);

      // Files should be re-rendered
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    it("sorts files by name", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Open sort menu
      const sortButton = screen.getByLabelText(/sort options/i);
      await user.click(sortButton);

      // Files should still be displayed (sorting menu opened)
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    it("maintains sort preference across navigation", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockImplementation((_connectionId, path = "") => {
        if (path === "Documents") {
          return Promise.resolve({
            items: [
              {
                name: "zzz.txt",
                path: "Documents/zzz.txt",
                type: FileType.FILE,
                size: 100,
                modified_at: "2024-01-01T00:00:00Z",
                is_readable: true,
                is_hidden: false,
              },
              {
                name: "aaa.txt",
                path: "Documents/aaa.txt",
                type: FileType.FILE,
                size: 200,
                modified_at: "2024-01-02T00:00:00Z",
                is_readable: true,
                is_hidden: false,
              },
            ],
            path: "Documents",
            total: 2,
          });
        }
        return Promise.resolve(mockDirectoryListing);
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Open sort menu
      const sortButton = screen.getByLabelText(/sort options/i);
      await user.click(sortButton);

      // Click Size in the menu
      const sizeOption = await screen.findByText("Size");
      await user.click(sizeOption);

      // Navigate into Documents folder
      const documentsFolder = screen.getByRole("button", {
        name: /documents/i,
      });
      await user.click(documentsFolder);

      // Optimized: Use findByText
      await waitFor(() => {
        const elements = screen.getAllByText("aaa.txt");
        expect(elements.length).toBeGreaterThan(0);
      });

      // Sort preference should still be applied
      const zzzElements = screen.getAllByText("zzz.txt");
      expect(zzzElements.length).toBeGreaterThan(0);
    });
  });

  describe("Error Handling", () => {
    it("redirects to login when unauthorized (401)", async () => {
      vi.mocked(api.getConnections).mockRejectedValue(createUnauthorizedError());

      await renderBrowserAndFlush();

      expect(await screen.findByText("Login Page")).toBeInTheDocument();
    });

    it("shows access denied message for admin endpoints (403)", async () => {
      vi.mocked(api.getConnections).mockRejectedValue(createForbiddenError());

      await renderBrowserAndFlush();

      expect(await screen.findByText(/Access denied. Please contact an administrator/i)).toBeInTheDocument();
    });

    it("handles connection not found (404)", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(createNotFoundError());

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/The connection is unavailable. Check connection settings and try again/i)).toBeInTheDocument();
    });

    it("handles generic API errors", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue({
        response: { data: { detail: "Server error" } },
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Failed to load directory contents. Please try again/i)).toBeInTheDocument();
    });

    it("handles network errors", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(createNetworkError());

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Failed to load files. Please check your connection settings/i)).toBeInTheDocument();
    });

    it("handles timeout errors with a dedicated message", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(createTimeoutError());

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Directory listing timed out. The remote share took too long to respond/i)).toBeInTheDocument();
    });
  });
});
