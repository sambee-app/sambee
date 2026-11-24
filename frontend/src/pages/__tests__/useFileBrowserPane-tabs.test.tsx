import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import type { FilesystemSearchRecord } from "../../services/filesystemSearchContract";
import { resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";
import { createMockAuthToken } from "../../test/fixtures/users";
import { type ApiMock, createStorageBackedTestContentProviderRegistry, setupSuccessfulApiMocks } from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import { FileType } from "../../types";
import type { ContentProviderRegistry } from "../FileBrowser/contentProviders";
import type { UseFileBrowserPaneConfig } from "../FileBrowser/types";
import { DIRECTORY_CACHE_TTL_MS, useFileBrowserPane as useFileBrowserPaneImplementation } from "../FileBrowser/useFileBrowserPane";
import { getPreferredViewerId, setPreferredViewerId } from "../FileBrowser/viewerPreferences";
import { mockConnections, mockDirectoryListing, mockNestedDirectory } from "./FileBrowser.test.utils";

vi.mock("../../services/api");
vi.mock("../FileBrowser/viewerPreferences", () => ({
  getPreferredViewerId: vi.fn(),
  setPreferredViewerId: vi.fn(),
}));

const paneContentProviders = createStorageBackedTestContentProviderRegistry(mockConnections);

function useFileBrowserPane(config: Omit<UseFileBrowserPaneConfig, "contentProviders"> & { contentProviders?: ContentProviderRegistry }) {
  const { contentProviders = paneContentProviders, ...rest } = config;
  return useFileBrowserPaneImplementation({ ...rest, contentProviders });
}

function deferred<T>() {
  let resolve: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve: (value: T) => resolve(value) };
}

