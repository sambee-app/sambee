// Load the shared Vitest mocks before modules that use them.
import "./FileBrowser-interactions.setup";

import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import api from "../../services/api";
import { createNotFoundError } from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { FileType } from "../../types";
import { renderBrowserAndFlush } from "./FileBrowser.test.utils";
import {
  completedTransferResult,
  expectDirectoryLoad,
  setupFileBrowserInteractions,
  setupRegularFileTransferListing,
} from "./FileBrowser-interactions.setup";

describe("Browser Component - Interactions", () => {
  setupFileBrowserInteractions();

  it("ignores a stale picker result after a later upload attempt", async () => {
    const pickers: HTMLInputElement[] = [];
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type === "file") pickers.push(this);
    });
    const hasFocus = vi.spyOn(document, "hasFocus").mockReturnValue(true);
    vi.mocked(api.publishBrowserFile).mockResolvedValue(completedTransferResult);
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      for (const focusReturned of [true, false, true]) {
        hasFocus.mockReturnValue(focusReturned);
        fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
        fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
        if (!focusReturned) expect(pickers).toHaveLength(1);
      }

      expect(pickers).toHaveLength(2);
      Object.defineProperty(pickers[0], "files", { value: [new File(["old"], "old.txt")] });
      await act(async () => {
        pickers[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(api.publishBrowserFile).not.toHaveBeenCalled();

      Object.defineProperty(pickers[1], "files", { value: [new File(["new"], "new.txt")] });
      await act(async () => {
        pickers[1]!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledOnce());
      expect(api.publishBrowserFile).toHaveBeenCalledWith(expect.any(File), "conn-1", "new.txt", "ask", expect.any(Object));
    } finally {
      hasFocus.mockRestore();
      pickerClick.mockRestore();
    }
  });

  it("does not start a pending upload picker while a copy dialog is open", async () => {
    setupRegularFileTransferListing();
    const pickers: HTMLInputElement[] = [];
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type === "file") pickers.push(this);
    });
    try {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents");
      const listContainer = (await screen.findAllByTestId("virtual-list"))[0]!;
      await user.click(listContainer);
      await user.keyboard(" ");
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
      expect(pickers).toHaveLength(1);

      listContainer.focus();
      await user.keyboard("{F5}");
      expect(await screen.findByRole("dialog")).toBeInTheDocument();
      Object.defineProperty(pickers[0], "files", { value: [new File(["new"], "new.txt")] });
      pickers[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      expect(api.publishBrowserFile).not.toHaveBeenCalled();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("rejects a menu choice after the destination changes", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("button", { name: /folder: documents/i, hidden: true }));
      await waitFor(() => expectDirectoryLoad("conn-1", "Documents"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));

      expect(pickerClick).not.toHaveBeenCalled();
      await waitFor(() => expect(screen.getByText(/destination changed/i)).toBeInTheDocument());
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("navigates the upload choices by keyboard and restores focus on Escape", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    const trigger = await screen.findByRole("button", { name: "Upload" });
    await act(async () => trigger.focus());
    fireEvent.click(trigger);
    const files = await screen.findByRole("menuitem", { name: "Files" });
    await waitFor(() => expect(files).toHaveFocus());

    fireEvent.keyDown(files, { key: "ArrowDown" });
    await waitFor(() => expect(screen.getByRole("menuitem", { name: "Folder" })).toHaveFocus());
    fireEvent.keyDown(screen.getByRole("menuitem", { name: "Folder" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Files" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();

    const previousTarget = screen.getByTestId("virtual-list");
    previousTarget.tabIndex = 0;
    await act(async () => previousTarget.focus());
    expect(previousTarget).toHaveFocus();
    fireEvent.keyDown(document, { key: "u", code: "KeyU", ctrlKey: true });
    const shortcutChoice = await screen.findByRole("menuitem", { name: "Files" });
    expect(shortcutChoice).not.toBe(files);
    await waitFor(() => expect(shortcutChoice).toHaveFocus());
    fireEvent.keyDown(shortcutChoice, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("menuitem", { name: "Files" })).not.toBeInTheDocument());
    expect(previousTarget).toHaveFocus();
  });

  it("rejects a pending picker result after navigating to another folder", async () => {
    let picker: HTMLInputElement | null = null;
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type === "file") picker = this;
    });
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
      expect(picker).not.toBeNull();
      fireEvent.click(await screen.findByRole("button", { name: /folder: documents/i }));
      await waitFor(() => expectDirectoryLoad("conn-1", "Documents"));

      Object.defineProperty(picker!, "files", { value: [new File(["data"], "report.txt")] });
      await act(async () => {
        picker!.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await waitFor(() => expect(screen.getByText(/destination changed/i)).toBeInTheDocument());
      expect(api.publishBrowserFile).not.toHaveBeenCalled();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("rejects a folder picker without relative paths before any destination mutation", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["data"], "report.txt")] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));

      await waitFor(() => expect(screen.getByText(/did not provide usable folder paths/)).toBeInTheDocument());
      expect(api.getFileInfo).not.toHaveBeenCalled();
      expect(api.createItem).not.toHaveBeenCalled();
      expect(api.publishBrowserFile).not.toHaveBeenCalled();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("merges a picked folder into an existing destination folder", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      const file = new File(["hello"], "hello.txt");
      Object.defineProperty(file, "webkitRelativePath", { value: "Documents/hello.txt" });
      Object.defineProperty(this, "files", { value: [file], configurable: true });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.publishBrowserFile).mockResolvedValue(completedTransferResult);
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));

      await waitFor(() =>
        expect(api.publishBrowserFile).toHaveBeenCalledWith(
          expect.objectContaining({ name: "hello.txt" }),
          "conn-1",
          "Documents/hello.txt",
          "ask",
          expect.any(Object)
        )
      );
      expect(api.createItem).not.toHaveBeenCalled();
      expect(pickerClick).toHaveBeenCalledOnce();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("creates a missing picked folder before uploading its files", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      const file = new File(["hello"], "hello.txt");
      Object.defineProperty(file, "webkitRelativePath", { value: "NewFolder/hello.txt" });
      Object.defineProperty(this, "files", { value: [file], configurable: true });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.getFileInfo).mockImplementation(async (_connectionId, path) => {
      if (path === "NewFolder") throw createNotFoundError();
      return { name: path, path, type: FileType.DIRECTORY, is_readable: true, is_hidden: false };
    });
    vi.mocked(api.createItem).mockResolvedValue({
      name: "NewFolder",
      path: "NewFolder",
      type: FileType.DIRECTORY,
      is_readable: true,
      is_hidden: false,
    });
    vi.mocked(api.publishBrowserFile).mockResolvedValue(completedTransferResult);
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));

      await waitFor(() =>
        expect(api.publishBrowserFile).toHaveBeenCalledWith(expect.any(File), "conn-1", "NewFolder/hello.txt", "ask", expect.any(Object))
      );
      expect(api.createItem).toHaveBeenCalledWith("conn-1", "", "NewFolder", "directory");
      expect(vi.mocked(api.createItem).mock.invocationCallOrder[0]).toBeLessThan(
        vi.mocked(api.publishBrowserFile).mock.invocationCallOrder[0]!
      );
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("merges a folder created by another client during upload", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      const file = new File(["hello"], "hello.txt");
      Object.defineProperty(file, "webkitRelativePath", { value: "Race/hello.txt" });
      Object.defineProperty(this, "files", { value: [file], configurable: true });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    let lookups = 0;
    vi.mocked(api.getFileInfo).mockImplementation(async (_connectionId, path) => {
      if (path === "Race" && lookups++ === 0) throw createNotFoundError();
      return { name: path, path, type: FileType.DIRECTORY, is_readable: true, is_hidden: false };
    });
    vi.mocked(api.createItem).mockRejectedValueOnce({ response: { status: 409 } });
    vi.mocked(api.publishBrowserFile).mockResolvedValue(completedTransferResult);
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));

      await waitFor(() =>
        expect(api.publishBrowserFile).toHaveBeenCalledWith(expect.any(File), "conn-1", "Race/hello.txt", "ask", expect.any(Object))
      );
      expect(api.createItem).toHaveBeenCalledOnce();
      expect(lookups).toBe(2);
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("renames a conflicting incoming folder before writing descendants", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      const file = new File(["hello"], "hello.txt");
      Object.defineProperty(file, "webkitRelativePath", { value: "Reports/hello.txt" });
      Object.defineProperty(this, "files", { value: [file] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.getFileInfo).mockImplementation(async (_connectionId, path) => {
      if (path === "Reports") return { name: "Reports", path, type: FileType.FILE, is_readable: true, is_hidden: false };
      throw createNotFoundError();
    });
    vi.mocked(api.publishBrowserFile).mockResolvedValue(completedTransferResult);
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));

      expect(await screen.findByRole("button", { name: "Cancel upload" })).toBeInTheDocument();
      expect(screen.queryByRole("radio", { name: "Replace" })).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("radio", { name: /rename/i }));
      fireEvent.change(screen.getByRole("textbox", { name: /name/i }), { target: { value: "Renamed" } });
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledOnce());
      expect(api.createItem).toHaveBeenCalledWith("conn-1", "", "Renamed", "directory");
      expect(api.publishBrowserFile).toHaveBeenCalledWith(expect.any(File), "conn-1", "Renamed/hello.txt", "ask", expect.any(Object));
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("skips a conflicting folder and all its descendants without writing", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      const file = new File(["hello"], "hello.txt");
      Object.defineProperty(file, "webkitRelativePath", { value: "Reports/child/hello.txt" });
      Object.defineProperty(this, "files", { value: [file] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.getFileInfo).mockImplementation(async (_connectionId, path) => {
      if (path === "Reports") return { name: "Reports", path, type: FileType.FILE, is_readable: true, is_hidden: false };
      throw createNotFoundError();
    });
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      const trigger = await screen.findByRole("button", { name: "Upload" });
      fireEvent.click(trigger);
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));
      expect(await screen.findByRole("button", { name: "Cancel upload" })).toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "Continue" }));

      await waitFor(() => expect(trigger).toBeEnabled());
      expect(api.createItem).not.toHaveBeenCalled();
      expect(api.publishBrowserFile).not.toHaveBeenCalled();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("stops a folder upload after an uncertain file outcome", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      const files = ["one.txt", "two.txt"].map((name) => {
        const file = new File(["hello"], name);
        Object.defineProperty(file, "webkitRelativePath", { value: `Documents/${name}` });
        return file;
      });
      Object.defineProperty(this, "files", { value: files, configurable: true });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.publishBrowserFile).mockResolvedValue({
      status: "outcome_unknown",
      replaced: false,
      effects: { source: "unchanged", destination: "unknown" },
    });
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Folder" }));

      await waitFor(() => expect(screen.getByText(/Inspect the destination before retrying/)).toBeInTheDocument());
      expect(api.publishBrowserFile).toHaveBeenCalledOnce();
      expect(api.publishBrowserFile).toHaveBeenCalledWith(expect.any(File), "conn-1", "Documents/one.txt", "ask", expect.any(Object));
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("continues a flat file selection after an uncertain file outcome", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["one"], "one.txt"), new File(["two"], "two.txt")], configurable: true });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    vi.mocked(api.publishBrowserFile)
      .mockResolvedValueOnce({ status: "outcome_unknown", replaced: false, effects: { source: "unchanged", destination: "unknown" } })
      .mockResolvedValueOnce(completedTransferResult);
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));

      await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledTimes(2));
      expect(api.publishBrowserFile).toHaveBeenLastCalledWith(expect.any(File), "conn-1", "two.txt", "ask", expect.any(Object));
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("continues independent files and folder entries after an uncertain root file in a mixed drop", async () => {
    const droppedFile = (name: string) => ({
      name,
      isFile: true,
      file: (resolve: (file: File) => void) => resolve(new File([name], name)),
    });
    const readEntries = vi
      .fn()
      .mockImplementationOnce((resolve: (entries: unknown[]) => void) => resolve([droppedFile("child.txt")]))
      .mockImplementation((resolve: (entries: unknown[]) => void) => resolve([]));
    const folder = { name: "Folder", isDirectory: true, createReader: () => ({ readEntries }) };
    vi.mocked(api.getFileInfo).mockResolvedValue({
      name: "Folder",
      path: "Folder",
      type: FileType.DIRECTORY,
      is_readable: true,
      is_hidden: false,
    });
    vi.mocked(api.publishBrowserFile).mockImplementation(async (file) =>
      file.name === "a.txt"
        ? { status: "outcome_unknown", replaced: false, effects: { source: "unchanged", destination: "unknown" } }
        : completedTransferResult
    );

    await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findByTestId("file-list-container");
    fireEvent.drop(screen.getByTestId("file-list-container"), {
      dataTransfer: {
        types: ["Files"],
        items: [droppedFile("a.txt"), droppedFile("b.txt"), folder].map((entry) => ({ kind: "file", webkitGetAsEntry: () => entry })),
      },
    });

    await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledTimes(3));
    expect(vi.mocked(api.publishBrowserFile).mock.calls.map(([, , path]) => path)).toEqual(["a.txt", "b.txt", "Folder/child.txt"]);
    await waitFor(() => expect(screen.getByText(/Uploaded 2 files.*1 outcome uncertain/)).toBeInTheDocument());
  });

  it("shows sent bytes and publishing separately from confirmed upload completion", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["hello"], "new.txt")] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    let completeUpload: ((value: typeof completedTransferResult) => void) | undefined;
    vi.mocked(api.publishBrowserFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          completeUpload = resolve;
        })
    );
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
      await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledOnce());
      expect(screen.getByText(/Sending/)).toBeInTheDocument();
      const options = requireTestValue(vi.mocked(api.publishBrowserFile).mock.calls[0])[4];
      act(() => options?.onProgress?.(3, 5));
      expect(screen.getByText(/3 B \/ 5 B/)).toBeInTheDocument();
      act(() => options?.onProgress?.(5, 5));
      expect(screen.queryByText(/Uploaded 1 file/)).not.toBeInTheDocument();
      act(() => options?.onUploadSent?.());
      expect(screen.getByText(/Publishing/)).toBeInTheDocument();
      act(() => completeUpload?.(completedTransferResult));
      await waitFor(() => expect(screen.getByText(/Uploaded 1 file/)).toBeInTheDocument());
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("invalidates the original listing without refreshing a pane that navigated away", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["data"], "new.txt")] });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    let completeUpload: ((value: typeof completedTransferResult) => void) | undefined;
    vi.mocked(api.publishBrowserFile).mockImplementation(
      () =>
        new Promise((resolve) => {
          completeUpload = resolve;
        })
    );
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      await screen.findByRole("button", { name: /folder: documents/i });
      const rootLoads = () =>
        vi.mocked(api.listDirectory).mock.calls.filter(([connectionId, path]) => connectionId === "conn-1" && path === "").length;
      const initialLoads = rootLoads();
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("menuitem", { name: "Files" }));
      await waitFor(() => expect(completeUpload).toBeDefined());
      fireEvent.click(screen.getByRole("button", { name: /folder: documents/i }));
      await waitFor(() => expectDirectoryLoad("conn-1", "Documents"));
      completeUpload!(completedTransferResult);
      await screen.findByText(/Uploaded 1 file/);
      expect(rootLoads()).toBe(initialLoads);

      fireEvent.keyDown(document, { key: "Backspace" });
      await waitFor(() => expect(rootLoads()).toBeGreaterThan(initialLoads));
    } finally {
      pickerClick.mockRestore();
    }
  });
});
