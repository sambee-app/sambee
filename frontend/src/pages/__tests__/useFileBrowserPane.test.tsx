import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { authSession } from "../../services/authSession";
import { resetCurrentUserSettingsStoreForTests } from "../../services/userSettingsStore";
import { createMockAuthToken } from "../../test/fixtures/users";
import {
  type ApiMock,
  createFakeContentProviderRegistry,
  createStorageBackedTestContentProviderRegistry,
  setupSuccessfulApiMocks,
} from "../../test/helpers";
import { requireTestValue } from "../../test/helpers/assertions";
import { SambeeThemeProvider } from "../../theme/ThemeContext";
import { FileType, type LocalLinkTargetListing } from "../../types";
import type { ContentProviderRegistry } from "../FileBrowser/contentProviders";
import type { UseFileBrowserPaneConfig } from "../FileBrowser/types";
import { shouldLoadNextVirtualPage, useFileBrowserPane as useFileBrowserPaneImplementation } from "../FileBrowser/useFileBrowserPane";
import { getPreferredViewerId, setPreferredViewerId } from "../FileBrowser/viewerPreferences";
import { mockConnections, mockDirectoryListing, mockEmptyDirectory, mockNestedDirectory } from "./FileBrowser.test.utils";

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

function createLocalStorageRegistry() {
  const backend = {
    async resolveActivation(item: { target: { driveId: string }; path: string }) {
      const activation = await api.resolveLocalActivation(`local-drive:${item.target.driveId}`, item.path);
      return {
        connectionId: `local-drive:${activation.drive_id}`,
        path: activation.path,
        type: activation.item.type,
        item: activation.item,
      };
    },
    async openInNativeApp(item: { target: { driveId: string }; path: string }, options: { forcePicker: boolean }) {
      await api.openLocalFile(`local-drive:${item.target.driveId}`, item.path, { forcePicker: options.forcePicker });
      return { kind: "opened-locally" as const };
    },
  };
  return {
    resolveItem: vi.fn(({ connectionId, path }: { connectionId: string; path: string }) => {
      const target = { kind: "local" as const, driveId: connectionId.replace("local-drive:", "") };
      return { target, path, resolvedTarget: { target, connection: null, capabilitySnapshot: { capabilityRevision: 1 } } };
    }),
    getCapabilities: vi.fn(() => ({ canOpenInNativeApp: true, readable: true, writable: true })),
    getBackend: vi.fn(() => backend),
  };
}

