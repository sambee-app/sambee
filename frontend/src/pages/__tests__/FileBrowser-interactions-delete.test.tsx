// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { mockConnections, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Delete", () => {
    it("returns focus to the file list when a toolbar confirmation is dismissed with Escape", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByRole("button", { name: "Delete" }));
      expect(await screen.findByRole("dialog")).toBeInTheDocument();

      await user.keyboard("{Escape}");

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
      });
    });

    it("returns focus to the file list when Escape is pressed on a focused file row", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const documentsRow = screen.getByTestId("file-list-container").querySelector<HTMLButtonElement>('button[aria-label*="Documents"]');
      expect(documentsRow).not.toBeNull();
      await act(async () => documentsRow?.focus());
      expect(documentsRow).toHaveFocus();

      await user.keyboard("{Escape}");

      expect(screen.getByTestId("file-list-container")).toHaveFocus();
    });

    it("returns focus to the file list when Escape is pressed after clicking unused toolbar space", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const deleteButton = screen.getByRole("button", { name: "Delete" });
      await act(async () => deleteButton.focus());
      fireEvent.click(screen.getByTestId("file-operations-toolbar"));
      expect(deleteButton).toHaveFocus();

      await user.keyboard("{Escape}");

      expect(screen.getByTestId("file-list-container")).toHaveFocus();
    });

    it("returns focus to the file list when Escape is pressed with document focus", async () => {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      fireEvent.keyDown(document, { key: "Escape" });

      expect(screen.getByTestId("file-list-container")).toHaveFocus();
    });

    it("opens delete dialog when Delete Focused Item is selected from commands mode", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      await user.type(commandInput, "delete");
      await user.click(await screen.findByText("Delete Focused Item"));

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("opens confirm dialog when Delete key pressed on focused file", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Wait for files to load
      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");

      // Focus on the list and ensure first item is focused
      await user.click(listContainer);

      // Press Delete key
      await user.keyboard("{Delete}");

      // Confirm dialog should clearly state the deletion outcome.
      await waitFor(() => {
        expect(screen.getByText(/will be permanently deleted/i)).toBeInTheDocument();
      });
    });

    it("calls deleteItem API when confirmed", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Wait for files to load
      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      // Navigate down to select a file (third item = readme.txt)
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowDown}");

      // Press Delete
      await user.keyboard("{Delete}");

      // Confirm dialog should appear
      const deleteButton = await screen.findByRole("button", { name: "Delete" });
      await user.click(deleteButton);

      // deleteItem should have been called
      await waitFor(() => {
        expect(api.deleteItem).toHaveBeenCalled();
      });
    });

    it("deletes every selected item when confirmed", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("{Insert}");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: /Documents.*selected/i })).toBeInTheDocument();
      });
      expect(screen.getByRole("button", { name: /Documents.*selected/i })).toHaveAttribute("data-selected", "true");
      await user.keyboard("{ArrowDown}");
      await waitFor(() => {
        expect(screen.getByRole("button", { name: "Folder: Pictures" })).toHaveAttribute("data-selected", "true");
      });
      await user.keyboard("{Insert}");
      await user.keyboard("{Delete}");

      expect(await screen.findByText("The following 2 items will be permanently deleted:")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Delete" }));

      await waitFor(() => {
        expect(api.deleteItem).toHaveBeenCalledTimes(2);
      });
    });

    it("deletes every item selected through the compact selection menu", async () => {
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
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "Selection actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Delete" }));

        expect(await screen.findByText("The following 2 items will be permanently deleted:")).toBeInTheDocument();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it("keeps the desktop layout while automatic touch selection is enabled for a coarse primary pointer", async () => {
      const originalMatchMedia = window.matchMedia;
      window.matchMedia = vi.fn().mockImplementation((query: string) => ({
        matches: query === "(pointer: coarse)",
        media: query,
        onchange: null,
        addListener: vi.fn(),
        removeListener: vi.fn(),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }));

      try {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        expect(await screen.findByRole("button", { name: "Refresh" })).toBeInTheDocument();
        expect(screen.queryByRole("button", { name: "Open menu" })).not.toBeInTheDocument();

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));

        expect(screen.getByRole("button", { name: /Folder: Documents.*selected/i })).toHaveAttribute("aria-pressed", "true");
        expect(screen.getByRole("button", { name: "Selection actions" })).toBeInTheDocument();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });

    it("closes dialog when Cancel is clicked", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Wait for files to load
      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      // Press Delete to open dialog
      await user.keyboard("{Delete}");

      // Wait for dialog
      const cancelButton = await screen.findByRole("button", { name: "Cancel" });
      await user.click(cancelButton);

      // Dialog should close
      await waitFor(() => {
        expect(screen.queryByText(/will be permanently deleted/i)).not.toBeInTheDocument();
      });
    });

    it("does not open confirm dialog for read-only connections", async () => {
      const user = userEvent.setup();

      vi.mocked(api.getConnections).mockResolvedValue([{ ...mockConnections[0], access_mode: "read_only" }]);

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("{Delete}");

      await waitFor(() => {
        expect(screen.queryByText(/will be permanently deleted/i)).not.toBeInTheDocument();
      });
      expect(api.deleteItem).not.toHaveBeenCalled();
    });
  });
});
