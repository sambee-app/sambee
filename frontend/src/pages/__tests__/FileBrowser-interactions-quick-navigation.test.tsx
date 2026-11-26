// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { RECENT_DIRECTORIES_CHANGED_EVENT } from "../../services/recentDirectoriesSync";
import { RECENT_FILES_CHANGED_EVENT } from "../../services/recentFilesSync";
import { createMockCurrentUserSettings } from "../../test/helpers/mockFactories";
import { QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY } from "../FileBrowser/preferences";
import { mockDirectoryListing, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { expectDirectoryLoad, setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Keyboard Navigation", () => {
    it("opens navigate mode with Ctrl+K even when a toolbar button is focused", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const settingsButton = screen.getByRole("button", { name: /open settings/i });
      await act(async () => settingsButton.focus());
      expect(settingsButton).toHaveFocus();

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Quick navigation");
      expect(quickBarInput).toHaveFocus();
    });

    it("opens the connection selector with Ctrl+ArrowDown", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const quickBarInput = screen.getByPlaceholderText("Quick navigation");
      await act(async () => {
        quickBarInput.focus();
      });
      expect(quickBarInput).toHaveFocus();

      await user.keyboard("{Control>}{ArrowDown}{/Control}");

      expect(await screen.findByRole("listbox")).toBeInTheDocument();
      expect(screen.getByText("Test Server 1 (192.168.1.100/share1)")).toBeInTheDocument();
    });

    it("does not open the connection selector or mode menu when Ctrl+ArrowDown is pressed on the mode button", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });
      await act(async () => modeButton.focus());
      expect(modeButton).toHaveFocus();

      await user.keyboard("{Control>}{ArrowDown}{/Control}");

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(screen.queryByRole("menuitem", { name: "File Search" })).not.toBeInTheDocument();
    });

    it("does not show an empty no-results dropdown when navigate mode opens", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Quick navigation");
      expect(quickBarInput).toHaveFocus();
      expect(screen.queryByText(/No results found for/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("shows the directory index minimum-character hint when a single-character query matches neither history nor the open folder", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Quick navigation");
      await user.type(quickBarInput, "z");

      expect(await screen.findByText("Type at least 2 characters to search")).toBeInTheDocument();
      expect(screen.queryByText(/No results found for/i)).not.toBeInTheDocument();
      expect(api.searchRecentDirectories).toHaveBeenCalledWith("z", 50, expect.any(AbortSignal), { connectionId: "conn-1" });
    });

    it("applies quick-navigation scope and item type before requesting results", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      await user.keyboard("{Control>}k{/Control}");
      const input = await screen.findByPlaceholderText("Quick navigation");
      await user.type(input, "report");
      await user.click(screen.getByRole("button", { name: "Search scope" }));
      await user.click(screen.getByRole("menuitem", { name: "Current folder and subfolders" }));
      await waitFor(() => {
        expect(api.searchRecentDirectories).toHaveBeenCalledWith("report", 50, expect.any(AbortSignal), {
          connectionId: "conn-1",
          scope: { path: "", mode: "subtree" },
        });
      });
      await user.click(screen.getByRole("button", { name: "Item type" }));
      await user.click(screen.getByRole("menuitem", { name: "Files" }));
      await waitFor(() => {
        expect(api.searchRecentFiles).toHaveBeenCalledWith("report", 50, expect.any(AbortSignal), {
          connectionId: "conn-1",
          scope: { path: "", mode: "subtree" },
        });
      });
      expect(input).toHaveValue("report");
    });

    it("keeps the quick-bar mode icon in sync with keyboard shortcuts and typing", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");
      await screen.findByPlaceholderText("Quick navigation");
      const modeButton = screen.getByRole("button", { name: "Switch quick bar mode" });
      expect(within(modeButton).getByTestId("FolderOutlinedIcon")).toBeInTheDocument();

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      expect(within(modeButton).getByTestId("KeyboardCommandKeyIcon")).toBeInTheDocument();

      await user.type(commandInput, "f");
      expect(within(modeButton).getByTestId("KeyboardCommandKeyIcon")).toBeInTheDocument();

      await user.click(screen.getByTestId("virtual-list"));
      await user.keyboard("/");

      const fileSearchInput = await screen.findByPlaceholderText("Search files and folders");
      expect(within(modeButton).getByTestId("SearchIcon")).toBeInTheDocument();

      await user.type(fileSearchInput, "r");
      expect(within(modeButton).getByTestId("SearchIcon")).toBeInTheDocument();
    });

    it.each([
      ["a same-tab history change", () => window.dispatchEvent(new Event(RECENT_FILES_CHANGED_EVENT))],
      ["window focus", () => window.dispatchEvent(new Event("focus"))],
      ["returning to a visible tab", () => document.dispatchEvent(new Event("visibilitychange"))],
    ])("does not fetch recent files for live search after %s", async (_description, triggerRefresh) => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByTestId("virtual-list"));
      await user.keyboard("/");
      await screen.findByPlaceholderText("Search files and folders");

      const callsBeforeRefresh = vi.mocked(api.searchRecentFiles).mock.calls.length;
      await act(async () => {
        triggerRefresh();
      });

      expect(api.searchRecentFiles).toHaveBeenCalledTimes(callsBeforeRefresh);
    });

    it.each([
      ["a same-tab history change", () => window.dispatchEvent(new Event(RECENT_FILES_CHANGED_EVENT))],
      ["window focus", () => window.dispatchEvent(new Event("focus"))],
      ["returning to a visible tab", () => document.dispatchEvent(new Event("visibilitychange"))],
    ])("does not submit live search after %s", async (_description, triggerRefresh) => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("/");
      const fileSearchInput = await screen.findByPlaceholderText("Search files and folders");
      expect(fileSearchInput).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();

      await act(async () => {
        triggerRefresh();
      });

      expect(api.startFilesystemSearch).not.toHaveBeenCalled();
      expect(fileSearchInput).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it.each([
      ["a same-tab directory-history change", () => window.dispatchEvent(new Event(RECENT_DIRECTORIES_CHANGED_EVENT))],
      ["window focus", () => window.dispatchEvent(new Event("focus"))],
      ["returning to a visible tab", () => document.dispatchEvent(new Event("visibilitychange"))],
    ])("refreshes active Directory Navigation after %s", async (_description, triggerRefresh) => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");
      await screen.findByPlaceholderText("Quick navigation");
      await waitFor(() => {
        expect(api.searchRecentDirectories).toHaveBeenCalledWith("", 50, expect.any(AbortSignal), { connectionId: "conn-1" });
      });

      const callsBeforeRefresh = vi.mocked(api.searchRecentDirectories).mock.calls.length;
      await act(async () => {
        triggerRefresh();
      });

      await waitFor(() => {
        expect(api.searchRecentDirectories).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      });
    });

    it.each(["Enter", "click"])("keeps Quick Navigation closed after opening a folder with %s", async (activation) => {
      const user = userEvent.setup();
      const history = vi.mocked(api.searchRecentDirectories);
      history.mockResolvedValue({
        result_limit: 10,
        results: [
          {
            id: "recent-documents",
            connection_id: "conn-1",
            path: "Documents",
            last_visited_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      const { router } = await renderBrowserAndFlush("/browse/smb/test-server-1");

      await user.keyboard("{Control>}k{/Control}");
      const input = screen.getByPlaceholderText("Quick navigation");
      await user.type(input, "Documents");
      const option = await screen.findByRole("option", { name: /^Documents\b/ });
      const emptyQueryCount = () => history.mock.calls.filter(([query]) => query === "").length;
      const beforeSelection = emptyQueryCount();

      if (activation === "Enter") await user.keyboard("{Enter}");
      else await user.click(option);

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Documents");
        expectDirectoryLoad("conn-1", "Documents");
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
      });
      await act(async () => window.dispatchEvent(new Event(RECENT_DIRECTORIES_CHANGED_EVENT)));
      expect(input).toHaveValue("");
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(emptyQueryCount()).toBe(beforeSelection);

      await user.keyboard("{Control>}k{/Control}");
      expect(await screen.findByRole("listbox")).toBeVisible();
    });

    it("does not reopen dismissed Directory Navigation after a history refresh", async () => {
      const user = userEvent.setup();
      vi.mocked(api.searchRecentDirectories).mockResolvedValue({
        result_limit: 10,
        results: [
          {
            id: "recent-documents",
            connection_id: "test-server-1",
            path: "Documents",
            last_visited_at: "2026-01-01T00:00:00Z",
          },
        ],
      });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await user.keyboard("{Control>}k{/Control}");
      const input = await screen.findByPlaceholderText("Quick navigation");
      await user.type(input, "Documents");
      expect(await screen.findByRole("option", { name: /^Documents\b/ })).toBeVisible();

      await user.keyboard("{Escape}");
      expect(input).toHaveValue("");
      expect(screen.getByTestId("file-list-container")).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      const callsBeforeRefresh = vi.mocked(api.searchRecentDirectories).mock.calls.length;

      await act(async () => {
        window.dispatchEvent(new Event(RECENT_DIRECTORIES_CHANGED_EVENT));
      });

      expect(api.searchRecentDirectories).toHaveBeenCalledTimes(callsBeforeRefresh);
      expect(screen.getByTestId("file-list-container")).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("does not reopen dismissed File Search after returning to the browser tab", async () => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("/");
      await screen.findByPlaceholderText("Search files and folders");

      await user.keyboard("{Escape}{Escape}");
      await waitFor(() => {
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      });

      const callsBeforeTabReturn = vi.mocked(api.searchRecentFiles).mock.calls.length;
      await act(async () => {
        fireEvent(window, new Event("focus"));
        fireEvent(document, new Event("visibilitychange"));
      });

      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      expect(api.searchRecentFiles).toHaveBeenCalledTimes(callsBeforeTabReturn);
    });

    it("keeps Home and End bound to the navigate input text", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Quick navigation");
      await user.type(quickBarInput, "abc");
      await user.keyboard("{Home}");
      await user.keyboard("x");
      await user.keyboard("{End}");
      await user.keyboard("z");

      expect(quickBarInput).toHaveValue("xabcz");
    });

    it("keeps quick navigation bound to the pane that opened it in dual-pane mode", async () => {
      const user = userEvent.setup();

      vi.mocked(api.searchDirectories).mockImplementation(async (connectionId, query) => {
        if (query === "Ri") {
          if (connectionId === "conn-2") {
            return {
              results: ["RightTarget"],
              total_matches: 1,
              cache_state: "ready",
              directory_count: 1,
            };
          }

          return {
            results: ["LeftTarget"],
            total_matches: 1,
            cache_state: "ready",
            directory_count: 1,
          };
        }

        return {
          results: [],
          total_matches: 0,
          cache_state: "ready",
          directory_count: 1,
        };
      });

      vi.mocked(api.listDirectory).mockImplementation(async (connectionId, path = "") => {
        if (connectionId === "conn-2" && path === "RightTarget") {
          return {
            items: [],
            path: "RightTarget",
            total: 0,
          };
        }

        return mockDirectoryListing;
      });

      const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "");
      });

      const rightPane = container.querySelector('[data-pane-id="right"]');
      const leftPane = container.querySelector('[data-pane-id="left"]');

      expect(rightPane).not.toBeNull();
      expect(leftPane).not.toBeNull();

      await user.click(rightPane as HTMLElement);
      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = screen.getByPlaceholderText("Quick navigation");
      await user.type(quickBarInput, "Ri");

      await waitFor(() => {
        expect(api.searchDirectories).toHaveBeenCalledWith(
          "conn-2",
          "Ri",
          expect.objectContaining({
            includeDotDirectories: false,
            signal: expect.any(AbortSignal),
          })
        );
      });

      await user.click(leftPane as HTMLElement);
      await user.click(screen.getByPlaceholderText("Quick navigation"));
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expectDirectoryLoad("conn-2", "RightTarget");
      });
    });

    it("uses the persisted quick-nav dot-directory preference", async () => {
      const user = userEvent.setup();

      localStorage.setItem(QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY, "true");
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
            quick_nav_include_dot_directories: true,
            file_browser_view_mode: "list",
            pane_mode: "single",
            selected_connection_id: null,
            viewer_associations: {},
          },
        })
      );

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Quick navigation");
      await user.type(quickBarInput, "do");

      await waitFor(() => {
        expect(api.searchDirectories).toHaveBeenCalledWith(
          "conn-1",
          "do",
          expect.objectContaining({
            includeDotDirectories: true,
            signal: expect.any(AbortSignal),
          })
        );
      });
    });

    it("keeps focus in the quick bar when a command switches quick-bar modes", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      expect(commandInput).toHaveFocus();

      await user.type(commandInput, "file search");
      const fileSearchCommand = await screen.findByText("File Search");
      await user.click(fileSearchCommand);

      await waitFor(() => {
        const fileSearchInput = screen.getByPlaceholderText("Search files and folders");
        expect(fileSearchInput).toHaveFocus();
      });
    });

    it.each([
      { shortcut: "{Control>}k{/Control}", source: "Navigate", destination: "Commands", placeholder: "Run a command" },
      {
        shortcut: "{Control>}p{/Control}",
        source: "Commands",
        destination: "Live search",
        placeholder: "Search files and folders",
      },
      { shortcut: "/", source: "Live search", destination: "Navigate", placeholder: "Quick navigation" },
    ])(
      "switches quick-bar modes from $source to $destination with the mode menu",
      async ({ shortcut, source, destination, placeholder }) => {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "Folder: Documents" });

        await user.keyboard(shortcut);

        const modeButton = await screen.findByRole("button", { name: "Switch quick bar mode" });
        expect(modeButton).toHaveAccessibleDescription(source);

        await user.click(modeButton);
        await user.click(await screen.findByRole("menuitem", { name: destination }));

        await waitFor(() => {
          expect(screen.getByPlaceholderText(placeholder)).toHaveFocus();
          expect(modeButton).toHaveAccessibleDescription(destination);
        });
        expect(screen.getByRole("button", { name: "File: readme.txt" })).toBeInTheDocument();
      }
    );
  });
});
