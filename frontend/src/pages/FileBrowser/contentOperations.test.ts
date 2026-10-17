import { act, renderHook } from "@testing-library/react";
import type { TFunction } from "i18next";
import { afterEach, describe, expect, it, vi } from "vitest";
import api from "../../services/api";
import { browserHistoryService } from "../../services/browserHistoryService";
import { FileType } from "../../types";
import {
  createContentItem,
  downloadContentSelection,
  executeTransfer,
  executeTransferTree,
  getCreateContainerAvailability,
  getCreateContentItemAvailability,
  getNativeOpenAvailability,
  getTransferAvailability,
  openContentInNativeApp,
  startCreateContainer,
} from "./contentOperations";
import { physicalItem, physicalItemHandle, physicalLocation, virtualItem, virtualItemHandle, virtualLocation } from "./contentProviders";
import { useBrowserDownload } from "./useBrowserDownload";

vi.mock("../../services/api", () => ({
  default: {
    cancelArchiveOperation: vi.fn(),
    copyItem: vi.fn(),
    createItem: vi.fn(),
    executeArchiveCreation: vi.fn(),
    getFileInfo: vi.fn(),
    getCompanionUri: vi.fn(),
    openLocalFile: vi.fn(),
    prepareArchiveOperation: vi.fn(),
    recordRecentFile: vi.fn(),
    removeRecentFile: vi.fn(),
    transferAcrossBackends: vi.fn(),
    downloadFile: vi.fn(),
    downloadArchiveMember: vi.fn(),
    downloadSelectionArchive: vi.fn(),
    downloadZipSelectionArchive: vi.fn(),
  },
}));

const environment = {
  isCompanionPaired: true,
  storageRegistry: {} as never,
  archiveOperations: {} as never,
  history: browserHistoryService,
};

