// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, createEvent, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, type Mock, vi } from "vitest";
import api from "../../services/api";
import { requireTestValue } from "../../test/helpers/assertions";
import { renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { expectDirectoryLoad, setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Refresh", () => {
    it.each([
      ["single", "left", "/browse/smb/test-server-1"],
      ["dual", "left", "/browse/smb/test-server-1?p2=smb/test-server-2/Documents"],
      ["dual", "right", "/browse/smb/test-server-1?p2=smb/test-server-2/Documents"],
    ] as const)("leaves browser tab shortcuts unchanged in %s mode with %s focus", async (mode, paneId, route) => {
      const { container } = await renderBrowserAndFlush(route);
      const list = requireTestValue(container.querySelector<HTMLElement>(`[data-pane-id="${paneId}"] [data-testid="file-list-container"]`));
      await act(async () => list.focus());
      const activePane = localStorage.getItem("active-pane");
      const settingsCalls = vi.mocked(api.updateCurrentUserSettings).mock.calls.length;

      for (const modifier of ["ctrlKey", "metaKey"] as const) {
        for (const key of ["1", "2"]) {
          const event = createEvent.keyDown(list, { key, [modifier]: true, bubbles: true, cancelable: true });
          fireEvent(list, event);

          expect(event.defaultPrevented).toBe(false);
          expect(list).toHaveFocus();
          expect(localStorage.getItem("active-pane")).toBe(activePane);
          expect(screen.getAllByTestId("file-list-container")).toHaveLength(mode === "dual" ? 2 : 1);
        }
      }
      expect(api.updateCurrentUserSettings).toHaveBeenCalledTimes(settingsCalls);
    });

    it("refreshes file list when Ctrl+R pressed", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const initialCallCount = (api.listDirectory as Mock).mock.calls.length;

      // Press Ctrl+R to refresh
      await user.keyboard("{Control>}r{/Control}");

      // Should call listDirectory again
      await waitFor(() => {
        expect((api.listDirectory as Mock).mock.calls.length).toBeGreaterThan(initialCallCount);
      });
    });

    it("returns to single-pane mode after pressing Ctrl+B twice", async () => {
      const user = userEvent.setup();
      const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenCalledWith(
          { field: "browser.pane_mode", value: "dual" },
          { signal: expect.any(AbortSignal) }
        );
        expect(localStorage.getItem("active-pane")).toBe("right");
        const rightPaneList = container.querySelector('[data-pane-id="right"] [data-testid="file-list-container"]');
        expect(rightPaneList).toBeInstanceOf(HTMLElement);
        expect(rightPaneList).toHaveFocus();
      });

      await user.keyboard("{Tab}");

      await waitFor(() => {
        expect(localStorage.getItem("active-pane")).toBe("left");
        const leftPaneList = container.querySelector('[data-pane-id="left"] [data-testid="file-list-container"]');
        expect(leftPaneList).toBeInstanceOf(HTMLElement);
        expect(leftPaneList).toHaveFocus();
      });

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenLastCalledWith(
          { field: "browser.pane_mode", value: "single" },
          { signal: expect.any(AbortSignal) }
        );
      });
    });

    it("opens dual-pane mode from the pane toggle button", async () => {
      const user = userEvent.setup();
      const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");

      await user.click(screen.getByRole("button", { name: "Toggle dual-pane view" }));

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenCalledWith(
          { field: "browser.pane_mode", value: "dual" },
          { signal: expect.any(AbortSignal) }
        );
        const rightPaneList = container.querySelector('[data-pane-id="right"] [data-testid="file-list-container"]');
        expect(rightPaneList).toBeInstanceOf(HTMLElement);
        expect(rightPaneList).toHaveFocus();
      });
    });

    it("reuses the current left-pane directory contents when opening dual-pane on the same target", async () => {
      const user = userEvent.setup();
      const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
      });

      const initialRootLoads = (api.listDirectory as Mock).mock.calls.filter(
        ([connectionId, path]) => connectionId === "conn-1" && path === ""
      ).length;

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenCalledWith(
          { field: "browser.pane_mode", value: "dual" },
          { signal: expect.any(AbortSignal) }
        );
        const rightPaneList = container.querySelector('[data-pane-id="right"] [data-testid="file-list-container"]');
        expect(rightPaneList).toBeInstanceOf(HTMLElement);
      });

      const rootLoadsAfterToggle = (api.listDirectory as Mock).mock.calls.filter(
        ([connectionId, path]) => connectionId === "conn-1" && path === ""
      ).length;

      expect(rootLoadsAfterToggle).toBe(initialRootLoads);
    });

    it("returns to single-pane mode after pressing Ctrl+B twice even when a toolbar button has focus", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const settingsButton = screen.getByRole("button", { name: /open settings/i });
      await act(async () => settingsButton.focus());
      expect(settingsButton).toHaveFocus();

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenCalledWith(
          { field: "browser.pane_mode", value: "dual" },
          { signal: expect.any(AbortSignal) }
        );
      });

      await act(async () => settingsButton.focus());
      expect(settingsButton).toHaveFocus();

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenLastCalledWith(
          { field: "browser.pane_mode", value: "single" },
          { signal: expect.any(AbortSignal) }
        );
      });
    });

    it("returns to single-pane mode after pressing Ctrl+B twice even if the left pane receives focus during the transition", async () => {
      const user = userEvent.setup();
      const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const leftPaneList = container.querySelector('[data-pane-id="left"] [data-testid="file-list-container"]');
      expect(leftPaneList).toBeInstanceOf(HTMLElement);

      await user.keyboard("{Control>}b{/Control}");

      await act(async () => {
        (leftPaneList as HTMLElement).focus();
      });

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenLastCalledWith(
          { field: "browser.pane_mode", value: "single" },
          { signal: expect.any(AbortSignal) }
        );
      });
    });
  });
});
