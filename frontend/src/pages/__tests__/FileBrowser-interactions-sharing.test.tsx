// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import * as viewerContent from "../../components/Viewer/viewerContent";
import api from "../../services/api";
import { requireTestValue } from "../../test/helpers/assertions";
import { FileType } from "../../types";
import { renderBrowserAndFlush } from "./FileBrowser.test.utils";
import {
  regularTransferTestItems,
  setupCompactNativeShare,
  setupFileBrowserInteractions,
  setupRegularFileTransferListing,
} from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  it("does not restore compact sharing mocks twice over a later override", () => {
    const first = setupCompactNativeShare();
    first.restore();
    const second = setupCompactNativeShare();
    const secondMatchMedia = window.matchMedia;

    first.restore();

    expect(window.matchMedia).toBe(secondMatchMedia);
    expect(navigator.share).toBe(second.share);
    expect(navigator.canShare).toBe(second.canShare);
    second.restore();
  });

  it("offers cancellation during a single-file download", async () => {
    setupRegularFileTransferListing();
    let downloadSignal: AbortSignal | undefined;
    vi.mocked(api.downloadFile).mockImplementationOnce((_connectionId, _path, _name, signal) => {
      downloadSignal = signal;
      return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    const listContainer = await screen.findByTestId("virtual-list");
    await user.click(listContainer);
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("Preparing download")).toBeInTheDocument();
    const cancel = await screen.findByRole("button", { name: "Cancel" });
    await user.click(cancel);
    expect(downloadSignal?.aborted).toBe(true);
    await waitFor(() => expect(screen.queryByText("Preparing download")).not.toBeInTheDocument());
  });

  it("does not flash a preparation notice for a quick single-file handoff", async () => {
    setupRegularFileTransferListing();
    vi.mocked(api.downloadFile).mockResolvedValueOnce(undefined);

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    const listContainer = await screen.findByTestId("virtual-list");
    await user.click(listContainer);
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Download" }));

    await waitFor(() => expect(api.downloadFile).toHaveBeenCalled());
    expect(screen.queryByText("Preparing download")).not.toBeInTheDocument();
  });

  it("shows archive preparation while downloading a directory", async () => {
    let downloadSignal: AbortSignal | undefined;
    vi.mocked(api.downloadSelectionArchive).mockImplementationOnce((_connectionId, _paths, signal) => {
      downloadSignal = signal;
      return new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
    });

    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    const listContainer = await screen.findByTestId("virtual-list");
    await user.click(listContainer);
    await user.keyboard(" ");
    await user.click(screen.getByRole("button", { name: "Download" }));

    expect(await screen.findByText("Preparing archive")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(downloadSignal?.aborted).toBe(true);
  });

  describe("Delete", () => {
    it("shares the original file from the compact item menu", async () => {
      const { share, canShare, restore } = setupCompactNativeShare();

      try {
        setupRegularFileTransferListing();
        vi.mocked(api.getOriginalFileBlob).mockResolvedValue(new Blob(["original"], { type: "text/plain" }));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("1 file ready to share")).toBeInTheDocument();
        expect(share).not.toHaveBeenCalled();
        await user.click(screen.getByRole("button", { name: "Share" }));

        await waitFor(() => expect(share).toHaveBeenCalledOnce());
        expect(api.getOriginalFileBlob).toHaveBeenCalledWith("conn-1", "Documents", { signal: expect.any(AbortSignal) });
        const files = share.mock.calls[0]![0].files as File[];
        expect(files).toHaveLength(1);
        expect(files[0]).toMatchObject({ name: "Documents", type: "text/plain", size: 8 });
        expect(canShare).toHaveBeenCalledWith({ files });

        canShare.mockReturnValue(false);
        await user.click(screen.getByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        await user.click(await screen.findByRole("button", { name: "Share" }));
        expect(await screen.findByText("This browser cannot share this attachment payload.")).toBeInTheDocument();
        expect(share).toHaveBeenCalledOnce();
      } finally {
        restore();
      }
    });

    it("keeps the share notice mounted from download through the native share sheet", async () => {
      const { share, restore } = setupCompactNativeShare();
      let finishDownload: ((blob: Blob) => void) | undefined;
      let finishShare: (() => void) | undefined;
      vi.mocked(api.getOriginalFileBlob).mockImplementation(
        () =>
          new Promise<Blob>((resolve) => {
            finishDownload = resolve;
          })
      );
      share.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishShare = resolve;
          })
      );

      try {
        setupRegularFileTransferListing();
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        const shareBar = (await screen.findByText("Downloading 1 file to share...")).closest(".MuiSnackbar-root");
        expect(shareBar).not.toBeNull();

        await act(async () => {
          finishDownload?.(new Blob(["content"]));
        });
        expect((await screen.findByText("1 file ready to share")).closest(".MuiSnackbar-root")).toBe(shareBar);
        await user.click(screen.getByRole("button", { name: "Share" }));
        expect((await screen.findByText("Opening the share sheet...")).closest(".MuiSnackbar-root")).toBe(shareBar);
        await act(async () => {
          finishShare?.();
        });
      } finally {
        finishDownload?.(new Blob(["content"]));
        finishShare?.();
        restore();
      }
    });

    it("shows the native share error for a downloaded PDF", async () => {
      const { share, restore } = setupCompactNativeShare();
      const downloadBlob = vi.spyOn(viewerContent, "downloadViewerBlob").mockImplementation(() => {});

      try {
        vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") => ({
          path,
          items: path
            ? []
            : [{ ...regularTransferTestItems[0]!, name: "document.pdf", path: "document.pdf", mime_type: "application/pdf" }],
          total: path ? 0 : 1,
        }));
        vi.mocked(api.getOriginalFileBlob).mockResolvedValue(new Blob(["%PDF-1.4"], { type: "application/octet-stream" }));
        share.mockRejectedValueOnce(new DOMException("The browser blocked this file", "NotAllowedError"));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for document.pdf" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        await user.click(await screen.findByRole("button", { name: "Share" }));

        await waitFor(() => expect(share).toHaveBeenCalledOnce());
        expect((share.mock.calls[0]![0].files as File[])[0]).toMatchObject({ name: "document.pdf", type: "application/pdf" });
        expect(await screen.findByText("Failed to share file")).toBeInTheDocument();
        expect(screen.queryByText(/The browser blocked this file/)).not.toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Details" }));
        const report = await screen.findByText(/"reason": "NotAllowedError"/);
        expect(report.textContent).not.toContain("document.pdf");
        expect(report.textContent).toContain('"entryPoint": "file-list"');
        await user.click(screen.getByRole("button", { name: "Close" }));
        await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
        await user.click(screen.getByRole("button", { name: "Download" }));
        expect(downloadBlob).toHaveBeenCalledWith((share.mock.calls[0]![0].files as File[])[0], "document.pdf");
        expect(api.getOriginalFileBlob).toHaveBeenCalledOnce();
        expect(
          screen.queryByText("Browser could not share these files. Download them instead: NotAllowedError: The browser blocked this file")
        ).not.toBeInTheDocument();
      } finally {
        downloadBlob.mockRestore();
        restore();
      }
    });

    it("downloads each prepared file separately after a rejected selection share", async () => {
      const { share, restore } = setupCompactNativeShare();
      const downloadBlob = vi.spyOn(viewerContent, "downloadViewerBlob").mockImplementation(() => {});

      try {
        setupRegularFileTransferListing();
        vi.mocked(api.getOriginalFileBlob).mockImplementation(async (_connectionId, path) => new Blob([path]));
        share.mockRejectedValueOnce(new DOMException("Permission denied", "NotAllowedError"));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "Selection actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        await user.click(await screen.findByRole("button", { name: "Share" }));

        expect(await screen.findByText("Failed to share file")).toBeInTheDocument();
        expect(screen.queryByText(/Permission denied/)).not.toBeInTheDocument();
        const files = share.mock.calls[0]![0].files as File[];
        downloadBlob.mockImplementationOnce(() => {
          throw new Error("Storage unavailable");
        });
        await user.click(screen.getByRole("button", { name: "Download 1/2" }));
        expect(await screen.findByText("Failed to download file")).toBeInTheDocument();
        expect(screen.queryByText(/Storage unavailable/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Download 1/2" })).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Download 1/2" }));
        expect(downloadBlob).toHaveBeenNthCalledWith(2, files[0], "Documents");
        await user.click(screen.getByRole("button", { name: "Download 2/2" }));
        expect(downloadBlob).toHaveBeenNthCalledWith(3, files[1], "Pictures");
        expect(api.getOriginalFileBlob).toHaveBeenCalledTimes(2);
        expect(screen.queryByText("Failed to download file")).not.toBeInTheDocument();
      } finally {
        downloadBlob.mockRestore();
        restore();
      }
    });

    it("shows the download error while preparing to share", async () => {
      const { share, restore } = setupCompactNativeShare();

      try {
        setupRegularFileTransferListing();
        vi.mocked(api.getOriginalFileBlob).mockRejectedValueOnce(new Error("Download failed (403): Forbidden"));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));

        expect(await screen.findByText("Failed to share file")).toBeInTheDocument();
        expect(screen.queryByText(/Forbidden/)).not.toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Details" })).toBeInTheDocument();
        expect(share).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("shares selected files separately in the compact selection menu", async () => {
      const { share, restore } = setupCompactNativeShare();

      try {
        setupRegularFileTransferListing();
        vi.mocked(api.getOriginalFileBlob).mockImplementation(async (_connectionId, path) => new Blob([path], { type: "text/plain" }));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(await screen.findByRole("button", { name: "Selection actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("2 files ready to share")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Share" }));

        await waitFor(() => expect(share).toHaveBeenCalledOnce());
        const files = share.mock.calls[0]![0].files as File[];
        expect(files.map((file) => file.name)).toEqual(["Documents", "Pictures"]);
        expect(files.map((file) => file.type)).toEqual(["text/plain", "text/plain"]);
      } finally {
        restore();
      }
    });

    it("cancels a second prepared compact selection share when the selection is cleared", async () => {
      const { share } = setupCompactNativeShare();
      setupRegularFileTransferListing();
      vi.mocked(api.getOriginalFileBlob).mockImplementation(async (_connectionId, path) => new Blob([path], { type: "text/plain" }));
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await user.click(await screen.findByTestId("file-list-container"));
      await user.keyboard("{Control>}a{/Control}");
      await user.click(await screen.findByRole("button", { name: "Selection actions" }));
      await user.click(screen.getByRole("menuitem", { name: "Share" }));
      expect(await screen.findByText("2 files ready to share")).toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "Share" }));
      await waitFor(() => {
        expect(share).toHaveBeenCalledOnce();
        expect(screen.queryByText("2 files ready to share")).not.toBeInTheDocument();
      });

      await user.click(screen.getByRole("button", { name: "Selection actions" }));
      await user.click(screen.getByRole("menuitem", { name: "Share" }));
      expect(await screen.findByText("2 files ready to share")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Clear selection" }));

      await waitFor(() => expect(screen.queryByText("2 files ready to share")).not.toBeInTheDocument());
      expect(share).toHaveBeenCalledOnce();
    });

    it("shares selections beyond the former count and listed-size limits", async () => {
      const { share, restore } = setupCompactNativeShare();

      try {
        const items = Array.from({ length: 21 }, (_, index) => ({
          ...regularTransferTestItems[0]!,
          name: `file-${index}.txt`,
          path: `file-${index}.txt`,
          size: index === 0 ? 200 * 1024 * 1024 : undefined,
        }));
        vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") => ({
          path,
          items: path ? [] : items,
          total: path ? 0 : items.length,
        }));
        vi.mocked(api.getOriginalFileBlob).mockResolvedValue(new Blob(["content"], { type: "text/plain" }));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        const list = await screen.findByTestId("file-list-container");
        await user.click(list);
        await user.keyboard("{Control>}a{/Control}");
        await user.click(await screen.findByRole("button", { name: "Selection actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("21 files ready to share")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Share" }));

        await waitFor(() => expect(share).toHaveBeenCalledOnce());
        expect(share.mock.calls[0]![0].files).toHaveLength(21);
        expect(api.getOriginalFileBlob).toHaveBeenCalledTimes(21);
      } finally {
        restore();
      }
    });

    it("keeps an OS share active when selection changes until the share sheet settles", async () => {
      const { share, restore } = setupCompactNativeShare();
      let finishShare: (() => void) | undefined;
      share.mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            finishShare = resolve;
          })
      );

      try {
        setupRegularFileTransferListing();
        vi.mocked(api.getOriginalFileBlob).mockResolvedValue(new Blob(["content"]));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        await user.click(await screen.findByRole("button", { name: "Share" }));
        await waitFor(() => expect(share).toHaveBeenCalledOnce());

        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        expect(screen.getByText("Opening the share sheet...")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        expect(screen.getByRole("menuitem", { name: "Share" })).toHaveAttribute("aria-disabled", "true");

        finishShare?.();
        await waitFor(() => expect(screen.queryByText("Opening the share sheet...")).not.toBeInTheDocument());
      } finally {
        finishShare?.();
        restore();
      }
    });

    it("keeps upload cancellation accessible while preparing and failing to share", async () => {
      const { canShare, restore } = setupCompactNativeShare();

      try {
        setupRegularFileTransferListing();
        vi.mocked(api.getOriginalFileBlob).mockResolvedValue(new Blob(["content"]));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");
        await screen.findByRole("button", { name: "More actions for Documents" });

        const fileEntry = {
          name: "pending.txt",
          isFile: true,
          file: vi.fn(),
        };
        fireEvent.drop(screen.getByTestId("file-list-container"), {
          dataTransfer: { types: ["Files"], items: [{ kind: "file", webkitGetAsEntry: () => fileEntry }] },
        });
        expect(await screen.findByText("Preparing upload")).toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "More actions for Documents" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("1 file ready to share")).toBeInTheDocument();
        expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(1);
        expect(document.querySelectorAll(".MuiSnackbar-root")).toHaveLength(1);
        await user.click(screen.getByRole("button", { name: /Next notification/ }));
        expect(screen.getByText("Preparing upload")).toBeInTheDocument();
        expect(screen.getByRole("button", { name: "Cancel" })).toBeEnabled();
        await user.click(screen.getByRole("button", { name: /Next notification/ }));

        canShare.mockReturnValue(false);
        await user.click(screen.getByRole("button", { name: "Share" }));
        expect(await screen.findByText("This browser cannot share this attachment payload.")).toBeInTheDocument();
        expect(screen.getByText("Preparing upload")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        await waitFor(() => expect(screen.queryByText("Preparing upload")).not.toBeInTheDocument());
      } finally {
        restore();
      }
    });

    it("disables sharing for folder selections and cancels a pending file read", async () => {
      const { share, restore } = setupCompactNativeShare();

      try {
        vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") => ({
          path,
          items: path ? [] : [{ ...regularTransferTestItems[0]!, type: FileType.DIRECTORY }, regularTransferTestItems[1]!],
          total: path ? 0 : 2,
        }));
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        expect(screen.queryByRole("menuitem", { name: "Share" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "Selection actions" }));
        expect(screen.getByRole("menuitem", { name: "Share" })).toHaveAttribute("aria-disabled", "true");
        expect(api.getOriginalFileBlob).not.toHaveBeenCalled();

        await user.keyboard("{Escape}");
        await user.click(screen.getByRole("button", { name: "Clear selection" }));
        vi.mocked(api.getOriginalFileBlob).mockImplementation(
          (_connectionId, _path, options) =>
            new Promise((_resolve, reject) =>
              requireTestValue(options).signal?.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), {
                once: true,
              })
            )
        );
        await user.click(screen.getByRole("button", { name: "More actions for Pictures" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("Downloading 1 file to share...")).toBeInTheDocument();
        const signal = vi.mocked(api.getOriginalFileBlob).mock.calls.at(-1)![2]!.signal;
        await user.click(screen.getByRole("button", { name: "Cancel" }));
        expect(signal?.aborted).toBe(true);
        expect(share).not.toHaveBeenCalled();
      } finally {
        restore();
      }
    });

    it("hides compact sharing commands when native sharing is unavailable", async () => {
      const { restore } = setupCompactNativeShare();
      Reflect.deleteProperty(navigator, "share");
      try {
        setupRegularFileTransferListing();
        const user = userEvent.setup();
        await renderBrowserAndFlush("/browse/smb/test-server-1");

        await user.click(await screen.findByRole("button", { name: "More actions for Documents" }));
        expect(screen.queryByRole("menuitem", { name: "Share" })).not.toBeInTheDocument();
        await user.click(screen.getByRole("menuitem", { name: "Select" }));
        await user.click(screen.getByRole("button", { name: "Selection actions" }));
        expect(screen.queryByRole("menuitem", { name: "Share" })).not.toBeInTheDocument();
      } finally {
        restore();
      }
    });
  });
});