describe("content operations", () => {
  const physicalSource = physicalItemHandle("source", "report.txt");
  const archiveDestination = virtualLocation("zip", "destination", physicalLocation("destination", "files.zip"), "inside");

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("keeps one download active until its request settles, including after cancellation", async () => {
    const location = physicalLocation("source", "parent");
    const file = physicalItem(location, {
      name: "report.txt",
      path: "parent/report.txt",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    });
    let finishDownload: (() => void) | undefined;
    vi.mocked(api.downloadFile).mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishDownload = resolve;
        })
    );
    const { result } = renderHook(() => useBrowserDownload({} as never, ((key: string) => key) as TFunction, vi.fn()));

    let firstDownload: Promise<void> | undefined;
    await act(async () => {
      firstDownload = result.current.startDownload([file]);
    });
    expect(result.current.isDownloading).toBe(true);
    await act(async () => {
      await result.current.startDownload([file]);
    });
    expect(api.downloadFile).toHaveBeenCalledTimes(1);

    act(() => result.current.cancelDownload());
    await act(async () => {
      await result.current.startDownload([file]);
    });
    expect(api.downloadFile).toHaveBeenCalledTimes(1);

    await act(async () => {
      finishDownload?.();
      await firstDownload;
    });
    expect(result.current.isDownloading).toBe(false);
    await act(async () => {
      await result.current.startDownload([file]);
    });
    expect(api.downloadFile).toHaveBeenCalledTimes(2);
  });

  it("shows preparation only when a single-file handoff remains pending", async () => {
    vi.useFakeTimers();
    try {
      const file = physicalItem(physicalLocation("source", "parent"), {
        name: "report.txt",
        path: "parent/report.txt",
        type: FileType.FILE,
        is_readable: true,
        is_hidden: false,
      });
      let finishDownload: (() => void) | undefined;
      vi.mocked(api.downloadFile).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishDownload = resolve;
          })
      );
      const { result } = renderHook(() => useBrowserDownload({} as never, ((key: string) => key) as TFunction, vi.fn()));

      let download: Promise<void> | undefined;
      act(() => {
        download = result.current.startDownload([file]);
      });
      act(() => {
        vi.advanceTimersByTime(299);
      });
      expect(result.current.showDownloadNotice).toBe(false);
      act(() => {
        vi.advanceTimersByTime(1);
      });
      expect(result.current.showDownloadNotice).toBe(true);
      await act(async () => {
        finishDownload?.();
        await vi.advanceTimersByTimeAsync(599);
      });
      expect(result.current.showDownloadNotice).toBe(true);
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1);
        await download;
      });
      expect(result.current.showDownloadNotice).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes a regular file directly and a directory through selected-root ZIP creation", async () => {
    const location = physicalLocation("source", "parent");
    const file = physicalItem(location, {
      name: "report.txt",
      path: "parent/report.txt",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    });
    const directory = physicalItem(location, {
      name: "folder",
      path: "parent/folder",
      type: FileType.DIRECTORY,
      is_readable: true,
      is_hidden: false,
    });
    const signal = new AbortController().signal;

    await downloadContentSelection([file], {} as never, signal);
    await downloadContentSelection([directory], {} as never, signal);

    expect(api.downloadFile).toHaveBeenCalledWith("source", "parent/report.txt", "report.txt", signal);
    expect(api.downloadSelectionArchive).toHaveBeenCalledWith("source", ["parent/folder"], signal);
  });

  it("routes ZIP virtual directories to their owning archive", async () => {
    const location = virtualLocation("zip", "source", physicalLocation("source", "files.zip"), "inner");
    const directory = virtualItem(location, {
      name: "folder",
      path: "inner/folder",
      type: FileType.DIRECTORY,
      is_readable: true,
      is_hidden: false,
    });
    const signal = new AbortController().signal;
    await downloadContentSelection([directory], {} as never, signal);
    expect(api.downloadZipSelectionArchive).toHaveBeenCalledWith("source", "files.zip", ["inner/folder"], signal);
  });

  it("routes a single ZIP member to the native download transport", async () => {
    const location = virtualLocation("zip", "source", physicalLocation("source", "files.zip"), "inner");
    const member = virtualItem(location, {
      name: "report.txt",
      path: "inner/report.txt",
      type: FileType.FILE,
      is_readable: true,
      is_hidden: false,
    });
    const signal = new AbortController().signal;
    await downloadContentSelection([member], {} as never, signal);
    expect(api.downloadArchiveMember).toHaveBeenCalledWith("source", "files.zip", "inner/report.txt", "report.txt", signal);
  });

  it("rejects virtual transfer and container destinations before invoking physical transport", async () => {
    expect(getTransferAvailability({ kind: "copy", source: physicalSource, destination: archiveDestination }, environment)).toEqual({
      available: false,
      reason: "unsupported-destination",
    });
    expect(getCreateContainerAvailability({ sources: [physicalSource], destination: archiveDestination }, environment)).toEqual({
      available: false,
      reason: "unsupported-destination",
    });

    await expect(executeTransfer({ kind: "copy", source: physicalSource, destination: archiveDestination }, environment)).rejects.toThrow(
      "unsupported-destination"
    );
    expect(api.copyItem).not.toHaveBeenCalled();
  });

  it("rejects virtual locations before invoking item creation transport", async () => {
    expect(getCreateContentItemAvailability(archiveDestination, environment)).toEqual({
      available: false,
      reason: "unsupported-destination",
    });

    await expect(createContentItem(archiveDestination, "notes.txt", "file", environment)).rejects.toThrow("unsupported-destination");
    expect(api.createItem).not.toHaveBeenCalled();
  });

  it("reports that Companion is required to create an archive containing local files", () => {
    const localTarget = { kind: "local", connectionId: "local-drive:c" };
    const destinationTarget = { kind: "smb", connectionId: "destination" };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: localTarget, resolvedTarget: localTarget })),
      resolveDirectory: vi.fn(() => ({ target: destinationTarget, resolvedTarget: destinationTarget })),
      getCapabilities: vi.fn(() => ({ readable: true, writable: true })),
    };

    expect(
      getCreateContainerAvailability(
        { sources: [physicalItemHandle("local-drive:c", "report.txt")], destination: physicalLocation("destination", "output") },
        { ...environment, isCompanionPaired: false, storageRegistry } as never
      )
    ).toEqual({ available: false, reason: "companion-unavailable" });
  });

  it("rejects virtual items before invoking native launch transport", async () => {
    const archiveItem = virtualItemHandle(archiveDestination, "report.txt");

    expect(getNativeOpenAvailability(archiveItem, environment)).toEqual({ available: false, reason: "unsupported-source" });
    await expect(openContentInNativeApp({ item: archiveItem, themeJson: "{}" }, environment)).rejects.toThrow("unsupported-source");
    expect(api.openLocalFile).not.toHaveBeenCalled();
    expect(api.getCompanionUri).not.toHaveBeenCalled();
  });

  it("delegates same-backend transfers to the resolved storage adapter", async () => {
    const copyWithinBackend = vi.fn().mockResolvedValue({ status: "completed" });
    const resolvedTarget = {
      target: { kind: "smb", connectionId: "source" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: resolvedTarget.target, path: "report.txt", resolvedTarget })),
      resolveDirectory: vi.fn(() => ({ target: resolvedTarget.target, path: "output", resolvedTarget })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(() => ({ copyWithinBackend })),
    };
    const onAttemptStart = vi.fn();
    const onAttemptSettled = vi.fn();

    await executeTransfer(
      { kind: "copy", source: physicalSource, destination: physicalLocation("source", "output"), onAttemptStart, onAttemptSettled },
      {
        ...environment,
        storageRegistry,
      } as never
    );

    expect(copyWithinBackend).toHaveBeenCalledWith(
      expect.objectContaining({ targetName: undefined, targetResolutionPolicy: "ask", transferAttemptId: onAttemptStart.mock.calls[0][0] })
    );
    expect(onAttemptSettled).toHaveBeenCalledWith(onAttemptStart.mock.calls[0][0]);
    expect(api.copyItem).not.toHaveBeenCalled();
  });

  it("creates a transfer idempotency key when randomUUID is unavailable", async () => {
    const copyWithinBackend = vi.fn().mockResolvedValue({ status: "completed" });
    const resolvedTarget = { kind: "smb", connectionId: "source" };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: resolvedTarget, path: "report.txt" })),
      resolveDirectory: vi.fn(() => ({ target: resolvedTarget, path: "output" })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(() => ({ copyWithinBackend })),
    };
    vi.stubGlobal("crypto", { getRandomValues: (bytes: Uint8Array) => bytes.fill(0) });
    try {
      await executeTransfer({ kind: "copy", source: physicalSource, destination: physicalLocation("source", "output") }, {
        ...environment,
        storageRegistry,
      } as never);

      expect(copyWithinBackend).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: "00000000-0000-4000-8000-000000000000" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("allows and dispatches a writable same-provider move", async () => {
    const sourceResolvedTarget = {
      target: { kind: "smb", connectionId: "source" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const destinationResolvedTarget = {
      target: { kind: "smb", connectionId: "destination" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const moveWithinBackend = vi.fn().mockResolvedValue({ status: "completed" });
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: sourceResolvedTarget.target, path: "report.txt", resolvedTarget: sourceResolvedTarget })),
      resolveDirectory: vi.fn(() => ({
        target: destinationResolvedTarget.target,
        path: "output",
        resolvedTarget: destinationResolvedTarget,
      })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(() => ({ moveWithinBackend })),
    };

    expect(
      getTransferAvailability({ kind: "move", source: physicalSource, destination: physicalLocation("destination", "output") }, {
        ...environment,
        storageRegistry,
      } as never)
    ).toEqual({ available: true });

    await executeTransfer({ kind: "move", source: physicalSource, destination: physicalLocation("destination", "output") }, {
      ...environment,
      storageRegistry,
    } as never);

    expect(moveWithinBackend).toHaveBeenCalledWith(expect.objectContaining({ targetName: undefined, targetResolutionPolicy: "ask" }));
  });

  it("relays a cross-backend move without letting storage adapters delete the source", async () => {
    const sourceResolvedTarget = {
      target: { kind: "local", driveId: "c" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const destinationResolvedTarget = {
      target: { kind: "smb", connectionId: "destination" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const sourceBackend = {
      getInfo: vi.fn().mockResolvedValue({ type: "file" }),
      read: vi.fn().mockResolvedValue(new Blob(["report"])),
      remove: vi.fn().mockResolvedValue({ status: "completed" }),
    };
    const destinationBackend = { writeFile: vi.fn().mockResolvedValue({ status: "completed" }) };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: sourceResolvedTarget.target, path: "report.txt", resolvedTarget: sourceResolvedTarget })),
      resolveDirectory: vi.fn(() => ({
        target: destinationResolvedTarget.target,
        path: "output",
        resolvedTarget: destinationResolvedTarget,
      })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { kind: string }) => (target.kind === "local" ? sourceBackend : destinationBackend)),
    };

    vi.mocked(api.transferAcrossBackends).mockResolvedValue({
      status: "completed_with_source_retained",
      replaced: false,
      effects: { source: "unchanged", destination: "mutated" },
      error: { code: "source_delete_failed", detail: "source retained" },
    });
    await expect(
      executeTransfer(
        { kind: "move", source: physicalItemHandle("local-drive:c", "report.txt"), destination: physicalLocation("destination", "output") },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed_with_source_retained", effects: { source: "unchanged", destination: "mutated" } });

    expect(api.transferAcrossBackends).toHaveBeenCalledWith(
      "move",
      "local-drive:c",
      "report.txt",
      "destination",
      "output/report.txt",
      "ask"
    );
    expect(sourceBackend.read).not.toHaveBeenCalled();
    expect(destinationBackend.writeFile).not.toHaveBeenCalled();
    expect(sourceBackend.remove).not.toHaveBeenCalled();
  });

  it("relays a cross-backend copy through the transfer coordinator", async () => {
    const sourceResolvedTarget = {
      target: { kind: "smb", connectionId: "source" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const destinationResolvedTarget = {
      target: { kind: "local", driveId: "c" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: sourceResolvedTarget.target, path: "report.txt", resolvedTarget: sourceResolvedTarget })),
      resolveDirectory: vi.fn(() => ({
        target: destinationResolvedTarget.target,
        path: "output",
        resolvedTarget: destinationResolvedTarget,
      })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(),
    };
    vi.mocked(api.transferAcrossBackends).mockResolvedValue({
      status: "completed",
      replaced: false,
      effects: { source: "unchanged", destination: "mutated" },
    });
    await expect(
      executeTransfer(
        { kind: "copy", source: physicalItemHandle("source", "report.txt"), destination: physicalLocation("local-drive:c", "output") },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed", effects: { source: "unchanged", destination: "mutated" } });
    expect(storageRegistry.getBackend).not.toHaveBeenCalled();
    expect(api.transferAcrossBackends).toHaveBeenCalledWith("copy", "source", "report.txt", "local-drive:c", "output/report.txt", "ask");
  });

  it("delegates a copy between different local drives to the Companion adapter", async () => {
    const sourceResolvedTarget = {
      target: { kind: "local", driveId: "c" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const destinationResolvedTarget = {
      target: { kind: "local", driveId: "d" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const copyWithinBackend = vi.fn().mockResolvedValue({
      status: "completed",
      replaced: false,
      effects: { source: "unchanged", destination: "mutated" },
    });
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: sourceResolvedTarget.target, path: "report.txt", resolvedTarget: sourceResolvedTarget })),
      resolveDirectory: vi.fn(() => ({
        target: destinationResolvedTarget.target,
        path: "output",
        resolvedTarget: destinationResolvedTarget,
      })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(() => ({ copyWithinBackend })),
    };
    vi.mocked(api.transferAcrossBackends).mockResolvedValue({
      status: "completed",
      replaced: false,
      effects: { source: "unchanged", destination: "mutated" },
    });

    await expect(
      executeTransfer(
        {
          kind: "copy",
          source: physicalItemHandle("local-drive:c", "report.txt"),
          destination: physicalLocation("local-drive:d", "output"),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(copyWithinBackend).toHaveBeenCalledWith(expect.objectContaining({ targetResolutionPolicy: "ask" }));
    expect(api.transferAcrossBackends).not.toHaveBeenCalled();
  });

  it("delegates a move between different local drives to the Companion adapter", async () => {
    const sourceResolvedTarget = {
      target: { kind: "local", driveId: "c" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const destinationResolvedTarget = {
      target: { kind: "local", driveId: "d" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const moveWithinBackend = vi.fn().mockResolvedValue({
      status: "completed_with_source_retained",
      replaced: false,
      effects: { source: "unchanged", destination: "mutated" },
      error: { code: "source_delete_failed", detail: "source retained" },
    });
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: sourceResolvedTarget.target, path: "report.txt", resolvedTarget: sourceResolvedTarget })),
      resolveDirectory: vi.fn(() => ({
        target: destinationResolvedTarget.target,
        path: "output",
        resolvedTarget: destinationResolvedTarget,
      })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(() => ({ moveWithinBackend })),
    };

    await expect(
      executeTransfer(
        {
          kind: "move",
          source: physicalItemHandle("local-drive:c", "report.txt"),
          destination: physicalLocation("local-drive:d", "output"),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed_with_source_retained" });

    expect(moveWithinBackend).toHaveBeenCalledWith(expect.objectContaining({ targetResolutionPolicy: "ask" }));
    expect(api.transferAcrossBackends).not.toHaveBeenCalled();
  });

  it("reports a retained move source when empty-directory cleanup finds entries", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [] }),
      removeEmptyDirectory: vi.fn().mockResolvedValue({ status: "not_empty" }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async () => null),
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn().mockResolvedValue({ status: "completed" }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "move",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed_with_source_retained", effects: { source: "unchanged", destination: "mutated" } });

    expect(sourceBackend.removeEmptyDirectory).toHaveBeenCalledTimes(1);
  });

  it("reports source mutation after moving an empty directory", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [] }),
      removeEmptyDirectory: vi.fn().mockResolvedValue({ status: "removed" }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async () => null),
      list: vi.fn().mockResolvedValue({ items: [] }),
      create: vi.fn().mockResolvedValue({ status: "completed" }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "move",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed", effects: { source: "mutated", destination: "mutated" } });
  });

  it("stops a tree when a source listing belongs to a different directory", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ path: "other", items: [] }),
      copyWithinBackend: vi.fn(),
    };
    const destinationBackend = {
      getInfo: vi.fn(async () => root),
      create: vi.fn(),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({
      status: "failed",
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "validation", reason: "invalid-directory-listing" },
    });

    expect(sourceBackend.copyWithinBackend).not.toHaveBeenCalled();
  });

  it("stops a tree when a source listing contains a non-child entry", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ path: "root", items: [{ name: "child.txt", path: "other/child.txt", type: "file" }] }),
      copyWithinBackend: vi.fn(),
    };
    const destinationBackend = {
      getInfo: vi.fn(async () => root),
      create: vi.fn(),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({
      status: "failed",
      effects: { source: "unchanged", destination: "unchanged" },
      error: { code: "validation", reason: "invalid-directory-listing" },
    });

    expect(sourceBackend.copyWithinBackend).not.toHaveBeenCalled();
  });

  it("offers only skip and rename when a directory merge child collides with a directory", async () => {
    const sourceDirectory = { name: "root", path: "root", type: "directory" };
    const conflictingDirectory = { name: "report.txt", path: "output/root/report.txt", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "root" ? sourceDirectory : null)),
      list: vi.fn().mockResolvedValue({ items: [{ name: "report.txt", path: "root/report.txt", type: "file" }] }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) =>
        path === "output/root" ? sourceDirectory : path === "output/root/report.txt" ? conflictingDirectory : null
      ),
      list: vi.fn().mockResolvedValue({ items: [conflictingDirectory] }),
      create: vi.fn(),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi.fn().mockResolvedValue({ resolution: "skip", applyToAll: false });

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(onConflict).toHaveBeenCalledWith(expect.anything(), ["skip", "rename"], { completed: 0, discovered: 1 });
  });

  it("offers only skip and rename when a top-level directory collides with a file", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const targetFile = { name: "root", path: "output/root", type: "file" };
    const sourceBackend = { getInfo: vi.fn(async () => root), list: vi.fn() };
    const destinationBackend = { getInfo: vi.fn(async () => targetFile) };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi.fn().mockResolvedValue({ resolution: "skip", applyToAll: false });

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "skipped" });

    expect(onConflict).toHaveBeenCalledWith(expect.anything(), ["skip", "rename"], { completed: 0, discovered: 0 });
  });

  it("applies a persistent skip policy to file-directory type mismatches", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [{ name: "report.txt", path: "root/report.txt", type: "file" }] }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) =>
        path === "output/root" ? root : { name: "report.txt", path: "output/root/report.txt", type: "directory" }
      ),
      list: vi.fn().mockResolvedValue({ items: [{ name: "report.txt", path: "output/root/report.txt", type: "directory" }] }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi.fn();

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          targetResolutionPolicy: "skip",
          onConflict,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed", effects: { source: "unchanged", destination: "unchanged" } });

    expect(onConflict).not.toHaveBeenCalled();
  });

  it("reports a partially mutated source when a moved tree is retained", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [{ name: "report.txt", path: "root/report.txt", type: "file" }] }),
      moveWithinBackend: vi.fn().mockResolvedValue({
        status: "completed",
        replaced: true,
        effects: { source: "mutated", destination: "mutated" },
      }),
      removeEmptyDirectory: vi.fn().mockResolvedValue({ status: "not_empty" }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi.fn().mockResolvedValue({ items: [] }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "move",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({
      status: "completed_with_source_retained",
      replaced: true,
      effects: { source: "mutated", destination: "mutated" },
    });
  });

  it.each(["outcome_unknown", "failed", "cancelled"] as const)(
    "preserves previous mutations and replacement when a child is %s",
    async (status) => {
      const root = { name: "root", path: "root", type: "directory" };
      const sourceBackend = {
        getInfo: vi.fn(async () => root),
        list: vi.fn().mockResolvedValue({
          items: [
            { name: "first.txt", path: "root/first.txt", type: "file" },
            { name: "second.txt", path: "root/second.txt", type: "file" },
          ],
        }),
        moveWithinBackend: vi
          .fn()
          .mockResolvedValueOnce({ status: "completed", replaced: true, effects: { source: "mutated", destination: "mutated" } })
          .mockResolvedValueOnce({
            status,
            replaced: false,
            effects: { source: "unknown", destination: "unknown" },
            ...(status === "failed" ? { error: { code: "transport", detail: "connection lost" } } : {}),
          }),
        removeEmptyDirectory: vi.fn(),
      };
      const destinationBackend = {
        getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
        list: vi.fn().mockResolvedValue({ items: [] }),
      };
      const storageRegistry = {
        resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
        resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
        getCapabilities: vi.fn(() => ({ writable: true })),
        getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
      };
      await expect(
        executeTransferTree(
          {
            kind: "move",
            source: physicalItemHandle("source", "root"),
            destination: physicalLocation("destination", "output"),
            onConflict: vi.fn(),
          },
          { ...environment, storageRegistry } as never
        )
      ).resolves.toMatchObject({
        status,
        replaced: true,
        effects: { source: "mutated", destination: "mutated" },
      });
      expect(sourceBackend.removeEmptyDirectory).not.toHaveBeenCalled();
    }
  );

  it("leaves destination-only merge entries untouched", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({
        items: [
          { name: "source-only.txt", path: "root/source-only.txt", type: "file" },
          { name: "another.txt", path: "root/another.txt", type: "file" },
        ],
      }),
      copyWithinBackend: vi.fn().mockResolvedValue({
        status: "completed",
        replaced: false,
        effects: { source: "unchanged", destination: "mutated" },
      }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi
        .fn()
        .mockResolvedValue({ items: [{ name: "destination-only.txt", path: "output/root/destination-only.txt", type: "file" }] }),
      remove: vi.fn(),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await executeTransferTree(
      {
        kind: "copy",
        source: physicalItemHandle("source", "root"),
        destination: physicalLocation("destination", "output"),
        onConflict: vi.fn(),
      },
      { ...environment, storageRegistry } as never
    );

    expect(sourceBackend.copyWithinBackend).toHaveBeenCalledTimes(2);
    expect(sourceBackend.copyWithinBackend.mock.calls[0][0].transferAttemptId).not.toBe(
      sourceBackend.copyWithinBackend.mock.calls[1][0].transferAttemptId
    );
    expect(destinationBackend.remove).not.toHaveBeenCalled();
  });

  it("reports completed child effects when a tree is cancelled before its next child", async () => {
    const abortController = new AbortController();
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({
        items: [
          { name: "first.txt", path: "root/first.txt", type: "file" },
          { name: "later.txt", path: "root/later.txt", type: "file" },
        ],
      }),
      moveWithinBackend: vi.fn(async () => {
        abortController.abort();
        return { status: "completed", replaced: false, effects: { source: "mutated", destination: "mutated" } };
      }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi.fn().mockResolvedValue({ items: [] }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "move",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          signal: abortController.signal,
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "cancelled", effects: { source: "mutated", destination: "mutated" } });

    expect(sourceBackend.moveWithinBackend).toHaveBeenCalledTimes(1);
  });

  it("re-reads a directory target after a creation collision and merges it", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [] }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async () => null),
      list: vi.fn().mockResolvedValue({ items: [root] }),
      create: vi.fn().mockRejectedValue({ response: { status: 409 } }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(destinationBackend.create).toHaveBeenCalledTimes(1);
    expect(destinationBackend.list).toHaveBeenCalledTimes(2);
    expect(sourceBackend.list).toHaveBeenCalledTimes(1);
  });

  it("retries refreshed leaf conflicts without restarting the directory traversal", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const existing = { name: "report.txt", path: "output/root/report.txt", type: "file" };
    const conflict = (target: typeof existing) => ({
      response: {
        status: 409,
        data: { detail: { incoming_file: { name: "report.txt", path: "root/report.txt", type: "file" }, existing_file: target } },
      },
    });
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [{ name: "report.txt", path: "root/report.txt", type: "file" }] }),
      copyWithinBackend: vi
        .fn()
        .mockRejectedValueOnce(conflict(existing))
        .mockRejectedValueOnce(conflict({ ...existing, modified_at: "2026-09-07T00:00:00Z" }))
        .mockResolvedValue({ status: "completed", replaced: true, effects: { source: "unchanged", destination: "mutated" } }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : existing)),
      list: vi.fn().mockResolvedValue({ items: [existing] }),
      create: vi.fn(),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi
      .fn()
      .mockResolvedValueOnce({ resolution: "overwrite", applyToAll: true })
      .mockResolvedValueOnce({ resolution: "overwrite", applyToAll: false });
    const onPolicyChange = vi.fn();

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict,
          onPolicyChange,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(sourceBackend.list).toHaveBeenCalledTimes(1);
    expect(sourceBackend.copyWithinBackend).toHaveBeenCalledTimes(3);
    expect(new Set(sourceBackend.copyWithinBackend.mock.calls.map(([transfer]) => transfer.transferAttemptId)).size).toBe(3);
    expect(onConflict).toHaveBeenCalledTimes(2);
    expect(onPolicyChange).toHaveBeenCalledWith("replace");
  });

  it("preserves a failed child transfer's factual destination mutation", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({ items: [{ name: "report.txt", path: "root/report.txt", type: "file" }] }),
      copyWithinBackend: vi.fn().mockResolvedValue({
        status: "failed",
        replaced: false,
        effects: { source: "unchanged", destination: "mutated" },
        error: { code: "transport", detail: "Source changed after publication" },
      }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi.fn().mockResolvedValue({ items: [] }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "failed", effects: { source: "unchanged", destination: "mutated" } });
  });

  it("rejects a directory target that is the source or one of its descendants", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn(),
      create: vi.fn(),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn(() => sourceBackend),
    };

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("source", "root/inside"),
          onConflict: vi.fn(),
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ error: { code: "validation", reason: "target-inside-source" } });

    expect(sourceBackend.create).not.toHaveBeenCalled();
    expect(sourceBackend.list).not.toHaveBeenCalled();
  });

  it("applies an overwrite policy to later sibling conflicts without reopening the dialog", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const firstTarget = { name: "first.txt", path: "output/root/first.txt", type: "file" };
    const secondTarget = { name: "second.txt", path: "output/root/second.txt", type: "file" };
    const conflict = (target: typeof firstTarget) => ({
      response: {
        status: 409,
        data: { detail: { incoming_file: { name: target.name, path: `root/${target.name}`, type: "file" }, existing_file: target } },
      },
    });
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({
        items: [
          { name: "first.txt", path: "root/first.txt", type: "file" },
          { name: "second.txt", path: "root/second.txt", type: "file" },
        ],
      }),
      copyWithinBackend: vi
        .fn()
        .mockRejectedValueOnce(conflict(firstTarget))
        .mockResolvedValue({ status: "completed", replaced: true, effects: { source: "unchanged", destination: "mutated" } }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi.fn().mockResolvedValue({ items: [firstTarget, secondTarget] }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi.fn().mockResolvedValue({ resolution: "overwrite", applyToAll: true });

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(sourceBackend.copyWithinBackend).toHaveBeenNthCalledWith(1, expect.objectContaining({ targetResolutionPolicy: "ask" }));
    expect(sourceBackend.copyWithinBackend).toHaveBeenNthCalledWith(2, expect.objectContaining({ targetResolutionPolicy: "replace" }));
  });

  it("applies a skip policy to later sibling conflicts without reopening the dialog", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const firstTarget = { name: "first.txt", path: "output/root/first.txt", type: "file" };
    const secondTarget = { name: "second.txt", path: "output/root/second.txt", type: "file" };
    const conflict = (target: typeof firstTarget) => ({
      response: {
        status: 409,
        data: { detail: { incoming_file: { name: target.name, path: `root/${target.name}`, type: "file" }, existing_file: target } },
      },
    });
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn().mockResolvedValue({
        items: [
          { name: "first.txt", path: "root/first.txt", type: "file" },
          { name: "second.txt", path: "root/second.txt", type: "file" },
        ],
      }),
      copyWithinBackend: vi
        .fn()
        .mockRejectedValueOnce(conflict(firstTarget))
        .mockResolvedValue({ status: "skipped", replaced: false, effects: { source: "unchanged", destination: "unchanged" } }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi.fn().mockResolvedValue({ items: [firstTarget, secondTarget] }),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi.fn().mockResolvedValue({ resolution: "skip", applyToAll: true });

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(sourceBackend.copyWithinBackend).toHaveBeenNthCalledWith(1, expect.objectContaining({ targetResolutionPolicy: "ask" }));
    expect(sourceBackend.copyWithinBackend).toHaveBeenNthCalledWith(2, expect.objectContaining({ targetResolutionPolicy: "skip" }));
  });

  it("applies an overwrite-only-older policy to nested sibling conflicts without reopening the dialog", async () => {
    const root = { name: "root", path: "root", type: "directory" };
    const folder = { name: "folder", path: "root/folder", type: "directory" };
    const firstTarget = { name: "first.txt", path: "output/root/folder/first.txt", type: "file" };
    const secondTarget = { name: "second.txt", path: "output/root/folder/second.txt", type: "file" };
    const conflict = (target: typeof firstTarget) => ({
      response: {
        status: 409,
        data: { detail: { incoming_file: { name: target.name, path: `root/folder/${target.name}`, type: "file" }, existing_file: target } },
      },
    });
    const sourceBackend = {
      getInfo: vi.fn(async () => root),
      list: vi.fn(async ({ path }: { path: string }) =>
        path === "root"
          ? { items: [folder] }
          : {
              items: [
                { name: "first.txt", path: "root/folder/first.txt", type: "file" },
                { name: "second.txt", path: "root/folder/second.txt", type: "file" },
              ],
            }
      ),
      copyWithinBackend: vi
        .fn()
        .mockRejectedValueOnce(conflict(firstTarget))
        .mockResolvedValue({ status: "completed", replaced: true, effects: { source: "unchanged", destination: "mutated" } }),
    };
    const destinationBackend = {
      getInfo: vi.fn(async ({ path }: { path: string }) => (path === "output/root" ? root : null)),
      list: vi.fn(async ({ path }: { path: string }) =>
        path === "output/root" ? { items: [{ ...folder, path: "output/root/folder" }] } : { items: [firstTarget, secondTarget] }
      ),
    };
    const storageRegistry = {
      resolveItem: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      resolveDirectory: vi.fn(({ connectionId, path }) => ({ target: { connectionId }, path })),
      getCapabilities: vi.fn(() => ({ writable: true })),
      getBackend: vi.fn((target: { connectionId: string }) => (target.connectionId === "source" ? sourceBackend : destinationBackend)),
    };
    const onConflict = vi.fn().mockResolvedValue({ resolution: "overwrite-older", applyToAll: true });

    await expect(
      executeTransferTree(
        {
          kind: "copy",
          source: physicalItemHandle("source", "root"),
          destination: physicalLocation("destination", "output"),
          onConflict,
        },
        { ...environment, storageRegistry } as never
      )
    ).resolves.toMatchObject({ status: "completed" });

    expect(onConflict).toHaveBeenCalledTimes(1);
    expect(sourceBackend.copyWithinBackend).toHaveBeenNthCalledWith(1, expect.objectContaining({ targetResolutionPolicy: "ask" }));
    expect(sourceBackend.copyWithinBackend).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ targetResolutionPolicy: "replace_older" })
    );
  });

  it("rejects container sources from different connections before starting an operation", async () => {
    const secondSource = physicalItemHandle("other-source", "other-report.txt");
    const destination = physicalLocation("destination", "output");

    expect(getCreateContainerAvailability({ sources: [physicalSource, secondSource], destination }, environment)).toEqual({
      available: false,
      reason: "mixed-source-connections",
    });

    const execution = startCreateContainer({ sources: [physicalSource, secondSource], destination, name: "archive.zip" }, environment);
    await expect(execution.result).rejects.toThrow("mixed-source-connections");
    expect(api.prepareArchiveOperation).not.toHaveBeenCalled();
  });

  it("creates a same-SMB archive from selected ZIP members and rejects other destinations", async () => {
    const zipLocation = virtualLocation("zip", "source", physicalLocation("source", "files.zip"), "inner");
    const sources = [virtualItemHandle(zipLocation, "inner/one.txt"), virtualItemHandle(zipLocation, "inner/two.txt")];
    const destination = physicalLocation("source", "output");
    const target = { kind: "smb" as const, connectionId: "source" };
    const storageRegistry = {
      resolveItem: vi.fn(({ path }) => ({ target, path, resolvedTarget: { target } })),
      resolveDirectory: vi.fn(({ path }) => ({ target, path, resolvedTarget: { target } })),
      getCapabilities: vi.fn(() => ({ readable: true, writable: true })),
    };
    const archiveOperations = {
      start: vi.fn(() => ({ result: Promise.resolve({ status: "completed" }), cancel: vi.fn(), isCancellationRequested: () => false })),
    };
    const context = { ...environment, storageRegistry, archiveOperations } as never;

    expect(getCreateContainerAvailability({ sources, destination }, context)).toEqual({ available: true });
    await expect(startCreateContainer({ sources, destination, name: "selected.zip" }, context).result).resolves.toBeUndefined();
    expect(archiveOperations.start).toHaveBeenCalledWith(
      expect.objectContaining({
        sources: [expect.objectContaining({ path: "files.zip" })],
        selectedMemberPaths: ["inner/one.txt", "inner/two.txt"],
      })
    );
    expect(getCreateContainerAvailability({ sources, destination: physicalLocation("other", "output") }, context)).toEqual({
      available: false,
      reason: "unsupported-source",
    });
    const localTarget = { kind: "local" as const, connectionId: "local-drive:c" };
    expect(
      getCreateContainerAvailability({ sources, destination }, {
        ...context,
        storageRegistry: { ...storageRegistry, resolveDirectory: () => ({ target: localTarget }) },
      } as never)
    ).toEqual({ available: false, reason: "unsupported-source" });
  });

  it("delegates container creation failures to the archive coordinator", async () => {
    const resolvedTarget = {
      target: { kind: "smb", connectionId: "source" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: resolvedTarget.target, path: "report.txt", resolvedTarget })),
      resolveDirectory: vi.fn(() => ({ target: resolvedTarget.target, path: "output", resolvedTarget })),
      getCapabilities: vi.fn(() => ({ readable: true, writable: true })),
    };
    const archiveOperations = {
      start: vi.fn(() => ({
        result: Promise.resolve({
          status: "failed" as const,
          effects: { source: "unchanged" as const, destination: "unchanged" as const },
          error: { code: "transport" as const, detail: "archive transport failed" },
        }),
        cancel: vi.fn(),
        isCancellationRequested: () => false,
      })),
    };

    const execution = startCreateContainer(
      { sources: [physicalSource], destination: physicalLocation("destination", "output"), name: "archive.zip" },
      { ...environment, storageRegistry, archiveOperations } as never
    );

    await expect(execution.result).rejects.toThrow("Container creation failed");
    expect(archiveOperations.start).toHaveBeenCalledWith(expect.objectContaining({ name: "archive.zip" }));
  });

  it("removes permanently invalid recent records when local native launch fails", async () => {
    const nativeLaunchError = { response: { data: { code: "recent_file_native_launch_failed" } } };
    const resolvedTarget = {
      target: { kind: "local", driveId: "c" },
      connection: null,
      capabilitySnapshot: { capabilityRevision: 1 },
    };
    const storageRegistry = {
      resolveItem: vi.fn(() => ({ target: resolvedTarget.target, path: "Documents/report.txt", resolvedTarget })),
      getCapabilities: vi.fn(() => ({ canOpenInNativeApp: true })),
      getBackend: vi.fn(() => ({ openInNativeApp: vi.fn().mockRejectedValue(nativeLaunchError) })),
    };
    vi.mocked(api.removeRecentFile).mockResolvedValue(undefined);

    await expect(
      openContentInNativeApp(
        {
          item: physicalItemHandle("local-drive:c", "Documents/report.txt"),
          recentRecordId: "recent-1",
          themeJson: "{}",
          assumeLocalTargetResolved: true,
        },
        { ...environment, storageRegistry } as never
      )
    ).rejects.toEqual(nativeLaunchError);

    expect(api.removeRecentFile).toHaveBeenCalledWith("recent-1");
  });
});
