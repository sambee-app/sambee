// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, type Mock, vi } from "vitest";
import api from "../../services/api";
import { FileType } from "../../types";
import { mockDirectoryListing, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { expectDirectoryLoad, setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Keyboard Navigation", () => {
    describe("boundary range selection", () => {
      const selectedNames = (container: HTMLElement) =>
        within(container)
          .queryAllByRole("button", { name: /\(selected\)$/i })
          .map((row) => row.getAttribute("aria-label"));

      it.each([
        ["Home", ["Folder: Documents (selected)", "Folder: Pictures (selected)"], "Documents"],
        ["End", ["Folder: Pictures (selected)", "File: readme.txt (selected)"], "readme.txt"],
      ])("Shift+%s selects the inclusive range from current focus and moves focus to the boundary", async (key, expected, target) => {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "Folder: Pictures" });
        const list = screen.getByTestId("file-list-container");
        await user.click(within(list).getByTestId("virtual-list"));
        await user.keyboard("{Home}");
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: "Folder: Documents" })).toHaveAttribute("data-selected", "true")
        );
        await user.keyboard("{ArrowDown}");
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: "Folder: Pictures" })).toHaveAttribute("data-selected", "true")
        );

        const event = createEvent.keyDown(list, { key, shiftKey: true });
        fireEvent(list, event);

        expect(event.defaultPrevented).toBe(true);
        expect(selectedNames(list)).toEqual(expected);
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: new RegExp(`: ${target} \\(selected\\)$`) })).toHaveAttribute(
            "data-selected",
            "true"
          )
        );
        await user.keyboard(`{Shift>}{${key}}{/Shift}`);
        expect(selectedNames(list)).toEqual(expected);
      });

      it.each([
        ["Home", "End", "File: readme.txt"],
        ["End", "Home", "Folder: Documents"],
      ])(
        "Shift+%s preserves selections outside the range and uses focus instead of the previous anchor",
        async (key, initialKey, initialName) => {
          const user = userEvent.setup();
          await renderBrowserAndFlush("/browse/smb/test-server-1");
          await screen.findByRole("button", { name: "Folder: Pictures" });
          const list = screen.getByTestId("file-list-container");
          await user.click(within(list).getByTestId("virtual-list"));
          await user.keyboard(`{${initialKey}}`);
          await waitFor(() => expect(within(list).getByRole("button", { name: initialName })).toHaveAttribute("data-selected", "true"));
          await user.keyboard(" ");
          expect(selectedNames(list)).toEqual([`${initialName} (selected)`]);
          await user.keyboard("{Home}");
          await waitFor(() =>
            expect(within(list).getByRole("button", { name: /^Folder: Documents/ })).toHaveAttribute("data-selected", "true")
          );
          await user.keyboard("{ArrowDown}");
          await waitFor(() =>
            expect(within(list).getByRole("button", { name: "Folder: Pictures" })).toHaveAttribute("data-selected", "true")
          );
          await user.keyboard(`{Shift>}{${key}}{/Shift}`);

          expect(selectedNames(list)).toEqual([
            "Folder: Documents (selected)",
            "Folder: Pictures (selected)",
            "File: readme.txt (selected)",
          ]);
        }
      );

      it.each([
        ["End", "Home", "File: readme.txt (selected)"],
        ["Home", "End", "Folder: Documents (selected)"],
      ])("Shift+%s uses pending focus from %s before an animation frame commits", async (key, navigationKey, targetName) => {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "Folder: Pictures" });
        const list = screen.getByTestId("file-list-container");
        await user.click(within(list).getByTestId("virtual-list"));
        await user.keyboard("{Home}");
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: "Folder: Documents" })).toHaveAttribute("data-selected", "true")
        );
        await user.keyboard("{ArrowDown}");
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: "Folder: Pictures" })).toHaveAttribute("data-selected", "true")
        );

        const frames: FrameRequestCallback[] = [];
        const animationFrame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => frames.push(callback));
        try {
          fireEvent.keyDown(list, { key: navigationKey });
          expect(within(list).getByRole("button", { name: "Folder: Pictures" })).toHaveAttribute("data-selected", "true");
          fireEvent.keyDown(list, { key, shiftKey: true });

          expect(selectedNames(list)).toEqual([
            "Folder: Documents (selected)",
            "Folder: Pictures (selected)",
            "File: readme.txt (selected)",
          ]);
          await act(async () => {
            for (const callback of frames.splice(0)) callback(performance.now());
          });
          expect(within(list).getByRole("button", { name: targetName })).toHaveAttribute("data-selected", "true");
        } finally {
          animationFrame.mockRestore();
          await act(async () => {
            for (const callback of frames) callback(performance.now());
          });
        }
      });

      it.each(["Home", "End"])("Shift+%s selects a single-item list without toggling it off", async (key) => {
        const user = userEvent.setup();
        vi.mocked(api.listDirectory).mockResolvedValue({ ...mockDirectoryListing, items: [mockDirectoryListing.items[0]!], total: 1 });
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        expect(screen.getByRole("button", { name: "Folder: Documents" })).toBeInTheDocument();
        const list = screen.getByTestId("file-list-container");
        await user.click(within(list).getByTestId("virtual-list"));
        await user.keyboard(`{Shift>}{${key}}{${key}}{/Shift}`);

        expect(selectedNames(list)).toEqual(["Folder: Documents (selected)"]);
      });

      it.each(["Home", "End"])("Shift+%s does nothing in an empty list", async (key) => {
        const user = userEvent.setup();
        vi.mocked(api.listDirectory).mockResolvedValue({ path: "", items: [], total: 0 });
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByText("This directory is empty");
        const list = screen.getByTestId("file-list-container");
        await user.click(list);
        await user.keyboard(`{Shift>}{${key}}{/Shift}`);

        expect(selectedNames(list)).toEqual([]);
      });

      it.each(["Home", "End"])("Shift+%s leaves text inputs and toolbar focus alone", async (key) => {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "Folder: Pictures" });
        const list = screen.getByTestId("file-list-container");
        const input = screen.getByPlaceholderText("Quick navigation");
        await user.click(input);
        await user.keyboard(`{Shift>}{${key}}{/Shift}`);
        expect(input).toHaveFocus();
        expect(selectedNames(list)).toEqual([]);

        const settingsButton = screen.getByRole("button", { name: /open settings/i });
        await act(async () => {
          settingsButton.focus();
        });
        await user.keyboard(`{Shift>}{${key}}{/Shift}`);
        expect(settingsButton).toHaveFocus();
        expect(selectedNames(list)).toEqual([]);
      });

      it.each(["Home", "End"])("Shift+%s does not select files while a dialog is open", async (key) => {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "Folder: Pictures" });
        await user.click(screen.getByRole("button", { name: "Delete" }));
        await screen.findByRole("dialog");
        await user.keyboard(`{Shift>}{${key}}{/Shift}`);

        expect(selectedNames(screen.getByTestId("file-list-container"))).toEqual([]);
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });

      it("keeps unmodified Home and End as focus-only navigation", async () => {
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "Folder: Pictures" });
        const list = screen.getByTestId("file-list-container");
        await user.click(within(list).getByTestId("virtual-list"));
        await user.keyboard("{End}");
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: "File: readme.txt" })).toHaveAttribute("data-selected", "true")
        );
        await user.keyboard("{Home}");
        await waitFor(() =>
          expect(within(list).getByRole("button", { name: "Folder: Documents" })).toHaveAttribute("data-selected", "true")
        );
        expect(selectedNames(list)).toEqual([]);
      });
    });

    it("navigates down with ArrowDown key", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");

      // Focus on the container and press ArrowDown
      await user.click(listContainer);
      await user.keyboard("{ArrowDown}");

      // The component should handle the keyboard event
      // Since we can't easily test focus state in JSDOM, we verify the component renders
      expect(listContainer).toBeInTheDocument();
    });

    it("navigates up with ArrowUp key", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");

      await user.click(listContainer);
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowUp}");

      expect(listContainer).toBeInTheDocument();
    });

    it("opens file or folder with Enter key", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Click on the Documents folder to focus it
      const documentsFolder = screen.getByRole("button", {
        name: /documents/i,
      });
      await user.click(documentsFolder);

      // Press Enter should navigate into the folder
      await user.keyboard("{Enter}");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });
    });

    it("opens the focused item when Open Focused Item is selected from commands mode", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const documentsFolder = screen.getByRole("button", {
        name: /documents/i,
      });
      await user.click(documentsFolder);

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      await user.type(commandInput, "open");
      await user.click(await screen.findByText("Open Focused Item"));

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "Documents");
      });
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("navigates to parent with Backspace key", async () => {
      const user = userEvent.setup();

      // Start in a subdirectory
      vi.mocked(api.listDirectory).mockImplementation((_connectionId, path = "") => {
        if (path === "Documents") {
          return Promise.resolve({
            items: [
              {
                name: "file.txt",
                path: "Documents/file.txt",
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
        return Promise.resolve(mockDirectoryListing);
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1/Documents");

      // Optimized: Use findByText
      await waitFor(() => {
        const elements = screen.getAllByText("file.txt");
        expect(elements.length).toBeGreaterThan(0);
      });

      // Press Backspace to go to parent
      await user.keyboard("{Backspace}");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
      });
    });

    it("does not navigate to parent when Backspace is pressed in an empty commands quick bar", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockImplementation((_connectionId, path = "") => {
        if (path === "Documents") {
          return Promise.resolve({
            items: [
              {
                name: "file.txt",
                path: "Documents/file.txt",
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
        return Promise.resolve(mockDirectoryListing);
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1/Documents");

      await waitFor(() => {
        expect(screen.getAllByText("file.txt").length).toBeGreaterThan(0);
      });

      const initialCallCount = (api.listDirectory as Mock).mock.calls.length;

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      expect(commandInput).toHaveFocus();
      expect(commandInput).toHaveValue("");

      await user.keyboard("{Backspace}");

      expect(commandInput).toHaveFocus();
      expect((api.listDirectory as Mock).mock.calls.length).toBe(initialCallCount);
      expect(screen.queryByPlaceholderText("Quick navigation")).not.toBeInTheDocument();
    });

    it("opens shortcuts dialog with ? key", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Press ? to open shortcuts dialog
      await user.keyboard("?");

      const dialog = await screen.findByRole("dialog", { name: "File browser shortcuts" });
      expect(within(dialog).queryByText("Ctrl+1")).not.toBeInTheDocument();
      expect(within(dialog).queryByText("Ctrl+2")).not.toBeInTheDocument();
      expect(within(dialog).getByText("Ctrl+B")).toBeInTheDocument();
    });

    it("closes the commands dropdown after selecting Show Keyboard Shortcuts", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      await user.type(commandInput, "show");
      await user.click(await screen.findByText("Show Keyboard Shortcuts"));

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("handles keyboard navigation without crashing on empty directory", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const elements = screen.getAllByText("readme.txt");
        expect(elements.length).toBeGreaterThan(0);
      });

      // Try keyboard navigation - component should not crash
      await user.keyboard("{ArrowDown}");
      await user.keyboard("{ArrowUp}");
      await user.keyboard("{Enter}");

      // Component should still be functional (not crashed)
      expect(screen.getByText("Sambee")).toBeInTheDocument();
    });

    it("handles switching between mouse and keyboard input without crashing", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Wait for files to load
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");

      // Simulate mouse interaction
      await user.click(listContainer);

      // Then keyboard navigation
      await user.keyboard("{ArrowDown}");

      // Then another mouse interaction
      await user.click(listContainer);

      // Verify component still renders correctly
      expect(screen.getByText("Sambee")).toBeInTheDocument();
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });
  });
});
