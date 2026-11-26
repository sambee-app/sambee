import * as reactVirtual from "@tanstack/react-virtual";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NOTICE_DURATION_MS } from "../../components/OperationNotifications";
import type { UseCompanionResult } from "../../hooks/useCompanion";
import api from "../../services/api";
import * as authConfigModule from "../../services/authConfig";
import { authSession } from "../../services/authSession";
import type { FilesystemSearchRecord } from "../../services/filesystemSearchContract";
import { resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";
import { createMockAuthToken } from "../../test/fixtures/users";
import { type ApiMock, setupSuccessfulApiMocks } from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { mockWebLocks } from "../../test/mocks/webLocks";
import { renderWithStyles } from "../../test/utils/renderWithStyles";
import { FileType } from "../../types";
import { setApplePlatformForTesting } from "../../utils/platform";
import {
  type PersistedWorkspaceTabsRecord,
  readPaneTabHistoryState,
  readWorkspacePageIds,
  resetPaneTabsStorageStateForTesting,
  WORKSPACE_TAB_RECORD_PREFIX,
} from "../FileBrowser/workspaceTabStorage";
import {
  mockDirectoryListing,
  mockEmptyDirectory,
  mockNestedDirectory,
  renderBrowser,
  renderBrowserAndFlush,
} from "./FileBrowser.test.utils";

const mockUseCompanion = vi.fn<() => UseCompanionResult>();
const { appRouter } = vi.hoisted(() => ({
  appRouter: { current: null as ReturnType<typeof import("react-router-dom").createMemoryRouter> | null },
}));

vi.mock("../../services/api");
vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react-router-dom")>();
  return {
    ...actual,
    createBrowserRouter(routes: Parameters<typeof actual.createMemoryRouter>[0]) {
      appRouter.current = actual.createMemoryRouter(routes, { initialEntries: ["/browse/smb/test-server-1"] });
      return appRouter.current;
    },
  };
});
vi.mock("@tanstack/react-virtual", () => import("../../__mocks__/@tanstack/react-virtual"));
vi.mock("../../hooks/useCompanion", () => ({
  useCompanion: () => mockUseCompanion(),
}));
vi.mock("../../services/companion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/companion")>();
  return {
    ...actual,
    buildCompanionWsUrl: vi.fn().mockResolvedValue(null),
  };
});

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

