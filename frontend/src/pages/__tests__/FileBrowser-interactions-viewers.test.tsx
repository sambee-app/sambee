// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { createMockCurrentUserSettings } from "../../test/helpers/mockFactories";
import { FileType } from "../../types";
import { renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Refresh", () => {
    it("opens the detected default viewer on Enter when there is only one compatible Sambee viewer", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "notes.MD",
            path: "notes.MD",
            type: FileType.FILE,
            size: 2048,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "text/plain",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });
      vi.mocked(api.getCurrentUserSettings).mockResolvedValue(
        createMockCurrentUserSettings({
          appearance: { theme_id: "sambee-light", custom_themes: [] },
          localization: {
            language: "browser",
            regional_locale: "browser",
          },
          browser: {
            touch_friendly_file_selection: "auto",
            quick_bar_shortcut_hint_visibility: "auto",
            quick_nav_include_dot_directories: false,
            file_browser_view_mode: "list",
            pane_mode: "single",
            selected_connection_id: null,
            viewer_associations: {},
          },
        })
      );

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(
        () => {
          expect(screen.getByRole("button", { name: /notes\.md/i })).toBeInTheDocument();
        },
        { timeout: 5000 }
      );

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByText("Markdown Viewer")).toBeInTheDocument();
      });
      expect(screen.queryByRole("dialog", { name: "Choose Viewer" })).not.toBeInTheDocument();
    });

    it("suppresses File Search results while a browser viewer is open", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "notes.MD",
            path: "notes.MD",
            type: FileType.FILE,
            size: 2048,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "text/plain",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("/");
      await screen.findByPlaceholderText("Search files and folders");

      await user.keyboard("{Escape}{Escape}");
      await user.keyboard("{Enter}");

      await screen.findByText("Markdown Viewer");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("returns focus to the file list without reopening File Search after closing a PDF viewer", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "report.pdf",
            path: "report.pdf",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/pdf",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });
      vi.mocked(api.getCurrentUserSettings).mockResolvedValue(
        createMockCurrentUserSettings({
          appearance: { theme_id: "sambee-light", custom_themes: [] },
          localization: {
            language: "browser",
            regional_locale: "browser",
          },
          browser: {
            touch_friendly_file_selection: "auto",
            quick_bar_shortcut_hint_visibility: "auto",
            quick_nav_include_dot_directories: false,
            file_browser_view_mode: "list",
            pane_mode: "single",
            selected_connection_id: null,
            viewer_associations: { "mime:application/pdf": "pdf" },
          },
        })
      );

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("/");
      await screen.findByPlaceholderText("Search files and folders");

      await user.keyboard("{Escape}{Escape}");
      await user.keyboard("{Enter}");
      await screen.findByRole("dialog");

      await user.keyboard("{Escape}");

      await waitFor(() => {
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
      });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("returns focus to the file list without reopening File Search after cancelling the viewer picker", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "report.pdf",
            path: "report.pdf",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/pdf",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const virtualList = await screen.findByTestId("virtual-list");
      await user.click(virtualList);
      await user.keyboard("/");
      await screen.findByPlaceholderText("Search files and folders");

      await user.keyboard("{Escape}{Escape}");
      await user.keyboard("{Shift>}{Enter}{/Shift}");
      await screen.findByRole("dialog", { name: "Choose Viewer" });
      await user.keyboard("{Escape}");

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Choose Viewer" })).not.toBeInTheDocument();
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      });
    });

    it("opens the saved preferred Sambee viewer on Enter even when it is outside the default compatible subset", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "report.pdf",
            path: "report.pdf",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/pdf",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });
      vi.mocked(api.getCurrentUserSettings).mockResolvedValue(
        createMockCurrentUserSettings({
          appearance: { theme_id: "sambee-light", custom_themes: [] },
          localization: {
            language: "browser",
            regional_locale: "browser",
          },
          browser: {
            touch_friendly_file_selection: "auto",
            quick_bar_shortcut_hint_visibility: "auto",
            quick_nav_include_dot_directories: false,
            file_browser_view_mode: "list",
            pane_mode: "single",
            selected_connection_id: null,
            viewer_associations: {
              "mime:application/pdf": "markdown",
              "ext:.pdf": "markdown",
            },
          },
        })
      );

      await renderBrowserAndFlush("/browse/smb/test-server-1");
      expect(screen.getByRole("button", { name: "File: report.pdf" })).toBeInTheDocument();

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expect(screen.getByText("Markdown Viewer")).toBeInTheDocument();
      });
      expect(screen.queryByRole("dialog", { name: "Choose Viewer" })).not.toBeInTheDocument();
    });

    it("shows all Sambee viewers in the forced browser picker", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "report.pdf",
            path: "report.pdf",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/pdf",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");
      expect(screen.getByRole("button", { name: "File: report.pdf" })).toBeInTheDocument();

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("{Shift>}{Enter}{/Shift}");

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Choose Viewer" })).toBeInTheDocument();
      });
      expect(screen.getByText("PDF Viewer")).toBeInTheDocument();
      expect(screen.getByText("Markdown Viewer")).toBeInTheDocument();
      expect(screen.getByText("Image Viewer")).toBeInTheDocument();
    });

    it("shows the viewer picker on mouse click when no associated viewer exists", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "archive.bin",
            path: "archive.bin",
            type: FileType.FILE,
            size: 2048,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/octet-stream",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const fileButton = screen.getByRole("button", { name: "File: archive.bin" });
      await user.click(fileButton);

      await waitFor(() => {
        expect(screen.getByRole("dialog", { name: "Choose Viewer" })).toBeInTheDocument();
      });
      expect(screen.getByText("Open in native app")).toBeInTheDocument();
    });
  });
});
