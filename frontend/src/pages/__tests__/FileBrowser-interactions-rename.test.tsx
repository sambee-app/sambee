// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { requireTestValue } from "../../test/helpers/assertions";
import { FileType } from "../../types";
import { mockConnections, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { expectDirectoryLoad, setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Rename", () => {
    const PANE_READY_TIMEOUT_MS = 5000;

    it.each(["immediate", "delayed"] as const)(
      "targets the newly active pane when Rename is invoked from the toolbar (%s loading)",
      async (loading) => {
        const user = userEvent.setup();
        let releaseConnections!: () => void;
        let releaseLeftListing!: () => void;
        let releaseRightListing!: () => void;
        const connectionsReady = new Promise<void>((resolve) => {
          releaseConnections = resolve;
        });
        const leftListingReady = new Promise<void>((resolve) => {
          releaseLeftListing = resolve;
        });
        const rightListingReady = new Promise<void>((resolve) => {
          releaseRightListing = resolve;
        });
        const listings = new Map([
          ["conn-1", { name: "left-item.txt", ready: leftListingReady }],
          ["conn-2", { name: "right-item.txt", ready: rightListingReady }],
        ]);
        vi.mocked(api.getConnections).mockImplementation(async () => {
          await connectionsReady;
          return mockConnections;
        });
        vi.mocked(api.listDirectory).mockImplementation(async (connectionId) => {
          const listing = listings.get(connectionId);
          if (!listing) throw new Error(`Unexpected connection in rename test: ${connectionId}`);
          await listing.ready;
          return {
            items: [
              {
                name: listing.name,
                path: listing.name,
                type: FileType.FILE,
                size: 1,
                modified_at: "2024-01-01T00:00:00Z",
                is_readable: true,
                is_hidden: false,
              },
            ],
            path: "",
            total: 1,
          };
        });

        if (loading === "immediate") {
          releaseConnections();
          releaseLeftListing();
          releaseRightListing();
        }
        const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");
        if (loading === "delayed") {
          await waitFor(() => expect(api.getConnections).toHaveBeenCalled(), { timeout: PANE_READY_TIMEOUT_MS });
          expect(api.listDirectory).not.toHaveBeenCalled();
          await act(async () => releaseConnections());
        }
        await waitFor(
          () => {
            expectDirectoryLoad("conn-1", "");
            expectDirectoryLoad("conn-2", "");
          },
          { timeout: PANE_READY_TIMEOUT_MS }
        );

        const { left, right } = await waitFor(
          () => ({
            left: within(requireTestValue(container.querySelector<HTMLElement>('[data-pane-id="left"]'))),
            right: within(requireTestValue(container.querySelector<HTMLElement>('[data-pane-id="right"]'))),
          }),
          { timeout: PANE_READY_TIMEOUT_MS }
        );
        if (loading === "delayed") {
          expect(left.queryByRole("button", { name: "File: left-item.txt" })).not.toBeInTheDocument();
          expect(right.queryByRole("button", { name: "File: right-item.txt" })).not.toBeInTheDocument();
          await act(async () => releaseLeftListing());
          await left.findByRole("button", { name: "File: left-item.txt" }, { timeout: PANE_READY_TIMEOUT_MS });
          expect(right.queryByRole("button", { name: "File: right-item.txt" })).not.toBeInTheDocument();
          await act(async () => releaseRightListing());
        }
        const rightRow = await waitFor(
          () => {
            expect(left.getByRole("button", { name: "File: left-item.txt" })).toBeInTheDocument();
            return right.getByRole("button", { name: "File: right-item.txt" });
          },
          { timeout: PANE_READY_TIMEOUT_MS }
        );
        await user.click(right.getByTestId("virtual-list"));
        await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("active=2"));
        expect(rightRow).toHaveAttribute("data-selected", "true");

        await user.click(screen.getByRole("button", { name: "Rename" }));
        expect(await screen.findByLabelText(/new name/i)).toHaveValue("right-item.txt");
      }
    );

    it("opens rename dialog when Rename Focused Item is selected from commands mode", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      await user.type(commandInput, "rename");
      await user.click(await screen.findByText("Rename Focused Item"));

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("keeps slash input in the rename dialog instead of opening File Search", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByTestId("virtual-list"));
      await user.keyboard("{F2}");

      const input = await screen.findByLabelText(/new name/i);
      await user.clear(input);
      await user.type(input, "/");

      expect(input).toHaveValue("/");
      expect(screen.queryByPlaceholderText("Search recent and current-directory files")).not.toBeInTheDocument();
    });

    it("calls renameItem API when confirmed", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Wait for files to load
      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      // Press F2 to open rename dialog
      await user.keyboard("{F2}");

      // Wait for the rename dialog input to appear
      const input = await screen.findByLabelText(/new name/i);
      await user.clear(input);
      await user.type(input, "Renamed-Item");

      // Click Rename button
      const renameButton = await screen.findByRole("button", { name: /^rename$/i });
      await user.click(renameButton);

      // renameItem should have been called
      await waitFor(() => {
        expect(api.renameItem).toHaveBeenCalled();
      });
    });

    it("sends NFC when a decomposed filename is renamed", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByTestId("virtual-list"));
      await user.keyboard("{F2}");
      const input = await screen.findByLabelText(/new name/i);
      await user.clear(input);
      await user.type(input, "Auftragsbesta\u0308tigung.pdf");
      await user.click(await screen.findByRole("button", { name: /^rename$/i }));

      await waitFor(() => {
        expect(api.renameItem).toHaveBeenCalledWith(expect.any(String), expect.any(String), "Auftragsbestätigung.pdf");
      });
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

      // Press F2 to open rename dialog
      await user.keyboard("{F2}");

      // Wait for dialog and click Cancel
      const cancelButton = await screen.findByRole("button", { name: /cancel/i });
      await user.click(cancelButton);

      // Dialog should close
      await waitFor(() => {
        expect(screen.queryByLabelText(/new name/i)).not.toBeInTheDocument();
      });
    });

    it("does not open rename dialog for read-only connections", async () => {
      const user = userEvent.setup();

      vi.mocked(api.getConnections).mockResolvedValue([{ ...mockConnections[0], access_mode: "read_only" }]);

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("{F2}");

      await waitFor(() => {
        expect(screen.queryByLabelText(/new name/i)).not.toBeInTheDocument();
      });
      expect(api.renameItem).not.toHaveBeenCalled();
    });

    it("still prevents the browser default for F2 on read-only connections", async () => {
      const user = userEvent.setup();

      vi.mocked(api.getConnections).mockResolvedValue([{ ...mockConnections[0], access_mode: "read_only" }]);

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      const event = createEvent.keyDown(document, { key: "F2" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(true);
      expect(screen.queryByLabelText(/new name/i)).not.toBeInTheDocument();
      expect(api.renameItem).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText("This location is read-only.")).toBeInTheDocument());
    });
  });
});
