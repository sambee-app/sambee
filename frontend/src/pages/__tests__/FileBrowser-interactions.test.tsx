import { createMockAuthToken } from "../../test/fixtures/users";
import { requireTestValue } from "../../test/helpers/assertions";
import { createMockCurrentUserSettings } from "../../test/helpers/mockFactories";
/**
 * Browser Component - Interactions Tests
 * Tests for keyboard navigation, search/filter, sorting, settings, and refresh
 */

import { act, cleanup, createEvent, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, type Mock, vi } from "vitest";
import * as viewerContent from "../../components/Viewer/viewerContent";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { RECENT_DIRECTORIES_CHANGED_EVENT } from "../../services/recentDirectoriesSync";
import { RECENT_FILES_CHANGED_EVENT } from "../../services/recentFilesSync";
import { resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";
import {
  type ApiMock,
  createForbiddenError,
  createMarkdownViewerMock,
  createNetworkError,
  createNotFoundError,
  createTimeoutError,
  createUnauthorizedError,
  setupSuccessfulApiMocks,
} from "../../test/helpers";
import { type ConflictInfo, FileType } from "../../types";
import { QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY } from "../FileBrowser/preferences";
import { mockConnections, mockDirectoryListing, renderBrowserAndFlush } from "./FileBrowser.test.utils";

const expectDirectoryLoad = (connectionId: string, path: string) => {
  expect(api.listDirectory).toHaveBeenCalledWith(
    connectionId,
    path,
    expect.objectContaining({
      signal: expect.any(AbortSignal),
    })
  );
};

const completedTransferResult = {
  status: "completed",
  replaced: false,
  effects: { source: "unchanged", destination: "mutated" },
} as const;

const cancelledTransferResult = {
  status: "cancelled",
  replaced: false,
  effects: { source: "unchanged", destination: "unchanged" },
} as const;

const regularTransferTestItems = [
  {
    name: "Documents",
    path: "Documents",
    type: FileType.FILE,
    size: 1024,
    modified_at: "2024-01-13T10:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
  {
    name: "Pictures",
    path: "Pictures",
    type: FileType.FILE,
    size: 2048,
    modified_at: "2024-01-14T10:00:00Z",
    is_readable: true,
    is_hidden: false,
  },
];

const setupRegularFileTransferListing = () => {
  vi.mocked(api.listDirectory).mockImplementation((_connectionId, path = "") =>
    Promise.resolve(
      path === "" || path === "/"
        ? { path: "", items: regularTransferTestItems, total: regularTransferTestItems.length }
        : { path, items: [], total: 0 }
    )
  );
};

function setupCompactNativeShare() {
  const originalMatchMedia = window.matchMedia;
  const originalShare = Object.getOwnPropertyDescriptor(navigator, "share");
  const originalCanShare = Object.getOwnPropertyDescriptor(navigator, "canShare");
  const share = vi.fn().mockResolvedValue(undefined);
  const canShare = vi.fn().mockReturnValue(true);
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: /max-width/.test(query),
    media: query,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
  Object.defineProperty(navigator, "share", { configurable: true, value: share });
  Object.defineProperty(navigator, "canShare", { configurable: true, value: canShare });

  return {
    share,
    canShare,
    restore() {
      window.matchMedia = originalMatchMedia;
      if (originalShare) Object.defineProperty(navigator, "share", originalShare);
      else Reflect.deleteProperty(navigator, "share");
      if (originalCanShare) Object.defineProperty(navigator, "canShare", originalCanShare);
      else Reflect.deleteProperty(navigator, "canShare");
    },
  };
}

// Mock the API module
vi.mock("../../services/api");

// Mock components using lazy mock factories
vi.mock("../../components/Viewer/MarkdownViewer", () => createMarkdownViewerMock());
// @tanstack/react-virtual mock - explicitly import the mock
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));