describe("useFileBrowserPane — Multi-Tab Sessions", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <SambeeThemeProvider>{children}</SambeeThemeProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentUserSettingsStoreForTests();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    setupSuccessfulApiMocks(api as unknown as ApiMock);
    vi.mocked(getPreferredViewerId).mockResolvedValue(null);
    vi.mocked(setPreferredViewerId).mockResolvedValue();
  });

  it("keeps duplicate archive member identities across batches, tabs, and close", async () => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    let signal: AbortSignal | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, requestSignal, onRecord) => {
      signal = requestSignal;
      publish = onRecord;
      return new Promise(() => {});
    });
    vi.mocked(getPreferredViewerId).mockResolvedValue("text");
    const onOpenViewer = vi.fn();
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections, onOpenViewer }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    const browseId = result.current.selectedTabId;
    act(() =>
      result.current.startFilesystemSearch?.("same", {
        case_sensitive: false,
        folder_depth: "recursive",
        item_type: "all",
        search_archives: true,
      })
    );
    const searchId = result.current.selectedTabId;
    await waitFor(() => expect(publish).toBeDefined());
    const member = (archive: string) => ({
      entry: { name: "same.txt", path: "dir/same.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
      target: { kind: "archive" as const, archive_path: archive, member_path: "dir/same.txt" },
      archive_state: "readable" as const,
    });
    await act(async () => {
      await publish?.({ type: "batch", results: [member("a.zip"), member("b.zip")] });
    });
    expect(result.current.sortedFiles).toHaveLength(2);
    act(() => {
      result.current.selectItem(requireTestValue(result.current.sortedFiles[1]), 1);
    });
    const selection = [...result.current.selectedFiles];
    expect(selection[0]).toContain("b.zip");
    act(() => result.current.selectTab(browseId));
    await act(async () => {
      await publish?.({ type: "batch", results: [member("c.zip")] });
    });
    expect(result.current.sortedFiles).toHaveLength(3);
    act(() => result.current.selectTab(searchId));
    expect(result.current.sortedFiles).toHaveLength(3);
    expect([...result.current.selectedFiles]).toEqual(selection);
    act(() => result.current.handleOpenFileForFile(requireTestValue(result.current.sortedFiles[1]), 1));
    await waitFor(() =>
      expect(onOpenViewer).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "dir/same.txt",
          virtualSource: expect.objectContaining({
            location: expect.objectContaining({ source: expect.objectContaining({ path: "b.zip" }) }),
          }),
        })
      )
    );
    act(() => result.current.closeTab(searchId));
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      await publish?.({ type: "batch", results: [member("late.zip")] });
    });
    expect(result.current.isSearchTab).toBe(false);
    expect(result.current.sortedFiles.some((file) => file.name === "same.txt")).toBe(false);
  });

  it("opens a result folder in a separate browse tab without rerunning the scan", async () => {
    let publish: ((record: FilesystemSearchRecord) => void | Promise<void>) | undefined;
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, _signal, onRecord) => {
      publish = onRecord;
      return new Promise(() => {});
    });
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    act(() =>
      result.current.startFilesystemSearch?.("docs", {
        case_sensitive: false,
        folder_depth: "recursive",
        item_type: "all",
        search_archives: false,
      })
    );
    const searchId = result.current.selectedTabId;
    await waitFor(() => expect(publish).toBeDefined());
    await act(async () => {
      await publish?.({
        type: "batch",
        results: [
          {
            entry: { name: "Documents", path: "Documents", type: FileType.DIRECTORY, is_readable: true, is_hidden: false },
            target: { kind: "physical", path: "Documents" },
          },
        ],
      });
    });
    act(() => result.current.handleFileClick(requireTestValue(result.current.sortedFiles[0]), 0));
    await waitFor(() => expect(result.current.currentPath).toBe("Documents"));
    expect(result.current.isSearchTab).toBe(false);
    expect(result.current.selectedTabId).not.toBe(searchId);
    act(() => result.current.selectTab(searchId));
    expect(result.current.sortedFiles[0]?.name).toBe("Documents");
    expect(api.startFilesystemSearch).toHaveBeenCalledOnce();
  });

  it("starts independent runs for the same query and aborts both when the pane unmounts", async () => {
    const signals: AbortSignal[] = [];
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { result, unmount } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    const options = { case_sensitive: false, folder_depth: "recursive" as const, item_type: "all" as const, search_archives: false };
    act(() => result.current.startFilesystemSearch?.("report", options));
    const first = result.current.selectedTabId;
    act(() => result.current.startFilesystemSearch?.("report", options));
    expect(result.current.selectedTabId).not.toBe(first);
    await waitFor(() => expect(signals).toHaveLength(2));
    expect(api.startFilesystemSearch).toHaveBeenCalledTimes(2);
    expect(signals.every((signal) => !signal.aborted)).toBe(true);
    unmount();
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each([
    ["sign-out", () => authSession.clear()],
    ["a new sign-in", () => authSession.notifyNewLogin()],
  ])("closes active and background searches on %s and keeps the last folder tab", async (_event, clearAuth) => {
    const signals: AbortSignal[] = [];
    vi.mocked(api.startFilesystemSearch).mockImplementation((_request, signal) => {
      signals.push(signal);
      return new Promise(() => {});
    });
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    const folderId = result.current.selectedTabId;
    const options = { case_sensitive: false, folder_depth: "recursive" as const, item_type: "all" as const, search_archives: false };
    await act(async () => {
      result.current.startFilesystemSearch?.("report", options);
      result.current.startFilesystemSearch?.("notes", options);
    });
    await waitFor(() => expect(signals).toHaveLength(2));
    act(() => {
      expect(result.current.closeTab(folderId).closed).toBe(false);
    });
    expect(result.current.tabs).toHaveLength(3);

    await act(async () => clearAuth());

    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([folderId]);
    expect(result.current.selectedTabId).toBe(folderId);
    expect(result.current.isSearchTab).toBe(false);
    expect(result.current.sortedFiles).toHaveLength(3);
  });

  it("uses the current ZIP as the root of a search", async () => {
    vi.mocked(api.startFilesystemSearch).mockImplementation(() => new Promise(() => {}));
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    act(() => result.current.openArchive("bundle.zip"));
    await waitFor(() => expect(result.current.archiveLocation?.archivePath).toBe("bundle.zip"));
    act(() =>
      result.current.startFilesystemSearch?.("file", {
        case_sensitive: false,
        folder_depth: "recursive",
        item_type: "all",
        search_archives: false,
      })
    );
    await waitFor(() =>
      expect(api.startFilesystemSearch).toHaveBeenCalledWith(
        expect.objectContaining({ root: { kind: "archive", path: "bundle.zip", member_path: "" } }),
        expect.any(AbortSignal),
        expect.any(Function)
      )
    );
  });

  it("preserves independent selection, focus, scroll, sort, and history across duplicate locations without refetching fresh data", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    const scrollEl = document.createElement("div");
    Object.defineProperty(scrollEl, "scrollTop", { value: 0, writable: true });
    result.current.parentRef.current = scrollEl;

    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    expect(api.listDirectory).toHaveBeenCalledTimes(1);

    const firstTabId = result.current.selectedTabId;
    act(() => {
      result.current.setSortDirection("desc");
      result.current.selectItem(requireTestValue(result.current.sortedFiles[1]), 1);
      scrollEl.scrollTop = 180;
    });

    let secondTabId: string | null = null;
    act(() => {
      secondTabId = result.current.createTab();
    });

    expect(secondTabId).toBeTruthy();
    expect(result.current.tabs.map((tab) => tab.id)).toEqual([firstTabId, secondTabId]);
    expect(result.current.selectedTabId).toBe(secondTabId);
    // Reuses fresh immutable listing data without another network request
    expect(api.listDirectory).toHaveBeenCalledTimes(1);
    // Copies sort settings, starts at top with empty selection
    expect(result.current.sortDirection).toBe("desc");
    expect(result.current.selectedFiles.size).toBe(0);
    expect(result.current.focusedIndex).toBe(0);
    expect(scrollEl.scrollTop).toBe(0);

    // Select a different item and scroll position in the second tab at the exact same location
    act(() => {
      result.current.setSortDirection("asc");
      result.current.selectItem(requireTestValue(result.current.sortedFiles[2]), 2);
      scrollEl.scrollTop = 60;
    });
    const secondSelection = [...result.current.selectedFiles];

    // Switch back to the first tab
    act(() => {
      result.current.selectTab(firstTabId);
    });
    expect(api.listDirectory).toHaveBeenCalledTimes(1);
    expect(result.current.sortDirection).toBe("desc");
    expect(scrollEl.scrollTop).toBe(180);
    expect(result.current.selectedFiles.size).toBe(1);
    expect([...result.current.selectedFiles]).not.toEqual(secondSelection);

    // Switch back to the second tab again
    act(() => {
      result.current.selectTab(requireTestValue(secondTabId));
    });
    expect(result.current.sortDirection).toBe("asc");
    expect(scrollEl.scrollTop).toBe(60);
    expect([...result.current.selectedFiles]).toEqual(secondSelection);
  });

  it("revalidates a hidden tab whose physical location was not monitored while hidden and does not reset its timestamp", async () => {
    vi.mocked(api.listDirectory).mockImplementation(async (_conn, path = "") =>
      path === "Documents" ? mockNestedDirectory : mockDirectoryListing
    );

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));
    const rootTabId = result.current.selectedTabId;

    let docsTabId = "";
    act(() => {
      docsTabId = requireTestValue(result.current.createTab());
    });
    act(() => {
      result.current.navigateToPath("Documents");
    });
    await waitFor(() => expect(result.current.currentPath).toBe("Documents"));
    expect(result.current.selectedTabId).toBe(docsTabId);

    const updatedRootListing = {
      ...mockDirectoryListing,
      items: [
        ...mockDirectoryListing.items,
        {
          name: "added-while-hidden.txt",
          path: "added-while-hidden.txt",
          type: FileType.FILE,
          size: 42,
          is_readable: true,
          is_hidden: false,
        },
      ],
      total: mockDirectoryListing.total + 1,
    };
    const revalidateDeferred = deferred<typeof updatedRootListing>();
    vi.mocked(api.listDirectory).mockReturnValueOnce(revalidateDeferred.promise);

    // Selecting rootTabId immediately shows retained rows while starting background revalidation
    act(() => {
      result.current.selectTab(rootTabId);
    });
    expect(result.current.currentPath).toBe("");
    expect(result.current.loading).toBe(false);
    expect(result.current.files).toHaveLength(mockDirectoryListing.items.length);
    expect(result.current.navigationPending).toBe(true);

    await act(async () => {
      revalidateDeferred.resolve(updatedRootListing);
    });
    expect(result.current.files.some((file) => file.name === "added-while-hidden.txt")).toBe(true);
    expect(result.current.navigationPending).toBe(false);
  });

  it("preserves archive pagination per tab and resets incomplete cursors on listing eviction", async () => {
    vi.mocked(api.listArchiveDirectory).mockImplementation(async (_conn, _archivePath, _virtualPath = "", options) => {
      if (options?.cursor === "page-2") {
        return {
          archive: { path: "bundle.zip", size: 100 },
          path: "",
          items: [{ name: "two.txt", path: "two.txt", type: FileType.FILE, state: "readable", is_hidden: false }],
          next_cursor: "page-3",
          page_size: 1,
        };
      }
      return {
        archive: { path: "bundle.zip", size: 100 },
        path: "",
        items: [{ name: "one.txt", path: "one.txt", type: FileType.FILE, state: "readable", is_hidden: false }],
        next_cursor: "page-2",
        page_size: 1,
      };
    });

    const { result } = renderHook(
      () => useFileBrowserPane({ rowHeight: 40, connections: mockConnections, maxInactiveRetainedTabListings: 1 }),
      { wrapper }
    );
    act(() => {
      result.current.applyLocation("conn-1", "");
      result.current.openArchive("bundle.zip");
    });
    await waitFor(() => expect(result.current.files.map((f) => f.name)).toEqual(["one.txt"]));
    expect(result.current.archiveHasMore).toBe(true);

    act(() => {
      result.current.loadMoreArchive();
    });
    await waitFor(() => expect(result.current.files.map((f) => f.name)).toEqual(["one.txt", "two.txt"]));
    expect(result.current.archiveHasMore).toBe(true);
    const archiveTabId = result.current.selectedTabId;

    // Create second tab (archiveTabId stays within maxInactiveRetainedTabListings = 1)
    let secondTabId = "";
    act(() => {
      secondTabId = requireTestValue(result.current.createTab());
      result.current.closeArchive();
    });
    await waitFor(() => expect(result.current.archiveLocation).toBeNull());

    // Switch back to archiveTabId -> retains both loaded pages and archiveHasMore without reloading page 1
    vi.mocked(api.listArchiveDirectory).mockClear();
    act(() => {
      result.current.selectTab(archiveTabId);
    });
    expect(result.current.files.map((f) => f.name)).toEqual(["one.txt", "two.txt"]);
    expect(result.current.archiveHasMore).toBe(true);
    expect(api.listArchiveDirectory).not.toHaveBeenCalled();

    // Now create a third tab so archiveTabId overflows maxInactiveRetainedTabListings = 1 and gets evicted
    act(() => {
      result.current.selectTab(secondTabId);
    });
    act(() => {
      result.current.createTab();
    });

    // Reactivating the evicted archive tab reloads cleanly from page 1 with archiveHasMore = true
    act(() => {
      result.current.selectTab(archiveTabId);
    });
    await waitFor(() => expect(api.listArchiveDirectory).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.files.map((f) => f.name)).toEqual(["one.txt"]));
    expect(result.current.archiveHasMore).toBe(true);
  });

  it("drops stale read completions after switching or closing the originating tab", async () => {
    const slowDocs = deferred<typeof mockNestedDirectory>();
    vi.mocked(api.listDirectory).mockImplementation((_conn, path = "") => {
      if (path === "SlowDocs") return slowDocs.promise;
      return Promise.resolve(mockDirectoryListing);
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files).toHaveLength(3));
    const rootTabId = result.current.selectedTabId;

    let slowTabId = "";
    act(() => {
      slowTabId = requireTestValue(result.current.createTab());
    });
    act(() => {
      result.current.navigateToPath("SlowDocs");
    });
    expect(result.current.navigationPending).toBe(true);

    // Close slowTabId before its listing resolves
    act(() => {
      result.current.closeTab(slowTabId);
    });
    expect(result.current.selectedTabId).toBe(rootTabId);
    expect(result.current.currentPath).toBe("");

    await act(async () => {
      slowDocs.resolve(mockNestedDirectory);
    });
    expect(result.current.currentPath).toBe("");
    expect(result.current.files).toEqual(mockDirectoryListing.items);
  });

  it("does not refresh a retained tab's listing timestamp merely because it was selected", async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, "now").mockImplementation(() => now);
    try {
      const { result } = renderHook(
        () =>
          useFileBrowserPane({
            rowHeight: 40,
            connections: mockConnections,
            isLocationMonitoredElsewhere: () => true,
          }),
        { wrapper }
      );
      act(() => result.current.applyLocation("conn-1", ""));
      await waitFor(() => expect(result.current.files).toHaveLength(3));
      const tab1 = result.current.selectedTabId;

      let tab2 = "";
      act(() => {
        tab2 = requireTestValue(result.current.createTab());
      });

      // Advance 20s (< TTL) and switch back to tab1: still fresh, no reload
      vi.mocked(api.listDirectory).mockClear();
      now += 20_000;
      act(() => {
        result.current.selectTab(tab1);
      });
      expect(api.listDirectory).not.toHaveBeenCalled();

      // Switch to tab2, advance another 15s (total 35s >= DIRECTORY_CACHE_TTL_MS from original fetch,
      // even though only 15s passed since tab1 was selected!) -> must revalidate
      act(() => {
        result.current.selectTab(tab2);
      });
      now += DIRECTORY_CACHE_TTL_MS - 15_000;
      act(() => {
        result.current.selectTab(tab1);
      });
      await waitFor(() => expect(api.listDirectory).toHaveBeenCalledTimes(1));
    } finally {
      clock.mockRestore();
    }
  });

  it("applies source-mutating selection cleanup only to the captured source tab and ignores closed source tabs", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files.length).toBeGreaterThan(1));
    const tabA = result.current.selectedTabId;
    const firstFile = requireTestValue(result.current.files[0]);
    const secondFile = requireTestValue(result.current.files[1]);

    // Select both files in Tab A
    act(() => {
      result.current.toggleItemSelection(firstFile, 0);
      result.current.toggleItemSelection(secondFile, 1);
    });
    expect(result.current.selectedFiles.has(firstFile.path)).toBe(true);
    expect(result.current.selectedFiles.has(secondFile.path)).toBe(true);

    // Create duplicate Tab B at the same directory and select firstFile in Tab B too
    let tabB = "";
    act(() => {
      tabB = requireTestValue(result.current.createTab());
    });
    act(() => {
      result.current.toggleItemSelection(firstFile, 0);
    });
    expect(result.current.selectedFiles.has(firstFile.path)).toBe(true);

    // Simulate a source-mutating operation completing for Tab A while Tab B is active:
    // Tab B's selection must remain untouched, while Tab A's selection drops firstFile!
    act(() => {
      result.current.removeSelectedPaths([firstFile.path], tabA);
    });
    expect(result.current.selectedFiles.has(firstFile.path)).toBe(true);

    act(() => {
      result.current.selectTab(tabA);
    });
    expect(result.current.selectedFiles.has(firstFile.path)).toBe(false);
    expect(result.current.selectedFiles.has(secondFile.path)).toBe(true);

    // If Tab A is closed before another operation finishes, removeSelectedPaths(..., tabA) is a safe no-op
    act(() => {
      result.current.closeTab(tabA);
    });
    expect(result.current.selectedTabId).toBe(tabB);
    act(() => {
      result.current.removeSelectedPaths([firstFile.path], tabA);
    });
    expect(result.current.selectedFiles.has(firstFile.path)).toBe(true);
  });
});