describe("useFileBrowserPane", () => {
  const wrapper = ({ children }: { children: ReactNode }) => <SambeeThemeProvider>{children}</SambeeThemeProvider>;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCurrentUserSettingsStoreForTests();
    authSession.setAuthenticated(createMockAuthToken({ access_token: "fake-token", token_type: "bearer" }), false);
    setupSuccessfulApiMocks(api as unknown as ApiMock);
    vi.mocked(getPreferredViewerId).mockResolvedValue(null);
    vi.mocked(setPreferredViewerId).mockResolvedValue();
  });

  it("extends mouse ranges from a path anchor and resets it when selection ends", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));

    act(() => result.current.selectItemFromIcon(requireTestValue(result.current.sortedFiles[0]), 0, false, false));
    act(() => result.current.selectItemFromIcon(requireTestValue(result.current.sortedFiles[2]), 2, true, false));
    expect([...result.current.selectedFiles]).toEqual(result.current.sortedFiles.map((file) => file.path));

    act(() => result.current.selectItemFromIcon(requireTestValue(result.current.sortedFiles[1]), 1, false, false));
    act(() => result.current.selectItemFromIcon(requireTestValue(result.current.sortedFiles[0]), 0, true, true));
    expect(result.current.selectedFiles.size).toBe(3);

    act(() => result.current.handleClearSelection());
    act(() => result.current.selectItemFromIcon(requireTestValue(result.current.sortedFiles[2]), 2, true, false));
    expect([...result.current.selectedFiles]).toEqual([requireTestValue(result.current.sortedFiles[2]).path]);
  });

  it("keeps earlier selections when extending a mouse range without Ctrl", async () => {
    const entries = ["A", "B", "C", "D", "E"].map((name) => ({ ...requireTestValue(mockDirectoryListing.items[2]), name, path: name }));
    vi.mocked(api.listDirectory).mockResolvedValue({ ...mockDirectoryListing, items: entries, total: entries.length });
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(5));

    const [first, , middle, , last] = result.current.sortedFiles;
    act(() => result.current.selectItemFromIcon(requireTestValue(first), 0, false, false));
    act(() => result.current.selectItemFromIcon(requireTestValue(middle), 2, false, false));
    act(() => result.current.selectItemFromIcon(requireTestValue(last), 4, true, false));

    expect(result.current.selectedFiles).toEqual(
      new Set([requireTestValue(first).path, ...result.current.sortedFiles.slice(2).map((file) => file.path)])
    );
  });

  it("adds a clicked item after a refresh removes the range anchor", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));

    const [first, middle, last] = result.current.sortedFiles;
    act(() => result.current.selectItemFromIcon(requireTestValue(first), 0, false, false));
    act(() => result.current.selectItemFromIcon(requireTestValue(last), 2, false, false));

    vi.mocked(api.listDirectory).mockResolvedValue({
      ...mockDirectoryListing,
      items: [requireTestValue(first), requireTestValue(middle)],
      total: 2,
    });
    act(() => result.current.handleRefresh());
    await waitFor(() => {
      expect(result.current.sortedFiles).toHaveLength(2);
      expect(result.current.selectedFiles).toEqual(new Set([requireTestValue(first).path]));
    });

    act(() => result.current.selectItemFromIcon(requireTestValue(middle), 1, true, true));
    expect(result.current.selectedFiles).toEqual(new Set([requireTestValue(first).path, requireTestValue(middle).path]));
  });

  it("uses a keyboard selection as the anchor for an icon range", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.sortedFiles).toHaveLength(3));

    const list = document.createElement("div");
    list.tabIndex = 0;
    document.body.appendChild(list);
    act(() => result.current.listContainerRef(list));
    list.focus();
    act(() => result.current.handleToggleSelection());
    expect(result.current.selectedFiles.size).toBe(1);
    act(() => result.current.selectItemFromIcon(requireTestValue(result.current.sortedFiles[2]), 2, true, false));
    expect([...result.current.selectedFiles]).toEqual(result.current.sortedFiles.map((file) => file.path));
    list.remove();
  });

  it("requests the next virtual page only near the rendered tail or for an underfilled viewport", () => {
    expect(
      shouldLoadNextVirtualPage({
        hasNextPage: true,
        isLoadingNextPage: false,
        lastRenderedIndex: 89,
        loadedItemCount: 100,
        scrollDirection: "forward",
        viewportIsUnderfilled: false,
      })
    ).toBe(true);
    expect(
      shouldLoadNextVirtualPage({
        hasNextPage: true,
        isLoadingNextPage: false,
        lastRenderedIndex: 40,
        loadedItemCount: 100,
        scrollDirection: "backward",
        viewportIsUnderfilled: false,
      })
    ).toBe(false);
    expect(
      shouldLoadNextVirtualPage({
        hasNextPage: true,
        isLoadingNextPage: false,
        lastRenderedIndex: 0,
        loadedItemCount: 1,
        scrollDirection: null,
        viewportIsUnderfilled: true,
      })
    ).toBe(true);
    expect(
      shouldLoadNextVirtualPage({
        hasNextPage: true,
        isLoadingNextPage: false,
        lastRenderedIndex: 99,
        loadedItemCount: 100,
        scrollDirection: "forward",
        viewportIsUnderfilled: null,
      })
    ).toBe(false);
    expect(
      shouldLoadNextVirtualPage({
        hasNextPage: true,
        isLoadingNextPage: true,
        lastRenderedIndex: 99,
        loadedItemCount: 100,
        scrollDirection: "forward",
        viewportIsUnderfilled: false,
      })
    ).toBe(false);
  });

  it("routes archive activation through the injected virtual-provider catalog", async () => {
    const capabilities = {
      browse: true,
      read: true,
      download: true,
      extract: false,
      mutate: true,
      openInNativeApp: true,
    };
    const list = vi.fn().mockResolvedValue({ items: [], total: 0, nextCursor: null });
    const physicalProvider = {
      id: "physical" as const,
      list,
      getCapabilities: () => capabilities,
      read: vi.fn(),
      beginEdit: vi.fn(),
      invalidatePdfDerivative: vi.fn(),
    };
    const virtualProvider = {
      ...physicalProvider,
      id: "bundle" as const,
      sourceExtensions: [".bundle"],
    };
    const providerRegistry = createFakeContentProviderRegistry([physicalProvider, virtualProvider]);
    const archive = {
      name: "project.bundle",
      path: "project.bundle",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };

    const { result } = renderHook(
      () => useFileBrowserPane({ rowHeight: 40, connections: mockConnections, contentProviders: providerRegistry }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });

    act(() => {
      result.current.handleFileClick(archive);
    });

    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual({ providerId: "bundle", archivePath: "project.bundle", virtualPath: "" });
    });
    expect(providerRegistry.getVirtualProviderIdForFilename("project.bundle")).toBe("bundle");
  });

  it("ignores a stale route replay after starting a local directory navigation", async () => {
    const onNavigatePath = vi.fn();
    const documentsDirectory = mockDirectoryListing.items.find((item) => item.type === "directory" && item.name === "Documents");

    expect(documentsDirectory).toBeDefined();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
          onNavigatePath,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
      expect(result.current.currentPath).toBe("");
    });

    act(() => {
      result.current.handleFileClick(documentsDirectory!);
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents");
    });

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    expect(result.current.currentPath).toBe("Documents");
    expect(onNavigatePath).toHaveBeenCalledWith("Documents");

    act(() => {
      result.current.applyLocation("conn-1", "Documents");
    });

    expect(result.current.currentPath).toBe("Documents");
  });

  it("ignores an out-of-order older route replay after a newer route has already been accepted", async () => {
    const onNavigatePath = vi.fn();
    const documentsDirectory = mockDirectoryListing.items.find((item) => item.type === "directory" && item.name === "Documents");

    expect(documentsDirectory).toBeDefined();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
          onNavigatePath,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "", 1);
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("");
    });

    act(() => {
      result.current.handleFileClick(documentsDirectory!);
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents");
    });

    act(() => {
      result.current.applyLocation("conn-1", "Documents", 3);
    });

    expect(result.current.currentPath).toBe("Documents");

    act(() => {
      result.current.applyLocation("conn-1", "", 2);
    });

    expect(result.current.currentPath).toBe("Documents");
    expect(onNavigatePath).toHaveBeenCalledWith("Documents");
  });

  it.each(["example.cjs", "example.clj", "Dockerfile"])("opens recognized language file %s without a viewer picker", async (filename) => {
    const file = {
      name: filename,
      path: filename,
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
      mime_type: "application/octet-stream",
    };
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(file, 0);
    });
    await waitFor(() => {
      expect(result.current.viewInfo).toMatchObject({ path: filename, viewerId: "text" });
    });
    expect(result.current.browserViewerPickerState).toBeNull();
  });

  it("restores a captured recovery snapshot with pane UI state", async () => {
    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
      expect(result.current.files.length).toBeGreaterThan(0);
    });

    act(() => {
      result.current.setSortBy("modified");
      result.current.setSortDirection("desc");
      result.current.handleSelectAll();
      result.current.setViewInfo({
        path: "readme.txt",
        mimeType: "text/plain",
        sessionId: "session-1",
      });
    });

    const snapshot = result.current.captureRecoverySnapshot();

    expect(snapshot).not.toBeNull();

    const { result: restoredResult } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      restoredResult.current.restoreRecoverySnapshot(snapshot);
    });

    await waitFor(() => {
      expect(restoredResult.current.connectionId).toBe("conn-1");
      expect(restoredResult.current.currentPath).toBe("");
      expect(restoredResult.current.files).toEqual(mockDirectoryListing.items);
      expect(restoredResult.current.sortBy).toBe("modified");
      expect(restoredResult.current.sortDirection).toBe("desc");
      expect(restoredResult.current.selectedFiles.size).toBe(mockDirectoryListing.items.length);
      expect(restoredResult.current.viewInfo?.path).toBe("readme.txt");
    });
  });

  it("restores archive recovery snapshots as read-only virtual content", async () => {
    const archiveLocation = { providerId: "zip" as const, archivePath: "Archives/backup.zip", virtualPath: "docs" };
    const archiveMember = {
      name: "notes.txt",
      path: "docs/notes.txt",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "Archives/backup.zip", size: 1 },
      path: "docs",
      items: [{ ...archiveMember, state: "readable" }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.restoreRecoverySnapshot({
        connectionId: "conn-1",
        path: "Archives",
        archiveLocation,
        items: [archiveMember],
        sortBy: "name",
        sortDirection: "asc",
        viewMode: "list",
        focusedIndex: 0,
        focusedFileName: "notes.txt",
        selectedFileNames: [],
        viewInfo: {
          path: "docs/notes.txt",
          mimeType: "text/plain",
          viewerId: "text",
          virtualSource: {
            kind: "virtual",
            location: {
              kind: "virtual",
              providerId: "zip",
              connectionId: "conn-1",
              source: { kind: "physical", connectionId: "conn-1", path: "Archives/backup.zip" },
              path: "docs",
            },
            path: "docs/notes.txt",
          },
          sessionId: "archive-session",
        },
        scrollOffset: 0,
      });
    });

    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual(archiveLocation);
      expect(result.current.contentCapabilities.mutate).toBe(false);
      expect(result.current.viewInfo?.virtualSource).toMatchObject({ kind: "virtual", path: "docs/notes.txt" });
    });
    expect(result.current.captureRecoverySnapshot()?.archiveLocation).toEqual(archiveLocation);

    act(() => {
      result.current.handleRenameForFile(result.current.files[0]!, 0);
      result.current.handleDeleteRequest({ requireListFocus: false });
    });
    expect(result.current.renameDialogOpen).toBe(false);
    expect(result.current.deleteDialogOpen).toBe(false);
  });

  it("normalizes same-drive absolute Windows paths for local-drive panes", async () => {
    const localDriveConnection = {
      ...requireTestValue(mockConnections[0]),
      id: "local-drive:d",
      slug: "d",
      type: "local",
      name: "Drive D",
    };

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localDriveConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:d", "d:\\temp");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:d");
      expect(result.current.currentPath).toBe("temp");
    });
  });

  it("enriches a current local directory with deferred link target metadata", async () => {
    const localDriveConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const linksListing = {
      path: "Links",
      total: 1,
      items: [
        {
          name: "Archive.lnk",
          path: "Links/Archive.lnk",
          type: FileType.FILE,
          is_readable: true,
          is_hidden: false,
          link_kind: "windows_shortcut" as const,
        },
      ],
    };
    vi.mocked(api.listDirectory).mockResolvedValue(linksListing);
    vi.mocked(api.listLocalLinkTargets).mockResolvedValue({
      items: [
        {
          source_path: "Links/Archive.lnk",
          state: "resolved",
          target: { name: "Archive", path: "C:\\Users\\Sambee\\Archive", type: "directory" },
        },
      ],
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localDriveConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });

    await waitFor(() => {
      expect(result.current.files[0]?.link_target).toEqual({
        source_path: "Links/Archive.lnk",
        state: "resolved",
        target: { name: "Archive", path: "C:\\Users\\Sambee\\Archive", type: "directory" },
      });
    });
    expect(api.listLocalLinkTargets).toHaveBeenCalledWith(
      "local-drive:c",
      "Links",
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("enriches cached local links when an earlier metadata request was interrupted", async () => {
    const localDriveConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const linksListing = {
      path: "Links",
      total: 1,
      items: [
        {
          name: "Archive.lnk",
          path: "Links/Archive.lnk",
          type: FileType.FILE,
          is_readable: true,
          is_hidden: false,
          link_kind: "windows_shortcut" as const,
        },
      ],
    };
    const interruptedRequest = deferred<LocalLinkTargetListing>();
    const resolvedListing: LocalLinkTargetListing = {
      items: [
        {
          source_path: "Links/Archive.lnk",
          state: "resolved",
          target: { name: "Archive", type: "directory" },
        },
      ],
    };
    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") =>
      path === "Links" ? linksListing : { path, total: 0, items: [] }
    );
    vi.mocked(api.listLocalLinkTargets)
      .mockImplementationOnce(() => interruptedRequest.promise)
      .mockResolvedValueOnce(resolvedListing);

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localDriveConnection],
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });

    await waitFor(() => {
      expect(api.listLocalLinkTargets).toHaveBeenCalledTimes(1);
    });

    act(() => {
      result.current.applyLocation("local-drive:c", "");
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("");
    });

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });

    await waitFor(() => {
      expect(result.current.files[0]?.link_target).toEqual(resolvedListing.items[0]);
    });
    expect(api.listLocalLinkTargets).toHaveBeenCalledTimes(2);
  });

  it("does not recreate an invalidated directory cache while enriching local links", async () => {
    const localDriveConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const targets = deferred<LocalLinkTargetListing>();
    const linkEntry = {
      name: "Archive.lnk",
      path: "Links/Archive.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
      link_kind: "windows_shortcut" as const,
    };
    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") => ({
      path,
      items: path === "Links" ? [linkEntry] : [],
      total: path === "Links" ? 1 : 0,
    }));
    vi.mocked(api.listLocalLinkTargets).mockReturnValueOnce(targets.promise).mockResolvedValue({ items: [] });
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: [localDriveConnection] }), { wrapper });
    act(() => result.current.applyLocation("local-drive:c", "Links"));
    await waitFor(() => expect(api.listLocalLinkTargets).toHaveBeenCalledTimes(1));

    act(() => result.current.handleDirectoryChanged({ connectionId: "local-drive:c", path: "Links" }, { invalidateOnly: true }));
    await act(async () => {
      targets.resolve({
        items: [{ source_path: linkEntry.path, state: "resolved", target: { name: "Archive", type: "directory" } }],
      });
    });
    expect(result.current.files[0]?.link_target?.state).toBe("resolved");

    await act(async () => result.current.applyLocation("local-drive:c", "Elsewhere"));
    await act(async () => result.current.applyLocation("local-drive:c", "Links"));
    expect(api.listDirectory).toHaveBeenCalledTimes(3);
  });

  it("ignores deferred link target metadata after navigating away", async () => {
    const localDriveConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const targets = deferred<LocalLinkTargetListing>();
    vi.mocked(api.listDirectory).mockImplementation(async (_connectionId, path = "") =>
      path === "Links"
        ? {
            path,
            total: 1,
            items: [
              {
                name: "Archive.lnk",
                path: "Links/Archive.lnk",
                type: FileType.FILE,
                is_readable: true,
                is_hidden: false,
                link_kind: "windows_shortcut" as const,
              },
            ],
          }
        : {
            path,
            total: 1,
            items: [
              {
                name: "elsewhere.txt",
                path: "Elsewhere/elsewhere.txt",
                type: FileType.FILE,
                is_readable: true,
                is_hidden: false,
              },
            ],
          }
    );
    vi.mocked(api.listLocalLinkTargets).mockReturnValueOnce(targets.promise);

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localDriveConnection],
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(api.listLocalLinkTargets).toHaveBeenCalled();
    });

    act(() => {
      result.current.applyLocation("local-drive:c", "Elsewhere");
    });
    await waitFor(() => {
      expect(result.current.files[0]?.name).toBe("elsewhere.txt");
    });

    await act(async () => {
      targets.resolve({
        items: [
          {
            source_path: "Links/Archive.lnk",
            state: "resolved",
            target: { name: "Archive", type: "directory" },
          },
        ],
      });
    });

    expect(result.current.files[0]?.name).toBe("elsewhere.txt");
    expect(result.current.files[0]?.link_target).toBeUndefined();
  });

  it("records a local directory only after Companion confirms its type", async () => {
    const localDriveConnection = {
      ...requireTestValue(mockConnections[0]),
      id: "local-drive:d",
      slug: "d",
      type: "local",
      name: "Drive D",
    };
    const documentsDirectory = mockDirectoryListing.items.find((item) => item.type === "directory" && item.name === "Documents");

    expect(documentsDirectory).toBeDefined();
    vi.mocked(api.getFileInfo).mockResolvedValue({ type: FileType.DIRECTORY } as never);
    vi.mocked(api.resolveLocalActivation).mockImplementation(async (_connectionId, path) => ({
      drive_id: "d",
      path,
      item: { ...documentsDirectory!, path, type: path === "Documents" ? FileType.DIRECTORY : FileType.FILE },
    }));
    const onNavigatePath = vi.fn();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localDriveConnection],
          storageRegistry: createLocalStorageRegistry() as never,
          onNavigatePath,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:d", "");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:d");
    });

    act(() => {
      result.current.handleFileClick(documentsDirectory!);
    });

    await waitFor(() => expect(onNavigatePath).toHaveBeenCalledWith("Documents"));
    act(() => {
      result.current.applyLocation("local-drive:d", "Documents");
    });

    await waitFor(() => {
      expect(api.recordRecentDirectory).toHaveBeenCalledWith("local-drive:d", "Documents");
    });

    vi.mocked(api.getFileInfo).mockResolvedValue({ type: FileType.FILE } as never);

    act(() => {
      result.current.handleFileClick({ ...documentsDirectory!, name: "Other", path: "Other" });
    });

    await waitFor(() => expect(api.resolveLocalActivation).toHaveBeenCalledWith("local-drive:d", "Documents/Other"));
    expect(api.recordRecentDirectory).toHaveBeenCalledTimes(1);
  });

  it("navigates to a directory resolved from a local link on another drive", async () => {
    const sourceConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const targetConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:d", slug: "d", type: "local", name: "Drive D" };
    const link = {
      name: "Archive.lnk",
      path: "Archive.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    const onNavigateDirectory = vi.fn();
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "d",
      path: "Projects/Archive",
      item: {
        name: "Archive",
        path: "Projects/Archive",
        type: FileType.DIRECTORY,
        is_readable: true,
        is_hidden: false,
      },
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [sourceConnection, targetConnection],
          onNavigateDirectory,
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:c");
    });
    act(() => {
      result.current.handleOpenFileForFile(link, 0);
    });

    await waitFor(() => {
      expect(api.resolveLocalActivation).toHaveBeenCalledWith("local-drive:c", "Links/Archive.lnk");
      expect(onNavigateDirectory).toHaveBeenCalledWith("local-drive:d", "Projects/Archive");
    });
  });

  it("opens a local ZIP as a virtual pane location instead of resolving a native file", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Archives");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:c");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });

    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual({ providerId: "zip", archivePath: "Archives/backup.zip", virtualPath: "" });
      expect(api.listArchiveDirectory).toHaveBeenCalledWith("local-drive:c", "Archives/backup.zip", "", {
        pageSize: 100,
        signal: expect.any(AbortSignal),
      });
    });
    expect(api.resolveLocalActivation).not.toHaveBeenCalled();
  });

  it("loads subsequent archive pages and appends their entries", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory)
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "first.txt", path: "first.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: "page-two",
      })
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "second.txt", path: "second.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: null,
      });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });

    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["first.txt"]);
      expect(result.current.archiveHasMore).toBe(true);
    });

    act(() => {
      result.current.loadMoreArchive();
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["first.txt", "second.txt"]);
      expect(result.current.archiveHasMore).toBe(false);
    });

    expect(api.listArchiveDirectory).toHaveBeenLastCalledWith("conn-1", "backup.zip", "", {
      cursor: "page-two",
      pageSize: 100,
      signal: expect.any(AbortSignal),
    });
  });

  it("allows archive pagination after a refresh supersedes an in-flight append", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    const pendingAppend = deferred<Awaited<ReturnType<typeof api.listArchiveDirectory>>>();
    vi.mocked(api.listArchiveDirectory)
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "first.txt", path: "first.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: "page-two",
      })
      .mockImplementationOnce(() => pendingAppend.promise)
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "refreshed.txt", path: "refreshed.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: "page-two",
      })
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "second.txt", path: "second.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: null,
      });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });

    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.archiveHasMore).toBe(true);
    });

    act(() => {
      result.current.loadMoreArchive();
    });
    await waitFor(() => {
      expect(result.current.archiveLoadingMore).toBe(true);
    });

    await act(async () => {
      await result.current.reloadCurrentLocation({ forceRefresh: true });
    });

    expect(result.current.archiveLoadingMore).toBe(false);

    act(() => {
      result.current.loadMoreArchive();
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["refreshed.txt", "second.txt"]);
      expect(result.current.archiveLoadingMore).toBe(false);
    });
  });

  it("navigates archive folders in the pane and returns to the containing directory from archive root", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listDirectory).mockResolvedValue({
      path: "Archives",
      items: [
        { name: "aardvark.txt", path: "Archives/aardvark.txt", type: FileType.FILE, is_readable: true, is_hidden: false },
        { ...archive, path: "Archives/backup.zip" },
      ],
      total: 2,
    });
    vi.mocked(api.listArchiveDirectory).mockImplementation((_connectionId, _archivePath, virtualPath = "") =>
      Promise.resolve({
        archive: { path: "Archives/backup.zip", size: 1 },
        path: virtualPath,
        items:
          virtualPath === ""
            ? [
                { name: "alpha", path: "alpha", type: FileType.DIRECTORY, state: "readable", is_hidden: false },
                { name: "nested", path: "nested", type: FileType.DIRECTORY, state: "readable", is_hidden: false },
              ]
            : [{ name: "member.txt", path: "nested/member.txt", type: FileType.FILE, state: "readable", is_hidden: false }],
        total: 1,
        page_size: 100,
      })
    );

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "Archives");
    });
    await waitFor(() => {
      expect(result.current.currentPath).toBe("Archives");
    });

    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual({ providerId: "zip", archivePath: "Archives/backup.zip", virtualPath: "" });
      expect(result.current.files.map((file) => file.name)).toEqual(["alpha", "nested"]);
    });

    const scrollContainer = document.createElement("div");
    act(() => {
      (result.current.parentRef as { current: HTMLDivElement | null }).current = scrollContainer as HTMLDivElement;
      scrollContainer.scrollTop = 96;
      const nestedDirectory = result.current.files.find((file) => file.name === "nested");
      expect(nestedDirectory).toBeDefined();
      result.current.handleFileClick(nestedDirectory!);
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual({ providerId: "zip", archivePath: "Archives/backup.zip", virtualPath: "nested" });
      expect(result.current.files[0]?.name).toBe("member.txt");
    });

    act(() => {
      result.current.handleNavigateUpDirectory();
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual({ providerId: "zip", archivePath: "Archives/backup.zip", virtualPath: "" });
      expect(result.current.focusedIndex).toBe(1);
      expect(scrollContainer.scrollTop).toBe(96);
    });

    act(() => {
      result.current.handleNavigateUpDirectory();
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).toBeNull();
      expect(result.current.currentPath).toBe("Archives");
      expect(result.current.focusedIndex).toBe(1);
    });
  });

  it("ignores an archive viewer activation that completes after leaving the archive", async () => {
    const archive = { name: "backup.zip", path: "backup.zip", type: FileType.FILE, is_readable: true, is_hidden: false };
    const preferredViewer = deferred<"text" | null>();
    vi.mocked(getPreferredViewerId).mockReturnValueOnce(preferredViewer.promise);
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "notes.txt", path: "notes.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "Archives");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
      result.current.handleNavigateUpDirectory();
    });
    await act(async () => {
      preferredViewer.resolve("text");
      await preferredViewer.promise;
    });

    expect(result.current.archiveLocation).toBeNull();
    expect(result.current.viewInfo).toBeNull();
  });

  it("ignores an archive viewer activation that completes after a route change", async () => {
    const archive = { name: "backup.zip", path: "backup.zip", type: FileType.FILE, is_readable: true, is_hidden: false };
    const preferredViewer = deferred<"text" | null>();
    vi.mocked(getPreferredViewerId).mockReturnValueOnce(preferredViewer.promise);
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "Archives/backup.zip", size: 1 },
      path: "",
      items: [{ name: "notes.txt", path: "notes.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "Archives");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
      result.current.applyLocation("conn-1", "Elsewhere");
    });
    await act(async () => {
      preferredViewer.resolve("text");
      await preferredViewer.promise;
    });

    expect(result.current.archiveLocation).toBeNull();
    expect(result.current.currentPath).toBe("Elsewhere");
    expect(result.current.viewInfo).toBeNull();
    expect(result.current.browserViewerPickerState).toBeNull();
  });

  it("does not let a deferred physical listing overwrite an open archive", async () => {
    const physicalListing = deferred<typeof mockDirectoryListing>();
    vi.mocked(api.listDirectory).mockReturnValueOnce(physicalListing.promise);
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "inside.txt", path: "inside.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(api.listDirectory).toHaveBeenCalled();
    });

    act(() => {
      result.current.openArchive("backup.zip");
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["inside.txt"]);
    });

    await act(async () => {
      physicalListing.resolve(mockDirectoryListing);
      await physicalListing.promise;
    });

    expect(result.current.archiveLocation).toEqual({ providerId: "zip", archivePath: "backup.zip", virtualPath: "" });
    expect(result.current.files.map((file) => file.name)).toEqual(["inside.txt"]);
  });

  it.each([mockDirectoryListing, mockEmptyDirectory])(
    "keeps a loaded directory visible during automatic refreshes ($total entries)",
    async (listing) => {
      vi.mocked(api.listDirectory).mockResolvedValueOnce(listing);
      const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
      act(() => result.current.applyLocation("conn-1", ""));
      await waitFor(() => expect(result.current.loading).toBe(false));
      expect(result.current.files).toHaveLength(listing.items.length);

      const refresh = deferred<typeof mockDirectoryListing>();
      vi.mocked(api.listDirectory).mockReturnValueOnce(refresh.promise);
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));

      expect(api.listDirectory).toHaveBeenCalledTimes(2);
      expect(result.current.loading).toBe(false);
      expect(result.current.files).toHaveLength(listing.items.length);

      await act(async () => refresh.resolve(mockDirectoryListing));
      expect(result.current.files).toHaveLength(mockDirectoryListing.items.length);
    }
  );

  it("coalesces changes without aborting the active automatic refresh", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files).toHaveLength(3));

    vi.useFakeTimers();
    try {
      const refresh = deferred<typeof mockDirectoryListing>();
      vi.mocked(api.listDirectory).mockReturnValueOnce(refresh.promise);
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      const signal = vi.mocked(api.listDirectory).mock.calls.at(-1)?.[2]?.signal;

      act(() => {
        for (let index = 0; index < 20; index++) {
          result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" });
        }
      });
      expect(api.listDirectory).toHaveBeenCalledTimes(2);
      expect(signal?.aborted).toBe(false);
      await act(async () => refresh.resolve(mockDirectoryListing));
      expect(api.listDirectory).toHaveBeenCalledTimes(2);

      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(api.listDirectory).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(api.listDirectory).toHaveBeenCalledTimes(3);
      expect(result.current.loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not reuse a stale snapshot after navigation cancels its trailing refresh", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files).toHaveLength(3));

    const snapshot = deferred<typeof mockDirectoryListing>();
    const newEntry = { ...requireTestValue(mockDirectoryListing.items[2]), name: "new-after-snapshot.txt", path: "new-after-snapshot.txt" };
    const freshListing = { ...mockDirectoryListing, items: [...mockDirectoryListing.items, newEntry], total: 4 };
    vi.mocked(api.listDirectory).mockResolvedValue(requireTestValue(freshListing)).mockReturnValueOnce(snapshot.promise);

    vi.useFakeTimers();
    try {
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      await act(async () => snapshot.resolve(mockDirectoryListing));
      expect(api.listDirectory).toHaveBeenCalledTimes(2);

      await act(async () => result.current.applyLocation("conn-1", "Documents"));
      await act(async () => result.current.applyLocation("conn-1", ""));

      expect(api.listDirectory).toHaveBeenCalledTimes(4);
      expect(result.current.files.map((entry) => entry.name)).toContain(newEntry.name);
      await act(async () => vi.advanceTimersByTimeAsync(1_000));
      expect(api.listDirectory).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("waits for the initial listing before refreshing changes received while loading", async () => {
    const initialListing = deferred<typeof mockDirectoryListing>();
    const refresh = deferred<typeof mockDirectoryListing>();
    vi.mocked(api.listDirectory).mockReturnValueOnce(initialListing.promise).mockReturnValueOnce(refresh.promise);
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    const initialSignal = requireTestValue(vi.mocked(api.listDirectory).mock.calls[0])[2]?.signal;

    act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
    expect(api.listDirectory).toHaveBeenCalledTimes(1);
    expect(initialSignal?.aborted).toBe(false);
    expect(result.current.loading).toBe(true);

    await act(async () => initialListing.resolve(mockDirectoryListing));
    expect(api.listDirectory).toHaveBeenCalledTimes(2);
    expect(result.current.files).toHaveLength(3);
    expect(result.current.loading).toBe(false);
    await act(async () => refresh.resolve(mockDirectoryListing));
  });

  it("refreshes periodically during continuous notifications instead of postponing the deadline", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files).toHaveLength(3));

    vi.useFakeTimers();
    try {
      await act(async () => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      for (let index = 0; index < 10; index++) {
        act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
        await act(async () => vi.advanceTimersByTimeAsync(200));
      }
      expect(api.listDirectory).toHaveBeenCalledTimes(4);
      expect(result.current.loading).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("performs one trailing refresh after a slow listing without overlapping requests", async () => {
    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files).toHaveLength(3));

    vi.useFakeTimers();
    try {
      const refresh = deferred<typeof mockDirectoryListing>();
      vi.mocked(api.listDirectory).mockReturnValueOnce(refresh.promise);
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(api.listDirectory).toHaveBeenCalledTimes(2);

      await act(async () => refresh.resolve(mockDirectoryListing));
      expect(api.listDirectory).toHaveBeenCalledTimes(3);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(api.listDirectory).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["navigation", "unmount"])("discards queued refreshes on %s", async (action) => {
    const { result, unmount } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => result.current.applyLocation("conn-1", ""));
    await waitFor(() => expect(result.current.files).toHaveLength(3));

    vi.useFakeTimers();
    try {
      await act(async () => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
      expect(api.listDirectory).toHaveBeenCalledTimes(2);

      if (action === "navigation") {
        await act(async () => result.current.applyLocation("conn-1", "Documents"));
      } else {
        unmount();
      }
      const callsAfterLeaving = vi.mocked(api.listDirectory).mock.calls.length;
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(api.listDirectory).toHaveBeenCalledTimes(callsAfterLeaving);
      if (action === "navigation") {
        expect(result.current.currentPath).toBe("Documents");
      }
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["before", "after"])(
    "keeps selection, focus and scroll while automatically refreshing unchanged rows (refresh resolves %s next frame)",
    async (refreshTiming) => {
      const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
      act(() => result.current.applyLocation("conn-1", ""));
      await waitFor(() => expect(result.current.files).toHaveLength(3));
      const list = document.createElement("div");
      list.tabIndex = 0;
      document.body.appendChild(list);
      vi.useFakeTimers();
      try {
        act(() => {
          result.current.listContainerRef(list);
          result.current.parentRef.current = list;
        });
        list.focus();
        act(() => result.current.handleEnd());
        act(() => vi.advanceTimersToNextFrame());
        const focusedIndex = result.current.sortedFiles.length - 1;
        expect(result.current.focusedIndex).toBe(focusedIndex);
        act(() => result.current.handleToggleSelection());
        const selected = new Set(result.current.selectedFiles);
        expect(selected).toEqual(new Set([requireTestValue(result.current.sortedFiles[focusedIndex]).path]));
        list.scrollTop = 120;

        const refresh = deferred<typeof mockDirectoryListing>();
        vi.mocked(api.listDirectory).mockReturnValueOnce(refresh.promise);
        act(() => result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" }));
        expect(result.current.loading).toBe(false);
        if (refreshTiming === "after") {
          act(() => vi.advanceTimersToNextFrame());
        }
        await act(async () =>
          refresh.resolve({ ...mockDirectoryListing, items: mockDirectoryListing.items.map((entry) => ({ ...entry })) })
        );
        act(() => vi.advanceTimersToNextFrame());

        expect(result.current.selectedFiles).toEqual(selected);
        expect(result.current.focusedIndex).toBe(focusedIndex);
        expect(list.scrollTop).toBe(120);
      } finally {
        list.remove();
        vi.useRealTimers();
      }
    }
  );

  it("reloads an open archive when its physical parent directory changes", async () => {
    const archive = { name: "backup.zip", path: "backup.zip", type: FileType.FILE, is_readable: true, is_hidden: false };
    vi.mocked(api.listArchiveDirectory)
      .mockResolvedValueOnce({
        archive: { path: "Archives/backup.zip", size: 1 },
        path: "",
        items: [{ name: "before.txt", path: "before.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      })
      .mockResolvedValueOnce({
        archive: { path: "Archives/backup.zip", size: 1 },
        path: "",
        items: [{ name: "after.txt", path: "after.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "Archives");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["before.txt"]);
    });

    act(() => {
      result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "Archives" });
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["after.txt"]);
    });
  });

  it("reloads an open root archive when its root directory changes", async () => {
    vi.mocked(api.listArchiveDirectory)
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "before.txt", path: "before.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      })
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "after.txt", path: "after.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "");
      result.current.openArchive("backup.zip");
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["before.txt"]);
    });

    act(() => {
      result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "" });
    });
    await waitFor(() => {
      expect(result.current.files.map((file) => file.name)).toEqual(["after.txt"]);
    });
  });

  it("exits an archive before switching connections", async () => {
    const archive = { name: "backup.zip", path: "backup.zip", type: FileType.FILE, is_readable: true, is_hidden: false };
    const otherConnection = { ...requireTestValue(mockConnections[0]), id: "conn-2", name: "Other Server", slug: "other-server" };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "Archives/backup.zip", size: 1 },
      path: "",
      items: [{ name: "notes.txt", path: "notes.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: [...mockConnections, otherConnection] }), {
      wrapper,
    });
    act(() => {
      result.current.applyLocation("conn-1", "Archives");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).not.toBeNull();
    });

    act(() => {
      result.current.handleConnectionChange("conn-2");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-2");
      expect(result.current.currentPath).toBe("");
      expect(result.current.archiveLocation).toBeNull();
    });
    expect(vi.mocked(api.listArchiveDirectory).mock.calls.every(([connectionId]) => connectionId === "conn-1")).toBe(true);
  });

  it("closes an archive picker when a refreshed member is no longer readable", async () => {
    const archive = { name: "backup.zip", path: "backup.zip", type: FileType.FILE, is_readable: true, is_hidden: false };
    vi.mocked(api.listArchiveDirectory)
      .mockResolvedValueOnce({
        archive: { path: "Archives/backup.zip", size: 1 },
        path: "",
        items: [{ name: "notes.txt", path: "notes.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 100,
      })
      .mockResolvedValueOnce({
        archive: { path: "Archives/backup.zip", size: 1 },
        path: "",
        items: [{ name: "notes.txt", path: "notes.txt", type: FileType.FILE, state: "blocked", is_hidden: false }],

        page_size: 100,
      });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "Archives");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).toEqual({ providerId: "zip", archivePath: "Archives/backup.zip", virtualPath: "" });
      expect(result.current.files.map((file) => file.name)).toEqual(["notes.txt"]);
    });
    act(() => {
      result.current.handleOpenFileForFile(result.current.files[0]!, 0, "force-viewer-picker");
    });
    await waitFor(() => {
      expect(result.current.browserViewerPickerState).not.toBeNull();
    });

    act(() => {
      result.current.handleDirectoryChanged({ connectionId: "conn-1", path: "Archives" });
    });
    await waitFor(() => {
      expect(result.current.files[0]?.is_readable).toBe(false);
      expect(result.current.browserViewerPickerState).toBeNull();
    });
  });

  it("does not open physical mutation dialogs while viewing archive entries", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "report.txt", path: "report.txt", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });

    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.archiveLocation).not.toBeNull();
    });

    act(() => {
      result.current.handleDeleteRequest({ requireListFocus: false });
      result.current.handleRenameRequest({ requireListFocus: false });
      result.current.handleNewDirectoryRequest();
      result.current.handleNewFileRequest();
    });

    expect(result.current.deleteDialogOpen).toBe(false);
    expect(result.current.renameDialogOpen).toBe(false);
    expect(result.current.createDialogOpen).toBe(false);
  });

  it("opens archive images in the standard viewer", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "inside.png", path: "images/inside.png", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
    });

    await waitFor(() => {
      expect(result.current.viewInfo).toMatchObject({
        path: "images/inside.png",
        viewerId: "image",
        virtualSource: {
          kind: "virtual",
          location: { providerId: "zip", source: { path: "backup.zip" } },
        },
        images: ["images/inside.png"],
        currentIndex: 0,
      });
    });
  });

  it.each([
    ["inside.pdf", "pdf", "docs/inside.pdf", "application/pdf"],
    ["readme.md", "markdown", "docs/readme.md", "text/markdown"],
    ["notes.txt", "text", "docs/notes.txt", "text/plain"],
  ] as const)("routes virtual %s members through the %s viewer", async (name, viewerId, path, mimeType) => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name, path, type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
    });

    await waitFor(() => {
      expect(result.current.viewInfo).toMatchObject({
        path,
        mimeType,
        viewerId,
        virtualSource: {
          kind: "virtual",
          location: { providerId: "zip", source: { path: "backup.zip" } },
        },
      });
    });
  });

  it("opens the Sambee viewer picker for an unknown archive member without downloading it", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "inside.sss", path: "files/inside.sss", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
    });

    await waitFor(() => {
      expect(result.current.browserViewerPickerState).toMatchObject({
        filePath: "files/inside.sss",
        showNativeOption: false,
        virtualSource: { kind: "virtual", path: "files/inside.sss" },
      });
    });
    expect(api.getArchiveMember).not.toHaveBeenCalled();
  });

  it("does not activate nested archive members in a Sambee viewer", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "nested.zip", path: "archives/nested.zip", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
      result.current.handleOpenFileForFile(result.current.files[0]!, 0, "force-viewer-picker");
    });

    expect(getPreferredViewerId).not.toHaveBeenCalled();
    expect(result.current.viewInfo).toBeNull();
    expect(result.current.browserViewerPickerState).toBeNull();
    expect(api.getArchiveMember).not.toHaveBeenCalled();
  });

  it("preserves a virtual source through viewer selection and reuses the saved preference", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "readme.md", path: "docs/readme.md", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });
    vi.mocked(getPreferredViewerId).mockResolvedValueOnce(null).mockResolvedValueOnce("text");

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });

    act(() => {
      result.current.handleOpenFileForFile(result.current.files[0]!, 0, "force-viewer-picker");
    });
    await waitFor(() => {
      expect(result.current.browserViewerPickerState).toMatchObject({
        filePath: "docs/readme.md",
        showNativeOption: false,
        virtualSource: {
          kind: "virtual",
          location: { providerId: "zip", source: { path: "backup.zip" } },
        },
      });
    });

    await act(async () => {
      await result.current.confirmBrowserViewerPicker({ viewerId: "text", rememberSelection: true });
    });
    expect(setPreferredViewerId).toHaveBeenCalledWith("readme.md", "text/markdown", "text");
    expect(result.current.viewInfo).toMatchObject({
      path: "docs/readme.md",
      viewerId: "text",
      virtualSource: { kind: "virtual" },
    });

    act(() => {
      result.current.setViewInfo(null);
      result.current.handleFileClick(result.current.files[0]!);
    });
    await waitFor(() => {
      expect(result.current.viewInfo).toMatchObject({ viewerId: "text", virtualSource: { kind: "virtual" } });
    });
  });

  it("keeps the viewer picker open when saving a remembered selection fails", async () => {
    const archive = { name: "backup.zip", path: "backup.zip", type: FileType.FILE, is_readable: true, is_hidden: false };
    vi.mocked(api.listArchiveDirectory).mockResolvedValue({
      archive: { path: "backup.zip", size: 1 },
      path: "",
      items: [{ name: "readme.md", path: "docs/readme.md", type: FileType.FILE, state: "readable", is_hidden: false }],

      page_size: 100,
    });
    vi.mocked(getPreferredViewerId).mockResolvedValue(null);
    vi.mocked(setPreferredViewerId).mockRejectedValue(new Error("Unable to save viewer preference."));

    const { result } = renderHook(() => useFileBrowserPane({ rowHeight: 40, connections: mockConnections }), { wrapper });
    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });
    act(() => {
      result.current.handleOpenFileForFile(result.current.files[0]!, 0, "force-viewer-picker");
    });
    await waitFor(() => {
      expect(result.current.browserViewerPickerState).not.toBeNull();
    });

    await act(async () => {
      await result.current.confirmBrowserViewerPicker({ viewerId: "text", rememberSelection: true });
    });

    expect(result.current.browserViewerPickerState).toMatchObject({ saving: false, saveError: "Unable to save viewer preference." });
    expect(result.current.viewInfo).toBeNull();

    await act(async () => {
      await result.current.confirmBrowserViewerPicker({ viewerId: "text", rememberSelection: false });
    });

    expect(result.current.browserViewerPickerState).toBeNull();
    expect(result.current.viewInfo).toMatchObject({ path: "docs/readme.md", viewerId: "text", virtualSource: { kind: "virtual" } });
  });

  it("extends an open virtual image gallery when another archive page loads", async () => {
    const archive = {
      name: "backup.zip",
      path: "backup.zip",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.listArchiveDirectory)
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "first.png", path: "images/first.png", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: "page-two",
      })
      .mockResolvedValueOnce({
        archive: { path: "backup.zip", size: 1 },
        path: "",
        items: [{ name: "second.png", path: "images/second.png", type: FileType.FILE, state: "readable", is_hidden: false }],

        page_size: 1,
        next_cursor: null,
      });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });
    act(() => {
      result.current.handleOpenFileForFile(archive, 0);
    });
    await waitFor(() => {
      expect(result.current.files).toHaveLength(1);
    });
    act(() => {
      result.current.handleFileClick(result.current.files[0]!);
    });
    await waitFor(() => {
      expect(result.current.viewInfo?.images).toEqual(["images/first.png"]);
    });

    act(() => {
      result.current.loadMoreArchive();
    });
    await waitFor(() => {
      expect(result.current.viewInfo?.images).toEqual(["images/first.png", "images/second.png"]);
    });
  });

  it("opens the resolved local file rather than its link source", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const link = {
      name: "Report.lnk",
      path: "Report.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "d",
      path: "Reports/quarterly.pdf",
      item: {
        name: "quarterly.pdf",
        path: "Reports/quarterly.pdf",
        type: FileType.FILE,
        mime_type: "application/pdf",
        is_readable: true,
        is_hidden: false,
      },
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:c");
    });
    act(() => {
      result.current.handleOpenFileForFile(link, 0);
    });

    await waitFor(() => {
      expect(result.current.viewInfo).toMatchObject({
        connectionId: "local-drive:d",
        path: "Reports/quarterly.pdf",
        mimeType: "application/pdf",
      });
    });
  });

  it("opens a resolved local link target with the native app", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const link = {
      name: "Report.lnk",
      path: "Report.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "d",
      path: "Reports/quarterly.docx",
      item: {
        name: "quarterly.docx",
        path: "Reports/quarterly.docx",
        type: FileType.FILE,
        is_readable: true,
        is_hidden: false,
      },
    });
    vi.mocked(api.openLocalFile).mockResolvedValue();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:c");
    });
    await act(async () => {
      await result.current.handleOpenInAppForFile(link, 0);
    });

    expect(api.openLocalFile).toHaveBeenCalledWith("local-drive:d", "Reports/quarterly.docx", { forcePicker: false });
  });

  it("shows a link-resolution error without opening the source file", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const link = {
      name: "Missing.lnk",
      path: "Missing.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    vi.mocked(api.resolveLocalActivation).mockRejectedValue({
      response: { data: { detail: "The link target no longer exists", code: "local_link_target_missing" }, status: 404 },
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.connectionId).toBe("local-drive:c");
    });
    act(() => {
      result.current.handleOpenFileForFile(link, 0);
    });

    await waitFor(() => {
      expect(result.current.error).toBe("The link target no longer exists");
    });
    expect(result.current.viewInfo).toBeNull();
    expect(api.openLocalFile).not.toHaveBeenCalled();
  });

  it("ignores a local activation result after navigation supersedes it", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const link = {
      name: "Report.lnk",
      path: "Report.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    let resolveActivation!: (value: Awaited<ReturnType<typeof api.resolveLocalActivation>>) => void;
    vi.mocked(api.resolveLocalActivation).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveActivation = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.currentPath).toBe("Links");
    });

    act(() => {
      result.current.handleOpenFileForFile(link, 0);
    });
    await waitFor(() => {
      expect(api.resolveLocalActivation).toHaveBeenCalledWith("local-drive:c", "Links/Report.lnk");
    });

    act(() => {
      result.current.applyLocation("local-drive:c", "Elsewhere");
    });
    await act(async () => {
      resolveActivation({
        drive_id: "c",
        path: "Reports/quarterly.pdf",
        item: {
          name: "quarterly.pdf",
          path: "Reports/quarterly.pdf",
          type: FileType.FILE,
          mime_type: "application/pdf",
          is_readable: true,
          is_hidden: false,
        },
      });
    });

    expect(result.current.currentPath).toBe("Elsewhere");
    expect(result.current.viewInfo).toBeNull();
  });

  it("ignores deferred viewer selection for a superseded local activation", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const link = {
      name: "Report.lnk",
      path: "Report.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    const defaultSettings = await api.getCurrentUserSettings();
    vi.mocked(api.getCurrentUserSettings).mockClear();
    let resolveSettings!: (value: Awaited<ReturnType<typeof api.getCurrentUserSettings>>) => void;
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "c",
      path: "Reports/quarterly.pdf",
      item: {
        name: "quarterly.pdf",
        path: "Reports/quarterly.pdf",
        type: FileType.FILE,
        mime_type: "application/pdf",
        is_readable: true,
        is_hidden: false,
      },
    });
    vi.mocked(api.getCurrentUserSettings).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.currentPath).toBe("Links");
    });

    act(() => {
      result.current.handleOpenFileForFile(link, 0);
    });
    await waitFor(() => {
      expect(api.getCurrentUserSettings).toHaveBeenCalled();
    });

    act(() => {
      result.current.applyLocation("local-drive:c", "Elsewhere");
    });
    await act(async () => {
      resolveSettings(defaultSettings);
    });

    expect(result.current.currentPath).toBe("Elsewhere");
    expect(result.current.viewInfo).toBeNull();
  });

  it("lets a non-local recent file supersede a pending local link activation", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const remoteConnection = { ...requireTestValue(mockConnections[0]), id: "conn-2", slug: "archive", name: "Archive" };
    const link = {
      name: "Report.lnk",
      path: "Report.lnk",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    };
    const defaultSettings = await api.getCurrentUserSettings();
    vi.mocked(api.getCurrentUserSettings).mockClear();
    let resolveSettings!: (value: Awaited<ReturnType<typeof api.getCurrentUserSettings>>) => void;
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "c",
      path: "Reports/quarterly.pdf",
      item: {
        name: "quarterly.pdf",
        path: "Reports/quarterly.pdf",
        type: FileType.FILE,
        mime_type: "application/pdf",
        is_readable: true,
        is_hidden: false,
      },
    });
    vi.mocked(api.validateRecentFileTarget).mockResolvedValue({
      name: "outside.png",
      path: "outside.png",
      type: FileType.FILE,
      mime_type: "image/png",
      size: 100,
      is_readable: true,
      is_hidden: false,
    });
    vi.mocked(api.getCurrentUserSettings).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveSettings = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection, remoteConnection],
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
      result.current.handleOpenFileForFile(link, 0);
    });
    await waitFor(() => {
      expect(api.getCurrentUserSettings).toHaveBeenCalled();
    });

    await act(async () => {
      await result.current.handleOpenFileAtPath("conn-2", "outside.png", "associated-viewer", "recent-2");
      resolveSettings(defaultSettings);
    });

    await waitFor(() => {
      expect(result.current.viewInfo).toMatchObject({ connectionId: "conn-2", path: "outside.png" });
    });
    expect(api.recordRecentFile).toHaveBeenCalledTimes(1);
    expect(api.recordRecentFile).toHaveBeenCalledWith("conn-2", "outside.png");
  });

  it("does not record a failed directory navigation after a later reload succeeds", async () => {
    const documentsDirectory = mockDirectoryListing.items.find((item) => item.type === "directory" && item.name === "Documents");

    expect(documentsDirectory).toBeDefined();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.files).toEqual(mockDirectoryListing.items);
    });

    vi.mocked(api.listDirectory).mockRejectedValueOnce(new Error("Directory unavailable"));

    act(() => {
      result.current.handleFileClick(documentsDirectory!);
    });

    await waitFor(() => {
      expect(result.current.error).not.toBeNull();
    });

    vi.mocked(api.listDirectory).mockResolvedValueOnce(mockNestedDirectory);

    await act(async () => {
      await result.current.reloadCurrentLocation({ forceRefresh: true });
    });

    expect(api.recordRecentDirectory).not.toHaveBeenCalled();
  });

  it("resets the file list scroll position when navigating into a fresh child directory", async () => {
    const documentsDirectory = mockDirectoryListing.items.find((item) => item.type === "directory" && item.name === "Documents");

    expect(documentsDirectory).toBeDefined();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 120,
      writable: true,
      configurable: true,
    });

    act(() => {
      (result.current.parentRef as { current: HTMLDivElement | null }).current = scrollContainer as HTMLDivElement;
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
      expect(result.current.files.length).toBeGreaterThan(0);
    });

    act(() => {
      scrollContainer.scrollTop = 120;
      result.current.handleFileClick(documentsDirectory!);
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents");
      expect(scrollContainer.scrollTop).toBe(0);
    });
  });

  it("falls back to the first item when saved directory history targets a missing file", async () => {
    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 120,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      (result.current.parentRef as { current: HTMLDivElement | null }).current = scrollContainer as HTMLDivElement;
      result.current.restoreRecoverySnapshot({
        connectionId: "conn-1",
        path: "Documents",
        items: mockNestedDirectory.items,
        sortBy: "name",
        sortDirection: "asc",
        viewMode: "list",
        focusedIndex: 0,
        focusedFileName: "Missing Folder",
        selectedFileNames: [],
        viewInfo: null,
        scrollOffset: 120,
      });
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
      expect(result.current.currentPath).toBe("Documents");
      expect(result.current.focusedIndex).toBe(0);
      expect(scrollContainer.scrollTop).toBe(0);
    });
  });

  it("opens a child directory fresh instead of restoring stale per-directory history from a previous visit", async () => {
    const documentsDirectory = mockDirectoryListing.items.find((item) => item.type === "directory" && item.name === "Documents");

    expect(documentsDirectory).toBeDefined();

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 0,
      writable: true,
      configurable: true,
    });

    act(() => {
      (result.current.parentRef as { current: HTMLDivElement | null }).current = scrollContainer as HTMLDivElement;
      result.current.restoreRecoverySnapshot({
        connectionId: "conn-1",
        path: "Documents",
        items: mockNestedDirectory.items,
        sortBy: "name",
        sortDirection: "asc",
        viewMode: "list",
        focusedIndex: 2,
        focusedFileName: "report.pdf",
        selectedFileNames: [],
        viewInfo: null,
        scrollOffset: 120,
      });
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents");
      expect(result.current.focusedIndex).toBe(2);
      expect(scrollContainer.scrollTop).toBe(120);
    });

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("");
      expect(result.current.files.length).toBeGreaterThan(0);
    });

    act(() => {
      scrollContainer.scrollTop = 55;
      result.current.handleFileClick(documentsDirectory!);
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents");
      expect(result.current.focusedIndex).toBe(0);
      expect(scrollContainer.scrollTop).toBe(0);
    });
  });

  it("falls back to the first parent item when navigating up and the previous child row no longer exists", async () => {
    const scrollContainer = document.createElement("div");
    Object.defineProperty(scrollContainer, "scrollTop", {
      value: 77,
      writable: true,
      configurable: true,
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      (result.current.parentRef as { current: HTMLDivElement | null }).current = scrollContainer as HTMLDivElement;
      result.current.restoreRecoverySnapshot({
        connectionId: "conn-1",
        path: "Documents/Ghost",
        items: mockEmptyDirectory.items,
        sortBy: "name",
        sortDirection: "asc",
        viewMode: "list",
        focusedIndex: 0,
        focusedFileName: null,
        selectedFileNames: [],
        viewInfo: null,
        scrollOffset: 77,
      });
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents/Ghost");
      expect(result.current.focusedIndex).toBe(0);
    });

    act(() => {
      scrollContainer.scrollTop = 77;
      result.current.handleNavigateUpDirectory();
    });

    await waitFor(() => {
      expect(result.current.currentPath).toBe("Documents");
      expect(result.current.focusedIndex).toBe(0);
      expect(scrollContainer.scrollTop).toBe(0);
    });
  });

  it("removes a local recent record only when Companion confirms its target is missing", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    vi.mocked(api.resolveLocalActivation).mockRejectedValue({
      response: { data: { code: "local_link_target_missing" }, status: 404 },
    });
    vi.mocked(api.removeRecentFile).mockResolvedValue(undefined);

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleOpenFileAtPath("local-drive:c", "Documents/deleted.txt", "associated-viewer", "recent-1");
    });

    expect(api.removeRecentFile).toHaveBeenCalledWith("recent-1");
    expect(result.current.error).toBe("The recent file no longer exists.");
  });

  it("preserves a local recent record when Companion is unavailable", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    vi.mocked(api.resolveLocalActivation).mockRejectedValue({
      response: { data: { detail: "Unknown drive" }, status: 404 },
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleOpenFileAtPath("local-drive:c", "Documents/report.txt", "associated-viewer", "recent-1");
    });

    expect(api.removeRecentFile).not.toHaveBeenCalled();
    expect(result.current.error).toBe("The recent file could not be opened.");
  });

  it.each([
    ["recent_file_native_launch_failed", "Failed to launch the native application."],
    ["recent_file_target_not_file", "Not a file: Documents/report.txt"],
  ])("removes a local recent record after a classified %s native-open failure", async (code, detail) => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "c",
      path: "Documents/report.txt",
      item: {
        name: "report.txt",
        path: "Documents/report.txt",
        type: FileType.FILE,
        mime_type: "text/plain",
        size: 100,
        is_readable: true,
        is_hidden: false,
      },
    });
    vi.mocked(api.openLocalFile).mockRejectedValue({ response: { data: { code, detail }, status: 500 } });
    vi.mocked(api.removeRecentFile).mockResolvedValue(undefined);

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleOpenFileAtPath("local-drive:c", "Documents/report.txt", "associated-native-app", "recent-1");
    });

    await waitFor(() => {
      expect(api.openLocalFile).toHaveBeenCalledWith("local-drive:c", "Documents/report.txt", { forcePicker: false });
      expect(api.removeRecentFile).toHaveBeenCalledWith("recent-1");
      expect(result.current.error).toBe(detail);
    });
  });

  it("opens a local recent shortcut at its resolved file target", async () => {
    const sourceConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "d",
      path: "Reports/quarterly.pdf",
      item: {
        name: "quarterly.pdf",
        path: "Reports/quarterly.pdf",
        type: FileType.FILE,
        mime_type: "application/pdf",
        is_readable: true,
        is_hidden: false,
      },
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [sourceConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleOpenFileAtPath("local-drive:c", "Links/Report.lnk", "associated-viewer", "recent-1");
    });

    expect(api.resolveLocalActivation).toHaveBeenCalledWith("local-drive:c", "Links/Report.lnk");
    expect(result.current.viewInfo).toMatchObject({
      connectionId: "local-drive:d",
      path: "Reports/quarterly.pdf",
      mimeType: "application/pdf",
    });
  });

  it("navigates to a directory resolved from a local recent shortcut", async () => {
    const sourceConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    const onNavigateDirectory = vi.fn();
    vi.mocked(api.resolveLocalActivation).mockResolvedValue({
      drive_id: "d",
      path: "Projects/Archive",
      item: {
        name: "Archive",
        path: "Projects/Archive",
        type: FileType.DIRECTORY,
        is_readable: true,
        is_hidden: false,
      },
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [sourceConnection],
          onNavigateDirectory,
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    await act(async () => {
      await result.current.handleOpenFileAtPath("local-drive:c", "Links/Archive.lnk", "associated-viewer", "recent-1");
    });

    expect(onNavigateDirectory).toHaveBeenCalledWith("local-drive:d", "Projects/Archive");
  });

  it("ignores a recent local activation result after navigation supersedes it", async () => {
    const localConnection = { ...requireTestValue(mockConnections[0]), id: "local-drive:c", slug: "c", type: "local" };
    let resolveActivation!: (value: Awaited<ReturnType<typeof api.resolveLocalActivation>>) => void;
    vi.mocked(api.resolveLocalActivation).mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveActivation = resolve;
        })
    );

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: [localConnection],
          storageRegistry: createLocalStorageRegistry() as never,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("local-drive:c", "Links");
    });
    await waitFor(() => {
      expect(result.current.currentPath).toBe("Links");
    });

    let activation: Promise<void>;
    act(() => {
      activation = result.current.handleOpenFileAtPath("local-drive:c", "Links/Archive.lnk", "associated-viewer", "recent-1");
    });
    await waitFor(() => {
      expect(api.resolveLocalActivation).toHaveBeenCalledWith("local-drive:c", "Links/Archive.lnk");
    });

    act(() => {
      result.current.applyLocation("local-drive:c", "Elsewhere");
    });
    await act(async () => {
      resolveActivation({
        drive_id: "c",
        path: "Projects/Archive",
        item: {
          name: "Archive",
          path: "Projects/Archive",
          type: FileType.DIRECTORY,
          is_readable: true,
          is_hidden: false,
        },
      });
      await activation;
    });

    expect(result.current.currentPath).toBe("Elsewhere");
  });

  it("opens an image recent outside the active pane without reusing its gallery", async () => {
    const viewerConnections = [
      requireTestValue(mockConnections[0]),
      { ...requireTestValue(mockConnections[0]), id: "conn-2", name: "Archive", slug: "archive" },
    ];
    vi.mocked(api.validateRecentFileTarget).mockResolvedValue({
      name: "outside.png",
      path: "outside.png",
      type: FileType.FILE,
      mime_type: "image/png",
      size: 100,
      is_readable: true,
      is_hidden: false,
    });

    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: viewerConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.applyLocation("conn-1", "");
    });

    await waitFor(() => {
      expect(result.current.connectionId).toBe("conn-1");
    });

    await act(async () => {
      await result.current.handleOpenFileAtPath("conn-2", "outside.png", "associated-viewer", "recent-2");
    });

    expect(result.current.viewInfo).toMatchObject({ path: "outside.png", connectionId: "conn-2" });
    expect(result.current.viewInfo?.images).toBeUndefined();
  });

  it("records each newly displayed gallery image once", async () => {
    const { result } = renderHook(
      () =>
        useFileBrowserPane({
          rowHeight: 40,
          connections: mockConnections,
        }),
      { wrapper }
    );

    act(() => {
      result.current.setViewInfo({
        connectionId: "conn-1",
        path: "first.jpg",
        mimeType: "image/jpeg",
        viewerId: "image",
        images: ["first.jpg", "second.jpg"],
        currentIndex: 0,
        sessionId: "gallery-session",
      });
    });
    act(() => {
      result.current.handleViewIndexChange(0);
      result.current.handleViewIndexChange(1);
      result.current.handleViewIndexChange(1);
    });

    await waitFor(() => {
      expect(api.recordRecentFile).toHaveBeenCalledTimes(2);
      expect(api.recordRecentFile).toHaveBeenNthCalledWith(1, "conn-1", "first.jpg");
      expect(api.recordRecentFile).toHaveBeenNthCalledWith(2, "conn-1", "second.jpg");
    });
  });
});
