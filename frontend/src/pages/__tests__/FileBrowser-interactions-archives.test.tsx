// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { logger } from "../../services/logger";
import { requireTestValue } from "../../test/helpers/assertions";
import { FileType } from "../../types";
import { mockConnections, renderBrowserAndFlush } from "./FileBrowser.test.utils";
import { expectDirectoryLoad, setupFileBrowserInteractions } from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  describe("Refresh", () => {
    it("creates an archive from the active right pane into the opposite pane", async () => {
      const user = userEvent.setup();
      const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });
      await user.keyboard("{Control>}b{/Control}");

      const rightPane = await waitFor(() => {
        const pane = container.querySelector('[data-pane-id="right"]');
        expect(pane).toBeInstanceOf(HTMLElement);
        return pane as HTMLElement;
      });
      await user.click(within(rightPane).getByRole("button", { name: /folder: documents/i }));
      await waitFor(() => {
        expect(within(rightPane).getByText("report.pdf")).toBeInTheDocument();
      });

      await user.click(within(rightPane).getByTestId("virtual-list"));
      await waitFor(() => {
        expect(localStorage.getItem("active-pane")).toBe("right");
      });
      const event = createEvent.keyDown(document, { key: "F5", altKey: true });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(true);
      const directory = await screen.findByLabelText("Test Server 1:/");
      expect(directory).toHaveTextContent("Test Server 1:/");
      expect(screen.getByText("Destination directory:")).toBeInTheDocument();
      expect(screen.getByText("Create a ZIP archive from 1 selected item in the destination directory.")).toBeInTheDocument();

      fireEvent.keyDown(document, { key: "Tab" });
      expect(localStorage.getItem("active-pane")).toBe("right");
    });

    it("shows and logs the V2 archive creation error without request credentials", async () => {
      const user = userEvent.setup();
      const message = "Archive creation source changed after manifest validation";
      const logError = vi.spyOn(logger, "error").mockImplementation(() => {});
      vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "archive-error" } as never);
      vi.mocked(api.executeArchiveCreation).mockRejectedValueOnce({
        response: { status: 409, data: { code: "source_changed", message } },
        config: { headers: { Authorization: "private-token" } },
      });
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      await screen.findByRole("button", { name: /folder: documents/i });
      await user.click(screen.getByTestId("virtual-list"));
      fireEvent.keyDown(document, { key: "F5", altKey: true });
      const dialog = await screen.findByRole("dialog", { name: "Create ZIP Archive" });
      await user.click(within(dialog).getByRole("button", { name: "Create archive" }));

      await waitFor(() => expect(within(dialog).getByText(message)).toBeInTheDocument());
      expect(logError).toHaveBeenCalledWith(
        "Archive creation failed",
        {
          message,
          code: "source_changed",
          status: 409,
          archiveName: expect.any(String),
          destination: expect.any(String),
        },
        "file-browser"
      );
      expect(JSON.stringify(logError.mock.calls)).not.toContain("private-token");
    });

    it("returns focus to the file list after navigating up from ZIP archive root", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "temp.zip",
            path: "temp.zip",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/zip",
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "zebra.txt",
            path: "zebra.txt",
            type: FileType.FILE,
            size: 2048,
            modified_at: "2024-01-02T00:00:00Z",
            mime_type: "text/plain",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 2,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const virtualList = await screen.findByTestId("virtual-list");
      await user.click(virtualList);
      await user.keyboard("{Enter}");
      await screen.findAllByText("temp.zip");
      await user.keyboard("{Backspace}");

      await waitFor(() => {
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
      });

      await user.keyboard("{ArrowDown}");

      await waitFor(() => {
        expect(screen.getByTestId("status-bar-focused-file-name")).toHaveTextContent("zebra.txt");
      });
    });

    it("does not open physical mutation dialogs from archive keyboard shortcuts", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "temp.zip",
            path: "temp.zip",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/zip",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });
      vi.mocked(api.listArchiveDirectory).mockResolvedValue({
        archive: { path: "temp.zip", size: 102400 },
        path: "",
        items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const virtualList = await screen.findByTestId("virtual-list");
      await user.click(virtualList);
      await user.keyboard("{Enter}");
      await screen.findByRole("button", { name: /inside.txt/i });

      await user.keyboard("{Delete}{F2}{F7}{Shift>}{F7}{/Shift}");

      expect(screen.queryByText(/will be permanently deleted/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: /rename/i })).not.toBeInTheDocument();
      expect(screen.queryByRole("dialog", { name: /create/i })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByText("Archive contents cannot be modified.")).toBeInTheDocument());
    });

    it("disables archive-wide extraction with Alt+F9 inside an archive and lists it in keyboard help", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "temp.zip",
            path: "temp.zip",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/zip",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 1,
      });
      vi.mocked(api.listArchiveDirectory).mockResolvedValue({
        archive: { path: "temp.zip", size: 102400 },
        path: "",
        items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const virtualList = await screen.findByTestId("virtual-list");
      await user.click(virtualList);
      await user.keyboard("{Enter}");
      await screen.findByRole("button", { name: /inside.txt/i });

      fireEvent.keyDown(document, { key: "F9", altKey: true });
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();
      await waitFor(() => expect(screen.getByText("Select an archive to extract.")).toBeInTheDocument());

      await user.keyboard("{Control>}p{/Control}");
      const commandInput = await screen.findByPlaceholderText("Run a command");
      await user.type(commandInput, "extract");
      expect(screen.queryByText(/Extract.*ZIP Archive/)).not.toBeInTheDocument();

      await user.keyboard("{Escape}");
      fireEvent.keyDown(document, { key: "F1" });

      const helpDialog = await screen.findByRole("dialog", { name: "File browser shortcuts" });
      expect(within(helpDialog).getByText("Extract ZIP archive")).toBeInTheDocument();
      expect(within(helpDialog).getByText("Alt+F9")).toBeInTheDocument();
    });

    it("opens archive extraction with Alt+F9 for a focused ZIP file", async () => {
      const user = userEvent.setup();
      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name: "temp.zip",
            path: "temp.zip",
            type: FileType.FILE,
            size: 102400,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "application/zip",
            is_readable: true,
            is_hidden: false,
          },
          {
            name: "notes.txt",
            path: "notes.txt",
            type: FileType.FILE,
            size: 1024,
            modified_at: "2024-01-01T00:00:00Z",
            mime_type: "text/plain",
            is_readable: true,
            is_hidden: false,
          },
        ],
        total: 2,
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");

      const [listContainer] = await screen.findAllByTestId("file-list-container");
      await act(async () => {
        requireTestValue(listContainer).focus();
      });
      await user.keyboard("{Alt>}{F9}{/Alt}");
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();

      await user.keyboard("{ArrowDown}");
      await waitFor(() => expect(screen.getAllByRole("button", { name: /file: temp\.zip/i })[0]).toHaveAttribute("data-selected", "true"));
      expect(screen.getByRole("button", { name: "Extract archive" })).toBeEnabled();
      await user.keyboard("{Alt>}{F9}{/Alt}");

      const extractDialog = await screen.findByRole("dialog", { name: "Extract from ZIP Archive" });
      expect(within(extractDialog).getByText("Destination directory:")).toBeInTheDocument();
      expect(within(extractDialog).getByLabelText("Test Server 2:/")).toHaveTextContent("Test Server 2:/");
      const unavailableEvent = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, unavailableEvent);
      expect(unavailableEvent.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
      const locationBeforeTab = screen.getByTestId("router-location").textContent;
      await user.tab();
      expect(screen.getByTestId("router-location")).toHaveTextContent(locationBeforeTab ?? "");
    });

    it("does not show unavailable feedback while the archive creation dialog owns keyboard interaction", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");

      const [listContainer] = await screen.findAllByTestId("virtual-list");
      await user.click(requireTestValue(listContainer));
      await user.keyboard(" ");
      await user.keyboard("{Alt>}{F5}{/Alt}");
      await screen.findByRole("dialog", { name: "Create ZIP Archive" });

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
      expect(screen.getByRole("dialog", { name: "Create ZIP Archive" })).toBeInTheDocument();
    });

    it("blocks copy, move, and archive creation when the opposite pane is a ZIP archive", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1/archive.zip?p2=smb/test-server-2");

      const lists = await screen.findAllByTestId("virtual-list");
      await user.click(lists[1]!);
      await user.keyboard(" ");

      fireEvent.keyDown(document, { key: "F5" });
      fireEvent.keyDown(document, { key: "F6" });
      fireEvent.keyDown(document, { key: "F5", altKey: true });

      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(api.copyItem).not.toHaveBeenCalled();
      expect(api.moveItem).not.toHaveBeenCalled();
      expect(api.prepareArchiveOperation).not.toHaveBeenCalled();
      expect(api.executeArchiveCreation).not.toHaveBeenCalled();
    });

    it.each([
      [{}, "Archive extraction completed.", ""],
      [{}, "Archive extraction completed.", "photos"],
      [
        { members_skipped: 3, encrypted_members_skipped: 1, unsupported_compression_members_skipped: 2 },
        "Archive extraction completed with 3 members skipped. 1 encrypted member was skipped. 2 members with unsupported compression were skipped.",
        "",
      ],
    ])("extracts the selected ZIP member and reports skipped reasons: %j", async (aggregate, expectedNotice, memberBasePath) => {
      const user = userEvent.setup();
      const memberPath = memberBasePath ? `${memberBasePath}/inside.txt` : "inside.txt";
      vi.mocked(api.listArchiveDirectory).mockImplementation(async (_connectionId, _archivePath, path) => ({
        archive: { path: "archive.zip", size: 1 },
        path: path ?? "",
        items:
          memberBasePath && !path
            ? [{ name: memberBasePath, path: memberBasePath, type: FileType.DIRECTORY, state: "readable", is_hidden: false }]
            : [{ name: "inside.txt", path: memberPath, type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      }));
      vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-selected" } as never);
      vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({
        phase: "completed",
        checkpoint_json: JSON.stringify({ aggregate_counters: aggregate }),
      } as never);
      await renderBrowserAndFlush(
        `/browse/smb/test-server-1/archive.zip${memberBasePath ? `/${memberBasePath}` : ""}?p2=smb/test-server-2`
      );

      const archiveMember = await screen.findByRole("button", { name: /file: inside\.txt/i });
      const archiveList = archiveMember.closest('[data-testid="virtual-list"]');
      expect(archiveList).toBeInstanceOf(HTMLElement);
      await user.click(archiveList as HTMLElement);

      fireEvent.keyDown(document, { key: "F9", altKey: true });
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();
      await user.keyboard(" ");

      await user.click(screen.getByRole("button", { name: "Copy" }));

      const extractDialog = await screen.findByRole("dialog", { name: "Extract from ZIP Archive" });
      expect(within(extractDialog).getByLabelText(memberPath)).toHaveTextContent(memberPath);
      expect(within(extractDialog).getByText("Destination directory:")).toBeInTheDocument();
      expect(within(extractDialog).getByLabelText("Test Server 2:/")).toHaveTextContent("Test Server 2:/");
      await user.click(within(extractDialog).getByRole("button", { name: "Extract" }));

      await waitFor(() => {
        expect(api.prepareArchiveOperation).toHaveBeenCalledWith(
          expect.objectContaining({ selected_member_paths: [memberPath], ...(memberBasePath ? { member_base_path: memberBasePath } : {}) })
        );
      });
      await waitFor(() => expect(screen.getByText(expectedNotice)).toBeInTheDocument());
      expect(api.copyItem).not.toHaveBeenCalled();
      expect(api.moveItem).not.toHaveBeenCalled();
      expect(api.executeArchiveCreation).not.toHaveBeenCalled();
    });

    it.each([
      ["blocked", "This archive member is encrypted."],
      ["unavailable", "Sambee does not support this member's compression method."],
    ] as const)("explains why a %s ZIP member cannot be extracted with F5", async (state, message) => {
      const user = userEvent.setup();
      vi.mocked(api.listArchiveDirectory).mockResolvedValue({
        archive: { path: "archive.zip", size: 1 },
        path: "",
        items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state, is_hidden: false }],
        page_size: 100,
      });
      await renderBrowserAndFlush("/browse/smb/test-server-1/archive.zip?p2=smb/test-server-2");
      const archiveMember = await screen.findByRole("button", { name: /file: inside\.txt/i });
      const archiveList = archiveMember.closest('[data-testid="virtual-list"]') as HTMLElement;
      await user.click(archiveList);
      await user.keyboard(" ");
      await user.keyboard("{F5}");
      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent(message));
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();
    });

    it("reports a read-only destination when ZIP-member F5 extraction is unavailable", async () => {
      const user = userEvent.setup();
      vi.mocked(api.getConnections).mockResolvedValue([{ ...mockConnections[0], access_mode: "read_only" }, mockConnections[1]]);
      vi.mocked(api.listArchiveDirectory).mockResolvedValue({
        archive: { path: "archive.zip", size: 1 },
        path: "",
        items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });
      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/archive.zip&active=2");

      await waitFor(() => expectDirectoryLoad("conn-1", ""));
      const archiveMember = await screen.findByRole("button", { name: /file: inside\.txt/i });
      const archiveList = archiveMember.closest('[data-testid="virtual-list"]');
      expect(archiveList).toBeInstanceOf(HTMLElement);
      await user.click(archiveList as HTMLElement);
      await user.keyboard(" ");

      await user.keyboard("{F5}");

      await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("This location is read-only."));
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();
    });

    it("reports a cancelled selected-member extraction", async () => {
      const user = userEvent.setup();
      vi.mocked(api.listArchiveDirectory).mockResolvedValue({
        archive: { path: "archive.zip", size: 1 },
        path: "",
        items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });
      vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-cancelled" } as never);
      vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({ phase: "cancelled", checkpoint_json: "{}" } as never);
      await renderBrowserAndFlush("/browse/smb/test-server-1/archive.zip?p2=smb/test-server-2");

      const archiveMember = await screen.findByRole("button", { name: /file: inside\.txt/i });
      const archiveList = archiveMember.closest('[data-testid="virtual-list"]');
      expect(archiveList).toBeInstanceOf(HTMLElement);
      await user.click(archiveList as HTMLElement);
      await user.keyboard(" ");
      fireEvent.keyDown(document, { key: "F5" });

      const extractDialog = await screen.findByRole("dialog", { name: "Extract from ZIP Archive" });
      await user.click(within(extractDialog).getByRole("button", { name: "Extract" }));

      await waitFor(() => expect(screen.getByText("Archive extraction was cancelled.")).toBeInTheDocument());
    });
  });
});