describe("FileBrowser — Pane Tabs Integration", () => {
  beforeEach(() => {
    mockWebLocks();
    vi.clearAllMocks();
    resetCurrentUserSettingsStoreForTests();
    resetPaneTabsStorageStateForTesting();
    setApplePlatformForTesting(false);
    sessionStorage.clear();
    localStorage.clear();
    window.history.replaceState(null, "");
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", user_id: "user-1" }), false);
    mockUseCompanion.mockReturnValue({
      status: "unavailable",
      drives: [],
      initiatePairing: vi.fn(),
      confirmPairing: vi.fn(),
      refresh: vi.fn(),
      loading: false,
    });
    setupSuccessfulApiMocks(api as unknown as ApiMock);
  });

  afterEach(() => {
    setApplePlatformForTesting(null);
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("starts a live search with slash, streams results, and retains the browse tab", async () => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    let signal: AbortSignal | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, requestSignal, onRecord) => {
      signal = requestSignal;
      publish = onRecord;
      return new Promise(() => {});
    });

    const user = userEvent.setup();
    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    const list = await screen.findByTestId("file-list-container");
    act(() => list.focus());
    await user.keyboard("/");
    const input = await screen.findByPlaceholderText("Search files and folders");
    await user.keyboard("{ArrowDown} ");
    expect(screen.getByRole("menuitemradio", { name: "Current folder and subfolders" })).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(screen.getByRole("menuitemradio", { name: "Current folder only" })).toHaveFocus();
    await user.keyboard(" {Escape}");
    expect(input).toHaveFocus();
    expect(api.startFilesystemSearch).not.toHaveBeenCalled();
    await user.type(input, "report{Enter}");
    await waitFor(() => expect(api.startFilesystemSearch).toHaveBeenCalledOnce());
    expect(vi.mocked(api.startFilesystemSearch).mock.calls[0]?.[0].folder_depth).toBe("current");
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);
    expect(screen.getAllByText("Search results 1").length).toBeGreaterThan(0);
    expect(screen.getByRole("status")).toHaveTextContent("Searching");
    await act(async () => {
      await publish?.({
        type: "batch",
        results: [
          {
            entry: { name: "report.txt", path: "docs/report.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
            target: { kind: "physical", path: "docs/report.txt" },
          },
        ],
      });
    });
    expect((await screen.findAllByText("report.txt")).length).toBeGreaterThan(0);
    expect(screen.getByText("docs", { selector: "bdi > span" })).toBeInTheDocument();
    expect(screen.queryByText("in docs")).not.toBeInTheDocument();
    expect(screen.queryByText("→")).not.toBeInTheDocument();
    await act(async () => {
      await publish?.({
        type: "terminal",
        reason: "complete",
        counts: { matches: 1, scanned_directories: 1, skipped: 0 },
        skips: [],
      });
    });
    const row = screen.getByRole("button", { name: "File: report.txt, in docs" });
    act(() => row.focus());
    await user.keyboard("/");
    await waitFor(() => expect(input).toHaveFocus());
    expect(api.startFilesystemSearch).toHaveBeenCalledOnce();
    const refresh = screen.getByRole("button", { name: /refresh/i });
    expect(refresh).toBeDisabled();
    const searchList = screen.getByTestId("file-list-container");
    act(() => searchList.focus());
    await act(async () => {
      fireEvent.keyDown(searchList, { key: "-", altKey: true });
      await Promise.resolve();
    });
    expect(signal?.aborted).toBe(true);
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);
    expect(screen.queryByText("report.txt")).not.toBeInTheDocument();
  });

  it("shows paths instead of file details and keeps search status visible in compact layout", async () => {
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
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise(() => {});
    });

    try {
      const user = userEvent.setup();
      await renderBrowserAndFlush("/browse/smb/test-server-1");
      const list = await screen.findByTestId("file-list-container");
      act(() => list.focus());
      await user.keyboard("/");
      await user.type(await screen.findByPlaceholderText("Search files and folders"), "report{Enter}");
      await waitFor(() => expect(publish).toBeDefined());
      expect(screen.getByRole("status")).toHaveTextContent("Searching");
      expect(screen.queryByTestId("status-bar-focused-file-name")).not.toBeInTheDocument();

      await act(async () => {
        await publish?.({
          type: "batch",
          results: [
            {
              entry: { name: "report.txt", path: "report.txt", type: FileType.FILE, is_readable: true, is_hidden: false, size: 1024 },
              target: { kind: "physical", path: "report.txt" },
            },
            {
              entry: { name: "report.txt", path: "docs/report.txt", type: FileType.FILE, is_readable: true, is_hidden: false, size: 1024 },
              target: { kind: "physical", path: "docs/report.txt" },
            },
          ],
        });
      });
      expect(screen.getByText("2 items")).toBeInTheDocument();
      const rootMatch = screen.getByRole("button", { name: "File: report.txt" });
      const nestedMatch = screen.getByRole("button", { name: "File: report.txt, in docs" });
      expect(rootMatch).toHaveTextContent(/^report\.txt$/);
      expect(within(nestedMatch).getByTitle("docs")).toHaveTextContent(/^docs$/);
      expect(within(nestedMatch).queryByText(/1 KB/)).not.toBeInTheDocument();

      await act(async () => {
        await publish?.({
          type: "terminal",
          reason: "partial_coverage",
          counts: { matches: 2, scanned_directories: 1, skipped: 1 },
          skips: [{ reason: "unreadable_directory", count: 1 }],
        });
      });
      expect(screen.getByTitle("Search ended with incomplete coverage. Check the skipped items and try again.")).toHaveAttribute(
        "role",
        "status"
      );
    } finally {
      window.matchMedia = originalMatchMedia;
    }
  });

  it.each(["running", "complete"] as const)("opens the first live search result with Enter when the search is %s", async (status) => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise(() => {});
    });
    vi.mocked(api.getFileContent).mockResolvedValue("Search result content");
    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    await waitFor(() => expect(screen.getByTestId("file-list-container")).toHaveFocus());
    await user.keyboard("/");
    await user.type(await screen.findByPlaceholderText("Search files and folders"), "note{Enter}");
    await waitFor(() => expect(publish).toBeDefined());

    await user.keyboard("{Enter}");
    expect(api.startFilesystemSearch).toHaveBeenCalledOnce();
    expect(api.getFileContent).not.toHaveBeenCalled();

    await act(async () => {
      await publish?.({
        type: "batch",
        results: ["note.txt", "notes.txt"].map((name) => ({
          entry: { name, path: `docs/${name}`, type: FileType.FILE, is_readable: true, is_hidden: false, mime_type: "text/plain" },
          target: { kind: "physical", path: `docs/${name}` },
        })),
      });
    });
    if (status === "complete") {
      await act(async () => {
        await publish?.({
          type: "terminal",
          reason: "complete",
          counts: { matches: 2, scanned_directories: 1, skipped: 0 },
          skips: [],
        });
      });
    }

    expect(screen.getByRole("status")).toHaveTextContent(status === "complete" ? "Search complete." : "Searching");
    expect(screen.getByRole("button", { name: "File: note.txt, in docs" })).toBeVisible();
    expect(screen.getByTestId("file-list-container")).toHaveFocus();
    await user.keyboard("{Enter}");
    await act(() => vi.dynamicImportSettled());
    expect(await screen.findByText("Search result content")).toBeVisible();
    expect(vi.mocked(api.getFileContent).mock.calls[0]?.[1]).toBe("docs/note.txt");
  });

  it.each(["physical", "archive"] as const)("navigates a stable %s search gallery and returns to the last viewed row", async (kind) => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise(() => {});
    });
    vi.mocked(api.getArchiveMember).mockResolvedValue(new Blob(["image"], { type: "image/png" }));
    vi.stubGlobal(
      "URL",
      class extends URL {
        static createObjectURL = vi.fn(() => "blob:search-image");
        static revokeObjectURL = vi.fn();
      }
    );
    const physical = (path: string, readable = true) => ({
      entry: { name: path.split("/").at(-1)!, path, type: FileType.FILE, is_readable: readable, is_hidden: false, mime_type: "image/png" },
      target: { kind: "physical" as const, path },
    });
    const member = (path: string, archive = "one.zip") => ({
      entry: physical(path).entry,
      target: { kind: "archive" as const, archive_path: archive, member_path: path },
      archive_state: "readable" as const,
    });
    const makeResult = kind === "physical" ? physical : member;
    const user = userEvent.setup();
    const { router } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    const viewerPath = () => {
      const params = new URLSearchParams(router.state.location.search);
      return kind === "archive" ? params.get("virtual") : params.get("file");
    };
    const expectedTarget = (path: string) => (kind === "archive" ? JSON.stringify(["zip", "one.zip", path]) : `smb/test-server-1/${path}`);
    await waitFor(() => expect(screen.getByTestId("file-list-container")).toHaveFocus());
    await user.keyboard("/");
    await user.type(await screen.findByPlaceholderText("Search files and folders"), "photo{Enter}");
    await waitFor(() => expect(publish).toBeDefined());

    await act(async () => {
      await publish?.({
        type: "batch",
        results: [
          makeResult("a/photo.png"),
          makeResult("b/photo.png"),
          member("b/photo.png", "other.zip"),
          kind === "archive" ? physical("b/photo.png") : physical("c/photo.png", false),
        ],
      });
    });
    await user.keyboard("{Enter}");
    await act(() => vi.dynamicImportSettled());
    const viewer = await screen.findByRole("dialog", { name: "" });
    const expectViewerReady = () => expect(viewer.closest("[aria-busy]")).toHaveAttribute("aria-busy", "false");
    await waitFor(expectViewerReady);
    expect(viewerPath()).toBe(expectedTarget("a/photo.png"));

    await act(async () => {
      await publish?.({ type: "batch", results: [makeResult("later/z-photo.png")] });
    });
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    await waitFor(() => expect(viewerPath()).toBe(expectedTarget("b/photo.png")));
    await waitFor(expectViewerReady);
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    expect(viewerPath()).toBe(expectedTarget("b/photo.png"));
    fireEvent.keyDown(viewer, { key: "ArrowLeft" });
    await waitFor(() => expect(viewerPath()).toBe(expectedTarget("a/photo.png")));
    await waitFor(expectViewerReady);
    fireEvent.keyDown(viewer, { key: "ArrowRight" });
    await waitFor(() => expect(viewerPath()).toBe(expectedTarget("b/photo.png")));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "" })).not.toBeInTheDocument());
    await waitFor(() => expect(screen.getByTestId("file-list-container")).toHaveFocus());
    await user.keyboard("{Enter}");
    await waitFor(() => expect(viewerPath()).toBe(expectedTarget("b/photo.png")));
  });

  it.each([
    ["partial_coverage", "incomplete coverage"],
    ["time_limit", "Time limit reached"],
    ["source_failure", "source failed"],
  ] as const)("notifies once when a background search ends with %s and keeps its rows", async (reason, message) => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise(() => {});
    });
    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    act(() => screen.getByTestId("file-list-container").focus());
    await user.keyboard("/");
    await user.type(await screen.findByPlaceholderText("Search files and folders"), "report{Enter}");
    await waitFor(() => expect(publish).toBeDefined());
    await act(async () => {
      await publish?.({
        type: "batch",
        results: [
          {
            entry: { name: "report.txt", path: "docs/report.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
            target: { kind: "physical", path: "docs/report.txt" },
          },
        ],
      });
    });
    await user.click(within(screen.getByTestId("pane-tab-item-left-0")).getByRole("button", { name: /^Test Server 1 —/ }));
    await act(async () => {
      await publish?.({
        type: "terminal",
        reason,
        counts: { matches: 1, scanned_directories: 1, skipped: 1 },
        skips: [{ reason: "unreadable_directory", count: 1 }],
      });
    });
    const notice = await screen.findByRole(reason === "source_failure" ? "alert" : "status");
    expect(notice).toHaveTextContent(message);
    await user.click(within(notice).getByRole("button", { name: "Close" }));
    await user.click(screen.getByRole("button", { name: /^Search results 1$/ }));
    expect(screen.getByRole("status")).toHaveTextContent(message);
    expect(screen.getByTitle("docs")).toBeInTheDocument();
    expect(document.querySelector(".MuiSnackbar-root")).not.toBeInTheDocument();
    await user.click(within(screen.getByTestId("pane-tab-item-left-0")).getByRole("button", { name: /^Test Server 1 —/ }));
    await user.click(screen.getByRole("button", { name: /^Search results 1$/ }));
    expect(document.querySelector(".MuiSnackbar-root")).not.toBeInTheDocument();
  });

  it.each([false, true])("reports an unexpected interruption without discarding rows (terminal received: %s)", async (terminalReceived) => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    let reject: ((reason: Error) => void) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise((_resolve, rejectRun) => {
        reject = rejectRun;
      });
    });
    const user = userEvent.setup();
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    act(() => screen.getByTestId("file-list-container").focus());
    await user.keyboard("/");
    await user.type(await screen.findByPlaceholderText("Search files and folders"), "report{Enter}");
    await waitFor(() => expect(publish).toBeDefined());
    await act(async () => {
      await publish?.({
        type: "batch",
        results: [
          {
            entry: { name: "report.txt", path: "docs/report.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
            target: { kind: "physical", path: "docs/report.txt" },
          },
        ],
      });
      if (terminalReceived) {
        await publish?.({
          type: "terminal",
          reason: "complete",
          counts: { matches: 1, scanned_directories: 1, skipped: 0 },
          skips: [],
        });
      }
      reject?.(new Error("Connection lost."));
    });
    expect(await screen.findByRole("alert")).toHaveTextContent("Search was interrupted. Start a new search to try again.");
    expect(screen.getByText("1 item")).toBeInTheDocument();
    expect(screen.getByTestId("pane-context-row")).toHaveTextContent("Search: “report” in Test Server 1:/");
    expect(screen.getByTitle("docs")).toBeInTheDocument();
    expect(screen.queryByText("No matches.")).not.toBeInTheDocument();
  });

  it("opens quick-navigation targets from a search-results tab in a new folder tab", async () => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise(() => {});
    });
    vi.mocked(api.searchDirectories).mockResolvedValue({
      results: ["Documents"],
      total_matches: 1,
      cache_state: "ready",
      directory_count: 1,
    });
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );
    const user = userEvent.setup();
    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    act(() => screen.getByTestId("file-list-container").focus());
    await user.keyboard("/");
    await user.type(await screen.findByPlaceholderText("Search files and folders"), "report{Enter}");
    await waitFor(() => expect(publish).toBeDefined());
    await act(async () => {
      await publish?.({
        type: "batch",
        results: [
          {
            entry: { name: "report.txt", path: "docs/report.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
            target: { kind: "physical", path: "docs/report.txt" },
          },
        ],
      });
    });
    expect(await screen.findByTitle("docs")).toBeInTheDocument();

    act(() => screen.getByTestId("file-list-container").focus());
    await user.keyboard("{Control>}k{/Control}");
    await user.type(screen.getByPlaceholderText("Quick navigation"), "Doc");
    expect(await screen.findByRole("option", { name: /^Documents\b/ })).toBeVisible();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(3));
    await waitFor(() => expect(vi.mocked(api.listDirectory)).toHaveBeenCalledWith("conn-1", "Documents", expect.anything()));
    expect(screen.queryByTitle("docs")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^Search results 1$/ }));
    expect(await screen.findByTitle("docs")).toBeInTheDocument();
    expect(screen.getByTestId("pane-context-row")).toHaveTextContent("Search: “report” in Test Server 1:/");
  });

  it("keeps tab and breadcrumb controls non-focusable and restores file-list focus even when breadcrumb navigation fails", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );

    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1/Documents");
    const list = await screen.findByTestId("file-list-container");
    await waitFor(() => expect(list).toHaveFocus());

    // Verify every interactive button inside tab bar and breadcrumbs has tabindex="-1"
    const tabBarButtons = container.querySelectorAll('[data-testid="pane-tab-bar-left"] button');
    expect(tabBarButtons.length).toBeGreaterThan(0);
    for (const button of tabBarButtons) {
      expect(button).toHaveAttribute("tabindex", "-1");
    }
    const rootBreadcrumb = screen.getByRole("button", { name: "Navigate to root directory" });
    expect(rootBreadcrumb).toHaveAttribute("tabindex", "-1");

    // Click Add button -> creates second tab and leaves focus on file-list-container
    await user.click(screen.getByTestId("pane-tab-add-left"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);
    expect(screen.getByTestId("file-list-container")).toHaveFocus();

    // Fail root breadcrumb navigation -> focus still stays on file-list-container
    vi.mocked(api.listDirectory).mockRejectedValueOnce({
      response: { status: 403, data: { detail: { code: "directory_access_denied" } } },
    });
    await user.click(screen.getByRole("button", { name: "Navigate to root directory" }));
    await waitFor(() => expect(screen.getByTestId("file-list-container")).toHaveFocus());
  });

  it("switches, creates, and closes tabs via file-list shortcuts in populated, empty, loading, and failed directories", async () => {
    const slowLoad = deferred<typeof mockDirectoryListing>();
    vi.mocked(api.listDirectory).mockImplementation((_conn, path = "") => {
      if (path === "Empty") return Promise.resolve(mockEmptyDirectory);
      if (path === "Loading") return slowLoad.promise;
      if (path === "Failed") {
        return Promise.reject({ response: { status: 403, data: { detail: { code: "directory_access_denied" } } } });
      }
      return Promise.resolve(mockDirectoryListing);
    });

    const { container, router } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    const list = await screen.findByTestId("file-list-container");
    list.focus();

    // Alt+Plus creates tab 2; repeat events are ignored
    fireEvent.keyDown(list, { key: "+", altKey: true, shiftKey: true });
    fireEvent.keyDown(list, { key: "+", altKey: true, shiftKey: true, repeat: true });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);
    await waitFor(() => expect(screen.getByTestId("pane-tab-live-region-left")).toHaveTextContent("Test Server 1, tab 2 of 2"));

    // Navigate tab 2 to Empty directory -> plain Left wraps to tab 1, plain Right returns to Empty tab 2
    await act(() => router.navigate("/browse/smb/test-server-1/Empty"));
    await waitFor(() => expect(screen.getByText("This directory is empty")).toBeInTheDocument());
    const emptyList = screen.getByTestId("file-list-container");
    emptyList.focus();

    fireEvent.keyDown(emptyList, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1"));
    expect(screen.getByTestId("file-list-container")).toHaveFocus();

    fireEvent.keyDown(screen.getByTestId("file-list-container"), { key: "ArrowRight" });
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Empty"));

    // Create tab 3 and enter a Failed directory -> Left/Right still switch out of the failed directory!
    fireEvent.keyDown(screen.getByTestId("file-list-container"), { key: "+", altKey: true });
    await act(() => router.navigate("/browse/smb/test-server-1/Failed"));
    await waitFor(() => expect(screen.getAllByText(/permission to open this folder/i).length).toBeGreaterThan(0));
    const failedList = screen.getByTestId("file-list-container");
    failedList.focus();
    fireEvent.keyDown(failedList, { key: "ArrowLeft" });
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Empty"));

    // Create tab 4 and enter a Loading directory -> Left switches out while loading!
    fireEvent.keyDown(screen.getByTestId("file-list-container"), { key: "+", altKey: true });
    const loadingTabItem = container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')[2]!;
    expect(loadingTabItem).toHaveAttribute("data-selected", "true");
    // Trigger initial load state on a cold tab by closing and re-creating on macOS Control+Plus
    setApplePlatformForTesting(true);
    fireEvent.keyDown(screen.getByTestId("file-list-container"), { key: "-", ctrlKey: true });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(3);
  });

  it("protects the last tab on keyboard close, resets incremental search on tab switch, and ignores non-list focus", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectory).mockResolvedValue({
      path: "",
      total: 2,
      items: [
        { name: "alpha.txt", path: "alpha.txt", type: FileType.FILE, size: 10, is_readable: true, is_hidden: false },
        { name: "bravo.txt", path: "bravo.txt", type: FileType.FILE, size: 10, is_readable: true, is_hidden: false },
      ],
    });

    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    const list = await screen.findByTestId("file-list-container");
    list.focus();

    // Attempting Alt+Minus on the only tab announces last-tab protection and leaves tab open
    fireEvent.keyDown(list, { key: "-", altKey: true });
    expect(await screen.findByText("Keep at least one tab open in each pane")).toBeInTheDocument();
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);

    // Focus in quick bar input must NOT trigger tab switching or creation
    const quickInput = screen.getByPlaceholderText("Quick navigation");
    await user.click(quickInput);
    fireEvent.keyDown(quickInput, { key: "ArrowLeft" });
    fireEvent.keyDown(quickInput, { key: "+", altKey: true });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);

    // Incremental search buffer resets when switching tabs
    act(() => {
      list.focus();
    });
    fireEvent.keyDown(list, { key: "+", altKey: true });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);
    await user.keyboard("b");
    await waitFor(() => expect(screen.getByTestId("status-bar-focused-file-name")).toHaveTextContent("bravo.txt"));

    // Switch to tab 1 and type "a" -> matches "alpha.txt" (not "ba")
    fireEvent.keyDown(screen.getByTestId("file-list-container"), { key: "ArrowLeft" });
    await user.keyboard("a");
    await waitFor(() => expect(screen.getByTestId("status-bar-focused-file-name")).toHaveTextContent("alpha.txt"));
  });

  it("supports Undo close tab via toast and command surface, reveals a hidden right pane, and expires with the notice", async () => {
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );

    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Documents&active=2");
    await waitFor(() => expect(container.querySelector('[data-pane-id="right"] [data-testid="file-list-container"]')).toBeTruthy());

    // Add a second tab in the right pane, then close it
    fireEvent.click(screen.getByTestId("pane-tab-add-right"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-right-"]')).toHaveLength(2);

    const rightList = container.querySelector<HTMLElement>('[data-pane-id="right"] [data-testid="file-list-container"]')!;
    rightList.focus();
    fireEvent.keyDown(rightList, { key: "-", altKey: true });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-right-"]')).toHaveLength(1);
    expect(await screen.findByText("Tab closed")).toBeInTheDocument();

    // Hide the right pane by toggling to single-pane mode, then click Undo -> reveals right pane and restores 2nd tab!
    fireEvent.click(screen.getByRole("button", { name: "Toggle dual-pane view" }));
    await waitFor(() => expect(container.querySelector('[data-pane-id="right"]')).toBeNull());

    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    await waitFor(() => expect(container.querySelector('[data-pane-id="right"]')).toBeTruthy());
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-right-"]')).toHaveLength(2);

    // Close again and verify record expires after NOTICE_DURATION_MS.information
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const reopenedRightList = container.querySelector<HTMLElement>('[data-pane-id="right"] [data-testid="file-list-container"]')!;
      reopenedRightList.focus();
      fireEvent.keyDown(reopenedRightList, { key: "-", altKey: true });
      expect(await screen.findByText("Tab closed")).toBeInTheDocument();

      await act(async () => {
        await vi.advanceTimersByTimeAsync(NOTICE_DURATION_MS.information + 200);
      });
      expect(screen.queryByText("Tab closed")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it("handles Back and Forward across directory navigation, replacement tab switches, and closed tabs without creating extra tabs", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );

    const { container, router } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findAllByText("Documents");

    // Navigate Tab 1 from "" -> "Documents" (PUSH Entry 1)
    await user.click(screen.getByRole("button", { name: /folder: documents/i }));
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Documents"));

    // Create Tab 2 at "Documents" (REPLACE Entry 1 with Tab 2)
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);

    // Press Back -> returns to Entry 0 ("") in Tab 1 while Tab 2 stays at "Documents"!
    await act(() => router.navigate(-1));
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent(/^\/browse\/smb\/test-server-1$/));
    expect(screen.getByTestId("pane-tab-item-left-0")).toHaveAttribute("data-selected", "true");
    expect(screen.getByRole("button", { name: "Documents — Test Server 1:/Documents" })).toBeInTheDocument();

    // Close Tab 2, then press Forward -> Entry 1 ("Documents") applies to Tab 1 without creating an extra tab!
    fireEvent.pointerEnter(screen.getByTestId("pane-tab-item-left-1"), { pointerType: "mouse" });
    fireEvent.click(screen.getByRole("button", { name: "Close Documents tab (Test Server 1:/Documents)" }), { detail: 1 });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);

    await act(() => router.navigate(1));
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Documents"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);
  });

  it("restores tabs across a matching reload and applies an explicit incoming link only to the selected tab", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );

    const firstMount = await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findAllByText("Documents");
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    await user.click(screen.getByRole("button", { name: /folder: documents/i }));
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Documents"));
    cleanup();

    // Matching reload of /browse/smb/test-server-1/Documents restores both tabs and selection
    const reloadMount = await renderBrowserAndFlush("/browse/smb/test-server-1/Documents");
    await waitFor(() => expect(reloadMount.container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2));
    expect(screen.getByTestId("pane-tab-item-left-1")).toHaveAttribute("data-selected", "true");
    cleanup();

    // Explicit incoming link to /browse/smb/test-server-2 updates selected tab while retaining background tab 1
    const explicitLinkMount = await renderBrowserAndFlush("/browse/smb/test-server-2");
    await waitFor(() => expect(explicitLinkMount.container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Test Server 1 — Test Server 1:/" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Test Server 2 — Test Server 2:/" })).toHaveAttribute("aria-pressed", "true");
    void firstMount;
  });

  it("warns when workspace storage is full and keeps the new tab open", async () => {
    await renderBrowserAndFlush("/browse/smb/test-server-1");
    const addTab = await screen.findByTestId("pane-tab-add-left");
    const { setItem } = localStorage;
    vi.spyOn(localStorage, "setItem").mockImplementation((key, value) => {
      if (key.startsWith(WORKSPACE_TAB_RECORD_PREFIX)) throw new DOMException("Full", "QuotaExceededError");
      setItem.call(localStorage, key, value);
    });

    fireEvent.click(addTab);
    expect(await screen.findByText(/could not save your latest folder tab changes/i)).toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-left-1")).toHaveAttribute("data-selected", "true");
  });

  it("reopens both panes from history without sessionStorage and never writes an early single-tab record", async () => {
    const url = "/browse/smb/test-server-1?p2=smb/test-server-2";
    await renderBrowserAndFlush(url);
    fireEvent.click(await screen.findByTestId("pane-tab-add-left"));
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    fireEvent.click(screen.getByTestId("pane-tab-add-right"));
    const [id] = readWorkspacePageIds();
    expect(id).not.toBeNull();
    const key = WORKSPACE_TAB_RECORD_PREFIX + id;
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).left.tabs).toHaveLength(3));
    cleanup();
    sessionStorage.clear();
    const writes = vi.spyOn(localStorage, "setItem");
    await renderBrowserAndFlush(url);
    await screen.findByTestId("pane-tab-item-left-2");
    expect(screen.getByTestId("pane-tab-item-right-1")).toBeInTheDocument();
    expect(readWorkspacePageIds()[0]).toBe(id);
    const saves = writes.mock.calls.filter(([savedKey]) => savedKey === key);
    expect(saves.length).toBeGreaterThan(0);
    expect(JSON.parse(saves[0]![1]).left.tabs).toHaveLength(3);
    writes.mockClear();
    fireEvent(window, new Event("pagehide"));
    expect(writes).toHaveBeenCalledWith(key, expect.stringContaining('"schemaVersion":2'));
  });

  it("keeps all tabs through session expiry and restores the closed workspace when /browse opens fresh", async () => {
    const url = "/browse/smb/test-server-1/Documents?p2=smb%2Ftest-server-2";
    await renderBrowserAndFlush(url);
    fireEvent.click(await screen.findByTestId("pane-tab-add-left"));
    fireEvent.click(screen.getByTestId("pane-tab-add-right"));
    const [id] = readWorkspacePageIds();
    const key = WORKSPACE_TAB_RECORD_PREFIX + id;
    await waitFor(() => expect(JSON.parse(localStorage.getItem(key)!).right.tabs).toHaveLength(2));
    await act(() => authSession.clear());
    cleanup();
    history.replaceState(null, "");
    expect(localStorage.getItem(key)).not.toBeNull();
    await act(() => authSession.setAuthenticated(createMockAuthToken({ access_token: "new-token", user_id: "user-1" }), false));
    await renderBrowserAndFlush(url);
    await screen.findByTestId("pane-tab-item-left-1");
    expect(screen.getByTestId("pane-tab-item-right-1")).toBeInTheDocument();
    cleanup();
    sessionStorage.clear();
    history.replaceState(null, "");
    await renderBrowserAndFlush("/browse");
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent(url));
    expect(screen.getByTestId("pane-tab-item-left-1")).toBeInTheDocument();
    expect(screen.getByTestId("pane-tab-item-right-1")).toBeInTheDocument();
  });

  it("keeps the root lock off the browse route and restores only the newly signed-in account's tabs", async () => {
    const browseUrl = "/browse/smb/test-server-1";
    const { default: App } = await import("../../App");
    const router = requireTestValue(appRouter.current);
    const otherScope = "user-2";
    const otherKey = `${WORKSPACE_TAB_RECORD_PREFIX}other-page`;
    const otherRecord: PersistedWorkspaceTabsRecord = {
      schemaVersion: 2,
      userScope: otherScope,
      updatedAt: Date.now(),
      paneMode: "single",
      activePaneId: "left",
      left: {
        selectedTabId: "other-root",
        tabs: [
          { id: "other-root", kind: "smb", targetId: "test-server-1", path: "" },
          { id: "other-folder", kind: "smb", targetId: "test-server-1", path: "Other workspace" },
        ],
      },
      right: null,
    };
    localStorage.setItem(otherKey, JSON.stringify(otherRecord));
    type Account = Awaited<ReturnType<typeof api.getCurrentAccount>>;
    const accountChecks: Array<ReturnType<typeof deferred<Account>>> = [];
    vi.spyOn(api, "getCurrentAccount").mockImplementation(() => {
      const check = deferred<Account>();
      accountChecks.push(check);
      return check.promise;
    });
    const finishAccountCheck = async (index: number) => {
      await waitFor(() => expect(accountChecks).toHaveLength(index + 1));
      await act(async () => {
        requireTestValue(accountChecks[index]).resolve({ password_change_required: false } as Account);
      });
    };
    try {
      await act(async () => {
        renderWithStyles(<App />);
      });
      await finishAccountCheck(0);
      fireEvent.click(await screen.findByTestId("pane-tab-add-left"));
      fireEvent.click(screen.getByTestId("pane-tab-add-left"));
      const originalKey = WORKSPACE_TAB_RECORD_PREFIX + readWorkspacePageIds()[0];
      const originalRecord = requireTestValue(localStorage.getItem(originalKey));
      expect(JSON.parse(originalRecord).left.tabs).toHaveLength(3);

      await act(() => router.navigate("/unknown-workspace-test-route"));
      expect(screen.queryByTestId("pane-tab-bar-left")).not.toBeInTheDocument();
      expect((await navigator.locks.query()).held).toContainEqual({ name: originalKey });
      await act(() => router.navigate(browseUrl));
      await finishAccountCheck(1);
      expect(await screen.findByTestId("pane-tab-item-left-2")).toBeInTheDocument();

      await act(() => authSession.setAuthenticated(createMockAuthToken({ user_id: otherScope }), false));
      expect(screen.queryByTestId("pane-tab-bar-left")).not.toBeInTheDocument();
      await finishAccountCheck(2);

      expect(await screen.findByRole("button", { name: /^Other workspace —/ })).toBeInTheDocument();
      expect(screen.queryByTestId("pane-tab-item-left-2")).not.toBeInTheDocument();
      expect((await navigator.locks.query()).held).toContainEqual({ name: otherKey });
      expect((await navigator.locks.query()).held).not.toContainEqual({ name: originalKey });
      expect(JSON.parse(requireTestValue(localStorage.getItem(originalKey))).left.tabs).toHaveLength(3);
      fireEvent.click(screen.getByTestId("pane-tab-add-left"));
      await waitFor(() => expect(JSON.parse(requireTestValue(localStorage.getItem(otherKey))).left.tabs).toHaveLength(3));
    } finally {
      cleanup();
    }
  });

  it("exposes all 5 tab actions in the keyboard command palette", async () => {
    const user = userEvent.setup();
    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findAllByText("Documents");

    // Open Command Palette (Ctrl+P) -> run "New Folder Tab"
    await user.keyboard("{Control>}p{/Control}");
    const cmdInput = await screen.findByPlaceholderText("Run a command");
    await user.type(cmdInput, "New Folder Tab");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2));

    // Close Folder Tab via Command Palette, then Undo Close Folder Tab via Command Palette
    await user.keyboard("{Control>}p{/Control}");
    const closeCmdInput = await screen.findByPlaceholderText("Run a command");
    await user.clear(closeCmdInput);
    await user.type(closeCmdInput, "Close Folder Tab");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1));

    await user.keyboard("{Control>}p{/Control}");
    const undoCmdInput = await screen.findByPlaceholderText("Run a command");
    await user.clear(undoCmdInput);
    await user.type(undoCmdInput, "Undo Close Folder Tab");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2));
  });

  it("closing a background tab in an inactive pane preserves the active pane and its focus", async () => {
    const { container } = await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2");
    const leftList = await waitFor(() =>
      requireTestValue(container.querySelector<HTMLElement>('[data-pane-id="left"] [data-testid="file-list-container"]'))
    );
    await waitFor(() => expect(container.querySelector('[data-pane-id="right"] [data-testid="file-list-container"]')).toBeTruthy());

    // Add a second tab in the right pane, then return focus/active state to the left pane
    fireEvent.click(screen.getByTestId("pane-tab-add-right"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-right-"]')).toHaveLength(2);

    fireEvent.click(leftList);
    leftList.focus();
    await waitFor(() => expect(localStorage.getItem("active-pane")).toBe("left"));

    // Hover and click close on the unselected tab (index 0) in the inactive right pane
    const rightBackgroundTab = screen.getByTestId("pane-tab-item-right-0");
    expect(rightBackgroundTab).toHaveAttribute("data-selected", "false");
    fireEvent.pointerEnter(rightBackgroundTab, { pointerType: "mouse" });
    const rightCloseButtons = within(screen.getByTestId("pane-tab-bar-right")).getAllByRole("button", { name: /Close .* tab/i });
    fireEvent.click(rightCloseButtons[0]!, { detail: 1 });

    expect(container.querySelectorAll('[data-testid^="pane-tab-item-right-"]')).toHaveLength(1);
    expect(localStorage.getItem("active-pane")).toBe("left");
    expect(leftList).toHaveFocus();
  });

  it("preserves archive routes, breadcrumbs, selection, pagination, close, and Undo across physical and archive tabs in both panes", async () => {
    const user = userEvent.setup();
    const originalUseVirtualizer = reactVirtual.useVirtualizer;
    let triggerLeftVirtualizerScroll: (() => void) | null = null;
    vi.spyOn(reactVirtual, "useVirtualizer").mockImplementation((options) => {
      const instance = originalUseVirtualizer(options);
      const enriched = {
        ...instance,
        scrollRect: { width: 600, height: 400 },
        scrollDirection: "forward" as const,
      };
      if (options.enabled !== false && options.count > 0 && !triggerLeftVirtualizerScroll) {
        triggerLeftVirtualizerScroll = () => {
          options.onChange?.(enriched as never, false);
        };
      }
      return instance;
    });
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") => {
      if (path === "Archives") {
        return {
          path: "Archives",
          total: 1,
          items: [
            { name: "backup.zip", path: "Archives/backup.zip", type: FileType.FILE, size: 1024, is_readable: true, is_hidden: false },
          ],
        };
      }
      if (path === "Documents") {
        return mockNestedDirectory;
      }
      return mockDirectoryListing;
    });
    vi.mocked(api.getFileInfo).mockImplementation(
      async (_conn, path) => ({ type: path.endsWith(".zip") ? FileType.FILE : FileType.DIRECTORY }) as never
    );
    vi.mocked(api.listArchiveDirectory).mockImplementation(async (_conn, archivePath, virtualPath = "", options) => {
      if (virtualPath === "docs") {
        const isPage2 = options?.cursor === "cursor-2";
        return {
          archive: { path: archivePath, size: 1024 },
          path: "docs",
          items: isPage2
            ? [{ name: "page2-spec.txt", path: "docs/page2-spec.txt", type: FileType.FILE, state: "readable", is_hidden: false }]
            : [{ name: "page1-readme.txt", path: "docs/page1-readme.txt", type: FileType.FILE, state: "readable", is_hidden: false }],
          next_cursor: isPage2 ? undefined : "cursor-2",
          total: 2,
          page_size: 1,
        };
      }
      if (virtualPath === "images") {
        return {
          archive: { path: archivePath, size: 1024 },
          path: "images",
          items: [{ name: "banner.png", path: "images/banner.png", type: FileType.FILE, state: "readable", is_hidden: false }],
          total: 1,
          page_size: 100,
        };
      }
      return {
        archive: { path: archivePath, size: 1024 },
        path: "",
        items: [
          { name: "docs", path: "docs", type: FileType.DIRECTORY, state: "readable", is_hidden: false },
          { name: "images", path: "images", type: FileType.DIRECTORY, state: "readable", is_hidden: false },
        ],
        total: 2,
        page_size: 100,
      };
    });

    const { container, router } = await renderBrowserAndFlush(
      "/browse/smb/test-server-1/Archives/backup.zip/docs?p2=smb/test-server-2/Archives/backup.zip/docs"
    );

    const leftPaneEl = () => requireTestValue(container.querySelector<HTMLElement>('[data-pane-id="left"]'));
    const rightPaneEl = () => requireTestValue(container.querySelector<HTMLElement>('[data-pane-id="right"]'));

    // Wait for initial archive "docs" listing in both panes
    await waitFor(() => {
      expect(within(leftPaneEl()).getByText("page1-readme.txt")).toBeInTheDocument();
      expect(within(rightPaneEl()).getByText("page1-readme.txt")).toBeInTheDocument();
    });

    // Select page1-readme.txt in left archive tab 0 and load page 2 ("page2-spec.txt") via next_cursor
    const leftCheckbox = within(leftPaneEl()).getByRole("checkbox", { name: /select: page1-readme\.txt/i });
    await user.click(leftCheckbox);
    expect(leftCheckbox).toBeChecked();
    await act(async () => {
      triggerLeftVirtualizerScroll?.();
    });
    await waitFor(() => expect(within(leftPaneEl()).getByText("page2-spec.txt")).toBeInTheDocument());

    // Create Left Tab 2 from archive "docs", navigate it out to physical "Documents", then create Left Tab 3 in archive "images"
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    await act(() => router.navigate("/browse/smb/test-server-1/Documents?p2=smb/test-server-2/Archives/backup.zip/docs"));
    await waitFor(() => expect(within(leftPaneEl()).getAllByText("Personal").length).toBeGreaterThan(0));

    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    await act(() => router.navigate("/browse/smb/test-server-1/Archives/backup.zip/images?p2=smb/test-server-2/Archives/backup.zip/docs"));
    await waitFor(() => expect(within(leftPaneEl()).getByText("banner.png")).toBeInTheDocument());

    // Switch Left: archive ("images") -> physical ("Documents") -> archive ("docs") -> archive ("images")
    fireEvent.click(within(screen.getByTestId("pane-tab-bar-left")).getByRole("button", { name: /^Documents —/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Documents"));

    fireEvent.click(within(screen.getByTestId("pane-tab-bar-left")).getByRole("button", { name: /^docs —/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Archives/backup.zip/docs"));
    // Saved archive location, breadcrumbs, selection, AND page-2 pagination ("page2-spec.txt") all survive!
    expect(within(leftPaneEl()).getByText("backup.zip")).toBeInTheDocument();
    expect(within(leftPaneEl()).getByRole("checkbox", { name: /select: page1-readme\.txt/i })).toBeChecked();
    expect(within(leftPaneEl()).getByText("page2-spec.txt")).toBeInTheDocument();

    // Switch between two archive folders ("docs" -> "images")
    fireEvent.click(within(screen.getByTestId("pane-tab-bar-left")).getByRole("button", { name: /^images —/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Archives/backup.zip/images"));
    expect(within(leftPaneEl()).getByText("banner.png")).toBeInTheDocument();

    // Also test right pane: physical <-> archive <-> archive + close + Undo!
    fireEvent.click(screen.getByTestId("pane-tab-add-right"));
    await act(() => router.navigate("/browse/smb/test-server-1/Archives/backup.zip/images?p2=smb/test-server-2/Documents&active=2"));
    await waitFor(() => expect(within(rightPaneEl()).getAllByText("Personal").length).toBeGreaterThan(0));

    // Switch right pane back from physical "Documents" to archive "docs"
    fireEvent.click(within(screen.getByTestId("pane-tab-bar-right")).getByRole("button", { name: /^docs —/i }));
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("p2")).toBe("smb/test-server-2/Archives/backup.zip/docs")
    );
    expect(within(rightPaneEl()).getByText("page1-readme.txt")).toBeInTheDocument();

    // Close right archive "docs" tab -> falls back to physical "Documents", then Undo restores archive "docs" route & listing!
    const rightList = requireTestValue(rightPaneEl().querySelector<HTMLElement>('[data-testid="file-list-container"]'));
    rightList.focus();
    fireEvent.keyDown(rightList, { key: "-", altKey: true });
    await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("p2")).toBe("smb/test-server-2/Documents"));

    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() =>
      expect(new URLSearchParams(router.state.location.search).get("p2")).toBe("smb/test-server-2/Archives/backup.zip/docs")
    );
    expect(within(rightPaneEl()).getByText("page1-readme.txt")).toBeInTheDocument();
  });

  it("updates router history metadata on same-URL replacement so Back selects the duplicate tab while preserving state, query, and hash", async () => {
    const user = userEvent.setup();
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") => {
      if (path === "Documents") {
        return {
          path: "Documents",
          total: 2,
          items: [
            { name: "Sub", path: "Documents/Sub", type: FileType.DIRECTORY, size: 0, is_readable: true, is_hidden: false },
            { name: "doc.txt", path: "Documents/doc.txt", type: FileType.FILE, size: 12, is_readable: true, is_hidden: false },
          ],
        };
      }
      if (path === "Documents/Sub") {
        return {
          path: "Documents/Sub",
          total: 1,
          items: [{ name: "deep.txt", path: "Documents/Sub/deep.txt", type: FileType.FILE, size: 5, is_readable: true, is_hidden: false }],
        };
      }
      return mockDirectoryListing;
    });

    const { container, router } = await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findAllByText("Documents");

    // Push Entry 1 into Documents with caller state, extra query parameter, and hash
    await act(() =>
      router.navigate("/browse/smb/test-server-1/Documents?keep=1#details", {
        state: { callerToken: "preserve-me" },
      })
    );
    await waitFor(() => expect(screen.getByText("doc.txt")).toBeInTheDocument());
    const tabAId = screen.getByTestId("pane-tab-item-left-0").getAttribute("data-tab-id")!;
    const historyLengthAtDocuments = router.state.historyAction ? (router as unknown as { state: { initialized: boolean } }) : null;
    void historyLengthAtDocuments;

    // Select doc.txt in Tab A so we can verify Tab A's state remains untouched
    await user.click(screen.getByRole("checkbox", { name: /select: doc\.txt/i }));

    // Create duplicate Tab B at the SAME URL (/browse/smb/test-server-1/Documents?keep=1#details)
    const indexBeforeCreate = router as unknown as { basename?: string } & { state: unknown };
    void indexBeforeCreate;
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);
    const tabBId = screen.getByTestId("pane-tab-item-left-1").getAttribute("data-tab-id")!;
    expect(tabBId).not.toBe(tabAId);

    // Router state MUST be updated in place with Tab B's ID while preserving callerToken, query, and hash!
    await waitFor(() => {
      expect(readPaneTabHistoryState(router.state.location.state)).toEqual({ leftTabId: tabBId, rightTabId: null });
    });
    expect((router.state.location.state as Record<string, unknown>)["callerToken"]).toBe("preserve-me");
    expect(router.state.location.search).toBe("?keep=1");
    expect(router.state.location.hash).toBe("#details");
    expect(router.state.historyAction).toBe("REPLACE");

    // Navigate Tab B deeper into Documents/Sub (PUSH)
    await user.click(screen.getByRole("button", { name: /folder: sub/i }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Documents/Sub"));
    expect(router.state.historyAction).toBe("PUSH");

    // Press Back -> MUST keep Tab B selected at Documents (NOT Tab A!), preserving both tabs' locations
    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Documents"));
    expect(screen.getByTestId("pane-tab-item-left-1")).toHaveAttribute("data-selected", "true");
    expect(screen.getByTestId("pane-tab-item-left-0")).toHaveAttribute("data-selected", "false");
    expect((router.state.location.state as Record<string, unknown>)["callerToken"]).toBe("preserve-me");

    // Press Forward -> returns Tab B to Documents/Sub
    await act(() => router.navigate(1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Documents/Sub"));
    expect(screen.getByTestId("pane-tab-item-left-1")).toHaveAttribute("data-selected", "true");

    // Close Tab B at Entry 2 (replaces Entry 2 with Documents), then press Back -> Entry 1 (which recorded closed tabBId)
    // falls back cleanly to remaining Tab A without creating a duplicate tab, and another Back returns to Entry 0 (root)!
    const list = screen.getByTestId("file-list-container");
    list.focus();
    fireEvent.keyDown(list, { key: "-", altKey: true });
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);
    expect(screen.getByRole("checkbox", { name: /select: doc\.txt/i })).toBeChecked();

    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1/Documents"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);

    await act(() => router.navigate(-1));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/smb/test-server-1"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(1);
  });

  it("restores multiple anonymous tabs after reload when authentication is disabled and startup refresh returns 401", async () => {
    const user = userEvent.setup();
    authSession.clear();
    vi.spyOn(authConfigModule, "isAuthRequired").mockResolvedValue(false);
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );

    await renderBrowserAndFlush("/browse/smb/test-server-1");
    await screen.findAllByText("Documents");

    // Open 3 tabs in anonymous mode (Tab 1: root, Tab 2: root, Tab 3: Documents)
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    await user.click(screen.getByRole("button", { name: /folder: documents/i }));
    await waitFor(() => expect(screen.getByTestId("router-location")).toHaveTextContent("/browse/smb/test-server-1/Documents"));
    cleanup();

    // Simulate reload startup where authSession.requestRefresh() fails with 401 BEFORE BrowserWorkspace mounts
    const refreshClient = (authSession as unknown as { refreshClient: { post: ReturnType<typeof vi.fn> } }).refreshClient;
    vi.spyOn(refreshClient, "post").mockRejectedValueOnce({
      isAxiosError: true,
      response: { status: 401, data: {} },
    });
    await expect(authSession.requestRefresh()).rejects.toThrow();

    const reloaded = renderBrowser("/browse/smb/test-server-1/Documents");
    await waitFor(() => expect(reloaded.container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(3));
    expect(screen.getByTestId("pane-tab-item-left-2")).toHaveAttribute("data-selected", "true");
  });

  it("supports local-drive tabs at parity with SMB for create, switch, close, Undo, path normalization, and session reload", async () => {
    const user = userEvent.setup();
    mockUseCompanion.mockReturnValue({
      status: "paired",
      drives: [{ id: "c", name: "Drive C", drive_type: "fixed" }],
      initiatePairing: vi.fn(),
      confirmPairing: vi.fn(),
      refresh: vi.fn(),
      loading: false,
    });

    vi.mocked(api.listDirectory).mockImplementation(async (connId, path = "") => {
      if (connId === "local-drive:c" && path === "") {
        return {
          path: "",
          total: 2,
          items: [
            { name: "Users", path: "Users", type: FileType.DIRECTORY, size: 0, is_readable: true, is_hidden: false },
            { name: "Projects", path: "Projects", type: FileType.DIRECTORY, size: 0, is_readable: true, is_hidden: false },
          ],
        };
      }
      if (connId === "local-drive:c" && path === "Users") {
        return {
          path: "Users",
          total: 1,
          items: [{ name: "alice.txt", path: "Users/alice.txt", type: FileType.FILE, size: 64, is_readable: true, is_hidden: false }],
        };
      }
      return mockDirectoryListing;
    });

    const { container, router } = await renderBrowserAndFlush("/browse/local/c");
    await waitFor(() => expect(screen.getByText("Users")).toBeInTheDocument());
    expect(screen.getByRole("button", { name: "Drive C — Drive C:/" })).toHaveAttribute("aria-pressed", "true");

    // Add second local-drive tab and navigate it via Windows backslash path -> normalizes to Users
    fireEvent.click(screen.getByTestId("pane-tab-add-left"));
    await act(() => router.navigate("/browse/local/c/c:%5CUsers"));
    await waitFor(() => expect(screen.getAllByText("alice.txt").length).toBeGreaterThan(0));
    await user.click(screen.getByRole("checkbox", { name: /select: alice\.txt/i }));

    // Switch back to Drive C root tab, then back to Users tab -> selection and local-drive URL preserved
    fireEvent.click(screen.getByRole("button", { name: "Drive C — Drive C:/" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/local/c"));
    fireEvent.click(screen.getByRole("button", { name: "Users — Drive C:/Users" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/local/c/Users"));
    expect(screen.getByRole("checkbox", { name: /select: alice\.txt/i })).toBeChecked();

    // Close and Undo local-drive tab
    const list = screen.getByTestId("file-list-container");
    list.focus();
    fireEvent.keyDown(list, { key: "-", altKey: true });
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/local/c"));
    fireEvent.click(await screen.findByRole("button", { name: "Undo" }));
    await waitFor(() => expect(router.state.location.pathname).toBe("/browse/local/c/Users"));
    expect(container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2);
    cleanup();

    // Reload local-drive workspace -> both local-drive tabs restore cleanly
    const reloaded = await renderBrowserAndFlush("/browse/local/c/Users");
    await waitFor(() => expect(reloaded.container.querySelectorAll('[data-testid^="pane-tab-item-left-"]')).toHaveLength(2));
    expect(screen.getByRole("button", { name: "Drive C — Drive C:/" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Users — Drive C:/Users" })).toHaveAttribute("aria-pressed", "true");
  });

  it("keeps in-flight upload operations bound to the captured destination tab even if tabs switch or close mid-upload", async () => {
    const pickerClick = vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
      if (this.type !== "file") return;
      Object.defineProperty(this, "files", { value: [new File(["hello"], "uploaded.txt")], configurable: true });
      this.dispatchEvent(new Event("change", { bubbles: true }));
    });
    const pendingUpload = deferred<{
      status: "completed";
      replaced: boolean;
      effects: { source: "unchanged"; destination: "mutated" };
    }>();
    vi.mocked(api.publishBrowserFile).mockImplementation(() => pendingUpload.promise as never);

    let picturesVersion = 1;
    vi.mocked(api.listDirectory).mockImplementation(async (connId, path = "") => {
      if (connId === "conn-2" && path === "Pictures") {
        return {
          path: "Pictures",
          total: picturesVersion === 1 ? 0 : 1,
          items:
            picturesVersion === 1
              ? []
              : [
                  {
                    name: "uploaded.txt",
                    path: "Pictures/uploaded.txt",
                    type: FileType.FILE,
                    size: 5,
                    is_readable: true,
                    is_hidden: false,
                  },
                ],
        };
      }
      if (connId === "conn-2" && path === "Exports") {
        return {
          path: "Exports",
          total: 1,
          items: [{ name: "keep.csv", path: "Exports/keep.csv", type: FileType.FILE, size: 32, is_readable: true, is_hidden: false }],
        };
      }
      return mockDirectoryListing;
    });

    try {
      const { container, router } = await renderBrowserAndFlush("/browse/smb/test-server-1?p2=smb/test-server-2/Pictures&active=2");
      const rightPaneEl = () => requireTestValue(container.querySelector<HTMLElement>('[data-pane-id="right"]'));
      await waitFor(() => expect(rightPaneEl().querySelector('[data-testid="file-list-container"]')).toBeTruthy());

      // Add Right Tab 2 ("Exports"), then switch back to Right Tab 1 ("Pictures") as active upload target
      fireEvent.click(screen.getByTestId("pane-tab-add-right"));
      await act(() => router.navigate("/browse/smb/test-server-1?p2=smb/test-server-2/Exports&active=2"));
      await waitFor(() => expect(within(rightPaneEl()).getByText("keep.csv")).toBeInTheDocument());

      fireEvent.click(within(screen.getByTestId("pane-tab-bar-right")).getByRole("button", { name: /^Pictures —/i }));
      await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("p2")).toBe("smb/test-server-2/Pictures"));

      // Start an async Upload while Right Tab 1 ("Pictures") is active
      fireEvent.click(screen.getByRole("button", { name: "Upload" }));
      const filesMenuItem = await screen.findByRole("menuitem", { name: "Files" });
      await act(async () => {
        fireEvent.click(filesMenuItem);
      });
      await waitFor(() => expect(api.publishBrowserFile).toHaveBeenCalledTimes(1));

      // WHILE UPLOAD IS IN FLIGHT: switch Right Pane to Tab 2 ("Exports") and add+close a tab in Left Pane!
      fireEvent.click(within(screen.getByTestId("pane-tab-bar-right")).getByRole("button", { name: /^Exports —/i }));
      await waitFor(() => expect(new URLSearchParams(router.state.location.search).get("p2")).toBe("smb/test-server-2/Exports"));
      fireEvent.click(screen.getByTestId("pane-tab-add-left"));
      fireEvent.pointerEnter(screen.getByTestId("pane-tab-item-left-1"), { pointerType: "mouse" });
      fireEvent.click(within(screen.getByTestId("pane-tab-bar-left")).getAllByRole("button", { name: /Close Test Server 1 tab/i })[1]!, {
        detail: 1,
      });

      // Dismiss the "Tab closed" toast so the upload completion notice is visible next
      fireEvent.click(await screen.findByRole("button", { name: "Close" }));

      const exportsLoadsBeforeComplete = vi
        .mocked(api.listDirectory)
        .mock.calls.filter(([c, p]) => c === "conn-2" && p === "Exports").length;

      // Complete the upload -> captured destination ("Pictures") was targeted, NOT "Exports"!
      picturesVersion = 2;
      await act(async () => {
        pendingUpload.resolve({
          status: "completed",
          replaced: false,
          effects: { source: "unchanged", destination: "mutated" },
        });
      });
      await screen.findByText(/Uploaded 1 file/i);

      expect(api.publishBrowserFile).toHaveBeenCalledWith(
        expect.any(File),
        "conn-2",
        "Pictures/uploaded.txt",
        expect.any(String),
        expect.any(Object)
      );
      const exportsLoadsAfterComplete = vi
        .mocked(api.listDirectory)
        .mock.calls.filter(([c, p]) => c === "conn-2" && p === "Exports").length;
      expect(exportsLoadsAfterComplete).toBe(exportsLoadsBeforeComplete);

      // Switching Right Pane back to Tab 1 ("Pictures") revalidates the invalidated tab and displays "uploaded.txt"!
      fireEvent.click(within(screen.getByTestId("pane-tab-bar-right")).getByRole("button", { name: /^Pictures —/i }));
      await waitFor(() => expect(within(rightPaneEl()).getAllByText("uploaded.txt").length).toBeGreaterThan(0));
    } finally {
      pickerClick.mockRestore();
    }
  });
});