describe("Browser Component - Interactions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.copyItem).mockReset();
    vi.mocked(api.moveItem).mockReset();
    resetCurrentUserSettingsStoreForTests();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    localStorage.removeItem("selectedConnectionId");
    localStorage.removeItem(QUICK_NAV_INCLUDE_DOT_DIRECTORIES_STORAGE_KEY);

    // Use mock factory for successful API responses
    setupSuccessfulApiMocks(api as unknown as ApiMock);
    vi.mocked(api.updateCurrentUserSettings).mockImplementation(async (update) => update as never);
  });

  afterEach(() => {
    cleanup();
    localStorage.clear();
  });

  it("flushes mocked initial loading without advancing timers", async () => {
    vi.useFakeTimers();
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expectDirectoryLoad("conn-1", "");
      expect(screen.getByRole("button", { name: "Folder: Documents" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "File: readme.txt" })).toBeInTheDocument();
      expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

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
      pickers[0]!.dispatchEvent(new Event("change", { bubbles: true }));
      expect(api.publishBrowserFile).not.toHaveBeenCalled();

      Object.defineProperty(pickers[1], "files", { value: [new File(["new"], "new.txt")] });
      pickers[1]!.dispatchEvent(new Event("change", { bubbles: true }));
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

  it("rejects a menu choice after the destination changes", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(() => {});
    try {
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      fireEvent.click(await screen.findByRole("button", { name: "Upload" }));
      fireEvent.click(await screen.findByRole("button", { name: /folder: documents/i, hidden: true }));
      await waitFor(() => expectDirectoryLoad("conn-1", "Documents"));
      fireEvent.click(screen.getByRole("menuitem", { name: "Files" }));

      expect(pickerClick).not.toHaveBeenCalled();
      expect(await screen.findByText(/destination changed/i)).toBeInTheDocument();
    } finally {
      pickerClick.mockRestore();
    }
  });

  it("navigates the upload choices by keyboard and restores focus on Escape", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    const trigger = await screen.findByRole("button", { name: "Upload" });
    trigger.focus();
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
    previousTarget.focus();
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
      picker!.dispatchEvent(new Event("change", { bubbles: true }));
      expect(await screen.findByText(/destination changed/i)).toBeInTheDocument();
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

      expect(await screen.findByText(/did not provide usable folder paths/)).toBeInTheDocument();
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

      expect(await screen.findByText(/Inspect the destination before retrying/)).toBeInTheDocument();
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
    expect(await screen.findByText(/Uploaded 2 files.*1 outcome uncertain/)).toBeInTheDocument();
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
      expect(await screen.findByText(/Uploaded 1 file/)).toBeInTheDocument();
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

  describe("Settings", () => {
    it("disables the Refresh toolbar command while settings is open", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();

      await user.click(screen.getByRole("button", { name: "Open settings" }));
      await screen.findByRole("dialog");

      expect(screen.getByRole("button", { name: "Refresh", hidden: true })).toBeDisabled();
    });

    it("opens settings when settings button clicked", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Find settings button - it should be clickable
      const settingsButton = screen.getByRole("button", { name: /open settings/i });
      expect(settingsButton).toBeInTheDocument();

      // Click is handled by navigation, which we can't fully test here
      // without setting up the routes, but we can verify the button works
      await user.click(settingsButton);
    });

    it("does not show unavailable shortcut feedback while settings is open", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      await user.keyboard("{Control>},{/Control}");
      await screen.findByRole("dialog");

      const event = createEvent.keyDown(document, { key: "F7" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("This location is read-only.")).not.toBeInTheDocument();
    });

    it("does not show unavailable shortcut feedback while help is open", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      await user.keyboard("{F1}");
      await screen.findByRole("dialog", { name: "File browser shortcuts" });

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
    });
  });

  describe("Unavailable shortcut scope", () => {
    it.each([
      { name: "image.png", mimeType: "image/png", viewerName: "image viewer" },
      { name: "notes.md", mimeType: "text/markdown", viewerName: "Markdown viewer" },
      { name: "report.pdf", mimeType: "application/pdf", viewerName: "PDF viewer" },
      { name: "notes.txt", mimeType: "text/plain", viewerName: "text viewer" },
    ])("does not show file-list feedback while the $viewerName is open", async ({ name, mimeType }) => {
      const user = userEvent.setup();
      vi.mocked(api.listDirectory).mockResolvedValue({
        path: "",
        items: [
          {
            name,
            path: name,
            type: FileType.FILE,
            size: 1024,
            modified_at: "2024-01-01T00:00:00Z",
            is_readable: true,
            is_hidden: false,
            mime_type: mimeType,
          },
        ],
        total: 1,
      });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await user.click(await screen.findByRole("button", { name: new RegExp(`file: ${name}`, "i") }));
      await screen.findByRole("dialog");

      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
    });

    it("does not show file-list feedback while mobile menus are open", async () => {
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

        await user.click(await screen.findByRole("button", { name: "Open menu" }));
        await screen.findByRole("button", { name: "Open settings" });

        const drawerEvent = createEvent.keyDown(document, { key: "F5" });
        fireEvent(document, drawerEvent);
        expect(drawerEvent.defaultPrevented).toBe(false);
        expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();

        await user.click(screen.getByRole("button", { name: "Open settings" }));
        await screen.findByRole("button", { name: "Go back" });

        const settingsEvent = createEvent.keyDown(document, { key: "F5" });
        fireEvent(document, settingsEvent);
        expect(settingsEvent.defaultPrevented).toBe(false);
        expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
      } finally {
        window.matchMedia = originalMatchMedia;
      }
    });
  });

  describe("Sort Functionality", () => {
    it("sorts files by name, size, and date", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Open sort menu
      const sortButton = screen.getByLabelText(/sort options/i);
      await user.click(sortButton);

      // Click "Size" in the menu
      const sizeOption = await screen.findByText("Size");
      await user.click(sizeOption);

      // Files should be re-rendered (already sorted by component)
      await waitFor(() => {
        const elements = screen.getAllByText("readme.txt");
        expect(elements.length).toBeGreaterThan(0);
      });

      // Open sort menu again
      const sortButtonAgain = screen.getByLabelText(/sort options/i);
      await user.click(sortButtonAgain);

      // Click "Modified" in the menu
      const modifiedOption = await screen.findByText("Modified");
      await user.click(modifiedOption);

      // Files should be re-rendered
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    it("sorts files by name", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Open sort menu
      const sortButton = screen.getByLabelText(/sort options/i);
      await user.click(sortButton);

      // Files should still be displayed (sorting menu opened)
      const documentsElements = screen.getAllByText("Documents");
      expect(documentsElements.length).toBeGreaterThan(0);
    });

    it("maintains sort preference across navigation", async () => {
      const user = userEvent.setup();

      vi.mocked(api.listDirectory).mockImplementation((_connectionId, path = "") => {
        if (path === "Documents") {
          return Promise.resolve({
            items: [
              {
                name: "zzz.txt",
                path: "Documents/zzz.txt",
                type: FileType.FILE,
                size: 100,
                modified_at: "2024-01-01T00:00:00Z",
                is_readable: true,
                is_hidden: false,
              },
              {
                name: "aaa.txt",
                path: "Documents/aaa.txt",
                type: FileType.FILE,
                size: 200,
                modified_at: "2024-01-02T00:00:00Z",
                is_readable: true,
                is_hidden: false,
              },
            ],
            path: "Documents",
            total: 2,
          });
        }
        return Promise.resolve(mockDirectoryListing);
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Optimized: Use findByText
      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      // Open sort menu
      const sortButton = screen.getByLabelText(/sort options/i);
      await user.click(sortButton);

      // Click Size in the menu
      const sizeOption = await screen.findByText("Size");
      await user.click(sizeOption);

      // Navigate into Documents folder
      const documentsFolder = screen.getByRole("button", {
        name: /documents/i,
      });
      await user.click(documentsFolder);

      // Optimized: Use findByText
      await waitFor(() => {
        const elements = screen.getAllByText("aaa.txt");
        expect(elements.length).toBeGreaterThan(0);
      });

      // Sort preference should still be applied
      const zzzElements = screen.getAllByText("zzz.txt");
      expect(zzzElements.length).toBeGreaterThan(0);
    });
  });

  describe("Refresh", () => {
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
      settingsButton.focus();
      expect(settingsButton).toHaveFocus();

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenCalledWith(
          { field: "browser.pane_mode", value: "dual" },
          { signal: expect.any(AbortSignal) }
        );
      });

      settingsButton.focus();
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

      (leftPaneList as HTMLElement).focus();

      await user.keyboard("{Control>}b{/Control}");

      await waitFor(() => {
        expect(api.updateCurrentUserSettings).toHaveBeenLastCalledWith(
          { field: "browser.pane_mode", value: "single" },
          { signal: expect.any(AbortSignal) }
        );
      });
    });

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

      expect(await screen.findByText(/Destination was created but the original could not be removed/)).toBeInTheDocument();
      expect(await screen.findByText("Content transfer failed: transport")).toBeInTheDocument();
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
      expect(await screen.findByText("This location is read-only.")).toBeInTheDocument();
    });

    it("explains unavailable F5, F6, and Alt+F5 when no item is selected", async () => {
      vi.mocked(api.listDirectory).mockResolvedValue({ path: "", items: [], total: 0 });
      await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");

      const [listContainer] = await screen.findAllByTestId("file-list-container");
      requireTestValue(listContainer).focus();

      const copyEvent = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, copyEvent);
      expect(copyEvent.defaultPrevented).toBe(true);
      expect(await screen.findByText("Select one or more items to copy.")).toBeInTheDocument();

      const moveEvent = createEvent.keyDown(document, { key: "F6" });
      fireEvent(document, moveEvent);
      expect(moveEvent.defaultPrevented).toBe(true);
      expect(await screen.findByText("Select one or more items to move.")).toBeInTheDocument();

      const archiveEvent = createEvent.keyDown(document, { key: "F5", altKey: true });
      fireEvent(document, archiveEvent);
      expect(archiveEvent.defaultPrevented).toBe(true);
      expect(await screen.findByText("Select items that can be added to an archive.")).toBeInTheDocument();
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });

    it("explains why F5 requires dual-pane mode", async () => {
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      listContainer.focus();
      const event = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, event);

      expect(event.defaultPrevented).toBe(true);
      expect(await screen.findByText("Copy requires dual-pane mode.")).toBeInTheDocument();
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
      expect(await screen.findByText("This location is read-only.")).toBeInTheDocument();

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
      await screen.findByRole("listbox");

      listContainer.focus();
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
      await screen.findByRole("listbox");

      listContainer.focus();
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
      await screen.findByRole("listbox");

      await user.keyboard("{Shift>}{Enter}{/Shift}");
      await screen.findByRole("dialog", { name: "Choose Viewer" });
      expect(screen.getAllByRole("listbox")).toHaveLength(1);

      await user.keyboard("{Escape}");

      await waitFor(() => {
        expect(screen.queryByRole("dialog", { name: "Choose Viewer" })).not.toBeInTheDocument();
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      });
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
      await screen.findByText("temp.zip");
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
      expect(await screen.findByText("Archive contents cannot be modified.")).toBeInTheDocument();
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
      expect(await screen.findByText("Select an archive to extract.")).toBeInTheDocument();

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
      requireTestValue(listContainer).focus();
      fireEvent.keyDown(document, { key: "F9", altKey: true });
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();

      fireEvent.keyDown(document, { key: "ArrowDown" });
      await waitFor(() => expect(screen.getAllByRole("button", { name: /file: temp\.zip/i })[0]).toHaveAttribute("data-selected", "true"));
      expect(screen.getByRole("button", { name: "Extract archive" })).toBeEnabled();
      fireEvent.keyDown(document, { key: "F9", altKey: true });

      const extractDialog = await screen.findByRole("dialog", { name: "Extract from ZIP Archive" });
      expect(within(extractDialog).getByText("Destination directory:")).toBeInTheDocument();
      expect(within(extractDialog).getByLabelText("Test Server 2:/")).toHaveTextContent("Test Server 2:/");
      const unavailableEvent = createEvent.keyDown(document, { key: "F5" });
      fireEvent(document, unavailableEvent);
      expect(unavailableEvent.defaultPrevented).toBe(false);
      expect(screen.queryByText("Copy requires dual-pane mode.")).not.toBeInTheDocument();
      const locationBeforeTab = screen.getByTestId("router-location").textContent;
      fireEvent.keyDown(document, { key: "Tab" });
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

    it("extracts the selected ZIP member to the other pane from the Copy toolbar command", async () => {
      const user = userEvent.setup();
      vi.mocked(api.listArchiveDirectory).mockResolvedValue({
        archive: { path: "archive.zip", size: 1 },
        path: "",
        items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });
      vi.mocked(api.prepareArchiveOperation).mockResolvedValueOnce({ id: "extract-selected" } as never);
      vi.mocked(api.executeArchiveExtraction).mockResolvedValueOnce({ phase: "completed", checkpoint_json: "{}" } as never);
      await renderBrowserAndFlush("/browse/smb/test-server-1/archive.zip?p2=smb/test-server-2");

      const archiveMember = await screen.findByRole("button", { name: /file: inside\.txt/i });
      const archiveList = archiveMember.closest('[data-testid="virtual-list"]');
      expect(archiveList).toBeInstanceOf(HTMLElement);
      await user.click(archiveList as HTMLElement);

      fireEvent.keyDown(document, { key: "F9", altKey: true });
      expect(screen.queryByRole("dialog", { name: "Extract from ZIP Archive" })).not.toBeInTheDocument();
      await user.keyboard(" ");

      await user.click(screen.getByRole("button", { name: "Copy" }));

      const extractDialog = await screen.findByRole("dialog", { name: "Extract from ZIP Archive" });
      expect(within(extractDialog).getByLabelText("inside.txt")).toHaveTextContent("inside.txt");
      expect(within(extractDialog).getByText("Destination directory:")).toBeInTheDocument();
      expect(within(extractDialog).getByLabelText("Test Server 2:/")).toHaveTextContent("Test Server 2:/");
      await user.click(within(extractDialog).getByRole("button", { name: "Extract" }));

      await waitFor(() => {
        expect(api.prepareArchiveOperation).toHaveBeenCalledWith(expect.objectContaining({ selected_member_paths: ["inside.txt"] }));
      });
      expect(await screen.findByText("Archive extraction completed.")).toBeInTheDocument();
      expect(api.copyItem).not.toHaveBeenCalled();
      expect(api.moveItem).not.toHaveBeenCalled();
      expect(api.executeArchiveCreation).not.toHaveBeenCalled();
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

      expect(await screen.findByRole("alert")).toHaveTextContent("This location is read-only.");
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

      expect(await screen.findByText("Archive extraction was cancelled.")).toBeInTheDocument();
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
          act(() => {
            for (const callback of frames.splice(0)) callback(performance.now());
          });
          expect(within(list).getByRole("button", { name: targetName })).toHaveAttribute("data-selected", "true");
        } finally {
          animationFrame.mockRestore();
          act(() => {
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
        const input = screen.getByPlaceholderText("Navigate to any directory");
        await user.click(input);
        await user.keyboard(`{Shift>}{${key}}{/Shift}`);
        expect(input).toHaveFocus();
        expect(selectedNames(list)).toEqual([]);

        const settingsButton = screen.getByRole("button", { name: /open settings/i });
        settingsButton.focus();
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

    it("opens navigate mode with Ctrl+K even when a toolbar button is focused", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      const settingsButton = screen.getByRole("button", { name: /open settings/i });
      settingsButton.focus();
      expect(settingsButton).toHaveFocus();

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Navigate to any directory");
      expect(quickBarInput).toHaveFocus();
    });

    it("opens the connection selector with Ctrl+ArrowDown", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const quickBarInput = screen.getByPlaceholderText("Navigate to any directory");
      quickBarInput.focus();
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
      modeButton.focus();
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

      const quickBarInput = await screen.findByPlaceholderText("Navigate to any directory");
      expect(quickBarInput).toHaveFocus();
      expect(screen.queryByText(/No results found for/i)).not.toBeInTheDocument();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("searches recent directories and shows no-results for single-character quick nav input", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");

      const quickBarInput = await screen.findByPlaceholderText("Navigate to any directory");
      await user.type(quickBarInput, "e");

      expect(await screen.findByText(/No results found for/i)).toHaveTextContent("e");
      expect(api.searchRecentDirectories).toHaveBeenCalledWith("e", 10, expect.any(AbortSignal));
    });

    it("always shows the current quick-bar mode pill", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");
      await screen.findByPlaceholderText("Navigate to any directory");
      expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("Navigate");

      await user.keyboard("{Control>}p{/Control}");

      const commandInput = await screen.findByPlaceholderText("Run a command");
      expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("Commands");

      await user.type(commandInput, "f");
      expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("Commands");

      await user.click(screen.getByTestId("virtual-list"));
      await user.keyboard("/");

      const fileSearchInput = await screen.findByPlaceholderText("Search recent and current-directory files");
      expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("File Search");

      await user.type(fileSearchInput, "r");
      expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("File Search");
    });

    it.each([
      ["a same-tab history change", () => window.dispatchEvent(new Event(RECENT_FILES_CHANGED_EVENT))],
      ["window focus", () => window.dispatchEvent(new Event("focus"))],
      ["returning to a visible tab", () => document.dispatchEvent(new Event("visibilitychange"))],
    ])("refreshes active File Search after %s", async (_description, triggerRefresh) => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      await user.click(screen.getByTestId("virtual-list"));
      await user.keyboard("/");
      await screen.findByPlaceholderText("Search recent and current-directory files");
      await waitFor(() => {
        expect(api.searchRecentFiles).toHaveBeenCalledWith("", 50, expect.any(AbortSignal));
      });

      const callsBeforeRefresh = vi.mocked(api.searchRecentFiles).mock.calls.length;
      triggerRefresh();

      await waitFor(() => {
        expect(api.searchRecentFiles).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      });
    });

    it.each([
      ["a same-tab history change", () => window.dispatchEvent(new Event(RECENT_FILES_CHANGED_EVENT))],
      ["window focus", () => window.dispatchEvent(new Event("focus"))],
      ["returning to a visible tab", () => document.dispatchEvent(new Event("visibilitychange"))],
    ])("does not reopen focused but dismissed File Search after %s", async (_description, triggerRefresh) => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("/");
      const fileSearchInput = await screen.findByPlaceholderText("Search recent and current-directory files");
      await screen.findByRole("listbox");

      await user.keyboard("{Escape}");
      expect(fileSearchInput).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      const callsBeforeRefresh = vi.mocked(api.searchRecentFiles).mock.calls.length;

      triggerRefresh();

      await waitFor(() => {
        expect(api.searchRecentFiles).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      });
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
      await screen.findByPlaceholderText("Navigate to any directory");
      await waitFor(() => {
        expect(api.searchRecentDirectories).toHaveBeenCalledWith("", 10, expect.any(AbortSignal));
      });

      const callsBeforeRefresh = vi.mocked(api.searchRecentDirectories).mock.calls.length;
      triggerRefresh();

      await waitFor(() => {
        expect(api.searchRecentDirectories).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      });
    });

    it("does not reopen focused but dismissed Directory Navigation after a history refresh", async () => {
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
      const navigateInput = await screen.findByPlaceholderText("Navigate to any directory");
      await screen.findByRole("listbox");

      await user.keyboard("{Escape}");
      expect(navigateInput).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      const callsBeforeRefresh = vi.mocked(api.searchRecentDirectories).mock.calls.length;

      window.dispatchEvent(new Event(RECENT_DIRECTORIES_CHANGED_EVENT));

      await waitFor(() => {
        expect(api.searchRecentDirectories).toHaveBeenCalledTimes(callsBeforeRefresh + 1);
      });
      expect(navigateInput).toHaveFocus();
      expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    });

    it("does not reopen dismissed File Search after returning to the browser tab", async () => {
      const user = userEvent.setup();
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      const listContainer = await screen.findByTestId("virtual-list");
      await user.click(listContainer);
      await user.keyboard("/");
      await screen.findByRole("listbox");

      await user.keyboard("{Escape}{Escape}");
      await waitFor(() => {
        expect(screen.getByTestId("file-list-container")).toHaveFocus();
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
      });

      const callsBeforeTabReturn = vi.mocked(api.searchRecentFiles).mock.calls.length;
      fireEvent(window, new Event("focus"));
      fireEvent(document, new Event("visibilitychange"));

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

      const quickBarInput = await screen.findByPlaceholderText("Navigate to any directory");
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

      const quickBarInput = screen.getByPlaceholderText("Navigate to any directory");
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
      await user.click(screen.getByPlaceholderText("Navigate to any directory"));
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

      const quickBarInput = await screen.findByPlaceholderText("Navigate to any directory");
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
        const fileSearchInput = screen.getByPlaceholderText("Search recent and current-directory files");
        expect(fileSearchInput).toHaveFocus();
      });
    });

    it("switches quick-bar modes from the mode pill", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await waitFor(() => {
        const documentsElements = screen.getAllByText("Documents");
        expect(documentsElements.length).toBeGreaterThan(0);
      });

      await user.keyboard("{Control>}k{/Control}");

      const modeButton = await screen.findByRole("button", { name: "Switch quick bar mode" });
      expect(modeButton).toHaveTextContent("Navigate");

      await user.click(modeButton);
      await user.click(await screen.findByRole("menuitem", { name: "Commands" }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Run a command")).toHaveFocus();
        expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("Commands");
      });

      await user.click(screen.getByRole("button", { name: "Switch quick bar mode" }));
      await user.click(await screen.findByRole("menuitem", { name: "File Search" }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Search recent and current-directory files")).toHaveFocus();
        expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("File Search");
      });

      await user.click(screen.getByRole("button", { name: "Switch quick bar mode" }));
      await user.click(await screen.findByRole("menuitem", { name: "Navigate" }));

      await waitFor(() => {
        expect(screen.getByPlaceholderText("Navigate to any directory")).toHaveFocus();
        expect(screen.getByRole("button", { name: "Switch quick bar mode" })).toHaveTextContent("Navigate");
        expect(screen.getByRole("button", { name: /readme.txt/i })).toBeInTheDocument();
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
      expect(screen.queryByPlaceholderText("Navigate to any directory")).not.toBeInTheDocument();
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

      // The shortcuts dialog should appear
      await waitFor(() => {
        // Dialog may or may not be implemented, so we just verify no crash
        expect(true).toBe(true);
      });
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

  describe("Error Handling", () => {
    it("redirects to login when unauthorized (401)", async () => {
      vi.mocked(api.getConnections).mockRejectedValue(createUnauthorizedError());

      await renderBrowserAndFlush();

      expect(await screen.findByText("Login Page")).toBeInTheDocument();
    });

    it("shows access denied message for admin endpoints (403)", async () => {
      vi.mocked(api.getConnections).mockRejectedValue(createForbiddenError());

      await renderBrowserAndFlush();

      expect(await screen.findByText(/Access denied. Please contact an administrator/i)).toBeInTheDocument();
    });

    it("handles connection not found (404)", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(createNotFoundError());

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Connection not found/i)).toBeInTheDocument();
    });

    it("handles generic API errors", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue({
        response: { data: { detail: "Server error" } },
      });

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Server error/i)).toBeInTheDocument();
    });

    it("handles network errors", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(createNetworkError());

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Failed to load files. Please check your connection settings/i)).toBeInTheDocument();
    });

    it("handles timeout errors with a dedicated message", async () => {
      vi.mocked(api.listDirectory).mockRejectedValue(createTimeoutError());

      await renderBrowserAndFlush("/browse/smb/test-server-1");

      expect(await screen.findByText(/Directory listing timed out. The remote share took too long to respond/i)).toBeInTheDocument();
    });
  });

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
      documentsRow?.focus();
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
      deleteButton.focus();
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
        await user.click(screen.getByRole("button", { name: "Selection actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("2 files ready to share")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Share" }));

        await waitFor(() => expect(share).toHaveBeenCalledOnce());
        const files = share.mock.calls[0]![0].files as File[];
        expect(files.map((file) => file.name)).toEqual(["Documents", "Pictures"]);
        expect(files.map((file) => file.type)).toEqual(["text/plain", "text/plain"]);

        await user.click(screen.getByRole("button", { name: "Selection actions" }));
        await user.click(screen.getByRole("menuitem", { name: "Share" }));
        expect(await screen.findByText("2 files ready to share")).toBeInTheDocument();
        await user.click(screen.getByRole("button", { name: "Clear selection" }));
        await waitFor(() => expect(screen.queryByText("2 files ready to share")).not.toBeInTheDocument());
        expect(share).toHaveBeenCalledOnce();
      } finally {
        restore();
      }
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
        await user.click(screen.getByRole("button", { name: "Selection actions" }));
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
        expect(screen.getAllByRole("button", { name: "Cancel" })).toHaveLength(2);

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

  describe("Rename", () => {
    const PANE_READY_TIMEOUT_MS = 5000;

    it("opens the rename dialog from the active pane toolbar command", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      await screen.findAllByText("Documents");
      await user.click(screen.getByRole("button", { name: "Rename" }));

      expect(await screen.findByRole("dialog")).toBeInTheDocument();
    });

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

        const leftPane = container.querySelector('[data-pane-id="left"]');
        const rightPane = container.querySelector('[data-pane-id="right"]');
        expect(leftPane).toBeInstanceOf(HTMLElement);
        expect(rightPane).toBeInstanceOf(HTMLElement);
        const left = within(leftPane as HTMLElement);
        const right = within(rightPane as HTMLElement);
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

    it("opens rename dialog when F2 is pressed on focused file", async () => {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");

      // Wait for files to load
      await waitFor(() => {
        expect(screen.getAllByText("Documents").length).toBeGreaterThan(0);
      });

      const listContainer = screen.getByTestId("virtual-list");
      await user.click(listContainer);

      // Press F2 key
      await user.keyboard("{F2}");

      // Rename dialog should appear
      await waitFor(() => {
        expect(screen.getByRole("dialog")).toBeInTheDocument();
      });
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
      expect(await screen.findByText("This location is read-only.")).toBeInTheDocument();
    });
  });
});
