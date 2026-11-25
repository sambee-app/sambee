// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, type Mock, vi } from "vitest";
import api from "../../services/api";
import { createNotFoundError } from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { type ConflictInfo, FileType } from "../../types";
import { mockConnections, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import {
  cancelledTransferResult,
  completedTransferResult,
  expectDirectoryLoad,
  regularTransferTestItems,
  setupFileBrowserInteractions,
  setupRegularFileTransferListing,
} from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Refresh", () => {
    it("refreshes the destination pane after copy to the other pane succeeds", async () => {
      const user = userEvent.setup();

      vi.mocked(api.copyItem).mockResolvedValue(completedTransferResult);

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const initialDestinationLoads = (api.listDirectory as Mock).mock.calls.filter(
        ([connectionId, path]) => connectionId === "conn-2" && path === "Documents"
      ).length;

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F5}");

      const dialog = await screen.findByRole("dialog");
      const copyButton = within(dialog).getByRole("button", { name: "Copy" });
      await waitFor(() => {
        expect(copyButton).toBeEnabled();
      });
      await user.click(copyButton);

      await waitFor(() => {
        const destinationLoads = (api.listDirectory as Mock).mock.calls.filter(
          ([connectionId, path]) => connectionId === "conn-2" && path === "Documents"
        ).length;
        expect(destinationLoads).toBeGreaterThan(initialDestinationLoads);
      });
    });

    it.each(["completed", "completed_with_source_retained", "outcome_unknown", "conflict"] as const)(
      "keeps sibling roots under the captured F6 destination after refresh and a %s child",
      async (childStatus) => {
        const user = userEvent.setup();
        const sockets: WebSocket[] = [];
        class CaptureWebSocket extends WebSocket {
          constructor(url: string | URL) {
            super(url);
            sockets.push(this);
          }
        }
        vi.stubGlobal("WebSocket", CaptureWebSocket);
        const roots = regularTransferTestItems.map((entry) => ({ ...entry, type: FileType.DIRECTORY }));
        const nested = { ...regularTransferTestItems[0]!, name: "nested", path: "Documents/nested", type: FileType.DIRECTORY };
        const file = { ...regularTransferTestItems[0]!, name: "report.txt", path: "Documents/nested/report.txt" };
        const secondFile = { ...file, path: "Pictures/report.txt" };
        vi.mocked(api.listDirectory).mockImplementation(async (connectionId, path = "") => ({
          path,
          items:
            connectionId === "conn-1"
              ? path === ""
                ? roots
                : path === "Documents"
                  ? [nested]
                  : path === "Documents/nested"
                    ? [file]
                    : childStatus === "conflict" && path === "Pictures"
                      ? [secondFile]
                      : []
              : [],
          total: 0,
        }));
        vi.mocked(api.getFileInfo).mockImplementation(async (connectionId, path) => {
          if (connectionId === "conn-1") {
            const entry = [...roots, nested, file, secondFile].find((item) => item.path === path);
            if (entry) return entry;
          }
          throw createNotFoundError();
        });
        vi.mocked(api.createItem).mockImplementation(async (_connectionId, parent, name) => ({
          ...nested,
          name,
          path: `${parent}/${name}`,
        }));
        vi.mocked(api.removeEmptyDirectory).mockResolvedValue(undefined);
        vi.mocked(api.moveItem).mockImplementation(async (...args) => {
          const socket = sockets.find((entry) => entry.url.includes("/api/ws"));
          act(() =>
            socket?.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify({ type: "directory_changed", connection_id: "conn-2", path: "Documents" }),
              })
            )
          );
          if (childStatus === "conflict" && args[5] === "ask")
            throw {
              response: { status: 409, data: { detail: { incoming_file: file, existing_file: { ...file, path: args[2] } } } },
            };
          if (childStatus === "completed_with_source_retained")
            return {
              status: childStatus,
              replaced: true,
              effects: { source: "unchanged", destination: "mutated" },
              error: { code: "source_delete_failed", detail: "Source retained after publication" },
            };
          return {
            status: childStatus === "conflict" ? "completed" : childStatus,
            replaced: false,
            effects: { source: childStatus === "outcome_unknown" ? "unknown" : "mutated", destination: "mutated" },
          };
        });

        try {
          await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");
          await waitFor(() => {
            expectDirectoryLoad("conn-1", "");
            expectDirectoryLoad("conn-2", "Documents");
          });
          const list = (await screen.findAllByTestId("virtual-list"))[0]!;
          await user.click(list);
          await user.keyboard("{Control>}a{/Control}");
          await user.keyboard("{F6}");
          await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Move" }));

          if (childStatus === "conflict") {
            await user.click(await screen.findByRole("radio", { name: "Overwrite" }));
            await user.click(screen.getByRole("checkbox", { name: /apply this choice to remaining conflicts/i }));
            await user.click(screen.getByRole("button", { name: "Continue" }));
            await waitFor(() => expect(api.moveItem).toHaveBeenCalledTimes(3));
            expect(vi.mocked(api.moveItem).mock.calls[2]?.slice(0, 6)).toEqual([
              "conn-1",
              "Pictures/report.txt",
              "Documents/Pictures/report.txt",
              expect.any(String),
              "conn-2",
              "replace",
            ]);
          } else await waitFor(() => expect(api.moveItem).toHaveBeenCalledOnce());
          await waitFor(() => {
            if (childStatus === "outcome_unknown") expect(screen.getByText(/transfer outcome is unknown/i)).toBeInTheDocument();
            else expect(api.createItem).toHaveBeenCalledWith("conn-2", "Documents", "Pictures", "directory");
          });
          expect(api.createItem).toHaveBeenCalledWith("conn-2", "Documents", "Documents", "directory");
          expect(api.createItem).toHaveBeenCalledWith("conn-2", "Documents/Documents", "nested", "directory");
          expect(api.moveItem).toHaveBeenCalledWith(
            "conn-1",
            "Documents/nested/report.txt",
            "Documents/Documents/nested/report.txt",
            expect.any(String),
            "conn-2",
            "ask",
            expect.any(Object)
          );
          expect(vi.mocked(api.createItem).mock.calls.some(([, parent, name]) => name === "Pictures" && parent !== "Documents")).toBe(
            false
          );
          if (childStatus === "outcome_unknown") {
            expect(vi.mocked(api.createItem).mock.calls.some(([, , name]) => name === "Pictures")).toBe(false);
            expect(api.removeEmptyDirectory).not.toHaveBeenCalled();
            const calls = vi.mocked(api.moveItem).mock.calls.length;
            fireEvent.keyDown(screen.getByRole("dialog"), { key: "Enter" });
            expect(api.moveItem).toHaveBeenCalledTimes(calls);
          } else {
            expect(api.removeEmptyDirectory).toHaveBeenCalledWith("conn-1", "Pictures");
          }
        } finally {
          vi.unstubAllGlobals();
        }
      }
    );

    it("shows SMB byte progress only for the active copy attempt until the request settles", async () => {
      const sockets: WebSocket[] = [];
      class CaptureWebSocket extends WebSocket {
        constructor(url: string | URL) {
          super(url);
          sockets.push(this);
        }
      }
      vi.stubGlobal("WebSocket", CaptureWebSocket);
      let finishCopy: ((result: typeof completedTransferResult) => void) | undefined;
      vi.mocked(api.copyItem).mockImplementation(
        () =>
          new Promise((resolve) => {
            finishCopy = resolve;
          })
      );
      try {
        setupRegularFileTransferListing();
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");
        const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
        await user.click(requireTestValue(listContainer));
        await user.keyboard(" ");
        await user.keyboard("{F5}");
        const dialog = await screen.findByRole("dialog");
        await user.click(within(dialog).getByRole("button", { name: "Copy" }));
        await waitFor(() => expect(api.copyItem).toHaveBeenCalledOnce());
        const attemptId = requireTestValue(vi.mocked(api.copyItem).mock.calls[0])[6]?.transferAttemptId;
        expect(attemptId).toMatch(/^[\da-f-]{36}$/);
        const socket = sockets.find((entry) => entry.url.includes("/api/ws"));
        expect(socket).toBeDefined();
        const progress = (transferAttemptId: string, bytesTransferred: number) => {
          act(() => {
            socket?.onmessage?.(
              new MessageEvent("message", {
                data: JSON.stringify({
                  type: "transfer_progress",
                  transfer_attempt_id: transferAttemptId,
                  bytes_transferred: bytesTransferred,
                  total_bytes: 2048,
                  item_name: "Documents",
                }),
              })
            );
          });
        };
        progress("00000000-0000-4000-8000-000000000000", 1024);
        expect(within(dialog).queryByText("1.0 KB / 2.0 KB")).not.toBeInTheDocument();
        progress(attemptId!, 1024);
        expect(within(dialog).getByText("1.0 KB / 2.0 KB")).toBeInTheDocument();
        progress(attemptId!, -1);
        expect(within(dialog).getByText("1.0 KB / 2.0 KB")).toBeInTheDocument();
        act(() => finishCopy?.(completedTransferResult));
        await waitFor(() => expect(within(dialog).queryByText("1.0 KB / 2.0 KB")).not.toBeInTheDocument());
        progress(attemptId!, 1024);
        expect(within(dialog).queryByText("1.0 KB / 2.0 KB")).not.toBeInTheDocument();
      } finally {
        vi.unstubAllGlobals();
      }
    });

    it("does not show unavailable feedback while a copy dialog owns keyboard interaction", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      const [listContainer] = await screen.findAllByTestId("virtual-list");
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F5}");
      await screen.findByRole("dialog");

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
    });

    it("closes the copy dialog when an in-progress transfer is cancelled", async () => {
      const user = userEvent.setup();
      setupRegularFileTransferListing();
      vi.mocked(api.copyItem).mockImplementationOnce((...args) => {
        const signal = args[6]?.signal;
        return new Promise<typeof cancelledTransferResult>((resolve) => {
          signal?.addEventListener("abort", () => resolve(cancelledTransferResult), { once: true });
        });
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(listContainer!);
      await user.keyboard(" ");
      await user.keyboard("{F5}");

      const dialog = await screen.findByRole("dialog");
      await user.click(within(dialog).getByRole("button", { name: "Copy" }));
      await waitFor(() => expect(api.copyItem).toHaveBeenCalledOnce());
      await user.click(within(dialog).getByRole("button", { name: "Cancel" }));

      await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
      expect(screen.queryByText("Copy cancelled.")).not.toBeInTheDocument();
    });

    it("shows retained-source warnings alongside later batch errors", async () => {
      const user = userEvent.setup();
      setupRegularFileTransferListing();
      vi.mocked(api.copyItem)
        .mockResolvedValueOnce({
          status: "completed_with_source_retained",
          replaced: false,
          effects: { source: "unchanged", destination: "mutated" },
          error: { code: "source_delete_failed", detail: "Destination was created but the original could not be removed." },
        })
        .mockResolvedValueOnce({
          status: "failed",
          replaced: false,
          effects: { source: "unchanged", destination: "unchanged" },
          error: { code: "transport", detail: "Destination is unavailable." },
        });

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard("{Control>}a{/Control}");
      await user.keyboard("{F5}");
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy" }));

      await waitFor(() => expect(screen.getByText(/Destination was created but the original could not be removed/)).toBeInTheDocument());
      await waitFor(() => expect(screen.getByText("Content transfer failed: transport")).toBeInTheDocument());
    });

    it("offers all regular-file conflict actions when replacement is available", async () => {
      const user = userEvent.setup();
      setupRegularFileTransferListing();
      const conflict: ConflictInfo = {
        incoming_file: {
          name: "Documents",
          path: "Documents",
          type: FileType.FILE,
          size: 1024,
          modified_at: "2024-01-13T10:00:00Z",
          is_readable: true,
          is_hidden: false,
        },
        existing_file: {
          name: "Documents",
          path: "Documents/Documents",
          type: FileType.FILE,
          size: 2048,
          modified_at: "2024-01-14T10:00:00Z",
          is_readable: true,
          is_hidden: false,
        },
      };
      vi.mocked(api.copyItem).mockRejectedValueOnce({ response: { status: 409, data: { detail: conflict } } });

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F5}");
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy" }));
      expect(await screen.findByRole("radio", { name: "Skip" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Rename" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Overwrite" })).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Overwrite only older" })).toBeInTheDocument();
    });

    it("reopens resolution when a renamed copy target also exists", async () => {
      const user = userEvent.setup();
      setupRegularFileTransferListing();
      const firstConflict: ConflictInfo = {
        incoming_file: {
          name: "Documents",
          path: "Documents",
          type: FileType.FILE,
          size: 1024,
          modified_at: "2024-01-13T10:00:00Z",
          is_readable: true,
          is_hidden: false,
        },
        existing_file: {
          name: "Documents",
          path: "Documents/Documents",
          type: FileType.FILE,
          size: 2048,
          modified_at: "2024-01-14T10:00:00Z",
          is_readable: true,
          is_hidden: false,
        },
      };
      const renamedTargetConflict: ConflictInfo = {
        ...firstConflict,
        existing_file: {
          ...firstConflict.existing_file,
          name: "alternate.txt",
          path: "Documents/alternate.txt",
        },
      };
      vi.mocked(api.copyItem)
        .mockRejectedValueOnce({ response: { status: 409, data: { detail: firstConflict } } })
        .mockRejectedValueOnce({ response: { status: 409, data: { detail: renamedTargetConflict } } })
        .mockResolvedValueOnce(completedTransferResult);

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F5}");
      await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "Copy" }));
      await user.click(await screen.findByRole("radio", { name: "Rename" }));
      const targetName = screen.getByRole("textbox", { name: "Target name" });
      await waitFor(() => expect(targetName).toHaveFocus());
      fireEvent.change(targetName, { target: { value: "alternate.txt" } });
      expect(targetName).toHaveValue("alternate.txt");
      await user.click(screen.getByRole("button", { name: "Continue" }));

      await user.click(await screen.findByRole("radio", { name: "Rename" }));
      expect(await screen.findByRole("textbox", { name: "Target name" })).toHaveValue("alternate (copy).txt");
      await user.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(api.copyItem).toHaveBeenCalledTimes(3));
      expect(vi.mocked(api.copyItem).mock.calls[2]?.slice(0, 6)).toEqual([
        "conn-1",
        "Documents",
        "Documents/alternate (copy).txt",
        expect.any(String),
        "conn-2",
        "ask",
      ]);
    });

    it("opens Move when the destination is writable", async () => {
      const user = userEvent.setup();

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F6}");

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Move" })).toBeInTheDocument();
      expect(api.moveItem).not.toHaveBeenCalled();
    });

    it("does not open copy dialog when the destination connection is read-only", async () => {
      const user = userEvent.setup();

      vi.mocked(api.getConnections).mockResolvedValue([mockConnections[0], { ...mockConnections[1], access_mode: "read_only" }]);

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F5}");

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.copyItem).not.toHaveBeenCalled();
    });

    it("prevents browser refresh for F5 when copy is unavailable because the destination connection is read-only", async () => {
      const user = userEvent.setup();

      vi.mocked(api.getConnections).mockResolvedValue([mockConnections[0], { ...mockConnections[1], access_mode: "read_only" }]);

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(true);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.copyItem).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText("This location is read-only.")).toBeInTheDocument());
    });

    it("explains unavailable F5, F6, and Alt+F5 when no item is selected", async () => {
      vi.mocked(api.listDirectory).mockResolvedValue({ path: "", items: [], total: 0 });
      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");

      const [listContainer] = await screen.findAllByTestId("file-list-container");
      await act(async () => {
        requireTestValue(listContainer).focus();
      });

      const copyEvent = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, copyEvent);
      expect(copyEvent.defaultPrevented).toBe(true);
      await waitFor(() => expect(screen.getByText("Select one or more items to copy.")).toBeInTheDocument());

      const moveEvent = createEvent.keyDown(document, { key: "F6" });
      fireEvent(document, moveEvent);
      expect(moveEvent.defaultPrevented).toBe(true);
      await waitFor(() => expect(screen.getByText("Select one or more items to move.")).toBeInTheDocument());

      const archiveEvent = createEvent.keyDown(document, { key: "F5", altKey: true });
      fireEvent(document, archiveEvent);
      expect(archiveEvent.defaultPrevented).toBe(true);
      await waitFor(() => expect(screen.getByText("Select items that can be added to an archive.")).toBeInTheDocument());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("explains why F5 requires dual-pane mode", async () => {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      listContainer.focus();
      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(true);
      await waitFor(() => expect(screen.getByText("Copy requires dual-pane mode.")).toBeInTheDocument());
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("explains why F7 and Shift+F7 cannot create content in a read-only location", async () => {
      vi.mocked(api.getConnections).mockResolvedValue([{ ...mockConnections[0], access_mode: "read_only" }]);
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      listContainer.focus();

      const directoryEvent = createEvent.keyDown(document, { key: "F7" });
      fireEvent(document, directoryEvent);
      expect(directoryEvent.defaultPrevented).toBe(true);
      await waitFor(() => expect(screen.getByText("This location is read-only.")).toBeInTheDocument());

      const fileEvent = createEvent.keyDown(document, { key: "F7", shiftKey: true });
      fireEvent(document, fileEvent);
      expect(fileEvent.defaultPrevented).toBe(true);
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("does not show unavailable shortcut feedback while the quick bar input owns focus", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      await user.keyboard("{Control>}p{/Control}");
      await screen.findByPlaceholderText("Run a command");

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
    });

    it("opens a move dialog without executing a move immediately", async () => {
      const user = userEvent.setup();

      vi.mocked(api.getConnections).mockResolvedValue(mockConnections);

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");

      await waitFor(() => {
        expectDirectoryLoad("conn-1", "");
        expectDirectoryLoad("conn-2", "Documents");
      });

      const listContainer = (await screen.findAllByTestId("virtual-list"))[0];
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{F6}");

      expect(await screen.findByRole("button", { name: "Move" })).toBeInTheDocument();
      expect(api.moveItem).not.toHaveBeenCalled();
    });
  });
});
